# Local handoff hardening — September 6, 2026

This change targets the single-user CLI/MCP workflow and its loopback browser
companion. It does not turn the companion into a public multi-user service.
Publication is subject to the release workflow; registry availability and CI
results must be checked against the actual release rather than this document.

## What changed

- Automatic bounded recovery snapshots protect every acknowledged project save.
  Existing version-1 ledgers are checkpointed on the updated resume path.
- `work doctor`, `work backup` and `work recover` expose health, encrypted export
  and preview-bound recovery. Current bytes are preserved before replacement.
- A recovery generation prevents stale CLI/MCP/browser sessions and in-flight
  checks from overwriting a restored handoff. Normal revision guards remain.
- Publication now depends on the entire reusable CI workflow. Node 24 is added
  to the Node 18/20/22 matrix across Linux, macOS and Windows. Node 22/24 are the
  maintained LTS targets for production; older versions are compatibility tests.

## Observed local evidence

| Exercise | Result |
| --- | --- |
| Full local suite | 25 suites passed on macOS/Node 26.7.0; subsequent focused checks cover the added crash and browser-generation cases |
| Recovery regression | 15 groups cover acknowledged snapshots, old-ledger upgrade, damaged/missing ledgers, exact preview conflicts, stale writers, concurrent recovery/check execution, all-branch encrypted round trips, malformed/secret-bearing imports, symlinks, failed writes, process crash, retention, CLI errors and Windows delete-pending retries |
| Browser harness | 31 scenarios pass, including retaining an open draft's old generation until the recovered record is explicitly reviewed |
| Existing regressions | 17 handoff groups, 21 adversarial scenarios and 14 browser API/security groups pass |
| Installed tarball | CLI, project MCP, local view, encrypted export, damaged-ledger recovery, unchanged client settings and post-recovery MCP continuation passed in a synthetic home |
| Dependency advisory audit | No known production-dependency advisories were returned at test time |

The actual Cursor desktop connection was reloaded using its existing **Reload**
control. Direct `memoir_work_resume` returned the current delivery and privacy
answers and identified `src/work/store.js` as changed. Cursor saved
`decision.cursor-production-resume` at revision 119 through MCP and read it back.
Returning Codex read that record. No fallback, repeated question, check rerun or
source edit was requested from Cursor in that bounded exercise.

In an actual in-app browser, a synthetic project answer was opened for editing.
The project was recovered while that draft stayed open. Saving was refused;
the draft remained intact. **Review latest version → Keep my draft and continue
→ Save correction** saved the deliberate correction. A separate CLI reader
recovered that answer at revision 2, and `doctor` reported a valid current copy.
The temporary project and browser were removed after validation.

A separate local drill restored a snapshot of the real project ledger at
revision 120 into a temporary folder after deliberately damaging only that
copy. All 64 record-history entries, 54 check receipts and two retractions
matched the source. The real ledger remained unchanged. No real project data
was uploaded, and no encrypted export passphrase was created for the user.

## What these results establish

The new failure handling was exercised in source tests, an installed artifact,
the actual browser, Cursor MCP and a real-data copy. Local protection is
enabled for this checkout, and the original app settings remain in place.
The release pipeline must separately establish cross-platform results and
validate the published npm artifact.

These tests are not an independent security certification, a power-cut test of
every filesystem, or proof of productivity gains over multiple days. Receipts
remain local and unauthenticated; project text is untrusted. Local snapshots
and quarantine are plaintext, and secret screening is heuristic. Losing the
entire folder/disk needs a separately stored export. See the
[recovery guide](PROJECT-RECOVERY.md) for downgrade restrictions, capacity,
retention, filesystem boundaries and the remaining manual lock-repair case.

The first expanded CI run caught a Windows/Node 18 delete-pending race on
`work.lock`. Path inspection and exclusive lock acquisition now retry transient
Windows access failures without skipping validation or entering without a lock.
A deterministic denial/concurrency regression accompanies the fix. Manual
publication also requires a version tag matching the package.
