import { planAttemptBudget, providerTimeout, samplingFor } from '../helpers.js';

/**
 * All tool rounds were used: force one final no-tools answer so fetched data is not lost.
 * Returns the turn counters unchanged when the turn already has an answer, is aborted, or
 * has no tool history to answer from.
 *
 * @param {{
 *   config: any,
 *   logger: import('../../../logger.js').Logger,
 *   llm: ReturnType<typeof import('../../router.js').createModelRouter>,
 *   chatId: string,
 *   record: any,
 *   target: {model: string, alias: string, provider: string},
 *   messages: any[],
 *   noToolsMessages: () => any[],
 *   visionMessages?: (() => any[]) | null,
 *   deadline: number,
 *   finalText: string,
 *   aborted: boolean,
 *   llmMs: number,
 *   completionMs: number,
 *   completionTokens: number,
 *   answeredBy: {model: string, alias: string, provider: string}|null,
 *   signal?: AbortSignal|null,
 * }} input
 * @returns {Promise<{
 *   finalText: string,
 *   llmMs: number,
 *   completionMs: number,
 *   completionTokens: number,
 *   answeredBy: {model: string, alias: string, provider: string}|null,
 * }>}
 */
export async function forceFinalAnswer({
  config,
  logger,
  llm,
  chatId,
  record,
  target,
  messages,
  noToolsMessages,
  visionMessages = null,
  deadline,
  finalText,
  aborted,
  llmMs,
  completionMs,
  completionTokens,
  answeredBy,
  signal = null,
}) {
  const unchanged = () => ({ finalText, llmMs, completionMs, completionTokens, answeredBy });
  if (finalText.trim() || aborted || !messages.some((message) => message.role === 'tool')) {
    return unchanged();
  }

  const left = deadline - Date.now();
  if (Number.isFinite(left) && left < 1500) return unchanged();

  const budget = planAttemptBudget({
    remainingMs: left,
    attempt: 1,
    maxAttempts: 1,
    streaming: false,
    aiTimeoutMs: providerTimeout(config, target.provider),
  });
  const started = Date.now();
  try {
    const response = await llm.chat({
      record,
      alias: target.alias,
      messages: [
        // A vision turn keeps its image blocks: the forced answer must still see the image.
        ...(visionMessages ? visionMessages() : noToolsMessages()),
        { role: 'user', content: 'Answer the user now using the tool results above. Do not call any tools.' },
      ],
      reasoning: 'none',
      maxTokens: config.ai.maxTokens,
      sampling: samplingFor(config, target.provider),
      stream: false,
      signal,
      ttftMs: 0,
      timeoutMs: budget.timeoutMs,
    });
    llmMs += Date.now() - started;
    completionMs += Number(response?.completionMs ?? response?.latencyMs ?? 0) || 0;
    completionTokens += Number(response?.completionTokens ?? response?.usage?.completion_tokens ?? 0) || 0;
    if (typeof response?.content === 'string' && response.content.trim()) {
      finalText = response.content;
      answeredBy = { model: target.model, alias: target.alias, provider: target.provider };
    }
  } catch (error) {
    llmMs += Date.now() - started;
    const reason = String(/** @type {any} */ (error)?.message ?? error);
    logger.warn('final answer after tool rounds failed', {
      chatId,
      error: reason,
      icon: '🧩',
    });
  }

  if (!finalText.trim()) answeredBy = null;
  return { finalText, llmMs, completionMs, completionTokens, answeredBy };
}
