#!/usr/bin/env node
// P0 data-safety regression: subscription lookup failures must fail closed.
// An unknown plan must NOT be treated as Free, and retention cleanup must
// delete zero backups until the plan is verified.
//
// Driven through the same getSubscription → cleanupOldBackups sequence that
// cloudPushCommand uses. No real network: globalThis.fetch is stubbed.
//
// HOME is shimmed before any ./src import so auth.js binds AUTH_FILE inside
// the scratch directory (it captures os.homedir() at module load).

import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { console.log(`  ${GREEN}PASS${RESET} ${msg}`); pass++; }
  else      { console.log(`  ${RED}FAIL${RESET} ${msg}`); fail++; }
}

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-sub-fail-closed-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.APPDATA = path.join(scratch, 'AppData', 'Roaming');
process.env.XDG_CONFIG_HOME = path.join(scratch, '.config');

const { getSubscription } = await import('./src/cloud/auth.js');
const { cleanupOldBackups } = await import('./src/cloud/storage.js');
const { MAX_BACKUPS_FREE, MAX_BACKUPS_PRO, SUPABASE_URL, STORAGE_BUCKET } = await import('./src/cloud/constants.js');

const session = { user: { id: 'user-123' }, access_token: 'tok' };
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeBackups(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, n - i)).toISOString();
    out.push({ id: `id-${i}`, storage_path: `${session.user.id}/b-${i}.gz`, created_at: ts });
  }
  return out;
}

function jsonRes({ ok, status, body }) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body ?? ''),
  };
}

// Overflow lives between Free and Pro limits so a silent downgrade to Free
// would prune, while a verified Pro plan would not.
const OVERFLOW_COUNT = MAX_BACKUPS_FREE + 7;
const overflowBackups = makeBackups(OVERFLOW_COUNT);

function installFetchStub({ subscription, backups = overflowBackups }) {
  const deleted = { storage: [], rows: [] };
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase();
    const u = String(url);
    calls.push({ method, url: u });

    if (method === 'GET' && u.includes('/rest/v1/subscriptions')) {
      if (typeof subscription === 'function') return subscription();
      throw new Error('subscription stub missing');
    }
    if (method === 'GET' && u.includes('/rest/v1/backups')) {
      return jsonRes({ ok: true, status: 200, body: backups });
    }
    if (method === 'DELETE' && u.includes(`/storage/v1/object/${STORAGE_BUCKET}`)) {
      if (options.body) {
        const parsed = JSON.parse(options.body);
        if (Array.isArray(parsed.prefixes)) deleted.storage.push(...parsed.prefixes);
      } else {
        const suffix = u.split(`/storage/v1/object/${STORAGE_BUCKET}/`)[1];
        if (suffix) deleted.storage.push(decodeURIComponent(suffix));
      }
      return jsonRes({ ok: true, status: 200, body: '' });
    }
    if (method === 'DELETE' && u.includes('/rest/v1/backups?id=eq.')) {
      deleted.rows.push(decodeURIComponent(u.split('id=eq.')[1]));
      return jsonRes({ ok: true, status: 200, body: '' });
    }
    throw new Error(`Unexpected fetch in test: ${method} ${u}`);
  };
  return { deleted, calls, restore: () => { globalThis.fetch = original; } };
}

// Same sequence cloudPushCommand uses: verify plan, then prune with that plan.
async function pruneUsingVerifiedPlan() {
  const sub = await getSubscription(session);
  return cleanupOldBackups(session, sub.status === 'pro');
}

function abortTimeout() {
  const err = new Error('The operation was aborted due to timeout');
  err.name = 'AbortError';
  return err;
}

function networkTimeout() {
  const err = new Error('fetch failed');
  err.cause = { code: 'ETIMEDOUT' };
  return err;
}

const LOOKUP_FAILURES = [
  { name: '401', kind: 'http', status: 401, body: { message: 'unauthorized' } },
  { name: '403', kind: 'http', status: 403, body: { message: 'forbidden' } },
  { name: '429', kind: 'http', status: 429, body: { message: 'rate limited' } },
  { name: '500', kind: 'http', status: 500, body: { message: 'internal error' } },
  { name: '408 timeout status', kind: 'http', status: 408, body: { message: 'request timeout' } },
  { name: 'AbortError timeout', kind: 'reject', error: abortTimeout() },
  { name: 'network timeout (ETIMEDOUT)', kind: 'reject', error: networkTimeout() },
  { name: 'non-array 200 body', kind: 'http', status: 200, ok: true, body: { status: 'free' } },
];

console.log(`\n${BOLD}${CYAN}getSubscription fail-closed (unknown plan ≠ Free)${RESET}\n`);

for (const case_ of LOOKUP_FAILURES) {
  const { deleted, restore } = installFetchStub({
    subscription: () => {
      if (case_.kind === 'reject') throw case_.error;
      const ok = case_.ok ?? false;
      return jsonRes({ ok, status: case_.status, body: case_.body });
    },
  });
  try {
    let result = undefined;
    let err = null;
    try {
      result = await getSubscription(session);
    } catch (e) {
      err = e;
    }
    assert(!!err, `${case_.name}: throws instead of guessing a plan`);
    assert(result === undefined, `${case_.name}: does not return a plan object`);
    assert(!(result && result.status === 'free'), `${case_.name}: does not treat unknown plan as Free`);
    if (case_.kind === 'http' && case_.ok !== true) {
      assert(String(err?.message || '').includes(String(case_.status)), `${case_.name}: error names HTTP ${case_.status}`);
      assert(String(err?.message || '').toLowerCase().includes('not pruned'), `${case_.name}: error says backups were not pruned`);
    }
    assert(deleted.rows.length === 0 && deleted.storage.length === 0, `${case_.name}: lookup itself issues zero deletions`);
  } finally { restore(); }
}

console.log(`\n${BOLD}${CYAN}retention cleanup: zero deletions when plan cannot be verified${RESET}\n`);

assert(
  OVERFLOW_COUNT > MAX_BACKUPS_FREE && OVERFLOW_COUNT < MAX_BACKUPS_PRO,
  `overflow fixture (${OVERFLOW_COUNT}) is above Free (${MAX_BACKUPS_FREE}) and below Pro (${MAX_BACKUPS_PRO}) so a Free downgrade would prune`
);

for (const case_ of LOOKUP_FAILURES) {
  const { deleted, restore } = installFetchStub({
    subscription: () => {
      if (case_.kind === 'reject') throw case_.error;
      const ok = case_.ok ?? false;
      return jsonRes({ ok, status: case_.status, body: case_.body });
    },
  });
  try {
    let pruned = null;
    let err = null;
    try {
      pruned = await pruneUsingVerifiedPlan();
    } catch (e) {
      err = e;
    }
    assert(!!err, `${case_.name}: verified-plan retention throws`);
    assert(pruned === null, `${case_.name}: cleanupOldBackups is not reached`);
    assert(deleted.rows.length === 0, `${case_.name}: zero metadata retention deletions (got ${deleted.rows.length})`);
    assert(deleted.storage.length === 0, `${case_.name}: zero storage retention deletions (got ${deleted.storage.length})`);
  } finally { restore(); }
}

console.log(`\n${BOLD}${CYAN}verified plans still prune at the matching limit${RESET}\n`);

{
  const { deleted, restore } = installFetchStub({
    subscription: () => jsonRes({ ok: true, status: 200, body: [] }),
  });
  try {
    const n = await pruneUsingVerifiedPlan();
    assert(n === OVERFLOW_COUNT - MAX_BACKUPS_FREE, 'empty subscription row is Free and prunes Free overflow');
    assert(deleted.rows.length === OVERFLOW_COUNT - MAX_BACKUPS_FREE, 'verified Free: overflow rows deleted');
  } finally { restore(); }
}

{
  const { deleted, restore } = installFetchStub({
    subscription: () => jsonRes({ ok: true, status: 200, body: [{ status: 'pro', user_id: session.user.id }] }),
  });
  try {
    const n = await pruneUsingVerifiedPlan();
    assert(n === 0, 'verified Pro does not prune a count that only exceeds Free');
    assert(deleted.rows.length === 0 && deleted.storage.length === 0, 'verified Pro: zero deletions below Pro limit');
  } finally { restore(); }
}

console.log(`\n${BOLD}${CYAN}cloud push source: no catch-as-Free before retention${RESET}\n`);

{
  const cloudSrc = await fs.readFile(path.join(__dirname, 'src', 'commands', 'cloud.js'), 'utf8');
  const pushStart = cloudSrc.indexOf('export async function cloudPushCommand');
  const pushEnd = cloudSrc.indexOf('export async function cloudRestoreCommand');
  const pushSrc = pushStart >= 0 && pushEnd > pushStart ? cloudSrc.slice(pushStart, pushEnd) : '';
  assert(pushSrc.includes('const sub = await getSubscription(session);'), 'cloudPushCommand awaits getSubscription before retention');
  assert(pushSrc.includes('cleanupOldBackups(session, isPro)'), 'cloudPushCommand passes the verified isPro flag to cleanup');
  const afterLookup = pushSrc.slice(pushSrc.indexOf('getSubscription'));
  const catchBeforeCleanup = afterLookup.indexOf('catch') !== -1
    && afterLookup.indexOf('catch') < afterLookup.indexOf('cleanupOldBackups');
  const catchAsFree = /catch[\s\S]{0,200}(status:\s*['"]free['"]|isPro\s*=\s*false)/.test(afterLookup.slice(0, afterLookup.indexOf('cleanupOldBackups') + 1));
  assert(!catchBeforeCleanup || !catchAsFree, 'cloudPushCommand does not catch a failed plan lookup as Free before cleanup');
}

await fs.remove(scratch);

console.log(`\n${BOLD}═══════════════════════════════════${RESET}`);
if (fail === 0) console.log(`${BOLD}${GREEN}  ALL ${pass} TESTS PASSED${RESET}`);
else console.log(`${BOLD}${RED}  ${fail} FAILED${RESET}, ${GREEN}${pass} passed${RESET}`);
console.log(`${BOLD}═══════════════════════════════════${RESET}\n`);

process.exit(fail);
