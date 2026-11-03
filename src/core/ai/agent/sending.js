import { chunkText } from '../../text/format.js';
import { preview, sleep } from './helpers.js';

/**
 * @param {{config: any, logger: import('../../logger.js').Logger, metrics: any, platform: import('../../../platforms/contract.js').Platform}} deps
 */
export function createSenderFactory({ config, logger, metrics, platform }) {  const transport = platform.transport;
  /**
   * @param {string} chatId
   * @param {() => Promise<void>|void} [onFirstSend] called once right before the first message (stops typing)
   * @param {{replyToMessageId?: string|null}} [options]
   * @returns {{enqueue: (text: string) => Promise<void>, wait: () => Promise<void>, sent: () => number}}
   */
  function makeSender(chatId, onFirstSend = async () => {}, options = {}) {
    let chain = Promise.resolve();
    let sent = 0;
    let firstSendHandled = false;
    const limit = config.maxMessagesPerReply > 0 ? config.maxMessagesPerReply : Number.POSITIVE_INFINITY;

    /** @param {string} text */
    function enqueue(text) {
      chain = chain
        .then(async () => {
          if (sent >= limit) return;
          if (!firstSendHandled) {
            firstSendHandled = true;
            // stop "typing" BEFORE sending the first message so the platform stops showing the action
            try {
              await onFirstSend();
            } catch {
              // ignore
            }
          }
          // Each platform owns its markdown dialect and output limits.
          const payload = platform.formatOutgoing(text);
          if (!payload) return;
          await transport.sendMessage(chatId, payload, {
            ...(sent === 0 && options.replyToMessageId
              ? { replyToMessageId: String(options.replyToMessageId) }
              : {}),
          });
          sent += 1;
          logger.info(`🤖 bot: ${preview(payload)}`, {
            chatId,
            part: sent,
            ...(config.maxMessagesPerReply > 0 ? { limit: config.maxMessagesPerReply } : {}),
          });
          if (sent < limit) await sleep(300);
        })
        .catch((error) => {
          logger.warn('send message failed', { error: String(error?.message ?? error), chatId, icon: '📤' });
          metrics.inc('messages.sendError');
        });
      return chain;
    }

    return { enqueue, wait: () => chain, sent: () => sent };
  }

  /**
   * @param {ReturnType<typeof makeSender>} sender
   * @param {string} text
   */
  async function sendText(sender, text) {
    const limit =
      config.maxMessagesPerReply > 0
        ? config.maxMessagesPerReply - sender.sent()
        : Number.POSITIVE_INFINITY;
    const remaining = Math.max(0, limit);
    if (remaining <= 0) return 0;
    const truncationSuffix = '\n\n…';
    let result = chunkText(text, { limit: platform.limits.text, maxChunks: remaining });
    // The truncation marker is appended after chunking: reserve room so the last chunk
    // cannot exceed the platform hard limit.
    if (result.truncated && Number.isFinite(remaining)) {
      const limit = Math.max(1, platform.limits.text - truncationSuffix.length);
      result = chunkText(text, { limit, maxChunks: remaining });
    }
    const { chunks, truncated } = result;
    if (!chunks.length) return 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const isLast = index === chunks.length - 1;
      const suffix = truncated && isLast ? '\n\n…' : '';
      await sender.enqueue(`${chunks[index]}${suffix}`);
    }
    return chunks.length;
  }

  return { makeSender, sendText };
}

/**
 * Sink that collects a turn's output instead of sending it. Used by native UIs (Discord
 * slash commands) that render the answer themselves. Implements the same surface as the
 * sender returned by `makeSender`, plus `sendPhoto`.
 *
 * `live: true` streams deltas through `onDelta` and stores the final text (instead of
 * accumulating progressive chunks), for UIs that edit one message as tokens arrive.
 * @param {{live?: boolean, onDelta?: (delta: string) => void}} [options]
 */
export function createCollectorSink(options = {}) {
  const live = options.live === true;
  const onDelta = options.onDelta;
  /** @type {string[]} */
  const texts = [];
  /** @type {Array<{url: string, caption: string, data?: Buffer, contentType?: string}>} */
  const photos = [];
  let streamed = '';
  let finalText = '';
  return {
    live,
    onDelta: live
      ? (/** @type {string} */ delta) => {
          streamed += delta;
          onDelta?.(delta);
        }
      : undefined,
    /** @param {string} text */
    async enqueue(text) {
      const value = String(text ?? '');
      if (live) {
        finalText = value;
        return;
      }
      if (value.trim()) texts.push(value);
    },
    async wait() {},
    sent() {
      return live ? (finalText ? 1 : 0) : texts.length;
    },
    /**
     * @param {string} url
     * @param {string} [caption]
     * @param {{data?: Buffer, contentType?: string}} [asset]
     */
    async sendPhoto(url, caption = '', asset = {}) {
      photos.push({
        url: String(url ?? ''),
        caption: String(caption ?? ''),
        data: asset?.data ? Buffer.from(asset.data) : undefined,
        contentType: asset?.contentType,
      });
    },
    result() {
      return { text: live ? finalText || streamed.trim() : texts.join('\n').trim(), photos };
    },
  };
}
