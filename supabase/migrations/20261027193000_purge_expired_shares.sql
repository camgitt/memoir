-- Expired/exhausted share purge lives in supabase/functions/purge-expired-shares.
-- It removes objects through the Storage API, then deletes matching rows.
-- Direct SQL deletes against the Storage catalog orphan files (and current projects reject them).
--
-- This migration only drops the unsafe SQL purge if an earlier draft applied it.
-- There is no pg_cron → SQL delete path.
--
-- MANUAL STEPS (owner):
--   1. Apply this file (no-op drop if the SQL purge was never created).
--   2. Set MEMOIR_PURGE_SECRET on the purge-expired-shares function.
--   3. Deploy supabase/functions/purge-expired-shares (verify_jwt = false;
--      the function requires header x-memoir-purge-secret).
--   4. Schedule a daily POST to that function with the secret header.
--      Do not schedule `select memoir_purge_expired_shares()`.
begin;

drop function if exists public.memoir_purge_expired_shares();

commit;
