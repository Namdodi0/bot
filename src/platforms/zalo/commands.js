import { COMMAND_SPECS, insertSpecAfter } from '../../core/commands/registry.js';

/** Zalo-only command: slash commands on Discord intentionally omit it. */
export const STICKER_SPEC = {
  name: 'sticker',
  description: 'Send a sticker',
  help: '`/sticker [mood]` — send a sticker; `/sticker add <id> [name]` to add an ID',
};

export const ZALO_COMMAND_SPECS = insertSpecAfter(COMMAND_SPECS, 'image', STICKER_SPEC);

export const ZALO_HELP_OVERRIDES = {
  ping: '`/ping` — check the connection to Zalo',
};

/** @param {any} config */
export function zaloHelpNote(config) {
  return [
    config.mode === 'polling'
      ? 'The bot is running in polling mode (local).'
      : 'The bot is running in webhook mode.',
    'In groups, **@mention the bot** or **reply** to one of its messages so it answers.',
  ].join('\n');
}

/** @param {{chatType?: string, isAdmin?: boolean}} ctx */
function canManage(ctx) {
  if (ctx.chatType !== 'GROUP') return true;
  if (typeof ctx.isAdmin === 'boolean') return ctx.isAdmin;
  return true;
}

/**
 * Handle the Zalo-only `/sticker` command. Returning undefined lets the shared router
 * handle every other command.
 * @param {{config: any, stickers: any, transport: any, logger?: any, metrics?: any}} deps
 */
export function createZaloCommandRunner(deps) {
  const { config, stickers, transport, logger, metrics } = deps;

  /** @param {string} name @param {string} args @param {any} ctx */
  return async function run(name, args, ctx) {
    if (name !== 'sticker') return undefined;
    if (!config.sticker.enabled) {
      return { kind: 'text', text: 'The sticker feature is disabled in the config.' };
    }
    if (!stickers) {
      return { kind: 'text', text: 'No sticker catalog yet.' };
    }
    const raw = args.trim();
    const lower = raw.toLowerCase();

    const listText = () => {
      const items = stickers.list();
      return [
        `**Stickers** — ${items.length} IDs available`,
        'Send: `/sticker <name or mood>`. Admins add IDs with `/sticker add <id> [name]`.',
        'Only **official sticker IDs** are accepted (20 hex chars); pack IDs from stickers.zaloapp.com make Zalo return error 425.',
        '',
        ...items
          .slice(0, 20)
          .map(
            (item) =>
              `• \`${item.id}\` — ${item.name}${item.tags.length ? ` (${item.tags.slice(0, 3).join(', ')})` : ''}`,
          ),
      ].join('\n');
    };

    if (!raw || lower === 'list' || lower === 'danh s\u00E1ch') {
      return { kind: 'text', text: listText() };
    }

    if (lower === 'add' || lower.startsWith('add ')) {
      if (!canManage(ctx)) {
        return { kind: 'text', text: 'Only group admins can add stickers.' };
      }
      const rest = raw.slice(3).trim();
      const [idPart, ...nameParts] = rest.split(/\s+/);
      if (!idPart) return { kind: 'text', text: 'Usage: `/sticker add <id> [name]`' };
      if (!/^[a-f0-9]{20}$/i.test(idPart)) {
        return { kind: 'text', text: 'The sticker ID must be exactly 20 hex characters (for example `0e078a2fb66a5f34067b`).' };
      }
      try {
        // send once so Zalo confirms the ID is valid
        await transport.sendSticker(ctx.chatId, idPart);
      } catch (error) {
        return {
          kind: 'text',
          text: `Zalo rejected the sticker \`${idPart}\`: ${String(/** @type {any} */ (error)?.message ?? error)}`,
        };
      }
      try {
        const { item, added } = await stickers.add({ id: idPart, name: nameParts.join(' ') || undefined });
        logger?.info('sticker added', { id: item.id, added, icon: '🧩' });
        metrics?.inc(added ? 'sticker.added' : 'sticker.exists');
        return {
          kind: 'text',
          text: added
            ? `Added and test-sent the sticker **${item.name}** (\`${item.id}\`).`
            : `The sticker **${item.name}** was already there — just test-sent it.`,
        };
      } catch (error) {
        return { kind: 'text', text: `Could not save the sticker: ${String(/** @type {any} */ (error)?.message ?? error)}` };
      }
    }

    if (lower === 'remove' || lower === 'xoa' || lower.startsWith('remove ') || lower.startsWith('xoa ')) {
      if (!canManage(ctx)) {
        return { kind: 'text', text: 'Only group admins can remove stickers.' };
      }
      const target = raw.replace(/^(remove|xoa)\s+/i, '').trim();
      if (!target || ['remove', 'xoa'].includes(target.toLowerCase())) {
        return { kind: 'text', text: 'Usage: `/sticker remove <id|name>`' };
      }
      const removed = await stickers.remove(target);
      return {
        kind: 'text',
        text: removed
          ? `Removed the sticker **${removed.name}** (\`${removed.id}\`).`
          : `No sticker named "${target}" was found in the self-added list.`,
      };
    }

    const item = stickers.find(raw);
    if (!item) {
      return { kind: 'text', text: `No sticker matches "${raw}".\n\n${listText()}` };
    }
    return { kind: 'sticker', stickerId: item.id, name: item.name };
  };
}