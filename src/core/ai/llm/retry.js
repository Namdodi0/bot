/** A provider Retry-After hint never blocks the turn for longer than this. */
const RETRY_AFTER_CAP_MS = 30_000;

/**
 * Retry executor kept separate from the adapter: the adapter declares the policy, the executor re-runs it.
 * @param {{maxAttempts?: number, backoffMs?: (attempt: number) => number, shouldRetry?: (error: unknown) => boolean, sleep?: (ms: number) => Promise<void>, minRemainingMs?: number, reserveMs?: number}} [options]
 */
export function createRetryExecutor(options = {}) {
  const maxAttempts = options.maxAttempts ?? 2;
  const backoffMs = options.backoffMs ?? ((attempt) => 400 * attempt);
  const shouldRetry = options.shouldRetry ?? (() => false);
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const minRemainingMs = options.minRemainingMs ?? 1500;
  // Time kept free for a fallback provider instead of spending it on a retry sleep.
  const reserveMs = Math.max(0, Number(options.reserveMs) || 0);

  /**
   * Sleep that wakes early when the caller aborts, so /stop does not wait out a backoff.
   * With a signal the wait uses its own timer (cleared on abort); without one the injected
   * sleep is used so tests stay deterministic.
   * @param {number} ms
   * @param {AbortSignal|null} signal
   */
  function waitDelay(ms, signal) {
    if (!signal) return sleep(ms);
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(undefined);
      };
      const onAbort = () => finish();
      const timer = setTimeout(finish, ms);
      timer.unref?.();
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * @template T
   * @param {(input: {attempt: number, deadline: number}) => Promise<T>} fn
   * @param {{deadline?: number, signal?: AbortSignal|null, onRetry?: (error: unknown, attempt: number) => void}} [context]
   * @returns {Promise<T>}
   */
  async function execute(fn, context = {}) {
    const deadline = context.deadline ?? Number.POSITIVE_INFINITY;
    const signal = context.signal ?? null;
    /** @type {unknown} */
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (signal?.aborted) break;
      if (deadline - Date.now() < minRemainingMs) break;
      try {
        return await fn({ attempt, deadline });
      } catch (error) {
        lastError = error;
        if (attempt === maxAttempts - 1 || !shouldRetry(error)) break;
        if (signal?.aborted) break;
        context.onRetry?.(error, attempt + 1);
        const backoff = backoffMs(attempt + 1);
        // Provider Retry-After hint (LlmError/HttpError/CircuitOpenError) wins over backoff.
        const hint = Number(/** @type {any} */ (error)?.retryAfterMs);
        const requested = Number.isFinite(hint) && hint > 0 ? Math.max(backoff, hint) : backoff;
        const waitMs = Math.min(requested, RETRY_AFTER_CAP_MS);
        const remaining = deadline - Date.now();
        const delay = Number.isFinite(remaining)
          ? Math.min(waitMs, Math.max(0, remaining - Math.max(minRemainingMs, reserveMs)))
          : waitMs;
        await waitDelay(delay, signal);
        if (signal?.aborted) break;
      }
    }

    if (lastError) throw lastError;
    throw new Error('Timed out before calling the model');
  }

  return { execute, maxAttempts };
}
