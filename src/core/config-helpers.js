/**
 * Low-level config parsing helpers shared by the root composition layer
 * (`src/config.js`) and the platform config modules (one per platform directory).
 * This module must not import either.
 */

const BOOL_TRUE = new Set(['1', 'on', 'true', 'yes', 'y']);
const BOOL_FALSE = new Set(['0', 'off', 'false', 'no', 'n', '']);

export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** @param {unknown} value @param {string} key @param {string} [fallback] */
export function asString(value, key, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ConfigError(`${key} must be a string`);
  }
  return String(value).trim();
}

/** @param {unknown} value @param {string} key @param {boolean} fallback */
export function asBool(value, key, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (BOOL_TRUE.has(text)) return true;
  if (BOOL_FALSE.has(text)) return false;
  throw new ConfigError(`${key} must be a boolean (got: "${value}")`);
}

/**
 * @param {unknown} value
 * @param {string} key
 * @param {number|null} fallback
 * @param {{min?:number,max?:number}} [bounds]
 * @returns {number|null}
 */
export function asInt(value, key, fallback, bounds = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number) || !Number.isInteger(number)) {
    throw new ConfigError(`${key} must be an integer (got: "${value}")`);
  }
  if (bounds.min !== undefined && number < bounds.min) {
    throw new ConfigError(`${key} must be >= ${bounds.min} (got: ${number})`);
  }
  if (bounds.max !== undefined && number > bounds.max) {
    throw new ConfigError(`${key} must be <= ${bounds.max} (got: ${number})`);
  }
  return number;
}

/**
 * @param {unknown} value
 * @param {string} key
 * @param {number} fallback
 * @param {{min?:number,max?:number}} [bounds]
 */
export function asNumber(value, key, fallback, bounds = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) {
    throw new ConfigError(`${key} must be a number (got: "${value}")`);
  }
  if (bounds.min !== undefined && number < bounds.min) {
    throw new ConfigError(`${key} must be >= ${bounds.min} (got: ${number})`);
  }
  if (bounds.max !== undefined && number > bounds.max) {
    throw new ConfigError(`${key} must be <= ${bounds.max} (got: ${number})`);
  }
  return number;
}

/** @param {unknown} value @param {string} key @param {{min?:number,max?:number}} [bounds] */
export function asOptionalNumber(value, key, bounds = {}) {
  if (value === undefined || value === null || value === '') return null;
  return asNumber(value, key, 0, bounds);
}

/** @param {unknown} value @param {string} key @param {{min?:number,max?:number}} [bounds] */
export function asOptionalInt(value, key, bounds = {}) {
  if (value === undefined || value === null || value === '') return null;
  return asInt(value, key, 0, bounds);
}

/** @param {unknown} value @param {string} key */
export function asStringList(value, key) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value !== 'string') throw new ConfigError(`${key} must be an array of strings`);
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** @param {Record<string, any>} root @param {string} name */
export function section(root, name) {
  const value = root?.[name];
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`config.${name} must be an object`);
  }
  return /** @type {Record<string, any>} */ (value);
}
