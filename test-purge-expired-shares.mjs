#!/usr/bin/env node
// Expired share bundles must be purged within 30 days of expires_at.
// The hosted function deletes as soon as they expire so a daily job meets
// that deadline. This suite locks the SQL predicate, grants, and the edge
// function's service-role RPC call — no live database.
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const BOLD = '\x1b[1m', GREEN = '\x1b[32m', RED = '\x1b[31m', CYAN = '\x1b[36m', RESET = '\x1b[0m';
let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ${GREEN}PASS${RESET} ${msg}`); }
  else { fail++; console.log(`  ${RED}FAIL${RESET} ${msg}`); }
}

const root = path.dirname(fileURLToPath(import.meta.url));
const sqlPath = path.join(root, 'supabase', 'migrations', '20261027193000_purge_expired_shares.sql');
const fnPath = path.join(root, 'supabase', 'functions', 'purge-expired-shares', 'index.ts');

console.log(`\n${BOLD}${CYAN}expired share purge (30-day deadline)${RESET}\n`);

const sql = await fs.readFile(sqlPath, 'utf8');
const fn = await fs.readFile(fnPath, 'utf8');

assert(/memoir_purge_expired_shares/.test(sql), 'migration defines memoir_purge_expired_shares');
assert(/expires_at\s*<\s*now\(\)/i.test(sql), 'purge selects shares whose expires_at is already past');
assert(/30 days/i.test(sql), 'migration documents the 30-day-after-expiry deadline');
assert(/delete from storage\.objects/i.test(sql), 'purge deletes matching storage objects');
assert(/bucket_id = 'memoir-backups'/.test(sql), 'storage deletes are scoped to the memoir-backups bucket');
assert(/\/shares\//.test(sql), 'storage deletes are limited to share object paths');
assert(/grant execute on function public\.memoir_purge_expired_shares\(\) to service_role/i.test(sql),
  'only service_role may execute the purge');
assert(/revoke all on function public\.memoir_purge_expired_shares\(\) from anon, authenticated/i.test(sql),
  'anon and authenticated cannot run the purge');
assert(/cron\.schedule/.test(sql), 'migration includes a pg_cron schedule for a daily run');
assert(/MANUAL STEP/i.test(sql), 'migration flags the owner-run schedule/apply step');

assert(/rpc\("memoir_purge_expired_shares"\)/.test(fn), 'edge function calls the SQL purge RPC');
assert(/SUPABASE_SERVICE_ROLE_KEY/.test(fn), 'edge function uses the service role, not a user JWT');
assert(!/SUPABASE_ANON_KEY/.test(fn), 'edge function does not fall back to the anon key');

// Policy replica: purge anything already expired. A share expired 29 days ago
// is due; one that expires tomorrow is not. Daily runs finish well inside 30 days.
function dueForPurge(expiresAt, now) {
  return new Date(expiresAt).getTime() < now.getTime();
}
const now = new Date('2026-10-27T12:00:00.000Z');
assert(!dueForPurge('2026-10-28T12:00:00.000Z', now), 'unexpired share is not purged');
assert(dueForPurge('2026-10-27T11:59:59.000Z', now), 'share is purged as soon as it expires');
assert(dueForPurge('2026-09-28T12:00:00.000Z', now), 'share expired 29 days ago is purged (inside the 30-day deadline)');
assert(dueForPurge('2026-09-26T12:00:00.000Z', now), 'share expired 31 days ago is purged');

const ms30 = 30 * 24 * 60 * 60 * 1000;
assert(now.getTime() - new Date('2026-09-28T12:00:00.000Z').getTime() < ms30,
  'the 29-day fixture is still within the 30-day SLA window');

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
