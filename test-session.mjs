#!/usr/bin/env node
// Unit tests for session state + render + inject.
// Uses a scratch HOME to avoid touching ~/.config/memoir or ~/.claude.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

// Shim HOME so state.js paths point to scratch
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-session-test-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch; // Windows
// os.homedir() uses HOME/USERPROFILE env; state.js captures at import time,
// so set these BEFORE the import below.

const state = await import('./src/session/state.js');
const { renderSession, BLOCK_START, BLOCK_END } = await import('./src/session/render.js');
const { applyBlock, injectInto, uninjectFrom, INJECTION_TARGETS } = await import('./src/session/inject.js');

// ── state.js ──────────────────────────────────────────────────────
console.log(`\n${BOLD}${CYAN}state.js${RESET}\n`);

// 1. readSession on fresh machine returns empty schema
{
  const s = await state.readSession();
  assert(s.version === state.SCHEMA_VERSION, 'fresh session has correct version');
  assert(Array.isArray(s.current.goals), 'goals is an array');
  assert(s.current.goals.length === 0, 'empty goals');
}

// 2. getMachineId is stable across calls
{
  const a = await state.getMachineId();
  const b = await state.getMachineId();
  assert(a.id === b.id, 'machine id stable across calls');
  assert(!!a.label, 'machine has a human label');
}

// 3. addGoal → readSession shows it
{
  await state.addGoal('Ship session continuity');
  const s = await state.readSession();
  assert(s.current.goals[0].text === 'Ship session continuity', 'goal appears after add');
  assert(!!s.current.goals[0].machine_id, 'goal tagged with machine');
}

// 4. addNext dedupes by text
{
  await state.addNext('Write tests');
  await state.addNext('write tests'); // same, lowercased
  const s = await state.readSession();
  const writeTestsCount = s.current.next_actions.filter(a => /write tests/i.test(a.text)).length;
  assert(writeTestsCount === 1, 'addNext dedupes (case-insensitive)');
}

// 5. completeNext removes by substring
{
  await state.addNext('Ship the thing');
  await state.completeNext('ship the');
  const s = await state.readSession();
  const stillThere = s.current.next_actions.some(a => /ship the thing/i.test(a.text));
  assert(!stillThere, 'completeNext removes by substring match');
}

// 6. addNote stores structured decision
{
  await state.addNote('Use archive-not-delete', { why: 'reversibility', rejected: 'rm -rf' });
  const s = await state.readSession();
  const last = s.current.decisions[0];
  assert(last.text === 'Use archive-not-delete', 'decision text stored');
  assert(last.why === 'reversibility', 'decision why stored');
  assert(last.rejected === 'rm -rf', 'rejected alternative stored');
}

// 7. Atomic write: session.json is valid JSON after mutations
{
  const raw = await fs.readFile(state.paths.session, 'utf8');
  const parsed = JSON.parse(raw);
  assert(parsed.version === state.SCHEMA_VERSION, 'persisted file is valid JSON with correct schema');
}

// 8. recordSessionEnd pushes to history
{
  await state.recordSessionEnd({ summary: 'Built session core', filesTouched: ['a.js', 'b.js'], durationMin: 45 });
  const s = await state.readSession();
  assert(s.history[0].summary === 'Built session core', 'history entry written');
  assert(s.history[0].duration_min === 45, 'duration captured');
}

// ── mergeSessions ─────────────────────────────────────────────────
console.log(`\n${BOLD}${CYAN}mergeSessions${RESET}\n`);

// 9. merge unions goals by text, prefers newer
{
  const local = {
    version: 1,
    created_at: '2026-04-17T00:00:00Z',
    updated_at: '2026-04-17T12:00:00Z',
    machines: { mac: { label: 'Mac', last_seen: '2026-04-17T12:00:00Z' } },
    current: {
      goals: [{ text: 'ship it', machine_id: 'mac', set_on: '2026-04-17T08:00:00Z' }],
      next_actions: [], open_questions: [], decisions: [],
    },
    history: [],
  };
  const remote = {
    version: 1,
    created_at: '2026-04-16T00:00:00Z',
    updated_at: '2026-04-16T22:00:00Z',
    machines: { win: { label: 'Windows', last_seen: '2026-04-16T22:00:00Z' } },
    current: {
      goals: [{ text: 'ship it', machine_id: 'win', set_on: '2026-04-18T08:00:00Z' }],
      next_actions: [], open_questions: [], decisions: [],
    },
    history: [],
  };
  const merged = state.mergeSessions(local, remote);
  assert(merged.current.goals.length === 1, 'duplicate goals union to 1');
  assert(merged.current.goals[0].machine_id === 'win', 'newer remote goal wins');
  assert(Object.keys(merged.machines).length === 2, 'both machines present');
}

// 10. merge unions unique next_actions
{
  const local = {
    version: 1, created_at: '', updated_at: '', machines: {},
    current: { goals: [], next_actions: [{ text: 'mac task', machine_id: 'mac', added: '2026-04-17T08:00:00Z' }], open_questions: [], decisions: [] },
    history: [],
  };
  const remote = {
    version: 1, created_at: '', updated_at: '', machines: {},
    current: { goals: [], next_actions: [{ text: 'win task', machine_id: 'win', added: '2026-04-18T08:00:00Z' }], open_questions: [], decisions: [] },
    history: [],
  };
  const merged = state.mergeSessions(local, remote);
  assert(merged.current.next_actions.length === 2, 'both unique next_actions kept');
}

// 11. merge history dedupes and sorts newest-first
{
  const entry = { date: '2026-04-17T10:00:00Z', machine_id: 'mac', summary: 'Did X' };
  const local = {
    version: 1, created_at: '', updated_at: '', machines: {},
    current: { goals: [], next_actions: [], open_questions: [], decisions: [] },
    history: [entry, { date: '2026-04-15T10:00:00Z', machine_id: 'mac', summary: 'Old' }],
  };
  const remote = {
    version: 1, created_at: '', updated_at: '', machines: {},
    current: { goals: [], next_actions: [], open_questions: [], decisions: [] },
    history: [entry, { date: '2026-04-18T10:00:00Z', machine_id: 'win', summary: 'Latest' }],
  };
  const merged = state.mergeSessions(local, remote);
  assert(merged.history.length === 3, 'duplicate history entry deduped');
  assert(merged.history[0].summary === 'Latest', 'newest history first');
}

// ── render.js ─────────────────────────────────────────────────────
console.log(`\n${BOLD}${CYAN}render.js${RESET}\n`);

// 12. Empty state renders a friendly placeholder
{
  const rendered = renderSession(null);
  assert(rendered.includes(BLOCK_START), 'includes start marker');
  assert(rendered.includes(BLOCK_END), 'includes end marker');
  assert(/memoir goal/.test(rendered), 'placeholder suggests the goal command');
}

// 13. Full state renders all sections
{
  const full = {
    version: 1,
    machines: {
      mac: { label: 'Mac', last_seen: '2026-04-17T12:00:00Z' },
      win: { label: 'Windows', last_seen: '2026-04-16T22:00:00Z' },
    },
    current: {
      goals: [{ text: 'Ship continuity', machine_id: 'mac', set_on: '2026-04-17T08:00:00Z' }],
      next_actions: [{ text: 'Write tests', machine_id: 'mac', added: '2026-04-17T09:00:00Z' }],
      open_questions: [{ text: 'What about hooks?', machine_id: 'mac', asked: '2026-04-17T10:00:00Z' }],
      decisions: [{ text: 'Use atomic writes', why: 'crash safety', machine_id: 'mac', date: '2026-04-17T11:00:00Z' }],
    },
    history: [
      { date: '2026-04-17T09:00:00Z', machine_id: 'mac', summary: 'Built state.js', duration_min: 45 },
    ],
  };
  const rendered = renderSession(full);
  assert(rendered.includes('Ship continuity'), 'goal shown');
  assert(rendered.includes('Write tests'), 'next shown');
  assert(rendered.includes('What about hooks?'), 'question shown');
  assert(rendered.includes('Use atomic writes'), 'decision shown');
  assert(rendered.includes('crash safety'), 'decision why shown');
  assert(/Built state\.js/.test(rendered), 'history shown');
  assert(/\(Mac\)/.test(rendered), 'machine tag shown with multiple machines');
}

// 14. Single-machine state omits machine tags (reduces noise)
{
  const single = {
    version: 1,
    machines: { mac: { label: 'Mac', last_seen: '2026-04-17T12:00:00Z' } },
    current: {
      goals: [{ text: 'Solo goal', machine_id: 'mac', set_on: '2026-04-17T08:00:00Z' }],
      next_actions: [], open_questions: [], decisions: [],
    },
    history: [],
  };
  const rendered = renderSession(single);
  assert(!/\(Mac\)/.test(rendered), 'no machine tag with single machine');
  assert(rendered.includes('Solo goal'), 'goal still rendered');
}

// ── inject.js ─────────────────────────────────────────────────────
console.log(`\n${BOLD}${CYAN}inject.js${RESET}\n`);

// 15. Injects into fresh file
{
  const target = path.join(scratch, 'CLAUDE.md');
  await fs.remove(target).catch(() => {});
  const block = renderSession({
    version: 1, machines: {},
    current: { goals: [{ text: 'hello', machine_id: 'x', set_on: '2026-04-17T00:00:00Z' }], next_actions: [], open_questions: [], decisions: [] },
    history: [],
  });
  await injectInto(target, block);
  const content = await fs.readFile(target, 'utf8');
  assert(content.includes('hello'), 'block injected into fresh file');
  assert(content.includes(BLOCK_START) && content.includes(BLOCK_END), 'markers present');
}

// 16. Replaces existing block without touching user content
{
  const target = path.join(scratch, 'CLAUDE2.md');
  const userContent = '# My Rules\n\nDon\'t mess with this text.\n';
  const firstBlock = renderSession({
    version: 1, machines: {},
    current: { goals: [{ text: 'goal v1', machine_id: 'x', set_on: '2026-04-17T00:00:00Z' }], next_actions: [], open_questions: [], decisions: [] },
    history: [],
  });
  await fs.writeFile(target, applyBlock(userContent, firstBlock, true));
  // Now inject an updated block
  const secondBlock = renderSession({
    version: 1, machines: {},
    current: { goals: [{ text: 'goal v2', machine_id: 'x', set_on: '2026-04-18T00:00:00Z' }], next_actions: [], open_questions: [], decisions: [] },
    history: [],
  });
  await injectInto(target, secondBlock);
  const content = await fs.readFile(target, 'utf8');
  assert(content.includes('goal v2'), 'new block content written');
  assert(!content.includes('goal v1'), 'old block replaced');
  assert(content.includes("Don't mess with this text"), 'user content preserved');
  assert(content.includes('# My Rules'), 'H1 title preserved');
}

// 17. Places block after H1 title, not before
{
  const content = '# Important\n\nuser note\n';
  const block = '<!-- memoir:session-block v1 -->INJECTED<!-- /memoir:session-block -->';
  const result = applyBlock(content, block, true);
  const h1Pos = result.indexOf('# Important');
  const blockPos = result.indexOf('INJECTED');
  const userPos = result.indexOf('user note');
  assert(h1Pos < blockPos && blockPos < userPos, 'block is between H1 and user content');
}

// 18. uninjectFrom removes block, leaves everything else
{
  const target = path.join(scratch, 'CLAUDE3.md');
  const content = '# Title\n\n' + renderSession(null) + '\n\nbody text\n';
  await fs.writeFile(target, content);
  const res = await uninjectFrom(target);
  assert(res.removed === true, 'reports removed');
  const after = await fs.readFile(target, 'utf8');
  assert(after.includes('# Title'), 'title preserved');
  assert(after.includes('body text'), 'body preserved');
  assert(!after.includes(BLOCK_START), 'markers gone');
}

// ── Cleanup ───────────────────────────────────────────────────────
await fs.remove(scratch);

// ── Results ───────────────────────────────────────────────────────
console.log(`\n${BOLD}═══════════════════════════════════${RESET}`);
if (fail === 0) console.log(`${BOLD}${GREEN}  ALL ${pass} TESTS PASSED${RESET}`);
else console.log(`${BOLD}${RED}  ${fail} FAILED${RESET}, ${GREEN}${pass} passed${RESET}`);
console.log(`${BOLD}═══════════════════════════════════${RESET}\n`);

process.exit(fail);
