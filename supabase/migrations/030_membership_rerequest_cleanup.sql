begin;

-- Remove approval-notification history that no longer has a membership row.
-- Deliveries cascade from notification_jobs; authentication identities and
-- profiles intentionally remain so the person can request access again.
delete from public.notification_jobs orphaned_job
where orphaned_job.notification_type = 'new_member'
  and orphaned_job.source_type = 'membership'
  and not exists (
    select 1
    from public.tournament_memberships membership
    where membership.tournament_id = orphaned_job.tournament_id
      and membership.user_id = orphaned_job.source_id
  );

-- A request recreated before this migration may have been suppressed by the
-- original stable notification key. Replace only an older job for the same
-- tournament/person with a fresh queued approval request.
do $$
declare
  membership record;
begin
  for membership in
    select
      current_membership.tournament_id,
      current_membership.user_id,
      current_membership.created_at,
      coalesce(nullif(trim(profile.display_name), ''), 'A new player') as member_name
    from public.tournament_memberships current_membership
    join public.profiles profile on profile.id = current_membership.user_id
    where current_membership.status = 'pending'
      and exists (
        select 1
        from public.notification_jobs old_job
        where old_job.tournament_id = current_membership.tournament_id
          and old_job.notification_type = 'new_member'
          and old_job.source_type = 'membership'
          and old_job.source_id = current_membership.user_id
          and old_job.idempotency_key = format(
            'member-approval:%s:%s',
            current_membership.tournament_id,
            current_membership.user_id
          )
          and old_job.created_at < current_membership.created_at
      )
  loop
    delete from public.notification_jobs old_job
    where old_job.tournament_id = membership.tournament_id
      and old_job.notification_type = 'new_member'
      and old_job.source_type = 'membership'
      and old_job.source_id = membership.user_id;

    perform public.enqueue_notification_job(
      membership.tournament_id,
      'new_member',
      'membership',
      membership.user_id,
      format('member-approval:%s:%s', membership.tournament_id, membership.user_id),
      'Member approval requested',
      format(
        '%s created an account. Open the administrator portal to approve or remove this request.',
        membership.member_name
      ),
      jsonb_build_object('member_user_id', membership.user_id, 'member_name', membership.member_name),
      clock_timestamp()
    );
  end loop;
end;
$$;

create or replace function public.delete_tournament_membership(
  target_tournament_id uuid,
  target_user_id uuid,
  change_reason text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_membership public.tournament_memberships%rowtype;
  active_admin_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(target_tournament_id::text, 0));

  if not public.is_tournament_admin(target_tournament_id) then
    raise exception 'Tournament administrator access required';
  end if;
  if char_length(trim(coalesce(change_reason, ''))) < 2 then
    raise exception 'A reason is required';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'You cannot delete your own administrator membership';
  end if;

  select membership.* into current_membership
  from public.tournament_memberships membership
  where membership.tournament_id = target_tournament_id
    and membership.user_id = target_user_id
  for update;

  if not found then
    raise exception 'Tournament membership not found';
  end if;
  if current_membership.status <> 'active' then
    raise exception 'Membership is not active';
  end if;

  if exists (
    select 1
    from public.profiles profile
    where profile.id = target_user_id
      and profile.role = 'admin'
  ) then
    raise exception 'You cannot delete a global administrator tournament membership';
  end if;

  if current_membership.status = 'active' and current_membership.role = 'admin' then
    select count(*) into active_admin_count
    from public.tournament_memberships membership
    where membership.tournament_id = target_tournament_id
      and membership.role = 'admin'
      and membership.status = 'active';
    if active_admin_count <= 1 then
      raise exception 'You cannot delete the last active tournament administrator';
    end if;
  end if;

  delete from public.notification_jobs job
  where job.tournament_id = target_tournament_id
    and job.notification_type = 'new_member'
    and job.source_type = 'membership'
    and job.source_id = target_user_id;

  delete from public.membership_status_audit audit
  where audit.tournament_id = target_tournament_id
    and audit.user_id = target_user_id;

  delete from public.tournament_memberships membership
  where membership.tournament_id = target_tournament_id
    and membership.user_id = target_user_id
    and membership.status = 'active';

  if not found then
    raise exception 'Membership is not active';
  end if;

  return true;
end;
$$;

revoke all on function public.delete_tournament_membership(uuid, uuid, text) from public, anon;
grant execute on function public.delete_tournament_membership(uuid, uuid, text) to authenticated;

create or replace function public.deny_tournament_membership(
  target_tournament_id uuid,
  target_user_id uuid,
  change_reason text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_membership public.tournament_memberships%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  perform pg_advisory_xact_lock(pg_catalog.hashtextextended(target_tournament_id::text, 0));

  if not public.is_tournament_admin(target_tournament_id) then
    raise exception 'Tournament administrator access required';
  end if;
  if char_length(trim(coalesce(change_reason, ''))) < 2 then
    raise exception 'A reason is required';
  end if;

  select membership.* into current_membership
  from public.tournament_memberships membership
  where membership.tournament_id = target_tournament_id
    and membership.user_id = target_user_id
  for update;

  if not found then
    raise exception 'Tournament membership not found';
  end if;
  if current_membership.status <> 'pending' then
    raise exception 'Membership request is no longer pending';
  end if;
  if exists (
    select 1
    from public.profiles profile
    where profile.id = target_user_id
      and profile.role = 'admin'
  ) then
    raise exception 'You cannot deny a global administrator tournament membership';
  end if;

  delete from public.notification_jobs job
  where job.tournament_id = target_tournament_id
    and job.notification_type = 'new_member'
    and job.source_type = 'membership'
    and job.source_id = target_user_id;

  delete from public.membership_status_audit audit
  where audit.tournament_id = target_tournament_id
    and audit.user_id = target_user_id;

  delete from public.tournament_memberships membership
  where membership.tournament_id = target_tournament_id
    and membership.user_id = target_user_id
    and membership.status = 'pending';

  if not found then
    raise exception 'Membership request is no longer pending';
  end if;

  return true;
end;
$$;

revoke all on function public.deny_tournament_membership(uuid, uuid, text) from public, anon;
grant execute on function public.deny_tournament_membership(uuid, uuid, text) to authenticated;

commit;
