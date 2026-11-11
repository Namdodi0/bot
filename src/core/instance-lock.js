import fs from 'node:fs/promises';
import path from 'node:path';

/** @param {number} pid */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // A process we cannot signal still exists (EBUSY/EPERM on Windows and POSIX).
    return /** @type {any} */ (error)?.code !== 'ESRCH';
  }
}

/** @param {string} file */
async function readHolder(file) {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  const pid = Number.parseInt(text.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Single-instance guard on the data dir: two processes sharing one context store answer
 * the same messages twice and race each other's writes, so the later one must not start.
 * A lock whose pid is gone is stale and is taken over.
 * @param {{dir: string, name?: string}} options
 * @returns {Promise<{path: string, pid: number, release: () => Promise<void>}>}
 */
export async function acquireInstanceLock(options) {
  const dir = String(options.dir ?? '');
  if (!dir) throw new Error('instance lock needs a data directory');
  const file = path.join(dir, options.name ?? 'bot.lock');
  const pid = process.pid;
  await fs.mkdir(dir, { recursive: true });

  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      await fs.writeFile(file, `${pid}\n`, { flag: 'wx' });
      return {
        path: file,
        pid,
        async release() {
          // Only remove our own lock: a restart may already own the file.
          const holder = await readHolder(file);
          if (holder !== null && holder !== pid) return;
          await fs.unlink(file).catch(() => {});
        },
      };
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'EEXIST') throw error;
    }

    const holder = await readHolder(file);
    if (holder !== null) {
      if (isAlive(holder)) {
        throw new Error(
          `another bot instance is already running with this data directory (pid ${holder}); ` +
            'stop it before starting a second one',
        );
      }
      await fs.unlink(file).catch((error) => {
        if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error;
      });
      continue;
    }

    // The holder has opened the file but not written its pid yet: give it a moment,
    // then treat an old empty file as stale.
    const stat = await fs.stat(file).catch(() => null);
    if (!stat || Date.now() - stat.mtimeMs > 5000) {
      await fs.unlink(file).catch(() => {});
      continue;
    }
    await sleep(100);
  }

  throw new Error('could not acquire the single-instance lock');
}
