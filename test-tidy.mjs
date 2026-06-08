#!/usr/bin/env node
// Regression guard for lean-memory tidyIndex().
// Covers the core guarantees PLUS every bug found in adversarial review:
// code-fence misparse (data loss), archive dedup (bloat), empty-header pointers.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(c, m) { if (c) { console.log(`  ${GREEN}PASS${RESET} ${m}`); pass++; } else { console.log(`  ${RED}FAIL${RESET} ${m}`); fail++; } }

const { tidyIndex } = await import('./src/commands/tidy.js');
const F = '```';
const mk = async (lines) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-tidy-')); await fs.writeFile(path.join(d, 'MEMORY.md'), lines.join('\n') + '\n'); return d; };
const detail = (n, p = 'detail line') => Array.from({ length: n }, (_, i) => `- ${p} ${i + 1}`);

// ── A. basic tidy: no-loss, protected, pointer, idempotent, dry-run ──
{
  console.log(`\n${BOLD}${CYAN}A. basic tidy${RESET}\n`);
  const dir = await mk([
    '# Project Memory', '',
    '## Active', '- [Triage](triage.md) — short', '',
    '## Critical behavior rules (load first)', '- [Rule one](r1.md) — keep', '- [Rule two](r2.md) — keep', '- [Rule three](r3.md) — keep', '',
    '## SocialsLink (fat)', '- **Path:** /p', '- **Stack:** React', ...detail(12), '',
    '## NutriScan (fat)', '- **Path:** /np', ...detail(8, 'np line'), '',
    '## Clean pointers', '- [A](a.md) — x', '- [B](b.md) — y',
  ]);
  const orig = (await fs.readFile(path.join(dir, 'MEMORY.md'), 'utf8')).split('\n').length;
  const dry = await tidyIndex(dir, { budgetLines: 25, dryRun: true, stamp: 'A' });
  assert(dry.dryRun && dry.overBudget, 'dry-run flags over-budget');
  assert((await fs.readFile(path.join(dir, 'MEMORY.md'), 'utf8')).split('\n').length === orig, 'dry-run does not modify file');
  const res = await tidyIndex(dir, { budgetLines: 25, stamp: 'A' });
  assert(res.newLineCount <= 25, `tidied under budget (${res.newLineCount} ≤ 25)`);
  const after = await fs.readFile(path.join(dir, 'MEMORY.md'), 'utf8');
  const arch = await fs.readFile(path.join(dir, 'memory_index_archive_A.md'), 'utf8');
  assert(arch.includes('detail line 12'), 'archived content preserved (no deletion)');
  assert(after.includes('Rule one') && after.includes('Rule three'), 'critical-rules preserved');
  assert(/\(memory_index_archive_A\.md\)/.test(after), 'index points to archive');
  assert(!/- \[\]\(/.test(after), 'no broken empty-title pointers');
  const again = await tidyIndex(dir, { budgetLines: 25, stamp: 'A' });
  assert(again.overBudget === false, 'idempotent re-run is a no-op');
  await fs.remove(dir);
}

// ── B. code fence: a "## " INSIDE ``` must not split (critical data-loss fix) ──
{
  console.log(`\n${BOLD}${CYAN}B. code-fence aware${RESET}\n`);
  const dir = await mk([
    '# Project Memory', '',
    '## Critical behavior rules (load first)', '- [r1](r1.md) — keep', '',
    '## Config Block (fat)', 'Intro line.', F + 'yaml', '## fake-header-inside-fence', 'key: value', 'more: stuff', 'deep: nesting', 'x1: a', 'x2: b', 'x3: c', 'x4: d', F, 'trailing one', 'trailing two',
  ]);
  await tidyIndex(dir, { budgetLines: 8, stamp: 'fence' });
  const after = await fs.readFile(path.join(dir, 'MEMORY.md'), 'utf8');
  const arch = await fs.readFile(path.join(dir, 'memory_index_archive_fence.md'), 'utf8');
  assert((after.match(/\(memory_index_archive_fence\.md\)/g) || []).length === 1, 'one pointer (section archived as a unit, not split at the fenced ##)');
  assert(!after.includes('fake-header-inside-fence'), 'the in-fence "##" did NOT become its own index entry');
  assert(arch.includes('fake-header-inside-fence') && arch.includes('trailing two'), 'whole section (incl. fenced ## + trailing) archived intact — no orphan/loss');
  assert(after.includes('r1.md'), 'critical-rules still protected');
  await fs.remove(dir);
}

// ── C. re-archiving identical content must not duplicate it ──
{
  console.log(`\n${BOLD}${CYAN}C. archive dedup${RESET}\n`);
  const fat = ['## Big (fat)', ...detail(15, 'unique payload')];
  const base = ['# Project Memory', '', '## Critical behavior rules (load first)', '- [r1](r1.md) — keep', ''];
  const dir = await mk([...base, ...fat]);
  await tidyIndex(dir, { budgetLines: 8, stamp: 'dedup' });
  await fs.writeFile(path.join(dir, 'MEMORY.md'), [...base, ...fat].join('\n') + '\n'); // same content returns
  await tidyIndex(dir, { budgetLines: 8, stamp: 'dedup' });
  const arch = await fs.readFile(path.join(dir, 'memory_index_archive_dedup.md'), 'utf8');
  const occ = (arch.match(/unique payload 15/g) || []).length;
  assert(occ === 1, `re-archiving identical content does not duplicate it (saw ${occ})`);
  await fs.remove(dir);
}

// ── D. a fat section with an EMPTY header must not be archived to `- []()` ──
{
  console.log(`\n${BOLD}${CYAN}D. empty-header guard${RESET}\n`);
  const dir = await mk(['# Project Memory', '', '## Critical behavior rules (load first)', '- [r1](r1.md) — keep', '', '## ', ...detail(12, 'orphan detail')]);
  await tidyIndex(dir, { budgetLines: 8, stamp: 'empty' });
  const after = await fs.readFile(path.join(dir, 'MEMORY.md'), 'utf8');
  assert(!/- \[\]\(/.test(after), 'never emits a broken `- []()` pointer');
  assert(after.includes('orphan detail 1'), 'empty-header section left in place, not severed to a broken link');
  await fs.remove(dir);
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
