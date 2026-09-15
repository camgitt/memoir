# Memoir production launch checklist — 2026-09-15

This checklist separates what source code can prove from hosted/product gates that need real external verification.

## P0 — data safety

- [x] Subscription lookup failures fail closed; an unknown plan cannot be treated as Free for retention cleanup.
- [x] Account-data deletion checks every destructive response and stops on failure.
- [x] Account-data deletion uses the hosted Storage deletion request shape already validated for backup deletion.
- [x] CLI no longer claims the authentication identity was deleted when the client cannot prove that.
- [ ] Add regression tests for subscription 401/403/429/500/timeouts and verify zero retention deletions.
- [ ] Add regression tests that fail each account-data deletion stage and verify no false success message.
- [ ] Add a privileged hosted endpoint for complete Auth-user deletion, with reauthentication and an auditable retryable workflow.

## P0 — cloud transaction recovery

- [ ] Give each logical cloud push a persistent operation/idempotency ID.
- [ ] Make object upload + metadata commit retryable without producing ambiguous orphan backups.
- [ ] Reconcile or garbage-collect uploaded objects that never received metadata.
- [ ] Test two clients pushing concurrently, lost responses, retries, and retention cleanup.
- [ ] Prove both clients' canonical/session changes survive the race.

## P0 — release verification

- [ ] `npm ci`
- [ ] `npm test`
- [ ] `npm run eval`
- [ ] `npm run test:packed`
- [ ] `npm audit --omit=dev`
- [ ] CI green on Linux/macOS/Windows and supported Node matrix.
- [ ] Install the exact packed artifact in a clean temporary home and complete setup → remember → fresh session → recall → backup → restore.
- [ ] Verify the npm registry version and trusted-publisher workflow after release.

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
