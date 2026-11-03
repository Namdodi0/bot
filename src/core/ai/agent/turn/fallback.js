import { FALLBACK_MIN_MS, providerTimeout, samplingFor, sleep, timeoutSignal } from '../helpers.js';

/**
 * Last-resort attempt with a DIFFERENT model. Tools are dropped so the call is valid and
 * still produces an answer. Callers must skip this when part of the reply was already sent.
 *
 * @param {{
 *   config: any,
 *   logger: import('../../../logger.js').Logger,
 *   metrics: any,
 *   llm: ReturnType<typeof import('../../router.js').createModelRouter>,
 *   record: any,
 *   target: {model: string, alias: string, provider: string},
 *   chatId: string,
 *   noToolsMessages: () => any[],
 *   deadline: number,
 * }} input
 * @returns {Promise<{
 *   response: any|null,
 *   answeredBy: {model: string, alias: string, provider: string}|null,
 *   lastError: unknown,
 *   abortReason: string|null,
 *   llmMs: number,
 * }>}
 */
export async function attemptFallback({
  config,
  logger,
  metrics,
  llm,
  record,
  target,
  chatId,
  noToolsMessages,
  deadline,
}) {
  const fallbackAlias = llm.fallbackFor(record);
  const fallbackEntry = fallbackAlias ? llm.find(fallbackAlias) : null;
  let left = deadline - Date.now();
  if (left > 6000) {
    await sleep(800);
    left = deadline - Date.now();
  }
  if (fallbackAlias && left > FALLBACK_MIN_MS) {
    const fallbackStarted = Date.now();
    // Respect the fallback provider's own timeout; 0 = no cap.
    const providerLimit = providerTimeout(config, fallbackEntry?.provider ?? target.provider);
    const timeLeft = Number.isFinite(left) ? Math.max(1500, left - 300) : 0;
    const fallbackTimeout =
      providerLimit > 0 ? (timeLeft > 0 ? Math.min(providerLimit, timeLeft) : providerLimit) : timeLeft;
    try {
      const response = await llm.chatWith(fallbackAlias, {
        messages: noToolsMessages(),
        reasoning: 'none',
        maxTokens: config.ai.maxTokens,
        sampling: samplingFor(config, fallbackEntry?.provider ?? target.provider),
        stream: false,
        timeoutMs: fallbackTimeout,
        signal: timeoutSignal(left),
      });
      const llmMs = Date.now() - fallbackStarted;
      const answeredBy = {
        model: fallbackEntry?.model ?? fallbackAlias,
        alias: fallbackAlias,
        provider: fallbackEntry?.provider ?? target.provider,
      };
      metrics.inc('llm.fallback');
      logger.warn('llm fallback (no tools) succeeded', {
        chatId,
        fallback: fallbackAlias,
        icon: '🛟',
      });
      return { response, answeredBy, lastError: null, abortReason: null, llmMs };
    } catch (error) {
      return {
        response: null,
        answeredBy: null,
        lastError: error,
        abortReason: String(/** @type {any} */ (error)?.message ?? error),
        llmMs: Date.now() - fallbackStarted,
      };
    }
  }
  if (!fallbackAlias) {
    logger.debug('fallback skipped: no other model available', {
      chatId,
      model: target.model,
      icon: '⏭️',
    });
  } else {
    logger.debug('fallback skipped: not enough time', {
      chatId,
      leftMs: left,
      icon: '⏭️',
    });
  }
  return { response: null, answeredBy: null, lastError: null, abortReason: null, llmMs: 0 };
}
