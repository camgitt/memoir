#!/usr/bin/env node
// Regression guard for lean-memory tidyIndex() (2026-06-07).
// Must: bring MEMORY.md under budget, archive (not delete) the fat sections,
// preserve the critical-rules section, leave pointers, and be idempotent.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(c, m) { if (c) { console.log(`  ${GREEN}PASS${RESET} ${m}`); pass++; } else { console.log(`  ${RED}FAIL${RESET} ${m}`); fail++; } }

const { tidyIndex } = await import('./src/commands/tidy.js');

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-tidy-'));
const detail = (n) => Array.from({ length: n }, (_, i) => `- detail line ${i + 1}`).join('\n');
const md = `# Project Memory

## Active
- [Triage](triage.md) — short pointer

## Critical behavior rules (load first)
- [Rule one](r1.md) — keep this
- [Rule two](r2.md) — keep this
- [Rule three](r3.md) — keep this

## SocialsLink (fat inline block)
- **Path:** /some/path
- **Stack:** React + Vite
${detail(12)}

## NutriScan (fat inline block)
- **Path:** /np
${detail(8)}

## Clean pointers
- [A](a.md) — x
- [B](b.md) — y
`;
await fs.writeFile(path.join(dir, 'MEMORY.md'), md);
const origLines = md.split('\n').length;

console.log(`\n${BOLD}${CYAN}lean-memory tidyIndex (orig ${origLines} lines, budget 25)${RESET}\n`);

// 1. dry-run reports without changing the file
const dry = await tidyIndex(dir, { budgetLines: 25, dryRun: true, stamp: 'test' });
assert(dry.dryRun === true && dry.overBudget === true, 'dry-run flags over-budget');
assert(dry.wouldArchive.length >= 1, 'dry-run names sections it would archive');
assert((await fs.readFile(path.join(dir, 'MEMORY.md'), 'utf8')).split('\n').length === origLines, 'dry-run did NOT modify MEMORY.md');

// 2. real run brings it under budget
const res = await tidyIndex(dir, { budgetLines: 25, stamp: 'test' });
assert(res.newLineCount <= 25, `tidied under budget (${res.newLineCount} ≤ 25)`);

const after = await fs.readFile(path.join(dir, 'MEMORY.md'), 'utf8');
const archive = await fs.readFile(path.join(dir, 'memory_index_archive_test.md'), 'utf8');

// 3. no data lost — moved detail lives in the archive
assert(archive.includes('detail line 12'), 'archived content preserved (no deletion)');
// 4. critical rules section is never archived
assert(after.includes('Rule one') && after.includes('Rule three'), 'critical-rules section preserved in index');
// 5. a pointer to the archive replaces the fat section
assert(/\(memory_index_archive_test\.md\)/.test(after), 'index now points to the archive');

// 6. idempotent — already under budget, nothing more to do
const again = await tidyIndex(dir, { budgetLines: 25, stamp: 'test' });
assert(again.overBudget === false, 'idempotent — re-run is a no-op when under budget');

await fs.remove(dir);

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
