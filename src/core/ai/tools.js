import { formatSearchResults } from '../search/tavily.js';
import { REMINDER_LIMITS, formatReminderTime, parseReminderArgs } from './reminders.js';
import { htmlToText, youtubeVideoId } from './read-url.js';

/** @typedef {(url: string, caption?: string, asset?: {data?: Buffer, contentType?: string}) => Promise<any>} PhotoSender */

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Hard cap for a single send_image request. */
export const MAX_IMAGES_PER_SEND = 5;

/** Characters of page text handed to the model by `read_url` (the fetch cap is 4 MB). */
const READ_URL_MAX_CHARS = 12_000;

/** Wall-clock budget for one send_image call, even when responseTimeoutMs is 0. */
const IMAGE_SEND_BUDGET_MS = 45_000;

/**
 * @param {{config: any, tavily: {search: (query: string, opts?: any) => Promise<any>}|null, platform: import('../../platforms/contract.js').Platform, validator: ReturnType<typeof import('../media/validate.js').createImageValidator>, reminders?: ReturnType<typeof import('./reminders.js').createReminderStore>, logger: import('../logger.js').Logger, metrics?: any, sendDelayMs?: number, imageBudgetMs?: number}} options
 */
export function createToolRuntime(options) {
  const config = options.config;
  const tavily = options.tavily;
  const platform = options.platform;
  const transport = platform.transport;
  const validator = options.validator;
  const reminders = options.reminders;
  const logger = options.logger;
  const metrics = options.metrics;
  const sendDelayMs = options.sendDelayMs ?? 0;
  const imageBudgetMs = options.imageBudgetMs ?? IMAGE_SEND_BUDGET_MS;

  function definitions() {
    /** @type {any[]} */
    const tools = [];
    // SEARCH_AUTO=off → the model does not search the web on its own, but /search still works.
    if (config.search.enabled && config.search.auto) {
      tools.push({
        type: 'function',
        function: {
          name: 'web_search',
          description:
            'Search the web for real-time information (news, prices, weather, events, products). Returns a list of titles + URLs + snippets.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query; keep it short and natural' },
            },
            required: ['query'],
          },
        },
      });
    }
    tools.push({
      type: 'function',
      function: {
        name: 'read_url',
        description:
          'Read a public web page (article, docs, blog post) and return its readable text. Use when the user shares a link or asks about a page.',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Public http(s) URL to read' },
          },
          required: ['url'],
        },
      },
    });
    // The image tool needs a search provider to find URLs; do not advertise it when search is off.
    if (config.image.enabled && tavily) {
      tools.push({
        type: 'function',
        function: {
          name: 'send_image',
          description:
            'Find and send images into the current conversation. Use when the user asks for pictures. Set count to the number of images requested: it sends one message per image. The whole reply is capped at 5 images total, across every send_image call.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Image keywords to search for, e.g. "cute kitten"' },
              count: {
                type: 'integer',
                minimum: 1,
                description: 'How many images to send (default 1, max 5).',
              },
              caption: { type: 'string', description: 'Short caption for the image (optional)' },
            },
            required: ['query'],
          },
        },
      });
    }
    tools.push(...(platform.tools?.definitions?.({ config }) ?? []));
    if (reminders) {
      tools.push({
        type: 'function',
        function: {
          name: 'set_reminder',
          description:
            'Set a reminder in this chat. Use when the user asks to be reminded later ("remind me at 8pm tonight", "remind me in 10 minutes"). Convert the requested time to Vietnam time. Only tell the user the reminder is set after this tool returns ok.',
          parameters: {
            type: 'object',
            properties: {
              when: {
                type: 'string',
                description:
                  'Reminder time in Vietnam time: "HH:MM", "HH:MM tomorrow", "HH:MM dd/mm", or relative "+10m", "+2h", "+1d". Example: "20:00", "08:00 tomorrow", "09:30 05/11", "+30m".',
              },
              text: { type: 'string', description: 'What to remind the user about' },
            },
            required: ['when', 'text'],
          },
        },
      });
    }
    return tools;
  }

  /**
   * @param {any} args
   * @param {{chatId: string, senderId?: string, platform?: string, deadline?: number, suppressDirectSend?: boolean}} ctx
   * @returns {Promise<{ok: boolean, text: string}>}
   */
  async function setReminder(args, ctx) {
    if (!reminders) return { ok: false, text: 'Reminders are not enabled.' };
    if (ctx?.suppressDirectSend) {
      return { ok: false, text: 'Reminders cannot be set from a private answer.' };
    }
    if (Number.isFinite(ctx?.deadline) && Date.now() >= /** @type {number} */ (ctx.deadline)) {
      return { ok: false, text: 'Ran out of time before the reminder could be set.' };
    }
    const when = String(args?.when ?? '').trim();
    const text = String(args?.text ?? args?.content ?? '').trim();
    if (!when) return { ok: false, text: 'Missing the reminder time (when).' };
    if (!text) return { ok: false, text: 'Missing the reminder content (text).' };
    if (text.length > REMINDER_LIMITS.MAX_REMINDER_CHARS) {
      return { ok: false, text: `The reminder content is too long (max ${REMINDER_LIMITS.MAX_REMINDER_CHARS} characters).` };
    }
    // Parse only `when`; a placeholder keeps the parser's content check quiet.
    const parsed = parseReminderArgs(`${when} x`);
    if (parsed.error || !Number.isFinite(parsed.at)) {
      return { ok: false, text: parsed.error ?? 'Invalid reminder time.' };
    }
    const result = await reminders.add({
      chatId: ctx.chatId,
      text,
      at: /** @type {number} */ (parsed.at),
      createdBy: ctx.senderId ?? '',
    });
    if (!result.ok) {
      const reason = /** @type {any} */ (result).reason;
      return {
        ok: false,
        text:
          reason === 'chat-limit'
            ? `This chat already has ${REMINDER_LIMITS.MAX_PER_CHAT} reminders; cancel one first.`
            : 'The reminder limit has been reached, try again later.',
      };
    }
    logger.info('reminder set by model', {
      chatId: ctx.chatId,
      id: result.item.id,
      at: formatReminderTime(result.item.at),
      icon: '⏰',
    });
    return {
      ok: true,
      text: `Reminder #${result.item.id} set for ${formatReminderTime(result.item.at)} (Vietnam time): ${result.item.text}`,
    };
  }

  /**
   * @param {string} name
   * @param {any} args
   * @param {{chatId: string, senderId?: string, platform?: string, deadline?: number, sendPhoto?: PhotoSender}} ctx
   * @returns {Promise<{ok: boolean, text: string, data?: any}>}
   */
  async function run(name, args, ctx) {
    if (name === 'web_search') return webSearch(args, ctx);
    if (name === 'read_url') return readUrl(args, ctx);
    if (name === 'send_image') return sendImage(args, ctx);
    if (name === 'set_reminder') return setReminder(args, ctx);
    const platformResult = await platform.tools?.run?.(name, args, ctx);
    if (platformResult) return platformResult;
    return { ok: false, text: `Tool does not exist: ${name}` };
  }

  /**
   * YouTube pages are far over the 1MB read cap and hide their metadata in scripts, so read
   * the small oEmbed document instead and return the title/channel.
   * @param {string} url
   * @param {{deadline?: number}} [ctx]
   */
  async function readYouTube(url, ctx = {}) {
    const videoId = youtubeVideoId(url);
    if (!videoId) return null;
    if (ctx.deadline && Date.now() > ctx.deadline) {
      return { ok: false, text: 'Ran out of time before the video could be read.' };
    }
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
    const result = await validator.readText(endpoint);
    if (!result.ok || !result.text) return null;
    try {
      const info = JSON.parse(result.text);
      if (!info?.title) return null;
      const lines = [`YouTube video: ${info.title}`];
      if (info.author_name) lines.push(`Channel: ${info.author_name}`);
      lines.push(`URL: ${watchUrl}`);
      return {
        ok: true,
        text: lines.join('\n'),
        data: { url, finalUrl: watchUrl, title: String(info.title), author: info.author_name ?? '' },
      };
    } catch {
      return null;
    }
  }

  /**
   * @param {any} args
   * @param {{chatId: string, deadline?: number}} ctx
   */
  async function readUrl(args, ctx) {
    const url = String(args?.url ?? '').trim();
    if (!url) return { ok: false, text: 'Missing the URL to read.' };
    if (ctx.deadline && Date.now() > ctx.deadline) {
      return { ok: false, text: 'Ran out of time before the page could be read.' };
    }
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, text: 'Only public http(s) URLs can be read.' };
    }
    const youtube = await readYouTube(url, ctx);
    if (youtube) return youtube;
    const result = await validator.readText(url);
    if (!result.ok) {
      logger.debug('read_url rejected', { url, reason: result.reason, icon: '🌐' });
      return { ok: false, text: `Could not read that page (${result.reason}).` };
    }
    const { title, text, description } = htmlToText(result.text ?? '', result.contentType);
    if (!text) return { ok: false, text: 'That page has no readable text.' };
    // Keep the page head plus a short meta description: JS-heavy pages often only have the
    // latter, and long docs still fit in a useful slice.
    const headerParts = [`Page: ${result.finalUrl ?? url}`];
    if (title) headerParts.push(`Title: ${title}`);
    if (description && !text.includes(description.slice(0, 80))) {
      headerParts.push(`Description: ${description.slice(0, 400)}`);
    }
    const trimmed = text.slice(0, READ_URL_MAX_CHARS);
    const suffix = text.length > READ_URL_MAX_CHARS ? '\n\n[content truncated]' : '';
    return {
      ok: true,
      text: `${headerParts.join('\n')}\n\n${trimmed}${suffix}`,
      data: { url, finalUrl: result.finalUrl, title },
    };
  }

  /**
   * @param {any} args
   * @param {{chatId: string, platform?: string, deadline?: number}} [ctx]
   */
  async function webSearch(args, ctx = { chatId: '' }) {
    if (!config.search.enabled || !tavily) {
      return { ok: false, text: 'Web search is disabled.' };
    }
    if (ctx.deadline && Date.now() > ctx.deadline) {
      return { ok: false, text: 'Ran out of time before the web search could run.' };
    }
    const query = String(args?.query ?? '').trim().slice(0, 300);
    if (!query) return { ok: false, text: 'Missing search keywords.' };
    try {
      const data = await tavily.search(query, {
        searchDepth: config.search.depth,
        maxResults: config.search.maxResults,
        country: config.search.country,
        // The router clamps each provider attempt to what is left of this absolute deadline.
        ...(Number.isFinite(ctx.deadline) ? { deadline: Number(ctx.deadline) } : {}),
        timeoutMs: Number.isFinite(ctx.deadline)
          ? Math.max(1500, Math.min(9000, /** @type {number} */ (ctx.deadline) - Date.now()))
          : 0,
      });
      metrics?.inc('tool.webSearch');
      logger.info('web search', { query, results: data.results.length, icon: '🔍' });
      const text = formatSearchResults(data.results, {
        maxChars: 500,
        maxItems: config.search.maxResults,
      });
      return { ok: true, text: `web_search results for "${query}":\n\n${text}`, data };
    } catch (error) {
      logger.warn('web_search failed', { error: String(/** @type {any} */ (error)?.message ?? error) });
      return { ok: false, text: `Web search error: ${String(/** @type {any} */ (error)?.message ?? error)}` };
    }
  }

  /**
   * @param {any} args
   * @param {{chatId: string, platform?: string, deadline?: number, sendPhoto?: PhotoSender, suppressDirectSend?: boolean, imageBudget?: {remaining: number}}} ctx
   */
  async function sendImage(args, ctx) {
    if (!config.image.enabled) return { ok: false, text: 'Image sending is disabled.' };
    if (ctx?.suppressDirectSend && typeof ctx.sendPhoto !== 'function') {
      return { ok: false, text: 'Images cannot be sent directly from a private answer.' };
    }
    if (!tavily) return { ok: false, text: 'Search is not configured, so images cannot be found.' };
    if (ctx.deadline && Date.now() > ctx.deadline) {
      return { ok: false, text: 'Ran out of time before the image search could run.' };
    }
    const query = String(args?.query ?? '').trim().slice(0, 200);
    if (!query) return { ok: false, text: 'Missing image keywords.' };
    const wantedCount = Math.max(1, Math.trunc(Number(args?.count ?? args?.number ?? 1)) || 1);
    const budget = ctx?.imageBudget && Number.isFinite(ctx.imageBudget.remaining) ? ctx.imageBudget : null;
    const available = budget ? Math.max(0, Math.trunc(budget.remaining)) : Number.POSITIVE_INFINITY;
    if (budget && available <= 0) {
      return { ok: false, text: `Image limit reached for this reply (max ${MAX_IMAGES_PER_SEND} images).` };
    }
    const requested = Math.min(MAX_IMAGES_PER_SEND, wantedCount, available);
    const capped = wantedCount > requested;
    const caption = String(args?.caption ?? '').trim() || query;

    // A per-call budget keeps a run of bad candidate URLs from hanging the turn forever.
    const effectiveDeadline = Math.min(
      Number.isFinite(ctx.deadline) ? /** @type {number} */ (ctx.deadline) : Number.POSITIVE_INFINITY,
      Date.now() + imageBudgetMs,
    );
    const remaining = () => effectiveDeadline - Date.now();
    const searchTimeout = () => Math.max(1500, Math.min(9000, remaining()));

    // Collect a small buffer beyond the requested count so rejected URLs can be replaced.
    const wanted = requested + Math.max(3, Math.ceil(requested * 0.5));
    /** @type {string[]} */
    const urls = [];
    const seen = new Set();
    let searches = 0;
    const maxSearches = Math.max(1, Math.ceil(wanted / 3) + 2);
    while (urls.length < wanted && searches < maxSearches && remaining() > 1500) {
      const searchQuery = searches === 0 ? query : `${query} ${searches + 1}`;
      searches += 1;
      try {
        const data = await tavily.search(searchQuery, {
          searchDepth: 'fast',
          maxResults: Math.min(10, Math.max(3, config.search.maxResults)),
          includeImages: true,
          country: config.search.country,
          timeoutMs: searchTimeout(),
        });
        const add = (image) => {
          const url = typeof image === 'string' ? image : image?.url;
          if (typeof url !== 'string' || !url.startsWith('http') || seen.has(url)) return;
          // Site icons and SVG assets are never real photos; skip them before a slow validation.
          if (/\.svg(?:[?#]|$)/i.test(url) || /\/assets\/img\/icons\//i.test(url)) return;
          seen.add(url);
          urls.push(url);
        };
        for (const image of data.images) add(image);
        for (const result of data.results) for (const image of result?.images ?? []) add(image);
      } catch (error) {
        logger.debug('image search failed', {
          query: searchQuery,
          error: String(/** @type {any} */ (error)?.message ?? error),
        });
        // Auth/quota errors will reject every follow-up query too: fail fast instead of
        // burning the remaining budget on four variants of the same search.
        const status = Number(/** @type {any} */ (error)?.status);
        if (status === 401 || status === 403 || status === 429 || status === 432) break;
      }
    }

    // Validate/download a small batch at a time: this is the network-bound part. Sending stays
    // ordered, but the default 400ms anti-spam delay is now opt-in.
    const limit = Math.min(urls.length, Math.max(6, requested * 3));
    const selectTarget = Math.min(limit, requested + 2);
    /** @type {Array<{url: string, upload: {data?: Buffer, contentType?: string}|null}>} */
    const selected = [];
    const concurrency = 4;
    let next = 0;
    while (selected.length < selectTarget && next < limit && remaining() > 0) {
      const batch = urls.slice(next, Math.min(limit, next + concurrency));
      next += batch.length;
      if (!batch.length) break;
      const results = await Promise.all(
        batch.map(async (url) => {
          if (remaining() <= 0) return null;
          if (platform.capabilities.uploadMedia) {
            const file = await validator.download(url);
            if (!file.ok) {
              logger.debug('image rejected by validator', { url, reason: file.reason, icon: '🚫' });
              return null;
            }
            return { url, upload: { data: file.data, contentType: file.contentType } };
          }
          const check = await validator.validate(url);
          if (!check.ok) {
            logger.debug('image rejected by validator', { url, reason: check.reason, icon: '🚫' });
            return null;
          }
          return { url, upload: null };
        }),
      );
      for (const result of results) {
        if (!result) continue;
        selected.push(result);
        if (selected.length >= selectTarget) break;
      }
    }

    let sent = 0;
    let uncertain = false;
    /** @type {string[]} */
    const sentUrls = [];
    for (const { url, upload } of selected) {
      if (sent >= requested || remaining() <= 0) break;
      try {
        if (typeof ctx.sendPhoto === 'function') {
          // Injected sinks collect (url, caption, asset); they add the chat id themselves.
          await ctx.sendPhoto(url, caption, upload ?? undefined);
        } else {
          await transport.sendPhoto(ctx.chatId, url, caption, upload ?? undefined);
        }
        sent += 1;
        if (budget) budget.remaining = Math.max(0, budget.remaining - 1);
        sentUrls.push(url);
        metrics?.inc('tool.sendImage.ok');
        logger.info('image sent', { query, url, sent, requested, icon: '🖼️' });
      } catch (error) {
        // Only a definite client rejection proves the image did not arrive. A timeout or
        // 5xx may mean the platform accepted it, so another candidate would duplicate it.
        const rawStatus = Number(/** @type {any} */ (error)?.status);
        const rawCode = Number(/** @type {any} */ (error)?.code);
        const status = Number.isFinite(rawStatus) ? rawStatus : rawCode;
        const definiteRejection =
          Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
        if (!definiteRejection) {
          uncertain = true;
          sent += 1;
          if (budget) budget.remaining = Math.max(0, budget.remaining - 1);
          sentUrls.push(url);
          logger.warn('image delivery is unconfirmed, not retrying', {
            query,
            url,
            error: String(/** @type {any} */ (error)?.message ?? error),
          });
          break;
        }
        // A URL can validate but still be rejected by the platform (or hit a rate limit):
        // move on to the next candidate instead of retrying the same one.
        logger.debug('send_image failed, trying next candidate', {
          url,
          error: String(/** @type {any} */ (error)?.message ?? error),
        });
        continue;
      }
      if (sent < requested && sendDelayMs > 0) await sleep(sendDelayMs);
    }

    const timedOut = remaining() <= 0;
    const seconds = Math.max(1, Math.round(imageBudgetMs / 1000));
    if (!sent) {
      metrics?.inc('tool.sendImage.fail');
      return {
        ok: false,
        text: timedOut
          ? `Could not find a valid image for "${query}" within the ${seconds}s image limit.`
          : `Could not find a valid image to send for "${query}".`,
      };
    }
    const text = uncertain
      ? `Sent an image for "${query}", but the platform did not confirm delivery. Do not retry within this reply.`
      : sent >= requested
        ? `Sent ${sent} image${sent === 1 ? '' : 's'} for "${query}"${
            capped ? ` (limit is ${MAX_IMAGES_PER_SEND} images per reply)` : ''
          }.`
        : `Sent ${sent} of ${requested} requested images for "${query}" — ${
            timedOut ? `hit the ${seconds}s image time limit` : 'the search ran out of valid unique images'
          }.`;
    return { ok: true, text, data: { sent, requested, urls: sentUrls } };
  }

  return { definitions, run };
}
