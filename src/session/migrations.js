// Pure, no-I/O session-schema migration ladder for session.json.
//
// This module has NO file access and NO side effects — it's a plain data
// transform: migrateSessionData(parsedObject) -> { future, state }. That
// makes it safe to reuse everywhere a session object needs normalizing,
// not just when reading the local file:
//   - state.js's readSession() calls it after JSON.parse-ing the local
//     ~/.config/memoir/session.json.
//   - push.js and restore.js call it on an already-parsed REMOTE session.json
//     (fetched from another machine's backup) before merging it with the
//     local session via mergeSessions — so a lagging machine's old-schema
//     file, or a machine ahead on a newer schema, gets migrated/degraded
//     consistently regardless of which code path touched it first.
//
// File-specific concerns — backing up the ORIGINAL on-disk file before a
// migration changes its data, and printing a one-time user-facing warning —
// belong to the caller that actually owns a real file (readSession()), not
// here. Remote data has no local file to back up; mergeSessions' own
// never-clobber semantics are the safety net there (a degraded remote read
// at worst contributes nothing to the merge, never destroys local data).

export const SCHEMA_VERSION = 1;

// Per-version migration steps, keyed by the version being migrated FROM.
// Each step takes a state object at version N and returns one at N+1.
// Currently empty (identity ladder) since SCHEMA_VERSION is still 1 — this
// exists so a REAL future schema bump has a tested seam to hang a step off,
// rather than growing an ad hoc branch inside migrateSessionData itself.
//
//   const MIGRATIONS = {
//     1: (state) => ({ ...state, version: 2, /* ...transform... */ }),
//   };
const MIGRATIONS = {};

export function emptySession() {
  return {
    version: SCHEMA_VERSION,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    machines: {}, // { [machineId]: { label, last_seen } }
    current: {
      goals: [],         // { text, machine_id, set_on }
      next_actions: [],  // { text, machine_id, added, completed? }
      // Overflow from next_actions (oldest first out) — still rendered, still
      // completable, never silently dropped. Additive field: older readers
      // ignore it, mergeSessions unions it, so no schema bump.
      parked_actions: [],// { text, machine_id, added, parked_at }
      open_questions: [],// { text, machine_id, asked }
      decisions: [],     // { text, why?, rejected?, hidden?, hidden_at?, machine_id, date }
      completed_actions: [], // { text, done_at } — temporal tombstones (see state.js)
      completed_goals: [],   // { text, done_at } — same, for goals
    },
    history: [],          // { date, machine_id, summary, files_touched, duration_min? }
  };
}

/**
 * Normalize an already-JSON.parsed session object to SCHEMA_VERSION.
 *
 * Returns { future, state }:
 *   - future: false, state: normalized object at SCHEMA_VERSION — either
 *     walked forward through the migration ladder from an older/missing
 *     version, or passed through unchanged (with defaults filled in for any
 *     missing fields) if already current.
 *   - future: true, state: a fresh, empty, valid session — returned when the
 *     input's version is NEWER than this build's SCHEMA_VERSION (the file
 *     came from a newer memoir install). We deliberately do not attempt to
 *     interpret an unknown future shape; the caller decides what to do with
 *     `future: true` (readSession() backs up the original + warns once).
 *
 * Never throws on malformed input — worst case, returns a fresh empty
 * session (future: false), matching the existing "corrupted JSON" recovery
 * behavior elsewhere in this codebase.
 */
export function migrateSessionData(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { future: false, state: emptySession() };
  }

  let version = typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 0;

  if (version > SCHEMA_VERSION) {
    return { future: true, state: emptySession() };
  }

  let state = raw;
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version];
    state = step ? step(state) : { ...state, version: version + 1 };
    version += 1;
  }

  const fresh = emptySession();
  const normalized = {
    ...fresh,
    ...state,
    version: SCHEMA_VERSION,
    current: { ...fresh.current, ...(state?.current || {}) },
    machines: { ...fresh.machines, ...(state?.machines || {}) },
    history: Array.isArray(state?.history) ? state.history : [],
  };

  return { future: false, state: normalized };
}
