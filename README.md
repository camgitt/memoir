# Memoir

Portable, project-scoped memory and session handoffs for coding agents.

Memoir keeps decisions, rationale, goals, and next actions in readable local files. An MCP server lets an agent save and retrieve that context. Optional local, Git, and cloud backups move it between machines.

This branch contains the changes described in [the remediation record](docs/AUDIT-REMEDIATION.md). Older npm installations do not receive them until a release is published.

## Start in a project

Node.js 18 or later is required.

```sh
npm install -g memoir-cli
cd /path/to/project
memoir setup --tool claude,codex,cursor
memoir goal "Finish the account recovery flow"
memoir note "Use single-use recovery codes" --why "Prevent replay"
memoir next "Test expired recovery codes"
memoir recall "recovery codes"
memoir resume
```

`setup` preserves existing settings, writes a project MCP entry, and starts the Memoir server to check its tools. Restart the client and accept its project trust/MCP prompt. Server startup does not prove that a particular client version has accepted its configuration.

For source development, use `npm ci`, then `node bin/memoir.js setup`. The generated entry uses absolute Node/server paths; review it after moving the installation. Existing different Memoir entries are preserved for review.

`memoir activate` adds managed usage instructions and sets up detected supported clients. `memoir resume --inject --to codex` adds a managed handoff to the project's `AGENTS.md`, preserving other content.

## Memory and continuity

- `memoir_note` records a scoped decision and rationale. Older decisions are archived when the working summary fills.
- `memoir_remember` writes a canonical Markdown record. Open its returned ID with `memoir_read`, `tool: "memoir"`, `filepath: "<id>.md"`.
- `memoir_recall` searches the active project plus shared records and returns matching passages, paths, line evidence, and IDs where available.
- Recall reuses an incremental lexical index while checking source changes and scope on each query. New project instructions are discovered without a timed cache delay. See [retrieval behavior and benchmarks](docs/RETRIEVAL-INDEX.md).
- `memoir_resume` returns the goal, next actions, questions, and decisions, and compares the saved commit with the checkout. Old observations never imply current tests pass.
- `memoir_forget` accepts a decision match or canonical ID. Hidden records are excluded from recall/session views; `purge: true` also removes current canonical text and local revision history.

Canonical memory lives in `~/.config/memoir/memories/` and session state in `~/.config/memoir/session.json`. These source files are plaintext on the device. Backup encryption does not encrypt them.

New memories use `MEMOIR_PROJECT_ROOT` or the working directory. Use explicit `scope: "shared"` for general preferences. Git identity recognizes common SSH/HTTPS remote spellings; local identity is home-relative. Renames, unusual remote aliases, or different directory layouts may need explicit scope selection. Profiles select backup destinations; they are not independent security tenants.

Legacy records without scope metadata are shared, except recognized Claude project directories. Review and label imported history before relying on strict isolation. Scope is an organizational boundary, not authentication against an agent already permitted to read the filesystem.

## Backup and recovery

First use creates a **local** configuration. It does not create a GitHub repository or upload automatically. Use `memoir init` to choose another destination and encryption.

```sh
memoir push
memoir restore
memoir push --only claude,codex
memoir restore --only codex
```

Filtered pushes preserve other tool/machine files. Session and canonical records accompany tool filters for cross-tool continuity.

For encrypted local/Git backups, supply `MEMOIR_PASSPHRASE` through your environment/password manager or enter it interactively. Legacy six-character secrets remain readable; use a long, unique secret for new backups. Headless writes do not silently choose plaintext when encryption is unconfigured.

Snapshots authenticate the manifest and every file. Missing blobs, corrupt contents, unsafe paths, symlinks, and oversized input fail recovery. Repeated encrypted pushes verify and merge the previous snapshot before replacement. Local encryption migration removes plaintext from the current destination after the switch; Git history and filesystem snapshots can retain older plaintext.

Local pushes lock the complete read/merge/write operation. Git rejects conflicting remote updates without force-pushing; retry to read and merge the new state. Use a dedicated backup directory.

### Cloud

New cloud writes require a user-held secret of at least 12 characters in `MEMOIR_CLOUD_PASSPHRASE` (or `MEMOIR_PASSPHRASE`). It is not derived from account identity or sent in metadata.

```sh
memoir cloud push
memoir cloud restore
memoir cloud restore --version 3
memoir cloud migrate
memoir cloud migrate --apply
```

The writer requires the database migration in [the rollout guide](docs/RELIABILITY-ROLLOUT.md). Without it, version allocation fails before upload. This source change has not deployed that migration.

`cloud migrate` displays a plan. `--apply` downloads each old backup, creates a user-passphrase replacement, downloads and byte-checks it, then removes the old object. Interrupted migration can reuse its replacement. Keep the secret available on every recovering device; there is no lost-passphrase recovery service.

Legacy account-ID-keyed and unencrypted cloud backups remain readable with warnings. Their protection changes only when replaced. Random vault-key wrapping, device enrollment, hardware-backed storage, and independently reviewed key rotation remain future work.

Latest cloud restore merges session/canonical state from retained versions, requiring additional downloads. Explicit version restore selects that snapshot. Cloud tests simulate the backend; production authorization and tenant isolation require separate validation.

### Optional workspace files

`memoir push --workspace` captures eligible files from the active project, including non-ignored untracked Git files. It does not archive the whole home directory.

`memoir restore --workspace` verifies those files into a new folder under `~/memoir-restored/` for inspection. Existing checkouts are not patched. Commit information is recorded; this is a file snapshot, not a Git-history backup.

Common secret filenames and detected patterns are omitted and listed in the manifest. Detection is heuristic. Old tar-based workspace archives are retained but no longer extracted automatically.

## Supported surfaces

| Surface | Capability | Verification boundary |
|---|---|---|
| Claude Code | Project MCP setup, Memoir tools, instruction import/export | JSON preservation and real server startup tested |
| Codex | Project TOML MCP setup, Memoir tools, AGENTS.md import/export | TOML round trip and server startup tested |
| Cursor | Project MCP setup, Memoir tools, rule import/export | JSON preservation and server startup tested |
| Other existing adapters | Selected memory/config import/export | Adapter fixtures, not full native session continuity |
| Generic MCP client | Memoir tool contract | Real stdio tests |

Configuration references: [Claude Code](https://code.claude.com/docs/en/mcp), [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Cursor](https://prod.cursor.com/help/customization/mcp).

## Search, privacy, and limits

Search is local Unicode-aware lexical retrieval with field/document-frequency weights, aliases, filtering, and a passage budget. It is not semantic search and has no demonstrated state-of-the-art result.

Memory is context, not permission to run commands or configure tools. Model-written records default to `unverified`. Automatic transcript capture is best effort and must not be treated as proof of successful work.

`memoir consolidate` reports duplicates/stale files. Similarity alone cannot remove distinct content. Confirmed removals keep recovery copies; the printed `memoir consolidate --undo <id>` restores into an absent destination. `--smart` explicitly sends bounded excerpts to the Gemini API; choose its model with `MEMOIR_CONSOLIDATE_MODEL`.

`push --redact` heuristically redacts staged text, not originals or historical backups. Without it, ordinary memory backups warn and preserve content. Set `DO_NOT_TRACK=1` to disable remote telemetry. Local events distinguish execution failure from success; they do not measure answer usefulness.

Forgetting propagates on later sync between updated clients. Old clients, snapshots, and Git history can still contain deleted text. Purging every historical copy is separate. Native configuration restore is not atomic across multiple application directories.

## Development

```sh
npm ci
npm test
node evals/run.mjs
npm audit --omit=dev
npm pack --ignore-scripts
```

Tests use synthetic homes and local Git remotes. CI declares macOS/Linux/Windows with Node 18/20/22; shell suites skip Windows. See [remediation status](docs/AUDIT-REMEDIATION.md) and [release gates](docs/RELIABILITY-ROLLOUT.md) for verification limits.

[MIT license](LICENSE)
