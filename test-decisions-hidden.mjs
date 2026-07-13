#!/usr/bin/env node
// hidden:true decision tombstone — consistency across all three
// read/display/search paths (render.js is covered separately in
// test-session.mjs, right next to the rest of render.js's tests), plus the
// one-off cleanup script that sets the tombstone.
//
// hidden:true is distinct from the existing `rejected` field: `rejected` is
// a live, user-facing string ("the alternative we considered and
// rejected"), searched/displayed everywhere; `hidden` is a boolean
// tombstone meaning "suppress this decision entirely." Setting `rejected`
// to a boolean would produce a nonsensical "rejected: true" line wherever
// it's displayed and wouldn't function as a hide-flag there — hence the
// new, separate field.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// ⚠️  HOME MUST BE SHIMMED BEFORE THE FIRST ./src IMPORT — DO NOT MOVE THIS.
//
// src/session/state.js does `const home = os.homedir()` at MODULE LOAD and
// derives paths.session from it once. os.homedir() reads $HOME. So any ./src
// import that (even transitively) pulls in state.js BEFORE this shim binds
// paths.session to the developer's REAL ~/.config/memoir/session.json for
// the life of the process — and ESM module caching means re-importing later,
// after setting $HOME, returns the same already-bound module.
//
// That is exactly what happened on 2026-07-13: this file imported
// ./src/commands/why.js (→ state.js) at the top of the first test block,
// then set process.env.HOME further down, then wrote a fixture to
// stateMod.paths.session — clobbering the real session.json with test data.
// Shim first, import second. Always.
const scratchHome = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-decisions-hidden-test-'));
process.env.HOME = scratchHome;
process.env.USERPROFILE = scratchHome; // Windows

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeState(decisions) {
  return {
    version: 1,
    machines: { m1: { label: 'test-machine', last_seen: '2026-07-01T00:00:00.000Z' } },
    current: { goals: [], next_actions: [], open_questions: [], decisions },
    history: [],
  };
}

// ── why.js — findDecisions (pure, used by the memoir_why MCP tool) ─────
console.log(`\n${BOLD}${CYAN}why.js — findDecisions() excludes hidden:true${RESET}\n`);

{
  const { findDecisions } = await import('./src/commands/why.js');
  const state = makeState([
    { text: 'Use Postgres for the database layer', machine_id: 'm1', date: '2026-07-01T00:00:00.000Z' },
    { text: 'Use MongoDB for the database layer', machine_id: 'm1', date: '2026-07-02T00:00:00.000Z', hidden: true, hidden_at: '2026-07-05T00:00:00.000Z' },
  ]);
  const matches = findDecisions(state, 'database');
  const texts = matches.map(d => d.text);
  assert(texts.includes('Use Postgres for the database layer'), 'non-hidden decision found by findDecisions');
  assert(!texts.includes('Use MongoDB for the database layer'), 'hidden:true decision excluded from findDecisions');
}

// ── why.js — whyCommand CLI display (its own independent filter) ───────
console.log(`\n${BOLD}${CYAN}why.js — whyCommand() CLI display excludes hidden:true${RESET}\n`);

{
  const stateMod = await import('./src/session/state.js');
  const { whyCommand } = await import('./src/commands/why.js');

  // Tripwire: prove state.js actually bound its paths inside the scratch HOME
  // shimmed at the top of this file. If a future edit ever reintroduces a
  // ./src import above that shim, paths.session silently points at the real
  // ~/.config/memoir/session.json and the fixture write below would destroy
  // real user data. Fail loudly here instead.
  if (!stateMod.paths.session.startsWith(scratchHome)) {
    console.error(
      `\n${RED}FATAL${RESET} state.js resolved paths.session to ${stateMod.paths.session},\n` +
      `which is OUTSIDE the scratch HOME (${scratchHome}).\n` +
      `A ./src import ran before the HOME shim. Refusing to write a fixture to a real path.\n`
    );
    process.exit(1);
  }

  await fs.ensureDir(path.dirname(stateMod.paths.session));
  const state = makeState([
    { text: 'Use Redis for caching', machine_id: 'm1', date: '2026-07-01T00:00:00.000Z' },
    { text: 'Use Memcached for caching', machine_id: 'm1', date: '2026-07-02T00:00:00.000Z', hidden: true, hidden_at: '2026-07-05T00:00:00.000Z' },
  ]);
  await fs.writeFile(stateMod.paths.session, JSON.stringify(state, null, 2));

  let output = '';
  const originalLog = console.log;
  console.log = (...args) => { output += args.join(' ') + '\n'; };
  try {
    await whyCommand('caching');
  } finally {
    console.log = originalLog;
  }

  assert(output.includes('Use Redis for caching'), 'non-hidden decision shown by `memoir why`');
  assert(!output.includes('Use Memcached for caching'), 'hidden:true decision excluded from `memoir why` CLI output');
}

// ── mcp.js — memoir_why tool handler (real stdio MCP call) ─────────────
console.log(`\n${BOLD}${CYAN}mcp.js — memoir_why tool excludes hidden:true (real stdio call)${RESET}\n`);

{
  const { spawnMcpClient, makeScratchHome } = await import('./test-mcp-helpers.mjs');
  const scratchHome = await makeScratchHome();
  await fs.ensureDir(path.join(scratchHome, '.config', 'memoir'));
  const state = makeState([
    { text: 'Deploy from the staging branch', machine_id: 'm1', date: '2026-07-01T00:00:00.000Z' },
    { text: 'Deploy from the release branch', machine_id: 'm1', date: '2026-07-02T00:00:00.000Z', hidden: true, hidden_at: '2026-07-05T00:00:00.000Z' },
  ]);
  await fs.writeFile(path.join(scratchHome, '.config', 'memoir', 'session.json'), JSON.stringify(state, null, 2));

  const mcp = await spawnMcpClient({ scratchHome });
  let text = '';
  let err = null;
  try {
    await mcp.initialize();
    const result = await mcp.callTool('memoir_why', { query: 'deploy' });
    text = (result.content || []).map(c => c.text || '').join('\n');
  } catch (e) {
    err = e;
  } finally {
    await mcp.close();
    await fs.remove(scratchHome);
  }

  assert(err === null, `memoir_why tool call succeeded${err ? ` (${err.message})` : ''}`);
  assert(text.includes('staging branch'), 'memoir_why: non-hidden decision present in tool response');
  assert(!text.includes('release branch'), 'memoir_why: hidden:true decision excluded from tool response');
}

// ── cleanup script — synthetic fixture only, never real data ───────────
console.log(`\n${BOLD}${CYAN}scripts/cleanup-junk-decisions-2026-07.mjs${RESET}\n`);

{
  const { cleanupJunkDecisions } = await import('./scripts/cleanup-junk-decisions-2026-07.mjs');

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-cleanup-script-test-'));
  const fixturePath = path.join(scratch, 'session.json');
  const junkSubstrings = ['JUNK_MARKER_ONE', 'JUNK_MARKER_TWO'];

  const makeFixture = () => makeState([
    { text: 'Real decision: use Postgres', machine_id: 'm1', date: '2026-07-01T00:00:00.000Z' },
    { text: 'This contains JUNK_MARKER_ONE mid-sentence and should be tombstoned', machine_id: 'm1', date: '2026-07-02T00:00:00.000Z' },
    { text: 'This one has JUNK_MARKER_TWO in it too', machine_id: 'm1', date: '2026-07-03T00:00:00.000Z' },
  ]);

  // Silence the script's own console.log noise during tests.
  const quiet = () => {};

  // 1. Dry-run changes nothing.
  await fs.writeFile(fixturePath, JSON.stringify(makeFixture(), null, 2));
  const beforeDry = await fs.readFile(fixturePath, 'utf8');
  const dryResult = await cleanupJunkDecisions(fixturePath, { dryRun: true, junkSubstrings, log: quiet });
  const afterDry = await fs.readFile(fixturePath, 'utf8');
  assert(afterDry === beforeDry, 'dry-run: file is byte-identical after running (nothing written)');
  assert(dryResult.matched.length === 2, `dry-run: reports 2 matching junk decisions (got ${dryResult.matched.length})`);
  assert(!(await fs.pathExists(`${fixturePath}.pre-cleanup-${Date.now()}`)), 'dry-run: no backup file pattern created (spot check)');
  const filesAfterDry = await fs.readdir(scratch);
  assert(!filesAfterDry.some(f => f.includes('.pre-cleanup-')), 'dry-run: no backup file of any timestamp created');

  // 2. Real mode: backs up first, then tombstones matching entries.
  const realResult = await cleanupJunkDecisions(fixturePath, { dryRun: false, junkSubstrings, log: quiet });
  assert(realResult.matched.length === 2, `real mode: tombstoned 2 decisions (got ${realResult.matched.length})`);
  assert(!!realResult.backupPath && await fs.pathExists(realResult.backupPath), 'real mode: backup file created');
  if (realResult.backupPath) {
    const backupContent = await fs.readFile(realResult.backupPath, 'utf8');
    assert(backupContent === beforeDry, 'real mode: backup content matches the pre-cleanup original byte-for-byte');
  }
  const afterReal = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  const hidden = afterReal.current.decisions.filter(d => d.hidden === true);
  const visible = afterReal.current.decisions.filter(d => !d.hidden);
  assert(hidden.length === 2, `real mode: exactly 2 decisions marked hidden:true (got ${hidden.length})`);
  assert(hidden.every(d => typeof d.hidden_at === 'string' && d.hidden_at.length > 0), 'real mode: every tombstoned decision has a hidden_at timestamp');
  assert(visible.length === 1 && visible[0].text.includes('Postgres'), 'real mode: the real decision is untouched and still visible');

  // 3. Idempotent: running again doesn't double-tombstone or error.
  const secondRun = await cleanupJunkDecisions(fixturePath, { dryRun: false, junkSubstrings, log: quiet });
  assert(secondRun.matched.length === 0, 'idempotent: second run finds nothing left to tombstone');
  const afterSecond = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  const hiddenAfterSecond = afterSecond.current.decisions.filter(d => d.hidden === true);
  assert(hiddenAfterSecond.length === 2, `idempotent: still exactly 2 hidden decisions, not doubled (got ${hiddenAfterSecond.length})`);

  await fs.remove(scratch);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
