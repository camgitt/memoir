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

const home = os.homedir();
const CONFIG_DIR = path.join(home, '.config', 'memoir');
const SESSION_PATH = path.join(CONFIG_DIR, 'session.json');
const MACHINE_ID_PATH = path.join(CONFIG_DIR, 'machine.id');

export const SCHEMA_VERSION = 1;

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

// ── Schema ───────────────────────────────────────────────────────

function emptySession() {
  return {
    version: SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    machines: {}, // { [machineId]: { label, last_seen } }
    current: {
      goals: [],         // { text, machine_id, set_on }
      next_actions: [],  // { text, machine_id, added, completed? }
      open_questions: [],// { text, machine_id, asked }
      decisions: [],     // { text, why?, rejected?, machine_id, date }
    },
    history: [],         // { date, machine_id, summary, files_touched, duration_min? }
  };
}

// ── Read / write ─────────────────────────────────────────────────

// Atomic read with graceful recovery from corrupted JSON.
export async function readSession() {
  if (!await fs.pathExists(SESSION_PATH)) return emptySession();

  try {
    const raw = await fs.readFile(SESSION_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return migrateIfNeeded(parsed);
  } catch (err) {
    // Corrupted — preserve it for inspection, start fresh.
    const backup = `${SESSION_PATH}.corrupted-${Date.now()}`;
    try { await fs.copy(SESSION_PATH, backup); } catch {}
    return emptySession();
  }
}

// Atomic write: write to tmp, rename. Prevents torn writes on crash.
export async function writeSession(state) {
  await fs.ensureDir(CONFIG_DIR);
  state.updated_at = new Date().toISOString();
  const tmp = `${SESSION_PATH}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.move(tmp, SESSION_PATH, { overwrite: true });
}

function migrateIfNeeded(state) {
  if (state && state.version === SCHEMA_VERSION) return state;
  // Future versions: add migration steps here.
  // For now, if version mismatch, merge defaults to fill gaps.
  const fresh = emptySession();
  return {
    ...fresh,
    ...state,
    version: SCHEMA_VERSION,
    current: { ...fresh.current, ...(state?.current || {}) },
    machines: { ...fresh.machines, ...(state?.machines || {}) },
    history: Array.isArray(state?.history) ? state.history : [],
  };
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

export async function addGoal(text) {
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
}

export async function addNext(text) {
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
}

export async function completeNext(textOrIndex) {
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
}

export async function addNote(text, opts = {}) {
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
}

export async function addQuestion(text) {
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
}

// Roll up the current state into a history entry. Use at session end / push.
// Does not clear `current` — these are "the working set," not per-session scratch.
export async function recordSessionEnd({ summary, filesTouched = [], durationMin = null } = {}) {
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
};
