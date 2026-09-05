import { repositoryState } from '../memory/repository.js';
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
import { projectIdentity, visibleMemory } from '../memory/scope.js';
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
// Overflow from next_actions goes here instead of vanishing. `slice(-MAX_NEXT)`
// used to drop the oldest item with no warning, no event and no render hint:
// three of the author's live next-actions disappeared in one week (2026-09-03
// → 09-04) while the store sat at exactly 8. Parked items stay rendered and
// completable; only when THIS list overflows is anything dropped, and that
// emits an event.
const MAX_PARKED = Infinity;
// Completion tombstones kept so merges can't resurrect finished actions.
// Must outlive every stale copy that might still carry the item.
const MAX_COMPLETED_TOMBSTONES = Infinity;
const MAX_QUESTIONS = 5;
const MAX_DECISIONS_RECENT = 10;
const MAX_HISTORY = Infinity;

// ── Decision identity ────────────────────────────────────────────
//
// SPEC.md 5.1: a decision's identity is its normalized text. A PURGED
// tombstone (memoir forget --purge) has had that text redacted, so it
// carries `text_hash` = sha256(identity) instead and matches by hash.
// Both forms resolve to the same key here so unionByText/capDecisions
// treat "the original" and "the purged tombstone of the original" as one
// identity — that is what lets the tombstone keep suppressing copies of
// the un-purged text on replicas that never saw the purge.
export const PURGED_TEXT = '[purged]';

export function decisionIdentity(text) {
  return String(text || '').trim().toLowerCase();
}

export function decisionHash(text) {
  return crypto.createHash('sha256').update(decisionIdentity(text)).digest('hex');
}

function decisionKey(item) {
  if (!item) return null;
  if (item.text_hash) return 'sha256:' + item.text_hash + (item.project ? ':' + item.project : '');
  if (!item.text) return null;
  return 'sha256:' + decisionHash(item.text) + (item.project ? ':' + item.project : '');
}

// Cap decisions WITHOUT evicting tombstones. A plain `slice(0, cap)` after
// an unshift meant the 11th note pushed the oldest hidden decision off the
// list — and a dropped tombstone is a resurrection waiting for the next
// merge with any replica still holding the un-hidden copy. Tombstones and
// visible entries get separate budgets, same as unionByText below.
function capDecisions(list = [], cap = MAX_DECISIONS_RECENT) {
  const visible = list.filter((d) => d && !d.hidden).slice(0, cap);
  const tombstones = list.filter((d) => d && d.hidden);
  return [...visible, ...tombstones];
}

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
  partitionWorkingState(state);
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
    const key = decisionIdentity(text);
    // Re-setting an existing goal moves it to the front; it is not a duplicate.
    state.current.goals = (state.current.goals || []).filter((g) => decisionIdentity(g?.text) !== key || !visibleMemory(g));
    state.current.goals.unshift({
      text,
      id: crypto.randomUUID(),
      project: projectIdentity(),
      machine_id: machineId,
      set_on: new Date().toISOString(),
    });
    // The cap still applies (a pinned block with ten goals is no focus at
    // all) but a replaced goal is reported, never silently dropped.
    const replaced = state.current.goals.slice(MAX_GOALS);

    await writeSession(state);
    await appendEvent('goal_set', { replaced: replaced.length }); // no PII/content — count-and-type only
    Object.defineProperty(state, 'replacedGoals', { value: replaced, enumerable: false });
    return state;
  });
}

export async function addNext(text) {
  return withSessionLock(SESSION_LOCK_PATH, async () => {
    const state = await readSession();
    const machineId = await touchMachine(state);
    // Dedupe by text (case-insensitive)
    const normalized = text.trim().toLowerCase();
    const exists = state.current.next_actions.some(a => a.text.trim().toLowerCase() === normalized && visibleMemory(a));
    let parked = [];
    if (!exists) {
      // Re-adding a parked item is "bring it back", not a duplicate.
      state.current.parked_actions = (state.current.parked_actions || [])
        .filter((a) => a?.text?.trim().toLowerCase() !== normalized || !visibleMemory(a));
      state.current.next_actions.push({
        text,
        id: crypto.randomUUID(),
      project: projectIdentity(),
      machine_id: machineId,
        added: new Date().toISOString(),
      });
      ({ live: state.current.next_actions, parked } = parkOverflow(state.current.next_actions));
      if (parked.length) {
        const merged = [...parked, ...(state.current.parked_actions || [])];
        const dropped = merged.slice(MAX_PARKED);
        state.current.parked_actions = merged.slice(0, MAX_PARKED);
        await appendEvent('next_parked', { count: parked.length, dropped: dropped.length });
      }
    }
    await writeSession(state);
    // Non-enumerable: callers can tell the user what was parked, nothing
    // serialises it.
    Object.defineProperty(state, 'justParked', { value: parked, enumerable: false });
    return state;
  });
}

// Split a next_actions list into the MAX_NEXT newest (live) and the overflow
// (oldest first), stamping parked_at on the overflow. Pure; shared by
// addNext and mergeSessions so both agree on what "full" means.
function parkOverflow(list, cap = MAX_NEXT, now = new Date().toISOString()) {
  if (list.length <= cap) return { live: list, parked: [] };
  const overflow = list.slice(0, list.length - cap);
  return {
    live: list.slice(list.length - cap),
    parked: overflow.map((a) => ({ ...a, parked_at: a.parked_at || now })),
  };
}

/**
 * Retire a goal. Same shape as completeNext: remove it AND record a
 * temporal tombstone, because a plain removal comes straight back on the
 * next union-merge with any copy that still carries it (the push-side
 * backup, another machine). A goal re-set after its done_at survives.
 */
export async function completeGoal(match) {
  return withSessionLock(SESSION_LOCK_PATH, async () => {
    const state = await readSession();
    await touchMachine(state);
    const normalized = String(match).trim().toLowerCase();
    state.current.goals = [...(state.current.goals || []), ...(state.current.archived_goals || [])];
    state.current.archived_goals = [];
    const idx = state.current.goals.findIndex(g => visibleMemory(g) && g?.text?.trim().toLowerCase().includes(normalized));
    const completed = idx >= 0;
    if (completed) {
      const [removed] = state.current.goals.splice(idx, 1);
      const key = removed.text.trim().toLowerCase();
      state.current.completed_goals = [
        { text: removed.text, project: removed.project, done_at: new Date().toISOString() },
        ...(state.current.completed_goals || []).filter((c) => c && c.text && decisionKey(c) !== decisionKey(removed)),
      ].slice(0, MAX_COMPLETED_TOMBSTONES);
    }
    await writeSession(state);
    if (completed) await appendEvent('goal_completed', {});
    Object.defineProperty(state, 'completed', { value: completed, enumerable: false });
    return state;
  });
}

export async function completeNext(textOrIndex) {
  return withSessionLock(SESSION_LOCK_PATH, async () => {
    const state = await readSession();
    await touchMachine(state);
    let idx = -1;
    let list = state.current.next_actions;
    if (typeof textOrIndex === 'number') {
      idx = list.map((item, index) => ({ item, index })).filter(x => visibleMemory(x.item))[textOrIndex]?.index ?? -1;
    } else {
      const normalized = String(textOrIndex).trim().toLowerCase();
      idx = list.findIndex(a => visibleMemory(a) && a.text.trim().toLowerCase().includes(normalized));
      if (idx < 0) {
        // Parked items are still real next-actions — finishing one must work.
        list = state.current.parked_actions || [];
        idx = list.findIndex(a => visibleMemory(a) && a?.text?.trim().toLowerCase().includes(normalized));
      }
    }
    const completed = idx >= 0;
    if (completed) {
      // Removal alone is not enough: any merge with a copy that still holds
      // this item (the push-side backup, another machine, a stale MCP-process
      // write) re-unions it straight back — the "completed actions resurrect"
      // bug. So completion also records a tombstone that merges consult.
      // Temporal, not absolute like decisions' `hidden`: a re-add whose
      // `added` postdates `done_at` is a deliberate revival and survives.
      const [removed] = list.splice(idx, 1);
      const key = removed.text.trim().toLowerCase();
      state.current.completed_actions = [
        { text: removed.text, project: removed.project, done_at: new Date().toISOString() },
        ...(state.current.completed_actions || []).filter(
          c => c && c.text && decisionKey(c) !== decisionKey(removed)
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
      id: crypto.randomUUID(),
      project: projectIdentity(opts.project),
      text,
      machine_id: machineId,
      date: new Date().toISOString(),
    };
    if (opts.why) decision.why = opts.why;
    if (opts.rejected) decision.rejected = opts.rejected;
    state.current.decisions.unshift(decision);
    await writeSession(state);
    // Count/booleans only — never the decision text itself.
    await appendEvent('decision_captured', { has_why: !!opts.why, has_rejected: !!opts.rejected });
    return state;
  });
}

/**
 * Find visible decisions matching a query — substring on text/why/rejected,
 * or an exact identity match. Pure; shared by `memoir forget` and the
 * memoir_forget MCP tool so both agree on what "matches" means.
 */
export function matchDecisions(state, query) {
  const q = decisionIdentity(query);
  if (!q) return [];
  const decisions = allDecisions(state).filter((d) => d && d.text && visibleMemory(d));
  const exact = decisions.filter((d) => decisionIdentity(d.text) === q);
  if (exact.length) return exact;
  return decisions.filter((d) =>
    [d.text, d.why, d.rejected].filter(Boolean).join(' ').toLowerCase().includes(q)
  );
}

/**
 * Forget a decision: set the SPEC.md 5.3.1 absolute tombstone
 * (`hidden: true` + `hidden_at`) on the decision whose identity is `text`.
 *
 * With `purge`, the text/why/rejected are also redacted in place and the
 * entry keeps only `text_hash` as its identity — for when the thing to
 * forget is a leaked secret and hiding it from render is not enough. The
 * hash still lets the tombstone suppress un-purged copies on other
 * replicas at merge time (see unionByText).
 *
 * Deliberately NOT a delete: removal does not survive union-merge (the
 * exact bug 3.10.2 fixed for next_actions). And there is no un-forget —
 * `hidden` is monotonic by spec, which is why the CLI confirms first.
 */
export async function hideDecision(text, { purge = false } = {}) {
  return withSessionLock(SESSION_LOCK_PATH, async () => {
    const state = await readSession();
    await touchMachine(state);
    const key = decisionIdentity(text);
    state.current.decisions = allDecisions(state);
    state.current.archived_decisions = [];
    const idx = (state.current.decisions || []).findIndex(
      (d) => d && d.text && visibleMemory(d) && decisionIdentity(d.text) === key
    );
    if (idx < 0) return { state, hidden: false };

    const now = new Date().toISOString();
    const d = state.current.decisions[idx];
    const tomb = { ...d, hidden: true, hidden_at: now };
    if (purge) {
      tomb.text_hash = decisionHash(d.text);
      tomb.text = PURGED_TEXT;
      delete tomb.why;
      delete tomb.rejected;
    }
    state.current.decisions[idx] = tomb;
    await writeSession(state);
    await appendEvent('decision_hidden', { purged: !!purge });
    return { state, hidden: true, purged: !!purge };
  });
}

export async function addQuestion(text) {
  return withSessionLock(SESSION_LOCK_PATH, async () => {
    const state = await readSession();
    const machineId = await touchMachine(state);
    state.current.open_questions.push({
      text,
      id: crypto.randomUUID(),
      project: projectIdentity(),
      machine_id: machineId,
      asked: new Date().toISOString(),
    });

    await writeSession(state);
    return state;
  });
}

// Roll up the current state into a history entry. Use at session end / push.
// Does not clear `current` — these are "the working set," not per-session scratch.
export async function recordSessionEnd({ summary, filesTouched = [], durationMin = null, sessionId = null, project } = {}) {
  return withSessionLock(SESSION_LOCK_PATH, async () => {
    const state = await readSession();
    const machineId = await touchMachine(state);
    const entry = {
      date: new Date().toISOString(),
      machine_id: machineId,
      project: projectIdentity(project),
      summary: summary || '',
      files_touched: filesTouched.slice(0, 20),
      duration_min: durationMin,
    };
    const repo = repositoryState(project || process.env.MEMOIR_PROJECT_ROOT || process.cwd());
    entry.repo_head = repo.head;
    entry.branch = repo.branch;
    entry.working_tree_dirty = repo.dirty;
    if (sessionId) entry.session_id = sessionId;
    // Autopush fires after every response, so one long session used to fill
    // all five "Recent sessions" rows with itself. Same session → update its
    // row in place (duration and files grow), don't add another.
    const existing = sessionId ? state.history.findIndex((h) => h?.session_id === sessionId) : -1;
    if (existing >= 0) {
      entry.date = state.history[existing].date || entry.date;
      state.history.splice(existing, 1);
    }
    state.history.unshift(entry);
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
      goals: unionByText([...(local.current?.goals || []), ...(local.current?.archived_goals || [])], [...(remote.current?.goals || []), ...(remote.current?.archived_goals || [])], 'set_on', Infinity),
      archived_goals: [],
      // Live + parked from both sides pooled, then re-split below: the
      // MAX_NEXT newest are live, the rest parked. A capped union here used
      // to evict the oldest on merge just as silently as addNext did.
      next_actions: unionByText(
        [...(local.current?.next_actions || []), ...(local.current?.parked_actions || [])],
        [...(remote.current?.next_actions || []), ...(remote.current?.parked_actions || [])],
        'added', Infinity),
      parked_actions: [],
      open_questions: unionByText([...(local.current?.open_questions || []), ...(local.current?.archived_questions || [])], [...(remote.current?.open_questions || []), ...(remote.current?.archived_questions || [])], 'asked', Infinity),
      archived_questions: [],
      decisions: unionByText(allDecisions(local), allDecisions(remote), 'date', Infinity),
      archived_decisions: [],
    },
    history: mergeHistory(local.history, remote.history),
  };

  // Fields this build does not know about pass through from the local copy
  // instead of being dropped. `current` is rebuilt from known keys above, so
  // a merge performed by an OLDER memoir silently erased anything newer —
  // live proof: minutes after 3.13.0 added parked_actions and
  // completed_goals, a Stop-hook push still running 3.12 rebuilt `current`
  // without them and wrote that back locally, undoing two goal retirements
  // and a parked item. Local wins over remote for unknown keys because an
  // old build cannot merge what it cannot read.
  const KNOWN_CURRENT = new Set(['goals', 'next_actions', 'parked_actions', 'open_questions', 'decisions', 'archived_decisions', 'archived_goals', 'archived_questions', 'completed_actions', 'completed_goals']);
  for (const src of [remote.current || {}, local.current || {}]) {
    for (const [k, v] of Object.entries(src)) {
      if (!KNOWN_CURRENT.has(k)) merged.current[k] = v;
    }
  }

  // Goal tombstones — same temporal rule as next_actions below.
  const goalTombstones = unionTombstones(local.current?.completed_goals, remote.current?.completed_goals);
  merged.current.completed_goals = goalTombstones;
  merged.current.goals = merged.current.goals.filter((g) => {
    const t = goalTombstones.find((c) => decisionKey(c) === decisionKey(g));
    return !t || new Date(g.set_on || 0) > new Date(t.done_at);
  });

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
      c => decisionKey(c) === decisionKey(a)
    );
    return !t || new Date(a.added || 0) > new Date(t.done_at);
  });
  // unionByText returns newest-first; next_actions is stored oldest-first
  // (render reverses). Re-split into live (newest MAX_NEXT) and parked.
  const pooled = [...merged.current.next_actions].reverse();
  const split = parkOverflow(pooled);
  merged.current.next_actions = split.live.map((a) => { const { parked_at, ...rest } = a; return rest; });
  merged.current.parked_actions = split.parked.reverse().slice(0, MAX_PARKED);

  // machines: union last_seen per id (take the newer)
  for (const [id, entry] of Object.entries(remote.machines || {})) {
    const existing = merged.machines[id];
    if (!existing || new Date(entry.last_seen) > new Date(existing.last_seen)) {
      merged.machines[id] = entry;
    }
  }

  partitionWorkingState(merged);
  return merged;
}

function unionByText(a = [], b = [], dateField, cap) {
  const byText = new Map();
  // Identity is normalized text (SPEC 5.1). Keyed through decisionKey so a
  // PURGED decision tombstone — text redacted, `text_hash` kept — lands on
  // the same key as the un-purged copies it must keep suppressing. For
  // goals/next_actions/questions (no purge concept) this is just a hash of
  // the same normalized text and behaves exactly as before.
  for (const item of [...a, ...b]) {
    const key = decisionKey(item);
    if (!key) continue;
    const existing = byText.get(key);
    if (!existing || new Date(item[dateField] || 0) > new Date(existing[dateField] || 0)) {
      byText.set(key, item);
    }
  }

  const stones = [...a, ...b].filter(i => i?.hidden);
  for (const [key, item] of byText) {
    if (item.project || item.hidden) continue;
    const hash = item.text_hash || decisionHash(item.text);
    if (stones.some(t => t.project && (t.text_hash || decisionHash(t.text)) === hash)) byText.delete(key);
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
  //
  // A PURGED tombstone wins outright — never let a date-winning un-purged
  // copy carry the redacted text back into the merged result. Purge is
  // "this text must leave the file"; the merged entry must be the purged one.
  for (const [key, winner] of byText) {
    const stones = [...a, ...b].filter((i) => i && i.hidden && decisionKey(i) === key);
    if (!stones.length) continue;
    const tombstone = stones.find((i) => i.text_hash) || stones[0];
    if (tombstone.text_hash) {
      byText.set(key, tombstone);
    } else if (!winner.hidden) {
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
  const visible = all.filter((i) => !i.hidden).slice(0, cap === Infinity ? undefined : cap);
  const tombstones = all.filter((i) => i.hidden);
  return [...visible, ...tombstones];
}

function unionTombstones(a = [], b = []) {
  const byText = new Map();
  for (const item of [...(a || []), ...(b || [])]) {
    if (!item || !item.text || !item.done_at) continue;
    const key = decisionKey(item);
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
  // Newest copy of a session_id wins (in-place updates change summary/duration).
  const sorted = all.sort((x, y) => new Date(y.date) - new Date(x.date));
  const unique = sorted.filter(h => {
    const key = h.session_id ? `sid:${h.session_id}` : `${h.date}|${h.machine_id}|${(h.summary || '').slice(0, 50)}`;
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

export function allDecisions(state) {
  return [...(state?.current?.decisions || []), ...(state?.current?.archived_decisions || [])];
}

function partitionWorkingState(state) {
  state.current ||= {};
  for (const [live, archive, date, cap] of [
    ['decisions', 'archived_decisions', 'date', MAX_DECISIONS_RECENT],
    ['goals', 'archived_goals', 'set_on', MAX_GOALS],
    ['open_questions', 'archived_questions', 'asked', MAX_QUESTIONS],
  ]) {
    const all = unionByText(state.current[live], state.current[archive], date, Infinity);
    state.current[live] = capDecisions(all, cap);
    state.current[archive] = all.filter(item => !item.hidden).slice(cap);
  }
}
