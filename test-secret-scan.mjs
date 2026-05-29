#!/usr/bin/env node
// Tests for the pre-upload secret scan (scanStagedFiles in src/commands/push.js).
// Locks in: scan-only never mutates files; --redact strips the secret in place
// and leaves clean files byte-identical; a clean-only dir yields no findings.
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { scanStagedFiles } from './src/commands/push.js';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

// Matches scanner.js /\b(sk-ant-[a-zA-Z0-9-]{20,})/ → "Anthropic API key"
const SECRET = 'sk-ant-api03-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
const CLEAN_TEXT = '# Notes\nJust ordinary project notes, nothing sensitive here.\n';

async function makeStaging() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-scan-'));
  await fs.outputFile(path.join(dir, 'sub', 'notes.md'), `# Config\napi key: ${SECRET}\n`);
  await fs.outputFile(path.join(dir, 'clean.md'), CLEAN_TEXT);
  return dir;
}

console.log(`\n${BOLD}${CYAN}scanStagedFiles${RESET}\n`);

// 1. Scan-only: detects the secret, mutates nothing
{
  const dir = await makeStaging();
  const before = await fs.readFile(path.join(dir, 'sub', 'notes.md'), 'utf8');
  const { findings } = await scanStagedFiles(dir, { redact: false });
  const after = await fs.readFile(path.join(dir, 'sub', 'notes.md'), 'utf8');
  assert(findings.length >= 1, 'scan finds the planted secret');
  assert(findings.some(f => f.file.endsWith('notes.md')), 'finding points at the offending file');
  assert(after === before, 'scan-only does NOT modify the offending file');
  assert((await fs.readFile(path.join(dir, 'clean.md'), 'utf8')) === CLEAN_TEXT, 'scan-only leaves clean file untouched');
  await fs.remove(dir);
}

// 2. Redact: strips the secret in place, leaves clean file untouched
{
  const dir = await makeStaging();
  const { findings } = await scanStagedFiles(dir, { redact: true });
  const after = await fs.readFile(path.join(dir, 'sub', 'notes.md'), 'utf8');
  assert(findings.length >= 1, 'redact run still reports what it redacted');
  assert(!after.includes(SECRET), 'redact removes the raw secret from the file');
  assert(after.includes('# Config'), 'redact preserves surrounding content');
  assert((await fs.readFile(path.join(dir, 'clean.md'), 'utf8')) === CLEAN_TEXT, 'redact leaves the clean file untouched');
  await fs.remove(dir);
}

// 3. Clean-only dir: no findings, no changes even with redact=true
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-scan-'));
  await fs.outputFile(path.join(dir, 'a.md'), CLEAN_TEXT);
  const { findings, scanned } = await scanStagedFiles(dir, { redact: true });
  assert(findings.length === 0, 'clean-only dir yields zero findings');
  assert(scanned >= 1, 'clean files are still scanned');
  assert((await fs.readFile(path.join(dir, 'a.md'), 'utf8')) === CLEAN_TEXT, 'clean file unchanged even with redact=true');
  await fs.remove(dir);
}

console.log(`\n${BOLD}═══════════════════════════════════${RESET}`);
if (fail === 0) console.log(`${BOLD}${GREEN}  ALL ${pass} TESTS PASSED${RESET}`);
else console.log(`${BOLD}${RED}  ${fail} FAILED${RESET}, ${GREEN}${pass} passed${RESET}`);
console.log(`${BOLD}═══════════════════════════════════${RESET}\n`);
process.exit(fail > 0 ? 1 : 0);
