import { findBreak } from '../helpers.js';

/**
 * Progressive reply flushing: sends the first complete segment once enough text has
 * arrived, then leaves the remainder for the final send. Live sinks (Discord edits)
 * bypass this and render deltas themselves.
 *
 * @param {{sink: any, logger: import('../../../logger.js').Logger, sendText: (sink: any, text: string) => Promise<any>, streaming: boolean, flushAfterMs: number, minHeadChars: number, flushAllowed: boolean, startedAt: number}} input
 */
export function createProgressiveFlusher({
  sink,
  logger,
  sendText,
  streaming,
  flushAfterMs,
  minHeadChars,
  flushAllowed,
  startedAt,
}) {
  let buffer = '';
  let emitted = 0;
  let flushed = false;
  let locked = false;

  /** @param {string} delta */
  function onDelta(delta) {
    if (sink.live) {
      sink.onDelta?.(delta);
      return;
    }
    if (!streaming || flushed || locked || !flushAllowed) return;
    buffer += delta;
    const elapsed = Date.now() - startedAt;
    if (elapsed < flushAfterMs) return;
    if (buffer.length < minHeadChars) return;
    const cut = findBreak(buffer);
    if (cut < minHeadChars) return;
    const rawHead = buffer.slice(0, cut);
    const head = rawHead.trimEnd();
    buffer = buffer.slice(cut);
    flushed = true;
    emitted = rawHead.length;
    sendText(sink, head).catch((error) => {
      logger.warn('progressive send failed', { error: String(error?.message ?? error), icon: '✂️' });
    });
  }

  /** After a tool round the next answer is fresh: stop splitting it early. */
  function lockAfterToolRound() {
    buffer = '';
    emitted = 0;
    locked = true;
  }

  return {
    onDelta,
    lockAfterToolRound,
    get emitted() {
      return emitted;
    },
    get flushed() {
      return flushed;
    },
  };
}
