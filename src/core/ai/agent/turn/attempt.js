import { SLOW_CALL_WARN_MS, planAttemptBudget, providerTimeout, samplingFor } from '../helpers.js';

/**
 * One turn's LLM attempts: per-attempt budget, slow-call warning, retry loop and llmMs
 * accounting. `execute()` is the normal path; `once()` is the single retry after an
 * overflow rebuild.
 *
 * @param {{config: any, logger: import('../../../logger.js').Logger, metrics: any, llm: any, record: any, target: any, chatId: string, messages: any[], toolDefs: any[], reasoning: string, streaming: boolean, onDelta: (delta: string) => void, onReasoning?: (text: string) => void, deadline: number, retryExecutor: any, vision?: boolean, signal?: AbortSignal|null}} input
 */
export function createAttemptRunner({
  config,
  logger,
  metrics,
  llm,
  record,
  target,
  chatId,
  messages,
  toolDefs,
  reasoning,
  streaming,
  onDelta,
  onReasoning,
  deadline,
  retryExecutor,
  vision = false,
  signal = null,
}) {
  let llmMs = 0;

  /** @param {number} [attemptIndex] */
  async function once(attemptIndex = 1) {
    const left = deadline - Date.now();
    const budget = planAttemptBudget({
      remainingMs: left,
      attempt: attemptIndex,
      maxAttempts: retryExecutor.maxAttempts,
      streaming,
      aiTimeoutMs: providerTimeout(config, target.provider),
    });
    const callStarted = Date.now();
    // With no deadline a hung provider would otherwise be silent forever.
    const slowTimer = setTimeout(() => {
      logger.warn('llm call still running', {
        chatId,
        provider: target.provider,
        model: target.model,
        ms: Date.now() - callStarted,
        icon: '🐢',
      });
    }, SLOW_CALL_WARN_MS);
    slowTimer.unref?.();
    try {
      return await llm.chat({
        record,
        alias: target.alias,
        messages,
        tools: toolDefs.length ? toolDefs : undefined,
        reasoning,
        maxTokens: config.ai.maxTokens,
        // Providers that recommend a lower vision temperature (NVIDIA: 0.6) opt in here.
        temperature: vision ? config?.[target.provider]?.visionTemperature : undefined,
        sampling: samplingFor(config, target.provider),
        stream: streaming,
        signal,
        onDelta,
        onReasoning,
        ttftMs: budget.ttftMs,
        timeoutMs: budget.timeoutMs,
      });
    } finally {
      clearTimeout(slowTimer);
      llmMs += Date.now() - callStarted;
    }
  }

  async function execute() {
    let attemptIndex = 0;
    const callOnce = () => {
      attemptIndex += 1;
      return once(attemptIndex);
    };
    return retryExecutor.execute(callOnce, {
      deadline,
      onRetry: (error, nextAttempt) => {
        metrics.inc('llm.retries');
        logger.warn('llm call failed, retrying', {
          attempt: nextAttempt,
          provider: target.provider,
          model: target.model,
          status: /** @type {any} */ (error)?.status,
          error: String(/** @type {any} */ (error)?.message ?? error),
          icon: '🔁',
        });
      },
    });
  }

  return { execute, once, llmMs: () => llmMs };
}
