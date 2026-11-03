// Load the .env file inside the code — no dependency on Node's `--env-file-if-exists` flag.
//
// Why: many hosting panels (Pterodactyl/Wispbyte, pm2, systemd, Docker CMD…)
// run `node index.js` or `node src/index.js` themselves and drop the env-file flag, so the bot
// dies with "fatal: Missing ZALO_BOT_TOKEN" even though .env is right there. Loading inside the
// code means the config is there however it is started.
//
// Rule: variables already present in process.env (panel/CI/terminal) ALWAYS win over the file,
// unless they are empty or whitespace-only — panels often pre-declare an empty
// `ZALO_BOT_TOKEN=` (or `" "`), in which case .env is allowed to fill it in.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Files tried, in priority order (the first one wins). */
export const DEFAULT_ENV_FILES = ['.env', '.env.local'];

/** Repo root derived from this file (src/core/env.js → ../..), independent of the process cwd. */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** @typedef {{ name: string, path: string, found: boolean, applied: string[], kept: string[], error?: string }} EnvFileReport */
/** @typedef {{ cwd: string, files: EnvFileReport[], applied: string[], missing: string[] }} EnvReport */

/** @type {EnvReport|null} */
let lastReport = null;

/**
 * Strip quotes and trailing comments from a value.
 * A quoted value ends at its matching closing quote, so `KEY="sk-…" # prod` yields `sk-…`
 * and anything after the closing quote is ignored. `#` inside the quotes is kept.
 * @param {string} raw
 */
function normalizeValue(raw) {
  const value = raw.trim();
  const first = value[0];
  if (first === '"' || first === "'") {
    let end = -1;
    for (let i = 1; i < value.length; i += 1) {
      const ch = value[i];
      // Only "..." supports escapes; inside '...' a backslash is a literal character.
      if (first === '"' && ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === first) {
        end = i;
        break;
      }
    }
    if (end > 0) {
      const inner = value.slice(1, end);
      if (first === "'") return inner;
      // Only decode basic escapes for "..."; \n in .env is commonly used for PEM.
      return inner.replace(/\\([nrt"\\])/g, (_, ch) =>
        ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch,
      );
    }
  }
  // Unquoted value (or an unterminated quote, which keeps today's behaviour): "abc  # note" → "abc"
  const hash = value.search(/\s#/);
  if (hash >= 0) return value.slice(0, hash).trim();
  return value;
}

/**
 * Parse the contents of a .env file into a list of [key, value] in order of appearance.
 * Accepts: BOM, CRLF, blank lines, comments, the `export ` prefix, single/double quotes.
 * @param {string} text
 * @returns {Array<[string, string]>}
 */
export function parseEnvFile(text) {
  /** @type {Array<[string, string]>} */
  const entries = [];
  const clean = String(text).replace(/^\uFEFF/, '');
  for (const rawLine of clean.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    entries.push([key, normalizeValue(body.slice(eq + 1))]);
  }
  return entries;
}

/**
 * Read the .env files and assign them into env (never overwrite a variable that already has a value).
 * Each file is looked up in `cwd` first, then in `extraRoots` (e.g. the repo root) so a panel
 * that starts the bot from another directory still finds the file.
 * @param {{ cwd?: string, env?: Record<string, string|undefined>, files?: string[], extraRoots?: string[] }} [options]
 * @returns {EnvReport}
 */
export function loadEnvFiles(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const env = options.env ?? /** @type {Record<string, string|undefined>} */ (process.env);
  const files = options.files ?? DEFAULT_ENV_FILES;
  const roots = [...new Set([cwd, ...(options.extraRoots ?? []).map((root) => path.resolve(root))])];

  /** @type {EnvFileReport[]} */
  const reports = [];
  /** @type {string[]} */
  const appliedAll = [];

  for (const name of files) {
    /** @type {EnvFileReport} */
    const report = { name, path: path.resolve(cwd, name), found: false, applied: [], kept: [] };
    let text = null;
    for (const root of roots) {
      const candidate = path.resolve(root, name);
      try {
        text = fs.readFileSync(candidate, 'utf8');
        report.path = candidate;
        report.found = true;
        break;
      } catch (error) {
        const code = /** @type {any} */ (error)?.code;
        // A missing file is normal (the panel provides variables via its UI). Keep other errors to report them.
        if (code !== 'ENOENT' && code !== 'EISDIR') {
          report.error = `${code ?? 'ERROR'}: ${/** @type {any} */ (error)?.message ?? error}`;
        }
      }
    }
    if (!report.found) {
      reports.push(report);
      continue;
    }

    for (const [key, value] of parseEnvFile(String(text))) {
      const current = env[key];
      // A whitespace-only value (e.g. `ZALO_BOT_TOKEN=" "` in a panel) is as unusable as an
      // empty one: it would otherwise win over the file and then trim to "" later.
      if (current === undefined || String(current).trim() === '') {
        env[key] = value;
        report.applied.push(key);
        appliedAll.push(key);
      } else {
        report.kept.push(key);
      }
    }
    reports.push(report);
  }

  /** @type {EnvReport} */
  const report = {
    cwd,
    files: reports,
    applied: appliedAll,
    missing: reports.filter((item) => !item.found).map((item) => item.name),
  };
  lastReport = report;
  return report;
}

/**
 * Config troubleshooting hints: where .env was searched for and what was found.
 * Used when loadConfig() throws ConfigError so the user knows where to fix things.
 * @returns {string[]}
 */
export function describeEnvHints() {
  const report = lastReport;
  if (!report) return [];
  /** @type {string[]} */
  const lines = [`  working directory: ${report.cwd}`];
  for (const item of report.files) {
    if (item.found) {
      lines.push(`  ${item.name}: found (${item.applied.length} variables loaded from file)`);
    } else if (item.error) {
      lines.push(`  ${item.name}: READ ERROR — ${item.error}`);
    } else {
      lines.push(`  ${item.name}: not found`);
    }
  }
  if (report.missing.length) {
    lines.push(
      `  → create a .env file there (API keys only; non-secret settings live in config.json), ` +
        'or declare the API keys directly in the host panel',
    );
  }
  if (report.applied.length) {
    lines.push(`  variables loaded from file: ${report.applied.join(', ')}`);
  }
  return lines;
}

export const __test__ = { normalizeValue };
