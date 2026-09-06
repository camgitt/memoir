# Coding continuity comparison protocol — proposal v1

This protocol defines future evaluation. It does not contain a completed user study, held-out task corpus, or competitor score. Existing `cases.json` is a development regression fixture; the retrieval performance corpus measures latency only.

## Primary question

Does memory help a returning developer or coding agent take the first appropriate action and finish a paused task, compared with the strongest practical baseline?

The primary proposed outcome is elapsed reorientation time: from receiving the resumed task to the first action that a prewritten task verifier or a blinded reviewer considers appropriate. Count failures and timeouts explicitly. Task completion, repeated failed approaches, unsupported claims, and total operating cost are required secondary outcomes.

## Freeze before testing

- Start with 30 continuation tasks across several repositories and at least three languages. Treat this as a pilot. Split by repository/task family; near-duplicate histories must not cross development/evaluation boundaries.
- Include decisions and rationale, changed code/branches, failed approaches, cross-client handoffs, conflicting updates, absent evidence, scope/deletion boundaries, and multilingual wording.
- For each task, record the repository revision, prior session history, interruption point, permitted sources, valid and invalid next actions, completion verifier, timeout, and failure labels. Freeze a manifest hash before tuning prompts or retrieval on the evaluation tasks.
- Keep the held-out material outside training/tuning fixtures. Publishing a protocol or generating new examples in the same development session does not make the examples independent.

## Conditions

Compare Memoir with native client memory enabled where available, a plain project plan/findings/progress baseline, and a small relevant external set: Claude-Mem, Engram, and Cass Memory first; EverOS for the portable-file/index comparison. Record the exact release/commit and actual integration support. A current default-branch README is not proof of a tested release.

Use the same task, history, downstream model, permissions, context budget, and verifier where feasible. Record differences that cannot be normalized. Use isolated workspaces and memory stores for every condition to prevent contamination. Randomize/counterbalance condition order and repeat nondeterministic runs. Never feed a failed condition's discoveries into a later condition's starting state.

## Required record for each run

| Field | Meaning |
|---|---|
| task_id, task_manifest_hash, condition, repetition | Identity and reproducibility |
| repository_commit, harness_commit, memory_version | Exact code and system revision |
| model, embedding_model, judge, configuration_hash | Model/configuration differences |
| start, first_appropriate_action, end, timeout | Timings; absent events must remain absent |
| completion_verified, verifier_output | Outcome and evidence |
| repeated_failed_approach, unsupported_memory, wrong_scope, stale_state_used | Failure labels with supporting traces |
| ingestion_tokens, maintenance_tokens, retrieval_tokens, answer_tokens | Whole-lifecycle usage, not just the final prompt |
| cost, retrieved_evidence_ids, memory_edits, setup_minutes | Cost, traceability, and operational burden |

Use public/synthetic histories or explicitly consented, redacted user material. The project's distribution constraint remains SEO/automation only; obtain participants through inbound opt-in, not unsolicited outreach.

## Analysis and decision

Report paired differences, sample counts, medians, p95 where adequately sampled, confidence intervals, and failures by category. Retrieval Recall@k is a diagnostic and must not be relabeled answer accuracy or task completion.

Proposed investment gate: at least 25% lower median reorientation time against the strongest tested baseline without worse completion or more serious memory errors. Pre-register the actual gate before running the pilot. If intervals remain wide or only a few tasks drive the result, expand the sample rather than declaring success.

A release still requires the separate isolation, recovery, client acceptance, and cloud policy checks. No benchmark result compensates for a lost acknowledged write. Zero observed violations in a finite suite does not establish universal safety. A SOTA claim must name the precise task/configuration, release reproduction artifacts, and obtain independent confirmation.
