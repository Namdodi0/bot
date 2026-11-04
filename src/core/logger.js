import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
};

const LEVEL_META = {
  debug: { label: 'DEBUG', icon: '·', color: ANSI.gray },
  info: { label: 'INFO', icon: 'ℹ', color: ANSI.cyan },
  warn: { label: 'WARN', icon: '▲', color: ANSI.yellow },
  error: { label: 'ERROR', icon: '✖', color: ANSI.red },
};

const SECRET_PATTERNS = [
  /nvapi-[A-Za-z0-9_-]{8,}/g,
  /tvly-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\b\d{8,}:[A-Za-z0-9_-]{10,}\b/g,
];

const SENSITIVE_KEY = /(^token$|Token$|Key$|Secret$|secret$|authorization$)/;
const MESSAGE_COLUMN = 26;
const MAX_VALUE_CHARS = 110;

/**
 * @param {string} text
 * @param {string[]} secrets
 */
function redactText(text, secrets) {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join('***');
  }
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '***');
  return out;
}

/**
 * @param {unknown} value
 * @param {string[]} secrets
 * @returns {unknown}
 */
function redactValue(value, secrets) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message, secrets),
      stack: value.stack ? redactText(value.stack, secrets) : undefined,
    };
  }
  if (value && typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (SENSITIVE_KEY.test(key) && typeof item === 'string') {
        out[key] = '***';
        continue;
      }
      out[key] = redactValue(item, secrets);
    }
    return out;
  }
  return value;
}

/**
 * Display width (emoji count as 2 columns) for aligning the banner.
 * @param {string} text
 */
export function visualWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0xfe0f || code === 0x200d) continue;
    if (/\p{Extended_Pictographic}/u.test(char)) width += 2;
    else width += 1;
  }
  return width;
}

/**
 * @param {NodeJS.WritableStream|null|undefined} stream
 * @param {'auto'|'always'|'never'} mode
 */
function colorEnabled(stream, mode) {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(/** @type {any} */ (stream)?.isTTY);
}

/**
 * @param {string} text
 * @param {string} code
 * @param {boolean} enabled
 */
function paint(text, code, enabled) {
  return enabled ? `${code}${text}${ANSI.reset}` : text;
}

/** @param {Date} date */
function clockTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * @param {unknown} value
 */
function formatValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    const clean = value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS - 1)}…` : value;
    return /[\s"=]/.test(clean) ? JSON.stringify(clean) : clean;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value instanceof Error) return JSON.stringify(value.message);
  try {
    const json = JSON.stringify(value);
    if (json === undefined) return String(value);
    return json.length > MAX_VALUE_CHARS ? `${json.slice(0, MAX_VALUE_CHARS - 1)}…` : json;
  } catch {
    return '[unreadable]';
  }
}

/**
 * @param {Record<string, unknown>} fields
 * @param {boolean} color
 */
function formatFields(fields, color) {
  const entries = Object.entries(fields).filter(
    ([key, value]) => key !== 'icon' && value !== undefined && value !== '',
  );
  if (!entries.length) return '';
  // push `error` to the end for readability
  entries.sort(([a], [b]) => (a === 'error' ? 1 : b === 'error' ? -1 : 0));
  return entries
    .map(([key, value]) => {
      const label = paint(`${key}=`, ANSI.gray, color);
      const rendered =
        value && typeof value === 'object' && !Array.isArray(value) && 'message' in value && 'name' in value
          ? JSON.stringify(`${/** @type {any} */ (value).name}: ${/** @type {any} */ (value).message}`)
          : formatValue(value);
      return `${label}${rendered}`;
    })
    .join(' ');
}

/**
 * @param {{date: Date, level: string, msg: string, fields: Record<string, unknown>}} record
 * @param {boolean} color
 */
function formatPretty(record, color) {
  const meta = LEVEL_META[/** @type {keyof typeof LEVEL_META} */ (record.level)] ?? LEVEL_META.info;
  const icon = typeof record.fields.icon === 'string' ? record.fields.icon : meta.icon;
  const time = paint(clockTime(record.date), ANSI.gray, color);
  const badge = paint(icon.padEnd(2, ' '), meta.color, color);

  const fields = formatFields(record.fields, color);
  const lines = String(record.msg).split('\n');
  const indent = ' '.repeat(11);

  const first = fields
    ? `${lines[0].padEnd(MESSAGE_COLUMN)} ${fields}`
    : lines[0];
  const rest = lines.slice(1).map((line) => `${indent}${paint(line, ANSI.dim, color)}`);

  return [`${time} ${badge} ${paint(first, ANSI.reset, color)}`, ...rest].join('\n');
}

/**
 * Keep one previous generation of a log file so it cannot grow forever.
 * @param {string} filePath
 * @param {number} maxBytes
 */
function rotateFile(filePath, maxBytes) {
  if (!(maxBytes > 0)) return;
  try {
    if (fs.statSync(filePath).size > maxBytes) {
      const target = `${filePath}.1`;
      fs.rmSync(target, { force: true });
      fs.renameSync(filePath, target);
    }
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error;
  }
}

/**
 * @typedef {object} Logger
 * @property {(msg: string, fields?: Record<string, unknown>) => void} debug
 * @property {(msg: string, fields?: Record<string, unknown>) => void} info
 * @property {(msg: string, fields?: Record<string, unknown>) => void} warn
 * @property {(msg: string, fields?: Record<string, unknown>) => void} error
 * @property {(bindings: Record<string, unknown>) => Logger} child
 * @property {() => Promise<void>} close
 */

/**
 * @param {{level?: string, format?: 'pretty'|'json', color?: 'auto'|'always'|'never', secrets?: string[], version?: string, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, now?: () => Date, files?: Array<{path: string, level?: string}>, rotateBytes?: number}} [options]
 * @returns {Logger}
 */
export function createLogger(options = {}) {
  const level = LEVELS[options.level ?? 'info'] ?? LEVELS.info;
  const format = options.format ?? 'pretty';
  const colorMode = options.color ?? 'auto';
  const secrets = options.secrets ?? [];
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const now = options.now ?? (() => new Date());
  const rotateBytes = options.rotateBytes ?? 5_000_000;
  /** @type {Array<{path: string, stream: import('node:fs').WriteStream, level: number, size: number, rotateBytes: number, rotating: boolean, queue: string[], rotation: Promise<void>|null}>} */
  const fileSinks = [];
  for (const file of options.files ?? []) {
    try {
      const filePath = path.resolve(file.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      rotateFile(filePath, rotateBytes);
      const stream = fs.createWriteStream(filePath, { flags: 'a' });
      stream.on('error', () => {});
      let size = 0;
      try {
        size = fs.statSync(filePath).size;
      } catch {
        // fresh file
      }
      fileSinks.push({
        path: filePath,
        stream,
        level: LEVELS[file.level ?? 'debug'] ?? LEVELS.debug,
        size,
        rotateBytes,
        rotating: false,
        queue: [],
        rotation: null,
      });
    } catch {
      // A broken log path must never take the bot down.
    }
  }
  const minLevel = fileSinks.length ? Math.min(level, ...fileSinks.map((item) => item.level)) : level;
  /** Attach the version to EVERY log line: the panel git-pulls on its own, so we must know which build is running. */
  const rootBindings = /** @type {Record<string, unknown>} */ (options.version ? { version: options.version } : {});

  /** @param {(typeof fileSinks)[number]} sink @param {string} line */
  function writeToSink(sink, line) {
    if (sink.rotating) {
      sink.queue.push(line);
      return;
    }
    try {
      sink.stream.write(line);
      sink.size += Buffer.byteLength(line);
    } catch {
      return;
    }
    if (sink.rotateBytes > 0 && sink.size >= sink.rotateBytes && !sink.rotation) {
      sink.rotation = rotateSink(sink);
    }
  }

  /** @param {(typeof fileSinks)[number]} sink */
  async function rotateSink(sink) {
    sink.rotating = true;
    try {
      await new Promise((resolve) => {
        try {
          sink.stream.end(() => resolve(undefined));
        } catch {
          resolve(undefined);
        }
      });
      const target = `${sink.path}.1`;
      fs.rmSync(target, { force: true });
      fs.renameSync(sink.path, target);
    } catch {
      // If rotation fails, keep appending to the same file.
    }
    try {
      sink.stream = fs.createWriteStream(sink.path, { flags: 'a' });
      sink.stream.on('error', () => {});
    } catch {
      // keep the old (closed) stream; writes below will be dropped
    }
    sink.size = 0;
    sink.rotating = false;
    sink.rotation = null;
    const queued = sink.queue.splice(0);
    for (const line of queued) writeToSink(sink, line);
  }

  function close() {
    return Promise.all(
      fileSinks.map(async (sink) => {
        if (sink.rotation) await sink.rotation.catch(() => {});
        await new Promise((resolve) => {
          try {
            sink.stream.end(() => resolve(undefined));
          } catch {
            resolve(undefined);
          }
        });
      }),
    ).then(() => undefined);
  }

  /**
   * @param {Record<string, unknown>} bindings
   * @returns {Logger}
   */
  function make(bindings) {
    /** @param {'debug'|'info'|'warn'|'error'} method */
    const emit = (method) => (msg, fields) => {
      const severity = LEVELS[method];
      if (severity < minLevel) return;
      const date = now();
      const merged = { ...bindings, ...(fields ?? {}) };
      const safeMsg = redactText(String(msg), secrets);
      const safeFields = /** @type {Record<string, unknown>} */ (redactValue(merged, secrets));
      /** @param {boolean} color */
      const render = (color) =>
        format === 'json'
          ? `${JSON.stringify({ t: date.toISOString(), level: method, msg: safeMsg, ...safeFields })}\n`
          : `${formatPretty({ date, level: method, msg: safeMsg, fields: safeFields }, color)}\n`;

      if (severity >= level) {
        const stream = method === 'error' || method === 'warn' ? stderr : stdout;
        try {
          stream.write(render(colorEnabled(stream, colorMode)));
        } catch {
          // never let a logging failure kill the bot
        }
      }
      for (const sink of fileSinks) {
        if (severity < sink.level) continue;
        writeToSink(sink, render(false));
      }
    };

    return {
      debug: emit('debug'),
      info: emit('info'),
      warn: emit('warn'),
      error: emit('error'),
      child: (extra) => make({ ...bindings, ...extra }),
      close,
    };
  }

  return make(rootBindings);
}

/**
 * Startup banner frame (used only in pretty mode).
 * @param {NodeJS.WritableStream} stream
 * @param {string[]} lines
 * @param {{color?: 'auto'|'always'|'never'}} [options]
 */
export function printBanner(stream, lines, options = {}) {
  if (!lines.length) return;
  const color = colorEnabled(stream, options.color ?? 'auto');
  const width = Math.max(...lines.map((line) => visualWidth(line)));
  const horizontal = '─'.repeat(width + 2);
  const top = paint(`╭${horizontal}╮`, ANSI.cyan, color);
  const bottom = paint(`╰${horizontal}╯`, ANSI.cyan, color);
  const body = lines
    .map((line) => {
      const padding = ' '.repeat(Math.max(0, width - visualWidth(line)));
      return `${paint('│', ANSI.cyan, color)} ${line}${padding} ${paint('│', ANSI.cyan, color)}`;
    })
    .join('\n');
  try {
    stream.write(`${top}\n${body}\n${bottom}\n`);
  } catch {
    // ignore
  }
}

/** Silent logger, used for tests. */
export function createSilentLogger() {
  const noop = () => {};
  /** @type {Logger} */
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger, close: async () => {} };
  return logger;
}

export { ANSI, LEVEL_META, LEVELS };
export const __test__ = { redactText, redactValue, formatPretty, formatFields, formatValue, colorEnabled, clockTime };
