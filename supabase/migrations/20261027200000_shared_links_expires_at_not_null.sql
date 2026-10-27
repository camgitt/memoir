-- shared_links.expires_at must be set so the purge always has an expiry.
-- Null-expiry rows under their download limit were never selected.
--
-- MANUAL STEP (owner): apply by SQL if `supabase db push` still mis-pairs
-- 12-digit history. Do not skip this; the edge function assumes the column
-- is present and not null after this lands.
begin;

update public.shared_links
   set expires_at = coalesce(created_at, now()) + interval '30 days'
 where expires_at is null;

alter table public.shared_links
  alter column expires_at set default (now() + interval '24 hours');

alter table public.shared_links
  alter column expires_at set not null;

commit;
