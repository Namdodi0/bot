import { createAgent } from '../../core/ai/agent.js';
import { createToolRuntime } from '../../core/ai/tools.js';

/**
 * Discord-native command handlers need the answer as data (to put it in an embed/edit a
 * reply), not as channel messages. This runs the shared engine against a capture transport
 * and returns the text and images it emitted.
 * @param {{config: any, logger: import('../../core/logger.js').Logger, metrics: any, platform: import('../contract.js').Platform, runtime: any}} deps
 */
export function createAskRunner(deps) {
  const { config, logger, metrics, platform, runtime } = deps;

  /** @typedef {{texts: string[], photos: Array<{url: string, caption?: string, data?: Buffer, contentType?: string}>}} Sink */
  /** @type {Sink} */
  let sink = { texts: [], photos: [] };

  const captureTransport = {
    get displayName() {
      return platform.transport.displayName;
    },
    async sendMessage(chatId, text) {
      void chatId;
      sink.texts.push(String(text ?? ''));
      return { ok: true };
    },
    async sendPhoto(chatId, url, caption, asset) {
      void chatId;
      sink.photos.push({
        url: String(url ?? ''),
        caption: caption ? String(caption) : '',
        data: asset?.data ? Buffer.from(asset.data) : undefined,
        contentType: asset?.contentType,
      });
      return { ok: true };
    },
    async sendSticker() {
      throw new Error('Stickers are not supported on Discord');
    },
    startTyping() {
      return async () => {};
    },
    stopAllTyping() {},
    ping() {
      return 0;
    },
  };

  const capturePlatform = {
    ...platform,
    transport: captureTransport,
    capabilities: { ...platform.capabilities, uploadMedia: true },
    commands: { specs: [], run: async () => undefined },
    tools: {
      run: async (name) => (name === 'send_sticker' ? { ok: false, text: 'Stickers are not supported on Discord.' } : null),
    },
    start: async () => ({ ready: {}, done: Promise.resolve() }),
    stop: async () => {},
  };

  const captureTools = createToolRuntime({
    config,
    tavily: runtime.tavily,
    platform: capturePlatform,
    validator: runtime.validator,
    reminders: runtime.reminders,
    logger,
    metrics,
  });

  const agent = createAgent({
    config,
    logger,
    metrics,
    platform: capturePlatform,
    llm: runtime.models,
    store: runtime.store,
    tools: captureTools,
    commands: runtime.commands,
    compaction: runtime.compaction,
  });

  /** @type {Map<string, Promise<unknown>>} */
  const queues = new Map();

  /** @param {any} event */
  function run(event) {
    // Keep per-channel ordering: two `/ask` interactions in the same channel must not
    // interleave writes to the same context record.
    const chatId = String(event?.chatId ?? '');
    const previous = queues.get(chatId) ?? Promise.resolve();
    const task = previous.then(async () => {
      sink = { texts: [], photos: [] };
      const current = sink;
      await agent.handle(event);
      return { text: current.texts.join('\n').trim(), photos: current.photos };
    });
    const guarded = task.catch(() => {});
    queues.set(chatId, guarded);
    guarded.then(() => {
      if (queues.get(chatId) === guarded) queues.delete(chatId);
    });
    return task;
  }

  /**
   * @param {any} args
   * @param {{chatId: string, platform?: string, deadline?: number}} ctx
   */
  async function image(args, ctx) {
    sink = { texts: [], photos: [] };
    const current = sink;
    const result = await captureTools.run('send_image', args, ctx);
    return { result, text: current.texts.join('\n').trim(), photos: current.photos };
  }

  return { run, image, agent };
}
