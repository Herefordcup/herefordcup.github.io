begin;

-- Keep 038's exact implementation private. Copy only under a new name so
-- CREATE OR REPLACE below preserves the original RPC's OID, owner and grants.
do $$
declare
  header constant text := 'CREATE OR REPLACE FUNCTION public.correct_hole_score(';
  definition text;
begin
  if to_regprocedure('public.apply_audited_hole_correction(uuid,integer,text,integer,boolean)') is null then
    definition := pg_get_functiondef('public.correct_hole_score(uuid,integer,text,integer,boolean)'::regprocedure);
    if not starts_with(definition, header) then raise exception 'Unexpected individual correction function definition'; end if;
    execute 'CREATE FUNCTION public.apply_audited_hole_correction(' || substr(definition, length(header) + 1);
  end if;
end;
$$;
revoke all on function public.apply_audited_hole_correction(uuid, integer, text, integer, boolean) from public, anon, authenticated, service_role;

create or replace function public.lock_individual_correction_round(target_round_id uuid)
returns void language plpgsql set search_path = pg_catalog, public as $$
declare
  match_key uuid;
  tournament_key uuid;
  tournament_status text;
begin
  -- Discover parents without a row lock. Revalidate every link under its lock.
  select r.match_id, m.tournament_id into match_key, tournament_key
  from public.rounds r left join public.matches m on m.id = r.match_id where r.id = target_round_id;
  if not found then raise exception 'Round not found'; end if;

  if tournament_key is not null then
    perform pg_advisory_xact_lock(hashtextextended(tournament_key::text, 0));
    select t.status into tournament_status from public.tournaments t where t.id = tournament_key for share;
  end if;
  -- Pre-edition matches and standalone rounds have no tournament organizer.
  if not (public.is_admin() or (tournament_key is not null and public.is_tournament_admin(tournament_key))) then
    raise exception 'Administrator access required';
  end if;
  if tournament_key is not null and (tournament_status is null or tournament_status not in ('setup', 'open', 'live')
      or exists (select 1 from public.legacy_editions e where e.source_tournament_id = tournament_key)) then
    raise exception 'Cannot correct individual scores for a completed or archived tournament';
  end if;

  if match_key is not null then
    perform 1 from public.matches m where m.id = match_key and m.tournament_id is not distinct from tournament_key for update;
    if not found then raise exception 'Match tournament changed during correction'; end if;
  end if;
  perform 1 from public.rounds r where r.id = target_round_id and r.match_id is not distinct from match_key for update;
  if not found then raise exception 'Round match changed during correction'; end if;
end;
$$;
revoke all on function public.lock_individual_correction_round(uuid) from public, anon, authenticated, service_role;

-- Keep the released five-argument signature and its defaults, including live
-- insert/delete. Both this and the exact-row overload lock tournament -> match -> round.
create or replace function public.correct_hole_score(
  target_round_id uuid, target_hole_number integer, target_reason text,
  target_gross_score integer default null, delete_score boolean default false
)
returns public.scores language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.lock_individual_correction_round(target_round_id);
  return public.apply_audited_hole_correction(target_round_id, target_hole_number, target_reason, target_gross_score, delete_score);
end;
$$;

-- No defaults on this overload: named PostgREST calls select it only when the
-- form supplies expected_score_id. A missing/null or superseded ID cannot insert.
create or replace function public.correct_hole_score(
  target_round_id uuid, target_hole_number integer, target_reason text,
  target_gross_score integer, delete_score boolean, expected_score_id uuid
)
returns public.scores language plpgsql security definer set search_path = pg_catalog, public as $$
begin
  perform public.lock_individual_correction_round(target_round_id);
  if delete_score is distinct from false then raise exception 'An Edit can only replace a submitted score'; end if;
  perform 1 from public.scores s where s.id = expected_score_id and s.round_id = target_round_id
    and s.hole_number = target_hole_number for update;
  if not found then raise exception 'Submitted score changed or no longer exists; refresh the scorecard'; end if;
  return public.apply_audited_hole_correction(target_round_id, target_hole_number, target_reason, target_gross_score, false);
end;
$$;

revoke all on function public.correct_hole_score(uuid, integer, text, integer, boolean, uuid) from public, anon, authenticated, service_role;
grant execute on function public.correct_hole_score(uuid, integer, text, integer, boolean, uuid) to authenticated;

commit;
