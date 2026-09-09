#!/usr/bin/env node
// Regression guard for capture-artifact detection (2026-09-09).
//
// capture.js mines transcripts for decisions and stores `match[0]` — the
// matched SPAN, not the captured value — so a leaked row is the opening of one
// of its own regexes, cut wherever the match stopped. Three such rows were live
// in a real store ("the name is taken", "the name is even", "name is
// contientenal") alongside ten genuine decisions of 334-564 characters.
//
// The risk this test exists to bound is a FALSE POSITIVE: tombstoning something
// the user meant to keep is much worse than leaving one junk row behind. Every
// real decision below is taken from that store.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-cleandec-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;

const { isCaptureArtifact, findCaptureArtifacts, tombstone, MAX_ARTIFACT_LENGTH } =
  await import('./src/commands/clean-decisions.js');

console.log(`\n${BOLD}${CYAN}capture-artifact detection${RESET}\n`);

// ── the real leaked rows ───────────────────────────────────────────────────
const ARTIFACTS = [
  'the name is taken',
  'the name is even',
  'name is contientenal',
  'rename the app from',
  'the name is settled',
  'switch to SocialsLink',
  "let's use Redis for",
  'the new name will be',
  'migrate to Postgres',
  'database is going to be',
];
for (const text of ARTIFACTS) {
  assert(isCaptureArtifact({ text }) === true, `flags ${JSON.stringify(text)}`);
}

// ── real decisions from the same store — none may be flagged ───────────────
const REAL = [
  'AlgoThesis "discovered, not indexed" has four measured causes (crawl 2026-09-07): shell-first streaming HTML, orphaned sitemap URLs, crawl-budget leaks, and long duplicate titles.',
  'memoir `update` now upgrades the install that is actually running, verifies the version on disk afterwards, and warns when another memoir on PATH shadows it.',
  'Relay (camgitt/relay-feedback) is a tool for the existing stack first; it becomes a product only if the 10-05 gate passes.',
  'AlgoThesis: DIRECTION.md in the repo is the single product-direction record; Cam accepted all five calls.',
];
for (const text of REAL) {
  assert(isCaptureArtifact({ text }) === false, `spares a real decision (${text.slice(0, 42)}…)`);
}

// ── the boundaries that keep it conservative ───────────────────────────────
assert(isCaptureArtifact({ text: 'the name is taken', why: 'the .app was gone' }) === false,
  'a `why` is proof of authorship — never flagged');
assert(isCaptureArtifact({ text: 'switch to Postgres', rejected: 'staying on MySQL' }) === false,
  'a `rejected` alternative is proof of authorship — never flagged');
assert(isCaptureArtifact({ text: 'Use Postgres' }) === false,
  'a short decision that is not a cut-off pattern is left alone');
assert(isCaptureArtifact({ text: 'Ship it' }) === false, 'a terse real decision survives');
assert(isCaptureArtifact({ text: 'x'.repeat(MAX_ARTIFACT_LENGTH + 1) + ' from' }) === false,
  'length is a backstop — long prose is never an artifact, however it ends');
assert(isCaptureArtifact({ text: 'We will switch to Postgres because the write load doubled' }) === false,
  'the pattern must OPEN the text — a mid-sentence "switch to" is not a match');
assert(isCaptureArtifact(null) === false && isCaptureArtifact({}) === false,
  'survives null and empty decisions');

// ── finding and tombstoning in a store ─────────────────────────────────────
const state = {
  current: {
    decisions: [
      { text: 'the name is taken', date: '2026-09-06T07:26:36.891Z' },
      { text: REAL[0], date: '2026-09-07T00:00:00.000Z' },
      { text: 'rename the app from', date: '2026-09-04T17:59:38.388Z', hidden: true, hidden_at: 'earlier' },
    ],
    archived_decisions: [{ text: "let's use Redis for", date: '2026-08-19T05:19:07.573Z' }],
  },
};

const found = findCaptureArtifacts(state);
assert(found.length === 2, `finds both live artifacts and skips the tombstoned one (got ${found.length})`);
assert(found.some(f => f.bucket === 'archived_decisions'), 'searches archived decisions too');
assert(found.every(f => f.reason), 'reports why each row was flagged');

tombstone(state, found, '2026-09-09T12:00:00.000Z');
assert(state.current.decisions[0].hidden === true, 'tombstones the artifact');
assert(state.current.decisions[0].hidden_reason === 'capture-artifact', 'records why it was hidden');
assert(state.current.decisions[1].hidden === undefined, 'leaves the real decision untouched');
assert(state.current.decisions[2].hidden_at === 'earlier',
  'does not restamp a row an earlier cleanup already tombstoned');
assert(state.current.decisions[0].text === 'the name is taken',
  'hides rather than deletes — the text stays on disk and stays auditable');

assert(findCaptureArtifacts(state).length === 0, 'idempotent — a second run finds nothing');

await fs.remove(scratch);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
