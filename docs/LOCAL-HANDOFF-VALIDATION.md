# Local handoff validation — 2026-09-06

The Codex → Cursor → Codex workflow completed in this Memoir checkout on this
Mac. Both continuations used the saved answers and reused the saved integration
check. This exercise was performed before publication; the counts below describe that local candidate.

This report records the original functional exercise. A subsequent
[adversarial audit](HANDOFF-SECURITY-AUDIT.md) found and fixed security gaps.
In the hardened version, check execution is available through the CLI under
normal terminal permissions; the MCP check tool deliberately refuses commands.
Memory reads also omit Git dirty-status checks to avoid executing repository
hooks. Later receipts supersede the original receipts described below.

For everyday use, open the **same folder and branch** in either tool and say
**“Continue this project.”** Run one-time setup in the project you want to continue. See
[the usage guide](PROJECT-HANDOFF.md) for the full reference.

## What was tested in actual clients

| Step | Observed result | Evidence |
|---|---|---|
| Codex, first session | Saved the goal, two user answers, an output-privacy decision, a real integration receipt and Cursor's next task | Ledger revisions 1–6; local Codex event log |
| Cursor desktop, local environment | Resumed without receiving the task description again, wrote the requested guide, marked its task done and left a review for Codex | Cursor conversation “Memoir project continuation”; ledger revisions 7–8; guide file |
| Codex, fresh return session | Found Cursor's completed task, reviewed and corrected the guide, preserved answers and marked the review done | Ledger revision 13; local Codex return event log/result |
| Cursor MCP connection | Initially disabled; enabling only this project's Memoir source connected four tools. A follow-up direct `memoir_work_resume` call returned both answers and the matching check | Cursor Customize → MCPs and the conversation's tool result |

Codex ran using the app-bundled **CLI 0.153.4**, with the existing configured
model, in two fresh sessions. Cursor was the installed **desktop app 3.17.19**,
using **This Mac**, this checkout and `fix/audit-reliability`. This was not a
separate fresh Codex desktop-chat test. The older standalone Codex CLI 0.146.0
could not run the configured model; it was left unchanged.

Codex loaded the project MCP configuration, but its test sessions' `never`
approval policy refused MCP calls. Both sessions successfully used the generated
CLI fallback. No approval policy or model setting was relaxed. Cursor's initial
work also used the fallback before its new project connection was enabled.
Successful server setup alone is not treated as proof of client acceptance.

## Did it reduce repeated work?

- Both continuations reused the original delivery and privacy answers; their
  record revisions remained 2 and 3. No repeated answered question was observed.
- The integration check was executed **once during the three-leg round trip**.
  Cursor and returning Codex both reused its revision-5 receipt because its
  declared files and runtime still matched.
- Cursor obtained its task from the handoff, and Codex obtained the review from
  Cursor's update. Neither continuation prompt copied those task descriptions
  or the earlier conversation.
- Returning Codex added a separate documentation check. Its first attempt
  mishandled Git's no-index exit status; the corrected check passed. Memoir
  retained the failed receipt and the later pass. This was additional work on
  a new check, not a rerun of the saved integration check.

This demonstrates continuity in one useful local exercise. It is not a timed
comparison against working without Memoir, a guarantee of fewer questions in
every task, or evidence that agents will always follow the instructions.

## Changed conditions and rechecks

After the round trip, the setup message was clarified and the integration
fixture was strengthened to actually exercise paths containing spaces and
quotes. A fresh resume correctly changed the integration result to
`needs-recheck` and named:

```text
Changed input: src/work/setup.js
Changed input: test-work-handoff.mjs
```

The documentation check also became stale because it included the setup source.
The guide then gained the final usage and removal instructions. Targeted reruns
passed: integration receipt **14**, documentation receipt **15**. Both now show
matching declared inputs. The warning cleared because the checks ran against
the new files; no completion flag was manually substituted for a check.

Relevant file changes, missing files, changed local Node runtime, newly added
dependency manifests, failed executions and changes during a run trigger
specific recheck reasons. Unrelated documentation edits do not invalidate the
integration result. External observations always need current verification:
for example, a prior Stripe dashboard check does not prove today's settings.
Only the declared inputs are covered, so agents must include all relevant files.

## Implementation and verification

- Separate project ledger and MCP server; no global personal-memory or transcript
  import. Records include source, rationale, branch, revisions and next-action
  completion. Corrections reject stale revisions; retractions retain history.
- Checks execute an argument array and retain exit status, timestamps, input
  fingerprints and an output digest. Raw terminal output is discarded.
- Setup preserves unrelated project settings and backs up changed existing
  files. Existing conflicting Memoir connections are preserved with a warning.
  No unrelated global configuration was edited. Only the new project source
  was enabled in Cursor's UI.
- **21 test suites passed**, including the project handoff suite. The final
  focused run passed **17 groups**, including privacy canaries, actual process
  execution, stale-input detection, concurrency, settings preservation, real
  MCP restarts and fallback paths containing spaces and quotes.
- The **installed-package smoke test passed** with the new project CLI, setup,
  check receipt and MCP resume, alongside the existing backup/restore tests.
- The guide's examples, command help and whitespace were checked; its semantic
  content was also reviewed against the implementation. A passing syntax check
  alone does not establish that a guide is correct.

## What remains manual or limited

- Choose the same local checkout and branch, then ask the next agent to continue.
  The ledger is ignored by Git: GitHub pushes, another worktree or another
  computer do not carry it. The older Memoir backup commands do not sync this
  new ledger.
- A client can require project trust or MCP approval. Cursor's connection is
  enabled here; Codex can use the fallback under its existing policy.
- Agents must save important decisions and use Memoir's check command/tool.
  Ordinary shell checks and unsaved conversation are not captured by a hook.
- Personal-scope records and recognized secrets are rejected, and raw output is
  not retained. Detection is heuristic. Project files and backups are plaintext
  locally; connected AI clients receive the project context used for the task.
  This is not an isolation barrier against a process with filesystem access.
- External app settings can change independently. Evidence is scoped and
  attributable, but local receipts and source labels are not cryptographic
  authentication against a process allowed to edit the ledger.

## Local evidence locations

The ignored `.memoir/` directory contains `work.json`, the refreshed
`HANDOFF.md`, both Codex event logs and results, `after-input-change.json`, and
the final integration/documentation receipts. Exact setup backups are under
`.memoir/setup-backups/`. Full-suite and package-test logs are beside this
checkout in `../memoir-handoff-full-tests.log` and
`../memoir-handoff-packed-test.log`. These local logs are not published.
