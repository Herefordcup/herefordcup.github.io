update public.tournament_rules
set body = replace(replace(body, 'Cardinal', 'Blue'), 'Silver', 'White'),
    updated_at = now()
where body like '%Cardinal%' or body like '%Silver%';

update public.match_commentaries
set commentary = replace(replace(commentary, 'Cardinal', 'Blue'), 'Silver', 'White'),
    original_commentary = case
      when original_commentary is null then null
      else replace(replace(original_commentary, 'Cardinal', 'Blue'), 'Silver', 'White')
    end,
    facts = case
      when jsonb_typeof(facts -> 'result') = 'string' then
        facts || jsonb_build_object(
          'result',
          replace(replace(facts ->> 'result', 'Cardinal', 'Blue'), 'Silver', 'White')
        )
      else facts
    end
where ai_generated
  and (
    commentary like '%Cardinal%' or commentary like '%Silver%'
    or original_commentary like '%Cardinal%' or original_commentary like '%Silver%'
    or facts ->> 'result' like '%Cardinal%' or facts ->> 'result' like '%Silver%'
  );

update public.legacy_editions
set final_score = replace(replace(final_score, 'Cardinal', 'Blue'), 'Silver', 'White')
where final_score like '%Cardinal%' or final_score like '%Silver%';

update public.legacy_results
set cardinal_entry = replace(replace(cardinal_entry, 'Cardinal', 'Blue'), 'Silver', 'White'),
    silver_entry = replace(replace(silver_entry, 'Cardinal', 'Blue'), 'Silver', 'White'),
    result = replace(replace(result, 'Cardinal', 'Blue'), 'Silver', 'White')
where cardinal_entry like '%Cardinal%' or cardinal_entry like '%Silver%'
   or silver_entry like '%Cardinal%' or silver_entry like '%Silver%'
   or result like '%Cardinal%' or result like '%Silver%';

create or replace function public.create_commentary_draft(
  target_match_id uuid,
  target_segment_id uuid,
  target_commentary_type text,
  target_phrase_id text,
  target_model text
)
returns public.match_commentaries
language plpgsql
security definer
set search_path = public
as $$
declare
  match_record public.matches%rowtype;
  segment_record public.match_segments%rowtype;
  settings_record public.commentary_settings%rowtype;
  closing_phrase text;
  result_text text;
  result_facts jsonb;
  cardinal_points numeric := 0;
  silver_points numeric := 0;
  saved public.match_commentaries;
begin
  if not public.is_admin() then raise exception 'Administrator access required'; end if;
  if target_commentary_type not in ('segment', 'post_match') then raise exception 'Invalid commentary type'; end if;

  select * into match_record from public.matches where id = target_match_id;
  if match_record.id is null then raise exception 'Match not found'; end if;
  select * into settings_record from public.commentary_settings where tournament_id = match_record.tournament_id;
  if settings_record.tournament_id is null or not settings_record.enabled then
    raise exception 'AI commentary is disabled for this tournament';
  end if;

  closing_phrase := case settings_record.tone || ':' || target_phrase_id
    when 'clean:clean_steady' then 'A composed finish settled the contest.'
    when 'clean:clean_clinical' then 'The result was secured with a disciplined close.'
    when 'playful:playful_pressure' then 'The pressure stayed on until the result was settled.'
    when 'playful:playful_scoreboard' then 'The scoreboard gets the final word.'
    when 'ruthless:ruthless_closed' then 'The door closed, and the scoreboard did not blink.'
    when 'ruthless:ruthless_final' then 'No spin needed; the result stands on its own.'
    else null
  end;
  if closing_phrase is null then raise exception 'Invalid commentary phrase identifier'; end if;

  if target_commentary_type = 'segment' then
    if target_segment_id is null then raise exception 'Segment commentary requires a segment'; end if;
    if settings_record.timing <> 'segment_and_match' then raise exception 'Segment commentary is disabled for this tournament'; end if;
    select * into segment_record from public.match_segments
      where id = target_segment_id and match_id = target_match_id and status = 'final';
    if segment_record.id is null then raise exception 'Commentary requires a finalized segment in this match'; end if;
    result_text := case
      when segment_record.differential = 0 then 'Match halved'
      when segment_record.holes_played = segment_record.end_hole - segment_record.start_hole + 1 then
        (case when segment_record.differential > 0 then 'Blue' else 'White' end)
          || ' wins ' || abs(segment_record.differential) || ' Up'
      else (case when segment_record.differential > 0 then 'Blue' else 'White' end)
          || ' wins ' || abs(segment_record.differential) || ' & '
          || (segment_record.end_hole - segment_record.start_hole + 1 - segment_record.holes_played)
    end;
    result_facts := jsonb_build_object(
      'status', segment_record.status,
      'result', result_text,
      'segment', jsonb_build_object(
        'id', segment_record.id, 'number', segment_record.segment_number,
        'startHole', segment_record.start_hole, 'endHole', segment_record.end_hole,
        'format', segment_record.format, 'scoringMode', segment_record.scoring_mode,
        'pointValue', segment_record.point_value, 'differential', segment_record.differential,
        'holesPlayed', segment_record.holes_played
      )
    );
  else
    if target_segment_id is not null then raise exception 'Post-match commentary cannot target a segment'; end if;
    if match_record.status <> 'final' or not exists (select 1 from public.match_segments where match_id = target_match_id)
       or exists (select 1 from public.match_segments where match_id = target_match_id and status <> 'final') then
      raise exception 'Post-match commentary requires a finalized match and segments';
    end if;
    select
      coalesce(sum(case when differential > 0 then point_value when differential = 0 then point_value / 2 else 0 end), 0),
      coalesce(sum(case when differential < 0 then point_value when differential = 0 then point_value / 2 else 0 end), 0)
      into cardinal_points, silver_points
    from public.match_segments where match_id = target_match_id;
    result_text := case when cardinal_points = silver_points then 'Match halved '
      when cardinal_points > silver_points then 'Blue wins '
      else 'White wins ' end || cardinal_points || '-' || silver_points;
    result_facts := jsonb_build_object(
      'status', match_record.status, 'result', result_text,
      'segments', (select jsonb_agg(jsonb_build_object(
        'id', segment.id, 'number', segment.segment_number,
        'startHole', segment.start_hole, 'endHole', segment.end_hole,
        'format', segment.format, 'scoringMode', segment.scoring_mode,
        'pointValue', segment.point_value, 'differential', segment.differential,
        'holesPlayed', segment.holes_played, 'status', segment.status
      ) order by segment.segment_number) from public.match_segments segment where segment.match_id = target_match_id)
    );
  end if;

  if char_length(result_text || '. ' || closing_phrase) > settings_record.max_characters then
    raise exception 'Composed commentary exceeds the configured length';
  end if;
  insert into public.match_commentaries(
    match_id, segment_id, commentary_type, commentary, original_commentary,
    facts, ai_generated, model, status, generated_by, approved_by, approved_at
  ) values (
    target_match_id, target_segment_id, target_commentary_type,
    result_text || '. ' || closing_phrase, result_text || '. ' || closing_phrase,
    result_facts, true, nullif(trim(target_model), ''), 'draft', auth.uid(), null, null
  ) returning * into saved;
  return saved;
end;
$$;

revoke all on function public.create_commentary_draft(uuid, uuid, text, text, text) from public;
grant execute on function public.create_commentary_draft(uuid, uuid, text, text, text) to authenticated;
