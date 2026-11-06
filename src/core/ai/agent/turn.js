import { assembleRequest } from '../../context/assembler.js';
import { searchEntry, syncContexts, turnEntry } from '../../context/record.js';
import { normalizeWhitespace, truncate } from '../../text/format.js';
import { LLM_ERROR } from '../llm/errors.js';
import { createPrompt, buildSearchContext } from '../prompt/index.js';
import { MAX_IMAGES_PER_SEND } from '../tools.js';
import {
  DEFAULT_MAX_TOOL_ROUNDS,
  TOOL_ROUND_WARN,
  effectiveReasoning,
  fallbackMessages,
} from './helpers.js';
import { createAttemptRunner } from './turn/attempt.js';
import { attemptFallback } from './turn/fallback.js';
import { forceFinalAnswer } from './turn/final.js';
import { reportTurn } from './turn/report.js';
import { createProgressiveFlusher } from './turn/streaming.js';
import { runToolRound } from './turn/tools.js';

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
   * @param {{enqueue: (text: string) => Promise<void>, wait: () => Promise<void>, sent: () => number, sendPhoto: (url: string, caption?: string, asset?: {data?: Buffer, contentType?: string}) => Promise<any>, live?: boolean, onDelta?: (delta: string) => void}} [sink]
   */
  async function run(event, record, options = {}, stopTyping = async () => {}, sink = null) {
    const startedAt = Date.now();
    // config.responseTimeoutMs=0 means no deadline: wait for the model as long as it takes.
    let deadline =
      config.responseTimeoutMs > 0 ? startedAt + config.responseTimeoutMs : Number.POSITIVE_INFINITY;
    const sender = sink ?? makeSender(event.chatId, stopTyping, { replyToMessageId: event.messageId });
    const responseSink = sink ?? {
      enqueue: (/** @type {string} */ text) => sender.enqueue(text),
      wait: () => sender.wait(),
      sent: () => sender.sent(),
      sendPhoto: (/** @type {string} */ url, /** @type {string} */ caption, /** @type {any} */ asset) =>
        platform.transport.sendPhoto(event.chatId, url, caption, asset),
    };

    const rawText = normalizeWhitespace(event.text ?? '');
    const image = event.imageData?.data ? event.imageData : null;
    // A 120B vision model can stall for minutes; cap image turns without touching text turns.
    if (image && config.nim?.visionTimeoutMs > 0) {
      deadline = Math.min(deadline, Date.now() + config.nim.visionTimeoutMs);
    }
    const selectedTarget = llm.resolve(record);
    // Image turns use a vision-capable alias (config.model.visionAlias) when the selected
    // model cannot see images. If none is configured, the turn stays text-only.
    const visionTarget = image && !selectedTarget.vision ? llm.find(config.model?.visionAlias ?? 'nim') : null;
    const target =
      image && selectedTarget.vision ? selectedTarget : visionTarget?.vision ? visionTarget : selectedTarget;
    const useImage = Boolean(image && target?.vision);
    const hasImage = Boolean(event.imageUrl || image);
    const imageNote = useImage
      ? 'the user attached an image'
      : 'the user attached an image — the bot cannot see its content';
    const effectiveText =
      rawText ||
      (hasImage
        ? useImage
          ? 'The user sent an image.'
          : 'The user sent an image — the bot cannot see its content.'
        : '');
    if (!effectiveText) return;
    if (image && !useImage) {
      logger.debug('image attached but the selected model is text-only', {
        chatId: event.chatId,
        model: target.model,
        icon: '🖼️',
      });
    }

    const textWithImage = rawText && hasImage ? `${rawText}\n[${imageNote}]` : effectiveText;
    const isGroup = event.chatType !== 'PRIVATE';
    const storedText = isGroup && textWithImage ? `${event.senderName}: ${textWithImage}` : textWithImage;

    const userTurn = turnEntry({
      text: storedText,
      name: event.senderName,
      ts: Date.now(),
      messageId: event.messageId,
      private: event.private === true,
    });

    const tone = record?.meta?.tone ?? config.tone;
    const toolDefs = tools.definitions();
    const toolNames = new Set(toolDefs.map((tool) => tool?.function?.name).filter(Boolean));
    const promptOptions = {
      platform,
      botName: event.botName || transport.displayName || 'AI assistant',
      chatType: isGroup ? 'GROUP' : 'PRIVATE',
      // Only advertise the image tool when its schema is actually sent.
      imageEnabled: toolNames.has('send_image'),
      // Tell the model to actually inspect a visible image instead of guessing from the caption.
      visionInput: useImage,
      tone,
    };
    const promptRegistry = createPrompt({
      ...promptOptions,
      // Tool guidance only appears when the matching schema is actually sent to the model.
      tools: toolDefs,
    });
    const promptAssembly = promptRegistry.assemble({ text: effectiveText, now: new Date() });
    const systemPrompt = promptRegistry.render(promptAssembly);
    // Same prompt without tool guidance, for the calls that send no tool schemas.
    // Those calls are text-only (image blocks are stripped), so claim no vision there.
    const noToolsRegistry = createPrompt({ ...promptOptions, imageEnabled: false, visionInput: false, tools: [] });
    const noToolsSystemPrompt = noToolsRegistry.render(
      noToolsRegistry.assemble({ text: effectiveText, now: new Date() }),
    );

    const reasoning = useImage
      ? String(config.model?.visionReasoning ?? 'high')
      : effectiveReasoning(config, record, effectiveText);
    // `/split` is per chat and takes priority over config.progressive.
    const splitMode = ['auto', 'on', 'off'].includes(record?.meta?.split)
      ? record.meta.split
      : config.progressive;
    const streaming = responseSink.live === true || splitMode !== 'off';
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
    const imageContent =
      useImage && image
        ? {
            type: 'image_url',
            image_url: {
              url: `data:${image.contentType || 'image/png'};base64,${Buffer.from(image.data).toString('base64')}`,
            },
          }
        : null;
    // The image belongs to the current turn only; the durable record keeps the text note.
    // Re-apply after an overflow rebuild, which replaces the message array.
    const applyImage = () => {
      if (!imageContent) return;
      const index = messages.findLastIndex((message) => message.role === 'user');
      if (index < 0 || Array.isArray(messages[index].content)) return;
      messages[index] = {
        ...messages[index],
        content: [{ type: 'text', text: String(messages[index].content ?? '') }, imageContent],
      };
    };
    applyImage();
    // Tool history must not go to a call without tool schemas, and that call must not
    // advertise tools in its system prompt either. No-tools calls are text-only.
    const noToolsMessages = () => {
      const list = fallbackMessages(messages);
      if (list[0]?.role === 'system') list[0] = { role: 'system', content: noToolsSystemPrompt };
      return list.map((message) =>
        Array.isArray(message.content)
          ? {
              ...message,
              content: message.content
                .filter((part) => part?.type === 'text')
                .map((part) => part.text)
                .join('\n'),
            }
          : message,
      );
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

    const progressive = createProgressiveFlusher({
      sink: responseSink,
      logger,
      sendText,
      streaming,
      flushAfterMs,
      minHeadChars,
      flushAllowed,
      startedAt,
    });

    let finalText = '';
    let aborted = false;
    // Collect the model's "thinking" (reasoning_content) to print to the console.
    let thinkingText = '';
    let reasoningTokens = 0;
    // LLM stats for this turn for logging: total call time, real generation time (TTFT subtracted),
    // generated tokens → tok/s. Accumulated across tool-call rounds.
    let llmMs = 0;
    let fallbackLlmMs = 0;
    let completionMs = 0;
    let completionTokens = 0;
    let promptTotal = 0;
    let cachedTotal = 0;
    let overflowRecovered = false;
    /** @type {{model: string, alias: string, provider: string}|null} */
    let answeredBy = null;
    let abortReason = '';

    const attempts = createAttemptRunner({
      config,
      logger,
      metrics,
      llm,
      record,
      target,
      chatId: event.chatId,
      messages,
      toolDefs,
      reasoning,
      streaming,
      onDelta: progressive.onDelta,
      deadline,
      retryExecutor,
      vision: Boolean(image),
    });

    // One reply may call send_image several times; share a single image budget across them.
    const imageBudget = { remaining: MAX_IMAGES_PER_SEND };

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

      try {
        response = await attempts.execute();
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
              applyImage();
              metrics.inc('llm.contextOverflow');
              logger.warn('context overflow: compacted and retried', {
                chatId: event.chatId,
                tokensBefore: result.tokensBefore,
                tokensAfter: result.tokensAfter,
                icon: '📉',
              });
              response = await attempts.once(2);
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

      // The progressive head may still be in flight: only a confirmed delivery suppresses fallback.
      await progressive.settled();
      // Last-resort fallback with a DIFFERENT model: drop tools so we still get an answer.
      // `flushed` = the head was already sent to the user; calling fallback now would duplicate content.
      if (!response && !progressive.flushed) {
        const fallback = await attemptFallback({
          config, logger, metrics, llm, record, target,
          chatId: event.chatId, noToolsMessages, deadline,
        });
        fallbackLlmMs += fallback.llmMs;
        if (fallback.response) ({ response, answeredBy } = fallback);
        else if (fallback.lastError) ({ lastError, abortReason } = fallback);
      }

      if (!response) {
        // Part of the reply was already sent (progressive), so treat that part as done.
        if (progressive.flushed) {
          aborted = true;
          break;
        }
        throw lastError ?? new Error('The model did not respond');
      }

      completionMs += Number(response.completionMs ?? response.latencyMs ?? 0) || 0;
      completionTokens += Number(response.completionTokens ?? response.usage?.completion_tokens ?? 0) || 0;
      promptTotal += Number(response.usage?.prompt_tokens ?? 0) || 0;
      cachedTotal += Number(response.cachedTokens ?? 0) || 0;
      // The first round matches `built.estimatedTokens`; later rounds add tool messages
      // so do not use them for calibration (it would skew the ratio).
      if (round === 0) {
        const promptTokens = Number(response.usage?.prompt_tokens ?? 0);
        // Only calibrate a request that was actually sent: fallback uses a different
        // transcript, and image tokens are appended after `built` was measured.
        const fromPrimary = answeredBy?.alias === target.alias && answeredBy?.model === target.model;
        if (promptTokens > 0 && fromPrimary && !useImage) {
          meter.observe(built.rawEstimatedTokens ?? built.estimatedTokens, promptTokens);
        }
      }
      if (typeof response.reasoning === 'string' && response.reasoning.trim()) {
        thinkingText += `${thinkingText ? '\n\n' : ''}${response.reasoning.trim()}`;
      }
      reasoningTokens += Number(response.usage?.completion_tokens_details?.reasoning_tokens ?? 0) || 0;

      if (!response.aborted && response.toolCalls?.length) {
        await runToolRound({
          logger, metrics, tools, store, chatId: event.chatId, senderId: event.senderId,
          deadline, sendPhoto: responseSink.sendPhoto, response, messages, record,
          privateTurn: event.private === true, imageBudget,
        });
        // The head of this round was already sent: send the whole final-round content instead of
        // cutting by the previous round's emitted text (which may be longer than the final answer).
        progressive.lockAfterToolRound();
        continue;
      }

      finalText = response.content ?? '';
      aborted = Boolean(response.aborted);
      if (response.aborted) abortReason = response.streamError || 'stream interrupted';
      break;
    }

    // All tool rounds used: force one final answer without tools so fetched data is not lost.
    ({ finalText, llmMs, completionMs, completionTokens, answeredBy } = await forceFinalAnswer({
      config, logger, llm, chatId: event.chatId, record, target, messages, noToolsMessages, deadline,
      finalText, aborted, llmMs: attempts.llmMs() + fallbackLlmMs, completionMs, completionTokens, answeredBy,
    }));
    // A tool round can set `answeredBy` before a final answer exists; drop it when the
    // forced final call produced no text.
    if (!finalText.trim()) answeredBy = null;

    await progressive.settled();
    await responseSink.wait();

    const remainder = finalText.slice(progressive.emitted);
    if (remainder.trim()) {
      await sendText(responseSink, remainder);
    } else if (!progressive.flushed && !finalText.trim()) {
      await sendText(responseSink, 'I do not have an answer for this one yet — please ask again a bit more clearly.');
    }

    record.messages.push(
      turnEntry({
        role: 'assistant',
        text: truncate(normalizeWhitespace(finalText), 4000),
        ts: Date.now(),
        private: event.private === true,
      }),
    );
    store.touch(event.chatId);

    reportTurn({
      config, logger, metrics, chatId: event.chatId, startedAt, finalText, built, responseSink,
      reasoning, target, answeredBy, aborted, abortReason, thinkingText, reasoningTokens,
      llmMs, completionMs, completionTokens, promptTokens: promptTotal, cachedTokens: cachedTotal,
    });
  }

  return run;
}
