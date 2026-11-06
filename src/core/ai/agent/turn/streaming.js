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
  let generation = 0;
  /** @type {Promise<void>} */
  let pendingSend = Promise.resolve();

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
    // Attempt at most one progressive send. The cursor advances only when the transport
    // confirms delivery; otherwise the final send must still include this head.
    locked = true;
    const sentFor = generation;
    pendingSend = sendText(sink, head)
      .then((confirmed) => {
        // A tool round may have reset the turn while this send was in flight; its cursor
        // belongs to the previous answer and must not clip the new one.
        if (sentFor !== generation) return;
        if (confirmed > 0) {
          flushed = true;
          emitted = rawHead.length;
        } else {
          logger.warn('progressive send was not confirmed, final answer will include it', { icon: '✂️' });
        }
      })
      .catch((error) => {
        logger.warn('progressive send failed', { error: String(error?.message ?? error), icon: '✂️' });
      });
  }

  /** After a tool round the next answer is fresh: stop splitting it early. */
  function lockAfterToolRound() {
    generation += 1;
    buffer = '';
    emitted = 0;
    flushed = false;
    locked = true;
  }

  return {
    onDelta,
    lockAfterToolRound,
    /** Wait for a progressive send to settle before deciding whether its head was delivered. */
    settled: () => pendingSend,
    get emitted() {
      return emitted;
    },
    get flushed() {
      return flushed;
    },
  };
}
