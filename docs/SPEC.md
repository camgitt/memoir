# The memoir format, v0.1 (draft)

**Status:** Draft. Version 0.1. Seeking implementations and critique.

This document specifies the memoir format: an open, portable, plain-text
format for an AI assistant's accumulated working context — what it has
learned, decided, been corrected on, and is in the middle of doing.

The format is extracted from a working implementation
([memoir-cli](https://github.com/camgitt/memoir), MIT), not designed on a
whiteboard. Where this document and shipped behavior disagree, that is a bug
in this document; please file it. Normative words (MUST, SHOULD, MAY) are
used in the RFC 2119 sense.

---

## 1. Why an open format

Every AI vendor is shipping memory, and every one of them is shipping it
locked in. Memory is the strongest lock-in there is, because it compounds:
the assistant that knows your preferences, your past decisions and their
reasons, and the mistakes it must not repeat is worth more every week — and
none of that accumulates anywhere you can take with you. Email had the same
problem, and solved it with open formats and protocols (mbox, Maildir, IMAP):
your mail is yours, in files and mailboxes any client can read, and clients
compete on experience rather than on holding your archive hostage.

The memoir format is that seat for AI working context. It deliberately covers
*experience*, not just facts: a decision with its rationale and the
alternative that was rejected; a lesson with the trigger that should fire it
and the behavior change it demands; the live working set of goals and next
actions that lets a different tool — or the same tool on a different machine —
pick up mid-thought. It is plain markdown and JSON on disk, owned by the
user, versioned however the user versions files. Any tool that can read a
directory can read it. That is the whole point.

## 2. The store

A **memoir store** is:

1. a directory of **entry files** — one entry per file, markdown with YAML
   frontmatter (section 3), and
2. a **session state file** — a single JSON document holding the live working
   set (section 5).

```
<store>/
  memory/
    decision_local-db-choice.md
    lesson_migrations-staging-first.md
    preference_commit-style.md
    fact_staging-endpoints.md
    ...
  session.json
```

The reference implementation currently keeps these in two places for
tool-compatibility reasons (entry files where the host assistant reads its
memory, e.g. `~/.claude/projects/<project-slug>/memory/`; session state at
`~/.config/memoir/session.json`). The format does not care where the store
lives. A store MAY be a git repository; the format is designed so that it
diffs and merges well when it is (section 4.2).

Entry filenames SHOULD be lowercase slugs and SHOULD carry the entry type as
a prefix (`decision_`, `lesson_`, ...), purely for human scanability. The
filename (without `.md`) is the entry's **link name**: other entries
reference it with `[[wikilinks]]` in their body text.

## 3. Entry files

### 3.1 File format

An entry file is UTF-8 markdown. It SHOULD begin with a YAML frontmatter
block delimited by `---` lines. Everything after the closing `---` is the
**body**: free markdown, as long or short as the entry deserves.

Plain text is a feature, not a compromise, and implementations MUST NOT
"upgrade" the store to a database as the canonical form:

- **Human-readable.** The user can open, audit, and edit their AI's memory
  with any editor. Memory the user cannot read is memory the user cannot
  trust or correct.
- **Git-diffable.** One entry per file means a change to one memory is a
  one-file diff. History, blame, review, and rollback come free from tools
  the user already has.
- **Mergeable.** Text files union across machines with well-understood
  conflict surfaces (section 4). A database file is an opaque blob that can
  only be replaced wholesale — which is exactly the failure mode this format
  exists to avoid.
- **Durable.** Markdown will be readable in twenty years by tools that have
  never heard of memoir.

Implementations MAY build derived indexes (embeddings, full-text, SQLite
caches) but these are caches: the files are the truth, and a conforming
implementation MUST be able to rebuild any index from the files alone.

The frontmatter is restricted to a simple YAML subset so that it can be
parsed without a full YAML engine: scalar `key: value` pairs, one level of
nested mapping, and simple `- item` string lists. Writers MUST NOT emit
anchors, multi-line block scalars, or deeper nesting in frontmatter; prose
belongs in the body.

### 3.2 Common frontmatter fields

| Field | Requirement | Meaning |
|---|---|---|
| `type` | REQUIRED | One of the six entry types (3.3). |
| `name` | REQUIRED | Human-readable title (or slug) for the entry. |
| `description` | SHOULD | One line. Indexes and pickers render this; an entry without one is invisible in lists. |
| `created` | SHOULD | ISO 8601 date or date-time the entry was first written. |
| `updated` | MAY | ISO 8601 date or date-time of last substantive edit. |
| `schema_version` | MAY | Integer. Absent means `1`. See section 6. |
| `project` | MAY | Project this entry is scoped to; absent means global. |
| `tags` | MAY | List of strings. |
| `origin` | MAY | Mapping with any of `tool`, `session_id`, `machine_id` — where the entry came from. |

Readers MUST ignore fields they do not recognize. Writers MUST preserve
fields they do not recognize when rewriting an entry. (Unknown fields are how
the format extends without breaking deployed tools.)

### 3.3 Entry types

Six types. A type answers the question "what should a tool *do* with this
entry when it loads?" — inform (fact), constrain style (preference), prevent
relitigation (decision), change behavior (lesson), orient (goal), or resume
work (next_action).

Machine-readable versions of every constraint in this section are in
[`schema/entry.schema.json`](../schema/entry.schema.json).

#### 3.3.1 `fact`

Something true about the world, the project, or the environment, worth
loading into future context. Facts are the baseline type: when in doubt, an
entry is a fact.

Extra fields: `source` (MAY) — where the fact was established.

```markdown
---
type: fact
name: Staging API endpoints
description: Base URLs and auth mode for the staging environment
created: 2026-05-14
project: acme-api
---
Staging runs at `https://staging.api.example.com`, bearer-token auth,
tokens minted by `scripts/mint-token.sh`. Rate limit is 60 req/min and it
is enforced. See [[decision_local-db-choice]] for why staging has no
Postgres.
```

#### 3.3.2 `preference`

How the user wants things done. Preferences are standing instructions:
tone, formatting, workflow, tooling defaults.

Extra fields: `scope` (MAY) — `global` or `project`.

```markdown
---
type: preference
name: Commit message style
description: Imperative mood, no trailers, reference the issue number
scope: global
---
Commit subjects in imperative mood ("Add retry", not "Added retry").
No generated trailers. Reference the issue as `(#123)` at the end of the
subject when one exists.
```

#### 3.3.3 `decision`

Something that was decided, recorded so it does not get silently relitigated
three sessions later. A decision's value is almost entirely in its `why` and
its `rejected` alternative — "we use Postgres" is trivia; "we use Postgres
*because X*, and we rejected SQLite *because Y*" is experience.

Extra fields:

| Field | Requirement | Meaning |
|---|---|---|
| `date` | SHOULD | When it was decided (ISO 8601). Merge recency key (4.2). |
| `why` | SHOULD (strongly — see below) | The rationale. |
| `rejected` | SHOULD | The alternative considered and rejected, and why it lost. |
| `hidden` | MAY | `true` marks an absolute tombstone (4.3.1). |
| `hidden_at` | MUST when `hidden: true` | When it was tombstoned. |
| `superseded_by` | MAY | Link name of the decision that replaced this one. |

`why` and `rejected` are *required-encouraged*: their absence is not a
validation error (auto-captured decisions legitimately lack them at capture
time), but interactive writers SHOULD prompt for both, and a decision entry
without a `why` SHOULD be flagged by validators as a warning. A decision
without a why is half a decision.

> Naming note: the field is `rejected`, not `rejected_alternative` — this
> matches every deployed store and the reference implementation's session
> records. The longer name lost to reality.

```markdown
---
type: decision
name: Local store is SQLite, not Postgres
description: Single-file embedded DB for the local cache; Postgres rejected
date: 2026-05-02
why: Zero-dependency install matters more than concurrent writers for a per-user local cache.
rejected: Postgres — better concurrency, but a daemon dependency in a CLI install is a support burden we measured and declined.
---
Applies to the local derived cache only; the canonical store stays plain
files per [[fact_staging-endpoints]] discussion.
```

#### 3.3.4 `lesson`

A behavior correction learned from experience — usually from a mistake. A
lesson is the format's most valuable and most structured type: it must say
*when it applies* (`trigger`) and *what to do differently*
(`how_to_apply`), or it is an anecdote, not a lesson.

Extra fields:

| Field | Requirement | Meaning |
|---|---|---|
| `trigger` | REQUIRED | The situation that should fire this lesson ("before deleting a directory", "when a test needs `$HOME`"). |
| `how_to_apply` | REQUIRED | The concrete behavior change. |
| `fired_count` | MAY | Integer ≥ 0. Times this lesson demonstrably fired and changed behavior. |
| `last_fired` | MAY | ISO 8601 date-time it last fired. |

`fired_count` / `last_fired` are the hook for the feedback loop (a later
phase of this spec's roadmap): once tools report firings, lessons acquire an
outcome record — which lessons actually prevent repeats, and which are dead
weight a consolidation pass can retire. Writers MAY maintain them; readers
MUST NOT require them.

The body SHOULD carry the evidence: what happened, what it cost, why the
rule is what it is. Established convention (predating this spec) renders
these as bold-label sections — `**Why:**` and `**How to apply:**` — in the
body; validators MUST accept `how_to_apply` expressed as a
`**How to apply:**` body section in legacy entries (Appendix A).

```markdown
---
type: lesson
name: Rehearse destructive migrations on a copy first
description: Never run a schema migration against the only copy of the data
trigger: About to run a migration that drops, renames, or rewrites columns
how_to_apply: Restore the latest backup to a scratch database and run the full migration train there first; only then touch the real one.
created: 2026-04-11
---
**Why:** A rename-and-backfill migration was run directly against the only
database; the backfill had an off-by-one and the pre-rename column was
already gone. Recovery took a day. A five-minute rehearsal on a restored
copy would have caught it.

**How to apply:** Restore latest backup → scratch DB → run the FULL
migration train → verify row counts → only then run for real.
```

#### 3.3.5 `goal`

What the work is currently *for* — the standing objective that orients
sessions. Goals are few (the reference implementation caps the live set at
3) and change rarely.

Extra fields: `set_on` (SHOULD, ISO 8601 — merge recency key), `done_at`
(MAY — temporal tombstone, same semantics as next_action, 4.3.2).

```markdown
---
type: goal
name: Ship v1 of the importer
description: End-to-end import from the three legacy formats, behind a flag
set_on: 2026-06-01
---
Done means: all three legacy formats round-trip in CI and the flag defaults
on for new installs.
```

#### 3.3.6 `next_action`

A concrete, resumable piece of work. Next actions are the handoff unit: the
thing a different machine or session picks up.

Extra fields:

| Field | Requirement | Meaning |
|---|---|---|
| `added` | REQUIRED | ISO 8601 date-time the action was added. The temporal-tombstone comparison (4.3.2) is against this field; without it, completion semantics are undefined. |
| `done_at` | MAY | ISO 8601 date-time it was completed. Presence marks the entry a temporal tombstone. |
| `machine_id` | MAY | Machine that added it. |

```markdown
---
type: next_action
name: Add retry with backoff to the sync client
description: Sync fails hard on transient 5xx; wrap in 3-try exponential backoff
added: 2026-06-12T09:30:00Z
---
Touch only `src/sync/client.js`. The failing case is a 503 mid-upload;
there is a repro in `test-fixtures/sync-503.json`.
```

### 3.4 Body conventions

- `[[wikilinks]]` reference other entries by link name (filename without
  `.md`). Readers SHOULD resolve them within the store; unresolvable links
  are not an error.
- Bold-label lines (`**Why:**`, `**How to apply:**`) are established body
  structure for lessons and MAY be used generally. They are convention, not
  syntax: readers MUST NOT require them (except as the legacy fallback in
  Appendix A).
- Entries SHOULD NOT contain secrets. That rule's enforcement (scanning,
  redaction) is an implementation concern, not a format concern.

## 4. Session state file

### 4.1 Shape

The session state file (`session.json`) is a single JSON document: the live
working set plus a bounded history. It is the "hot" half of the store —
small, rewritten atomically as a whole, merged structurally (never
line-by-line). This section describes exactly what the reference
implementation reads and writes; the machine-readable version is
[`schema/session.schema.json`](../schema/session.schema.json).

```json
{
  "version": 1,
  "created_at": "2026-04-18T08:22:36.703Z",
  "updated_at": "2026-08-06T21:10:03.001Z",
  "machines": {
    "<machine-uuid>": { "label": "work-laptop", "last_seen": "2026-08-06T21:10:03.001Z" }
  },
  "current": {
    "goals":           [ { "text": "...", "machine_id": "...", "set_on": "..." } ],
    "next_actions":    [ { "text": "...", "machine_id": "...", "added": "..." } ],
    "completed_actions": [ { "text": "...", "done_at": "..." } ],
    "open_questions":  [ { "text": "...", "machine_id": "...", "asked": "..." } ],
    "decisions":       [ { "text": "...", "why": "...", "rejected": "...",
                           "hidden": true, "hidden_at": "...",
                           "machine_id": "...", "date": "..." } ]
  },
  "history": [
    { "date": "...", "machine_id": "...", "summary": "...",
      "files_touched": ["..."], "duration_min": 42 }
  ]
}
```

Field notes:

- `version` — integer schema version of this file (section 6). Note the
  asymmetry with entry files' `schema_version`; both names are kept because
  both are deployed.
- `machines` — map of stable machine UUID → `{ label, last_seen }`. Machine
  identity is a UUID persisted per machine, paired with a human label
  (hostname) for display. Labels may change; UUIDs MUST NOT.
- `current.*` — every item carries `text` (the identity key, 4.2) and the
  list's date field (`set_on` / `added` / `asked` / `date`). `machine_id`
  SHOULD be stamped by writers.
- `completed_actions` — temporal tombstones for `next_actions` (4.3.2):
  `{ text, done_at }`. This list MAY be absent in files written before any
  completion occurred; readers MUST treat absence as empty.
- `open_questions` — captured questions awaiting an answer. (Draft note:
  there is deliberately no `question` *entry type* in v0.1 — questions have
  so far only proven useful in the live working set. If a portable form
  earns its keep, it becomes a seventh type in a later version.)
- `history` — bounded roll-up of past sessions, newest first, deduplicated
  by `(date, machine_id, summary)`.
- **Bounded lists.** The live lists are capped (reference implementation:
  goals 3, next_actions 8, open_questions 5, recent decisions 10, completed
  tombstones 50, history 30). Caps are implementation-chosen QUALITY
  parameters, not format constants — but *some* cap is normative: the
  working set must stay loadable-into-context small, with rotation
  oldest-by-date-out. In particular the completed-tombstone retention MUST
  be large enough to outlive any stale replica that might still carry the
  completed item, or completions resurrect (4.3.2).

Writers MUST write the file atomically (write temp file, rename) and MUST
serialize concurrent read-mutate-write cycles (e.g. a lock file). Locking
only the write is insufficient: two processes can both read the same stale
snapshot before either writes. The entire read → mutate → write cycle is the
critical section.

Readers encountering unparseable JSON MUST NOT discard the file silently:
quarantine the original (e.g. copy to a timestamped backup), then degrade to
a safe empty state.

## 5. Merge semantics (normative)

This section is the hard-won part of the format. Every rule here exists
because its absence produced a real data-loss or data-resurrection bug in
production. Implementations claiming Full conformance (section 8) MUST
implement this section exactly.

### 5.1 Identity

The identity of a session-list item is its **normalized text**: `text`,
whitespace-trimmed, case-folded. Two items with the same normalized text are
the same item. The identity of an entry file is its link name (filename).

### 5.2 Union, newest wins

Merging two replicas (local and remote) of a session list:

1. **Union by identity.** The merged list contains every distinct identity
   from both sides. A merge MUST NOT drop an item merely because the other
   side lacks it — "never clobber." The only way items leave is cap
   rotation (oldest by date field, off the end) and tombstoning.
2. **Newest wins per identity.** When both sides carry the same identity,
   the copy with the newer value in the list's date field (`set_on`,
   `added`, `asked`, `date`) wins wholesale. A missing or unparseable date
   compares as the epoch (loses to any real date).
3. `machines` merges per-UUID, keeping the entry with the newer `last_seen`.
4. `history` unions, deduplicates by `(date, machine_id, summary)`, sorts
   newest-first, and caps.
5. `created_at` takes the earlier of the two; `updated_at` the later.

Entry files merge by the same principle at file granularity: union of files;
same filename on both sides resolves by newest (`updated`, falling back to
`created`), or by the user's VCS if the store is under one. v0.1 does not
define intra-file three-way merge for entry bodies; that is what git is for.

### 5.3 Tombstones are sticky

Deletion under union-merge is the hard problem: plain removal does not
survive, because any replica still holding the removed item re-unions it
straight back on the next merge. A conforming implementation MUST therefore
represent removals as tombstones, and tombstones MUST be *sticky* — they
propagate through merges. There are two classes, and the difference between
them is deliberate.

#### 5.3.1 Absolute tombstones (`hidden`) — decisions

Setting `hidden: true` (with `hidden_at`) on a decision suppresses it
permanently: hidden decisions are excluded from rendering and lookup but
retained in the data so the tombstone keeps propagating.

**Stickiness rule:** hidden is monotonic. If *any* copy of an identity on
*either* side of a merge carries `hidden: true`, the merged copy carries
`hidden: true` (and that copy's `hidden_at`) — **regardless of the date
comparison in 5.2**. The winner-by-date inherits the tombstone from the
loser if it lacks one.

The date-independence is not an optimization; it is the correctness
condition. Tombstoning legitimately does not touch the item's `date` (the
tombstoned copy may well *lose* the newest-wins comparison), and a replica
that has not yet pulled the tombstone holds an older un-hidden copy that
would otherwise win or re-union. If hiding were just another field on
whichever copy has the newer date, every un-synced replica would resurrect
the item on its next merge, and the same junk would need re-hiding on every
machine forever. Suppression must be monotonic or it is not suppression.

#### 5.3.2 Temporal tombstones (`done_at`) — next actions

Completing a next action removes it from `next_actions` AND records
`{ text, done_at }` in `completed_actions`. Removal alone is insufficient
for exactly the resurrection reason above — any stale replica (another
machine, a backup, a long-lived process's in-memory copy) re-unions the
finished item on merge.

**Merge rule.** After the 5.2 union:

1. Union `completed_actions` from both sides by identity, keeping the
   newest `done_at` per identity, capped (newest-first).
2. Filter the merged `next_actions`: an action is suppressed if a tombstone
   with its identity exists **and** the action's `added` is not later than
   the tombstone's `done_at`.

Unlike `hidden`, this tombstone is *temporal on purpose*: a copy whose
`added` postdates `done_at` is not a stale straggler — it is a deliberate
re-add of the same text after completion, and it MUST survive. "Fix the
flaky test" can legitimately be finished and later added again. Decisions
get absolute tombstones because a suppressed decision text is junk forever;
actions get temporal ones because finished work can recur. Implementations
MUST NOT substitute one class for the other.

The same `done_at`-vs-`added`/`set_on` comparison applies to `goal` and
`next_action` *entry files* that carry `done_at`.

### 5.4 Merge invariants (summary)

For any replicas A and B:

- **No silent loss:** every identity in A ∪ B is in merge(A, B), as a live
  item or a tombstone-suppressed one (up to cap rotation).
- **Convergence:** merge is commutative and idempotent up to ordering —
  merge(A, B) and merge(B, A) render identically, and merging a replica
  with itself is a no-op.
- **Monotone suppression:** once hidden everywhere-merged, hidden in every
  future merge; a completed action stays completed against every copy whose
  `added` predates its `done_at`.

## 6. Versioning

- Entry frontmatter MAY carry `schema_version` (integer; absent = 1). The
  session file MUST carry `version` (integer). Both are governed by the
  same rules below.
- This spec is v0.1 and describes data schema version **1**.
- **Backward:** implementations MUST migrate older versions forward through
  a per-version ladder (a pure step from N to N+1 for each N), filling
  defaults for missing fields. Migration MUST NOT throw on malformed input;
  the worst case is a fresh empty state, with the original quarantined.
- **Forward (normative — quarantine and degrade, never guess):** an
  implementation encountering a version **newer** than it understands MUST
  NOT attempt to interpret the data. It MUST preserve the original
  (quarantine — e.g. a timestamped backup copy), MUST degrade to safe
  behavior (an empty-but-valid state, or read-only), and SHOULD tell the
  user once to upgrade. A newer schema's fields may have semantics —
  tombstones especially — that an old reader would destroy by "mostly
  understanding" them. Merging is the dangerous path: a degraded read MUST
  contribute nothing to a merge rather than contribute a misreading.
- Unknown *fields* at a known version are the extension mechanism and are
  NOT a version violation: readers ignore, writers preserve (3.2).

## 7. What this spec does not cover

Deliberately out of scope — these are implementations' business, and
competing on them is the point of an open format:

- **Sync transport.** Git, object storage, a vendor cloud, a USB stick.
  The format defines what a correct merge produces, not how bytes move.
- **Encryption at rest and in transit.** Stores are plain text; protecting
  them (client-side encryption before upload, disk encryption) is an
  implementation/deployment concern.
- **Cloud services.** Accounts, auth, storage tiers, sharing links.
- **Capture quality.** What is *worth* remembering, secret scanning,
  consolidation/deduplication passes, relevance ranking, embeddings.
- **Rendering.** How entries and the working set are surfaced into an
  assistant's context (pinned blocks, system prompts, retrieval) is a
  competitive surface, not a format rule.

## 8. Conformance levels

Three levels, cumulative.

- **memoir Reader.** Can parse and render a store: frontmatter + body of
  every entry type, and the session file. MUST ignore unknown fields, MUST
  tolerate unknown entry types (render as opaque), MUST honor tombstone
  visibility (never display `hidden` decisions or completed actions as
  live), and MUST apply the forward-version rule (6) on read.
- **memoir Writer.** Reader, plus can add and edit entries without
  corrupting the store: atomic session writes with a locked
  read-mutate-write cycle, preserves unknown fields on rewrite, stamps
  identity and date fields (`added`, `set_on`, `date`, `machine_id`), and
  never rewrites entries it was not asked to touch.
- **memoir Full.** Writer, plus implements section 5 exactly: union-by-text
  with newest-wins, both tombstone classes with their stickiness rules, and
  the merge invariants of 5.4.

A conformance claim names its level: "memoir Reader (v0.1)".

## 9. Security and privacy considerations

A memoir store aggregates exactly the information an attacker would want:
project internals, decision history, environment facts. Implementations
SHOULD scan for and warn about secrets before any entry leaves the machine,
and MUST NOT transmit store contents anywhere without explicit user
configuration. The format's plain-text nature is a privacy *feature* — the
user can always audit precisely what their AI knows — and implementations
should preserve that auditability rather than obscure it.

---

## Appendix A: Legacy dialects (informative)

The format formalizes a convention that grew in the wild, and existing
stores predate it. A survey of one long-lived production store (326 entry
files, April–August 2026) found:

- **Two frontmatter dialects.** About half the files carry `type` as a
  top-level key; the other half nest it as `metadata.type` (often with
  `metadata.node_type: memory`). `originSessionId` likewise appears both
  top-level and nested.
- **Bare files.** ~6% have no frontmatter at all — plain markdown with an
  `# H1` title.
- **Legacy type vocabulary.** Deployed values are `user`, `feedback`,
  `project`, `reference` — not the six types of this spec.
- **Body-borne lesson fields.** Legacy `feedback` entries carry the trigger
  in `description` and the application rule as a `**How to apply:**` body
  section, not as frontmatter keys.

Conforming Readers SHOULD apply these compatibility rules when reading
pre-v0.1 stores, and validators SHOULD downgrade the corresponding errors to
warnings for legacy-dialect files:

| Legacy | Read as |
|---|---|
| `metadata.type: X` | `type: X` |
| top-level `originSessionId` / `metadata.originSessionId` | `origin.session_id` |
| `type: user` | `preference` |
| `type: feedback` | `lesson` (trigger ← `description`; how_to_apply ← `**How to apply:**` body section) |
| `type: reference` | `fact` |
| `type: project` | no atomic mapping — a project *dossier* aggregates many would-be entries in one file; read as an opaque legacy entry |
| no frontmatter | opaque legacy entry; `name` ← first `# H1` |

Writers MUST NOT emit legacy dialects for new entries. Rewriting legacy
files into canonical form is an implementation choice (a consolidation
pass), not an obligation — a Reader must handle both indefinitely.

## Appendix B: Relationship to the reference implementation (informative)

memoir-cli (npm) implements: session state exactly as section 4 at
`~/.config/memoir/session.json` (schema version 1); the merge semantics of
section 5 in its cross-machine sync (`mergeSessions`); the forward-version
quarantine of section 6 (`.pre-migration-<ts>` backups, degrade to empty);
and `memoir validate`, a structural checker for both file kinds against this
spec. Entry-file writing currently passes agent-authored markdown through
verbatim — validation, not generation, is where the convention is enforced.

## Appendix C: Changes

- **v0.1 (2026-08-06)** — first public draft. Extracted from memoir-cli
  3.10.x behavior. Seeking implementations and critique:
  https://github.com/camgitt/memoir/issues
