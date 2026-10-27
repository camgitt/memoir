#!/usr/bin/env node
// P0 data-safety regression: each account-data deletion stage must be checked.
// A failed stage must not produce a success message. Auth identity deletion
// goes through POST /functions/v1/account-delete (never Auth admin from the
// CLI); the CLI claims the login was removed only after that function confirms.
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

const TABLE_COLUMNS = {
  backups: new Set(['id', 'user_id', 'version', 'storage_path', 'size_bytes', 'file_count', 'tools', 'machine_name', 'created_at']),
  shared_links: new Set(['id', 'token', 'backup_id', 'created_by', 'tools', 'size_bytes', 'expires_at', 'max_uses', 'use_count', 'created_at']),
  subscriptions: new Set(['user_id', 'status', 'stripe_customer_id', 'stripe_subscription_id', 'current_period_end', 'created_at']),
};

function validatePostgrestColumns(urlStr) {
  const parsed = new URL(urlStr);
  const match = parsed.pathname.match(/\/rest\/v1\/(backups|shared_links|subscriptions)$/);
  if (!match) return null;
  const table = match[1];
  const allowed = TABLE_COLUMNS[table];
  for (const [key] of parsed.searchParams.entries()) {
    if (key === 'select' || key === 'limit' || key === 'order' || key === 'offset') continue;
    if (!allowed.has(key)) {
      return {
        ok: false,
        status: 400,
        body: {
          code: '42703',
          details: null,
          hint: null,
          message: `column ${table}.${key} does not exist`,
        },
      };
    }
  }
  return null;
}

function classify(url, method) {
  const u = String(url);
  if (method === 'GET' && u.includes('/rest/v1/backups') && u.includes('select=')) return 'list';
  if (method === 'GET' && u.includes('/rest/v1/subscriptions') && u.includes('select=*')) return 'plan';
  if (method === 'GET' && u.includes('/rest/v1/shared_links') && u.includes('backup_id')) return 'shared-list';
  if (method === 'GET' && u.includes('/rest/v1/shared_links')) return 'shared-check';
  if (method === 'GET' && u.includes('/rest/v1/subscriptions')) return 'subscription-check';
  if (method === 'DELETE' && u.includes(`/storage/v1/object/${STORAGE_BUCKET}`)) return 'object';
  if (method === 'DELETE' && u.includes('/rest/v1/backups?id=eq.')) return 'row';
  if (method === 'DELETE' && u.includes('/rest/v1/shared_links')) return 'shared';
  if (method === 'DELETE' && u.includes('/rest/v1/subscriptions')) return 'subscription';
  if (method === 'POST' && u.includes('/functions/v1/account-delete')) return 'account-delete';
  if (u.includes('/auth/v1/admin') || (method === 'DELETE' && u.includes('/auth/v1/'))) return 'auth-identity';
  return 'other';
}

function hasPreferRepresentation(headers = {}) {
  const prefer = headers.Prefer || headers.prefer || '';
  return String(prefer).includes('return=representation');
}

function installDeleteStub(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const kind = classify(url, method);
    const entry = { method, url: String(url), kind, body: options.body || null, headers: options.headers || {} };
    calls.push(entry);
    const schemaErr = validatePostgrestColumns(String(url));
    if (schemaErr) return jsonRes(schemaErr);
    return handler(entry, jsonRes);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function defaultHandler(failKind, failStatus = 500) {
  let objectDeletes = 0;
  let rowDeletes = 0;
  return (entry, respond) => {
    if (entry.kind === 'auth-identity') {
      throw new Error('CLI must not call Auth admin APIs; use /functions/v1/account-delete');
    }
    if (entry.kind === 'account-delete') {
      if (failKind === 'account-delete') return respond({ ok: false, status: failStatus, body: { error: 'delete_failed' } });
      if (failKind === 'account-delete-shape') return respond({ ok: true, status: 200, body: { ok: true } });
      if (failKind === 'account-delete-pro') {
        return respond({
          ok: false,
          status: 409,
          body: { error: 'subscription_active', message: 'Cancel your Pro subscription before deleting your account.' },
        });
      }
      return respond({ ok: true, status: 200, body: { deleted: true, id: session.user.id } });
    }
    if (entry.kind === 'plan') {
      // Production gives every user a subscriptions row; Stripe sets status.
      if (failKind === 'plan-fail') return respond({ ok: false, status: failStatus, body: { message: 'plan lookup failed' } });
      const status = failKind === 'plan-pro' ? 'pro' : 'free';
      return respond({ ok: true, status: 200, body: [{ user_id: session.user.id, status }] });
    }
    if (entry.kind === 'shared-list') {
      if (failKind === 'shared-list') return respond({ ok: false, status: failStatus, body: { message: 'shared-link list failed' } });
      return respond({ ok: true, status: 200, body: [{ id: 'share-1', backup_id: `${session.user.id}/shares/share-1.gz` }] });
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
      if (failKind === 'shared-object' && objectDeletes === 3) {
        return respond({ ok: false, status: failStatus, body: 'shared bundle delete failed' });
      }
      return respond({ ok: true, status: 200, body: [{ name: 'deleted' }] });
    }
    if (entry.kind === 'row') {
      rowDeletes += 1;
      if (failKind === 'row' && rowDeletes === 1) {
        return respond({ ok: false, status: failStatus, body: 'row delete failed' });
      }
      if (failKind === 'row-rls-204' && rowDeletes === 1) {
        return respond({ ok: true, status: 204, body: '' });
      }
      if (failKind === 'row-rls-empty' && rowDeletes === 1) {
        return respond({ ok: true, status: 200, body: [] });
      }
      if (!hasPreferRepresentation(entry.headers)) {
        return respond({ ok: true, status: 204, body: '' });
      }
      return respond({ ok: true, status: 200, body: [backups[rowDeletes - 1] || backups[0]] });
    }
    if (entry.kind === 'shared') {
      if (failKind === 'shared') return respond({ ok: false, status: failStatus, body: 'shared-link delete failed' });
      if (failKind === 'shared-rls-204') return respond({ ok: true, status: 204, body: '' });
      if (failKind === 'shared-rls-empty') return respond({ ok: true, status: 200, body: [] });
      if (!hasPreferRepresentation(entry.headers)) {
        return respond({ ok: true, status: 204, body: '' });
      }
      return respond({
        ok: true,
        status: 200,
        body: [{ id: 'share-1', created_by: session.user.id, backup_id: `${session.user.id}/shares/share-1.gz` }],
      });
    }
    if (entry.kind === 'shared-check') {
      if (failKind === 'shared-rls-empty') {
        return respond({ ok: true, status: 200, body: [{ id: 'share-1' }] });
      }
      return respond({ ok: true, status: 200, body: [] });
    }
    if (entry.kind === 'subscription') {
      if (failKind === 'subscription') return respond({ ok: false, status: failStatus, body: 'subscription delete failed' });
      if (failKind === 'subscription-rls-204') return respond({ ok: true, status: 204, body: '' });
      if (failKind === 'subscription-rls-empty') return respond({ ok: true, status: 200, body: [] });
      if (!hasPreferRepresentation(entry.headers)) {
        return respond({ ok: true, status: 204, body: '' });
      }
      return respond({ ok: true, status: 200, body: [{ user_id: session.user.id, status: 'free' }] });
    }
    if (entry.kind === 'subscription-check') {
      if (failKind === 'subscription-rls-empty') {
        return respond({ ok: true, status: 200, body: [{ user_id: session.user.id }] });
      }
      return respond({ ok: true, status: 200, body: [] });
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
  { failKind: 'shared-list', failStatus: 503, name: 'shared-link enumeration (GET 503)', stopBefore: ['shared', 'subscription'] },
  { failKind: 'shared-object', failStatus: 500, name: 'shared bundle deletion (DELETE 500)', stopBefore: ['shared', 'subscription'] },
  { failKind: 'shared', failStatus: 429, name: 'shared-link deletion (DELETE 429)', stopBefore: ['subscription', 'account-delete'] },
  { failKind: 'subscription', failStatus: 401, name: 'subscription deletion (DELETE 401)', stopBefore: ['account-delete'] },
  { failKind: 'account-delete', failStatus: 502, name: 'auth identity deletion (POST 502)', stopBefore: [] },
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
    assert(!calls.some(c => c.kind === 'auth-identity'), `${stage.name}: does not call Auth admin APIs`);
    if (stage.failKind !== 'account-delete') {
      assert(!calls.some(c => c.kind === 'account-delete'), `${stage.name}: does not delete the Auth identity after a failed data stage`);
    }
    assert(String(err?.message || '').includes(String(stage.failStatus)), `${stage.name}: error names HTTP ${stage.failStatus}`);
  } finally { restore(); }
}

console.log(`\n${BOLD}${CYAN}deleteAccount: schema validation & silent RLS 0-row failures${RESET}\n`);

{
  // Verify the fake PostgREST validator rejects unknown columns with 400 42703
  const badCol = validatePostgrestColumns(`${SUPABASE_URL}/rest/v1/shared_links?user_id=eq.user-123`);
  assert(badCol && badCol.status === 400 && badCol.body.code === '42703',
    'fake PostgREST rejects shared_links?user_id=eq.* with 400 42703');
  const goodCol = validatePostgrestColumns(`${SUPABASE_URL}/rest/v1/shared_links?created_by=eq.user-123`);
  assert(goodCol === null, 'fake PostgREST accepts shared_links?created_by=eq.*');
}

const RLS_ZERO_ROW_CASES = [
  { failKind: 'row-rls-204', name: 'backup row DELETE returning 204 without representation' },
  { failKind: 'row-rls-empty', name: 'backup row DELETE returning 200 [] (0 rows removed under RLS)' },
  { failKind: 'shared-rls-204', name: 'shared_links DELETE returning 204 without representation' },
  { failKind: 'shared-rls-empty', name: 'shared_links DELETE returning 200 [] while row still exists under RLS' },
  { failKind: 'subscription-rls-204', name: 'subscriptions DELETE returning 204 without representation' },
  { failKind: 'subscription-rls-empty', name: 'subscriptions DELETE returning 200 [] while row still exists under RLS' },
];

for (const rlsCase of RLS_ZERO_ROW_CASES) {
  await seedAuthFile();
  const { restore } = installDeleteStub(defaultHandler(rlsCase.failKind));
  try {
    let err = null;
    try { await deleteAccount(session); } catch (e) { err = e; }
    assert(!!err, `${rlsCase.name}: throws`);
    assert(/204|0 rows removed/i.test(String(err?.message || '')), `${rlsCase.name}: error explains missing representation or 0 rows removed`);
    assert(await fs.pathExists(AUTH_FILE), `${rlsCase.name}: local session is retained`);
  } finally { restore(); }
}

{
  await seedAuthFile();
  const { calls, restore } = installDeleteStub((entry, respond) => {
    if (entry.kind === 'plan') {
      return respond({ ok: true, status: 200, body: [{ user_id: session.user.id, status: 'free' }] });
    }
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

console.log(`\n${BOLD}${CYAN}deleteAccount: a paying or unreadable plan stops before any delete${RESET}\n`);

const DESTRUCTIVE = ['object', 'row', 'shared', 'subscription', 'account-delete', 'auth-identity'];
for (const planCase of [
  { failKind: 'plan-pro', name: 'active Pro subscription', message: /hello@memoir\.sh/ },
  { failKind: 'plan-fail', failStatus: 503, name: 'plan lookup failure (GET 503)', message: /503/ },
]) {
  await seedAuthFile();
  const { calls, restore } = installDeleteStub(defaultHandler(planCase.failKind, planCase.failStatus));
  try {
    let err = null;
    try { await deleteAccount(session); } catch (e) { err = e; }
    assert(!!err, `${planCase.name}: throws`);
    assert(/Nothing was deleted/.test(String(err?.message || '')), `${planCase.name}: says nothing was deleted`);
    assert(planCase.message.test(String(err?.message || '')), `${planCase.name}: error explains the stop`);
    assert(!calls.some(c => DESTRUCTIVE.includes(c.kind)), `${planCase.name}: makes no destructive call`);
    assert(await fs.pathExists(AUTH_FILE), `${planCase.name}: local session is retained`);
  } finally { restore(); }
}

{
  await seedAuthFile();
  const { calls, restore } = installDeleteStub(defaultHandler('shared-object', 500));
  try {
    try { await deleteAccount(session); } catch {}
    assert(calls.some(c => c.kind === 'shared-list'), 'shared bundles: rows are listed before anything is deleted');
    assert(!calls.some(c => c.kind === 'shared'),
      'shared bundle deletion failure: shared_links rows are kept so a retry can find the bundle');
  } finally { restore(); }
}

console.log(`\n${BOLD}${CYAN}deleteAccount: success deletes Auth identity via hosted function${RESET}\n`);

{
  await seedAuthFile();
  const { calls, restore } = installDeleteStub(defaultHandler(null));
  try {
    const result = await deleteAccount(session);
    assert(result && result.authUserDeleted === true, 'success result sets authUserDeleted: true');
    assert(result && result.localDataDeleted === true, 'success result reports cloud data deletion');
    const identityCall = calls.find(c => c.kind === 'account-delete');
    assert(!!identityCall, 'success path POSTs /functions/v1/account-delete');
    assert(identityCall.url === `${SUPABASE_URL}/functions/v1/account-delete`, 'identity deletion uses the hosted account-delete function');
    assert(String(identityCall.headers.Authorization || '').includes(session.access_token), 'identity deletion sends the user JWT, not a service-role key');
    assert(!calls.some(c => c.kind === 'auth-identity'), 'success path never calls Auth admin APIs from the CLI');
    assert(calls.findIndex(c => c.kind === 'account-delete') > calls.findIndex(c => c.kind === 'subscription'),
      'identity deletion runs after data deletion');
    assert(!await fs.pathExists(AUTH_FILE), 'success path signs this device out locally');

    const sharedCall = calls.find(c => c.kind === 'shared');
    assert(sharedCall && sharedCall.url.includes('created_by=eq.'),
      'shared_links deletion filters by created_by (not non-existent user_id)');

    const objectCalls = calls.filter(c => c.kind === 'object');
    assert(objectCalls.length === 3, 'success path deletes both backup objects and shared bundle object');
    const objectCall = objectCalls[0];
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

{
  await seedAuthFile();
  const { calls, restore } = installDeleteStub(defaultHandler('account-delete-shape'));
  try {
    let err = null;
    try { await deleteAccount(session); } catch (e) { err = e; }
    assert(!!err, 'identity response without deleted:true: throws');
    assert(/unexpected response/i.test(String(err?.message || '')), 'identity response without deleted:true: names the shape failure');
    assert(await fs.pathExists(AUTH_FILE), 'identity response without deleted:true: local session is retained');
    assert(!calls.some(c => c.kind === 'auth-identity'), 'identity response without deleted:true: still no Auth admin call');
  } finally { restore(); }
}

{
  await seedAuthFile();
  const { restore } = installDeleteStub(defaultHandler('account-delete-pro'));
  try {
    let err = null;
    try { await deleteAccount(session); } catch (e) { err = e; }
    assert(!!err, 'hosted function 409 subscription_active: throws');
    assert(/Cancel your Pro subscription/i.test(String(err?.message || '')),
      'hosted function 409: tells the user to cancel Pro first');
    assert(await fs.pathExists(AUTH_FILE), 'hosted function 409: local session is retained');
  } finally { restore(); }
}

console.log(`\n${BOLD}${CYAN}deleteAccountCommand: success claims identity deletion only after the function confirms${RESET}\n`);

{
  await seedAuthFile();
  const { restore } = installDeleteStub(defaultHandler(null));
  try {
    const output = await captureLogs(() => deleteAccountCommand({ confirm: true }));
    const text = stripAnsi(output);
    assert(/✔\s*Account deleted/i.test(text), 'success output reports the account was deleted');
    assert(/login were removed/i.test(text.replace(/\s+/g, ' ')), 'success output says the login was removed');
    assert(!/may still exist/i.test(text), 'success output does not warn that the Auth identity may still exist');
    assert(!/hosted account-deletion service/i.test(text),
      'success output does not claim a vaguely named hosted account-deletion service');
    assert(claimsAuthIdentityDeleted(output),
      'success output claims the account/login was deleted');
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

{
  const fnSrc = await fs.readFile(new URL('./supabase/functions/account-delete/index.ts', import.meta.url), 'utf8');
  assert(/auth\.admin\.deleteUser\(/.test(fnSrc), 'hosted function deletes only the JWT subject');
  assert(!/body\?\.id|body\?\.user/.test(fnSrc), 'hosted function does not take a user id from the request body');
  assert(/SUPABASE_SERVICE_ROLE_KEY/.test(fnSrc), 'hosted function holds the service role on the server');
}

await fs.remove(scratch);

console.log(`\n${BOLD}═══════════════════════════════════${RESET}`);
if (fail === 0) console.log(`${BOLD}${GREEN}  ALL ${pass} TESTS PASSED${RESET}`);
else console.log(`${BOLD}${RED}  ${fail} FAILED${RESET}, ${GREEN}${pass} passed${RESET}`);
console.log(`${BOLD}═══════════════════════════════════${RESET}\n`);

process.exit(fail);
