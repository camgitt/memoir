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
// NOTE: events/log.js imports getMachineId FROM this module — this is a
// circular import, safe here because both appendEvent (used below) and
// getMachineId (used by events/log.js) are hoisted function declarations
// used only inside other functions' bodies, never at module-evaluation
// time. Verified working; see test-event-log.mjs.
import { appendEvent } from '../events/log.js';

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
// Completion tombstones kept so merges can't resurrect finished actions.
// Must outlive every stale copy that might still carry the item.
const MAX_COMPLETED_TOMBSTONES = 50;
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

// Opportunistic cleanup so the .corrupted-<ts> / .pre-migration-<ts> backup
// patterns don't accumulate forever on a machine that repeatedly hits
// either quarantine path. Keeps the N most recent of EACH pattern, deletes
// older ones. Best-effort — a cleanup failure never blocks the caller.
const MAX_BACKUPS_PER_PATTERN = 3;
function cleanupOldBackups(suffixPrefix) {
  try {
    const dir = path.dirname(SESSION_PATH);
    const base = path.basename(SESSION_PATH); // "session.json"
    const marker = `${base}.${suffixPrefix}-`;
    const matches = fs.readdirSync(dir)
      .filter((f) => f.startsWith(marker))
      .map((f) => {
        let mtime = 0;
        try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch {}
        return { name: f, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const f of matches.slice(MAX_BACKUPS_PER_PATTERN)) {
      try { fs.unlinkSync(path.join(dir, f.name)); } catch {}
    }
  } catch {
    // Best-effort — never block the caller.
  }
}

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
    cleanupOldBackups('corrupted');
    return emptySession();
  }

  const { future, state } = migrateSessionData(parsed);

  if (future) {
    const backup = `${SESSION_PATH}.pre-migration-${Date.now()}`;
    try { await fs.copy(SESSION_PATH, backup); } catch {}
    cleanupOldBackups('pre-migration');
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
    await appendEvent('goal_set', {}); // no PII/content — count-and-type only
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
    const completed = idx >= 0;
    if (completed) {
      // Removal alone is not enough: any merge with a copy that still holds
      // this item (the push-side backup, another machine, a stale MCP-process
      // write) re-unions it straight back — the "completed actions resurrect"
      // bug. So completion also records a tombstone that merges consult.
      // Temporal, not absolute like decisions' `hidden`: a re-add whose
      // `added` postdates `done_at` is a deliberate revival and survives.
      const [removed] = state.current.next_actions.splice(idx, 1);
      const key = removed.text.trim().toLowerCase();
      state.current.completed_actions = [
        { text: removed.text, done_at: new Date().toISOString() },
        ...(state.current.completed_actions || []).filter(
          c => c && c.text && c.text.trim().toLowerCase() !== key
        ),
      ].slice(0, MAX_COMPLETED_TOMBSTONES);
    }
    await writeSession(state);
    // Only when something was actually completed — the event should mean
    // "something happened," not "this function was called with no match."
    if (completed) await appendEvent('next_completed', {});
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
    // Count/booleans only — never the decision text itself.
    await appendEvent('decision_captured', { has_why: !!opts.why, has_rejected: !!opts.rejected });
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

  // Completed-action tombstones beat the union above. unionByText can only
  // union; it cannot represent "this used to exist and was finished," so a
  // completed item surviving in ANY stale copy resurrected on every merge —
  // the intermittent completeNext no-op observed in production (2026-08-03).
  // Temporal on purpose: an item re-ADDED after its done_at is a deliberate
  // revival and must survive, so tombstones only suppress copies whose
  // `added` predates the completion.
  const tombstones = unionTombstones(
    local.current?.completed_actions,
    remote.current?.completed_actions
  );
  merged.current.completed_actions = tombstones;
  merged.current.next_actions = merged.current.next_actions.filter(a => {
    const t = tombstones.find(
      c => c.text.trim().toLowerCase() === a.text.trim().toLowerCase()
    );
    return !t || new Date(a.added || 0) > new Date(t.done_at);
  });

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

  // A tombstone is STICKY: once any machine marks an entry hidden, the merged
  // result stays hidden, whatever the dates say.
  //
  // Without this, `hidden` is just another field on whichever copy has the
  // newer date — so a machine that hasn't pulled the tombstone yet, holding an
  // older un-hidden copy of the same text, resurrects it on its next
  // merge/push. (The cleanup script sets `hidden` without touching `date`, so
  // the tombstoned copy doesn't even win the date comparison.) Suppression has
  // to be monotonic or it isn't suppression — you'd be re-hiding the same junk
  // on every machine forever.
  for (const [key, winner] of byText) {
    if (winner.hidden) continue;
    const tombstone = [...a, ...b].find(
      (i) => i && i.text && i.text.trim().toLowerCase() === key && i.hidden
    );
    if (tombstone) {
      byText.set(key, { ...winner, hidden: true, hidden_at: tombstone.hidden_at });
    }
  }

  // Partition before capping. Tombstones keep their original (recent) date,
  // so a plain sort+slice let them win cap slots and silently evict real
  // entries on merge. They must SURVIVE the merge (removing them
  // reintroduces the resurrection the sticky-tombstone rule fixed) but must
  // not count against the visible budget.
  const all = Array.from(byText.values())
    .sort((x, y) => new Date(y[dateField] || 0) - new Date(x[dateField] || 0));
  const visible = all.filter((i) => !i.hidden).slice(0, cap);
  const tombstones = all.filter((i) => i.hidden).slice(0, cap);
  return [...visible, ...tombstones];
}

function unionTombstones(a = [], b = []) {
  const byText = new Map();
  for (const item of [...(a || []), ...(b || [])]) {
    if (!item || !item.text || !item.done_at) continue;
    const key = item.text.trim().toLowerCase();
    const existing = byText.get(key);
    if (!existing || new Date(item.done_at) > new Date(existing.done_at)) {
      byText.set(key, item);
    }
  }
  return Array.from(byText.values())
    .sort((x, y) => new Date(y.done_at) - new Date(x.done_at))
    .slice(0, MAX_COMPLETED_TOMBSTONES);
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
