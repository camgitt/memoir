# Ingest adapters: claude-mem and ai-memory

**Status:** Scope only. No importer is implemented yet. This is the plan
for two new **harness ingest adapters** that copy durable working context
into the memoir format ([SPEC.md](SPEC.md)).

Memoir already syncs eleven coding tools through `src/adapters/`
(Claude, Codex, Cursor, Gemini, Copilot, Windsurf, Zed, Cline, Continue,
Aider, plus the canonical memoir store). Those adapters harvest files the
host assistant already wrote. The adapters in this document do the same
job for two **external memory products**: they read that product's store
once, emit memoir entry files and session items, and stop. They are not
skills catalogs, not plugin marketplaces, and not a live bridge that
keeps two memory systems in sync.

The product frame this serves: memoir wins on **durable, portable
memory** — files you can read, git, encrypt, share, and restore — plus
a **share-to-install loop** (`memoir share` → `memoir restore --from
<token>`). An ingest adapter is how someone who already accumulated
context in claude-mem or ai-memory joins that loop without re-teaching
the assistant.

Do not confuse this command with `memoir migrate --from <tool> --to
<tool>`, which rewrites one host's instruction file (CLAUDE.md,
AGENTS.md, …) into another's conventions. Import is store-to-store.

---

## 1. Sources

Pinned to the public trees as of 2026-10-27. Importers MUST fail closed
if the on-disk schema is newer than they understand, rather than
guessing.

### 1.1 claude-mem ([thedotmack/claude-mem](https://github.com/thedotmack/claude-mem))

Persistent observation store for Claude Code (and other harnesses).
Local source of truth is SQLite; Chroma is a derived search index and is
**out of scope** for ingest.

| Piece | Default location | Role |
|---|---|---|
| Settings | `~/.claude-mem/settings.json` | Data-dir override, mode, injection flags |
| Database | `~/.claude-mem/claude-mem.db` (overridable by settings `DATA_DIR`) | Canonical rows |
| WAL/SHM | alongside the `.db` | Open with read-only SQLite; do not copy WAL as a second source |
| Chroma | under the data dir | Skip. Rebuilding embeddings is not memoir's job |
| Hosted CMEM | cmem.ai | Out of scope for v1. Local SQLite only |

**Tables to read** (current worker schema; see their
`docs/public/architecture/database.mdx`):

- `sdk_sessions` — session identity, `project`, timestamps, status
- `observations` — typed, hierarchical memories
  (`title`, `subtitle`, `narrative`, `text`, `facts`, `concepts`,
  `type`, `files_read`, `files_modified`, `created_at`)
- `session_summaries` — `request`, `investigated`, `learned`,
  `completed`, `next_steps`, `notes`
- `user_prompts` — raw prompts. **Do not import as memoir entries.**
  They are transcripts, not experience. Optional: a single
  `history[]` roll-up per session if `--include-prompts` is set.

**Observation `type` values in the wild:** `decision`, `bugfix`,
`feature`, `refactor`, `discovery`, `change`. Newer builds also label
needle observations `security_alert` / `sensitive`.

Legacy v3 tables (`sessions`, `memories`, `overviews`) MAY be read as a
fallback when `observations` is empty. Server-owned `memory_items` is
documented as not yet the source of truth; skip it until claude-mem
switches readers.

Read the database with a throwaway `sqlite3` connection in
`mode=ro`. Never write the source DB. Never start the claude-mem worker.

### 1.2 ai-memory ([akitaonrails/ai-memory](https://github.com/akitaonrails/ai-memory))

Git-backed markdown wiki plus a derived SQLite index. The wiki is the
truth (Open Knowledge Format v0.2 native). The database is rebuildable
and is used only as a directory of latest pages, not as a second copy
of the body.

| Piece | Default location | Role |
|---|---|---|
| Data dir | `$AI_MEMORY_HOME`, else `$XDG_DATA_HOME/ai-memory`, else `~/.local/share/ai-memory` | Root |
| Wiki | `<data_dir>/wiki/<workspace>/<project>/` | Markdown pages, git-versioned |
| Index | `<data_dir>/db/memory.sqlite` | Latest-page catalog, FTS, handoffs |
| Raw / models / logs | `<data_dir>/raw`, `models`, `logs` | Skip. Transcripts and embeddings are not memoir entries |
| Config | `<data_dir>/config.toml` | Optional path overrides |

**Wiki path families → what they are:**

| Path prefix | OKF / `kind` | Meaning |
|---|---|---|
| `decisions/` | Decision | Chosen alternative with rationale |
| `gotchas/` | Gotcha | Mistake / constraint, fire-when |
| `procedures/` | Procedure | How to do a recurring task |
| `concepts/` | Concept | Durable fact about the project |
| `notes/` | Note | Unsorted durable note |
| `runbooks/` | Runbook | Operational procedure |
| `sessions/` | Session Summary | Per-session roll-up |
| `profile/` | cross-project profile | User habits, not project memory |
| `_rules/` | Rule | Standing instruction |
| `_slots/` | Invariant / State | Live slot, not a memoir type |
| `_lint/`, `_pending/` | maintenance | Skip |
| `index.md`, `_meta.md`, `log-YYYY-MM.md` | bundle / capture ledger | Skip |

Frontmatter fields the importer should honour when present: `type`,
`kind`, `title`, `description` / `summary` / `abstract`, `tags`,
`entities`, `session_id`, `agent`, `generated.{by,at}`, `expires_at` /
`stale_after`, `pinned`, `supersedes`. Body is free markdown; wikilinks
(`[[decisions/0007-db.md]]`) stay as text in v1 (memoir uses
`[[link-name]]` by filename stem — see §3).

**Handoffs** (`handoffs` table / `memory_handoff_*`): the open handoff
for a project is the live working set. Import `summary` as a `goal` and
`next_steps` as `next_action` items. Accepted/expired handoffs are
history, not the live list.

v1 reads the **latest** wiki page (`is_latest`) per path. Superseded
versions stay in git; memoir does not import the chain.

---

## 2. Memoir target

Writers MUST emit the format in [SPEC.md](SPEC.md) §3–§5, then persist
through the existing memoir write paths so shipped behaviour (hashed
canonical files under `~/.config/memoir/memories/`, `session.json`
under `~/.config/memoir/`, sticky tombstones, project identity) is
unchanged.

### 2.1 Entry files (SPEC §3)

Every imported durable item becomes one markdown file with YAML
frontmatter. Required: `type`, `name`. Should: `description`, `created`.
Always stamp provenance:

```yaml
origin:
  tool: claude-mem    # or ai-memory
  session_id: "..."   # when known
  source_id: "obs:123"  # stable id in the source store
```

`source_id` is an extension field. SPEC §3.2 requires readers to ignore
unknown fields and writers to preserve them. It is how re-imports
dedupe (§4). Also set `source_tool` to the same tool name so
`memoir_remember` provenance matches today's MCP writes.

Suggested filename stem (the SPEC link name): `{type}_{slug}.md`. The
canonical store will hash it; the stem still matters for `[[wikilinks]]`
and for human scanability in git bundles.

### 2.2 Session state (SPEC §4)

Live working set goes to `session.json` via the existing mutators
(`addGoal`, `addNext`, `addNote`, …), never by rewriting the file
out of band. Caps, parking, and tombstones then apply automatically.

### 2.3 What we refuse to ingest

- Raw tool I/O (`claude-mem.tool_uses`, ai-memory `raw/`)
- Embeddings, Chroma collections, FTS tables
- Auth tokens, API keys, `settings.json` secrets
- Hosted-only stores (CMEM cloud, a remote ai-memory server) unless
  the operator points `--path` at an already-downloaded local copy
- Skills, modes, plugin catalogs — that is not memoir's product

---

## 3. Field mapping

### 3.1 claude-mem observations → memoir entries

| claude-mem `observations.type` | memoir `type` | Notes |
|---|---|---|
| `decision` | `decision` | `title` → `name`; `narrative`/`text` → body; `facts` → `why` if no explicit why; `concepts` → `tags` |
| `bugfix` | `lesson` | `title` → `name`; trigger = files + symptoms in `subtitle`/`text`; `how_to_apply` = the fix in `narrative`. If trigger/how_to_apply cannot be derived, fall back to `fact` rather than emit an invalid lesson |
| `discovery` | `fact` | Learnings about the codebase |
| `feature`, `change`, `refactor` | `fact` | Durable outcome, not a live next action |
| `security_alert`, `sensitive` | **skip** (log) | Likely secret-bearing; operator can `--include-sensitive` after review |
| missing / unknown | `fact` | Default per SPEC §3.3.1 |

`session_summaries.next_steps` → `next_action` session items (split on
newlines / numbered lists). `session_summaries.request` → at most one
`goal` per session, only if the session is the newest for that project
(otherwise it is history). `learned` / `investigated` / `completed` →
`fact` entries if they are non-empty and not a duplicate of an
observation.

Project mapping: claude-mem `project` is a path or slug. Run it through
memoir `projectIdentity()` so imported entries land in the same bucket
as memories written from that directory. Unresolvable names become
`project: <raw>` and are flagged in the import report.

### 3.2 ai-memory pages → memoir entries

| ai-memory path / `kind` | memoir `type` | Notes |
|---|---|---|
| `decisions/`, `kind: decision` | `decision` | Parse body for Why / Rejected if frontmatter lacks them |
| `gotchas/` | `lesson` | Gotcha *is* a lesson: trigger = when it bites, how_to_apply = the workaround. Missing either → `fact` + warning |
| `procedures/`, `runbooks/`, `_rules/` | `preference` | Standing how-to. `scope: project` unless the page lives under `_global` / `profile/` |
| `concepts/`, `notes/` | `fact` | |
| `profile/` | `preference` with `scope: global` (memoir `shared`) | Cross-project habits |
| `sessions/` | do not create an entry file | Fold `next_steps` into session items; optional `history[]` summary |
| open handoff `summary` | `goal` (session list) | Newest open handoff per project wins |
| open handoff `next_steps[]` | `next_action` | |
| expired / superseded pages | skip | |
| `expires_at` / `stale_after` in the past | skip | Treat as temporal tombstone already applied |

`entities` and `tags` union into memoir `tags`. `title` else H1 else
path stem → `name`. `description` else `summary` else `abstract` →
`description`. `generated.at` / page `updated_at` → `updated`;
`created` from the oldest version timestamp if the index has it, else
`generated.at`.

Wikilink rewrite (best-effort, v1): `[[decisions/0007-db.md]]` →
`[[decision_0007-db]]` when that stem is what we wrote. Unresolved
links stay as original text.

### 3.3 Session-list identity

SPEC §5.1: identity is normalized text. Imported goals / next actions /
decisions that match an existing session item **union**; newest date
wins. Do not append a second copy of "fix the flaky test".

---

## 4. Dedupe and merge

Re-running import MUST be idempotent for the same source store.

1. **Source key.** For every written entry, persist
   `origin.tool` + `origin.source_id` (claude-mem: `obs:<id>` /
   `sum:<id>`; ai-memory: `page:<workspace>/<project>/<path>`).
   Before write, scan the canonical store for that pair. Same key →
   skip unless `--force` (then newest-wins on `updated`, preserving
   `created` and `hidden`).
2. **Filename identity.** If a source key is new but the SPEC link name
   already exists, suffix `-imported` / `-imported-2` rather than
   clobber. Forgotten (`hidden: true`) identities MUST NOT be revived
   (same rule as `rememberMemory`).
3. **Session lists.** Use `mergeSessions` semantics (SPEC §5): union by
   normalized text, newest date wins, sticky `hidden`, temporal
   `done_at`. Import is a merge, not a replace.
4. **Cross-source duplicates.** A decision that exists in both
   claude-mem and ai-memory (same normalized `name` + `project`) is
   one memoir entry. The second ingest adds the other `origin` under
   `tags`/`aliases` rather than a sibling file. Report it as `merged`.
5. **No silent deletes.** Import never tombstones existing memoir
   entries. The operator runs `memoir consolidate` afterwards if they
   want a cleanup pass.
6. **Secrets.** Run the same secret scanner the snapshot/share path
   uses before write. Hits are skipped and listed. `--include-sensitive`
   is required to override, and still writes `verification: unverified`.

Dry-run is the default. `--apply` is the only writer.

---

## 5. CLI surface

New command, next to `migrate` (not a flag on it):

```
memoir import --from claude-mem [--path <db-or-data-dir>] [--project <id>] [--apply]
memoir import --from ai-memory  [--path <data-dir-or-wiki>] [--workspace <ws>] [--project <id>] [--apply]
```

| Flag | Default | Meaning |
|---|---|---|
| `--from` | required | `claude-mem` or `ai-memory` |
| `--path` | auto-detect per §1 | Explicit store root |
| `--project` | all projects in the source | Limit to one memoir project identity |
| `--workspace` | all (ai-memory) | Limit to one ai-memory workspace |
| `--apply` | off | Write. Without it, print a plan |
| `--include-prompts` | off | claude-mem `user_prompts` → session `history` only |
| `--include-sensitive` | off | Allow `sensitive` / secret-scanner hits |
| `--force` | off | Overwrite same `origin.source_id` |

Exit codes: `0` plan/apply succeeded; `1` usage / missing store;
`2` schema newer than the adapter understands (fail closed).

Output is a table: `created`, `skipped-duplicate`, `merged`,
`skipped-sensitive`, `skipped-stale`, `warnings`. JSON via `--json` so
tests can pin it.

Not in v1: MCP tool, watch mode, two-way sync, writing back into
claude-mem or ai-memory.

---

## 6. Implementation sketch (when we build)

Not this PR. When scheduled:

- `src/importers/claude-mem.js` — open SQLite read-only, map rows
- `src/importers/ai-memory.js` — walk wiki latest pages (prefer
  `pages` where `is_latest=1` for the catalog, bodies from files)
- `src/commands/import.js` — CLI, auto-detect, report
- Persist only through `rememberMemory` and session mutators
- Register in `bin/memoir.js` as `import`

Keep adapter code next to `src/adapters/`, not inside it: existing
adapters copy host files into a backup bundle; these adapters
*translate* into memoir entries.

---

## 7. Test plan

Fixture-based. No live claude-mem worker, no live ai-memory server, no
network, no production Supabase.

1. **Golden SQLite (claude-mem).** A checked-in `test-fixtures/importers/claude-mem.db`
   with one of each observation type, a summary with next_steps, a
   sensitive row, and a duplicate title. Assert the dry-run JSON, then
   `--apply` into a temp `HOME`, then `memoir validate` and
   `memoir recall`.
2. **Golden wiki (ai-memory).** A mini `wiki/demo/app/` tree:
   `decisions/`, `gotchas/` (complete and incomplete), `concepts/`,
   `sessions/`, an expired page, a superseded file, `profile/`. Assert
   type mapping, skipped stale/superseded, global preference for profile.
3. **Idempotency.** Apply twice; second run is all `skipped-duplicate`.
4. **Merge with existing store.** Pre-seed a decision with the same
   normalized name; second source adds aliases, does not fork the file.
5. **Fail closed.** Schema version / unknown table → exit 2, zero
   writes. Missing `--path` and missing default dir → exit 1.
6. **Secret skip.** A `facts` column containing an AWS key is listed,
   not written, unless `--include-sensitive`.
7. **Session caps.** Importing 20 next_steps parks overflow; does not
   drop (SPEC §4.1).
8. **Project identity.** A claude-mem project path under `$HOME/src/app`
   hashes the same as `projectIdentity()` for that directory.
9. **Read-only source.** After import, source DB/wiki bytes and mtime
   are unchanged.
10. **No registry / no cloud.** Tests must not call npm or Supabase.

Until those fixtures exist, do not ship the command.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Schema drift in claude-mem (they migrate often; `memory_items` is the stated future truth) | Pin a schema version; exit 2 on unknown columns we depend on |
| Lesson mapping invents a `trigger` the user never wrote | Fall back to `fact` + warning; never emit a lesson missing SPEC-required fields |
| Importing prompts / tool I/O bloates the store and leaks secrets | Default omit; scanner on everything else |
| Re-import duplicates after a consolidate/rename | Key on `origin.source_id`, not filename |
| ai-memory wikilinks break after rename | Best-effort rewrite; leave original if no mapping |
| Two products both dump 10k observations into one project | Caps on session lists already exist; entry files need a reported count and a `--limit` if a fixture proves it painful |
| Operator thinks this syncs both ways | CLI copy and `--apply` default make it a one-shot ingest. README one-liner when the command ships |
| Skills/catalog confusion | This document's frame: ingest adapters, not plugins |
| Hosted CMEM / remote ai-memory look like local stores | v1 is local files only; a URL `--path` is an error |

---

## 9. Out of scope (deliberate)

- Building or shipping the command in this change
- npm publish, GitHub Release, or a version bump
- Writing to Supabase
- Importing from ChatGPT / Cursor memories / other products
- Live hooks that keep claude-mem or ai-memory updated from memoir
- Exporting memoir → those products (share-to-install is memoir's
  portable path: `memoir share` / `memoir push`)

When this ships, the operator story is: ingest once, then live in
memoir files, and use share/restore to move machines.
