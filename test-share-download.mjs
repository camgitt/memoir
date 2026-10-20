#!/usr/bin/env node
// Share restore must download through the share-download function, never
// straight from Storage. A Storage read rule for recipients also lets anyone
// list every bundle, and bundle names contain their tokens (found 2026-10-19).
//
// No real network: globalThis.fetch is stubbed with the response shapes the
// hosted APIs return. The bundle is real: built and encrypted with the same
// helpers `memoir share` uses. HOME is shimmed before any ./src import.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-share-download-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.APPDATA = path.join(scratch, 'AppData', 'Roaming');
process.env.XDG_CONFIG_HOME = path.join(scratch, '.config');
process.env.MEMOIR_PASSPHRASE = 'correct horse battery';

const { restoreCommand } = await import('./src/commands/restore.js');
const { encryptDirectory, createVerifyToken } = await import('./src/security/encryption.js');
const { bundleDir } = await import('./src/cloud/storage.js');
const { SUPABASE_URL, STORAGE_BUCKET } = await import('./src/cloud/constants.js');

const ownerId = crypto.randomUUID();
const token = crypto.randomUUID();
const objectPath = `${ownerId}/shares/${token}.gz`;
const signedUrl = `${SUPABASE_URL}/storage/v1/object/sign/${STORAGE_BUCKET}/${objectPath}?token=signed-jwt`;

// Real encrypted bundle, same steps as share.js.
const plainDir = path.join(scratch, 'plain');
const encDir = path.join(scratch, 'enc');
await fs.outputJson(path.join(plainDir, 'claude-cli', 'settings.json'), { sharedMarker: token });
await encryptDirectory(plainDir, encDir, process.env.MEMOIR_PASSPHRASE);
await fs.writeFile(path.join(encDir, 'verify.enc'), await createVerifyToken(process.env.MEMOIR_PASSPHRASE));
const bundle = await bundleDir(encDir);

const shareRow = {
  id: crypto.randomUUID(),
  token,
  backup_id: objectPath,
  created_by: ownerId,
  tools: ['claude'],
  size_bytes: bundle.length,
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  max_uses: 5,
  use_count: 0,
  created_at: new Date().toISOString(),
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function installStub({ grant }) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = (options.method || 'GET').toUpperCase();
    calls.push({ method, url: u, body: options.body || null });
    if (u === `${SUPABASE_URL}/rest/v1/rpc/memoir_get_shared_link`) {
      return jsonResponse(200, JSON.parse(options.body).link_token === token ? [shareRow] : []);
    }
    if (u === `${SUPABASE_URL}/functions/v1/share-download`) return grant(JSON.parse(options.body));
    if (u === signedUrl) return new Response(bundle, { status: 200 });
    // Direct Storage reads are what this release removed.
    if (u.startsWith(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/`)) {
      return jsonResponse(400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
    }
    throw new Error(`Unexpected fetch in test: ${method} ${u}`);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function captureLogs(fn) {
  const lines = [];
  const origLog = console.log, origError = console.error;
  console.log = (...a) => lines.push(a.map(String).join(' '));
  console.error = (...a) => lines.push(a.map(String).join(' '));
  let error = null;
  try { await fn(); } catch (e) { error = e; } finally { console.log = origLog; console.error = origError; }
  return { output: lines.join('\n').replace(/\x1b\[[0-9;]*m/g, ''), error };
}

console.log(`\n${BOLD}${CYAN}restore --from: downloads through share-download${RESET}\n`);

{
  const { calls, restore } = installStub({
    grant: (body) => body.token === token
      ? jsonResponse(200, { url: signedUrl, use_count: 1, max_uses: 5, expires_at: shareRow.expires_at })
      : jsonResponse(404, { error: 'not_available' }),
  });
  try {
    const { output, error } = await captureLogs(() => restoreCommand({ from: token }));
    assert(error === null, `restore succeeds${error ? ` (${error.message})` : ''}`);
    const grantCall = calls.find(c => c.url.endsWith('/functions/v1/share-download'));
    assert(grantCall && JSON.parse(grantCall.body).token === token, 'asks share-download for the exact token');
    assert(calls.some(c => c.url === signedUrl), 'downloads from the signed URL');
    assert(!calls.some(c => c.url.startsWith(`${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/`)),
      'never reads the bundle straight from Storage');
    assert(!calls.some(c => c.url.includes('memoir_consume_shared_link')),
      'client does not consume a use itself (share-download did)');
    const restored = await fs.readJson(path.join(scratch, '.claude', 'settings.json')).catch(() => null);
    assert(restored?.sharedMarker === token, 'decrypts the bundle and restores its file');
    assert(/restored successfully/i.test(output), 'reports a successful restore');
  } finally { restore(); }
}

{
  const { calls, restore } = installStub({ grant: () => jsonResponse(404, { error: 'not_available' }) });
  try {
    const { output, error } = await captureLogs(() => restoreCommand({ from: token }));
    assert(error === null, 'used-up or expired link: no crash');
    assert(/no longer available/i.test(output), 'used-up or expired link: says the link is no longer available');
    assert(!calls.some(c => c.url === signedUrl || c.url.includes('/storage/v1/')), 'used-up or expired link: downloads nothing');
  } finally { restore(); }
}

{
  const offOrigin = `https://attacker.example/storage/v1/object/sign/${STORAGE_BUCKET}/${objectPath}?token=x`;
  const { calls, restore } = installStub({ grant: () => jsonResponse(200, { url: offOrigin }) });
  try {
    const { error } = await captureLogs(() => restoreCommand({ from: token }));
    assert(/unexpected download URL/i.test(String(error?.message || '')), 'off-origin grant URL: refused');
    assert(!calls.some(c => c.url === offOrigin), 'off-origin grant URL: never fetched');
  } finally { restore(); }
}

{
  const { restore } = installStub({ grant: () => jsonResponse(500, { error: 'lookup_failed' }) });
  try {
    const { error } = await captureLogs(() => restoreCommand({ from: token }));
    assert(/Download failed \(500\)/.test(String(error?.message || '')), 'share-download 500: reported as a failed download');
  } finally { restore(); }
}

await fs.remove(scratch);

console.log(`\n${BOLD}═══════════════════════════════════${RESET}`);
if (fail === 0) console.log(`${BOLD}${GREEN}  ALL ${pass} TESTS PASSED${RESET}`);
else console.log(`${BOLD}${RED}  ${fail} FAILED${RESET}, ${GREEN}${pass} passed${RESET}`);
console.log(`${BOLD}═══════════════════════════════════${RESET}\n`);

process.exit(fail);
