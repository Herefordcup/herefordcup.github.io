-- Permanently delete tournament membership rows while preserving Auth identities and profiles.
-- Deleted people may request a fresh pending membership on their next authenticated portal visit.
-- Apply after 018_membership_approval.sql.

-- Remove legacy removal history and its retained membership rows.
delete from public.membership_status_audit audit
where exists (
  select 1
  from public.tournament_memberships membership
  where membership.tournament_id = audit.tournament_id
    and membership.user_id = audit.user_id
    and membership.status = 'removed'
);

delete from public.tournament_memberships
where status = 'removed';

-- Approval remains audited, but this former status RPC can no longer create
-- retained "removed" rows. Deletion uses delete_tournament_membership below.
create or replace function public.set_tournament_membership_status(
  target_tournament_id uuid,
  target_user_id uuid,
  target_status text,
  change_reason text
)
returns public.tournament_memberships
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_membership public.tournament_memberships%rowtype;
  updated_membership public.tournament_memberships%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_tournament_admin(target_tournament_id) then
    raise exception 'Tournament administrator access required';
  end if;
  if target_status <> 'active' then
    raise exception 'Membership status must be active';
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

  update public.tournament_memberships membership
  set status = 'active',
      joined_at = coalesce(membership.joined_at, now()),
      updated_at = now()
  where membership.tournament_id = target_tournament_id
    and membership.user_id = target_user_id
  returning membership.* into updated_membership;

  if current_membership.status is distinct from updated_membership.status then
    insert into public.membership_status_audit(
      tournament_id, user_id, previous_status, new_status, reason, changed_by
    ) values (
      target_tournament_id, target_user_id, current_membership.status,
      updated_membership.status, trim(change_reason), auth.uid()
    );
  end if;

  return updated_membership;
end;
$$;

revoke all on function public.set_tournament_membership_status(uuid, uuid, text, text) from public, anon;
grant execute on function public.set_tournament_membership_status(uuid, uuid, text, text) to authenticated;

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

  -- Serialize all membership deletions for this tournament. This makes the
  -- authorization check and last-administrator count one atomic decision.
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

  -- A deletion leaves no membership-status history for this tournament/person.
  delete from public.membership_status_audit audit
  where audit.tournament_id = target_tournament_id
    and audit.user_id = target_user_id;

  delete from public.tournament_memberships membership
  where membership.tournament_id = target_tournament_id
    and membership.user_id = target_user_id;

  return true;
end;
$$;

revoke all on function public.delete_tournament_membership(uuid, uuid, text) from public, anon;
grant execute on function public.delete_tournament_membership(uuid, uuid, text) to authenticated;

create or replace function public.request_tournament_membership()
returns public.tournament_memberships
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  requested_membership public.tournament_memberships%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into public.tournament_memberships(
    tournament_id,
    user_id,
    status,
    role,
    team,
    joined_at
  )
  select
    tournament.id,
    auth.uid(),
    'pending',
    'player',
    null,
    null
  from public.tournaments tournament
  where tournament.status in ('setup', 'open', 'live')
  order by
    case tournament.status when 'live' then 1 when 'open' then 2 else 3 end,
    tournament.edition_year desc
  limit 1
  on conflict (tournament_id, user_id) do nothing
  returning * into requested_membership;

  if requested_membership.tournament_id is null then
    select membership.* into requested_membership
    from public.tournament_memberships membership
    join public.tournaments tournament on tournament.id = membership.tournament_id
    where membership.user_id = auth.uid()
      and tournament.status in ('setup', 'open', 'live')
    order by
      case tournament.status when 'live' then 1 when 'open' then 2 else 3 end,
      tournament.edition_year desc
    limit 1;
  end if;

  return requested_membership;
end;
$$;

revoke all on function public.request_tournament_membership() from public, anon;
grant execute on function public.request_tournament_membership() to authenticated;

-- Browser clients must use the narrow RPCs above.
revoke insert, update, delete on public.tournament_memberships from authenticated;
