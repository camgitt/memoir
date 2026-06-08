#!/usr/bin/env node
// Regression guard for auto-capture decision QUALITY.
//
// 2026-06-07: loose regexes in extractDecisions() captured conversational
// fragments — and even scraped web text ("some lenders may require vehicle
// information…", from a Cars & Bids page) — as "decisions", which then
// polluted the pinned session block every session and buried real context.
// These tests assert the junk stays out while real decisions still land.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

const { parseSession } = await import('./src/context/capture.js');

// Build a scratch Claude transcript: known junk (must be rejected) + known
// real decisions (must survive).
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-capture-test-'));
const sessionFile = path.join(scratch, 'session.jsonl');
const asst = (t) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const usr  = (t) => JSON.stringify({ type: 'user', message: { content: t } });

const JUNK = [
  "Okay so we pick this back up at Monday's outreach?",
  "we pick it up at Monday's outreach?",
  "the backend is just throwing it away right now",
  "some lenders may require specific vehicle information and may have year restrictions",
  "stack is now complete (`90ae99c`):",
];
const REAL = [
  "We decided to go with Postgres for the database layer.",
  "remember that the API keys live in the env file not the repo",
];

await fs.writeFile(sessionFile, [...JUNK.map(asst), ...REAL.map(usr)].join('\n') + '\n');

console.log(`\n${BOLD}${CYAN}capture decision quality${RESET}\n`);

const parsed = parseSession(sessionFile);
const texts = parsed.decisions.map(d => String(d.value || '').toLowerCase());

// 1. None of the distinctive junk markers leak through as decisions
const JUNK_MARKERS = ["monday's outreach", 'throwing it away', 'lenders', '90ae99c', 'back up at'];
for (const m of JUNK_MARKERS) {
  assert(!texts.some(t => t.includes(m)), `junk marker rejected: "${m}"`);
}

// 2. A question is never a decision
assert(!parsed.decisions.some(d => /\?/.test(String(d.value || ''))), 'no decision contains a question mark');

// 3. Pronoun/filler-start fragments are never decisions
assert(
  !parsed.decisions.some(d => /^(it|this|that|these|those|we|i|they|you|some|there|here|just|back|now|also)\b/i.test(String(d.value || '').trim())),
  'no decision starts with a pronoun/filler fragment'
);

// 4. Real decisions still survive — the filter must not be over-eager
assert(texts.some(t => t.includes('postgres')), 'real tech decision (Postgres) still captured');
assert(texts.some(t => t.includes('api keys')), 'explicit "remember that…" note still captured');

await fs.remove(scratch);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
