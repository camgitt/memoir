#!/usr/bin/env node
// Unit tests for cross-machine sync logic.
// Tests detectLocalHomeKey + cleanupLocalForeignKeys against scratch dirs —
// never touches the user's real ~/.claude.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { detectLocalHomeKey, cleanupLocalForeignKeys } from './src/adapters/restore.js';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', CYAN = '\x1b[36m', RESET = '\x1b[0m';

let pass = 0, fail = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    console.log(`  ${GREEN}PASS${RESET} ${msg}`);
    pass++;
  } else {
    console.log(`  ${RED}FAIL${RESET} ${msg}`);
    fail++;
    failures.push(msg);
  }
}

async function mkScratch() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-test-'));
  return dir;
}

// The real home key memoir would compute on this machine (for tests to be platform-agnostic)
const home = os.homedir();
const localKey = process.platform === 'win32'
  ? home.replace(/\\/g, '-').replace(/:/g, '-')
  : '-' + home.replace(/^\//, '').replace(/\//g, '-');

async function seedHomeKey(claudeDir, key, files = { 'MEMORY.md': 'local content' }, mtime = null) {
  const memDir = path.join(claudeDir, 'projects', key, 'memory');
  await fs.ensureDir(memDir);
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(memDir, name), content);
    if (mtime) {
      await fs.utimes(path.join(memDir, name), mtime, mtime);
    }
  }
}

async function rm(dir) { await fs.remove(dir).catch(() => {}); }

// ── detectLocalHomeKey tests ──────────────────────────────────────
console.log(`\n${BOLD}${CYAN}detectLocalHomeKey${RESET}\n`);

// 1. Empty projects dir → null
{
  const dir = await mkScratch();
  await fs.ensureDir(path.join(dir, 'projects'));
  assert(detectLocalHomeKey(dir) === null, 'returns null when projects/ is empty');
  await rm(dir);
}

// 2. No projects dir at all → null
{
  const dir = await mkScratch();
  assert(detectLocalHomeKey(dir) === null, 'returns null when projects/ does not exist');
  await rm(dir);
}

// 3. Only local home key present → returns it
{
  const dir = await mkScratch();
  await seedHomeKey(dir, localKey);
  assert(detectLocalHomeKey(dir) === localKey, 'returns local home key when only it exists');
  await rm(dir);
}

// 4. Local + stale foreign, foreign newer mtime → returns local (the core bug fix)
{
  const dir = await mkScratch();
  const foreignKey = 'C--Users-Asian-Beast';
  const oldTime = new Date('2026-01-01');
  const newTime = new Date('2026-04-16');
  await seedHomeKey(dir, localKey, { 'MEMORY.md': 'local' }, oldTime);
  await seedHomeKey(dir, foreignKey, { 'MEMORY.md': 'foreign' }, newTime);
  assert(
    detectLocalHomeKey(dir) === localKey,
    'prefers encoded homedir over newer-mtime foreign (the bug fix)'
  );
  await rm(dir);
}

// 5. Ignores hidden dirs (our .memoir-archived- dirs)
{
  const dir = await mkScratch();
  await fs.ensureDir(path.join(dir, 'projects', '.memoir-archived-20260417', 'something'));
  await seedHomeKey(dir, localKey);
  assert(detectLocalHomeKey(dir) === localKey, 'ignores .memoir-archived- hidden dirs');
  await rm(dir);
}

// 6. No local key, only foreign with memory/ → falls back to mtime logic
{
  const dir = await mkScratch();
  await seedHomeKey(dir, 'C--Users-Other', { 'MEMORY.md': 'foreign' });
  const result = detectLocalHomeKey(dir);
  assert(result === 'C--Users-Other', 'falls back to candidate when local key absent');
  await rm(dir);
}

// ── cleanupLocalForeignKeys tests ─────────────────────────────────
console.log(`\n${BOLD}${CYAN}cleanupLocalForeignKeys${RESET}\n`);

// 7. No foreign keys → no-op
{
  const dir = await mkScratch();
  await seedHomeKey(dir, localKey);
  const { archived, merged } = await cleanupLocalForeignKeys(dir);
  assert(archived.length === 0, 'no-op when no foreign keys');
  assert(merged === 0, 'merged count is 0');
  await rm(dir);
}

// 8. One foreign key with memory/ → archived, merged
{
  const dir = await mkScratch();
  const foreignKey = 'C--Users-Asian-Beast';
  await seedHomeKey(dir, localKey, { 'MEMORY.md': 'local' });
  await seedHomeKey(dir, foreignKey, {
    'MEMORY.md': 'foreign',
    'unique-file.md': 'content only on foreign',
  });
  const { archived } = await cleanupLocalForeignKeys(dir);
  assert(archived.includes(foreignKey), 'archived the foreign key');
  assert(!await fs.pathExists(path.join(dir, 'projects', foreignKey)), 'foreign dir removed from projects/');
  // unique file should now be in local memory/
  const localUniq = path.join(dir, 'projects', localKey, 'memory', 'unique-file.md');
  assert(await fs.pathExists(localUniq), 'foreign unique file merged into local');
  // archive dir exists
  const archiveDirs = (await fs.readdir(path.join(dir, 'projects')))
    .filter(n => n.startsWith('.memoir-archived-'));
  assert(archiveDirs.length === 1, 'archive dir created');
  assert(
    await fs.pathExists(path.join(dir, 'projects', archiveDirs[0], foreignKey)),
    'foreign dir moved into archive, recoverable'
  );
  await rm(dir);
}

// 9. Foreign key with matching local username → NOT archived (alt encoding of self)
{
  const dir = await mkScratch();
  const username = path.basename(home);
  const altLocalKey = 'C--Users-' + username; // alt encoding of this same machine
  await seedHomeKey(dir, localKey);
  await seedHomeKey(dir, altLocalKey);
  const { archived } = await cleanupLocalForeignKeys(dir);
  assert(!archived.includes(altLocalKey), 'does not archive dirs containing local username');
  assert(await fs.pathExists(path.join(dir, 'projects', altLocalKey)), 'alt-local dir untouched');
  await rm(dir);
}

// 10. Foreign key without memory/ → NOT archived (it's a project, not a home key)
{
  const dir = await mkScratch();
  await seedHomeKey(dir, localKey);
  // Create a dir that looks foreign but has no memory/ — e.g. a sub-project
  const projectDir = path.join(dir, 'projects', 'C--Users-Other-someproject');
  await fs.ensureDir(projectDir);
  await fs.writeFile(path.join(projectDir, 'session.jsonl'), '');
  const { archived } = await cleanupLocalForeignKeys(dir);
  assert(archived.length === 0, 'does not archive foreign dirs without memory/');
  assert(await fs.pathExists(projectDir), 'foreign project dir untouched');
  await rm(dir);
}

// 11. Merge keeps NEWER file (foreign newer → foreign wins; foreign older → local wins)
{
  const dir = await mkScratch();
  const foreignKey = 'C--Users-Other';
  const oldTime = new Date('2026-01-01');
  const newTime = new Date('2026-04-16');
  // Local file is OLDER, foreign file is NEWER → foreign wins
  await seedHomeKey(dir, localKey, { 'shared.md': 'OLD local version' }, oldTime);
  await seedHomeKey(dir, foreignKey, { 'shared.md': 'NEW foreign version' }, newTime);
  await cleanupLocalForeignKeys(dir);
  const merged = await fs.readFile(path.join(dir, 'projects', localKey, 'memory', 'shared.md'), 'utf8');
  assert(merged === 'NEW foreign version', 'newer foreign version wins over older local');
  await rm(dir);
}

// 12. Merge: foreign older, local newer → local kept
{
  const dir = await mkScratch();
  const foreignKey = 'C--Users-Other';
  const oldTime = new Date('2026-01-01');
  const newTime = new Date('2026-04-16');
  await seedHomeKey(dir, localKey, { 'shared.md': 'NEW local' }, newTime);
  await seedHomeKey(dir, foreignKey, { 'shared.md': 'OLD foreign' }, oldTime);
  await cleanupLocalForeignKeys(dir);
  const merged = await fs.readFile(path.join(dir, 'projects', localKey, 'memory', 'shared.md'), 'utf8');
  assert(merged === 'NEW local', 'newer local version preserved when foreign is older');
  await rm(dir);
}

// 13. Two foreign keys → both archived
{
  const dir = await mkScratch();
  await seedHomeKey(dir, localKey);
  await seedHomeKey(dir, 'C--Users-Other1');
  await seedHomeKey(dir, '-C-Users-Other2'); // alt encoding
  const { archived } = await cleanupLocalForeignKeys(dir);
  assert(archived.length === 2, 'both foreign keys archived');
  await rm(dir);
}

// 14. No local home key present → no-op (safety: don't archive when we can't ID local)
{
  const dir = await mkScratch();
  await fs.ensureDir(path.join(dir, 'projects'));
  await seedHomeKey(dir, 'C--Users-Other');
  // No local key. detectLocalHomeKey will fall back to 'C--Users-Other'.
  // cleanup should still be safe.
  const { archived } = await cleanupLocalForeignKeys(dir);
  // Since the fallback returns C--Users-Other as "local", it wouldn't archive itself
  assert(archived.length === 0, 'no-op when no encoded-homedir match (uses fallback as local)');
  await rm(dir);
}

// ── Results ───────────────────────────────────────────────────────
console.log(`\n${BOLD}═══════════════════════════════════${RESET}`);
if (fail === 0) {
  console.log(`${BOLD}${GREEN}  ALL ${pass} TESTS PASSED${RESET}`);
} else {
  console.log(`${BOLD}${RED}  ${fail} FAILED${RESET}, ${GREEN}${pass} passed${RESET}`);
  for (const f of failures) console.log(`    ${RED}·${RESET} ${f}`);
}
console.log(`${BOLD}═══════════════════════════════════${RESET}\n`);

process.exit(fail);
