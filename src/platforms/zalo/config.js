import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { ConfigError, asInt, asString, asStringList, section } from '../../core/config-helpers.js';
import { STICKER_SECTION_KEYS, WEBHOOK_SECTION_KEYS, ZALO_SECTION_KEYS } from '../../config-schema.js';
import { parseStickerIds } from './stickers.js';

export { STICKER_SECTION_KEYS, WEBHOOK_SECTION_KEYS, ZALO_SECTION_KEYS };

// Repo root derived from this file (src/platforms/zalo/..), used only when the caller
// does not pass an already-resolved dataDir.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Webhook secret: use config.webhook.secret when set; otherwise generate it once and store
 * it in data/ so a restart does not change the secret (403 on every request).
 * @param {string} dataDir
 * @param {string} mode
 * @param {string} configured
 */
export function resolveWebhookSecret(dataDir, mode, configured) {
  if (configured) {
    if (configured.length < 8) throw new ConfigError('config.webhook.secret must be at least 8 characters');
    return configured;
  }
  if (mode !== 'webhook') return '';

  const file = path.join(dataDir, 'webhook-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 8) return existing;
  } catch {
    // no file yet → generate one below
  }

  const generated = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, generated, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // if it cannot be saved, still use a temporary secret for this session
  }
  return generated;
}

/**
 * The webhook path is matched verbatim against the request URL: a missing leading slash or
 * a trailing slash makes every delivery 404 while startup still looks healthy.
 * @param {unknown} value
 * @returns {string}
 */
export function resolveWebhookPath(value) {
  const pathValue = asString(value, 'config.webhook.path', '/zalo/webhook');
  if (!pathValue || !pathValue.startsWith('/')) {
    throw new ConfigError(`config.webhook.path must be a non-empty path starting with "/" (got: "${pathValue}")`);
  }
  if (pathValue.length > 1 && pathValue.endsWith('/')) {
    throw new ConfigError(`config.webhook.path must not end with "/" (got: "${pathValue}")`);
  }
  if (/\s/.test(pathValue)) {
    throw new ConfigError(`config.webhook.path must not contain whitespace (got: "${pathValue}")`);
  }
  return pathValue;
}

/** @param {Record<string, any>} root @param {string} [dataDir] */
function resolveDataDir(root, dataDir) {
  if (dataDir) return dataDir;
  const raw = asString(root?.dataDir, 'config.dataDir', './data') || './data';
  return path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(PROJECT_ROOT, raw);
}

/**
 * Parse the Zalo-specific settings: token, API section, admission lists, transport mode,
 * webhook and sticker store. Missing-token policy stays in the root composition layer.
 * @param {{root: Record<string, any>, env: Record<string, unknown>, cli?: Record<string, any>, dataDir?: string}} input
 */
export function parseZaloConfig(input) {
  const { root, env, cli = {}, dataDir } = input;
  const zaloSection = section(root, 'zalo');
  const webhookSection = section(root, 'webhook');
  const stickerSection = section(root, 'sticker');

  const token = asString(env.ZALO_BOT_TOKEN, 'ZALO_BOT_TOKEN');

  const mode = String(cli.mode ?? asString(root.mode, 'config.mode', 'polling')).toLowerCase();
  if (mode !== 'polling' && mode !== 'webhook') {
    throw new ConfigError(`config.mode must be "polling" or "webhook" (got: "${mode}")`);
  }

  const resolvedDataDir = resolveDataDir(root, dataDir);
  // Validate before resolving the secret: an invalid path must not leave a secret file behind.
  const webhookPath = resolveWebhookPath(webhookSection.path);
  const webhookSecret = resolveWebhookSecret(
    resolvedDataDir,
    mode,
    asString(webhookSection.secret, 'config.webhook.secret'),
  );

  return {
    token,
    zalo: {
      botId: asString(zaloSection.botId, 'config.zalo.botId'),
      baseUrl: asString(zaloSection.baseUrl, 'config.zalo.baseUrl', 'https://bot-api.zaloplatforms.com'),
      parseMode: asString(zaloSection.parseMode, 'config.zalo.parseMode', 'markdown').toLowerCase() === 'none'
        ? 'none'
        : 'markdown',
    },
    allowedChatIds: asStringList(root.allowedChatIds, 'config.allowedChatIds'),
    adminIds: asStringList(root.adminIds, 'config.adminIds'),
    mode,
    webhook: {
      port: /** @type {number} */ (asInt(webhookSection.port, 'config.webhook.port', 8787, { min: 1, max: 65535 })),
      host: asString(webhookSection.host, 'config.webhook.host', '127.0.0.1'),
      path: webhookPath,
      secret: webhookSecret,
      publicUrl: asString(webhookSection.publicUrl, 'config.webhook.publicUrl'),
    },
    sticker: {
      file: path.join(resolvedDataDir, 'stickers.json'),
      // pre-declared valid IDs: "id1,id2:name 2"
      extraIds: parseStickerIds(asString(stickerSection.ids, 'config.sticker.ids')),
    },
  };
}
