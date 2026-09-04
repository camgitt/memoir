// Handoff files: ~/.config/memoir/handoffs/<timestamp>-claude.md + latest.md.
//
// One is written on EVERY autopush (the Stop hook fires after each response),
// so without a bound the directory grows by ~50 files a day forever — 3,944
// files / 15MB on the author's machine before this module existed, none of
// them ever read (only `memoir resume` reads, and it reads latest.md).
// Keep a window: the newest HANDOFF_KEEP_MAX files that are also younger
// than HANDOFF_KEEP_DAYS. latest.md is always kept. Pruning is best-effort
// and never fails the write that triggered it.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';

export const HANDOFF_KEEP_DAYS = 14;
export const HANDOFF_KEEP_MAX = 200;

// Resolved at call time (not module load) so tests can shim $HOME.
export function localHandoffDir() {
  return path.join(os.homedir(), '.config', 'memoir', 'handoffs');
}

export function handoffFilename(now = new Date()) {
  return `${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}-claude.md`;
}

/**
 * Write `content` as a timestamped handoff + latest.md into every dir in
 * `dirs` (default: the local handoff dir), then prune the local dir.
 * Returns the filename used, so callers that also stage a copy for upload
 * use the same name locally and remotely.
 */
export async function saveHandoff(content, { dirs, filename } = {}) {
  const name = filename || handoffFilename();
  const targets = dirs && dirs.length ? dirs : [localHandoffDir()];
  for (const dir of targets) {
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, name), content);
    await fs.writeFile(path.join(dir, 'latest.md'), content);
  }
  try { await pruneHandoffs(localHandoffDir()); } catch {}
  return name;
}

/**
 * Delete handoff files beyond the window. Returns how many were removed.
 * Order is by mtime, newest first; a file survives only if it is within the
 * first `keepMax` AND younger than `keepDays`.
 */
export async function pruneHandoffs(dir, { keepDays = HANDOFF_KEEP_DAYS, keepMax = HANDOFF_KEEP_MAX, now = Date.now() } = {}) {
  let names;
  try { names = await fs.readdir(dir); } catch { return 0; }
  const entries = [];
  for (const name of names) {
    if (name === 'latest.md' || !name.endsWith('.md')) continue;
    try {
      const st = await fs.stat(path.join(dir, name));
      entries.push({ name, mtime: st.mtimeMs });
    } catch {}
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  const cutoff = now - keepDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (let i = 0; i < entries.length; i++) {
    if (i < keepMax && entries[i].mtime >= cutoff) continue;
    try {
      await fs.remove(path.join(dir, entries[i].name));
      removed++;
    } catch {}
  }
  return removed;
}
