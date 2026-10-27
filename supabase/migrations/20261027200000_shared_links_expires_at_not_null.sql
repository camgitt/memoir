-- shared_links.expires_at must be set so the purge always has an expiry.
-- Null-expiry rows under their download limit were never selected.
--
-- MANUAL STEP (owner): apply by SQL if `supabase db push` still mis-pairs
-- 12-digit history. Do not skip this; the edge function assumes the column
-- is present and not null after this lands.
begin;

-- created_at is not declared in this repo's migrations (GAMEPLAN.md and
-- tests assume the column exists). Cap at now() so a 30-day offset cannot
-- land a future expiry that the purge would skip.
update public.shared_links
   set expires_at = least(coalesce(created_at, now()) + interval '30 days', now())
 where expires_at is null;

alter table public.shared_links
  alter column expires_at set default (now() + interval '24 hours');

alter table public.shared_links
  alter column expires_at set not null;

commit;
