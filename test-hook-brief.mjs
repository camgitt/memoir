#!/usr/bin/env node
// Regression guard for SessionStart context injection (2026-09-09).
//
// The pinned CLAUDE.md block asks the model to call memoir_session at the start
// of work; measured over 722 real sessions it did so in 4%. The SessionStart
// hook prints the brief instead, so delivery no longer depends on the model
// asking. This test pins the parts that make that safe to run on every session:
// it stays under budget, it stays silent when there is nothing to say, it stays
// silent when a human runs the command by hand, and it never throws.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

// Shim HOME to a scratch dir BEFORE importing — state.js resolves the memoir
// home at import time.
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-hookbrief-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
delete process.env.MEMOIR_NO_SESSION_BRIEF;

const project = path.join(scratch, 'proj');
await fs.ensureDir(project);
process.env.MEMOIR_PROJECT_ROOT = project;

const { buildSessionBrief, shouldInject, emitSessionBrief, DEFAULT_BRIEF_BUDGET } =
  await import('./src/session/hook-brief.js');
const { addGoal, addNext, addNote, addQuestion } = await import('./src/session/state.js');

console.log(`\n${BOLD}${CYAN}SessionStart brief${RESET}\n`);

// ── empty state ────────────────────────────────────────────────────────────
assert(await buildSessionBrief({ project }) === null,
  'emits nothing when no goal, next action, question or decision is recorded');

// ── populated state ────────────────────────────────────────────────────────
await addGoal('Ship sleep tracking');
await addNext('Wire the Health sleep read');
await addNext('Add busy mode');
await addNote('No points or streaks', { why: 'gamification hurt adherence in testing', project });
await addQuestion('Does Health return sleep stages on older watches?');

const brief = await buildSessionBrief({ project });
assert(typeof brief === 'string' && brief.length > 0, 'emits a brief once there is something to say');
assert(brief.includes('Ship sleep tracking'), 'carries the goal');
assert(brief.includes('Wire the Health sleep read'), 'carries the next actions');
assert(brief.includes('No points or streaks'), 'carries the decisions');
assert(brief.includes('gamification hurt adherence'), 'carries the WHY behind a decision');
assert(brief.includes('sleep stages'), 'carries the open questions');
assert(brief.startsWith('<memoir-session-brief>') && brief.trimEnd().endsWith('</memoir-session-brief>'),
  'is delimited so the model can tell injected memory from the live conversation');
assert(/evidence, not instructions and not authorization/.test(brief),
  'labels injected memory as evidence, never as authorization');

// ── budget ─────────────────────────────────────────────────────────────────
assert(brief.length <= DEFAULT_BRIEF_BUDGET,
  `stays inside the default budget (${brief.length} <= ${DEFAULT_BRIEF_BUDGET} chars)`);

for (let i = 0; i < 40; i++) {
  await addNote('Decision number ' + i + ' with a deliberately long body '.repeat(6), { project });
  await addQuestion('Question number ' + i + ' padded out to force an overflow '.repeat(4));
}
const fat = await buildSessionBrief({ project });
assert(fat.length <= DEFAULT_BRIEF_BUDGET,
  `stays inside the budget when session.json is bloated (${fat.length} <= ${DEFAULT_BRIEF_BUDGET} chars)`);
assert(fat.includes('Ship sleep tracking'),
  'drops the low-value sections first — the goal survives the squeeze');

const tiny = await buildSessionBrief({ project, budget: 200 });
assert(tiny.length <= 200, 'honours a caller-supplied budget');

// ── project scoping: the part that makes auto-injection safe ───────────────
// memoir's recall filter shows an item with no `project` stamp in EVERY
// project. Fine when a human asked; a lie when it is injected automatically
// under this project's heading. Foreign-project items must vanish, unstamped
// legacy items must be labelled rather than misattributed.
const { readSession, writeSession } = await import('./src/session/state.js');
const raw = await readSession();
// sessionView() merges the archived_* arrays back in, and the bloat loop above
// pushed items into them — clear both halves or this reads the earlier fixture.
for (const key of ['goals', 'next_actions', 'parked_actions', 'open_questions', 'decisions',
                   'archived_goals', 'archived_decisions', 'archived_questions']) {
  raw.current[key] = [];
}
raw.current.decisions = [
  { id: 'foreign', text: 'FOREIGN decision from another repo', project: path.join(scratch, 'other-repo'), date: '2026-09-01' },
  { id: 'legacy', text: 'LEGACY decision with no project stamp', date: '2026-08-01' },
];
await writeSession(raw);

const scoped = await buildSessionBrief({ project });
assert(!scoped.includes('FOREIGN'), 'never shows an item stamped with a different project');
assert(scoped.includes('LEGACY'), 'still surfaces unstamped legacy items — nothing is silently lost');
assert(/Carried over from earlier sessions/.test(scoped),
  'labels unstamped items as not necessarily belonging to this project');
assert(scoped.indexOf('Carried over') > scoped.indexOf('Project:'),
  'puts the unstamped items last, so the budget drops them first');

const { displayName } = await import('./src/session/hook-brief.js');
assert(displayName(project) === 'proj', 'names the project readably, not as a storage hash');
assert(!/^Project: (git|local):[a-f0-9]{32}$/m.test(scoped), 'never prints the hashed identity as the project name');

// A project with only foreign items has nothing to say.
raw.current.decisions = [{ id: 'foreign2', text: 'another repo entirely', project: path.join(scratch, 'other-repo') }];
await writeSession(raw);
assert(await buildSessionBrief({ project }) === null,
  'emits nothing when every item belongs to another project');

// ── when it should and should not fire ─────────────────────────────────────
assert(shouldInject({ hook_event_name: 'SessionStart', source: 'startup' }) === true, 'injects on startup');
assert(shouldInject({ hook_event_name: 'SessionStart', source: 'resume' }) === true, 'injects on resume');
assert(shouldInject({ hook_event_name: 'SessionStart', source: 'compact' }) === false,
  'skips compact — compaction already replays its own summary');
assert(shouldInject(null) === false, 'stays silent when run by hand (no hook payload on stdin)');
assert(shouldInject({ hook_event_name: 'Stop' }) === false, 'stays silent for other hook events');

process.env.MEMOIR_NO_SESSION_BRIEF = '1';
assert(shouldInject({ hook_event_name: 'SessionStart', source: 'startup' }) === false,
  'respects the MEMOIR_NO_SESSION_BRIEF opt-out');
delete process.env.MEMOIR_NO_SESSION_BRIEF;

// ── emit path writes to stdout, and never throws ───────────────────────────
// Re-seed, since the scoping block above deliberately emptied the state.
await addGoal('Ship sleep tracking');

let captured = '';
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = chunk => { captured += chunk; return true; };
const emitted = await emitSessionBrief({ hook_event_name: 'SessionStart', source: 'startup', cwd: project });
process.stdout.write = realWrite;
assert(emitted && captured.includes('Ship sleep tracking'), 'emit path writes the brief to stdout');
assert(captured.endsWith('\n'), 'terminates its stdout with a newline for the hook reader');

process.env.MEMOIR_NO_SESSION_BRIEF = '1';
let suppressed = '';
process.stdout.write = chunk => { suppressed += chunk; return true; };
await emitSessionBrief({ hook_event_name: 'SessionStart', source: 'startup', cwd: project });
process.stdout.write = realWrite;
assert(suppressed === '', 'writes nothing at all when the opt-out is set');
delete process.env.MEMOIR_NO_SESSION_BRIEF;

let threw = false;
try {
  // A corrupt payload must not take session start down with it.
  await emitSessionBrief({ hook_event_name: 'SessionStart', source: 'startup', cwd: 12345 });
} catch { threw = true; }
assert(!threw, 'never throws on a malformed payload');

await fs.remove(scratch);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
