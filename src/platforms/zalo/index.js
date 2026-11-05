import { prepareOutgoing } from './format.js';
import { createZaloClient, ZaloApiError } from './client.js';
import { createZaloCommandRunner, zaloHelpNote, ZALO_COMMAND_SPECS, ZALO_HELP_OVERRIDES } from './commands.js';
import { createZaloAdmission, createZaloIncomingHandler } from './incoming.js';
import { startPolling } from './polling.js';
import { registerZaloPrompt, ZALO_TOOL_GUIDANCE } from './prompt.js';
import { createStickerStore } from './stickers.js';
import { createZaloToolRunner, zaloToolDefinitions } from './tools.js';
import { createWebhookServer } from './webhook.js';

/**
 * Build the Zalo platform: transport plus every Zalo-specific policy and feature.
 * @param {{config: any, boot: {logger: import('../../core/logger.js').Logger, metrics: any, http: any}}} input
 * @returns {Promise<import('../contract.js').Platform>}
 */
export async function createZaloPlatform(input) {
  const config = input.config;
  const { logger, metrics, http } = input.boot;

  const client = createZaloClient({
    token: config.zalo.token,
    baseUrl: config.zalo.baseUrl,
    parseMode: config.zalo.parseMode,
    http,
    logger,
    metrics,
    dryRun: config.dryRun,
    typingIntervalMs: config.typingIntervalMs,
  });

  const stickers = config.sticker.enabled
    ? createStickerStore({ file: config.sticker.file, extraIds: config.sticker.extraIds, logger })
    : null;
  if (stickers) await stickers.load();

  /** @type {ReturnType<typeof createWebhookServer>|null} */
  let webhookServer = null;

  const admits = createZaloAdmission(config);

  const platform = {
    name: 'zalo',
    label: 'Zalo',
    transport: client,
    transportMode: config.mode,
    capabilities: {
      stickers: true,
      uploadMedia: false,
      nativeInteractions: false,
      messageEdits: false,
      embeds: false,
      threads: false,
    },
    limits: { text: 1900, caption: 1900 },
    formatOutgoing: (/** @type {string} */ text) => prepareOutgoing(text, { parseMode: config.zalo.parseMode }),
    isAdmin: (/** @type {any} */ event) => {
      if (!config.adminIds.length) return true;
      return config.adminIds.includes(String(event?.senderId ?? ''));
    },
    prompt: {
      register: registerZaloPrompt,
      toolGuidance: ZALO_TOOL_GUIDANCE,
    },
    commands: {
      specs: ZALO_COMMAND_SPECS,
      helpOverrides: ZALO_HELP_OVERRIDES,
      helpNote: zaloHelpNote(config),
      run: createZaloCommandRunner({ config, stickers, transport: client, logger, metrics }),
    },
    tools: {
      definitions: zaloToolDefinitions,
      run: createZaloToolRunner({ config, stickers, transport: client, logger, metrics }),
    },
    healthServices: ['zalo', 'firecrawl', 'tavily'],
    explainError: (/** @type {any} */ error) =>
      error instanceof ZaloApiError && (error.status === 401 || error.code === 401)
        ? 'Zalo rejected the bot token. Admin, please check ZALO_BOT_TOKEN.'
        : null,
    /**
     * @param {import('../contract.js').PlatformStartInput} startInput
     * @returns {Promise<import('../contract.js').PlatformStartResult>}
     */
    async start(startInput) {
      let me;
      try {
        me = await client.getMe();
      } catch (error) {
        logger.error('could not call getMe — check ZALO_BOT_TOKEN', { error });
        throw error;
      }
      logger.info('zalo bot ready', {
        id: me.id,
        name: client.displayName,
        groups: me.can_join_groups,
        icon: '🤖',
      });
      if (config.zalo.botId && me.id && String(me.id) !== config.zalo.botId) {
        logger.warn('config.zalo.botId does not match the token', {
          expected: config.zalo.botId,
          actual: me.id,
        });
      }
      if (me.can_join_groups !== true) {
        logger.warn('this bot is not allowed to join groups (can_join_groups=false)');
      }
      if (!config.allowedChatIds.length) {
        logger.warn('config.allowedChatIds is empty: the bot will reply to every chat. Set the group chat.id.');
      }

      const dispatch = (/** @type {any} */ event) => {
        if (!admits(event)) {
          logger.debug('chat not allowed, skipping', { chatId: event.chatId, icon: '🚫' });
          return;
        }
        startInput.onEvent(event);
      };
      const signal = startInput.signal;
      const aborted = () =>
        new Promise((resolve) => {
          if (signal?.aborted) resolve(undefined);
          else signal?.addEventListener('abort', () => resolve(undefined), { once: true });
        });

      if (config.mode === 'webhook') {
        /** @type {() => void} */
        let resolveFatal = () => {};
        const fatal = new Promise((resolve) => {
          resolveFatal = () => resolve(undefined);
        });
        webhookServer = createWebhookServer({
          config,
          logger,
          metrics,
          onEvent: dispatch,
          onFatal: () => resolveFatal(),
        });
        const { port, url } = await webhookServer.start();
        logger.info('webhook server listening', { port, path: config.webhook.path, icon: '🌐' });

        if (config.webhook.publicUrl) {
          try {
            const result = await client.setWebhook(config.webhook.publicUrl, config.webhook.secret);
            logger.info('setWebhook ok', { result, icon: '🔗' });
          } catch (error) {
            logger.error('setWebhook failed', { error });
          }
        } else {
          logger.info('webhook not registered yet — set config.webhook.publicUrl or call setWebhook manually', {
            localUrl: url,
            icon: '🔗',
          });
        }
        return { ready: { me, mode: 'webhook' }, done: Promise.race([aborted(), fatal]) };
      }

      const once = startInput.once ?? config.once;
      if (once) logger.info('running --once: handle at most 1 update then exit');
      return {
        ready: { me, mode: 'polling' },
        done: startPolling({ zalo: client, onEvent: dispatch, logger, metrics, signal, once }),
      };
    },
    async stop() {
      if (webhookServer) {
        const current = webhookServer;
        webhookServer = null;
        await current.stop();
      }
      client.stopAllTyping();
    },
    // Sticker echo is a Zalo-only feature; the shared agent delegates here.
    handleIncoming: createZaloIncomingHandler({ config, stickers, transport: client, logger, metrics }),
  };

  return /** @type {import('../contract.js').Platform} */ (platform);
}