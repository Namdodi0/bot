import { assembleRequest } from '../../context/assembler.js';
import {
  searchEntry,
  syncContexts,
  toolCallEntry,
  toolResultEntry,
  turnEntry,
} from '../../context/record.js';
import { normalizeWhitespace, truncate } from '../../text/format.js';
import { LLM_ERROR } from '../llm/errors.js';
import { buildSearchContext, createPrompt } from '../prompt/index.js';
import { pickStyleSeed } from '../prompt/sections.js';
import {
  DEFAULT_MAX_TOOL_ROUNDS,
  FALLBACK_MIN_MS,
  SLOW_CALL_WARN_MS,
  TOOL_ROUND_WARN,
  effectiveReasoning,
  fallbackMessages,
  findBreak,
  planAttemptBudget,
  preview,
  providerTimeout,
  samplingFor,
  sleep,
  timeoutSignal,
} from './helpers.js';

/**
 * @param {{config: any, logger: import('../../logger.js').Logger, metrics: any, platform: import('../../../platforms/contract.js').Platform, llm: ReturnType<typeof import('../router.js').createModelRouter>, tools: ReturnType<typeof import('../tools.js').createToolRuntime>, store: ReturnType<typeof import('../../context/store.js').createContextStore>, compaction: ReturnType<typeof import('../../context/compaction/engine.js').createCompactionEngine>, makeSender: ReturnType<typeof import('./sending.js').createSenderFactory>['makeSender'], sendText: ReturnType<typeof import('./sending.js').createSenderFactory>['sendText'], meter: ReturnType<typeof import('../../context/token-meter.js').createTokenMeter>, retryExecutor: ReturnType<typeof import('../llm/retry.js').createRetryExecutor>}} deps
 */
export function createTurnRunner(deps) {
  const { config, logger, metrics, platform, llm, tools, store, compaction, makeSender, sendText, meter, retryExecutor } = deps;
  const transport = platform.transport;

  /**
   * @param {import('../../../platforms/contract.js').BotEvent} event
   * @param {any} record
   * @param {{forceSearch?: string}} [options]
   * @param {() => Promise<void>|void} [stopTyping]
   */
  async function run(event, record, options = {}, stopTyping = async () => {}) {
    const startedAt = Date.now();
    // config.responseTimeoutMs=0 means no deadline: wait for the model as long as it takes.
    const deadline =
      config.responseTimeoutMs > 0 ? startedAt + config.responseTimeoutMs : Number.POSITIVE_INFINITY;
    const sender = makeSender(event.chatId, stopTyping, { replyToMessageId: event.messageId });

    const rawText = normalizeWhitespace(event.text ?? '');
    // The model is text-only: images are only noted, image content is not sent to the API.
    const imageNote = 'the user attached an image — the bot cannot see its content';
    const effectiveText =
      rawText || (event.imageUrl ? 'The user sent an image — the bot cannot see its content.' : '');
    if (!effectiveText) return;

    const textWithImage =
      rawText && event.imageUrl ? `${rawText}\n[${imageNote}]` : effectiveText;
    const isGroup = event.chatType !== 'PRIVATE';
    const storedText = isGroup && textWithImage ? `${event.senderName}: ${textWithImage}` : textWithImage;

    const userTurn = turnEntry({
      text: storedText,
      name: event.senderName,
      ts: Date.now(),
      messageId: event.messageId,
    });

    const tone = record?.meta?.tone ?? config.tone;
    const toolDefs = tools.definitions();
    const promptOptions = {
      platform,
      botName: event.botName || transport.displayName || 'AI assistant',
      chatType: isGroup ? 'GROUP' : 'PRIVATE',
      imageEnabled: config.image.enabled,
      tone,
      // Rotates every turn so the roast reaches for different imagery instead of repeating itself.
      styleSeed: pickStyleSeed((record?.turns ?? 0) + 1),
    };
    const promptRegistry = createPrompt({
      ...promptOptions,
      // Tool guidance only appears when the matching schema is actually sent to the model.
      tools: toolDefs,
    });
    const promptAssembly = promptRegistry.assemble({ text: effectiveText, now: new Date() });
    const systemPrompt = promptRegistry.render(promptAssembly);
    // Same prompt without tool guidance, for the calls that send no tool schemas.
    const noToolsRegistry = createPrompt({ ...promptOptions, tools: [] });
    const noToolsSystemPrompt = noToolsRegistry.render(
      noToolsRegistry.assemble({ text: effectiveText, now: new Date() }),
    );

    const reasoning = effectiveReasoning(config, record, effectiveText);
    const target = llm.resolve(record);
    // `/split` is per chat and takes priority over config.progressive.
    const splitMode = ['auto', 'on', 'off'].includes(record?.meta?.split)
      ? record.meta.split
      : config.progressive;
    const streaming = splitMode !== 'off';
    // `on` = send split segments early (once a sentence is complete); `auto` = only when the wait is long.
    const flushAfterMs = splitMode === 'on' ? 0 : config.progressiveAfterMs;
    const minHeadChars = splitMode === 'on' ? 80 : 160;
    // With a limit of exactly 1 message, do not split early: sending the head uses the only slot
    // and the rest is dropped without any sign.
    const flushAllowed = config.maxMessagesPerReply !== 1;

    // Save the user turn RIGHT AWAY (before calling the model) so the question survives a crash/timeout.
    record.messages.push(userTurn);
    record.turns = (record.turns ?? 0) + 1;

    // /search: the result is durable context, inserted right before the current user turn.
    if (options.forceSearch) {
      const search = await tools.run(
        'web_search',
        { query: options.forceSearch },
        { chatId: event.chatId, senderId: event.senderId, platform: event.platform, deadline },
      );
      record.messages.splice(
        record.messages.length - 1,
        0,
        searchEntry(buildSearchContext(options.forceSearch, search.text)),
      );
    }

    // Runtime context (time...) comes from the prompt registry and is materialized
    // as durable user messages — refreshed every turn, never mutating the user turn.
    syncContexts(record, promptAssembly.contexts);
    store.touch(event.chatId);

    const buildAll = () =>
      assembleRequest({
        systemPrompt,
        tools: toolDefs,
        record,
        maxTokens: config.context.maxTokens,
        maxMessages: config.context.maxMessages,
        maxCharsPerMessage: config.context.maxCharsPerMessage,
        contextWindow: target.contextWindow ?? config.context.modelWindow ?? 0,
        meter,
      });

    let built = buildAll();

    try {
      const measure = () => {
        const current = buildAll();
        return { pressure: current.pressure, tokens: current.estimatedTokens };
      };
      const result = await compaction.compactIfNeeded({
        record,
        trigger: built.needsSummary ? 'dropped' : 'pressure',
        deadline,
        measure,
      });
      if (result?.changed) {
        built = buildAll();
        metrics.inc('context.summarized');
      }
    } catch (error) {
      logger.warn('compaction failed, fallback to trimming', {
        error: String(/** @type {any} */ (error)?.message ?? error),
      });
    }

    const messages = built.messages;
    // Tool history must not go to a call without tool schemas, and that call must not
    // advertise tools in its system prompt either.
    const noToolsMessages = () => {
      const list = fallbackMessages(messages);
      if (list[0]?.role === 'system') list[0] = { role: 'system', content: noToolsSystemPrompt };
      return list;
    };

    // Proof that context reaches the API: with config.logLevel=debug you see the message count
    // (history included) and the character count of the whole payload on every turn.
    logger.debug('llm payload', {
      chatId: event.chatId,
      messages: messages.length,
      kept: built.keptMessages,
      dropped: built.dropped,
      estTokens: built.estimatedTokens,
      pressure: built.pressure,
      contextWindow: built.contextWindow,
      chars: messages.reduce(
        (sum, message) =>
          sum + (typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length),
        0,
      ),
    });

    let streamBuffer = '';
    let emitted = 0;
    let flushed = false;
    // After a round with a tool call, the next round is a fresh, complete answer —
    // do not split early anymore to avoid missing or duplicated segments.
    let flushLocked = false;

    const onDelta = (delta) => {
      if (!streaming || flushed || flushLocked || !flushAllowed) return;
      streamBuffer += delta;
      const elapsed = Date.now() - startedAt;
      if (elapsed < flushAfterMs) return;
      if (streamBuffer.length < minHeadChars) return;
      const cut = findBreak(streamBuffer);
      if (cut < minHeadChars) return;
      const rawHead = streamBuffer.slice(0, cut);
      const head = rawHead.trimEnd();
      streamBuffer = streamBuffer.slice(cut);
      flushed = true;
      emitted = rawHead.length;
      sendText(sender, head).catch((error) => {
        logger.warn('progressive send failed', { error: String(error?.message ?? error), icon: '✂️' });
      });
    };

    let finalText = '';
    let aborted = false;
    // Collect the model's "thinking" (reasoning_content) to print to the console.
    let thinkingText = '';
    let reasoningTokens = 0;
    // LLM stats for this turn for logging: total call time, real generation time (TTFT subtracted),
    // generated tokens → tok/s. Accumulated across tool-call rounds.
    let llmMs = 0;
    let completionMs = 0;
    let completionTokens = 0;
    let overflowRecovered = false;
    /** @type {{model: string, alias: string, provider: string}|null} */
    let answeredBy = null;
    let abortReason = '';

    const configuredRounds = Number(config.ai?.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS);
    const unlimitedRounds = !Number.isFinite(configuredRounds) || configuredRounds <= 0;

    for (let round = 0; unlimitedRounds || round < configuredRounds; round += 1) {
      if (unlimitedRounds && round === TOOL_ROUND_WARN) {
        logger.warn('many tool rounds (maxToolRounds=0)', { chatId: event.chatId, round, icon: '🔁' });
      }
      const remaining = deadline - Date.now();
      if (remaining < 1500) {
        aborted = true;
        break;
      }

      /** @type {any} */
      let response = null;
      /** @type {unknown} */
      let lastError = null;

      let attemptIndex = 0;
      const callOnce = async () => {
        attemptIndex += 1;
        const left = deadline - Date.now();
        const budget = planAttemptBudget({
          remainingMs: left,
          attempt: attemptIndex,
          maxAttempts: retryExecutor.maxAttempts,
          streaming,
          aiTimeoutMs: providerTimeout(config, target.provider),
        });
        // Measure failed calls too: llmMs is the total time actually spent on the LLM.
        const callStarted = Date.now();
        // With no deadline a hung provider would otherwise be silent forever.
        const slowTimer = setTimeout(() => {
          logger.warn('llm call still running', {
            chatId: event.chatId,
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
            messages,
            tools: toolDefs.length ? toolDefs : undefined,
            reasoning,
            maxTokens: config.ai.maxTokens,
            sampling: samplingFor(config, target.provider),
            stream: streaming,
            onDelta,
            ttftMs: budget.ttftMs,
            timeoutMs: budget.timeoutMs,
            signal: timeoutSignal(budget.timeoutMs),
          });
        } finally {
          clearTimeout(slowTimer);
          llmMs += Date.now() - callStarted;
        }
      };

      try {
        response = await retryExecutor.execute(callOnce, {
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
      } catch (error) {
        lastError = error;
        abortReason = String(/** @type {any} */ (error)?.message ?? error);

        // The provider confirmed a context overflow: compact and retry this same turn.
        if (/** @type {any} */ (error)?.code === LLM_ERROR.CONTEXT_WINDOW_EXCEEDED && !overflowRecovered) {
          overflowRecovered = true;
          try {
            const result = await compaction.compactIfNeeded({
              record,
              trigger: 'overflow',
              deadline,
              measure: () => {
                const current = buildAll();
                return { pressure: current.pressure, tokens: current.estimatedTokens };
              },
            });
            if (result?.changed) {
              built = buildAll();
              messages.splice(0, messages.length, ...built.messages);
              metrics.inc('llm.contextOverflow');
              logger.warn('context overflow: compacted and retried', {
                chatId: event.chatId,
                tokensBefore: result.tokensBefore,
                tokensAfter: result.tokensAfter,
                icon: '📉',
              });
              response = await callOnce();
            }
          } catch (recoveryError) {
            logger.warn('overflow recovery failed', {
              error: String(/** @type {any} */ (recoveryError)?.message ?? recoveryError),
            });
          }
        }
      }

      if (response) {
        answeredBy = { model: target.model, alias: target.alias, provider: target.provider };
      }

      // Last-resort fallback with a DIFFERENT model: drop tools so we still get an answer.
      // `flushed` = the head was already sent to the user; calling fallback now would duplicate content.
      if (!response && !flushed) {
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
            response = await llm.chatWith(fallbackAlias, {
              messages: noToolsMessages(),
              reasoning: 'none',
              maxTokens: config.ai.maxTokens,
              sampling: samplingFor(config, fallbackEntry?.provider ?? target.provider),
              stream: false,
              timeoutMs: fallbackTimeout,
              signal: timeoutSignal(left),
            });
            llmMs += Date.now() - fallbackStarted;
            answeredBy = {
              model: fallbackEntry?.model ?? fallbackAlias,
              alias: fallbackAlias,
              provider: fallbackEntry?.provider ?? target.provider,
            };
            metrics.inc('llm.fallback');
            logger.warn('llm fallback (no tools) succeeded', {
              chatId: event.chatId,
              fallback: fallbackAlias,
              icon: '🛟',
            });
          } catch (error) {
            llmMs += Date.now() - fallbackStarted;
            lastError = error;
            abortReason = String(/** @type {any} */ (error)?.message ?? error);
          }
        } else if (!fallbackAlias) {
          logger.debug('fallback skipped: no other model available', {
            chatId: event.chatId,
            model: target.model,
            icon: '⏭️',
          });
        } else {
          logger.debug('fallback skipped: not enough time', {
            chatId: event.chatId,
            leftMs: left,
            icon: '⏭️',
          });
        }
      }

      if (!response) {
        // Part of the reply was already sent (progressive), so treat that part as done.
        if (flushed) {
          aborted = true;
          break;
        }
        throw lastError ?? new Error('The model did not respond');
      }

      completionMs += Number(response.completionMs ?? response.latencyMs ?? 0) || 0;
      completionTokens += Number(response.completionTokens ?? response.usage?.completion_tokens ?? 0) || 0;
      // The first round matches `built.estimatedTokens`; later rounds add tool messages
      // so do not use them for calibration (it would skew the ratio).
      if (round === 0) {
        const promptTokens = Number(response.usage?.prompt_tokens ?? 0);
        // The calibrator needs the RAW estimate, not the already calibrated one.
        if (promptTokens > 0) meter.observe(built.rawEstimatedTokens ?? built.estimatedTokens, promptTokens);
      }
      if (typeof response.reasoning === 'string' && response.reasoning.trim()) {
        thinkingText += `${thinkingText ? '\n\n' : ''}${response.reasoning.trim()}`;
      }
      reasoningTokens += Number(response.usage?.completion_tokens_details?.reasoning_tokens ?? 0) || 0;

      if (response.toolCalls?.length) {
        metrics.inc('llm.toolRounds');
        messages.push({
          role: 'assistant',
          content: response.content || null,
          tool_calls: response.toolCalls.map((call) => ({
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: call.rawArguments || JSON.stringify(call.arguments) },
          })),
        });
        record.messages.push(
          toolCallEntry({ content: response.content ?? '', toolCalls: response.toolCalls, ts: Date.now() }),
        );

        for (const call of response.toolCalls) {
          const started = Date.now();
          /** @type {{ok?: boolean, text: string}} */
          let result;
          try {
            result = await tools.run(call.name, call.arguments, {
              chatId: event.chatId,
              senderId: event.senderId,
              deadline,
            });
          } catch (error) {
            // Every tool_call id needs a result, otherwise the stored transcript is
            // invalid and every later request fails on the provider.
            const reason = String(/** @type {any} */ (error)?.message ?? error);
            logger.warn('tool call failed', {
              chatId: event.chatId,
              tool: call.name,
              error: reason,
              icon: '⚠️',
            });
            result = { ok: false, text: `Tool ${call.name} failed: ${reason}` };
          }
          metrics.observe(`tool.${call.name}`, Date.now() - started);
          const text = truncate(result.text, 4000);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: text,
          });
          record.messages.push(toolResultEntry({ toolCallId: call.id, text, ts: Date.now() }));
        }
        store.touch(event.chatId);
        // The head of this round was already sent: send the whole final-round content instead of
        // cutting by the previous round's `emitted` (which may be longer than the final answer).
        streamBuffer = '';
        emitted = 0;
        flushLocked = true;
        continue;
      }

      finalText = response.content ?? '';
      aborted = Boolean(response.aborted);
      if (response.aborted) abortReason = response.streamError || 'stream interrupted';
      break;
    }

    // All tool rounds used: force one final answer without tools so fetched data is not lost.
    if (!finalText.trim() && !aborted && messages.some((message) => message.role === 'tool')) {
      const left = deadline - Date.now();
      if (!Number.isFinite(left) || left >= 1500) {
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
            messages: [
              ...noToolsMessages(),
              { role: 'user', content: 'Answer the user now using the tool results above. Do not call any tools.' },
            ],
            reasoning: 'none',
            maxTokens: config.ai.maxTokens,
            sampling: samplingFor(config, target.provider),
            stream: false,
            ttftMs: 0,
            timeoutMs: budget.timeoutMs,
            signal: timeoutSignal(budget.timeoutMs),
          });
          llmMs += Date.now() - started;
          completionMs += Number(response?.completionMs ?? response?.latencyMs ?? 0) || 0;
          completionTokens += Number(response?.completionTokens ?? response?.usage?.completion_tokens ?? 0) || 0;
          if (typeof response?.content === 'string') finalText = response.content;
          answeredBy = { model: target.model, alias: target.alias, provider: target.provider };
        } catch (error) {
          llmMs += Date.now() - started;
          abortReason = String(/** @type {any} */ (error)?.message ?? error);
          logger.warn('final answer after tool rounds failed', {
            chatId: event.chatId,
            error: abortReason,
            icon: '🧩',
          });
        }
      }
    }

    await sender.wait();

    const remainder = finalText.slice(emitted);
    if (remainder.trim()) {
      await sendText(sender, remainder);
    } else if (!flushed && !finalText.trim()) {
      await sendText(sender, 'I do not have an answer for this one yet — please ask again a bit more clearly.');
    }

    record.messages.push(
      turnEntry({
        role: 'assistant',
        text: truncate(normalizeWhitespace(finalText), 4000),
        ts: Date.now(),
      }),
    );
    store.touch(event.chatId);

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
        chatId: event.chatId,
        model: attribution.model,
        ...(reasoningTokens > 0 ? { tokens: reasoningTokens } : {}),
      });
    }
    logger.info(`✅ replied · ${attribution.model} · ${tps || 0} tok/s`, {
      chatId: event.chatId,
      model: attribution.model,
      alias: attribution.alias,
      provider: attribution.provider,
      tps,
      tokens: completionTokens,
      ms: duration,
      llmMs,
      chars: finalText.length,
      ...(aborted ? { aborted: true } : {}),
      messages: sender.sent(),
      kept: built.keptMessages,
      reasoning, // reasoning mode (none/low/...), not the thinking content
      ...(reasoningTokens > 0 ? { thinkingTokens: reasoningTokens } : {}),
    });

    if (aborted) {
      logger.warn('reply aborted', {
        chatId: event.chatId,
        partial: finalText.length,
        reason: abortReason || 'deadline',
        icon: '⏱️',
      });
    }
  }

  return run;
}
