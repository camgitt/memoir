// Lightweight file lock for a read-modify-write critical section, with NO
// new npm dependency.
//
// WHY: two independent Claude Code sessions (or two racing Stop hooks) can
// run against the same $HOME at once — each runs its own memoir-mcp stdio
// server / autopush invocation. Every session.json mutator in state.js does
// readSession() -> mutate in memory -> writeSession(). writeSession's
// tmp-then-rename only prevents a TORN write; it does not stop two
// concurrent processes from both reading the same on-disk snapshot,
// mutating independently, and having the second writeSession() silently and
// completely overwrite the first process's change. autopush.js's debounce
// check ("read timestamp, compare elapsed, write new timestamp") is the same
// class of unlocked check-then-act. This is a real, easily-triggered
// data-loss bug, not a theoretical one.
//
// MECHANISM: fs.openSync(lockPath, 'wx') is an atomic create-exclusive at
// the OS level — it throws EEXIST if the file already exists, so exactly one
// process can "win" the create at a time. Acquire retries on EEXIST with a
// short delay, up to a bounded total wait. Release deletes the lock file,
// wrapped in try/finally so a thrown error inside the critical section still
// releases the lock.
//
// STALE-LOCK RECOVERY: if the lock file is older than STALE_MS, we assume
// the process that created it crashed (or was killed) while holding it, and
// we remove it and proceed. This trades a small window of imperfect mutual
// exclusion for availability — appropriate for a local, single-user tool,
// where a permanently stuck lock from a crashed process is a worse failure
// mode than the rare double-write it might allow.

import fs from 'fs-extra';
import path from 'path';

const RETRY_DELAY_MS = 50;
const MAX_WAIT_MS = 5000;
const STALE_MS = 30_000; // treat a lock older than this as abandoned

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the exclusive lock at `lockPath`, run `fn`, then always release —
 * even if `fn` throws. Returns whatever `fn` returns/resolves to.
 *
 * If the lock can't be acquired within MAX_WAIT_MS (and stale-lock recovery
 * didn't free it up), proceeds WITHOUT the lock rather than hanging forever,
 * printing one loud stderr warning — never blocks the caller indefinitely,
 * and never throws just because the lock was contended.
 */
export async function withSessionLock(lockPath, fn) {
  await fs.ensureDir(path.dirname(lockPath));
  const start = Date.now();
  let fd = null;
  let warned = false;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } catch {}
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;

      // Stale-lock recovery: the holder may have crashed. If the lock file
      // is older than STALE_MS, remove it and retry the acquire immediately
      // (no delay) rather than waiting out the full bounded window.
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STALE_MS) {
          // Steal by rename, not unlink: two processes racing an unlink can
          // both "win" and both proceed. rename() is atomic, so exactly one
          // wins and the loser simply retries.
          let stolen = false;
          try {
            const graveyard = `${lockPath}.stale-${process.pid}-${Date.now()}`;
            fs.renameSync(lockPath, graveyard);
            stolen = true;
            // The rename is only there to make the steal atomic; the file
            // itself is debris. Remove it immediately — best-effort, and
            // harmless to leave behind if this fails.
            try { fs.unlinkSync(graveyard); } catch {}
          } catch {}
          if (stolen) {
            continue; // we removed it; retry the acquire immediately
          }
          // Could not remove it (read-only dir, permissions). Fall through
          // to the deadline + backoff below instead of spinning forever.
          if (Date.now() - start > MAX_WAIT_MS) {
            fd = null;
            break;
          }
          await sleep(RETRY_DELAY_MS);
          continue;
        }
      } catch {
        // Lock file vanished between the failed open and this stat (the
        // holder released it) — just retry the acquire.
        continue;
      }

      if (Date.now() - start > MAX_WAIT_MS) {
        if (!warned) {
          warned = true;
          process.stderr.write(
            `memoir: could not acquire lock at ${lockPath} after ${MAX_WAIT_MS}ms — proceeding without it (another memoir process may be mid-write).\n`
          );
        }
        fd = null;
        break; // proceed without the lock rather than hang forever
      }
      await sleep(RETRY_DELAY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    if (fd !== null) {
      // Only unlink if the file at lockPath is still OURS. If our lock was
      // stolen as stale and another process now holds a NEW file at the same
      // path, unlinking by path would delete the current holder's lock and
      // let a third process in. Compare inode via the fd we still hold.
      let ours = false;
      try {
        const byFd = fs.fstatSync(fd);
        const byPath = fs.statSync(lockPath);
        ours = byFd.ino === byPath.ino && byFd.dev === byPath.dev;
      } catch {
        ours = false; // path gone or unreadable — nothing safe to remove
      }
      try { fs.closeSync(fd); } catch {}
      if (ours) { try { fs.unlinkSync(lockPath); } catch {} }
    }
  }
}
