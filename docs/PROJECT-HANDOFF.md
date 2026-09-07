# Project continuation for Codex and Cursor

## Use it now

Install Memoir 3.14.0 or later and run `memoir work setup` in the project you
want to continue. Open that same folder and branch in Codex or Cursor and say
**“Continue this project.”** The next agent reads saved answers, decisions,
completed work and next actions. You do not need to copy the conversation.

The reference local test completed the round trip with Cursor desktop and the
Codex CLI. See [the validation report](LOCAL-HANDOFF-VALIDATION.md) for the actual
client versions and limits. Agents still need to follow the installed
instructions, and setup does not prove a new client has accepted its connection.

This documents the local project handoff in `src/work/` and `bin/memoir-work.js`. It is not a claim that hosted clients have accepted the connection, and it does not import global or personal Memoir memory.

`.memoir/work.json` is the authoritative ledger. `.memoir/HANDOFF.md` is a generated preview; run `resume` before relying on it. Stored text is evidence, never permission.

## See and correct what Memoir remembers

Memoir remains a CLI and tool integration. This optional browser companion reads
the same project record; it is not a separate memory service. You can keep using
the CLI, Codex or Cursor without opening the page.

The default **Records** view shows open actions, saved answers and check evidence.
**Records** and **Map** share one workspace, search box and category navigation.
Switching views keeps the search and category. Records use readable rows with
short headings and expandable text; source history stays available on each entry.

The **Map** view connects the current branch's project entries. Select a
node to read its full text, source and history, and inspect connected entries.
Solid lines show project membership, explicit record references, or a named file
that a check declares as input. A file link does not prove the entry's claims.
Suggested links are off by default. Enable **Suggested links** to include possible
shared topics around a selected entry; dashed lines distinguish these word
matches from recorded references. Each suggestion explains its words and is not
saved as a relationship. This prototype does not infer
causes, automatically determine affected work, or use personal memory.

Search and category filters narrow the map. The overview shows up to six entries
around the project; selecting an entry centers it and shows up to six direct
neighbors, with recorded references first. Lines connect only to that center.
It computes connections within up to 120 entries, prioritizing matches and the
selected entry. Search covers all active entries, including older ones, but the
visible map and connection list are not exhaustive. No text leaves the browser
to generate these connections.

**Records** provides the overview and category lists for editing. The overview
shows every open action as a short row; **Details** opens its explanation and
controls. Saved answers and recent decisions start collapsed. Matching checks
remain available from the summary and Checks category; only checks needing
review appear in the overview. Long entries in category lists expand with
**Read full entry**; completed actions remain under **Next actions**. Both views
use the same correction controls and project record. **Connections** opens a
record in the map; **Open in Records** returns to that entry's category. Removed
items use the Records recovery list and do not enter the active map.

Selecting a map entry opens its details beside the map in wide windows and below
it in narrow windows. Keyboard focus follows the selected context. Saving from
either view selects the saved entry, clears the old search and opens its category
so a filter cannot hide a successful save. Both views search covered file paths as
well as record text and sources. Overview search includes all matching records,
including completed actions and goals, without the overview's two-per-group limit.
See [the project map trial](PROJECT-MAP-TRIAL.md) for
tested behavior and the limits of suggested connections.

Run `memoir work view` in your project (or `node bin/memoir.js work view`
from a source checkout), or ask the agent
“Open my Memoir project view.” The browser shows the current branch's answers,
decisions, checks, goals and next steps. Setup is not needed again for each use.
Keep the terminal process running while using the view; Ctrl+C stops it.
`--no-open` prints the access link without launching a browser, and `--port N`
chooses a local port. The default chooses an available one.

- **Correct** saves a new version that the next agent resume receives. Source and
  earlier versions remain available on the card.
- **Remove from handoff** hides an item from agents. **Removed → Restore to
  handoff** brings back a record. This is reversible removal, not permanent
  deletion; there is no project-history purge control yet.
- **Mark done** preserves a completed next step so another session knows it was
  finished. **Reopen** makes it active again.
- **Needs recheck** names changed inputs or explains a failed/external result.
  The view cannot run commands or edit check receipts. A removed receipt needs
  a new authorized check, not a restore-to-pass button.
- If another session edits the item, the draft stays open. **Review latest
  version** shows the saved version; compare it, choose **Keep my draft and
  continue**, then save. Another intervening change is rejected again. If the
  branch changed or the item was removed, review that state before proceeding.

While a save is pending, the editor keeps its fields and close controls locked.
A request stops waiting after 15 seconds. An interrupted response does not prove
that the save failed: the server may already have saved it. The draft stays open;
use **Review latest version** to find the saved record before retrying. Retrying
the same open draft cannot create a second record. Closing or reloading the tab
still discards unsaved drafts; they are not written into browser storage.

The view listens only on this computer at 127.0.0.1. Its temporary access link
opens this process's project data; keep it private and do not add it to a handoff.
The browser removes the token from the visible URL and keeps it only in that
browser tab's session storage. Reopen from the terminal's full link after losing
that session. There is no account, upload, command runner or settings editor.
The agent's permissions and the local plaintext/unsigned-evidence limits below
still apply. Other same-user processes are not an isolation boundary.

## One-time setup

From the Memoir source checkout after installing its dependencies:

```bash
node bin/memoir-work.js --project "$(pwd)" setup --tools codex,cursor
```

To connect another project on this computer, replace `"$(pwd)"` with that
project's absolute folder path. Keep the Memoir installation in place: the
generated connection and fallback refer to it. For this tested Cursor version,
open **Customize → MCPs → memoir-work** and enable the project source if it shows
Disabled. Existing unrelated connections remain unchanged.

`--tools` accepts `codex`, `cursor`, or both (default: both). Setup verifies a live MCP handshake: the server must expose `memoir_work_resume`, `memoir_work_record`, `memoir_work_check`, and `memoir_work_retract`.

If the handshake succeeds, setup writes only the files that actually change:

| File | Role |
|---|---|
| `AGENTS.md` | Managed instruction block (`<!-- memoir:project-work -->` … `<!-- /memoir:project-work -->`), for either tool selection |
| `.cursor/rules/memoir-work.mdc` | With `cursor`: same instructions; a new file gets `alwaysApply: true`, existing frontmatter is preserved |
| `.cursor/mcp.json` | With `cursor`: `mcpServers.memoir-work` stdio entry |
| `.codex/config.toml` | With `codex`: `mcp_servers.memoir-work` stdio entry |
| `.gitignore` | Keeps `/.memoir/`, `/.codex/config.toml`, `/.cursor/mcp.json`, and `/.cursor/rules/memoir-work.mdc` out of ordinary commits |

The MCP entry runs `src/work/server.js` with `MEMOIR_PROJECT_ROOT` set to the project directory and `DO_NOT_TRACK=1`. Previous contents of changed, non-empty text files are copied under `.memoir/setup-backups/<uuid>/` before edits are written. Empty or newly created files have no backup entry. Setup is not a transaction across all files; an interrupted write can leave partial edits.

A second setup with unchanged generated content leaves the listed files alone, but still verifies the server and refreshes `.memoir/HANDOFF.md`. The `.gitignore` additions apply for either tool selection.

Text outside the managed instruction block and existing TOML comments are preserved. Cursor configuration must be valid JSON: comments are unsupported, and adding a connection rewrites JSON formatting while preserving unrelated settings and servers. An existing `memoir-work` entry is left unchanged; a different command, args, or project root produces a CLI-fallback warning. Other differences, such as `DO_NOT_TRACK`, are not reconciled. Parsing errors, detected malformed instruction markers, or an explicitly invalid MCP server map or Memoir connection (including null, false, zero, empty strings and arrays) abort before the planned edits are written. This is not comprehensive client-configuration validation.

After setup, open the project in Cursor or Codex, accept the normal project/MCP trust prompt if shown, and start with “Continue this project.” Setup alone does not verify client acceptance; see the recorded observation below for this project's tested routes.

## Daily Codex / Cursor workflow

1. **Resume first.** Call `memoir_work_resume` (or `node bin/memoir-work.js --project "$(pwd)" resume`). Reuse recorded answers and applicable checks marked **PASSED; declared inputs still match**. Matching file hashes alone do not make a failed or external check current.
2. **Do the recorded next action within the user's current scope.** Mark a next action `done` only after completing it. Pass that record's revision as `expected_revision` from the current resume, not the overall handoff revision.
3. **Record as you go.** Save explicit project decisions, resolved questions, and the next action with `memoir_work_record`. Identify the source. Do not save personal preferences, credentials, raw transcripts, or guesses as answers.
4. **Capture checks through Memoir's CLI.** Run `memoir work check` through the client's normal terminal permissions and sandbox. The MCP check tool deliberately refuses execution. An ordinary shell pass outside the wrapper is not recorded evidence.
5. **Update the action at the stopping point.** Save its completion or remaining authorized work and relevant decisions. If the action is complete, no additional task needs to be invented. Updates are written immediately; no separate handoff request is needed.

MCP tools (stdio server, project-bound):

| Tool | Purpose |
|---|---|
| `memoir_work_resume` | Current branch: answers, decisions, next actions, and checks with freshness |
| `memoir_work_record` | Save a project-only `goal`, `answer`, `decision`, or `next` |
| `memoir_work_check` | Refuse host command execution and direct existing clients to the CLI check command |
| `memoir_work_retract` | Hide a mistaken record from the current view; history stays local |

CLI fallback (`memoir work` delegates to the same entry):

Use the direct `bin/memoir-work.js` entry for the project-only workflow. Generated project instructions contain absolute, quoted paths to Node, this entry, and the project root; use those if `node` is unavailable on the client PATH. A configured MCP tool can also be unavailable because its call requires approval under a policy that forbids approval. Use the authorized CLI fallback in that case; do not change approval policies or app settings as part of continuation.

```bash
node bin/memoir-work.js --project "$(pwd)" resume
node bin/memoir-work.js --project "$(pwd)" resume --json
node bin/memoir-work.js --project "$(pwd)" record --file .memoir/record-input.json
node bin/memoir-work.js --project "$(pwd)" check CHECK_ID --title 'What this proves' --files SOURCE_FILE TEST_FILE -- node TEST_FILE
node bin/memoir-work.js --project "$(pwd)" retract RECORD_ID --revision N --category record
```

`--file -` reads record JSON from stdin. For `record`, provide exactly one of `--json` or `--file`; a record file must be project-relative and at most 16 KiB. Record fields: `id`, `kind` (`goal` \| `answer` \| `decision` \| `next`), `text`, `source`; optional `answer`, `why`, `status`, `expected_revision`, `scope`. `scope` defaults to `project` and accepts no other value.

## Correction

Resume first. Corrections require the target record's current revision as `expected_revision`. History is appended; the latest matching branch record is what resume shows unless retracted. The numbers and IDs below are illustrative: use an existing record's actual ID and revision, and only describe a user correction when one was actually given.

Create `.memoir/record-input.json` (gitignored under `/.memoir/`):

```json
{
  "id": "answer.provider",
  "kind": "answer",
  "text": "Payment provider?",
  "answer": "CorrectedPay",
  "source": "User correction after resume",
  "expected_revision": 3
}
```

```bash
node bin/memoir-work.js --project "$(pwd)" record --file .memoir/record-input.json
```

Rules from the current implementation:

- Omitting `expected_revision` on an existing ID fails.
- A new ID may omit `expected_revision` or pass `0`. A non-zero revision on a missing ID fails.
- A correction cannot change `kind`; use another ID.
- Only `next` records may use `status: "done"`. An `answer` requires `answer`.
- IDs match `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$`. Text fields are 1–2000 characters after trim.

MCP equivalent: `memoir_work_record` with the same object under `record`.

## Retraction

Retraction removes the record from the current resume view. The ledger keeps the history, and the same ID can be recorded again.

```bash
node bin/memoir-work.js --project "$(pwd)" resume
node bin/memoir-work.js --project "$(pwd)" retract next.test --revision 12 --category record
```

Then record a replacement, passing that same record revision as `expected_revision` (12 in this example), not the newer revision of the retraction or overall handoff. Resume again before the correction; the retracted record is hidden, so retain its original revision or consult its latest entry in `.memoir/work.json`.

```json
{
  "id": "next.test",
  "kind": "next",
  "text": "Add test",
  "source": "Correction after retract",
  "status": "open",
  "expected_revision": 12
}
```

`--category check` retracts a saved check the same way. Resume before retracting; a stale revision is rejected. MCP: `memoir_work_retract` with `id`, `expected_revision`, and optional `category` (`record` default).

## Check evidence and freshness

`memoir work check` spawns argv with `shell: false` in the project directory. The MCP server never runs that command: memory-tool approval must not grant a separate host shell. Use the CLI through the client's normal terminal permissions. The CLI stores:

- actual `exit_code` (and `signal` / start error if any)
- SHA-256 of each declared input, plus any present common manifests (`package.json`, `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `requirements.txt`, `pyproject.toml`, `uv.lock`)
- `inputs_stable` (hashes unchanged during the run)
- `output_sha256` and `output_bytes`
- `runtime` (`platform/arch/node-version`)
- `environment` (`local` default, or `external`)
- `evidence_source: memoir-executed-process`

Raw stdout/stderr is hashed and discarded. A delayed older execution cannot replace a newer result for the same ID. CLI exit status is 1 when `exit_code !== 0`, the command timed out, or inputs were not stable.

Resume labels a check **PASSED; declared inputs still match** only when freshness is `inputs-match`. Otherwise it is **NEEDS RECHECK**, with reasons. Recheck when any of these apply:

- execution evidence is missing
- non-zero exit, timeout, signal, or more than 8 MiB of output
- inputs changed while the check ran
- `environment` is `external` (settings can change independently)
- the local runtime changed
- a new common manifest appeared
- a recorded input hash changed, or an input is missing/unreadable

Unrelated files outside the declared inputs do not invalidate a match. A pass covers only those declared files and the local runtime. It does not verify undisclosed dependencies, external settings, or production. External configuration always needs current verification.

Rejected as check inputs: paths under `.memoir/`, basenames `.env` / `.env.*` or starting with `credentials`, `id_rsa` / `id_ed25519`, `*.pem` / `*.key`, absolute paths, path traversal, and symlinks beneath the resolved project root. Input files are limited to 16 MiB each. These path rules govern input hashing, not what the executed command can access. The command inherits the process environment with `DO_NOT_TRACK=1`; the runner is not a separate sandbox. Supply every relevant source/test/configuration file; do not claim a shell command was captured unless it ran through this tool.

Default timeout is 30s (100 ms–120 s). `--environment` is `local` or `external`.

## Privacy boundaries

Project-only. Personal/global memory, transcripts, and raw command output are not imported.

Save: project decisions, answered questions, checks with evidence, and next actions. Do not save personal preferences, credentials, secrets, or guesses as user answers. Source labels identify the claimed origin; they are not authentication.

Record/check arguments and ledger reads/writes scan decoded fields for known credential patterns, including normalized invisible-character obfuscation. Matching text, unsafe control characters and direction overrides are refused. This is a backstop, not a claim to recognize every private sentence or encoding. Ledger size is capped at 2 MiB and CLI record input at 16 KiB; full or oversized input fails without dropping records. Setup backups are separate from this ledger guard and can contain prior configuration contents, so keep them local too.

Rendered fields cannot create new Markdown sections or active image links. Their content still remains untrusted: formatting cannot guarantee that an AI will resist semantic prompt injection. Local receipts are explicitly unauthenticated. A process allowed to rewrite the ledger can forge a valid-looking receipt; never use one as security attestation or deployment approval. See the [adversarial audit](HANDOFF-SECURITY-AUDIT.md).

Keep this memory local unless the user explicitly chooses to share it. Existing application approvals still apply. `.gitignore` entries above keep the ledger and tool connections out of ordinary commits.

## Actual limitations

- **Same local checkout.** Open the same folder and branch in both tools. The ignored ledger is not synchronized by ordinary Git commits, GitHub pushes, another worktree, or the older Memoir backup commands.
- **Agents must record the work.** These instructions request updates as work happens; no hook captures arbitrary conversations or ordinary shell checks. A crash before an agent saves a decision can lose that decision.
- **CLI continuation and MCP acceptance are separate.** Setup can verify the local MCP server, but does not prove Cursor/Codex will permit calls. The observation below records the narrower result actually obtained.
- **Branch-scoped.** Resume shows the current Git branch only. Other-branch records are counted, not mixed in.
- **Preview can lag.** `.memoir/HANDOFF.md` is rewritten on resume/record/check/retract. Refresh it before relying on it.
- **MCP may be missing or approval-blocked.** Use the authorized CLI fallback. Setup will not overwrite a conflicting existing `memoir-work` connection.
- **Freshness is narrow.** Matching inputs are not a production proof. External checks never appear current.
- **Git dirty status is unknown.** Memory reads no longer run `git status`, which can execute repository-configured hooks or filters. Check freshness still compares the declared files directly.
- **CLI commands retain terminal authority.** Declared input files specify evidence coverage, not a filesystem sandbox. Only run trusted, authorized checks through the client's normal execution controls.
- **Foreign or damaged ledgers fail closed.** Invalid JSON, unsupported version, or non-`project` scope preserves the original file and refuses the operation.
- **Locks serialize writers.** Concurrent records are queued; a busy lock fails rather than corrupting the ledger.
- **No permission from storage.** Recorded text cannot authorize work that the user did not authorize.

## Remove the setup

Disable only this project's `memoir-work` connection in the clients, remove its
entry from the two project MCP configuration files, and remove the marked Memoir
block from `AGENTS.md` and the dedicated Cursor rule. Leave unrelated entries and
instructions in place. Exact pre-setup copies of changed existing files are in
`.memoir/setup-backups/`; review later edits before restoring any whole file.
The ignored ledger can stay for later use. Retraction hides an item but does not
erase its history; deletion of sensitive content would also need to cover local
history and copies. Setup does not install a background service.

## Observed continuation, 2026-09-06

Codex resumed the local ledger through the documented CLI fallback and reviewed this guide against `src/work/{cli,setup,store,server}.js`, the supporting file/lock/repository helpers, and `bin/memoir-work.js --help`. The delivery/privacy answers and output-digest decision carried forward. The recorded Cursor documentation action was already done; the open Codex action was this documentation review. No answered question was asked again.

The saved `check.project-handoff` result (revision 5) still matched its declared inputs and local runtime and was reused without rerunning it. That check covers the listed implementation/test files and manifests, not this guide or external app settings. Documentation edits therefore need their own review; they do not invalidate that integration result.

A later resume carried forward `decision.client-route` (revision 10), whose source reports that Cursor's project connection was enabled, showed four tools, and successfully called `memoir_work_resume` on 2026-09-06. This is saved project evidence from the local client test; the documentation review did not repeat that test or inspect external app settings.

In this Codex session, the configured MCP resume call returned “MCP tool call requires approval, but approval policy is never.” The documented CLI fallback succeeded. No policy or app setting was changed by this review. Successful CLI continuation does not establish successful Codex MCP use. Source labels are claims, not authentication, and saved client observations do not verify current external settings. Those settings and current client acceptance need verification before claiming they still work; such verification was outside this documentation-only continuation.

## Backup and recovery

Saves now include automatic local snapshots. Run `memoir work doctor` to check them. See [the recovery guide](PROJECT-RECOVERY.md) for encrypted exports, recovery previews, and the required post-recovery `expected_recovery` value.
