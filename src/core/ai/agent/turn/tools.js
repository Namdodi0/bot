import { toolCallEntry, toolResultEntry } from '../../../context/record.js';
import { truncate } from '../../../text/format.js';

/**
 * Append the assistant `tool_calls` message and one `role: "tool"` result per call to both
 * the request messages and the durable chat record. Every call id gets a result, even when
 * the tool throws, otherwise every later request fails on the provider.
 *
 * @param {{
 *   logger: import('../../../logger.js').Logger,
 *   metrics: any,
 *   tools: ReturnType<typeof import('../../tools.js').createToolRuntime>,
 *   store: ReturnType<typeof import('../../../context/store.js').createContextStore>,
 *   chatId: string,
 *   senderId: string,
 *   deadline: number,
 *   sendPhoto: (url: string, caption?: string, asset?: {data?: Buffer, contentType?: string}) => Promise<any>,
 *   response: any,
 *   messages: any[],
 *   record: any,
 *   privateTurn?: boolean,
 *   imageBudget?: {remaining: number},
 *   onProgress?: (event: any) => void,
 *   turnId?: string,
 * }} input
 */
export async function runToolRound({
  logger,
  metrics,
  tools,
  store,
  chatId,
  senderId,
  deadline,
  sendPhoto,
  response,
  messages,
  record,
  privateTurn = false,
  imageBudget,
  onProgress,
  turnId,
}) {
  metrics.inc('llm.toolRounds');
  messages.push({
    role: 'assistant',
    content: response.content || null,
    tool_calls: response.toolCalls.map((/** @type {any} */ call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.rawArguments || JSON.stringify(call.arguments) },
    })),
  });
  record.messages.push(
    toolCallEntry({
      content: response.content ?? '',
      toolCalls: response.toolCalls,
      ts: Date.now(),
      private: privateTurn,
      ...(turnId ? { turnId } : {}),
    }),
  );

  for (const call of response.toolCalls) {
    const started = Date.now();
    onProgress?.({ type: 'tool', name: call.name, query: call.arguments?.query });
    /** @type {{ok?: boolean, text: string}} */
    let result;
    try {
      if (call.parseError === true) {
        // Never execute arguments the provider did not finish emitting.
        result = {
          ok: false,
          text: `Tool ${call.name} was not executed: its arguments were not valid JSON.`,
        };
      } else if (Number.isFinite(deadline) && Date.now() >= deadline) {
        // The operation deadline already passed: no more side effects for this turn.
        result = { ok: false, text: `Tool ${call.name} was not executed: the turn deadline expired.` };
      } else {
        result = await tools.run(call.name, call.arguments, {
          chatId,
          senderId,
          deadline,
          sendPhoto,
          ...(imageBudget ? { imageBudget } : {}),
          ...(privateTurn ? { suppressDirectSend: true } : {}),
        });
      }
    } catch (error) {
      const reason = String(/** @type {any} */ (error)?.message ?? error);
      logger.warn('tool call failed', {
        chatId,
        tool: call.name,
        error: reason,
        icon: '⚠️',
      });
      result = { ok: false, text: `Tool ${call.name} failed: ${reason}` };
    }
    metrics.observe(`tool.${call.name}`, Date.now() - started);
    onProgress?.({ type: 'tool-result', name: call.name, ok: result.ok !== false });
    const text = truncate(result.text, 4000);
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: text,
    });
    record.messages.push(
      toolResultEntry({
        toolCallId: call.id,
        text,
        ts: Date.now(),
        private: privateTurn,
        ...(turnId ? { turnId } : {}),
      }),
    );
  }
  store.touch(chatId);

  return { calls: response.toolCalls.length };
}
