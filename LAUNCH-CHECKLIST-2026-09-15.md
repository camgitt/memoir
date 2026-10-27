# Memoir production launch checklist — 2026-09-15

This checklist separates what source code can prove from hosted/product gates that need real external verification.

## P0 — data safety

- [x] Subscription lookup failures fail closed; an unknown plan cannot be treated as Free for retention cleanup.
- [x] Account-data deletion checks every destructive response and stops on failure.
- [x] Account-data deletion uses the hosted Storage deletion request shape already validated for backup deletion.
- [x] CLI no longer claims the authentication identity was deleted when the client cannot prove that.
- [x] Add regression tests for subscription 401/403/429/500/timeouts and verify zero retention deletions.
- [x] Add regression tests that fail each account-data deletion stage and verify no false success message.
- [ ] Add a privileged hosted endpoint for complete Auth-user deletion, with reauthentication and an auditable retryable workflow.

### Found 2026-10-18 (review of 3.17.2–3.17.3, checked against production)

- [x] **Account-data deletion always fails in production.** `deleteAccount` deletes `shared_links` by `user_id`, but that column does not exist (it is `created_by`). PostgREST returns 400 `42703 column shared_links.user_id does not exist`, so every run deletes all backups, then stops with "Deletion incomplete" and never signs out. Retrying fails the same way.
- [x] `shared_links` and `subscriptions` have no DELETE policy, so even with the right column those deletes return 204 with 0 rows removed. Use `Prefer: return=representation` and check the row count, or move these steps server-side.
- [x] The deletion test fakes 204 for a request production rejects with 400. Fake the real PostgREST responses (400 unknown column, 204 with 0 rows under RLS).
- [x] The deletion success message points to "the hosted account-deletion service". No such function exists (production functions: `track`, `stripe-checkout`, `stripe-webhook`).
- [x] `memoir cloud push` aborts the whole backup when the plan lookup fails. Safer: upload the backup, skip only the pruning.
- [x] `shared_links` policies: anyone can read every row, and "Anyone can increment use count" lets anyone UPDATE any column of any row. `memoir share` uploads to `shares/<uid>/…`, which the storage INSERT policy appears to reject (first folder must be the uid). 0 shared links exist.
- [x] `src/cloud/auth.js` and `src/commands/login.js` were collapsed into very long single lines, and the comment explaining why GoTrue needs `redirect_to` as a query parameter (the 3.12.0 fix) was deleted. Restore the comment.

### Found 2026-10-19 (review of 3.17.4, checked against production) — fixed in 3.17.5

- [x] 3.17.4's delete rules work in production: an owner deletes their own shared link and subscription row; another user can neither read nor delete them (simulated as two real users in a rolled-back transaction).
- [x] 3.17.4's storage rule "Recipients read active shared bundles" let anyone list every active share bundle, and each bundle name contains its share token (proved as `anon` in a rolled-back probe). 3.17.5 downloads through the `share-download` edge function instead: exact token in, one use consumed, 120-second signed URL out. The CLI only fetches signed URLs on the project's own origin.
- [ ] **Production:** drop that storage rule and its helper function, and stop `anon`/`authenticated` calling `memoir_consume_shared_link` (`202610190001`). Then record `202610180001` (applied by hand for 3.17.4) and `202610190001` in the migration history. Needs Cam: the Supabase connector refuses writes from Claude Code, and reading the CLI login from the keychain was blocked.
- [x] Account deletion stops before deleting anything when the plan is Pro (deleting data doesn't stop Stripe billing, and the webhook re-creates the row on renewal) or when the plan can't be read.
- [x] Share bundles are deleted before their rows, so a failed bundle delete leaves the row for the retry to find.
- [ ] There is no way to cancel Pro inside the product (no Stripe billing portal). The CLI points paying users to hello@memoir.sh.
- [ ] `supabase db push` mis-pairs this repo's 12-digit migration names with production's 14-digit history and would re-run `202609050001`. Apply by SQL, or switch new migrations to 14-digit names.

## P0 — cloud transaction recovery

- [ ] Give each logical cloud push a persistent operation/idempotency ID.
- [ ] Make object upload + metadata commit retryable without producing ambiguous orphan backups.
- [ ] Reconcile or garbage-collect uploaded objects that never received metadata.
- [ ] Test two clients pushing concurrently, lost responses, retries, and retention cleanup.
- [ ] Prove both clients' canonical/session changes survive the race.

## P0 — release verification

- [x] `npm ci`
- [x] `npm test`
- [x] `npm run eval`
- [x] `npm run test:packed`
- [x] `npm audit --omit=dev`
- [x] CI green on Linux/macOS/Windows and supported Node matrix.
- [x] Install the exact packed artifact in a clean temporary home and complete setup → remember → fresh session → recall → backup → restore.
- [x] Verify the npm registry version and trusted-publisher workflow after release.
- [ ] The MCP registry still lists `io.github.camgitt/memoir` at **3.2.2** (published 2026-03-28; found 2026-10-19). `publish.yml` now runs official `mcp-publisher` (GitHub OIDC) after npm on each version tag. **Catch-up for 3.17.5:** merge the workflow PR, then Actions → Publish → Run workflow on `main` (`workflow_dispatch` skips npm). Confirm `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.camgitt/memoir"` shows 3.17.5.

## P1 — onboarding / landing

- [ ] Landing page leads with the plain-English outcome, not MCP/CLI terminology.
- [ ] Primary CTA is guided setup; terminal install is explicitly the developer path.
- [ ] User chooses Claude Code, Cursor, or Codex and sees only relevant instructions.
- [ ] Setup does not claim it automatically creates a GitHub repository.
- [ ] Cloud sync is clearly marked beta until the P0 cloud transaction gates above pass.
- [ ] First-run success test demonstrates one saved decision appearing in a fresh session.
- [ ] Current shipping version is not hard-coded into SEO/schema copy.
- [ ] Mobile setup flow checked at 390 px and keyboard-only navigation checked.

## P1 — real product evidence

- [ ] Run 20–30 ordinary fresh development tasks with and without Memoir.
- [ ] Measure repeated questions, missed decisions, irrelevant memories, stale evidence, and re-explanation required.
- [ ] Do not turn controlled retrieval tests into claims of time saved or automatic adherence.
- [ ] Run at least one multi-day trial across each first-class client before claiming seamless continuity there.

## P2 — independent review

- [ ] Independent security review of local file boundaries, recovery, encryption protocol, and hosted tenant isolation.
- [ ] Disaster-recovery exercise from encrypted backup with a clean machine.
- [ ] Document support/escalation process for a user who cannot restore or believes data was lost.

## Launch rule

Local/project memory can ship as a developer beta once release verification is green. Paid cross-machine cloud sync should remain beta until every P0 cloud transaction/recovery gate is checked with hosted evidence.
