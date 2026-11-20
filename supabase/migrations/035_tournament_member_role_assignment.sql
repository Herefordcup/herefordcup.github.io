-- Let global and tournament administrators manage Player/Admin roles for an
-- active member of one current tournament through a narrow, locked RPC.

create or replace function public.set_tournament_member_role(
  target_tournament_id uuid,
  target_user_id uuid,
  target_role text
)
returns public.tournament_memberships
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  tournament_status text;
  current_membership public.tournament_memberships%rowtype;
  updated_membership public.tournament_memberships%rowtype;
  global_profile_role text;
  active_admin_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if target_role not in ('player', 'admin') then
    raise exception 'Role must be Player or Admin';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_tournament_id::text, 0));

  select tournament.status into tournament_status
  from public.tournaments tournament
  where tournament.id = target_tournament_id
  for update;

  if not found then
    raise exception 'Tournament not found';
  end if;

  if tournament_status not in ('setup', 'open', 'live') then
    raise exception 'Roles can only be changed for a current tournament';
  end if;

  select membership.* into current_membership
  from public.tournament_memberships membership
  where membership.tournament_id = target_tournament_id
    and membership.user_id = target_user_id
    and membership.status = 'active'
  for update;

  if not found then
    raise exception 'Active tournament membership not found';
  end if;

  select profile.role into global_profile_role
  from public.profiles profile
  where profile.id = target_user_id
  for update;

  if not found then
    raise exception 'Member profile not found';
  end if;

  if not (public.is_admin() or public.is_tournament_admin(target_tournament_id)) then
    raise exception 'Tournament administrator access required';
  end if;

  if target_user_id = auth.uid()
     and current_membership.role = 'admin'
     and target_role = 'player' then
    raise exception 'You cannot demote your own administrator membership';
  end if;

  if global_profile_role = 'admin'
     and current_membership.role = 'admin'
     and target_role = 'player' then
    raise exception 'A global administrator tournament membership cannot be demoted';
  end if;

  if current_membership.role = 'admin' and target_role = 'player' then
    select count(*) into active_admin_count
    from public.tournament_memberships membership
    where membership.tournament_id = target_tournament_id
      and membership.role = 'admin'
      and membership.status = 'active';

    if active_admin_count <= 1 then
      raise exception 'You cannot demote the last active tournament administrator';
    end if;
  end if;

  if current_membership.role = target_role then
    return current_membership;
  end if;

  update public.tournament_memberships membership
  set role = target_role,
      updated_at = now()
  where membership.tournament_id = target_tournament_id
    and membership.user_id = target_user_id
    and membership.status = 'active'
  returning membership.* into updated_membership;

  if updated_membership.tournament_id is null then
    raise exception 'Active tournament membership changed before the role could be saved';
  end if;

  return updated_membership;
end;
$$;

revoke all on function public.set_tournament_member_role(uuid, uuid, text) from public, anon;
grant execute on function public.set_tournament_member_role(uuid, uuid, text) to authenticated;
