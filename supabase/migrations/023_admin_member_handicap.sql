-- Allow authorized tournament administrators to update an active member's handicap index.

create or replace function public.set_tournament_member_handicap(
  target_tournament_id uuid,
  target_user_id uuid,
  target_handicap_index numeric
)
returns table(user_id uuid, handicap_index numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_tournament public.tournaments;
  current_membership public.tournament_memberships;
  saved_handicap numeric;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if target_tournament_id is null or target_user_id is null then
    raise exception 'Tournament and member are required';
  end if;
  if target_handicap_index is null
     or target_handicap_index not between -10 and 54
     or target_handicap_index <> round(target_handicap_index, 1) then
    raise exception 'Handicap index must be between -10.0 and 54.0 with one decimal place';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_tournament_id::text, 0));

  select tournament.* into current_tournament
  from public.tournaments tournament
  where tournament.id = target_tournament_id
  for update;

  if current_tournament.id is null
     or current_tournament.status not in ('live', 'open', 'setup') then
    raise exception 'Handicaps can only be managed for the current tournament';
  end if;

  select membership.* into current_membership
  from public.tournament_memberships membership
  where membership.tournament_id = target_tournament_id
    and membership.user_id = target_user_id
    and membership.status = 'active'
  for update;

  if current_membership.user_id is null then
    raise exception 'Active tournament member not found';
  end if;
  if not (public.is_admin() or public.is_tournament_admin(target_tournament_id)) then
    raise exception 'Administrator access required';
  end if;

  update public.profiles profile
  set handicap_index = target_handicap_index,
      updated_at = now()
  where profile.id = target_user_id
  returning profile.handicap_index into saved_handicap;

  if not found then
    raise exception 'Member profile not found';
  end if;

  return query select target_user_id, saved_handicap;
end;
$$;

revoke all on function public.set_tournament_member_handicap(uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.set_tournament_member_handicap(uuid, uuid, numeric) to authenticated;
