-- Derive automatic Singles and Four-Ball results from locked persisted scores.
-- Keep the administrator-entered fallback only for Foursomes.

create or replace function public.finalize_match_results(target_match_id uuid, segment_results jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  match_record public.matches%rowtype;
  segment_record public.match_segments%rowtype;
  result_record jsonb;
  result_count integer;
  unique_result_count integer;
  expected_per_team integer;
  assignment_count integer;
  cardinal_count integer;
  silver_count integer;
  total_holes integer;
  current_hole_number integer;
  derived_differential integer;
  derived_holes_played integer;
  cardinal_score integer;
  silver_score integer;
  baseline_handicap integer;
begin
  if jsonb_typeof(coalesce(segment_results, '[]'::jsonb)) <> 'array' then
    raise exception 'Every segment must have one authoritative final result';
  end if;

  -- Lock in the same root-to-leaf order used by score correction: match, rounds,
  -- then scores. Segment plan rows are locked between match and round rows.
  select source_match.* into match_record
  from public.matches source_match
  where source_match.id = target_match_id
  for update;
  if match_record.id is null then raise exception 'Match not found'; end if;
  if not (public.is_admin() or public.is_tournament_admin(match_record.tournament_id)) then
    raise exception 'Administrator access required';
  end if;
  if match_record.status not in ('scheduled', 'live') then
    raise exception 'Only scheduled or live matches can be finalized';
  end if;
  if match_record.course_id is null then raise exception 'A match course is required before finalization'; end if;

  perform locked_segment.id
  from public.match_segments locked_segment
  where locked_segment.match_id = target_match_id
  order by locked_segment.id
  for update;

  perform locked_assignment.segment_id
  from public.match_segment_players locked_assignment
  join public.match_segments locked_segment on locked_segment.id = locked_assignment.segment_id
  where locked_segment.match_id = target_match_id
  order by locked_assignment.segment_id, locked_assignment.user_id
  for update of locked_assignment;

  perform locked_round.id
  from public.rounds locked_round
  where locked_round.match_id = target_match_id
  order by locked_round.id
  for update;

  perform locked_score.id
  from public.scores locked_score
  join public.rounds locked_round on locked_round.id = locked_score.round_id
  where locked_round.match_id = target_match_id
  order by locked_score.round_id, locked_score.hole_number
  for update of locked_score;

  -- Tee stroke indexes participate in net scoring, so freeze the read until commit.
  perform locked_hole.tee_id
  from public.holes locked_hole
  join public.rounds locked_round on locked_round.tee_id = locked_hole.tee_id
  where locked_round.match_id = target_match_id
  order by locked_hole.tee_id, locked_hole.hole_number
  for share of locked_hole;

  select count(*), count(distinct (result ->> 'segment_id')::uuid)
    into result_count, unique_result_count
  from jsonb_array_elements(segment_results) results(result);
  if result_count <> (select count(*) from public.match_segments where match_id = target_match_id)
     or unique_result_count <> result_count then
    raise exception 'Every segment must have one authoritative final result';
  end if;

  for segment_record in
    select segment.*
    from public.match_segments segment
    where segment.match_id = target_match_id
    order by segment.segment_number, segment.id
  loop
    select result into result_record
    from jsonb_array_elements(segment_results) results(result)
    where (result ->> 'segment_id')::uuid = segment_record.id;
    if result_record is null or result_record ->> 'status' is distinct from 'final' then
      raise exception 'Every segment must have one authoritative final result';
    end if;

    if segment_record.format in ('singles', 'fourball') then
      expected_per_team := case when segment_record.format = 'singles' then 1 else 2 end;
      select count(*),
             count(*) filter (where assignment.side = 'cardinal'),
             count(*) filter (where assignment.side = 'silver')
        into assignment_count, cardinal_count, silver_count
      from public.match_segment_players assignment
      where assignment.segment_id = segment_record.id;
      if assignment_count <> expected_per_team * 2
         or cardinal_count <> expected_per_team
         or silver_count <> expected_per_team then
        raise exception 'Automatic result requires the complete format lineup';
      end if;

      if exists (
        select 1
        from public.match_segment_players assignment
        where assignment.segment_id = segment_record.id
          and (select count(*)
               from public.rounds round_record
               join public.tees tee_record on tee_record.id = round_record.tee_id
               where round_record.match_id = target_match_id
                 and round_record.user_id = assignment.user_id
                 and round_record.course_id = match_record.course_id
                 and tee_record.course_id = match_record.course_id) <> 1
      ) then
        raise exception 'Automatic result requires one valid persisted round per assigned player';
      end if;

      if segment_record.scoring_mode = 'net' and (
        segment_record.handicap_allowance is null
        or exists (
          select 1
          from public.match_segment_players assignment
          join public.rounds round_record
            on round_record.match_id = target_match_id
           and round_record.user_id = assignment.user_id
          where assignment.segment_id = segment_record.id
            and round_record.course_handicap is null
        )
      ) then
        raise exception 'Net automatic result requires complete handicap data';
      end if;

      -- Require every persisted hole score and its tee-specific stroke index before
      -- calculating any result, including holes after an early match-play finish.
      if exists (
        select 1
        from public.match_segment_players assignment
        cross join lateral generate_series(segment_record.start_hole, segment_record.end_hole) expected_hole(hole_number)
        where assignment.segment_id = segment_record.id
          and not exists (
            select 1
            from public.rounds round_record
            join public.scores score_record
              on score_record.round_id = round_record.id
             and score_record.hole_number = expected_hole.hole_number
            join public.holes hole_record
              on hole_record.tee_id = round_record.tee_id
             and hole_record.hole_number = expected_hole.hole_number
            where round_record.match_id = target_match_id
              and round_record.user_id = assignment.user_id
              and round_record.course_id = match_record.course_id
          )
      ) then
        raise exception 'Automatic result requires complete persisted hole scores and tee stroke indexes';
      end if;

      if segment_record.scoring_mode = 'net' and exists (
        select 1
        from public.match_segment_players assignment
        join public.rounds round_record
          on round_record.match_id = target_match_id
         and round_record.user_id = assignment.user_id
        join public.holes hole_record
          on hole_record.tee_id = round_record.tee_id
         and hole_record.hole_number between segment_record.start_hole and segment_record.end_hole
        where assignment.segment_id = segment_record.id
          and (hole_record.stroke_index is null
               or hole_record.stroke_index not between 1 and 18)
      ) then
        raise exception 'Net automatic result requires valid tee stroke indexes';
      end if;

      if segment_record.scoring_mode = 'net' and exists (
        select 1
        from generate_series(segment_record.start_hole, segment_record.end_hole) expected_hole(hole_number)
        where (select count(distinct hole_record.stroke_index)
               from public.match_segment_players assignment
               join public.rounds round_record
                 on round_record.match_id = target_match_id
                and round_record.user_id = assignment.user_id
               join public.holes hole_record
                 on hole_record.tee_id = round_record.tee_id
                and hole_record.hole_number = expected_hole.hole_number
               where assignment.segment_id = segment_record.id) <> 1
      ) then
        raise exception 'Net automatic result requires matching tee stroke indexes';
      end if;

      if segment_record.scoring_mode = 'net' then
        select min(floor(round_record.course_handicap * segment_record.handicap_allowance / 100.0 + 0.5)::integer)
          into baseline_handicap
        from public.match_segment_players assignment
        join public.rounds round_record
          on round_record.match_id = target_match_id
         and round_record.user_id = assignment.user_id
        where assignment.segment_id = segment_record.id;
      else
        baseline_handicap := 0;
      end if;

      total_holes := segment_record.end_hole - segment_record.start_hole + 1;
      derived_differential := 0;
      derived_holes_played := 0;
      for current_hole_number in segment_record.start_hole..segment_record.end_hole loop
        select
          min(case when assignment.side = 'cardinal' then
            score_record.gross_score - case when segment_record.scoring_mode = 'net' then
              floor(greatest(
                0,
                floor(round_record.course_handicap * segment_record.handicap_allowance / 100.0 + 0.5)::integer - baseline_handicap
              ) / 18.0)::integer
              + case when hole_record.stroke_index <= mod(greatest(
                  0,
                  floor(round_record.course_handicap * segment_record.handicap_allowance / 100.0 + 0.5)::integer - baseline_handicap
                ), 18) then 1 else 0 end
            else 0 end
          end),
          min(case when assignment.side = 'silver' then
            score_record.gross_score - case when segment_record.scoring_mode = 'net' then
              floor(greatest(
                0,
                floor(round_record.course_handicap * segment_record.handicap_allowance / 100.0 + 0.5)::integer - baseline_handicap
              ) / 18.0)::integer
              + case when hole_record.stroke_index <= mod(greatest(
                  0,
                  floor(round_record.course_handicap * segment_record.handicap_allowance / 100.0 + 0.5)::integer - baseline_handicap
                ), 18) then 1 else 0 end
            else 0 end
          end)
          into cardinal_score, silver_score
        from public.match_segment_players assignment
        join public.rounds round_record
          on round_record.match_id = target_match_id
         and round_record.user_id = assignment.user_id
        join public.scores score_record
          on score_record.round_id = round_record.id
         and score_record.hole_number = current_hole_number
        join public.holes hole_record
          on hole_record.tee_id = round_record.tee_id
         and hole_record.hole_number = current_hole_number
        where assignment.segment_id = segment_record.id;

        derived_differential := derived_differential
          + case when cardinal_score < silver_score then 1
                 when silver_score < cardinal_score then -1
                 else 0 end;
        derived_holes_played := derived_holes_played + 1;
        exit when derived_holes_played >= total_holes
          or abs(derived_differential) > total_holes - derived_holes_played;
      end loop;

      -- The server is authoritative. A stale or altered browser payload cannot
      -- finalize a different automatic result than the locked persisted scores.
      if (result_record ? 'differential'
          and (result_record ->> 'differential')::integer is distinct from derived_differential)
         or (result_record ? 'holes_played'
          and (result_record ->> 'holes_played')::integer is distinct from derived_holes_played) then
        raise exception 'Client automatic result does not match persisted scores';
      end if;
    elsif segment_record.format = 'foursomes' then
      -- Foursomes remains an explicit administrator fallback until side-score
      -- scorecards exist. Only this branch accepts a client-authored result.
      derived_differential := (result_record ->> 'differential')::integer;
      derived_holes_played := (result_record ->> 'holes_played')::integer;
      total_holes := segment_record.end_hole - segment_record.start_hole + 1;
    else
      raise exception 'Unsupported format cannot be finalized';
    end if;

    if derived_holes_played < 1
       or derived_holes_played > total_holes
       or abs(derived_differential) > derived_holes_played
       or (derived_differential = 0 and derived_holes_played <> total_holes)
       or (derived_differential <> 0
           and derived_holes_played < total_holes
           and abs(derived_differential) <= total_holes - derived_holes_played) then
      raise exception 'Segment result is not a valid completed match-play result';
    end if;

    update public.match_segments set
      differential = derived_differential,
      holes_played = derived_holes_played,
      status = 'final',
      updated_at = now()
    where id = segment_record.id;
  end loop;

  update public.matches
  set status = 'final'
  where id = target_match_id;
  return target_match_id;
end;
$$;

revoke all on function public.finalize_match_results(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_match_results(uuid, jsonb) to authenticated;

-- Score correction follows the same match -> round -> score lock order as
-- finalization, then rejects a correction once finalization has won the lock.
create or replace function public.correct_hole_score(
  target_round_id uuid,
  target_hole_number integer,
  target_reason text,
  target_gross_score integer default null,
  delete_score boolean default false
)
returns public.scores
language plpgsql
security definer
set search_path = public
as $$
declare
  target_match_id uuid;
  target_match public.matches%rowtype;
  target_round public.rounds%rowtype;
  score_user_id uuid;
  existing_score public.scores%rowtype;
  saved_score public.scores;
  audit_action text;
begin
  if char_length(trim(target_reason)) not between 1 and 500 then raise exception 'Correction reason is required'; end if;
  if target_hole_number not between 1 and 18 then raise exception 'Hole number must be between 1 and 18'; end if;
  if delete_score and target_gross_score is not null then raise exception 'Delete corrections cannot include a gross score'; end if;
  if not delete_score and (target_gross_score is null or target_gross_score not between 1 and 15) then
    raise exception 'Gross score must be between 1 and 15';
  end if;

  select source_round.match_id into target_match_id
  from public.rounds source_round
  where source_round.id = target_round_id;
  if not found then raise exception 'Round not found'; end if;

  if target_match_id is not null then
    select source_match.* into target_match
    from public.matches source_match
    where source_match.id = target_match_id
    for update;
    if not (public.is_admin() or public.is_tournament_admin(target_match.tournament_id)) then
      raise exception 'Administrator access required';
    end if;
    if target_match.status = 'final' then raise exception 'Finalized matches cannot be corrected'; end if;
  end if;
  if target_match_id is null then
    if not public.is_admin() then raise exception 'Administrator access required'; end if;
  end if;

  select source_round.* into target_round
  from public.rounds source_round
  where source_round.id = target_round_id
  for update;
  if target_round.id is null then raise exception 'Round not found'; end if;
  if target_round.match_id is distinct from target_match_id then
    raise exception 'Round match changed during correction';
  end if;
  score_user_id := target_round.user_id;

  if not exists (
    select 1 from public.holes hole
    where hole.tee_id = target_round.tee_id and hole.hole_number = target_hole_number
  ) then
    raise exception 'Hole does not exist for the round tee';
  end if;

  select score.* into existing_score
  from public.scores score
  where score.round_id = target_round_id and score.hole_number = target_hole_number
  for update;

  if delete_score then
    if existing_score.id is null then raise exception 'Score not found'; end if;
    delete from public.scores where id = existing_score.id returning * into saved_score;
    audit_action := 'delete';
  else
    insert into public.scores(round_id, user_id, hole_number, gross_score, updated_at)
    values (target_round_id, score_user_id, target_hole_number, target_gross_score, now())
    on conflict (round_id, hole_number) do update
      set gross_score = excluded.gross_score, updated_at = now()
    returning * into saved_score;
    audit_action := case when existing_score.id is null then 'insert' else 'update' end;
  end if;

  insert into public.score_correction_audit(
    score_id, round_id, user_id, hole_number, action,
    old_gross_score, new_gross_score, correction_reason, corrected_by
  ) values (
    coalesce(saved_score.id, existing_score.id), target_round_id, score_user_id,
    target_hole_number, audit_action, existing_score.gross_score,
    case when delete_score then null else target_gross_score end, trim(target_reason), auth.uid()
  );
  return saved_score;
end;
$$;

revoke all on function public.correct_hole_score(uuid, integer, text, integer, boolean) from public, anon, authenticated;
grant execute on function public.correct_hole_score(uuid, integer, text, integer, boolean) to authenticated;
