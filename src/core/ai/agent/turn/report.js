import { preview } from '../helpers.js';

/**
 * Turn completion logging: thinking content, the `✅ replied` line and the aborted warning.
 * Also records the reply duration and the `messages.replied` counter.
 *
 * @param {{
 *   config: any,
 *   logger: import('../../../logger.js').Logger,
 *   metrics: any,
 *   chatId: string,
 *   startedAt: number,
 *   finalText: string,
 *   built: {keptMessages?: number},
 *   responseSink: {sent: () => number},
 *   reasoning: string,
 *   target: {model: string, alias: string, provider: string},
 *   answeredBy: {model: string, alias: string, provider: string}|null,
 *   aborted: boolean,
 *   abortReason: string,
 *   thinkingText: string,
 *   reasoningTokens: number,
 *   llmMs: number,
 *   completionMs: number,
 *   completionTokens: number,
 * }} input
 */
export function reportTurn({
  config,
  logger,
  metrics,
  chatId,
  startedAt,
  finalText,
  built,
  responseSink,
  reasoning,
  target,
  answeredBy,
  aborted,
  abortReason,
  thinkingText,
  reasoningTokens,
  llmMs,
  completionMs,
  completionTokens,
}) {
  const duration = Date.now() - startedAt;
  const tps =
    completionTokens > 0 && completionMs > 0
      ? Math.round((completionTokens / (completionMs / 1000)) * 10) / 10
      : 0;
  const attribution = answeredBy ?? { model: target.model, alias: target.alias, provider: target.provider };
  metrics.observe('agent.reply', duration);
  metrics.inc('messages.replied');
  if (thinkingText && config.logThinking !== false) {
    logger.info(`🧠 thinking: ${preview(thinkingText, 2000)}`, {
      chatId,
      model: attribution.model,
      ...(reasoningTokens > 0 ? { tokens: reasoningTokens } : {}),
    });
  }
  logger.info(`✅ replied · ${attribution.model} · ${tps || 0} tok/s`, {
    chatId,
    model: attribution.model,
    alias: attribution.alias,
    provider: attribution.provider,
    tps,
    tokens: completionTokens,
    ms: duration,
    llmMs,
    chars: finalText.length,
    ...(aborted ? { aborted: true } : {}),
    messages: responseSink.sent(),
    kept: built.keptMessages,
    reasoning, // reasoning mode (none/low/...), not the thinking content
    ...(reasoningTokens > 0 ? { thinkingTokens: reasoningTokens } : {}),
  });

  if (aborted) {
    logger.warn('reply aborted', {
      chatId,
      partial: finalText.length,
      reason: abortReason || 'deadline',
      icon: '⏱️',
    });
  }
}
