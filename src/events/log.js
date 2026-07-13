// Additive, size-bounded, crash-safe JSONL event log.
//
// Target: ~/.config/memoir/events.jsonl — one JSON object per line:
//   { ts, type, machine_id, ...minimal metadata }
//
// PRIVACY: this must never become a second, unfiltered copy of sensitive
// user data. NEVER log raw decision/note/goal TEXT content — only counts,
// ids, booleans, and short enum-like type strings. Every call site in this
// codebase that calls appendEvent() is expected to honor that; review any
// new call site against it.
//
// CRASH-SAFE: pure fs.appendFileSync (O_APPEND) for the actual write —
// never a read-modify-write on this file, so a crash mid-write can at worst
// leave a truncated LAST line, never corrupt earlier ones.
//
// SIZE-BOUNDED: rotates at MAX_BYTES — events.jsonl -> .1 -> .2, oldest
// generation beyond MAX_ROTATIONS is deleted.
//
// LOCKED ROTATE-THEN-APPEND: the size-check-and-maybe-rotate is itself a
// check-then-act sequence that would race under concurrent processes
// exactly like the session.json bug Commit 4 fixed (two processes both see
// "under the cap," both append, one rotates mid-write, etc.). Rather than
// threading through whichever *other* lock happens to be held at each of
// the 6+ call sites (some of which, like sync_pushed/sync_failed, have no
// adjacent lock at all), this uses ONE small dedicated lock
// (events.jsonl.lock) around every rotate-then-append, uniformly. Simpler
// and always-safe, at the cost of a little lock contention on an
// infrequent, cheap operation — a deliberate simplification over coupling
// to each caller's own lock.
//
// NEVER BREAKS THE CALLER: appendEvent() catches everything internally and
// never throws. The primary operation it's logging (writeSession,
// injectInto, push, etc.) must always succeed or fail on its own merits,
// never because event logging failed.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { getMachineId } from '../session/state.js';
import { withSessionLock } from '../session/lock.js';

const CONFIG_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'memoir')
  : path.join(os.homedir(), '.config', 'memoir');
const EVENTS_PATH = path.join(CONFIG_DIR, 'events.jsonl');
const EVENTS_LOCK_PATH = path.join(CONFIG_DIR, 'events.jsonl.lock');

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_ROTATIONS = 2; // keep events.jsonl.1 and .2; older generations are dropped

let cachedMachineId = null;
async function machineId() {
  if (cachedMachineId) return cachedMachineId;
  try {
    const { id } = await getMachineId();
    cachedMachineId = id;
  } catch {
    cachedMachineId = 'unknown';
  }
  return cachedMachineId;
}

// Rotate events.jsonl -> .1 -> .2, drop anything beyond MAX_ROTATIONS. Must
// only be called from within the events lock (see appendEvent) — this
// function itself does no locking.
function rotateIfNeeded() {
  try {
    if (!fs.existsSync(EVENTS_PATH)) return;
    const stat = fs.statSync(EVENTS_PATH);
    if (stat.size < MAX_BYTES) return;

    // Shift existing generations up (.1 -> .2 -> dropped), oldest first.
    for (let i = MAX_ROTATIONS; i >= 1; i--) {
      const src = `${EVENTS_PATH}.${i}`;
      if (!fs.existsSync(src)) continue;
      if (i === MAX_ROTATIONS) {
        fs.removeSync(src); // oldest generation, drop it
      } else {
        fs.moveSync(src, `${EVENTS_PATH}.${i + 1}`, { overwrite: true });
      }
    }
    fs.moveSync(EVENTS_PATH, `${EVENTS_PATH}.1`, { overwrite: true });
  } catch {
    // Rotation failure must never block an append.
  }
}

/**
 * Append one JSON event line. See file header for the privacy contract
 * (counts/ids/booleans/enum-strings only, never raw content) and the
 * crash-safety / size-bound / locking guarantees.
 *
 * Always safe to call and await — never throws, never rejects.
 */
export async function appendEvent(type, payload = {}) {
  try {
    await fs.ensureDir(CONFIG_DIR);
    const id = await machineId();
    const line = JSON.stringify({ ts: new Date().toISOString(), type, machine_id: id, ...payload }) + '\n';

    await withSessionLock(EVENTS_LOCK_PATH, async () => {
      rotateIfNeeded();
      fs.appendFileSync(EVENTS_PATH, line);
    });
  } catch {
    // Never break the caller.
  }
}

export const paths = {
  events: EVENTS_PATH,
  eventsLock: EVENTS_LOCK_PATH,
};
