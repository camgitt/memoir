-- Review and apply to the existing Memoir Supabase project before deploying
-- the new cloud writer. No old backups are deleted or renumbered.
-- If duplicate (user_id, version) rows exist, the unique index fails; inspect
-- and reconcile those records before retrying this transactional migration.
begin;

alter table public.backups add column if not exists encryption_format text not null default 'legacy';
alter table public.backups add column if not exists source_backup_id uuid;

create unique index if not exists memoir_backups_user_version
  on public.backups (user_id, version);

create table if not exists public.memoir_backup_counters (
  user_id uuid primary key references auth.users(id) on delete cascade,
  next_version bigint not null check (next_version > 0)
);
alter table public.memoir_backup_counters enable row level security;
revoke all on public.memoir_backup_counters from public, anon, authenticated;

create or replace function public.memoir_next_backup_version()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  allocated bigint;
begin
  if actor is null then
    raise exception 'Authentication required';
  end if;

  insert into public.memoir_backup_counters as counter (user_id, next_version)
  select actor, coalesce(max(b.version), 0) + 1
    from public.backups b where b.user_id = actor
  on conflict (user_id) do update
    set next_version = greatest(
      counter.next_version + 1,
      (select coalesce(max(b.version), 0) + 1 from public.backups b where b.user_id = actor)
    )
  returning next_version into allocated;

  return allocated;
end;
$$;

revoke all on function public.memoir_next_backup_version() from public, anon;
grant execute on function public.memoir_next_backup_version() to authenticated;
commit;
