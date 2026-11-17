-- Forward-only production hardening for round authorization, immutable player scores,
-- finalized metadata, and server-derived commentary. Apply after 004_course_catalog.sql.

-- Course- and tee-aware round authorization. Migration 002 is already applied in
-- production, so its original two-argument function is replaced only here.
create or replace function public.can_create_round(
  target_user_id uuid,
  target_match_id uuid,
  target_course_id uuid,
  target_tee_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_user_id = auth.uid()
    and exists (
      select 1
      from public.tees tee_record
      where tee_record.id = target_tee_id
        and tee_record.course_id = target_course_id
    )
    and (
      (target_match_id is null and public.has_any_tournament_access())
      or exists (
        select 1
        from public.matches match_record
        join public.match_players assignment on assignment.match_id = match_record.id
        join public.tees tee_record on tee_record.id = target_tee_id
        where match_record.id = target_match_id
          and match_record.status <> 'final'
          and match_record.course_id = target_course_id
          and tee_record.course_id = target_course_id
          and tee_record.course_id = match_record.course_id
          and assignment.user_id = auth.uid()
          and public.has_tournament_access(match_record.tournament_id)
      )
    );
$$;

create or replace function public.can_write_round(target_round_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.rounds round_record
    where round_record.id = target_round_id
      and public.can_create_round(
        round_record.user_id,
        round_record.match_id,
        round_record.course_id,
        round_record.tee_id
      )
  );
$$;

revoke all on function public.can_create_round(uuid, uuid, uuid, uuid) from public;
grant execute on function public.can_create_round(uuid, uuid, uuid, uuid) to authenticated;

drop policy if exists "members create their round" on public.rounds;
create policy "members create their round" on public.rounds
  for insert to authenticated
  with check (public.can_create_round(user_id, match_id, course_id, tee_id));

drop policy if exists "members update their round" on public.rounds;
revoke update, delete on public.rounds from authenticated;
grant insert, select on public.rounds to authenticated;

drop function if exists public.can_create_round(uuid, uuid);

-- A score's denormalized user_id must always be the owner of its round.
do $$
begin
  if exists (
    select 1
    from public.scores score
    join public.rounds round_record on round_record.id = score.round_id
    where score.user_id is distinct from round_record.user_id
  ) then
    raise exception 'Score ownership integrity check failed: existing scores do not match their rounds';
  end if;
end;
$$;

alter table public.rounds
  add constraint rounds_id_user_id_key unique (id, user_id);
alter table public.scores
  add constraint scores_round_user_fkey
  foreign key (round_id, user_id) references public.rounds(id, user_id)
  on delete cascade not valid;
alter table public.scores validate constraint scores_round_user_fkey;

-- Players may submit a new hole score for their own authorized match round. The
-- tournament is monitored/honor-system: authorization is match-wide, not limited
-- to the player's assigned segment holes. A submitted hole is immutable to players.
drop policy if exists "players update their scores" on public.scores;
drop policy if exists "members update their scores" on public.scores;
drop policy if exists "players create their scores" on public.scores;
drop policy if exists "members create their scores" on public.scores;
drop policy if exists "admins manage scores" on public.scores;
create policy "members create immutable scores" on public.scores
  for insert to authenticated
  with check (public.can_write_score(round_id, user_id));

revoke update, delete on public.scores from authenticated;
grant insert, select on public.scores to authenticated;

create table if not exists public.score_correction_audit (
  id uuid primary key default gen_random_uuid(),
  score_id uuid,
  round_id uuid not null,
  user_id uuid not null,
  hole_number integer not null,
  action text not null check (action in ('insert', 'update', 'delete')),
  old_gross_score integer,
  new_gross_score integer,
  correction_reason text not null,
  corrected_by uuid not null references public.profiles(id),
  corrected_at timestamptz not null default now()
);
alter table public.score_correction_audit enable row level security;
create policy "administrators view score correction audit" on public.score_correction_audit
  for select to authenticated using (public.is_admin());
revoke insert, update, delete on public.score_correction_audit from authenticated;
grant select on public.score_correction_audit to authenticated;

-- Final scores remain frozen for players. The only authenticated mutation path for
-- an administrator is the validated SECURITY DEFINER correction RPC below.
create or replace function public.prevent_final_match_score_changes()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  old_round_id uuid;
  new_round_id uuid;
  old_match_id uuid;
  new_match_id uuid;
begin
  if tg_table_name = 'rounds' then
    if tg_op <> 'INSERT' then old_match_id := old.match_id; end if;
    if tg_op <> 'DELETE' then new_match_id := new.match_id; end if;
  else
    if tg_op <> 'INSERT' then
      old_round_id := old.round_id;
      select round_record.match_id into old_match_id from public.rounds round_record where round_record.id = old_round_id;
    end if;
    if tg_op <> 'DELETE' then
      new_round_id := new.round_id;
      select round_record.match_id into new_match_id from public.rounds round_record where round_record.id = new_round_id;
    end if;
  end if;

  if exists (
    select 1 from public.matches match_record
    where match_record.id in (old_match_id, new_match_id)
      and match_record.status = 'final'
  ) and not (tg_table_name = 'scores' and public.is_admin()) then
    raise exception 'Finalized match rounds and scores cannot be changed';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

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
  target_round public.rounds%rowtype;
  score_user_id uuid;
  existing_score public.scores%rowtype;
  saved_score public.scores;
  audit_action text;
begin
  if not public.is_admin() then raise exception 'Administrator access required'; end if;
  if char_length(trim(target_reason)) not between 1 and 500 then raise exception 'Correction reason is required'; end if;
  if target_hole_number not between 1 and 18 then raise exception 'Hole number must be between 1 and 18'; end if;
  if delete_score and target_gross_score is not null then raise exception 'Delete corrections cannot include a gross score'; end if;
  if not delete_score and (target_gross_score is null or target_gross_score not between 1 and 15) then
    raise exception 'Gross score must be between 1 and 15';
  end if;

  select source_round.* into target_round
  from public.rounds source_round
  where source_round.id = target_round_id
  for update;
  if target_round.id is null then raise exception 'Round not found'; end if;
  score_user_id := target_round.user_id;
  if not exists (
    select 1 from public.holes hole
    where hole.tee_id = target_round.tee_id and hole.hole_number = target_hole_number
  ) then
    raise exception 'Hole does not exist for the round tee';
  end if;

  select * into existing_score
  from public.scores
  where round_id = target_round_id and hole_number = target_hole_number
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
revoke all on function public.correct_hole_score(uuid, integer, text, integer, boolean) from public;
grant execute on function public.correct_hole_score(uuid, integer, text, integer, boolean) to authenticated;

-- Protect historical course data. Courses referenced directly by finalized matches
-- are protected even when no player round exists. Hole checks include INSERT and
-- both OLD and NEW tee relationships so rows cannot be moved into or out of history.
create or replace function public.prevent_final_tee_changes()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  old_tee_id uuid;
  new_tee_id uuid;
  old_course_id uuid;
  new_course_id uuid;
begin
  if tg_table_name = 'holes' then
    if tg_op <> 'INSERT' then old_tee_id := old.tee_id; end if;
    if tg_op <> 'DELETE' then new_tee_id := new.tee_id; end if;
  elsif tg_table_name = 'tees' then
    if tg_op <> 'INSERT' then
      old_tee_id := old.id;
      old_course_id := old.course_id;
    end if;
    if tg_op <> 'DELETE' then
      new_tee_id := new.id;
      new_course_id := new.course_id;
    end if;
  else
    if tg_op <> 'INSERT' then old_course_id := old.id; end if;
    if tg_op <> 'DELETE' then new_course_id := new.id; end if;
  end if;

  if old_tee_id is not null then
    select tee_record.course_id into old_course_id
    from public.tees tee_record where tee_record.id = old_tee_id;
  end if;
  if new_tee_id is not null then
    select tee_record.course_id into new_course_id
    from public.tees tee_record where tee_record.id = new_tee_id;
  end if;

  if exists (
    select 1
    from public.rounds round_record
    join public.matches match_record on match_record.id = round_record.match_id
    where match_record.status = 'final'
      and (round_record.tee_id in (old_tee_id, new_tee_id)
        or round_record.course_id in (old_course_id, new_course_id))
  ) or exists (
    select 1
    from public.matches match_record
    where match_record.status = 'final'
      and match_record.course_id in (old_course_id, new_course_id)
  ) then
    raise exception 'Course, tee, and hole metadata used by finalized matches is immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists freeze_final_holes on public.holes;
create trigger freeze_final_holes
before insert or update or delete on public.holes
for each row execute function public.prevent_final_tee_changes();
drop trigger if exists freeze_final_tees on public.tees;
create trigger freeze_final_tees
before update or delete on public.tees
for each row execute function public.prevent_final_tee_changes();
drop trigger if exists freeze_final_courses on public.courses;
create trigger freeze_final_courses
before update or delete on public.courses
for each row execute function public.prevent_final_tee_changes();

-- Preserve generated copy and record administrator edits without presenting edited
-- prose as AI-generated.
alter table public.match_commentaries add column if not exists original_commentary text;
alter table public.match_commentaries add column if not exists edited_by uuid references public.profiles(id);
alter table public.match_commentaries add column if not exists edited_at timestamptz;

-- Remove the unsafe overload that accepted caller-supplied prose and facts.
revoke all on function public.create_commentary_draft(uuid, uuid, text, text, jsonb, text) from public;
drop function if exists public.create_commentary_draft(uuid, uuid, text, text, jsonb, text);

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
        (case when segment_record.differential > 0 then 'Cardinal' else 'Silver' end)
          || ' wins ' || abs(segment_record.differential) || ' Up'
      else (case when segment_record.differential > 0 then 'Cardinal' else 'Silver' end)
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
      when cardinal_points > silver_points then 'Cardinal wins '
      else 'Silver wins ' end || cardinal_points || '-' || silver_points;
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

create or replace function public.edit_commentary_draft(target_commentary_id uuid, target_commentary text)
returns public.match_commentaries
language plpgsql
security definer
set search_path = public
as $$
declare saved public.match_commentaries;
begin
  if not public.is_admin() then raise exception 'Administrator access required'; end if;
  if char_length(trim(target_commentary)) not between 1 and 2000 then
    raise exception 'Commentary must be 1 through 2,000 characters';
  end if;
  update public.match_commentaries set
    original_commentary = coalesce(original_commentary, commentary),
    commentary = trim(target_commentary), status = 'draft',
    ai_generated = false, model = null,
    edited_by = auth.uid(), edited_at = now(),
    approved_by = null, approved_at = null
  where id = target_commentary_id returning * into saved;
  if saved.id is null then raise exception 'Commentary not found'; end if;
  return saved;
end;
$$;

revoke insert, update, delete on public.match_commentaries from authenticated;
