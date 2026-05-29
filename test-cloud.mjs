#!/usr/bin/env node
// Unit tests for cloud storage (retention + bundle round-trip) and MCP registration.
// No real network: cleanupOldBackups is driven through a stubbed globalThis.fetch,
// and the MCP server is exercised over its real stdio transport (not a network server).

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { bundleDir, unbundleToDir, cleanupOldBackups } = await import('./src/cloud/storage.js');
const { MAX_BACKUPS_FREE, MAX_BACKUPS_PRO, SUPABASE_URL, STORAGE_BUCKET } = await import('./src/cloud/constants.js');

// ── constants.js — verify the REAL retention limits ──────────────────
console.log(`\n${BOLD}${CYAN}constants.js (retention limits)${RESET}\n`);

// Plan claimed MAX_BACKUPS_FREE=100, MAX_BACKUPS_PRO=50 — verify against source.
{
  assert(MAX_BACKUPS_FREE === 100, `MAX_BACKUPS_FREE is 100 (got ${MAX_BACKUPS_FREE})`);
  assert(MAX_BACKUPS_PRO === 50, `MAX_BACKUPS_PRO is 50 (got ${MAX_BACKUPS_PRO})`);
}

// ── cleanupOldBackups — retention via stubbed fetch ──────────────────
// listBackups() orders created_at.desc (newest first). cleanupOldBackups keeps
// the first `maxBackups` and deletes backups.slice(maxBackups) — the OLDEST.
console.log(`\n${BOLD}${CYAN}cleanupOldBackups (retention)${RESET}\n`);

const session = { user: { id: 'user-123' }, access_token: 'tok' };

// Build N fake backups, newest-first (matching listBackups order).
function makeBackups(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    // i=0 is newest; created_at decreases as i grows.
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, n - i)).toISOString();
    out.push({ id: `id-${i}`, storage_path: `${session.user.id}/b-${i}.gz`, created_at: ts });
  }
  return out;
}

// Install a fetch stub: the listBackups GET returns our fixture; DELETEs are recorded.
function installFetchStub(backups) {
  const deleted = { storage: [], rows: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const u = String(url);

    if (method === 'GET' && u.includes('/rest/v1/backups')) {
      return { ok: true, json: async () => backups };
    }
    if (method === 'DELETE' && u.startsWith(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/`)) {
      const p = u.slice(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/`.length);
      deleted.storage.push(p);
      return { ok: true, text: async () => '' };
    }
    if (method === 'DELETE' && u.includes('/rest/v1/backups?id=eq.')) {
      const id = decodeURIComponent(u.split('id=eq.')[1]);
      deleted.rows.push(id);
      return { ok: true, text: async () => '' };
    }
    throw new Error(`Unexpected fetch in test: ${method} ${u}`);
  };
  return { deleted, restore: () => { globalThis.fetch = original; } };
}

// 1. Free tier: more than the limit → deletes exactly the overflow, oldest first.
{
  const total = MAX_BACKUPS_FREE + 7; // 107
  const backups = makeBackups(total);
  const { deleted, restore } = installFetchStub(backups);
  try {
    const n = await cleanupOldBackups(session, false);
    assert(n === total - MAX_BACKUPS_FREE, `deletes overflow count (${total - MAX_BACKUPS_FREE})`);
    assert(deleted.rows.length === total - MAX_BACKUPS_FREE, 'one metadata DELETE per removed backup');
    assert(deleted.storage.length === total - MAX_BACKUPS_FREE, 'one storage DELETE per removed backup');

    // The kept set must be the NEWEST `maxBackups`; deleted must be the oldest.
    const keptIds = new Set(backups.slice(0, MAX_BACKUPS_FREE).map(b => b.id));
    const deletedExpected = backups.slice(MAX_BACKUPS_FREE).map(b => b.id);
    assert(JSON.stringify(deleted.rows) === JSON.stringify(deletedExpected),
      'deletes exactly the OLDEST backups (tail of newest-first list)');
    assert(deleted.rows.every(id => !keptIds.has(id)), 'no kept (newest) backup is deleted');

    // Storage path of each deleted row matches its metadata row's storage_path.
    const expectedStorage = backups.slice(MAX_BACKUPS_FREE).map(b => b.storage_path);
    assert(JSON.stringify(deleted.storage) === JSON.stringify(expectedStorage),
      'storage deletions match the deleted rows\' storage_path');
  } finally { restore(); }
}

// 2. Pro tier uses MAX_BACKUPS_PRO (50) as the limit.
{
  const total = MAX_BACKUPS_PRO + 3; // 53
  const backups = makeBackups(total);
  const { deleted, restore } = installFetchStub(backups);
  try {
    const n = await cleanupOldBackups(session, true);
    assert(n === total - MAX_BACKUPS_PRO, `Pro limit applied (${MAX_BACKUPS_PRO}); deletes ${total - MAX_BACKUPS_PRO}`);
    const deletedExpected = backups.slice(MAX_BACKUPS_PRO).map(b => b.id);
    assert(JSON.stringify(deleted.rows) === JSON.stringify(deletedExpected),
      'Pro: deletes the oldest beyond limit');
  } finally { restore(); }
}

// 3. At or below the limit → no deletions, returns 0.
{
  const backups = makeBackups(MAX_BACKUPS_FREE); // exactly at limit
  const { deleted, restore } = installFetchStub(backups);
  try {
    const n = await cleanupOldBackups(session, false);
    assert(n === 0, 'no-op when count == limit');
    assert(deleted.rows.length === 0 && deleted.storage.length === 0, 'no DELETE calls when at/below limit');
  } finally { restore(); }
}

// 4. Cross-check: pure selection logic (sort/slice) keeps newest, drops oldest.
{
  // Unsorted input — assert the keep/drop semantics on the sorted (desc) order.
  const raw = makeBackups(10);
  const shuffled = [...raw].sort(() => Math.random() - 0.5);
  const sortedDesc = [...shuffled].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const limit = 4;
  const kept = sortedDesc.slice(0, limit);
  const dropped = sortedDesc.slice(limit);
  assert(kept.length === limit, 'pure: keeps exactly the limit');
  const newestTs = Math.max(...raw.map(b => +new Date(b.created_at)));
  const oldestTs = Math.min(...raw.map(b => +new Date(b.created_at)));
  assert(+new Date(kept[0].created_at) === newestTs, 'pure: newest is kept');
  assert(dropped.every(d => +new Date(d.created_at) < +new Date(kept[kept.length - 1].created_at)),
    'pure: every dropped backup is older than every kept one');
  assert(+new Date(dropped[dropped.length - 1].created_at) === oldestTs, 'pure: oldest is dropped');
}

// ── bundleDir → unbundleToDir round-trip ─────────────────────────────
console.log(`\n${BOLD}${CYAN}bundleDir / unbundleToDir round-trip${RESET}\n`);

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-cloud-test-'));

async function listTree(root) {
  const out = [];
  async function walk(dir, prefix = '') {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(dir, e.name), rel);
      else out.push(rel);
    }
  }
  await walk(root);
  return out.sort();
}

{
  const src = path.join(scratch, 'src');
  const dest = path.join(scratch, 'dest');
  await fs.ensureDir(path.join(src, 'nested', 'deep'));
  await fs.writeFile(path.join(src, 'top.md'), '# top\nhello world\n');
  await fs.writeFile(path.join(src, 'nested', 'a.json'), JSON.stringify({ a: 1, b: [2, 3] }));
  await fs.writeFile(path.join(src, 'nested', 'deep', 'note.txt'), 'deeply nested note');
  // Binary content with all byte values to prove base64 fidelity.
  const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  await fs.writeFile(path.join(src, 'nested', 'blob.bin'), binary);
  // Unicode content.
  await fs.writeFile(path.join(src, 'emoji.md'), 'héllo — 世界 — \u{1F680}\n');

  const gzipped = await bundleDir(src);
  assert(Buffer.isBuffer(gzipped), 'bundleDir returns a Buffer');
  assert(gzipped.length > 0, 'bundle is non-empty');
  // gzip magic bytes
  assert(gzipped[0] === 0x1f && gzipped[1] === 0x8b, 'bundle is gzip-framed');

  const count = await unbundleToDir(gzipped, dest);

  const srcTree = await listTree(src);
  const destTree = await listTree(dest);
  assert(JSON.stringify(srcTree) === JSON.stringify(destTree), 'tree identical after round-trip');
  assert(count === srcTree.length, `unbundleToDir returns file count (${srcTree.length})`);

  let allMatch = true;
  for (const rel of srcTree) {
    const a = await fs.readFile(path.join(src, rel));
    const b = await fs.readFile(path.join(dest, rel));
    if (!a.equals(b)) { allMatch = false; console.log(`    mismatch: ${rel}`); }
  }
  assert(allMatch, 'every file byte-identical (incl. binary + unicode)');
}

// Empty directory round-trips to zero files.
{
  const src = path.join(scratch, 'empty-src');
  const dest = path.join(scratch, 'empty-dest');
  await fs.ensureDir(src);
  const gzipped = await bundleDir(src);
  const count = await unbundleToDir(gzipped, dest);
  assert(count === 0, 'empty dir bundles/unbundles to 0 files');
}

await fs.remove(scratch);

// ── MCP smoke: real stdio transport, list registered tools ───────────
// Spawns `node src/mcp.js`, speaks newline-delimited JSON-RPC over stdio
// (the transport memoir actually uses — NOT a network server), then asserts
// the import succeeded and the expected tool names are registered.
console.log(`\n${BOLD}${CYAN}MCP smoke (stdio tools/list)${RESET}\n`);

const EXPECTED_TOOLS = [
  'memoir_status', 'memoir_recall', 'memoir_remember', 'memoir_list',
  'memoir_read', 'memoir_profiles', 'memoir_consolidate',
  'memoir_set_goal', 'memoir_add_next', 'memoir_complete_next',
  'memoir_note', 'memoir_ask', 'memoir_session', 'memoir_why',
];

async function mcpListTools() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'src', 'mcp.js')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; try { child.kill('SIGKILL'); } catch {} reject(new Error(`MCP timeout. stderr: ${stderr}`)); }
    }, 15000);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
      // Process complete newline-delimited JSON-RPC messages.
      let idx;
      while ((idx = stdout.indexOf('\n')) !== -1) {
        const line = stdout.slice(0, idx).trim();
        stdout = stdout.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2 && msg.result && Array.isArray(msg.result.tools)) {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            try { child.kill('SIGKILL'); } catch {}
            resolve(msg.result.tools.map(t => t.name));
          }
        }
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    child.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`MCP exited (code ${code}) before tools/list. stderr: ${stderr}`)); }
    });

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
    // 1. initialize handshake
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-cloud', version: '0.0.0' },
      },
    });
    // 2. tools/list (server processes requests in order after initialize)
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  });
}

{
  let toolNames = null;
  let err = null;
  try { toolNames = await mcpListTools(); } catch (e) { err = e; }

  assert(err === null, `src/mcp.js imports + serves over stdio without crashing${err ? ` (${err.message})` : ''}`);
  if (toolNames) {
    for (const name of EXPECTED_TOOLS) {
      assert(toolNames.includes(name), `tool registered: ${name}`);
    }
    assert(toolNames.length >= EXPECTED_TOOLS.length,
      `at least ${EXPECTED_TOOLS.length} tools registered (got ${toolNames.length})`);
  }
}

// ── Results ──────────────────────────────────────────────────────────
console.log(`\n${BOLD}═══════════════════════════════════${RESET}`);
if (fail === 0) console.log(`${BOLD}${GREEN}  ALL ${pass} TESTS PASSED${RESET}`);
else console.log(`${BOLD}${RED}  ${fail} FAILED${RESET}, ${GREEN}${pass} passed${RESET}`);
console.log(`${BOLD}═══════════════════════════════════${RESET}\n`);

process.exit(fail);
