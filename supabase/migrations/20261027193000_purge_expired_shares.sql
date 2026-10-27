-- Purge expired share links and their storage objects.
--
-- Deadline: a share must be gone within 30 days of expires_at. This function
-- deletes as soon as expires_at < now(), so a daily job meets that SLA.
--
-- MANUAL STEPS (owner):
--   1. Apply this migration (14-digit name; apply by SQL if `supabase db push`
--      mis-pairs 12-digit history — see LAUNCH-CHECKLIST).
--   2. Enable a daily schedule, either:
--        a. Dashboard → Edge Functions → purge-expired-shares → Cron (daily), or
--        b. Enable the pg_cron extension and allow the schedule below.
begin;

create or replace function public.memoir_purge_expired_shares()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_links int := 0;
  deleted_objects int := 0;
begin
  -- Storage objects first, then rows — same order as account deletion, so a
  -- failed object delete leaves the row for the next run to find.
  with expired as (
    select backup_id
    from public.shared_links
    where expires_at < now()
      and backup_id is not null
      and backup_id ~ '^[0-9a-f-]{36}/shares/[0-9a-f-]{36}\.gz$'
  ),
  removed as (
    delete from storage.objects o
    using expired e
    where o.bucket_id = 'memoir-backups'
      and o.name = e.backup_id
    returning o.name
  )
  select count(*) into deleted_objects from removed;

  delete from public.shared_links
  where expires_at < now();
  get diagnostics deleted_links = row_count;

  return jsonb_build_object(
    'deleted_links', deleted_links,
    'deleted_objects', deleted_objects
  );
end;
$$;

revoke all on function public.memoir_purge_expired_shares() from public;
revoke all on function public.memoir_purge_expired_shares() from anon, authenticated;
grant execute on function public.memoir_purge_expired_shares() to service_role;

-- Optional daily schedule. No-ops when pg_cron is not enabled so applying
-- this file cannot fail on a project that has not turned the extension on.
do $cron$
begin
  begin
    perform cron.unschedule('memoir-purge-expired-shares');
  exception when others then
    null;
  end;
  begin
    perform cron.schedule(
      'memoir-purge-expired-shares',
      '20 4 * * *',
      $job$select public.memoir_purge_expired_shares()$job$
    );
  exception when others then
    raise notice 'pg_cron not available; schedule purge-expired-shares in the dashboard. (%)', sqlerrm;
  end;
end
$cron$;

commit;
