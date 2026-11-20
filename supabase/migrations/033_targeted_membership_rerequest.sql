-- Allow the stale-tab lifecycle monitor to re-request the exact tournament
-- whose active membership was deleted, even when another joinable tournament
-- has a higher-priority pending membership.

create or replace function public.request_tournament_membership(target_tournament_id uuid)
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
  where tournament.id = target_tournament_id
    and tournament.status in ('setup', 'open', 'live')
  on conflict (tournament_id, user_id) do nothing
  returning * into requested_membership;

  if requested_membership.tournament_id is null then
    select membership.* into requested_membership
    from public.tournament_memberships membership
    join public.tournaments tournament on tournament.id = membership.tournament_id
    where membership.tournament_id = target_tournament_id
      and membership.user_id = auth.uid()
      and tournament.status in ('setup', 'open', 'live');
  end if;

  if requested_membership.tournament_id is null then
    raise exception 'Tournament is not available for membership requests';
  end if;

  return requested_membership;
end;
$$;

revoke all on function public.request_tournament_membership(uuid) from public, anon;
grant execute on function public.request_tournament_membership(uuid) to authenticated;
