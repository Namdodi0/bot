import { formatSearchResults } from '../search/tavily.js';
import { REMINDER_LIMITS, formatReminderTime, parseReminderArgs } from './reminders.js';
import { htmlToText, youtubeVideoId } from './read-url.js';

/** @typedef {(url: string, caption?: string, asset?: {data?: Buffer, contentType?: string}) => Promise<any>} PhotoSender */

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{config: any, tavily: ReturnType<typeof import('../search/tavily.js').createTavilyClient>|null, platform: import('../../platforms/contract.js').Platform, validator: ReturnType<typeof import('../media/validate.js').createImageValidator>, reminders?: ReturnType<typeof import('./reminders.js').createReminderStore>, logger: import('../logger.js').Logger, metrics?: any, sendDelayMs?: number}} options
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
  const sendDelayMs = options.sendDelayMs ?? 400;

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
    // The image tool needs Tavily to find URLs; do not advertise it when search is off.
    if (config.image.enabled && tavily) {
      tools.push({
        type: 'function',
        function: {
          name: 'send_image',
          description:
            'Find and send images into the current conversation. Use when the user asks for pictures. Set count to the number of images requested: it sends one message per image and has no per-request cap.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Image keywords to search for, e.g. "cute kitten"' },
              count: {
                type: 'integer',
                minimum: 1,
                description:
                  'How many images to send (default 1). Pass the number the user asked for; never cap it yourself.',
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
    const { title, text } = htmlToText(result.text ?? '', result.contentType);
    if (!text) return { ok: false, text: 'That page has no readable text.' };
    const header = title ? `Page: ${result.finalUrl ?? url}\nTitle: ${title}` : `Page: ${result.finalUrl ?? url}`;
    return {
      ok: true,
      text: `${header}\n\n${text.slice(0, 6000)}`,
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
   * @param {{chatId: string, platform?: string, deadline?: number, sendPhoto?: PhotoSender, suppressDirectSend?: boolean}} ctx
   */
  async function sendImage(args, ctx) {
    if (!config.image.enabled) return { ok: false, text: 'Image sending is disabled.' };
    if (ctx?.suppressDirectSend && typeof ctx.sendPhoto !== 'function') {
      return { ok: false, text: 'Images cannot be sent directly from a private answer.' };
    }
    if (!tavily) return { ok: false, text: 'Tavily is required to search for images.' };
    if (ctx.deadline && Date.now() > ctx.deadline) {
      return { ok: false, text: 'Ran out of time before the image search could run.' };
    }
    const query = String(args?.query ?? '').trim().slice(0, 200);
    if (!query) return { ok: false, text: 'Missing image keywords.' };
    const requested = Math.max(1, Math.trunc(Number(args?.count ?? args?.number ?? 1)) || 1);
    const caption = String(args?.caption ?? '').trim() || query;

    const remaining = () =>
      Number.isFinite(ctx.deadline) ? /** @type {number} */ (ctx.deadline) - Date.now() : Number.POSITIVE_INFINITY;
    const searchTimeout = () => (Number.isFinite(ctx.deadline) ? Math.max(1500, Math.min(9000, remaining())) : 0);

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
          if (typeof url === 'string' && url.startsWith('http') && !seen.has(url)) {
            seen.add(url);
            urls.push(url);
          }
        };
        for (const image of data.images) add(image);
        for (const result of data.results) for (const image of result?.images ?? []) add(image);
      } catch (error) {
        logger.debug('image search failed', {
          query: searchQuery,
          error: String(/** @type {any} */ (error)?.message ?? error),
        });
      }
    }

    let sent = 0;
    /** @type {string[]} */
    const sentUrls = [];
    for (const url of urls) {
      if (sent >= requested || remaining() <= 0) break;
      // Platforms that upload bytes download them here through the pinned-address validator
      // instead of letting the platform client fetch the URL on its own.
      /** @type {{data?: Buffer, contentType?: string}|null} */
      let upload = null;
      if (platform.capabilities.uploadMedia) {
        const file = await validator.download(url);
        if (!file.ok) {
          logger.debug('image rejected by validator', { url, reason: file.reason, icon: '🚫' });
          continue;
        }
        upload = { data: file.data, contentType: file.contentType };
      } else {
        const check = await validator.validate(url);
        if (!check.ok) {
          logger.debug('image rejected by validator', { url, reason: check.reason, icon: '🚫' });
          continue;
        }
      }
      if (remaining() <= 0) break;
      try {
        if (typeof ctx.sendPhoto === 'function') {
          // Injected sinks collect (url, caption, asset); they add the chat id themselves.
          await ctx.sendPhoto(url, caption, upload ?? undefined);
        } else {
          await transport.sendPhoto(ctx.chatId, url, caption, upload ?? undefined);
        }
        sent += 1;
        sentUrls.push(url);
        metrics?.inc('tool.sendImage.ok');
        logger.info('image sent', { query, url, sent, requested, icon: '🖼️' });
      } catch (error) {
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

    if (!sent) {
      metrics?.inc('tool.sendImage.fail');
      return { ok: false, text: `Could not find a valid image to send for "${query}".` };
    }
    const text =
      sent >= requested
        ? `Sent ${sent} image${sent === 1 ? '' : 's'} for "${query}".`
        : `Sent ${sent} of ${requested} requested images for "${query}" — the search ran out of valid unique images.`;
    return { ok: true, text, data: { sent, requested, urls: sentUrls } };
  }

  return { definitions, run };
}
