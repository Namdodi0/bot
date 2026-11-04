import { latestSummary } from '../context/record.js';
import { createTokenMeter } from '../context/token-meter.js';
import { formatDuration } from '../text/format.js';
import { REMINDER_LIMITS, formatReminderTime, parseReminderArgs } from '../ai/reminders.js';
import { createChatServices } from '../services/chat.js';
import { createReminderService } from '../services/reminders.js';
import { helpBullets } from './registry.js';
import { createSettingsCommands } from './settings.js';

const SUMMARY_DEFAULT_COUNT = 30;
const SUMMARY_MAX_COUNT = 200;

/**
 * @param {string} text
 * @returns {{name: string, args: string}|null}
 */
export function parseCommand(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('/')) return null;
  const match = trimmed.match(/^\/([a-zA-Z0-9_]+)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1].toLowerCase(), args: (match[2] ?? '').trim() };
}

/**
 * @param {{config: any, store: ReturnType<typeof import('../context/store.js').createContextStore>, metrics: ReturnType<typeof import('../metrics.js').createMetrics>, platform: import('../../platforms/contract.js').Platform, http: ReturnType<typeof import('../http.js').createHttp>, models: ReturnType<typeof import('../ai/router.js').createModelRouter>, reminders?: ReturnType<typeof import('../ai/reminders.js').createReminderStore>, logger?: import('../logger.js').Logger, compaction?: ReturnType<typeof import('../context/compaction/engine.js').createCompactionEngine>, chatServices?: ReturnType<typeof import('../services/chat.js').createChatServices>, reminderService?: ReturnType<typeof import('../services/reminders.js').createReminderService>}} deps
 */
export function createCommands(deps) {
  const { config, store, metrics, platform, models, compaction } = deps;
  const transport = platform.transport;
  const http = deps.http;
  const reminders = deps.reminders;
  const logger = deps.logger;
  const chat = deps.chatServices ?? createChatServices({ config, store, models, compaction });
  const reminderService = deps.reminderService ?? createReminderService({ reminders });

  function canManage(ctx) {
    // Private chats are per-chat settings, so the manager check is a group concern only.
    // The platform owns the admin policy and always supplies a boolean in group chats.
    if (ctx.chatType !== 'GROUP') return true;
    return ctx.isAdmin === true;
  }

  const settingsCommands = createSettingsCommands({ canManage, config, store, logger, platform });

  function helpText() {
    const lines = ['**Bot commands**', ...helpBullets(platform.commands.specs, platform.commands.helpOverrides)];
    if (platform.commands.helpNote) lines.push('', platform.commands.helpNote);
    return lines.join('\n');
  }

  /** @param {{chatId: string, chatType: string, senderId: string, platform?: string}} ctx @param {any} record */
  async function statusText(ctx, record) {
    const snapshot = metrics.snapshot();
    const nimLatency = snapshot.latency['llm.latency'];
    const replyLatency = snapshot.latency['agent.reply'];
    const count = (name) => snapshot.counters[name] ?? 0;
    const messages = record?.messages?.length ?? 0;
    const thinking = record?.meta?.thinking ?? 'per config';
    const current = models.resolve(record);
    const contextBudget =
      config.context.maxTokens > 0 || config.context.maxMessages > 0
        ? `${config.context.maxTokens > 0 ? `${config.context.maxTokens} token` : '∞ token'} / ${
            config.context.maxMessages > 0 ? `${config.context.maxMessages} msg` : '∞ msg'
          }`
        : 'unlimited';
    const replyLimit =
      config.maxMessagesPerReply > 0 ? `${config.maxMessagesPerReply} msg` : 'unlimited';
    const generationSpeed = Number(snapshot.gauges?.['llm.tokensPerSec'] ?? 0);
    const contextFiles = typeof store.count === 'function' ? await store.count() : null;
    const contextStore = `• Context storage: ${
      contextFiles === null ? 'unknown' : `${contextFiles} file${contextFiles === 1 ? '' : 's'}`
    } · TTL ${config.context.ttlHours > 0 ? `${config.context.ttlHours}h` : 'never'}`;
    const estimated = createTokenMeter().messages(record?.messages ?? []);
    const window = Number(current.contextWindow ?? config.context.modelWindow ?? 0);
    const pressure = `• Context pressure: ~${estimated} token${window > 0 ? ` / ${window} (${Math.round((estimated / window) * 100)}%)` : ' (context window unknown)'}`;

    /** @type {string[]} */
    const lines = [
      '**Bot status**',
      `• Model: \`${current.alias}\` — ${current.label} (\`${current.model}\`, ${current.provider})`,
      `• Mode: ${platform.transportMode} · Reasoning: ${config.ai.reasoning} (this chat: ${thinking})`,
      `• max_tokens: ${config.ai.maxTokens ?? 'unlimited'}`,
      `• Uptime: ${formatDuration(snapshot.uptimeSec * 1000)} · bot v${config.version ?? '?'}`,
      `• Context: ${messages} msg · ${record?.turns ?? 0} turns · budget: ${contextBudget} · summary: ${latestSummary(record) ? 'yes' : 'no'}`,
      pressure,
      contextStore,
      `• Reply limit: ${replyLimit}`,
      `• LLM latency: p50 ${nimLatency ? `${nimLatency.p50}ms` : 'n/a'} · p95 ${nimLatency ? `${nimLatency.p95}ms` : 'n/a'}${generationSpeed > 0 ? ` · ~${generationSpeed} tok/s` : ''}`,
      `• Replies: p50 ${replyLatency ? `${replyLatency.p50}ms` : 'n/a'} · p95 ${replyLatency ? `${replyLatency.p95}ms` : 'n/a'}`,
      `• Received: ${count('messages.in')} · Replied: ${count('messages.replied')} · Errors: ${count('messages.error')}`,
      `• Web search: ${config.search.enabled ? `${config.search.depth}/${config.search.maxResults} (auto: ${config.search.auto ? 'on' : 'off'})` : 'off'} · Images: ${config.image.enabled ? 'on' : 'off'}`,
      `• Typing: ${config.typing ? 'on' : 'off'} · Progressive: ${config.progressive}${record?.meta?.split ? ` (this chat: ${record.meta.split})` : ''}`,
      `• Chat: \`${ctx.chatId}\` (${ctx.chatType})`,
    ];

    if (http?.listStates) {
      /** @type {Map<string, {service: string, failures: number, open: boolean}>} */
      const states = new Map();
      for (const state of http.listStates()) states.set(state.service, state);
      for (const name of platform.healthServices) {
        if (!states.has(name)) states.set(name, { service: name, failures: 0, open: false });
      }
      const parts = [...states.values()].map(
        (state) => `${state.service}: ${state.open ? `open (${state.failures} errors)` : 'ok'}`,
      );
      lines.push(`• Circuit: ${parts.join(' · ')}`);
    }

    return lines.join('\n');
  }

  /**
   * @param {{name: string, args: string}} command
   * @param {{chatId: string, chatType: string, senderId: string, senderName: string, platform?: string, isAdmin?: boolean, record: any}} ctx
   */
  async function run(command, ctx) {
    const name = command.name;
    const args = command.args;

    const platformResult = await platform.commands.run?.(name, args, ctx);
    if (platformResult) return platformResult;

    switch (name) {
      case 'help':
        return { kind: 'text', text: helpText() };

      case 'id':
        return {
          kind: 'text',
          text: `Chat id: \`${ctx.chatId}\`\nType: ${ctx.chatType}\nSender: ${ctx.senderName} (\`${ctx.senderId}\`)`,
        };

      case 'reset': {
        if (!canManage(ctx)) {
          return { kind: 'text', text: 'Only group admins can use /reset.' };
        }
        const full = args.trim().toLowerCase() === 'all';
        const turns = ctx.record?.turns ?? 0;
        await chat.reset(ctx.chatId, { all: full });
        logger?.info('context reset', { chatId: ctx.chatId, turns, full });
        return {
          kind: 'text',
          text: full
            ? `Cleared all context and settings for this chat (${turns} turns). It is like new.`
            : `Cleared this chat's context (${turns} turns) but kept the settings (model/tone/think). Use \`/reset all\` to clear the settings too.`,
        };
      }

      case 'status':
        return { kind: 'text', text: await statusText(ctx, ctx.record) };

      case 'compact': {
        if (!canManage(ctx)) return { kind: 'text', text: 'Only group admins can compact the context.' };
        if (!compaction) return { kind: 'text', text: 'Compaction is not configured.' };
        const meter = createTokenMeter();
        const before = meter.messages(ctx.record.messages);
        const result = await chat.compact(ctx.chatId, ctx.chatType, ctx.record);
        if (!result?.changed) {
          return { kind: 'text', text: 'The context does not need compaction yet (no safe range left to compact).' };
        }
        const after = meter.messages(ctx.record.messages);
        const parts = [];
        if (result.summarized) parts.push('summary');
        if (result.pruned) parts.push('pruned tool results');
        return { kind: 'text', text: `Compacted context (${parts.join(', ')}) — ~${before} → ~${after} tokens.` };
      }

      case 'summary': {
        const raw = args.trim();
        let count = SUMMARY_DEFAULT_COUNT;
        if (raw) {
          const parsed = Number(raw);
          if (!Number.isInteger(parsed) || parsed < 2 || parsed > SUMMARY_MAX_COUNT) {
            return {
              kind: 'text',
              text: `Use \`/summary [count]\` (2–${SUMMARY_MAX_COUNT}, default ${SUMMARY_DEFAULT_COUNT}).`,
            };
          }
          count = parsed;
        }
        try {
          const result = await chat.summarize(ctx.chatId, ctx.chatType, count, ctx.record);
          if (!result.ok) {
            const reason = /** @type {any} */ (result).reason;
            return {
              kind: 'text',
              text:
                reason === 'empty'
                  ? 'The model returned no summary; try again later.'
                  : 'Not enough messages to summarize (need at least 2).',
            };
          }
          return { kind: 'text', text: `**Summary of the last ${result.count} messages:**\n\n${result.text}` };
        } catch (error) {
          logger?.warn('summary command failed', {
            error: String(/** @type {any} */ (error)?.message ?? error),
          });
          return { kind: 'text', text: `Could not summarize: ${String(/** @type {any} */ (error)?.message ?? error)}` };
        }
      }

      case 'search': {
        if (!args) return { kind: 'text', text: 'Usage: `/search <question>`' };
        if (!config.search.enabled) return { kind: 'text', text: 'Web search is disabled in the config.' };
        return { kind: 'search', query: args };
      }

      case 'image': {
        if (!args) return { kind: 'text', text: 'Usage: `/image <keywords>`' };
        if (!config.image.enabled) return { kind: 'text', text: 'Image sending is disabled.' };
        return { kind: 'image', query: args };
      }

      case 'model': {
        if (!canManage(ctx)) {
          return { kind: 'text', text: 'Only group admins can change the model.' };
        }
        const current = chat.currentModel(ctx.record);
        if (!args) {
          const lines = [
            `**Current model:** \`${current.alias}\` — ${current.label} (\`${current.model}\`, ${current.provider})`,
            '',
            '**Change the model for this chat:**',
            ...chat
              .listModels()
              .map((item) => `• \`/model ${item.alias}\` — ${item.label} (${item.provider}/${item.model})`),
          ];
          return { kind: 'text', text: lines.join('\n') };
        }
        const saved = await chat.setModel(ctx.chatId, args, ctx.chatType, ctx.record);
        if (!saved.ok) {
          return {
            kind: 'text',
            text: `No model named "${args}". Choose: ${chat.listModels().map((item) => item.alias).join(', ')}`,
          };
        }
        return {
          kind: 'text',
          text: `Switched to **${saved.model.label}** (\`${saved.model.model}\`, ${saved.model.provider}).`,
        };
      }

      case 'think':
        return settingsCommands.think(ctx, args);

      case 'remind': {
        if (!reminderService.available()) {
          return { kind: 'text', text: 'Reminders are not configured.' };
        }
        const raw = args.trim();
        const lower = raw.toLowerCase();
        const listText = () => {
          const items = reminderService
            .list(ctx.chatId)
            .slice()
            .sort((a, b) => a.at - b.at);
          if (!items.length) {
            return `No reminders in this chat yet. Use \`/remind 20:00 tomorrow team meeting\`.`;
          }
          return [
            `**Reminders in this chat** (${items.length}/${REMINDER_LIMITS.MAX_PER_CHAT})`,
            ...items.map((item) => `• #${item.id} — ${formatReminderTime(item.at)} — ${item.text}`),
            '',
            'Remove with `/remind remove <id>`.',
          ].join('\n');
        };

        if (!raw || ['list', 'danh sách', 'danh sach'].includes(lower)) {
          return { kind: 'text', text: listText() };
        }

        const cancel = /^(remove|cancel|xoa|xóa)(?:\s+|$)/i.exec(raw);
        if (cancel) {
          const target = raw.slice(cancel[0].length).trim();
          if (!target) {
            return { kind: 'text', text: 'Use `/remind remove <id>` (see ids with `/remind list`).' };
          }
          const removed = await reminderService.cancel(ctx.chatId, target);
          return {
            kind: 'text',
            text: removed
              ? `Removed reminder #${removed.id}: ${removed.text}`
              : `No reminder "${target}" in this chat.`,
          };
        }

        const parsed = parseReminderArgs(raw);
        if (parsed.error) return { kind: 'text', text: parsed.error };
        const result = await reminderService.addAt(
          ctx.chatId,
          /** @type {number} */ (parsed.at),
          /** @type {string} */ (parsed.text),
          ctx.senderId,
        );
        if (!result.ok) {
          return {
            kind: 'text',
            text:
              result.reason === 'chat-limit'
                ? `This chat already has ${REMINDER_LIMITS.MAX_PER_CHAT} reminders — remove one with \`/remind remove <id>\`.`
                : 'The total reminder limit is reached; try again later.',
          };
        }
        return {
          kind: 'text',
          text: `Reminder #${result.item.id} set for ${formatReminderTime(result.item.at)}: ${result.item.text}`,
        };
      }

      case 'split':
        return settingsCommands.split(ctx, args);

      case 'tone':
        return settingsCommands.tone(ctx, args);

      case 'ping': {
        try {
          const ms = await transport.ping(ctx.chatId);
          return { kind: 'text', text: `Pong! The platform API replied in ${ms}ms.` };
        } catch (error) {
          return { kind: 'text', text: `Ping failed: ${String(/** @type {any} */ (error)?.message ?? error)}` };
        }
      }

      default:
        return { kind: 'text', text: `Unknown command \`/${name}\`. Type /help to see the list.` };
    }
  }

  return { run, parseCommand };
}
