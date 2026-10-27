#!/usr/bin/env node
// Expired and exhausted share bundles are purged through the Storage API,
// then rows are deleted only for confirmed paths. Forged backup_id values
// are ignored. No live database.
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memoir-purge-test-'));
process.env.HOME = scratch;
process.env.USERPROFILE = scratch;
process.env.APPDATA = path.join(scratch, 'AppData', 'Roaming');

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ${GREEN}PASS${RESET} ${msg}`); }
  else { fail++; console.log(`  ${RED}FAIL${RESET} ${msg}`); }
}

const root = path.dirname(fileURLToPath(import.meta.url));
const {
  canonicalSharePath,
  isTrustedSharePath,
  isDueForPurge,
  selectPurgeableShares,
  purgeExpiredShares,
  secretsEqual,
  dueShareOrFilter,
  SHARE_BUCKET,
  PURGE_PAGE_SIZE,
  REMOVE_BATCH_SIZE,
} = await import('./supabase/functions/purge-expired-shares/logic.js');
const { normalizeShareExpiresHours, MAX_SHARE_EXPIRES_HOURS } = await import('./src/commands/share.js');

const now = new Date('2026-10-27T12:00:00.000Z');
const owner = '11111111-1111-4111-8111-111111111111';
const victim = '22222222-2222-4222-8222-222222222222';
const token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const victimToken = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function link(overrides = {}) {
  const created_by = overrides.created_by ?? owner;
  const tok = overrides.token ?? token;
  return {
    id: overrides.id ?? 'row-1',
    created_by,
    token: tok,
    backup_id: overrides.backup_id ?? canonicalSharePath(created_by, tok),
    expires_at: overrides.expires_at ?? '2026-10-28T12:00:00.000Z',
    use_count: overrides.use_count ?? 0,
    max_uses: overrides.max_uses ?? 5,
  };
}

async function runPurge(rows, { removeError = null, failRemove = false } = {}) {
  const removedCalls = [];
  const deletedIds = [];
  const result = await purgeExpiredShares({
    now,
    listShares: async () => rows,
    removeObjects: async (paths) => {
      removedCalls.push(paths.slice());
      if (failRemove) return { removed: [], error: removeError || new Error('storage failed') };
      return { removed: paths };
    },
    deleteShareRows: async (ids) => {
      deletedIds.push(...ids);
      return {};
    },
  });
  return { result, removedCalls, deletedIds };
}

console.log(`\n${BOLD}${CYAN}expired/exhausted share purge (Storage API)${RESET}\n`);

assert(SHARE_BUCKET === 'memoir-backups', 'purge targets the memoir-backups bucket');
assert(canonicalSharePath(owner, token) === `${owner}/shares/${token}.gz`, 'canonical path is created_by/shares/token.gz');
assert(canonicalSharePath(owner, '../etc/passwd') === null, 'canonical path rejects a non-UUID token');
assert(canonicalSharePath('not-a-uuid', token) === null, 'canonical path rejects a non-UUID created_by');
assert(isTrustedSharePath(link()), 'row whose backup_id matches created_by/token is trusted');
assert(!isTrustedSharePath(link({ backup_id: `${victim}/shares/${victimToken}.gz` })),
  'row pointing at another user path is not trusted');

assert(!isDueForPurge(link({ expires_at: '2026-10-28T12:00:00.000Z', use_count: 0 }), now),
  'unexpired under-limit share is not due');
assert(isDueForPurge(link({ expires_at: '2026-10-27T11:59:59.000Z' }), now),
  'expired share is due even with remaining uses');
assert(isDueForPurge(link({ expires_at: '2026-10-28T12:00:00.000Z', use_count: 5, max_uses: 5 }), now),
  'exhausted share is due while still unexpired');
assert(isDueForPurge(link({ expires_at: '2026-10-28T12:00:00.000Z', use_count: 6, max_uses: 5 }), now),
  'over-limit share is due');
assert(isDueForPurge(link({ expires_at: '2026-10-28T12:00:00.000Z', use_count: 5, max_uses: null }), now),
  'missing max_uses defaults to 5 for exhaustion');

{
  const live = link({ id: 'live' });
  const expired = link({ id: 'exp', expires_at: '2026-10-01T00:00:00.000Z', token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' });
  const exhausted = link({ id: 'exh', use_count: 5, token: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
  const forged = link({
    id: 'forged',
    expires_at: '2026-10-01T00:00:00.000Z',
    backup_id: `${victim}/shares/${victimToken}.gz`,
  });
  const { due, skippedUntrusted } = selectPurgeableShares([live, expired, exhausted, forged], now);
  assert(due.map((r) => r.id).sort().join(',') === 'exh,exp', 'selects expired and exhausted trusted rows only');
  assert(skippedUntrusted.map((r) => r.id).join(',') === 'forged', 'forged backup_id is skipped, not selected');
}

{
  const expired = link({ id: 'exp', expires_at: '2026-10-01T00:00:00.000Z' });
  const { result, removedCalls, deletedIds } = await runPurge([expired]);
  assert(removedCalls.length === 1 && removedCalls[0][0] === expired.backup_id,
    'expired share: Storage API remove is called with the canonical path');
  assert(deletedIds.join(',') === 'exp', 'expired share: row is deleted after remove confirms');
  assert(result.deleted_objects === 1 && result.deleted_links === 1, 'expired share: counts objects and rows');
}

{
  const exhausted = link({ id: 'exh', use_count: 5, max_uses: 5 });
  const { result, removedCalls, deletedIds } = await runPurge([exhausted]);
  assert(removedCalls[0][0] === exhausted.backup_id, 'exhausted share: Storage API remove is called');
  assert(deletedIds.join(',') === 'exh', 'exhausted share: row is deleted after remove confirms');
  assert(result.due === 1, 'exhausted share: counted as due');
}

{
  const forged = link({
    id: 'forged',
    expires_at: '2026-10-01T00:00:00.000Z',
    backup_id: `${victim}/shares/${victimToken}.gz`,
  });
  const { result, removedCalls, deletedIds } = await runPurge([forged]);
  assert(removedCalls.length === 0, 'forged backup_id: Storage API is not called');
  assert(deletedIds.length === 0, 'forged backup_id: attacker row is not deleted (and victim object is untouched)');
  assert(result.skipped_untrusted === 1 && result.deleted_objects === 0, 'forged backup_id: reported as skipped');
}

{
  const expired = link({ id: 'exp', expires_at: '2026-10-01T00:00:00.000Z' });
  const { result, deletedIds } = await runPurge([expired], { failRemove: true, removeError: new Error('nope') });
  assert(deletedIds.length === 0, 'storage failure: row is kept so a retry can find the object');
  assert(result.deleted_links === 0 && result.error, 'storage failure: no rows deleted, error recorded');
}

{
  const live = link({ id: 'live' });
  const { result, removedCalls, deletedIds } = await runPurge([live]);
  assert(removedCalls.length === 0 && deletedIds.length === 0, 'live share: no storage or row deletes');
  assert(result.due === 0, 'live share: not due');
}

assert(secretsEqual('abc', 'abc') && !secretsEqual('abc', 'abd') && !secretsEqual('abc', 'ab'),
  'purge secret compare is equality, including length');
assert(!secretsEqual('', 'x'), 'empty vs non-empty secret does not match');

assert(MAX_SHARE_EXPIRES_HOURS === 24 * 30, 'share expiry cap is 30 days (720 hours)');
assert(normalizeShareExpiresHours(undefined) === 24, '--expires default is 24 hours');
assert(normalizeShareExpiresHours('0') === 24 && normalizeShareExpiresHours('-3') === 24, 'non-positive --expires falls back to 24');
assert(normalizeShareExpiresHours('48') === 48, '48-hour --expires is kept');
assert(normalizeShareExpiresHours('99999') === MAX_SHARE_EXPIRES_HOURS, '--expires above 30 days is capped');

{
  const sql = await fs.readFile(path.join(root, 'supabase', 'migrations', '20261027193000_purge_expired_shares.sql'), 'utf8');
  assert(!/^\s*delete from storage\.objects/im.test(sql), 'migration does not DELETE FROM storage.objects');
  assert(/drop function if exists public\.memoir_purge_expired_shares/i.test(sql),
    'migration drops the unsafe SQL purge if it was applied');
  assert(!/cron\.schedule/i.test(sql), 'migration does not schedule pg_cron against SQL deletes');
}

{
  const fn = await fs.readFile(path.join(root, 'supabase', 'functions', 'purge-expired-shares', 'index.ts'), 'utf8');
  assert(/storage\.from\(SHARE_BUCKET\)\.remove/.test(fn), 'edge function removes objects via the Storage API');
  assert(/x-memoir-purge-secret/.test(fn), 'edge function requires the shared-secret header');
  assert(/MEMOIR_PURGE_SECRET/.test(fn), 'edge function reads MEMOIR_PURGE_SECRET');
  assert(/dueShareOrFilter/.test(fn), 'edge function filters expired/exhausted rows in the query');
  assert(/listSharePage/.test(fn) && /\.gt\("id"/.test(fn), 'edge function pages candidate rows by id');
}

assert(PURGE_PAGE_SIZE === 1000 && REMOVE_BATCH_SIZE === 1000, 'purge pages and remove batches are 1000');
{
  const filter = dueShareOrFilter(now);
  assert(/expires_at\.lt\."2026-10-27T12:00:00.000Z"/.test(filter), 'query filter includes expires_at < now');
  assert(/use_count\.gte\.1/.test(filter), 'query filter includes used (possibly exhausted) rows');
}

{
  function tok(n) {
    return `cccccccc-cccc-4ccc-8ccc-${String(n).padStart(12, '0')}`;
  }
  function rid(n) {
    return `dddddddd-dddd-4ddd-8ddd-${String(n).padStart(12, '0')}`;
  }
  const many = Array.from({ length: 1001 }, (_, i) => link({
    id: rid(i),
    token: tok(i),
    expires_at: '2026-10-01T00:00:00.000Z',
  }));
  const pageCalls = [];
  const removedCalls = [];
  const deletedIds = [];
  const pageSize = 1000;
  const result = await purgeExpiredShares({
    now,
    pageSize,
    removeBatchSize: 1000,
    listSharePage: async ({ afterId, limit }) => {
      pageCalls.push({ afterId, limit });
      const start = afterId ? many.findIndex((r) => r.id === afterId) + 1 : 0;
      return { rows: many.slice(start, start + limit) };
    },
    removeObjects: async (paths) => {
      removedCalls.push(paths.slice());
      return { removed: paths };
    },
    deleteShareRows: async (ids) => {
      deletedIds.push(...ids);
      return {};
    },
  });
  assert(pageCalls.length >= 2, 'paging: more than 1000 due rows are fetched in multiple pages');
  assert(pageCalls[0].afterId == null && pageCalls[1].afterId === many[999].id,
    'paging: second page keysets after the last id of the first page');
  assert(removedCalls.length === 2 && removedCalls[0].length === 1000 && removedCalls[1].length === 1,
    'batch remove: 1001 due paths are removed in batches of 1000');
  assert(result.due === 1001 && result.deleted_links === 1001 && deletedIds.length === 1001,
    'paging: every due row is removed after Storage confirms');
}

{
  const sql = await fs.readFile(path.join(root, 'supabase', 'migrations', '20261027200000_shared_links_expires_at_not_null.sql'), 'utf8');
  assert(/expires_at is null/i.test(sql), 'expires_at migration backfills nulls');
  assert(/least\(coalesce\(created_at, now\(\)\) \+ interval '30 days', now\(\)\)/i.test(sql),
    'expires_at nulls backfill to least(created_at + 30 days, now())');
  assert(/set not null/i.test(sql), 'expires_at migration sets NOT NULL');
}

{
  const { isProSubscription, userStoragePrefix } = await import('./supabase/functions/account-delete/logic.js');
  assert(isProSubscription([{ status: 'pro' }]) === true, 'account-delete treats status=pro as active billing');
  assert(isProSubscription([{ status: 'free' }]) === false && isProSubscription([]) === false,
    'account-delete allows free / missing subscription rows');
  assert(userStoragePrefix(owner) === `${owner}/`, 'account-delete wipes the uid/ storage prefix');
  assert(userStoragePrefix('../etc') === null && userStoragePrefix('') === null,
    'account-delete rejects a non-UUID uid before building a storage prefix');
}

await fs.remove(scratch).catch(() => {});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
