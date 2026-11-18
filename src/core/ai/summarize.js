import { truncate } from '../text/format.js';
import { SUMMARY_SYSTEM_PROMPT, buildSummaryInput } from './prompt/index.js';

/**
 * Summarizer used for compaction — keeps the chat's route when a record is present.
 * @param {{llm: any, logger?: import('../logger.js').Logger}} options
 */
export function createSummarizer(options) {
  const llm = options.llm;

  /**
   * @param {any[]} messages
   * @param {number} [deadline]
   * @param {any} [record]
   */
  return async function summarize(messages, deadline = Number.POSITIVE_INFINITY, record = null) {
    if (!messages?.length) return '';
    // Auxiliary work has one budget, even when the reply itself has no deadline.
    const endTime = Math.min(deadline, Date.now() + 15_000);
    const transcript = buildSummaryInput(messages);
    const left = endTime - Date.now();
    if (left <= 0) return '';
    const signal = AbortSignal.timeout(Math.ceil(left));
    let summary = '';
    let offset = 0;
    while (offset < transcript.length) {
      const prefix = summary ? `Previous summary:\n${summary}\n\nTranscript continuation:\n` : '';
      let end = Math.min(transcript.length, offset + 12_000 - prefix.length);
      // The transcript is well-formed; never leave half a surrogate pair in either chunk.
      if (end < transcript.length && /[\uD800-\uDBFF]/.test(transcript[end - 1])) end -= 1;
      const content = prefix + transcript.slice(offset, end);
      const timeout = endTime - Date.now();
      if (timeout <= 0 || signal.aborted) return '';
      const response = await llm.chat({
        ...(record ? { record } : {}),
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content },
        ],
        reasoning: 'none',
        temperature: 0.3,
        maxTokens: 200,
        timeoutMs: timeout,
        signal,
      });
      if (signal.aborted || Date.now() >= endTime) return '';
      summary = truncate(String(response.content ?? '').trim(), 900).trim();
      // Never let a partial result replace the entire selected range.
      if (!summary) return '';
      offset = end;
    }
    return summary;
  };
}
