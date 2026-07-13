#!/usr/bin/env node
// Regression guard for auto-capture decision QUALITY.
//
// 2026-06-07: loose regexes in extractDecisions() captured conversational
// fragments — and even scraped web text ("some lenders may require vehicle
// information…", from a Cars & Bids page) — as "decisions", which then
// polluted the pinned session block every session and buried real context.
// These tests assert the junk stays out while real decisions still land.
//
// 2026-07: a second, distinct bug — the "user-note" trigger regex
// (remember that / note that / keep in mind that / from now on) matched
// UNANCHORED anywhere in a user message, so those phrases appearing
// mid-sentence inside a long pasted spec/prompt got misread as an explicit
// "remember this" instruction. Two real junk decisions reached a live
// session.json this way. The fix anchors the trigger to message/line start
// and adds truncation/unbalanced-paren checks to the shared isQuality gate.
// These tests reproduce both real junk shapes and assert they're excluded,
// while short legitimate instructions (at message start, or followed by a
// long paste in the same turn) still land.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

const { parseSession, isQuality } = await import('./src/context/capture.js');

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

// ── user-note anchor regression (2026-07 fix) ──────────────────────────
// Reproduces the two real junk decisions found in a live session.json: the
// "remember that / note that / keep in mind that / from now on" trigger
// matched anywhere in a user message, so it fired on incidental occurrences
// deep inside long pasted spec/prompt text. A short-message fixture would
// have passed even under the OLD buggy code and would prove nothing about
// this fix — these are deliberately long (>500 char), single-paragraph,
// realistic pasted-content messages with the trigger phrase mid-sentence.
console.log(`\n${BOLD}${CYAN}user-note anchor regression${RESET}\n`);

const scratch2 = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-capture-test2-'));
const sessionFile2 = path.join(scratch2, 'session.jsonl');

// Junk A: real shape — "note that the service key is read as
// SUPABASE_SERVICE_KEY" occurring mid-sentence inside a long pasted ops spec.
const JUNK_A_PASTE =
  "Here is the full outline of what needs to happen before we can consider the backend hardening pass complete, so please read through the whole thing carefully instead of skimming just the headers. " +
  "The API gateway terminates TLS at the edge and forwards plaintext to the internal service mesh, and every internal service authenticates its outbound calls using a short-lived token minted from the credential broker at startup, " +
  "note that the service key is read as SUPABASE_SERVICE_KEY and must never be logged, echoed in an error message, or written to any file outside the secrets directory, " +
  "and once you have confirmed that path is airtight, move on to reviewing the queue consumer's retry and dead-letter behavior under sustained load in staging before we sign off on this pass.";

// Junk B: real shape — a "note that (...)" parenthetical mid-sentence inside
// a long "READ ONLY, produce a spec" style message, sized so a greedy 150-char
// capture would land mid-parenthetical with an unbalanced closing paren.
const JUNK_B_PASTE =
  "READ ONLY — produce an implementation spec only, do not touch any files during this pass, and do not open a PR until the spec is reviewed. " +
  "Walk through the rendering pipeline end to end and identify exactly where the cost actually lives before proposing any change " +
  "(note that off-screen render cost is already mitigated by content-visibility:auto so the only gain from a server-side filter would be trimming the HTML payload itself, not repaint cost). " +
  "If the filtering already happens at the query layer, or the trim happens client-side after hydration, the additional server-side work buys us nothing beyond a marginally smaller initial payload, " +
  "and that tradeoff needs to be weighed against the added complexity of a second filtering pass before we commit to building it.";

assert(JUNK_A_PASTE.length > 500, `junk A fixture is realistically long (${JUNK_A_PASTE.length} chars, must be >500)`);
assert(JUNK_B_PASTE.length > 500, `junk B fixture is realistically long (${JUNK_B_PASTE.length} chars, must be >500)`);

// Positive-path regression AT MESSAGE START — proves the anchor fix didn't
// over-tighten: a genuine short top-of-message instruction must still land.
const START_A = 'Note that from now on we deploy from the staging branch';
const START_B = 'Keep in mind that the cron runs at 2am UTC';

// Mixed case: a short remember-instruction at message start, followed by a
// long paste in the SAME turn — must still be captured (proves the fix
// scopes the regex to the first ~500 chars rather than rejecting the whole
// message because its total length exceeds some naive threshold).
const MIXED_PASTE = 'y'.repeat(80) + ' error connecting to host, retrying in 5s ' + 'z'.repeat(600);
const MIXED = `Remember that Postgres is the production database.\n${MIXED_PASTE}`;

await fs.writeFile(sessionFile2, [JUNK_A_PASTE, JUNK_B_PASTE, START_A, START_B, MIXED].map(usr).join('\n') + '\n');

const parsed2 = parseSession(sessionFile2);
const texts2 = parsed2.decisions.map(d => String(d.value || '').toLowerCase());

assert(!texts2.some(t => t.includes('supabase_service_key')), 'junk A (mid-message "note that ... SUPABASE_SERVICE_KEY") not captured');
assert(!texts2.some(t => t.includes('off-screen render cost')), 'junk B (mid-message "note that (...)" parenthetical) not captured');

assert(texts2.some(t => t.includes('staging branch')), 'message-start "Note that from now on..." still captured');
assert(texts2.some(t => t.includes('cron runs at 2am')), 'message-start "Keep in mind that..." still captured');
assert(texts2.some(t => t.includes('postgres is the production database')), 'short remember-instruction followed by a long paste in the same message still captured');

await fs.remove(scratch2);

// ── isQuality — direct unit assertions ─────────────────────────────────
console.log(`\n${BOLD}${CYAN}isQuality (exported quality gate)${RESET}\n`);

// Reconstructed junk A: what the OLD unanchored regex would have captured —
// a long, truncated-looking fragment with no sentence-ending punctuation.
const JUNK_A_RECONSTRUCTED =
  'the service key is read as SUPABASE_SERVICE_KEY and must never be logged, echoed in an error message, or written to any file outside the secrets'
    .slice(0, 150);
// Reconstructed junk B: what the OLD unanchored regex would have captured —
// starts inside the parenthetical (the opening "(" is before the capture),
// so the closing ")" it does contain is unbalanced.
const JUNK_B_RECONSTRUCTED =
  'off-screen render cost is already mitigated by content-visibility:auto so the only gain from a server-side filter would be trimming the HTML payload itself, not repaint cost). If the filtering'
    .slice(0, 150);

assert(isQuality(JUNK_A_RECONSTRUCTED) === false, 'isQuality rejects reconstructed junk A (long, no sentence-ending punctuation)');
assert(isQuality(JUNK_B_RECONSTRUCTED) === false, 'isQuality rejects reconstructed junk B (unbalanced closing paren)');
// NOTE: phrased without a leading "We" — isQuality (like looksLikeFragment,
// which it reuses) correctly rejects pronoun-led text ("we pick this back up
// Monday" is exactly the kind of junk assertion #3 above guards against, and
// that protection predates this commit). "We decided to go with Postgres for
// the database layer." would — correctly — also return false; asserting it
// true here would mean weakening a deliberate anti-fragment protection.
assert(isQuality('Decided to go with Postgres for the database layer.') === true, 'isQuality accepts a real, well-formed decision');

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
