import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { inspectFile } from '../security/files.js';

const windowsBusy = error => process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code);

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code !== 'ESRCH'; }
}

// Never enter without owning the lock. A slow living writer is not abandoned.
export async function withSessionLock(lockPath, fn, { maxWaitMs = 5000, staleMs = 30_000 } = {}) {
  await fs.ensureDir(path.dirname(lockPath));
  const start = Date.now();
  let fd;
  while (fd === undefined) {
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, String(process.pid));
    } catch (err) {
      if (fd !== undefined) { fs.closeSync(fd); await fs.remove(lockPath); throw err; }
      if (err.code !== 'EEXIST' && !windowsBusy(err)) throw err;
      let reaper;
      const reaperPath = lockPath + '.reaper';
      try {
        reaper = await fs.open(reaperPath, 'wx', 0o600);
        const st = await inspectFile(lockPath);
        if (st.isSymbolicLink()) throw new Error('Session lock must not be a symlink');
        const owner = Number((await fs.readFile(lockPath, 'utf8')).trim());
        if (Date.now() - st.mtimeMs > staleMs && !alive(owner)) {
          const abandoned = lockPath + '.stale-' + crypto.randomUUID();
          await fs.rename(lockPath, abandoned);
          await fs.remove(abandoned);
        }
      } catch (err) { if (!['ENOENT', 'EEXIST'].includes(err.code) && !windowsBusy(err)) throw err; }
      finally {
        if (reaper !== undefined) {
          await fs.close(reaper);
          await fs.unlink(reaperPath).catch(() => {});
        }
      }
      if (Date.now() - start >= maxWaitMs) {
        const err = new Error('Memoir is busy: could not acquire the session lock. Retry after the other operation completes.');
        err.code = 'ELOCKED';
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, Math.min(50, maxWaitMs)));
    }
  }
  try { return await fn(); }
  finally {
    let ours = false, owned;
    try { owned = fs.fstatSync(fd); const current = await inspectFile(lockPath); ours = owned.ino === current.ino && owned.dev === current.dev; } catch {}
    fs.closeSync(fd);
    if (ours) for (let attempt = 0; ; attempt++) {
      try {
        if (attempt) { const current = await inspectFile(lockPath); if (owned.ino !== current.ino || owned.dev !== current.dev) break; }
        await fs.unlink(lockPath); break;
      }
      catch (error) {
        if (!windowsBusy(error) || attempt >= 5) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
  }
}
