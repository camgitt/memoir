#!/usr/bin/env node
// Regression guard for GLOBAL auto-activation of recall (2026-06-07).
// ensureRecallInstruction() must: inject the memoir instruction block into an
// installed tool's user-global config, be IDEMPOTENT (no duplicate on re-run),
// and respect the MEMOIR_NO_AUTO_ACTIVATE opt-out.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

// Shim HOME to a scratch dir BEFORE importing — inject.js captures home at import
// time. Create .claude so 'claude' is a detected target.
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-autoactivate-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
await fs.ensureDir(path.join(scratch, '.claude'));
delete process.env.MEMOIR_NO_AUTO_ACTIVATE;

const { ensureRecallInstruction } = await import('./src/commands/activate.js');
const claudeMd = path.join(scratch, '.claude', 'CLAUDE.md');

console.log(`\n${BOLD}${CYAN}global auto-activate${RESET}\n`);

await ensureRecallInstruction();
const after1 = await fs.readFile(claudeMd, 'utf8');
assert((after1.match(/memoir:start/g) || []).length === 1, 'injects the recall block into the global config');
assert(after1.includes('memoir_recall'), 'block tells the AI to use memoir_recall');

await ensureRecallInstruction();
const after2 = await fs.readFile(claudeMd, 'utf8');
assert((after2.match(/memoir:start/g) || []).length === 1, 'idempotent — re-run does not duplicate the block');

process.env.MEMOIR_NO_AUTO_ACTIVATE = '1';
const r = await ensureRecallInstruction();
assert(r.skipped === true, 'MEMOIR_NO_AUTO_ACTIVATE opts out cleanly');
delete process.env.MEMOIR_NO_AUTO_ACTIVATE;

await fs.remove(scratch);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
