#!/usr/bin/env node
// P0 data-safety regression: each account-data deletion stage must be checked.
// A failed stage must not produce a success message, and the CLI must never
// claim the Auth identity was deleted when the client cannot prove that.
//
// No real network: globalThis.fetch is stubbed. HOME is shimmed before any
// ./src import so auth.js binds AUTH_FILE inside the scratch directory.

import fs from 'fs-extra';
import path from 'path';
import os from 'os';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-acct-del-fail-closed-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.APPDATA = path.join(scratch, 'AppData', 'Roaming');
process.env.XDG_CONFIG_HOME = path.join(scratch, '.config');

const { deleteAccount, AUTH_FILE } = await import('./src/cloud/auth.js');
const { deleteAccountCommand } = await import('./src/commands/login.js');
const { SUPABASE_URL, STORAGE_BUCKET } = await import('./src/cloud/constants.js');

const session = { user: { id: 'user-123', email: 'user@example.com' }, access_token: 'tok' };

const backups = [
  { id: 'id-0', storage_path: `${session.user.id}/b-0.gz` },
  { id: 'id-1', storage_path: `${session.user.id}/b-1.gz` },
];

function jsonRes({ ok, status, body = '' }) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body ?? ''),
  };
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function claimsAuthIdentityDeleted(text) {
  const t = stripAnsi(text);
  return /✔\s*Account deleted/i.test(t)
    || /authentication identity (?:was |has been )?deleted/i.test(t)
    || /auth(?:entication)? (?:user|account) (?:was |has been )?deleted/i.test(t)
    || /your account has been deleted/i.test(t);
}

function claimsDeletionSucceeded(text) {
  const t = stripAnsi(text);
  return /Memoir cloud data deleted/i.test(t)
    || /✔\s*Account deleted/i.test(t)
    || /All backups, shared links, and data have been removed/i.test(t);
}

async function seedAuthFile() {
  await fs.ensureDir(path.dirname(AUTH_FILE));
  await fs.writeJson(AUTH_FILE, {
    access_token: session.access_token,
    refresh_token: 'refresh-tok',
    expires_at: Date.now() + 60 * 60 * 1000,
    user: session.user,
  });
}

function classify(url, method) {
  const u = String(url);
  if (method === 'GET' && u.includes('/rest/v1/backups') && u.includes('select=')) return 'list';
  if (method === 'DELETE' && u.includes(`/storage/v1/object/${STORAGE_BUCKET}`)) return 'object';
  if (method === 'DELETE' && u.includes('/rest/v1/backups?id=eq.')) return 'row';
  if (method === 'DELETE' && u.includes('/rest/v1/shared_links')) return 'shared';
  if (method === 'DELETE' && u.includes('/rest/v1/subscriptions')) return 'subscription';
  if (u.includes('/auth/v1/admin') || (method === 'DELETE' && u.includes('/auth/v1/'))) return 'auth-identity';
  return 'other';
}

function installDeleteStub(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const kind = classify(url, method);
    const entry = { method, url: String(url), kind, body: options.body || null, headers: options.headers || {} };
    calls.push(entry);
    return handler(entry, jsonRes);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function defaultHandler(failKind, failStatus = 500) {
  let objectDeletes = 0;
  let rowDeletes = 0;
  return (entry, respond) => {
    if (entry.kind === 'auth-identity') {
      return respond({ ok: true, status: 200, body: {} });
    }
    if (entry.kind === 'list') {
      if (failKind === 'list') return respond({ ok: false, status: failStatus, body: { message: 'list failed' } });
      return respond({ ok: true, status: 200, body: backups });
    }
    if (entry.kind === 'object') {
      objectDeletes += 1;
      if (failKind === 'object' && objectDeletes === 1) {
        return respond({ ok: false, status: failStatus, body: 'object delete failed' });
      }
      if (failKind === 'object-second' && objectDeletes === 2) {
        return respond({ ok: false, status: failStatus, body: 'object delete failed' });
      }
      return respond({ ok: true, status: 200, body: '' });
    }
    if (entry.kind === 'row') {
      rowDeletes += 1;
      if (failKind === 'row' && rowDeletes === 1) {
        return respond({ ok: false, status: failStatus, body: 'row delete failed' });
      }
      return respond({ ok: true, status: 200, body: '' });
    }
    if (entry.kind === 'shared') {
      if (failKind === 'shared') return respond({ ok: false, status: failStatus, body: 'shared-link delete failed' });
      return respond({ ok: true, status: 200, body: '' });
    }
    if (entry.kind === 'subscription') {
      if (failKind === 'subscription') return respond({ ok: false, status: failStatus, body: 'subscription delete failed' });
      return respond({ ok: true, status: 200, body: '' });
    }
    throw new Error(`Unexpected fetch in test: ${entry.method} ${entry.url}`);
  };
}

async function captureLogs(fn) {
  const lines = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origError;
  }
  return lines.join('\n');
}

const STAGES = [
  { failKind: 'list', failStatus: 500, name: 'backup enumeration (GET 500)', stopBefore: ['object', 'row', 'shared', 'subscription'] },
  { failKind: 'object', failStatus: 500, name: 'backup object deletion (DELETE 500)', stopBefore: ['shared', 'subscription'] },
  { failKind: 'row', failStatus: 403, name: 'backup metadata deletion (DELETE 403)', stopBefore: ['shared', 'subscription'] },
  { failKind: 'shared', failStatus: 429, name: 'shared-link deletion (DELETE 429)', stopBefore: ['subscription'] },
  { failKind: 'subscription', failStatus: 401, name: 'subscription deletion (DELETE 401)', stopBefore: [] },
];

console.log(`\n${BOLD}${CYAN}deleteAccount: each failed stage stops and does not log out${RESET}\n`);

for (const stage of STAGES) {
  await seedAuthFile();
  const { calls, restore } = installDeleteStub(defaultHandler(stage.failKind, stage.failStatus));
  try {
    let err = null;
    let result = undefined;
    try {
      result = await deleteAccount(session);
    } catch (e) {
      err = e;
    }
    assert(!!err, `${stage.name}: throws`);
    assert(result === undefined, `${stage.name}: does not return a success result`);
    assert(await fs.pathExists(AUTH_FILE), `${stage.name}: local session is retained so the user can retry`);
    for (const kind of stage.stopBefore) {
      assert(!calls.some(c => c.kind === kind), `${stage.name}: does not continue to ${kind} deletion`);
    }
    assert(!calls.some(c => c.kind === 'auth-identity'), `${stage.name}: does not attempt Auth-user deletion`);
    assert(String(err?.message || '').includes(String(stage.failStatus)), `${stage.name}: error names HTTP ${stage.failStatus}`);
  } finally { restore(); }
}

{
  await seedAuthFile();
  const { calls, restore } = installDeleteStub((entry, respond) => {
    if (entry.kind === 'list') {
      return respond({
        ok: true,
        status: 200,
        body: [{ id: 'id-x', storage_path: 'other-user/secret.gz' }],
      });
    }
    throw new Error(`Unexpected fetch after unsafe path: ${entry.method} ${entry.url}`);
  });
  try {
    let err = null;
    try { await deleteAccount(session); } catch (e) { err = e; }
    assert(!!err, 'unsafe backup path: throws');
    assert(/unsafe backup path/i.test(String(err?.message || '')), 'unsafe backup path: names the safety stop');
    assert(!calls.some(c => c.kind === 'object' || c.kind === 'row' || c.kind === 'shared' || c.kind === 'subscription'),
      'unsafe backup path: no destructive follow-up calls');
    assert(await fs.pathExists(AUTH_FILE), 'unsafe backup path: local session is retained');
  } finally { restore(); }
}

{
  await seedAuthFile();
  const { calls, restore } = installDeleteStub(defaultHandler('object-second', 500));
  try {
    let err = null;
    try { await deleteAccount(session); } catch (e) { err = e; }
    assert(!!err, 'second object deletion failure: throws');
    const objectCalls = calls.filter(c => c.kind === 'object');
    const rowCalls = calls.filter(c => c.kind === 'row');
    assert(objectCalls.length === 2, 'second object deletion failure: first object was already attempted');
    assert(rowCalls.length === 1, 'second object deletion failure: does not delete the second metadata row');
    assert(!calls.some(c => c.kind === 'shared' || c.kind === 'subscription'),
      'second object deletion failure: does not continue past backups');
  } finally { restore(); }
}

console.log(`\n${BOLD}${CYAN}deleteAccount: success does not claim Auth-user deletion${RESET}\n`);

{
  await seedAuthFile();
  const { calls, restore } = installDeleteStub(defaultHandler(null));
  try {
    const result = await deleteAccount(session);
    assert(result && result.authUserDeleted === false, 'success result sets authUserDeleted: false');
    assert(result && result.localDataDeleted === true, 'success result reports local/cloud data deletion only');
    assert(!calls.some(c => c.kind === 'auth-identity'), 'success path never calls Auth admin/user deletion');
    assert(!await fs.pathExists(AUTH_FILE), 'success path signs this device out locally');

    const objectCall = calls.find(c => c.kind === 'object');
    assert(!!objectCall, 'success path deletes storage objects');
    assert(objectCall && objectCall.url === `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}`,
      'storage deletion uses the bucket endpoint, not the download URL');
    let prefixesOk = false;
    try {
      const parsed = JSON.parse(objectCall?.body);
      prefixesOk = Array.isArray(parsed.prefixes) && parsed.prefixes[0] === backups[0].storage_path;
    } catch { prefixesOk = false; }
    assert(prefixesOk, 'storage deletion uses the validated prefixes JSON body');
  } finally { restore(); }
}

console.log(`\n${BOLD}${CYAN}deleteAccountCommand: no false success message${RESET}\n`);

{
  await seedAuthFile();
  const { restore } = installDeleteStub(defaultHandler(null));
  try {
    const output = await captureLogs(() => deleteAccountCommand({ confirm: true }));
    assert(/authentication identity may still exist/i.test(stripAnsi(output)),
      'success output warns that the Auth identity may still exist');
    assert(/hosted account-deletion service/i.test(stripAnsi(output)),
      'success output points at the hosted Auth-deletion service');
    assert(!claimsAuthIdentityDeleted(output),
      'success output does not claim the Auth identity was deleted');
    assert(!/✔\s*Account deleted\.?/i.test(stripAnsi(output)),
      'success output does not use the old "Account deleted." headline');
  } finally { restore(); }
}

for (const stage of STAGES) {
  await seedAuthFile();
  const { restore } = installDeleteStub(defaultHandler(stage.failKind, stage.failStatus));
  try {
    const output = await captureLogs(() => deleteAccountCommand({ confirm: true }));
    const text = stripAnsi(output);
    assert(/Deletion incomplete/i.test(text), `${stage.name}: CLI reports deletion incomplete`);
    assert(!claimsDeletionSucceeded(output), `${stage.name}: CLI does not print a deletion-success message`);
    assert(!claimsAuthIdentityDeleted(output), `${stage.name}: CLI does not claim the Auth identity was deleted`);
    assert(await fs.pathExists(AUTH_FILE), `${stage.name}: CLI failure keeps the local session`);
  } finally { restore(); }
}

await fs.remove(scratch);

console.log(`\n${BOLD}═══════════════════════════════════${RESET}`);
if (fail === 0) console.log(`${BOLD}${GREEN}  ALL ${pass} TESTS PASSED${RESET}`);
else console.log(`${BOLD}${RED}  ${fail} FAILED${RESET}, ${GREEN}${pass} passed${RESET}`);
console.log(`${BOLD}═══════════════════════════════════${RESET}\n`);

process.exit(fail);
