-- Add the scorecard-grounded Savage commentary tone and make it the default.
-- Existing tournament choices remain unchanged; only new settings use the new default.

alter table public.commentary_settings
  drop constraint if exists commentary_settings_tone_check;

alter table public.commentary_settings
  add constraint commentary_settings_tone_check
  check (tone in ('clean', 'playful', 'ruthless', 'savage'));

alter table public.commentary_settings
  alter column tone set default 'savage';

create or replace function public.create_commentary_draft(
  target_match_id uuid,
  target_segment_id uuid,
  target_commentary_type text,
  target_phrase_id text,
  target_model text,
  target_regenerate boolean default false
)
returns public.match_commentaries
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  match_record public.matches%rowtype;
  segment_record public.match_segments%rowtype;
  settings_record public.commentary_settings%rowtype;
  saved public.match_commentaries;
  segment_count integer;
  expected_per_side integer;
  assignment_count integer;
  cardinal_count integer;
  silver_count integer;
  baseline_handicap integer := 0;
  total_holes integer;
  current_hole_number integer;
  played_index integer;
  check_index integer;
  cardinal_score integer;
  silver_score integer;
  derived_differential integer := 0;
  derived_holes_played integer := 0;

  hole_winner integer;
  winner_sign integer;
  hole_winners integer[] := array[]::integer[];
  running_leads integer[] := array[]::integer[];
  current_streak integer := 0;
  current_streak_start integer;
  longest_streak integer := 0;
  streak_start_hole integer;
  streak_end_hole integer;
  lead_for_good_hole integer;
  lead_stayed boolean;
  cardinal_label text;
  silver_label text;
  winner_label text;
  turning_side_label text;

  participant_text text;
  result_text text;
  turning_text text;
  closing_phrase text;
  recap_text text;
  result_facts jsonb;
begin
  if target_commentary_type <> 'post_match' or target_segment_id is not null then
    raise exception 'Only post-match recaps are supported';
  end if;

  select source_match.* into match_record
  from public.matches source_match
  where source_match.id = target_match_id
  for share;
  if match_record.id is null then raise exception 'Match not found'; end if;
  if not (public.is_admin() or public.is_tournament_admin(match_record.tournament_id)) then
    raise exception 'Administrator access required';
  end if;
  if match_record.status <> 'final' then raise exception 'Post-match commentary requires a finalized match'; end if;

  select settings.* into settings_record
  from public.commentary_settings settings
  where settings.tournament_id = match_record.tournament_id;
  if settings_record.tournament_id is null or not settings_record.enabled then
    raise exception 'AI commentary is disabled for this tournament';
  end if;

  select count(*) into segment_count
  from public.match_segments segment
  where segment.match_id = target_match_id;
  if segment_count <> 1 then
    raise exception 'Short factual recaps require a one-segment match';
  end if;

  select segment.* into segment_record
  from public.match_segments segment
  where segment.match_id = target_match_id
  for share;
  if segment_record.status <> 'final' then raise exception 'Commentary requires a finalized segment'; end if;
  if segment_record.format not in ('singles', 'fourball') then
    raise exception 'Short factual recaps support only Singles and Four-Ball';
  end if;

  perform locked_assignment.segment_id
  from public.match_segment_players locked_assignment
  where locked_assignment.segment_id = segment_record.id
  order by locked_assignment.user_id
  for share of locked_assignment;

  perform round_record.id
  from public.rounds round_record
  where round_record.match_id = target_match_id
  order by round_record.id
  for share;

  perform score_record.id
  from public.scores score_record
  join public.rounds round_record on round_record.id = score_record.round_id
  where round_record.match_id = target_match_id
  order by score_record.round_id, score_record.hole_number
  for share of score_record;

  perform hole_record.tee_id
  from public.holes hole_record
  join public.rounds round_record on round_record.tee_id = hole_record.tee_id
  where round_record.match_id = target_match_id
  order by hole_record.tee_id, hole_record.hole_number
  for share of hole_record;

  expected_per_side := case when segment_record.format = 'singles' then 1 else 2 end;
  select count(*),
         count(*) filter (where assignment.side = 'cardinal'),
         count(*) filter (where assignment.side = 'silver')
    into assignment_count, cardinal_count, silver_count
  from public.match_segment_players assignment
  where assignment.segment_id = segment_record.id;
  if assignment_count <> expected_per_side * 2
     or cardinal_count <> expected_per_side
     or silver_count <> expected_per_side then
    raise exception 'Commentary requires the complete format lineup';
  end if;

  select string_agg(trim(profile.display_name), ' & ' order by assignment.playing_order, profile.id)
    into cardinal_label
  from public.match_segment_players assignment
  join public.profiles profile on profile.id = assignment.user_id
  where assignment.segment_id = segment_record.id and assignment.side = 'cardinal';
  select string_agg(trim(profile.display_name), ' & ' order by assignment.playing_order, profile.id)
    into silver_label
  from public.match_segment_players assignment
  join public.profiles profile on profile.id = assignment.user_id
  where assignment.segment_id = segment_record.id and assignment.side = 'silver';
  if cardinal_label is null or silver_label is null or cardinal_label = '' or silver_label = '' then
    raise exception 'Commentary requires participant labels';
  end if;

  -- Match migration 022's completeness and metadata checks before replaying a result.
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
    raise exception 'Commentary requires one valid persisted round per assigned player';
  end if;

  if segment_record.scoring_mode = 'net' and (
    segment_record.handicap_allowance is null
    or exists (
      select 1
      from public.match_segment_players assignment
      join public.rounds round_record
        on round_record.match_id = target_match_id and round_record.user_id = assignment.user_id
      where assignment.segment_id = segment_record.id and round_record.course_handicap is null
    )
  ) then
    raise exception 'Net commentary requires complete handicap data';
  end if;

  if exists (
    select 1
    from public.match_segment_players assignment
    cross join lateral generate_series(segment_record.start_hole, segment_record.end_hole) expected_hole(hole_number)
    where assignment.segment_id = segment_record.id
      and not exists (
        select 1
        from public.rounds round_record
        join public.scores score_record
          on score_record.round_id = round_record.id and score_record.hole_number = expected_hole.hole_number
        join public.holes hole_record
          on hole_record.tee_id = round_record.tee_id and hole_record.hole_number = expected_hole.hole_number
        where round_record.match_id = target_match_id
          and round_record.user_id = assignment.user_id
          and round_record.course_id = match_record.course_id
      )
  ) then
    raise exception 'Commentary requires complete persisted hole scores and tee stroke indexes';
  end if;

  if segment_record.scoring_mode = 'net' and exists (
    select 1
    from public.match_segment_players assignment
    join public.rounds round_record
      on round_record.match_id = target_match_id and round_record.user_id = assignment.user_id
    join public.holes hole_record on hole_record.tee_id = round_record.tee_id
      and hole_record.hole_number between segment_record.start_hole and segment_record.end_hole
    where assignment.segment_id = segment_record.id
      and (hole_record.stroke_index is null or hole_record.stroke_index not between 1 and 18)
  ) then
    raise exception 'Net commentary requires valid tee stroke indexes';
  end if;

  if segment_record.scoring_mode = 'net' and exists (
    select 1
    from generate_series(segment_record.start_hole, segment_record.end_hole) expected_hole(hole_number)
    where (select count(distinct hole_record.stroke_index)
           from public.match_segment_players assignment
           join public.rounds round_record
             on round_record.match_id = target_match_id and round_record.user_id = assignment.user_id
           join public.holes hole_record
             on hole_record.tee_id = round_record.tee_id and hole_record.hole_number = expected_hole.hole_number
           where assignment.segment_id = segment_record.id) <> 1
  ) then
    raise exception 'Net commentary requires matching tee stroke indexes';
  end if;

  if segment_record.scoring_mode = 'net' then
    select min(floor(round_record.course_handicap * segment_record.handicap_allowance / 100.0 + 0.5)::integer)
      into baseline_handicap
    from public.match_segment_players assignment
    join public.rounds round_record
      on round_record.match_id = target_match_id and round_record.user_id = assignment.user_id
    where assignment.segment_id = segment_record.id;
  end if;

  total_holes := segment_record.end_hole - segment_record.start_hole + 1;
  for current_hole_number in segment_record.start_hole..segment_record.end_hole loop
    select
      min(case when assignment.side = 'cardinal' then
        score_record.gross_score - case when segment_record.scoring_mode = 'net' then
          floor(greatest(0, floor(round_record.course_handicap * segment_record.handicap_allowance / 100.0 + 0.5)::integer - baseline_handicap) / 18.0)::integer
          + case when hole_record.stroke_index <= mod(greatest(0, floor(round_record.course_handicap * segment_record.handicap_allowance / 100.0 + 0.5)::integer - baseline_handicap), 18) then 1 else 0 end
        else 0 end
      end),
      min(case when assignment.side = 'silver' then
        score_record.gross_score - case when segment_record.scoring_mode = 'net' then
          floor(greatest(0, floor(round_record.course_handicap * segment_record.handicap_allowance / 100.0 + 0.5)::integer - baseline_handicap) / 18.0)::integer
          + case when hole_record.stroke_index <= mod(greatest(0, floor(round_record.course_handicap * segment_record.handicap_allowance / 100.0 + 0.5)::integer - baseline_handicap), 18) then 1 else 0 end
        else 0 end
      end)
      into cardinal_score, silver_score
    from public.match_segment_players assignment
    join public.rounds round_record
      on round_record.match_id = target_match_id and round_record.user_id = assignment.user_id
    join public.scores score_record
      on score_record.round_id = round_record.id and score_record.hole_number = current_hole_number
    join public.holes hole_record
      on hole_record.tee_id = round_record.tee_id and hole_record.hole_number = current_hole_number
    where assignment.segment_id = segment_record.id;

    hole_winner := case when cardinal_score < silver_score then 1 when silver_score < cardinal_score then -1 else 0 end;
    derived_differential := derived_differential + hole_winner;
    derived_holes_played := derived_holes_played + 1;
    hole_winners := array_append(hole_winners, hole_winner);
    running_leads := array_append(running_leads, derived_differential);
    exit when derived_holes_played >= total_holes
      or abs(derived_differential) > total_holes - derived_holes_played;
  end loop;

  if derived_differential is distinct from segment_record.differential
     or derived_holes_played is distinct from segment_record.holes_played then
    raise exception 'Stored final result does not match persisted scores';
  end if;

  participant_text := cardinal_label || ' vs ' || silver_label || ': ';
  if derived_differential = 0 then
    result_text := 'Match halved';
    if derived_holes_played >= 2 then
      for check_index in reverse derived_holes_played..2 loop
        if running_leads[check_index] = 0 and running_leads[check_index - 1] <> 0 then
          turning_side_label := case when hole_winners[check_index] = 1 then cardinal_label
                                     when hole_winners[check_index] = -1 then silver_label
                                     else null end;
          if turning_side_label is null then raise exception 'Unable to prove the halved-match turning point'; end if;
          turning_text := turning_side_label || ' squared the match on hole '
            || (segment_record.start_hole + check_index - 1) || '.';
          exit;
        end if;
      end loop;
    end if;
    if turning_text is null then
      turning_text := 'Every counted hole was halved; neither side found an opening.';
    end if;
  else
    winner_sign := case when derived_differential > 0 then 1 else -1 end;
    winner_label := case when winner_sign = 1 then cardinal_label else silver_label end;

    result_text := winner_label || ' wins ' || abs(derived_differential)
      || case when derived_holes_played = total_holes then ' Up'
              else ' & ' || (total_holes - derived_holes_played) end;

    for played_index in 1..derived_holes_played loop
      if hole_winners[played_index] = winner_sign then
        if current_streak = 0 then current_streak_start := segment_record.start_hole + played_index - 1; end if;
        current_streak := current_streak + 1;
        if current_streak > longest_streak then
          longest_streak := current_streak;
          streak_start_hole := current_streak_start;
          streak_end_hole := segment_record.start_hole + played_index - 1;
        end if;
      else
        current_streak := 0;
      end if;
    end loop;

    -- Deterministic tie-break: order by streak_length desc, start_hole asc.
    if longest_streak >= 2 then
      turning_text := 'The damage came on holes ' || streak_start_hole || '–' || streak_end_hole
        || ', where ' || winner_label || ' won ' || longest_streak || ' straight.';
    else
      for played_index in 1..derived_holes_played loop
        if running_leads[played_index] * winner_sign > 0 then
          lead_stayed := true;
          if played_index < derived_holes_played then
            for check_index in (played_index + 1)..derived_holes_played loop
              if running_leads[check_index] * winner_sign <= 0 then lead_stayed := false; exit; end if;
            end loop;
          end if;
          if lead_stayed then
            lead_for_good_hole := segment_record.start_hole + played_index - 1;
            exit;
          end if;
        end if;
      end loop;
      if lead_for_good_hole is null then raise exception 'Unable to prove a turning point'; end if;
      turning_text := winner_label || ' took the lead for good on hole ' || lead_for_good_hole || '.';
    end if;
  end if;

  closing_phrase := case settings_record.tone || ':' || target_phrase_id
    when 'clean:clean_steady' then 'A composed finish settled the contest.'
    when 'clean:clean_clinical' then 'The result was secured with a disciplined close.'
    when 'clean:clean_complete' then 'The scorecard confirms a complete performance.'
    when 'clean:clean_decisive' then 'A decisive finish put the result beyond doubt.'
    when 'clean:clean_halved_even' then 'The scorecard confirms an evenly shared match.'
    when 'clean:clean_halved_complete' then 'The full card ended with the point shared.'
    when 'playful:playful_excuses' then 'The winners get bragging rights; the losers get first crack at the excuses.'
    when 'playful:playful_group_chat' then 'Bragging rights secured. The scorecard has entered the group chat.'
    when 'playful:playful_recount' then 'The card is signed; recount requests have been denied by the scorecard.'
    when 'playful:playful_character' then 'One side gets the win. The other gets a little character development.'
    when 'playful:playful_receipts' then 'The scorecard kept the receipts, and it is not accepting revisions.'
    when 'playful:playful_cart_ride' then 'The result is on the card. The wheels are officially loose.'
    when 'playful:playful_halved_claims' then 'Nobody gets the win, so the scorecard gets the last laugh.'
    when 'playful:playful_halved_brags' then 'The match was halved; the scorecard declined to pick a favorite.'
    when 'ruthless:ruthless_no_appeal' then 'The scorecard leaves no appeal and even less sympathy.'
    when 'ruthless:ruthless_character' then 'One side earned the win. The other earned character development.'
    when 'ruthless:ruthless_receipts' then 'The scorecard kept every receipt. None of them favor the losing side.'
    when 'ruthless:ruthless_verdict' then 'The verdict arrived, and the excuses were ruled inadmissible.'
    when 'ruthless:ruthless_resume' then 'Put it on the winners’ résumé and file the other copy under hard lessons.'
    when 'ruthless:ruthless_silence' then 'The result is official. The scorecard has closed comments.'
    when 'ruthless:ruthless_halved_stalemate' then 'The full card produced no winner and no appeal.'
    when 'ruthless:ruthless_halved_brags' then 'No winner, no loser, and no room for creative scorekeeping.'
    when 'savage:savage_competition_left' then 'The losing side was still on the scorecard, but the competition had already left.'
    when 'savage:savage_apology' then 'An answer was required. An apology would have been more realistic.'
    when 'savage:savage_rental' then 'The losing side spent the finish renting space on someone else’s scoreboard.'
    when 'savage:savage_evidence' then 'There was hope. Then the scorecard introduced evidence.'
    when 'savage:savage_itemized' then 'The scorecard kept the receipts and itemized the damage.'
    when 'savage:savage_closed_case' then 'The result needs no explanation. The scorecard already closed the case.'
    when 'savage:savage_halved_afternoon' then 'Nobody lost, nobody won, and the scorecard would like its afternoon back.'
    when 'savage:savage_halved_explanations' then 'The full match produced no winner—just two sides preparing very confident explanations.'
    else null
  end;
  if closing_phrase is null then raise exception 'Invalid commentary phrase identifier'; end if;
  if (derived_differential = 0) is distinct from (target_phrase_id like '%_halved_%') then
    raise exception 'Commentary phrase does not match the result';
  end if;

  recap_text := participant_text || result_text || '. ' || turning_text || ' ' || closing_phrase;
  if char_length(recap_text) > settings_record.max_characters then
    raise exception 'Composed commentary exceeds the configured length';
  end if;
  result_facts := jsonb_build_object(
    'status', match_record.status,
    'format', segment_record.format,
    'scoringMode', segment_record.scoring_mode,
    'participants', jsonb_build_object('blue', cardinal_label, 'white', silver_label),
    'result', result_text,
    'turningPoint', turning_text,
    'segment', jsonb_build_object('id', segment_record.id, 'startHole', segment_record.start_hole,
      'endHole', segment_record.end_hole, 'differential', derived_differential,
      'holesPlayed', derived_holes_played)
  );

  select commentary.* into saved
  from public.match_commentaries commentary
  where commentary.match_id = target_match_id
    and commentary.commentary_type = 'post_match'
    and commentary.segment_id is null
    and commentary.status <> 'hidden'
  for update;

  if target_regenerate and saved.id is not null then
    update public.match_commentaries
    set commentary = recap_text,
        original_commentary = recap_text,
        facts = result_facts,
        ai_generated = true,
        model = nullif(trim(target_model), ''),
        status = case when settings_record.require_approval then 'draft' else 'approved' end,
        generated_by = auth.uid(),
        approved_by = case when settings_record.require_approval then null else auth.uid() end,
        approved_at = case when settings_record.require_approval then null else now() end,
        edited_by = null,
        edited_at = null,
        created_at = now()
    where id = saved.id
    returning * into saved;
    return saved;
  end if;
  if saved.id is not null then return saved; end if;

  insert into public.match_commentaries(
    match_id, segment_id, commentary_type, commentary, original_commentary,
    facts, ai_generated, model, status, generated_by, approved_by, approved_at
  ) values (
    target_match_id, null, 'post_match', recap_text, recap_text,
    result_facts, true, nullif(trim(target_model), ''), 'draft', auth.uid(), null, null
  ) returning * into saved;
  return saved;
end;
$$;

revoke all on function public.create_commentary_draft(uuid, uuid, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.create_commentary_draft(uuid, uuid, text, text, text, boolean) to authenticated;
