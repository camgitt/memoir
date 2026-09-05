# Audit remediation and remaining roadmap

Audit base: `037e7be7afbee85dde53a1a512125510417b8bd7` (source 3.13.3). This document describes the review branch. It does not mark the original multi-week roadmap complete.

## Findings and evidence

| Audit | Implemented in this branch | Remaining boundary |
|---|---|---|
| A01 Cloud key ownership | New user-passphrase format; legacy read warnings; plan/apply migration with download verification | Hosted rollout, independent protocol review, random vault keys/device enrollment |
| A02 File access | Portable path validation, adapter allowlists, no-follow reads, atomic safe writes in MCP/store | Concurrent hostile parent-directory swaps need further OS-level review |
| A03 Unsafe/incomplete restore | Validate manifests/paths/duplicates/size; require every blob; stage complete file sets | Native multi-root writes are not one transaction |
| A04 Repeated encrypted push | Authenticate prior snapshot, merge session/canonical records, preserve untouched files | Ten successive local encrypted cycles tested; hosted Git transport is CI/manual scope |
| A05 Partial sync/collisions | Additive plaintext Git updates; project identity suffix/manifest; consistent main-branch reads | Rename/remote aliases and legacy ambiguous mapping need review |
| A06 Forgetting | Consistent visibility; uncapped tombstones; canonical purge wins over stale history | Old clients and historical remote copies remain outside the guarantee |
| A07 Storage caps | Durable decision/goal/question archives and uncapped parked/completed/history data | No general operation journal/compaction protocol yet |
| A08 Encryption defaults | Local first-use configuration; headless encryption choice must be explicit; local migration replaces plaintext | Old Git/provider history can retain plaintext |
| A09 Locking | Never run unlocked on timeout; preserve living owner; lock full local backup cycle | Crash recovery of reaper locks; Git conflict retry is user-triggered |
| A10 Scope | Canonical project/shared metadata; filter before retrieval; neutral global instructions | Unlabelled legacy files shared; profiles are not isolated stores |
| A11 Save/recall | Canonical cross-tool store, direct session retrieval, ID-based expansion | Other clients' native memory is still import/export, not complete native continuity |
| A12 Setup | Claude/Codex/Cursor project config, preservation, real MCP server handshake | Real client trust/installation acceptance not automated here |
| A13 Retrieval | Unicode/CJK, IDF weights, lifecycle filtering, source lines, passage budget, evaluation fixture | No FTS/semantic index, held-out comparative benchmark, or SOTA claim |
| A14 Capture/consolidation | Scoped capture, unverified records, local consolidation archive/undo, bounded model request | Outcome-backed lessons and measured capture precision remain |
| A15 Workspace | Explicit selected-project file snapshot; secret omissions; hashes; separate recovery directory; disable old tar extraction | Omitted files/Git history require separate backup; detection is heuristic |
| A16 Release | Reviewable source candidate and installed-artifact smoke workflow | npm trusted publisher, version selection, publication, registry smoke |
| A17 Dependencies/tests | Dependency refresh, zero audit advisories at verification, adversarial suite, expanded CI matrix | Hosted matrix results must be checked before release |
| A18 Error/telemetry/cloud | Argument-array Git calls, propagated failures, success-labelled events, atomic version SQL | Production tenant policies, conditional cloud commit/retention races, task-outcome telemetry |

## Local evidence

Local verification passed 19/19 suites and the installed-tarball smoke workflow. The audit integration suite contains 26 groups and covers portable paths, symlinks, incomplete encryption, ciphertext swaps, cloud traversal, user-held cloud keys, locks, durable history/deletion, MCP boundaries, cross-tool recall, project isolation, Unicode, collision-safe exports, partial Git updates, repeated encryption, Git main/master selection and removal of plaintext from the current encrypted tree, purge versus stale history, client configuration, resume drift, verified migration, workspace recovery, and consolidation undo.

Development retrieval fixture: 14 synthetic records, 16 cases. Recall@5 and reciprocal rank were 1.0 on the 10 positive cases; all 6 abstention cases returned no results; no forbidden results. The unscoped substring control scored 0.8 recall@5 and leaked 6 forbidden results. This fixture was created after implementation. It is **not held out**, a comparison with the previous released engine, a competitor evaluation, or evidence of SOTA.

Observed MCP performance on macOS arm64 / Node 26.7.0, eight queries per corpus (first cold, seven warm), tiny synthetic adapter records:

| Files | Cold ms | Warm median ms | Warm max ms |
|---:|---:|---:|---:|
| 100 | 35.7 | 8.5 | 10.4 |
| 1,000 | 235.3 | 58.0 | 74.6 |
| 10,000 | 1,882.5 | 566.0 | 578.1 |

Batching independent checks reduced the initial safety-patch warm median at 10,000 files from 1,479.7 ms to 566.0 ms. Every file still undergoes boundary validation. This remains slower than the old unsafe path and misses the roadmap's 250 ms target at 10,000 records. The measured fixtures were adapted to valid project scope, so the old/new numbers are directional rather than a fully controlled benchmark.

## Next gates, in order

1. Review and merge this containment/continuity candidate only after final local and hosted CI evidence.
2. Validate real client acceptance and hosted cloud migration/tenant policies; configure publication and test the registry artifact.
3. Build an operation journal and conditional cloud commit/retention protocol; finish project aliases and legacy scope migration.
4. Freeze held-out coding-continuity tasks and a larger multilingual retrieval corpus. Compare the released version, lexical controls, and relevant systems under equal context/cost.
5. Add a rebuildable index and optional semantic candidates only where that evaluation justifies them.
6. Add evidence-backed reusable lessons, real first-use/returning-use measurements, and independent security/recovery review.

The original roadmap's comparative quality, adoption, and independent-review gates require evidence from real users and external systems. They cannot be completed by passing synthetic repository tests.
