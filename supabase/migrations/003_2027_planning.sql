-- 2027 itinerary, mixed-format match segments, rules, statistics, and AI commentary.
-- Apply after 002_tournament_access.sql.

create extension if not exists btree_gist with schema extensions;

alter table public.matches drop constraint if exists matches_format_check;
alter table public.matches add constraint matches_format_check
  check (format in ('singles', 'fourball', 'foursomes', 'scramble', 'shamble', 'chapman'));

create table if not exists public.tournament_events (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  title text not null,
  event_type text not null default 'golf' check (event_type in ('travel', 'golf', 'activity', 'meal', 'other')),
  starts_at timestamptz not null,
  ends_at timestamptz,
  course_id uuid references public.courses(id) on delete set null,
  is_competitive boolean not null default false,
  notes text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tournament_id, title, starts_at),
  check (ends_at is null or ends_at >= starts_at)
);

create table if not exists public.match_segments (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  segment_number integer not null check (segment_number > 0),
  start_hole integer not null check (start_hole between 1 and 18),
  end_hole integer not null check (end_hole between 1 and 18 and end_hole >= start_hole),
  format text not null check (format in ('singles', 'fourball', 'foursomes', 'scramble', 'shamble', 'chapman')),
  scoring_mode text not null check (scoring_mode in ('gross', 'net')),
  handicap_allowance numeric(5,2) check (handicap_allowance between 0 and 100),
  point_value numeric(4,2) not null default 1 check (point_value > 0 and point_value <= 9),
  status text not null default 'scheduled' check (status in ('scheduled', 'live', 'final')),
  differential integer not null default 0,
  holes_played integer not null default 0 check (holes_played between 0 and 18),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, match_id),
  unique (match_id, segment_number),
  check (scoring_mode = 'gross' or handicap_allowance is not null),
  exclude using gist (
    match_id with =,
    int4range(start_hole, end_hole, '[]') with &&
  )
);

create table if not exists public.match_segment_players (
  segment_id uuid not null references public.match_segments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  team text not null check (team in ('cardinal', 'silver')),
  side text not null check (side in ('cardinal', 'silver')),
  playing_order integer not null default 1 check (playing_order between 1 and 4),
  primary key (segment_id, user_id),
  unique (segment_id, playing_order)
);

create table if not exists public.tournament_rules (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  title text not null,
  body text not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tournament_id, title)
);

create table if not exists public.commentary_settings (
  tournament_id uuid primary key references public.tournaments(id) on delete cascade,
  enabled boolean not null default false,
  tone text not null default 'playful' check (tone in ('clean', 'playful', 'ruthless')),
  timing text not null default 'post_match' check (timing in ('post_match', 'segment_and_match')),
  require_approval boolean not null default true check (require_approval),
  max_characters integer not null default 600 check (max_characters between 120 and 2000),
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

create table if not exists public.match_commentaries (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches(id) on delete cascade,
  segment_id uuid,
  commentary_type text not null default 'post_match' check (commentary_type in ('segment', 'post_match')),
  commentary text not null check (char_length(commentary) between 1 and 2000),
  facts jsonb not null default '{}'::jsonb,
  ai_generated boolean not null default true,
  model text,
  status text not null default 'draft' check (status in ('draft', 'approved', 'hidden')),
  generated_by uuid references public.profiles(id),
  approved_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  foreign key (segment_id, match_id) references public.match_segments(id, match_id) on delete cascade,
  check (
    (commentary_type = 'segment' and segment_id is not null)
    or (commentary_type = 'post_match' and segment_id is null)
  ),
  check ((status = 'approved' and approved_by is not null and approved_at is not null) or status <> 'approved')
);

create index if not exists tournament_events_tournament_time_idx
  on public.tournament_events(tournament_id, starts_at);
create index if not exists match_segments_match_idx
  on public.match_segments(match_id, segment_number);
create index if not exists match_segment_players_user_idx
  on public.match_segment_players(user_id);
create index if not exists match_commentaries_match_idx
  on public.match_commentaries(match_id, status, created_at desc);

alter table public.tournament_events enable row level security;
alter table public.match_segments enable row level security;
alter table public.match_segment_players enable row level security;
alter table public.tournament_rules enable row level security;
alter table public.commentary_settings enable row level security;
alter table public.match_commentaries enable row level security;

create policy "members view tournament events" on public.tournament_events
  for select to authenticated
  using (public.is_admin() or public.has_tournament_access(tournament_id));
create policy "admins manage tournament events" on public.tournament_events
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "members view match segments" on public.match_segments
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.matches match_record
      where match_record.id = match_id
        and public.has_tournament_access(match_record.tournament_id)
    )
  );
create policy "admins manage match segments" on public.match_segments
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "members view segment lineups" on public.match_segment_players
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1
      from public.match_segments segment
      join public.matches match_record on match_record.id = segment.match_id
      where segment.id = segment_id
        and public.has_tournament_access(match_record.tournament_id)
    )
  );
create policy "admins manage segment lineups" on public.match_segment_players
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "members view active rules" on public.tournament_rules
  for select to authenticated
  using (public.is_admin() or (active and public.has_tournament_access(tournament_id)));
create policy "admins manage tournament rules" on public.tournament_rules
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "members view commentary settings" on public.commentary_settings
  for select to authenticated
  using (public.is_admin() or public.has_tournament_access(tournament_id));
create policy "admins manage commentary settings" on public.commentary_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "members view approved commentary" on public.match_commentaries
  for select to authenticated
  using (
    public.is_admin()
    or (
      status = 'approved'
      and exists (
        select 1 from public.matches match_record
        where match_record.id = match_id
          and public.has_tournament_access(match_record.tournament_id)
      )
    )
  );
create or replace function public.save_match_plan(match_payload jsonb, segment_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  saved_match_id uuid;
  saved_segment_id uuid;
  segment_record jsonb;
  player_record jsonb;
  expected_start integer := 1;
  start_value integer;
  end_value integer;
  member_team text;
  expected_players_per_side integer;
  cardinal_player_count integer;
  silver_player_count integer;
  player_count integer;
  unique_player_count integer;
  unique_order_count integer;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  if jsonb_array_length(segment_payload) = 0 then
    raise exception 'At least one segment is required';
  end if;

  if nullif(match_payload ->> 'id', '') is null then
    insert into public.matches(name, session, format, scoring_mode, starts_at, course_id, tournament_id, status)
    values (
      trim(match_payload ->> 'name'),
      trim(match_payload ->> 'session'),
      segment_payload -> 0 ->> 'format',
      segment_payload -> 0 ->> 'scoring_mode',
      nullif(match_payload ->> 'starts_at', '')::timestamptz,
      nullif(match_payload ->> 'course_id', '')::uuid,
      (match_payload ->> 'tournament_id')::uuid,
      'scheduled'
    ) returning id into saved_match_id;
  else
    saved_match_id := (match_payload ->> 'id')::uuid;
    update public.matches set
      name = trim(match_payload ->> 'name'),
      session = trim(match_payload ->> 'session'),
      format = segment_payload -> 0 ->> 'format',
      scoring_mode = segment_payload -> 0 ->> 'scoring_mode',
      starts_at = nullif(match_payload ->> 'starts_at', '')::timestamptz,
      course_id = nullif(match_payload ->> 'course_id', '')::uuid,
      tournament_id = (match_payload ->> 'tournament_id')::uuid,
      status = 'scheduled'
    where id = saved_match_id;
    if not found then raise exception 'Match not found'; end if;
  end if;

  delete from public.match_players where match_id = saved_match_id;
  delete from public.match_segments where match_id = saved_match_id;

  for segment_record in
    select value from jsonb_array_elements(segment_payload) with ordinality ordered(value, position)
    order by position
  loop
    start_value := (segment_record ->> 'start_hole')::integer;
    end_value := (segment_record ->> 'end_hole')::integer;
    if start_value <> expected_start then
      raise exception 'Segments must cover holes 1 through 18 without gaps or overlaps';
    end if;
    expected_start := end_value + 1;

    expected_players_per_side := case segment_record ->> 'format'
      when 'singles' then 1
      when 'fourball' then 2
      when 'foursomes' then 2
      when 'scramble' then 2
      when 'shamble' then 2
      when 'chapman' then 2
      else null
    end;
    if expected_players_per_side is null then
      raise exception 'Unsupported segment format';
    end if;

    if exists (
      select 1
      from jsonb_array_elements(coalesce(segment_record -> 'players', '[]'::jsonb)) as invalid_players(player)
      where invalid_players.player ->> 'side' not in ('cardinal', 'silver')
        or coalesce(invalid_players.player ->> 'playing_order', '') !~ '^[1-4]$'
        or coalesce(invalid_players.player ->> 'user_id', '') = ''
    ) then
      raise exception 'Every segment player requires a valid side, user, and playing order';
    end if;

    select
      count(*),
      count(*) filter (where player ->> 'side' = 'cardinal'),
      count(*) filter (where player ->> 'side' = 'silver'),
      count(distinct player ->> 'user_id'),
      count(distinct (player ->> 'playing_order')::integer)
    into player_count, cardinal_player_count, silver_player_count, unique_player_count, unique_order_count
    from jsonb_array_elements(coalesce(segment_record -> 'players', '[]'::jsonb)) as players(player);

    if cardinal_player_count <> expected_players_per_side
       or silver_player_count <> expected_players_per_side
       or player_count <> expected_players_per_side * 2 then
      raise exception 'Segment format requires exactly % player(s) per side', expected_players_per_side;
    end if;
    if unique_player_count <> player_count then
      raise exception 'Segment players must be unique';
    end if;
    if unique_order_count <> player_count then
      raise exception 'Segment playing orders must be unique';
    end if;

    insert into public.match_segments(
      match_id, segment_number, start_hole, end_hole, format, scoring_mode,
      handicap_allowance, point_value
    ) values (
      saved_match_id,
      (segment_record ->> 'segment_number')::integer,
      start_value,
      end_value,
      segment_record ->> 'format',
      segment_record ->> 'scoring_mode',
      nullif(segment_record ->> 'handicap_allowance', '')::numeric,
      (segment_record ->> 'point_value')::numeric
    ) returning id into saved_segment_id;

    for player_record in select value from jsonb_array_elements(coalesce(segment_record -> 'players', '[]'::jsonb))
    loop
      member_team := null;
      select membership.team into member_team
      from public.tournament_memberships membership
      where membership.tournament_id = (match_payload ->> 'tournament_id')::uuid
        and membership.user_id = (player_record ->> 'user_id')::uuid
        and membership.status = 'active';

      if member_team is null then
        raise exception 'Every segment player must be an active tournament member with a team';
      end if;
      if (player_record ->> 'team') is distinct from member_team then
        raise exception 'Segment player team must match tournament membership';
      end if;

      insert into public.match_segment_players(segment_id, user_id, team, side, playing_order)
      values (
        saved_segment_id,
        (player_record ->> 'user_id')::uuid,
        member_team,
        player_record ->> 'side',
        coalesce((player_record ->> 'playing_order')::integer, 1)
      );
      insert into public.match_players(match_id, user_id, team)
      values (saved_match_id, (player_record ->> 'user_id')::uuid, member_team)
      on conflict (match_id, user_id) do update set team = excluded.team;
    end loop;
  end loop;

  if expected_start <> 19 then
    raise exception 'Segments must cover holes 1 through 18 without gaps or overlaps';
  end if;

  return saved_match_id;
end;
$$;

revoke all on function public.save_match_plan(jsonb, jsonb) from public;
grant execute on function public.save_match_plan(jsonb, jsonb) to authenticated;

create or replace function public.prevent_final_match_changes()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.status = 'final' then
    raise exception 'Finalized matches cannot be changed or deleted';
  end if;
  if tg_op = 'UPDATE' then return new; end if;
  return old;
end;
$$;

drop trigger if exists freeze_final_matches on public.matches;
create trigger freeze_final_matches
before update or delete on public.matches
for each row execute function public.prevent_final_match_changes();

create or replace function public.prevent_final_match_plan_changes()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  protected_match_id uuid;
  protected_segment_status text;
begin
  if tg_table_name = 'match_segment_players' then
    select segment.match_id, segment.status
      into protected_match_id, protected_segment_status
    from public.match_segments segment
    where segment.id = old.segment_id;
  elsif tg_table_name = 'match_segments' then
    protected_match_id := old.match_id;
    protected_segment_status := old.status;
  else
    protected_match_id := old.match_id;
  end if;

  if protected_segment_status = 'final' or exists (
    select 1 from public.matches match_record
    where match_record.id = protected_match_id and match_record.status = 'final'
  ) then
    raise exception 'Finalized match plans cannot be changed or deleted';
  end if;
  if tg_op = 'UPDATE' then return new; end if;
  return old;
end;
$$;

drop trigger if exists freeze_final_match_segments on public.match_segments;
create trigger freeze_final_match_segments
before update or delete on public.match_segments
for each row execute function public.prevent_final_match_plan_changes();
drop trigger if exists freeze_final_match_players on public.match_players;
create trigger freeze_final_match_players
before update or delete on public.match_players
for each row execute function public.prevent_final_match_plan_changes();
drop trigger if exists freeze_final_segment_players on public.match_segment_players;
create trigger freeze_final_segment_players
before update or delete on public.match_segment_players
for each row execute function public.prevent_final_match_plan_changes();

create or replace function public.prevent_final_tee_changes()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  protected_tee_id uuid;
  protected_course_id uuid;
begin
  if tg_table_name = 'holes' then
    protected_tee_id := old.tee_id;
  elsif tg_table_name = 'tees' then
    protected_tee_id := old.id;
  else
    protected_course_id := old.id;
  end if;

  if exists (
    select 1
    from public.rounds round_record
    join public.matches match_record on match_record.id = round_record.match_id
    where match_record.status = 'final'
      and (round_record.tee_id = protected_tee_id or round_record.course_id = protected_course_id)
  ) then
    raise exception 'Course, tee, and hole metadata used by finalized matches is immutable';
  end if;
  if tg_op = 'UPDATE' then return new; end if;
  return old;
end;
$$;

drop trigger if exists freeze_final_tees on public.tees;
create trigger freeze_final_tees
before update or delete on public.tees
for each row execute function public.prevent_final_tee_changes();
drop trigger if exists freeze_final_holes on public.holes;
create trigger freeze_final_holes
before update or delete on public.holes
for each row execute function public.prevent_final_tee_changes();
drop trigger if exists freeze_final_courses on public.courses;
create trigger freeze_final_courses
before update or delete on public.courses
for each row execute function public.prevent_final_tee_changes();

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
    if tg_op <> 'INSERT' then
      old_match_id := nullif(to_jsonb(old) ->> 'match_id', '')::uuid;
    end if;
    if tg_op <> 'DELETE' then
      new_match_id := nullif(to_jsonb(new) ->> 'match_id', '')::uuid;
    end if;
  else
    if tg_op <> 'INSERT' then
      old_round_id := nullif(to_jsonb(old) ->> 'round_id', '')::uuid;
      select round_record.match_id into old_match_id
      from public.rounds round_record
      where round_record.id = old_round_id;
    end if;
    if tg_op <> 'DELETE' then
      new_round_id := nullif(to_jsonb(new) ->> 'round_id', '')::uuid;
      select round_record.match_id into new_match_id
      from public.rounds round_record
      where round_record.id = new_round_id;
    end if;
  end if;

  if exists (
    select 1 from public.matches match_record
    where match_record.id in (old_match_id, new_match_id)
      and match_record.status = 'final'
  ) then
    raise exception 'Finalized match rounds and scores cannot be changed';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists freeze_final_match_rounds on public.rounds;
create trigger freeze_final_match_rounds
before insert or update or delete on public.rounds
for each row execute function public.prevent_final_match_score_changes();

drop trigger if exists freeze_final_match_scores on public.scores;
create trigger freeze_final_match_scores
before insert or update or delete on public.scores
for each row execute function public.prevent_final_match_score_changes();

create or replace function public.finalize_match_results(target_match_id uuid, segment_results jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  match_record public.matches%rowtype;
  result_record jsonb;
  segment_record public.match_segments%rowtype;
  result_count integer;
  unique_result_count integer;
begin
  if not public.is_admin() then
    raise exception 'Administrator access required';
  end if;

  select * into match_record from public.matches
  where id = target_match_id for update;
  if match_record.id is null then raise exception 'Match not found'; end if;
  if match_record.status = 'final' then raise exception 'Finalized matches cannot be changed'; end if;
  if match_record.course_id is null then raise exception 'A match course is required before finalization'; end if;

  select count(*), count(distinct (result ->> 'segment_id')::uuid)
    into result_count, unique_result_count
  from jsonb_array_elements(coalesce(segment_results, '[]'::jsonb)) results(result);
  if result_count <> (select count(*) from public.match_segments where match_id = target_match_id)
     or unique_result_count <> result_count then
    raise exception 'Every segment must have one authoritative final result';
  end if;

  for result_record in select value from jsonb_array_elements(segment_results)
  loop
    select * into segment_record
    from public.match_segments
    where id = (result_record ->> 'segment_id')::uuid
      and match_id = target_match_id;
    if segment_record.id is null or result_record ->> 'status' <> 'final' then
      raise exception 'Every segment must have one authoritative final result';
    end if;
    if (result_record ->> 'holes_played')::integer < 1
       or (result_record ->> 'holes_played')::integer > segment_record.end_hole - segment_record.start_hole + 1
       or abs((result_record ->> 'differential')::integer) > (result_record ->> 'holes_played')::integer
       or (
         (result_record ->> 'differential')::integer = 0
         and (result_record ->> 'holes_played')::integer <> segment_record.end_hole - segment_record.start_hole + 1
       )
       or (
         (result_record ->> 'differential')::integer <> 0
         and (result_record ->> 'holes_played')::integer < segment_record.end_hole - segment_record.start_hole + 1
         and abs((result_record ->> 'differential')::integer)
           <= segment_record.end_hole - segment_record.start_hole + 1 - (result_record ->> 'holes_played')::integer
       ) then
      raise exception 'Segment result is not a valid completed match-play result';
    end if;

    update public.match_segments set
      differential = (result_record ->> 'differential')::integer,
      holes_played = (result_record ->> 'holes_played')::integer,
      status = 'final',
      updated_at = now()
    where id = segment_record.id;
  end loop;

  if exists (select 1 from public.match_segments where match_id = target_match_id and status <> 'final') then
    raise exception 'Every segment must have one authoritative final result';
  end if;

  if exists (
    select 1
    from (
      select distinct expected_assignment.user_id
      from public.match_segments expected_segment
      join public.match_segment_players expected_assignment
        on expected_assignment.segment_id = expected_segment.id
      where expected_segment.match_id = target_match_id
        and expected_segment.format in ('singles', 'fourball', 'shamble')
    ) needed_player
    where not exists (
      select 1
      from public.rounds round_record
      join public.tees tee_record on tee_record.id = round_record.tee_id
      where round_record.match_id = target_match_id
        and round_record.user_id = needed_player.user_id
        and round_record.course_id = match_record.course_id
        and tee_record.course_id = match_record.course_id
        and not exists (
          select 1
          from public.match_segments expected_segment
          join public.match_segment_players expected_assignment
            on expected_assignment.segment_id = expected_segment.id
          cross join lateral generate_series(expected_segment.start_hole, expected_segment.end_hole) expected_hole(hole_number)
          where expected_segment.match_id = target_match_id
            and expected_assignment.user_id = needed_player.user_id
            and expected_segment.format in ('singles', 'fourball', 'shamble')
            and not exists (
              select 1 from public.scores expected_score
              join public.holes expected_tee_hole
                on expected_tee_hole.tee_id = round_record.tee_id
               and expected_tee_hole.hole_number = expected_score.hole_number
              where expected_score.round_id = round_record.id
                and expected_score.hole_number = expected_hole.hole_number
            )
        )
    )
  ) then
    raise exception 'Assigned rounds required for official statistics are incomplete';
  end if;

  update public.matches set status = 'final' where id = target_match_id;
  return target_match_id;
end;
$$;

revoke all on function public.finalize_match_results(uuid, jsonb) from public;
grant execute on function public.finalize_match_results(uuid, jsonb) to authenticated;

create or replace function public.create_commentary_draft(
  target_match_id uuid,
  target_segment_id uuid,
  target_commentary_type text,
  target_commentary text,
  target_facts jsonb,
  target_model text
)
returns public.match_commentaries
language plpgsql
security definer
set search_path = public
as $$
declare saved public.match_commentaries;
begin
  if not public.is_admin() then raise exception 'Administrator access required'; end if;
  insert into public.match_commentaries(
    match_id, segment_id, commentary_type, commentary, facts, ai_generated,
    model, status, generated_by, approved_by, approved_at
  ) values (
    target_match_id, target_segment_id, target_commentary_type, trim(target_commentary),
    target_facts, true, target_model, 'draft', auth.uid(), null, null
  ) returning * into saved;
  return saved;
end;
$$;

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
  update public.match_commentaries set commentary = trim(target_commentary), status = 'draft',
    approved_by = null, approved_at = null
  where id = target_commentary_id returning * into saved;
  if saved.id is null then raise exception 'Commentary not found'; end if;
  return saved;
end;
$$;

create or replace function public.set_commentary_status(target_commentary_id uuid, target_status text)
returns public.match_commentaries
language plpgsql
security definer
set search_path = public
as $$
declare saved public.match_commentaries;
begin
  if not public.is_admin() then raise exception 'Administrator access required'; end if;
  if target_status not in ('draft', 'approved', 'hidden') then raise exception 'Invalid commentary status'; end if;
  update public.match_commentaries set
    status = target_status,
    approved_by = case when target_status = 'approved' then auth.uid() else null end,
    approved_at = case when target_status = 'approved' then now() else null end
  where id = target_commentary_id returning * into saved;
  if saved.id is null then raise exception 'Commentary not found'; end if;
  return saved;
end;
$$;

revoke all on function public.create_commentary_draft(uuid, uuid, text, text, jsonb, text) from public;
revoke all on function public.edit_commentary_draft(uuid, text) from public;
revoke all on function public.set_commentary_status(uuid, text) from public;
grant execute on function public.create_commentary_draft(uuid, uuid, text, text, jsonb, text) to authenticated;
grant execute on function public.edit_commentary_draft(uuid, text) to authenticated;
grant execute on function public.set_commentary_status(uuid, text) to authenticated;

create or replace view public.official_round_statistics
with (security_invoker = true)
as
select
  round_record.id as round_id,
  round_record.user_id,
  match_record.tournament_id,
  match_record.id as match_id,
  count(score.id)::integer as holes_played,
  sum(score.gross_score)::integer as gross_total,
  sum(hole.par)::integer as par_total,
  (sum(score.gross_score) - sum(hole.par))::integer as to_par
from public.rounds round_record
join public.matches match_record on match_record.id = round_record.match_id
join public.tees tee_record
  on tee_record.id = round_record.tee_id
 and tee_record.course_id = round_record.course_id
 and tee_record.course_id = match_record.course_id
join public.scores score on score.round_id = round_record.id
join public.holes hole
  on hole.tee_id = round_record.tee_id
 and hole.hole_number = score.hole_number
where match_record.status = 'final'
  and exists (
    select 1
    from public.match_segments expected_segment
    join public.match_segment_players expected_assignment
      on expected_assignment.segment_id = expected_segment.id
    where expected_segment.match_id = match_record.id
      and expected_assignment.user_id = round_record.user_id
      and expected_segment.format in ('singles', 'fourball', 'shamble')
      and score.hole_number between expected_segment.start_hole and expected_segment.end_hole
  )
group by round_record.id, round_record.user_id, round_record.tee_id, match_record.tournament_id, match_record.id
having count(score.id) = (
  select count(distinct expected_hole.hole_number)
  from public.match_segments expected_segment
  join public.match_segment_players expected_assignment
    on expected_assignment.segment_id = expected_segment.id
  cross join lateral generate_series(expected_segment.start_hole, expected_segment.end_hole) expected_hole(hole_number)
  where expected_segment.match_id = match_record.id
    and expected_assignment.user_id = round_record.user_id
    and expected_segment.format in ('singles', 'fourball', 'shamble')
)
and not exists (
  select 1
  from public.match_segments expected_segment
  join public.match_segment_players expected_assignment
    on expected_assignment.segment_id = expected_segment.id
  cross join lateral generate_series(expected_segment.start_hole, expected_segment.end_hole) expected_hole(hole_number)
  where expected_segment.match_id = match_record.id
    and expected_assignment.user_id = round_record.user_id
    and expected_segment.format in ('singles', 'fourball', 'shamble')
    and not exists (
      select 1
      from public.holes expected_tee_hole
      join public.scores expected_score
        on expected_score.round_id = round_record.id
       and expected_score.hole_number = expected_tee_hole.hole_number
      where expected_tee_hole.tee_id = round_record.tee_id
        and expected_tee_hole.hole_number = expected_hole.hole_number
    )
);

grant select, insert, update, delete on public.tournament_events to authenticated;
revoke insert, update, delete on public.matches from authenticated;
revoke insert, update, delete on public.match_players from authenticated;
revoke insert, update, delete on public.match_segments from authenticated;
revoke insert, update, delete on public.match_segment_players from authenticated;
grant select on public.match_segments to authenticated;
grant select on public.match_segment_players to authenticated;
grant select, insert, update, delete on public.tournament_rules to authenticated;
grant select, insert, update, delete on public.commentary_settings to authenticated;
revoke insert, update, delete on public.match_commentaries from authenticated;
grant select on public.match_commentaries to authenticated;
grant select on public.official_round_statistics to authenticated;

-- March 18–21, 2027 itinerary. Financial and private contact details are intentionally excluded.
do $$
declare
  admin_id uuid;
  tournament_id_value uuid;
begin
  select id into admin_id
  from public.profiles
  where role = 'admin'
  order by created_at
  limit 1;

  if admin_id is null then
    raise notice 'Skipping March 18–21, 2027 itinerary seed until an administrator exists.';
    return;
  end if;

  insert into public.tournaments(name, slug, edition_year, starts_on, ends_on, status, created_by)
  values ('Hereford Cup 2027', 'hereford-cup-2027', 2027, date '2027-03-18', date '2027-03-21', 'setup', admin_id)
  on conflict (slug) do update set
    name = excluded.name,
    edition_year = excluded.edition_year,
    starts_on = excluded.starts_on,
    ends_on = excluded.ends_on,
    updated_at = now()
  returning id into tournament_id_value;

  insert into public.tournament_events(tournament_id, title, event_type, starts_at, is_competitive, notes, sort_order)
  values
    (tournament_id_value, 'Tobacco Road fun round', 'golf', timestamptz '2027-03-18 13:00:00-04', false, 'Non-competition opening round.', 10),
    (tournament_id_value, 'Thistle Dhu putting course', 'activity', timestamptz '2027-03-18 19:00:00-04', false, null, 20),
    (tournament_id_value, 'Dinner at The Deuce', 'meal', timestamptz '2027-03-18 20:00:00-04', false, null, 30),
    (tournament_id_value, 'Pinehurst No. 3', 'golf', timestamptz '2027-03-19 08:00:00-04', true, 'Team competition begins.', 40),
    (tournament_id_value, 'Pinehurst No. 4', 'golf', timestamptz '2027-03-19 14:00:00-04', true, null, 50),
    (tournament_id_value, 'Dinner at Pinehurst Brewing Company', 'meal', timestamptz '2027-03-19 19:00:00-04', false, null, 60),
    (tournament_id_value, 'Pinehurst No. 2', 'golf', timestamptz '2027-03-20 10:00:00-04', true, 'Tee-time window 10:00–10:30 AM; caddies optional.', 70),
    (tournament_id_value, 'Long drive', 'activity', timestamptz '2027-03-20 16:00:00-04', false, null, 80),
    (tournament_id_value, 'The Cradle', 'golf', timestamptz '2027-03-20 18:00:00-04', false, 'Par-3 course; competition status to be confirmed.', 90),
    (tournament_id_value, 'Dinner', 'meal', timestamptz '2027-03-20 20:00:00-04', false, null, 100),
    (tournament_id_value, 'Pinehurst No. 10', 'golf', timestamptz '2027-03-21 07:30:00-04', true, 'Tee-time window 7:30–8:00 AM; walking only.', 110)
  on conflict (tournament_id, title, starts_at) do update set
    event_type = excluded.event_type,
    is_competitive = excluded.is_competitive,
    notes = excluded.notes,
    sort_order = excluded.sort_order,
    updated_at = now();

  insert into public.commentary_settings(tournament_id, enabled, tone, timing, require_approval, updated_by)
  values (tournament_id_value, true, 'playful', 'post_match', true, admin_id)
  on conflict (tournament_id) do nothing;
end;
$$;
