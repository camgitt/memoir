# Memoir

Portable, project-scoped memory and session handoffs for coding agents.

Memoir keeps decisions, rationale, goals, and next actions in readable local files. An MCP server lets an agent save and retrieve that context. Optional local, Git, and cloud backups move it between machines.

The reliability changes are described in [the remediation record](docs/AUDIT-REMEDIATION.md). Review the [upgrade and recovery guide](docs/RELIABILITY-ROLLOUT.md) before upgrading clients that share encrypted backups.

## Continue between Codex and Cursor on this computer

Memoir includes a separate, project-only handoff. It carries answered questions,
decisions, next actions and receipts from checks actually run through Memoir. It
does not import personal memory or transcripts.

The project handoff, browser view and recovery commands below require version 3.16.0 or later:

```sh
npm install -g memoir-cli@3.16.0
cd /path/to/your/project
memoir work setup
memoir work resume
memoir work view
```

For source development, install dependencies and replace `memoir` with
`node bin/memoir.js` from the Memoir checkout.

Open **this same folder and branch** in Codex or Cursor and say **“Continue this
project.”** The managed instructions use the project MCP connection, or the
included CLI fallback when the connection is unavailable. Existing settings and
approval policies are preserved. Agent adherence is still required; ordinary
terminal checks are not captured automatically.

The **project view** opens in your browser on this computer. Search saved
answers, see why a check needs repeating, correct a decision, or remove it from
the next handoff. Removed records can be restored; earlier versions stay in local
history. Keep the view's terminal open while using it, and press Ctrl+C to stop.
You can also ask your agent **“Open my Memoir project view.”** See the
[local view validation](docs/PROJECT-VIEW-VALIDATION.md) for actual browser tests
and the limits of the fresh-session continuity results. Subsequent
[debugging fixes and recovery tests](docs/PROJECT-VIEW-DEBUG.md) cover slow saves,
interrupted responses and configuration preservation.

Checks run through `memoir work check` using the client's normal terminal
permissions. The MCP memory connection deliberately cannot execute commands.
See the [adversarial audit and remaining trust limits](docs/HANDOFF-SECURITY-AUDIT.md).

The project ledger stays in ignored `.memoir/` files. This workflow does not
sync those files through GitHub or bridge different checkouts. See the
[setup and everyday guide](docs/PROJECT-HANDOFF.md) for commands, corrections,
privacy boundaries and when a check needs to run again. The feature runs locally even when installed from npm; publishing the package
does not upload your project ledger.

Project handoffs now have automatic local recovery snapshots. Run `memoir work
doctor` to check them, or `memoir work backup --output /path/to/backup.memoir`
for an encrypted copy outside the project. Recovery previews changes before
applying them and preserves the original file. See [backup and recovery](docs/PROJECT-RECOVERY.md).

## Existing memory and backup workflow

Node.js 18 or later can run the CLI. For production use, choose a maintained LTS release (Node 22 or 24); Node 18/20 remain compatibility-test targets. See the [Node release policy](https://nodejs.org/en/about/previous-releases).

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

The writer requires the database migration in [the rollout guide](docs/RELIABILITY-ROLLOUT.md). Without it, version allocation fails before upload. The Memoir hosted service received this migration on September 6, 2026; see the [deployment checks](docs/RELEASE-3.14-VALIDATION.md). Self-hosted services must apply it before enabling new writes.

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

Tests use synthetic homes and local Git remotes. CI declares macOS/Linux/Windows with Node 18/20/22/24; shell suites skip Windows. See [remediation status](docs/AUDIT-REMEDIATION.md) and [release gates](docs/RELIABILITY-ROLLOUT.md) for verification limits.

[MIT license](LICENSE)
