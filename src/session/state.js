// Session state: the canonical source of truth for "what are we working on"
// across sessions and machines. Rendered into CLAUDE.md (and other tools) as a
// pinned block at the top, guaranteed to load.
//
// File: ~/.config/memoir/session.json
// See CLAUDE.md pinned block for how this gets displayed.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { withSessionLock } from './lock.js';
import { SCHEMA_VERSION, migrateSessionData, emptySession } from './migrations.js';

const home = os.homedir();
const CONFIG_DIR = path.join(home, '.config', 'memoir');
const SESSION_PATH = path.join(CONFIG_DIR, 'session.json');
const MACHINE_ID_PATH = path.join(CONFIG_DIR, 'machine.id');
const SESSION_LOCK_PATH = path.join(CONFIG_DIR, 'session.json.lock');

// Re-exported for external consumers (e.g. test-session.mjs asserts against
// state.SCHEMA_VERSION) — the canonical constant now lives in migrations.js
// alongside the migration ladder it governs.
export { SCHEMA_VERSION, emptySession };

// Maximum items kept in each list before oldest entries rotate into history.
// Prevents unbounded growth of the live pinned block.
const MAX_GOALS = 3;
const MAX_NEXT = 8;
const MAX_QUESTIONS = 5;
const MAX_DECISIONS_RECENT = 10;
const MAX_HISTORY = 30;

// ── Machine identity ─────────────────────────────────────────────

// Stable per-machine identifier. Persisted once, reused forever.
// We pair a UUID (stable across hostname changes) with a human label (hostname)
// for display — "mac-mini (abc1234)".
export async function getMachineId() {
  try {
    if (await fs.pathExists(MACHINE_ID_PATH)) {
      const id = (await fs.readFile(MACHINE_ID_PATH, 'utf8')).trim();
      if (id) return { id, label: os.hostname() };
    }
  } catch {}

  const id = crypto.randomUUID();
  await fs.ensureDir(CONFIG_DIR);
  await fs.writeFile(MACHINE_ID_PATH, id);
  return { id, label: os.hostname() };
}

// ── Read / write ─────────────────────────────────────────────────
//
// Forward-version guard: if session.json's version is NEWER than this
// build's SCHEMA_VERSION (the file came from a newer memoir install — e.g.
// another machine upgraded first and this one hasn't yet), readSession()
// backs up the original file (mirroring the corrupted-JSON quarantine
// pattern below) and returns a safe, empty-but-valid session instead of
// misinterpreting an unknown shape. This is centralized HERE, not in
// individual callers, so all ~20 call sites across mcp.js (8 MCP tool
// handlers), commands/session.js, commands/why.js, commands/auto-refresh.js,
// commands/push.js, commands/restore.js automatically get safe behavior
// with zero changes required at each call site — and critically, no MCP
// tool call is ever allowed to throw/crash because of a schema mismatch.
let warnedForwardVersion = false; // print the upgrade warning once per process, not once per call

// Atomic read with graceful recovery from corrupted JSON AND from a
// too-new schema version.
export async function readSession() {
  if (!await fs.pathExists(SESSION_PATH)) return emptySession();

  let raw;
  try {
    raw = await fs.readFile(SESSION_PATH, 'utf8');
  } catch {
    // Unreadable (permissions, race with a concurrent delete, etc.) —
    // degrade to a safe empty session rather than throwing.
    return emptySession();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupted — preserve it for inspection, start fresh.
    const backup = `${SESSION_PATH}.corrupted-${Date.now()}`;
    try { await fs.copy(SESSION_PATH, backup); } catch {}
    return emptySession();
  }

  const { future, state } = migrateSessionData(parsed);

  if (future) {
    const backup = `${SESSION_PATH}.pre-migration-${Date.now()}`;
    try { await fs.copy(SESSION_PATH, backup); } catch {}
    if (!warnedForwardVersion) {
      warnedForwardVersion = true;
      try {
        process.stderr.write(
          `memoir: session.json is from a newer version of memoir than this install understands ` +
          `(schema v${parsed?.version} > v${SCHEMA_VERSION}). It has been backed up to ${backup}. ` +
          `Run: npm i -g memoir-cli@latest\n`
        );
      } catch {}
    }
  }

  return state;
}

// Atomic write: write to tmp, rename. Prevents torn writes on crash.
// Unconditionally stamps version — every write lands at the CURRENT
// SCHEMA_VERSION, since it always passed through readSession/migrateSessionData
// (or emptySession()) to get here. Always called from within a locked
// critical section (see the mutators below and lock.js).
export async function writeSession(state) {
  await fs.ensureDir(CONFIG_DIR);
  state.version = SCHEMA_VERSION;
  state.updated_at = new Date().toISOString();
  const tmp = `${SESSION_PATH}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.move(tmp, SESSION_PATH, { overwrite: true });
}

// ── Machine registration ────────────────────────────────────────

async function touchMachine(state) {
  const { id, label } = await getMachineId();
  state.machines[id] = {
    label,
    last_seen: new Date().toISOString(),
  };
  return id;
}

// ── Mutators ────────────────────────────────────────────────────

// Every mutator below wraps its ENTIRE read -> mutate -> write cycle in
// withSessionLock — not just the write. Locking only the write would still
// allow two processes to both read the same stale snapshot before either
// writes; the read must be inside the lock too so the second process reads
// the FIRST process's already-written change rather than a stale copy.

export async function addGoal(text) {
  return withSessionLock(SESSION_LOCK_PATH, async () => {
    const state = await readSession();
    const machineId = await touchMachine(state);
    state.current.goals.unshift({
      text,
      machine_id: machineId,
      set_on: new Date().toISOString(),
    });
    state.current.goals = state.current.goals.slice(0, MAX_GOALS);
    await writeSession(state);
    return state;
  });
}

export async function addNext(text) {
  return withSessionLock(SESSION_LOCK_PATH, async () => {
    const state = await readSession();
    const machineId = await touchMachine(state);
    // Dedupe by text (case-insensitive)
    const normalized = text.trim().toLowerCase();
    const exists = state.current.next_actions.some(a => a.text.trim().toLowerCase() === normalized);
    if (!exists) {
      state.current.next_actions.push({
        text,
        machine_id: machineId,
        added: new Date().toISOString(),
      });
      state.current.next_actions = state.current.next_actions.slice(-MAX_NEXT);
    }
    await writeSession(state);
    return state;
  });
}

export async function completeNext(textOrIndex) {
  return withSessionLock(SESSION_LOCK_PATH, async () => {
    const state = await readSession();
    await touchMachine(state);
    let idx = -1;
    if (typeof textOrIndex === 'number') {
      idx = textOrIndex;
    } else {
      const normalized = String(textOrIndex).trim().toLowerCase();
      idx = state.current.next_actions.findIndex(a => a.text.trim().toLowerCase().includes(normalized));
    }
    if (idx >= 0) {
      state.current.next_actions.splice(idx, 1);
    }
    await writeSession(state);
    return state;
  });
}

export async function addNote(text, opts = {}) {
  return withSessionLock(SESSION_LOCK_PATH, async () => {
    const state = await readSession();
    const machineId = await touchMachine(state);
    const decision = {
      text,
      machine_id: machineId,
      date: new Date().toISOString(),
    };
    if (opts.why) decision.why = opts.why;
    if (opts.rejected) decision.rejected = opts.rejected;
    state.current.decisions.unshift(decision);
    state.current.decisions = state.current.decisions.slice(0, MAX_DECISIONS_RECENT);
    await writeSession(state);
    return state;
  });
}

export async function addQuestion(text) {
  return withSessionLock(SESSION_LOCK_PATH, async () => {
    const state = await readSession();
    const machineId = await touchMachine(state);
    state.current.open_questions.push({
      text,
      machine_id: machineId,
      asked: new Date().toISOString(),
    });
    state.current.open_questions = state.current.open_questions.slice(-MAX_QUESTIONS);
    await writeSession(state);
    return state;
  });
}

// Roll up the current state into a history entry. Use at session end / push.
// Does not clear `current` — these are "the working set," not per-session scratch.
export async function recordSessionEnd({ summary, filesTouched = [], durationMin = null } = {}) {
  return withSessionLock(SESSION_LOCK_PATH, async () => {
    const state = await readSession();
    const machineId = await touchMachine(state);
    state.history.unshift({
      date: new Date().toISOString(),
      machine_id: machineId,
      summary: summary || '',
      files_touched: filesTouched.slice(0, 20),
      duration_min: durationMin,
    });
    state.history = state.history.slice(0, MAX_HISTORY);
    await writeSession(state);
    return state;
  });
}

// ── Cross-machine merge ─────────────────────────────────────────

// Merge a remote session (from another machine's backup) into local.
// Never clobbers — unions lists, dedupes by text, keeps newest timestamp.
// Machine entries accumulate so we can show "last seen on X".
export function mergeSessions(local, remote) {
  if (!remote) return local;
  if (!local) local = { ...remote };

  const merged = {
    version: SCHEMA_VERSION,
    created_at: earliest(local.created_at, remote.created_at),
    updated_at: latest(local.updated_at, remote.updated_at),
    machines: { ...remote.machines, ...local.machines }, // local wins for same machine
    current: {
      goals: unionByText(local.current?.goals, remote.current?.goals, 'set_on', MAX_GOALS),
      next_actions: unionByText(local.current?.next_actions, remote.current?.next_actions, 'added', MAX_NEXT),
      open_questions: unionByText(local.current?.open_questions, remote.current?.open_questions, 'asked', MAX_QUESTIONS),
      decisions: unionByText(local.current?.decisions, remote.current?.decisions, 'date', MAX_DECISIONS_RECENT),
    },
    history: mergeHistory(local.history, remote.history),
  };

  // machines: union last_seen per id (take the newer)
  for (const [id, entry] of Object.entries(remote.machines || {})) {
    const existing = merged.machines[id];
    if (!existing || new Date(entry.last_seen) > new Date(existing.last_seen)) {
      merged.machines[id] = entry;
    }
  }

  return merged;
}

function unionByText(a = [], b = [], dateField, cap) {
  const byText = new Map();
  for (const item of [...a, ...b]) {
    if (!item || !item.text) continue;
    const key = item.text.trim().toLowerCase();
    const existing = byText.get(key);
    if (!existing || new Date(item[dateField] || 0) > new Date(existing[dateField] || 0)) {
      byText.set(key, item);
    }
  }
  return Array.from(byText.values())
    .sort((x, y) => new Date(y[dateField] || 0) - new Date(x[dateField] || 0))
    .slice(0, cap);
}

function mergeHistory(a = [], b = []) {
  const seen = new Set();
  const all = [...a, ...b].filter(h => h && h.date);
  // Dedupe by (date + machine_id + summary) — the three keys that make a session unique
  const unique = all.filter(h => {
    const key = `${h.date}|${h.machine_id}|${(h.summary || '').slice(0, 50)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique
    .sort((x, y) => new Date(y.date) - new Date(x.date))
    .slice(0, MAX_HISTORY);
}

function earliest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) < new Date(b) ? a : b;
}

function latest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a) > new Date(b) ? a : b;
}

// ── Paths (exported for tests + other modules) ──────────────────

export const paths = {
  config: CONFIG_DIR,
  session: SESSION_PATH,
  machineId: MACHINE_ID_PATH,
  sessionLock: SESSION_LOCK_PATH,
};
