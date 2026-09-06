# Local debugging follow-up — 2026-09-06

The user asked Codex to debug the implementation itself. This pass reproduced
failure cases locally, fixed the shipped handlers/setup code, and verified the
changes without modifying real client settings, committing, pushing or deploying.

## Reproduced problems and fixes

| Problem | Reproduction and resulting behavior |
|---|---|
| A delayed refresh replaced a successful correction with old data | A deterministic transport returned responses out of order. Refresh responses now lose authority when a newer read, edit or mutation starts |
| A slow save closed a different draft and reported it saved | Reproduced in the actual browser with an eight-second server delay: cancel the first editor, open a second draft, then receive the first response. The second editor closed with a false success message. Save controls now prevent that transition and completion stays tied to its original editor |
| A retry could duplicate a newly saved record after its reply was lost | Each submit previously generated a new ID. The open draft now retains one ID, so a committed retry conflicts with its first save and can be reviewed. Actual browser/server testing dropped the response after the write, retried, and found exactly one saved record |
| Cancelling a version comparison left the main view stale | Latest context was read but not rendered. Closing now displays the latest accepted snapshot. Delayed comparison responses also cannot affect a different editor |
| Adding memory before context loaded threw an error | Add stays disabled until the first context load; the handler also guards absent context |
| Restricted browser storage prevented the page loading | The launch capability remains usable in page memory if session storage is unavailable. It is still removed from the visible URL and expires with the server process |
| Setup overwrote malformed, falsey configuration values | Synthetic null/false/zero/empty-string maps and existing entries were rewritten before the fix. Both Codex and Cursor invalid maps/entries now stop setup before planned settings or instruction writes |
| Duplicate closing instruction markers were accepted | Setup now refuses the ambiguous block and preserves its original contents |

Requests now have a 15-second client wait limit. Timeout or connection failure
keeps the draft and explicitly says that the change may already be saved. It
never claims that stopping the wait rolled back the server write. The editor
unlocks for recovery. Drafts do not survive closing/reloading the tab.

## Validation

The first six recovery cases all failed against the original shipped event
handlers. After the fixes and four additional race/recovery probes,
`test-work-view-ui.mjs` passes **10 scenarios**. This dependency-free harness
executes the shipped script and its event handlers with a deterministic DOM and
transport. It is not a substitute for a full browser engine.

Actual browser testing used an isolated synthetic project and the real local
HTTP server, with a test-only wrapper delaying or dropping responses. It
confirmed the original slow-save failure, the fixed pending-editor behavior,
correct success text, recovery after a lost acknowledgement, no duplicated
record after retry, and fresh main-page context after closing comparison.
No synthetic questions, answers or access capabilities entered the user's
project ledger.

**24 full suites passed: zero failures and zero skips.** This includes the
10 recovery scenarios, 14 view request-security/correction groups, 17 handoff
integration groups and now 21 adversarial scenarios. One adversarial scenario
continues to demonstrate valid local receipt forgery as an explicitly disclosed
limitation. Passing these tests is not proof of comprehensive security.

The saved view/recovery, handoff, adversarial and guide checks were refreshed
because `src/work/ui/app.js`, `src/work/ui/index.html`, `src/work/setup.js`,
regression tests and guide wording changed. Their receipts list their actual
inputs; unrelated checks do not become stale solely because this report changes.
The full-suite log remains ordinary local evidence, not a forged Memoir receipt.

Local evidence files are under ignored `.memoir/`: `debug-ui-check.json`,
`debug-view-check.json`, `debug-security-check.json`, `debug-handoff-check.json`
and `debug-full-suites.log`. The installed-package check also passed, including shipped view assets and
authenticated access; its output is in `debug-packed.log`.

## Limits

This fixes the reproduced recovery and preservation problems. Existing limits
remain: project records are plaintext; secret scanning is heuristic; receipts
and source labels are unauthenticated; hostile same-user processes are outside
the local view's isolation boundary; agents must save and read project context.
This debugging task reused the original delivery/privacy answers without asking
again. It supplies one ordinary development-task observation, not a measured
comparison of daily time savings.
