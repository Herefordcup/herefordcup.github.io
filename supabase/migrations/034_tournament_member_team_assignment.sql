-- Let global and tournament administrators assign an active member to the
-- Blue or White team for one current tournament through a narrow RPC.

create or replace function public.set_tournament_member_team(
  target_tournament_id uuid,
  target_user_id uuid,
  target_team text
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
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if target_team is not null and target_team not in ('cardinal', 'silver') then
    raise exception 'Team must be Blue, White, or unassigned';
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
    raise exception 'Teams can only be assigned for a current tournament';
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

  if not (public.is_admin() or public.is_tournament_admin(target_tournament_id)) then
    raise exception 'Tournament administrator access required';
  end if;

  update public.tournament_memberships membership
  set team = target_team,
      updated_at = now()
  where membership.tournament_id = target_tournament_id
    and membership.user_id = target_user_id
    and membership.status = 'active'
  returning membership.* into updated_membership;

  if updated_membership.tournament_id is null then
    raise exception 'Active tournament membership changed before the team could be saved';
  end if;

  return updated_membership;
end;
$$;

revoke all on function public.set_tournament_member_team(uuid, uuid, text) from public, anon;
grant execute on function public.set_tournament_member_team(uuid, uuid, text) to authenticated;
