-- Shared Texas Scramble scorecards and outcome-only match-play entry.
-- Apply after 040_march_2027_itinerary.sql.

-- Publish the score tables, both planner entry points, and their grants together.
begin;

alter table public.match_segments
  add column if not exists entry_mode text not null default 'individual_scores';

alter table public.match_segments
  drop constraint if exists match_segments_entry_mode_check;
alter table public.match_segments
  add constraint match_segments_entry_mode_check
  check (entry_mode in ('individual_scores', 'hole_outcomes'));

alter table public.match_segments
  drop constraint if exists match_segments_point_value_check;
alter table public.match_segments
  add constraint match_segments_point_value_check
  check (
    (format = 'scramble' and point_value between 0 and 72)
    or (format <> 'scramble' and point_value > 0 and point_value <= 9)
  );

create table public.texas_scramble_sessions (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  session_label text not null check (length(btrim(session_label)) between 1 and 120),
  starts_at timestamptz not null,
  start_hole integer not null default 1 check (start_hole between 1 and 18),
  end_hole integer not null default 18 check (end_hole between start_hole and 18),
  required_tee_shots integer not null default 3 check (required_tee_shots >= 0 and required_tee_shots <= 9),
  course_id uuid references public.courses(id),
  tee_id uuid references public.tees(id),
  status text not null default 'scheduled' check (status in ('scheduled', 'live', 'final')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((course_id is null and tee_id is null) or (course_id is not null and tee_id is not null))
);

create table public.texas_scramble_squads (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.texas_scramble_sessions(id) on delete cascade,
  match_id uuid not null unique references public.matches(id) on delete cascade,
  segment_id uuid not null unique references public.match_segments(id) on delete cascade,
  label text not null check (length(btrim(label)) between 1 and 80),
  side text not null check (side in ('cardinal', 'silver')),
  squad_number integer not null check (squad_number > 0),
  squad_size integer not null check (squad_size in (2, 4)),
  status text not null default 'scheduled' check (status in ('scheduled', 'live', 'final')),
  playing_handicap integer,
  gross_total integer,
  net_score integer,
  par_total integer,
  points numeric(5,2),
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, side, squad_number),
  unique (id, session_id),
  foreign key (segment_id, match_id) references public.match_segments(id, match_id) on delete cascade,
  check ((status <> 'final') or (playing_handicap is not null and gross_total is not null and net_score is not null and par_total is not null and points is not null and finalized_at is not null))
);

create table public.texas_scramble_squad_players (
  squad_id uuid not null references public.texas_scramble_squads(id) on delete cascade,
  session_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  playing_order integer not null check (playing_order between 1 and 4),
  course_handicap integer,
  created_at timestamptz not null default now(),
  primary key (squad_id, user_id),
  unique (squad_id, playing_order),
  unique (session_id, user_id),
  foreign key (squad_id, session_id)
    references public.texas_scramble_squads(id, session_id) on delete cascade
);

create table public.texas_scramble_hole_scores (
  id uuid primary key default gen_random_uuid(),
  squad_id uuid not null references public.texas_scramble_squads(id) on delete cascade,
  hole_number integer not null check (hole_number between 1 and 18),
  gross_score integer not null check (gross_score between 1 and 30),
  tee_shot_player_id uuid not null,
  submitted_by uuid not null references public.profiles(id),
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (squad_id, hole_number),
  foreign key (squad_id, tee_shot_player_id)
    references public.texas_scramble_squad_players(squad_id, user_id)
);

create table public.match_hole_outcomes (
  id uuid primary key default gen_random_uuid(),
  segment_id uuid not null references public.match_segments(id) on delete cascade,
  hole_number integer not null check (hole_number between 1 and 18),
  winner text not null check (winner in ('cardinal', 'silver', 'halved')),
  submitted_by uuid not null references public.profiles(id),
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (segment_id, hole_number)
);

create table public.team_score_correction_audit (
  event_sequence bigint generated always as identity primary key,
  target_type text not null check (target_type in ('texas_scramble_hole', 'match_hole_outcome')),
  target_id uuid not null,
  match_id uuid not null references public.matches(id) on delete cascade,
  before_value jsonb not null,
  after_value jsonb not null,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  corrected_by uuid references public.profiles(id) on delete set null,
  corrected_at timestamptz not null default now()
);

create index texas_scramble_sessions_tournament_idx on public.texas_scramble_sessions(tournament_id, starts_at);
create index texas_scramble_squads_session_idx on public.texas_scramble_squads(session_id, side, squad_number);
create index texas_scramble_hole_scores_squad_idx on public.texas_scramble_hole_scores(squad_id, hole_number);
create index match_hole_outcomes_segment_idx on public.match_hole_outcomes(segment_id, hole_number);
create index team_score_correction_audit_match_idx on public.team_score_correction_audit(match_id, event_sequence desc);

create or replace function public.is_texas_scramble_squad_member(target_squad_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.texas_scramble_squad_players player
    join public.texas_scramble_squads squad on squad.id = player.squad_id
    join public.texas_scramble_sessions session_record on session_record.id = squad.session_id
    join public.tournament_memberships membership
      on membership.tournament_id = session_record.tournament_id
     and membership.user_id = player.user_id
     and membership.status = 'active'
    where player.squad_id = target_squad_id
      and player.user_id = auth.uid()
  );
$$;

create or replace function public.can_administer_scramble_session(target_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin() or exists (
    select 1 from public.texas_scramble_sessions session_record
    where session_record.id = target_session_id
      and public.is_tournament_admin(session_record.tournament_id)
  );
$$;

alter table public.texas_scramble_sessions enable row level security;
alter table public.texas_scramble_squads enable row level security;
alter table public.texas_scramble_squad_players enable row level security;
alter table public.texas_scramble_hole_scores enable row level security;
alter table public.match_hole_outcomes enable row level security;
alter table public.team_score_correction_audit enable row level security;

create policy texas_scramble_sessions_select on public.texas_scramble_sessions
for select to authenticated using (public.has_tournament_access(tournament_id));
create policy texas_scramble_squads_select on public.texas_scramble_squads
for select to authenticated using (
  public.is_texas_scramble_squad_member(id) or public.can_administer_scramble_session(session_id)
);
create policy texas_scramble_squad_players_select on public.texas_scramble_squad_players
for select to authenticated using (
  public.is_texas_scramble_squad_member(squad_id)
  or exists (select 1 from public.texas_scramble_squads squad where squad.id = squad_id and public.can_administer_scramble_session(squad.session_id))
);
create policy texas_scramble_hole_scores_select on public.texas_scramble_hole_scores
for select to authenticated using (
  public.is_texas_scramble_squad_member(squad_id)
  or exists (select 1 from public.texas_scramble_squads squad where squad.id = squad_id and public.can_administer_scramble_session(squad.session_id))
);
create policy match_hole_outcomes_select on public.match_hole_outcomes
for select to authenticated using (
  exists (
    select 1
    from public.match_segments segment
    join public.matches match_record on match_record.id = segment.match_id
    where segment.id = segment_id
      and (
        public.is_admin()
        or public.is_tournament_admin(match_record.tournament_id)
        or exists (
          select 1 from public.match_segment_players player
          join public.tournament_memberships membership
            on membership.tournament_id = match_record.tournament_id
           and membership.user_id = player.user_id
           and membership.status = 'active'
          where player.segment_id = segment.id and player.user_id = auth.uid()
        )
      )
  )
);
create policy team_score_correction_audit_select on public.team_score_correction_audit
for select to authenticated using (
  public.is_admin() or exists (
    select 1 from public.matches match_record
    where match_record.id = match_id and public.is_tournament_admin(match_record.tournament_id)
  )
);

revoke insert, update, delete on public.texas_scramble_sessions from authenticated;
revoke insert, update, delete on public.texas_scramble_squads from authenticated;
revoke insert, update, delete on public.texas_scramble_squad_players from authenticated;
revoke insert, update, delete on public.texas_scramble_hole_scores from authenticated;
revoke insert, update, delete on public.match_hole_outcomes from authenticated;
revoke insert, update, delete on public.team_score_correction_audit from authenticated;
grant select on public.texas_scramble_sessions, public.texas_scramble_squads,
  public.texas_scramble_squad_players, public.texas_scramble_hole_scores,
  public.match_hole_outcomes, public.team_score_correction_audit to authenticated;

create or replace function public.select_texas_scramble_course_tee(
  target_session_id uuid,
  target_course_id uuid,
  target_tee_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  session_record public.texas_scramble_sessions%rowtype;
  tee_record public.tees%rowtype;
  hole_count integer;
begin
  select * into session_record from public.texas_scramble_sessions
  where id = target_session_id for update;
  if session_record.id is null then raise exception 'Texas Scramble session not found'; end if;
  if not (public.is_texas_scramble_squad_member((
      select squad.id from public.texas_scramble_squads squad
      join public.texas_scramble_squad_players player on player.squad_id = squad.id
      where squad.session_id = target_session_id and player.user_id = auth.uid() limit 1
    )) or public.can_administer_scramble_session(target_session_id)) then
    raise exception 'Not authorized for this Texas Scramble session';
  end if;
  if session_record.status = 'final' then raise exception 'Finalized Texas Scramble sessions cannot change course or tee'; end if;
  if session_record.course_id is not null then
    if session_record.course_id <> target_course_id or session_record.tee_id <> target_tee_id then
      raise exception 'The shared course and tee are already locked';
    end if;
    return to_jsonb(session_record);
  end if;

  select * into tee_record from public.tees
  where id = target_tee_id and course_id = target_course_id and rating_category in ('M', 'U');
  if tee_record.id is null then raise exception 'Select a valid tournament tee for this course'; end if;
  if tee_record.rating is null or tee_record.slope is null then
    raise exception 'A course rating and slope are required for Texas Scramble net scoring';
  end if;
  select count(*) into hole_count from public.holes
  where tee_id = target_tee_id and hole_number between session_record.start_hole and session_record.end_hole;
  if hole_count <> session_record.end_hole - session_record.start_hole + 1 then
    raise exception 'The selected tee does not have every required hole';
  end if;

  update public.texas_scramble_sessions
  set course_id = target_course_id, tee_id = target_tee_id, status = 'live', updated_at = now()
  where id = target_session_id;
  update public.matches set course_id = target_course_id, status = 'live'
  where id in (select match_id from public.texas_scramble_squads where session_id = target_session_id);
  update public.match_segments set status = 'live', updated_at = now()
  where id in (select segment_id from public.texas_scramble_squads where session_id = target_session_id);

  update public.texas_scramble_squad_players player
  set course_handicap = floor((
    profile.handicap_index * tee_record.slope::numeric / 113
    + (tee_record.rating - coalesce(tee_record.rating_par, tee_record.par))
  ) + 0.5)::integer
  from public.profiles profile, public.texas_scramble_squads squad
  where player.user_id = profile.id
    and player.squad_id = squad.id
    and squad.session_id = target_session_id;

  with ranked as (
    select player.squad_id, player.course_handicap,
      row_number() over (partition by player.squad_id order by player.course_handicap, player.user_id) as rank,
      count(*) over (partition by player.squad_id) as player_count
    from public.texas_scramble_squad_players player
    join public.texas_scramble_squads squad on squad.id = player.squad_id
    where squad.session_id = target_session_id
  ), allowances as (
    select squad_id,
      floor(sum(course_handicap * case
        when player_count = 4 and rank = 1 then 0.25
        when player_count = 4 and rank = 2 then 0.20
        when player_count = 4 and rank = 3 then 0.15
        when player_count = 4 and rank = 4 then 0.10
        when player_count = 2 and rank = 1 then 0.35
        when player_count = 2 and rank = 2 then 0.15
        else 0 end) + 0.5)::integer as playing_handicap
    from ranked group by squad_id
  )
  update public.texas_scramble_squads squad
  set playing_handicap = allowances.playing_handicap, status = 'live', updated_at = now()
  from allowances where squad.id = allowances.squad_id;

  return (select to_jsonb(saved) from public.texas_scramble_sessions saved where saved.id = target_session_id);
end;
$$;

-- Plan edits and archive publication share the tournament lock. A SHARE row lock
-- freezes its status without blocking foreign-key checks during score submission.
create function public.lock_editable_plan_tournament(target_tournament_id uuid, allow_tournament_admin boolean)
returns void language plpgsql set search_path = pg_catalog, public as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(target_tournament_id::text, 0));
  -- Tournament-role mutations use this same lock. Authorize before looking
  -- up the edition and keep each planner's existing permission boundary.
  if (public.is_admin() or (allow_tournament_admin and public.is_tournament_admin(target_tournament_id))) is not true then
    raise exception 'Administrator access required';
  end if;
  perform 1 from public.tournaments
  where id = target_tournament_id and status in ('setup', 'open', 'live') for share;
  if not found or exists (select 1 from public.legacy_editions where source_tournament_id = target_tournament_id) then
    raise exception 'Plans require a current, unarchived tournament';
  end if;
end;
$$;
revoke all on function public.lock_editable_plan_tournament(uuid, boolean) from public, anon, authenticated, service_role;

-- Call with the match already locked (and, for Scramble, its session first).
-- A score inserted into an existing individual round also takes an FK lock on
-- that round. Wait for that writer before deciding whether a rebuild is safe.
create function public.match_plan_has_recorded_play(target_match_id uuid)
returns boolean language plpgsql set search_path = pg_catalog, public as $$
begin
  perform 1 from public.rounds where match_id = target_match_id order by id for update;
  return exists (select 1 from public.rounds r join public.scores s on s.round_id = r.id where r.match_id = target_match_id)
    or exists (select 1 from public.match_segments s join public.match_hole_outcomes o on o.segment_id = s.id where s.match_id = target_match_id)
    or exists (select 1 from public.texas_scramble_squads q join public.texas_scramble_hole_scores h on h.squad_id = q.id where q.match_id = target_match_id)
    or exists (select 1 from public.match_segments where match_id = target_match_id and (status = 'final' or holes_played <> 0 or differential <> 0))
    -- Selecting a Scramble tee logs scheduled -> live with zero holes. That
    -- setup event is not play; a prior final or nonzero result still is.
    or exists (select 1 from public.match_result_audit where match_id = target_match_id
               and (old_status = 'final' or new_status = 'final' or old_holes_played <> 0 or new_holes_played <> 0
                    or old_differential <> 0 or new_differential <> 0))
    or exists (select 1 from public.team_score_correction_audit where match_id = target_match_id);
end;
$$;
revoke all on function public.match_plan_has_recorded_play(uuid) from public, anon, authenticated, service_role;

create or replace function public.save_texas_scramble_plan(
  session_payload jsonb,
  squad_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  saved_session_id uuid;
  tournament_id_value uuid := (session_payload ->> 'tournament_id')::uuid;
  existing_session_id uuid := nullif(session_payload ->> 'id', '')::uuid;
  existing_session public.texas_scramble_sessions%rowtype;
  course_id_value uuid := nullif(session_payload ->> 'course_id', '')::uuid;
  tee_id_value uuid := nullif(session_payload ->> 'tee_id', '')::uuid;
  squad_record jsonb;
  saved_match_id uuid;
  saved_segment_id uuid;
  saved_squad_id uuid;
  player_record record;
  squad_size_value integer;
  side_value text;
  expected_players integer := 0;
  assigned_players integer;
begin
  perform public.lock_editable_plan_tournament(tournament_id_value, allow_tournament_admin => true);
  if jsonb_typeof(squad_payload) is distinct from 'array' or jsonb_array_length(squad_payload) < 1 then
    raise exception 'Add at least one Texas Scramble squad';
  end if;
  if coalesce((session_payload ->> 'required_tee_shots')::integer, 0) < 0 then
    raise exception 'Required tee shots cannot be negative';
  end if;

  if existing_session_id is null then
    insert into public.texas_scramble_sessions(
      tournament_id, name, session_label, starts_at, start_hole, end_hole,
      required_tee_shots, created_by
    ) values (
      tournament_id_value, btrim(session_payload ->> 'name'), btrim(session_payload ->> 'session_label'),
      (session_payload ->> 'starts_at')::timestamptz,
      coalesce((session_payload ->> 'start_hole')::integer, 1),
      coalesce((session_payload ->> 'end_hole')::integer, 18),
      coalesce((session_payload ->> 'required_tee_shots')::integer, 3), auth.uid()
    ) returning id into saved_session_id;
  else
    -- Course selection alone marks a session live. The first submitted hole,
    -- not that label, freezes every lineup. Use the submitter's session ->
    -- match -> squad lock order and read play only after acquiring the locks.
    select * into existing_session from public.texas_scramble_sessions
    where id = existing_session_id and tournament_id = tournament_id_value for update;
    if not found then raise exception 'Texas Scramble session not found in this tournament'; end if;
    saved_session_id := existing_session.id;
    perform m.id from public.matches m join public.texas_scramble_squads q on q.match_id = m.id
    where q.session_id = saved_session_id order by m.id for update of m;
    perform id from public.texas_scramble_squads where session_id = saved_session_id order by id for update;
    if existing_session.status = 'final' or exists (
      select 1 from public.texas_scramble_squads q join public.matches m on m.id = q.match_id
      where q.session_id = saved_session_id and (m.tournament_id is distinct from tournament_id_value
        or q.status = 'final' or m.status not in ('scheduled', 'live') or public.match_plan_has_recorded_play(m.id))
    ) then raise exception 'Only an unplayed, nonfinal Texas Scramble lineup can be replaced'; end if;
    if not (session_payload ? 'course_id' or session_payload ? 'tee_id') then
      course_id_value := existing_session.course_id;
      tee_id_value := existing_session.tee_id;
    end if;
    -- Delete the old match roots, not just their squads: the FK cascades
    -- retire their unscored segments and both sets of assignments together.
    delete from public.matches where id in (
      select match_id from public.texas_scramble_squads where session_id = saved_session_id
    );
    update public.texas_scramble_sessions set
      name = btrim(session_payload ->> 'name'),
      session_label = btrim(session_payload ->> 'session_label'),
      starts_at = (session_payload ->> 'starts_at')::timestamptz,
      start_hole = coalesce((session_payload ->> 'start_hole')::integer, 1),
      end_hole = coalesce((session_payload ->> 'end_hole')::integer, 18),
      required_tee_shots = coalesce((session_payload ->> 'required_tee_shots')::integer, 3),
      course_id = null, tee_id = null, status = 'scheduled', updated_at = now()
    where id = saved_session_id;
  end if;

  for squad_record in select value from jsonb_array_elements(squad_payload)
  loop
    squad_size_value := jsonb_array_length(squad_record -> 'player_ids');
    side_value := squad_record ->> 'side';
    if squad_size_value not in (2, 4) then raise exception 'Each Texas Scramble squad must contain exactly two or four players'; end if;
    if side_value not in ('cardinal', 'silver') then raise exception 'Each Texas Scramble squad must belong to Blue or White'; end if;
    if (select required_tee_shots from public.texas_scramble_sessions where id = saved_session_id) * squad_size_value
       > (select end_hole - start_hole + 1 from public.texas_scramble_sessions where id = saved_session_id) then
      raise exception 'The selected tee-shot minimum is impossible for this squad size';
    end if;
    expected_players := expected_players + squad_size_value;

    insert into public.matches(name, session, format, scoring_mode, starts_at, course_id, status, tournament_id)
    select btrim(squad_record ->> 'label'), session_label, 'scramble', 'net', starts_at, null, 'scheduled', tournament_id
    from public.texas_scramble_sessions where id = saved_session_id
    returning id into saved_match_id;

    insert into public.match_segments(match_id, segment_number, start_hole, end_hole, format, scoring_mode,
      handicap_allowance, point_value, status, entry_mode)
    select saved_match_id, 1, start_hole, end_hole, 'scramble', 'net', 100, 0, 'scheduled', 'individual_scores'
    from public.texas_scramble_sessions where id = saved_session_id
    returning id into saved_segment_id;

    insert into public.texas_scramble_squads(session_id, match_id, segment_id, label, side, squad_number, squad_size)
    values (saved_session_id, saved_match_id, saved_segment_id, btrim(squad_record ->> 'label'), side_value,
      (squad_record ->> 'squad_number')::integer, squad_size_value)
    returning id into saved_squad_id;

    for player_record in
      select value::uuid as user_id, ordinality::integer as playing_order
      from jsonb_array_elements_text(squad_record -> 'player_ids') with ordinality
    loop
      if not exists (
        select 1 from public.tournament_memberships membership
        where membership.tournament_id = tournament_id_value
          and membership.user_id = player_record.user_id
          and membership.status = 'active'
          and membership.team = side_value
      ) then raise exception 'Every squad player must be an active member of the matching Cup side'; end if;
      if exists (
        select 1 from public.texas_scramble_squad_players player
        join public.texas_scramble_squads squad on squad.id = player.squad_id
        where squad.session_id = saved_session_id and player.user_id = player_record.user_id
      ) then raise exception 'A player cannot appear in more than one squad in the same session'; end if;
      insert into public.texas_scramble_squad_players(squad_id, session_id, user_id, playing_order)
      values (saved_squad_id, saved_session_id, player_record.user_id, player_record.playing_order);
      insert into public.match_players(match_id, user_id, team)
      values (saved_match_id, player_record.user_id, side_value);
      insert into public.match_segment_players(segment_id, user_id, team, side, playing_order)
      values (saved_segment_id, player_record.user_id, side_value, side_value, player_record.playing_order);
    end loop;
  end loop;

  select count(*) into assigned_players
  from public.texas_scramble_squad_players player
  join public.texas_scramble_squads squad on squad.id = player.squad_id
  where squad.session_id = saved_session_id;
  if assigned_players <> expected_players then raise exception 'Texas Scramble assignments are incomplete'; end if;

  if course_id_value is not null or tee_id_value is not null then
    if course_id_value is null or tee_id_value is null then
      raise exception 'Choose both course and tee or leave both open for the players';
    end if;
    perform public.select_texas_scramble_course_tee(saved_session_id, course_id_value, tee_id_value);
  end if;
  return saved_session_id;
end;
$$;

create or replace function public.submit_texas_scramble_hole(
  target_squad_id uuid,
  target_hole_number integer,
  target_gross_score integer,
  target_tee_shot_player_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  squad_record public.texas_scramble_squads%rowtype;
  session_record public.texas_scramble_sessions%rowtype;
  saved_hole public.texas_scramble_hole_scores%rowtype;
  total_holes integer;
  saved_holes integer;
  missing_contributions integer;
  gross_value integer;
  par_value integer;
  net_value integer;
  points_value numeric(5,2);
  squad_session_id uuid;
  squad_match_id uuid;
begin
  select session_id, match_id into squad_session_id, squad_match_id
  from public.texas_scramble_squads where id = target_squad_id;
  if squad_session_id is null then raise exception 'Texas Scramble squad not found'; end if;
  select * into session_record from public.texas_scramble_sessions where id = squad_session_id for update;
  perform 1 from public.matches where id = squad_match_id for update;
  select * into squad_record from public.texas_scramble_squads where id = target_squad_id for update;
  if squad_record.session_id <> squad_session_id or squad_record.match_id <> squad_match_id then
    raise exception 'Texas Scramble squad changed while scoring';
  end if;
  if not public.is_texas_scramble_squad_member(target_squad_id) then raise exception 'Only an active squad member may submit this shared scorecard'; end if;
  if squad_record.status = 'final' or session_record.status = 'final' then raise exception 'This Texas Scramble scorecard is final'; end if;
  if session_record.tee_id is null then raise exception 'Select and lock the shared course and tee first'; end if;
  if target_hole_number not between session_record.start_hole and session_record.end_hole then raise exception 'Hole is outside this Texas Scramble session'; end if;
  if target_gross_score not between 1 and 30 then raise exception 'Enter a valid team gross score'; end if;
  if not exists (select 1 from public.texas_scramble_squad_players where squad_id = target_squad_id and user_id = target_tee_shot_player_id) then
    raise exception 'The selected tee shot must belong to this exact squad';
  end if;
  if not exists (select 1 from public.holes where tee_id = session_record.tee_id and hole_number = target_hole_number) then
    raise exception 'The selected tee does not contain this hole';
  end if;

  insert into public.texas_scramble_hole_scores(squad_id, hole_number, gross_score, tee_shot_player_id, submitted_by)
  values (target_squad_id, target_hole_number, target_gross_score, target_tee_shot_player_id, auth.uid())
  returning * into saved_hole;

  total_holes := session_record.end_hole - session_record.start_hole + 1;
  select count(*) into saved_holes from public.texas_scramble_hole_scores where squad_id = target_squad_id;
  if saved_holes = total_holes then
    select count(*) into missing_contributions
    from public.texas_scramble_squad_players player
    where player.squad_id = target_squad_id
      and (select count(*) from public.texas_scramble_hole_scores score
           where score.squad_id = target_squad_id and score.tee_shot_player_id = player.user_id)
          < session_record.required_tee_shots;
    if missing_contributions > 0 then raise exception 'Every squad member must meet the required tee shot minimum before the scorecard can finish'; end if;

    select sum(gross_score) into gross_value from public.texas_scramble_hole_scores where squad_id = target_squad_id;
    select sum(par) into par_value from public.holes
    where tee_id = session_record.tee_id and hole_number between session_record.start_hole and session_record.end_hole;
    net_value := gross_value - squad_record.playing_handicap;
    points_value := greatest(0, par_value - net_value);

    update public.texas_scramble_squads set status = 'final', gross_total = gross_value,
      net_score = net_value, par_total = par_value, points = points_value,
      finalized_at = now(), updated_at = now()
    where id = target_squad_id;
    perform set_config('app.automatic_completion_match_id', squad_record.match_id::text, true);
    update public.match_segments set status = 'final', differential = case when squad_record.side = 'cardinal' then 1 else -1 end,
      holes_played = total_holes, point_value = points_value, updated_at = now()
    where id = squad_record.segment_id;
    update public.matches set status = 'final' where id = squad_record.match_id;
    if not exists (select 1 from public.texas_scramble_squads where session_id = session_record.id and status <> 'final') then
      update public.texas_scramble_sessions set status = 'final', updated_at = now() where id = session_record.id;
    end if;
  end if;

  return jsonb_build_object(
    'hole', to_jsonb(saved_hole),
    'squad', (select to_jsonb(saved) from public.texas_scramble_squads saved where saved.id = target_squad_id),
    'finalized', saved_holes = total_holes
  );
exception when unique_violation then
  raise exception 'That shared hole is already submitted and locked';
end;
$$;

create or replace function public.submit_match_hole_outcome(
  target_segment_id uuid,
  target_hole_number integer,
  target_winner text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  segment_record public.match_segments%rowtype;
  match_record public.matches%rowtype;
  saved_outcome public.match_hole_outcomes%rowtype;
  total_holes integer;
  played integer;
  differential_value integer;
  remaining integer;
begin
  select * into segment_record from public.match_segments where id = target_segment_id;
  if segment_record.id is null then raise exception 'Match segment not found'; end if;
  select * into match_record from public.matches where id = segment_record.match_id for update;
  select * into segment_record from public.match_segments where id = target_segment_id for update;
  if segment_record.entry_mode <> 'hole_outcomes' then raise exception 'This segment requires full player scores'; end if;
  if segment_record.status = 'final' or match_record.status = 'final' then raise exception 'This segment is final'; end if;
  if target_winner not in ('cardinal', 'silver', 'halved') then raise exception 'Choose Blue, Halved, or White'; end if;
  if target_hole_number not between segment_record.start_hole and segment_record.end_hole then raise exception 'Hole is outside this match segment'; end if;
  if not exists (
    select 1 from public.match_segment_players player
    join public.tournament_memberships membership
      on membership.tournament_id = match_record.tournament_id
     and membership.user_id = player.user_id
     and membership.status = 'active'
    where player.segment_id = target_segment_id and player.user_id = auth.uid()
  ) then raise exception 'Only an active assigned player may submit hole outcomes'; end if;

  insert into public.match_hole_outcomes(segment_id, hole_number, winner, submitted_by)
  values (target_segment_id, target_hole_number, target_winner, auth.uid()) returning * into saved_outcome;
  select count(*), coalesce(sum(case winner when 'cardinal' then 1 when 'silver' then -1 else 0 end), 0)
  into played, differential_value from public.match_hole_outcomes where segment_id = target_segment_id;
  total_holes := segment_record.end_hole - segment_record.start_hole + 1;
  remaining := total_holes - played;
  if played = total_holes or abs(differential_value) > remaining then
    perform set_config('app.automatic_completion_match_id', match_record.id::text, true);
    update public.match_segments set status = 'final', differential = differential_value,
      holes_played = played, updated_at = now() where id = target_segment_id;
    if not exists (select 1 from public.match_segments where match_id = match_record.id and status <> 'final') then
      update public.matches set status = 'final' where id = match_record.id;
    end if;
  end if;
  return jsonb_build_object('outcome', to_jsonb(saved_outcome), 'differential', differential_value,
    'holes_played', played, 'finalized', played = total_holes or abs(differential_value) > remaining);
exception when unique_violation then
  raise exception 'That hole outcome is already submitted and locked';
end;
$$;

create or replace function public.correct_team_score_entry(
  target_type text,
  target_id uuid,
  target_reason text,
  replacement_gross_score integer default null,
  replacement_tee_shot_player_id uuid default null,
  replacement_winner text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_scope record;
  tournament_record public.tournaments%rowtype;
  session_record public.texas_scramble_sessions%rowtype;
  match_record public.matches%rowtype;
  segment_record public.match_segments%rowtype;
  squad_record public.texas_scramble_squads%rowtype;
  before_value jsonb;
  after_value jsonb;
  gross_total_value integer;
  net_score_value integer;
  points_value numeric(5,2);
  played_value integer;
  differential_value integer;
  remaining_value integer;
  total_holes_value integer;
begin
  if nullif(btrim(target_reason), '') is null then raise exception 'A correction reason is required'; end if;

  -- Discover IDs only. Do not hold a hole lock while waiting for archive or player submissions.
  if target_type = 'texas_scramble_hole' then
    select m.tournament_id, squad.session_id, squad.match_id, squad.segment_id, squad.id as squad_id into target_scope
    from public.texas_scramble_hole_scores score
    join public.texas_scramble_squads squad on squad.id = score.squad_id
    join public.matches m on m.id = squad.match_id
    where score.id = target_id;
  elsif target_type = 'match_hole_outcome' then
    select m.tournament_id, null::uuid as session_id, segment.match_id, segment.id as segment_id, null::uuid as squad_id into target_scope
    from public.match_hole_outcomes outcome
    join public.match_segments segment on segment.id = outcome.segment_id
    join public.matches m on m.id = segment.match_id
    where outcome.id = target_id;
  else raise exception 'Unsupported team score correction type'; end if;
  if not found or target_scope.tournament_id is null then raise exception 'Team score entry not found'; end if;

  -- Archive and role changes share this tournament lock. Submissions share the session/match locks.
  perform pg_advisory_xact_lock(hashtextextended(target_scope.tournament_id::text, 0));
  select * into tournament_record from public.tournaments where id = target_scope.tournament_id for update;
  if target_scope.session_id is not null then
    select * into session_record from public.texas_scramble_sessions
    where id = target_scope.session_id and tournament_id = tournament_record.id for update;
  end if;
  select * into match_record from public.matches
  where id = target_scope.match_id and tournament_id = tournament_record.id for update;
  select * into segment_record from public.match_segments
  where id = target_scope.segment_id and match_id = match_record.id for update;
  -- Bind each child to its locked parent; a stale or missing link cannot yield a before-image.
  if target_type = 'texas_scramble_hole' then
    select * into squad_record from public.texas_scramble_squads
    where id = target_scope.squad_id and session_id = session_record.id
      and match_id = match_record.id and segment_id = segment_record.id for update;
    select to_jsonb(score) into before_value from public.texas_scramble_hole_scores score
    where score.id = target_id and score.squad_id = squad_record.id for update;
  else
    select to_jsonb(outcome) into before_value from public.match_hole_outcomes outcome
    where outcome.id = target_id and outcome.segment_id = segment_record.id and segment_record.entry_mode = 'hole_outcomes' for update;
  end if;
  if not found then raise exception 'Team score entry changed or no longer exists'; end if;
  if not (public.is_admin() or public.is_tournament_admin(tournament_record.id)) then
    raise exception 'Only a tournament administrator can correct team scoring';
  end if;
  if tournament_record.status not in ('setup', 'open', 'live') then
    raise exception 'Cannot correct team scores for a completed or archived tournament';
  end if;

  perform set_config('app.correcting_final_match_id', match_record.id::text, true);
  perform set_config('app.result_change_match_id', match_record.id::text, true);
  perform set_config('app.result_change_reason', btrim(target_reason), true);
  if target_type = 'texas_scramble_hole' then
    if replacement_gross_score not between 1 and 30 then raise exception 'Enter a valid replacement team score'; end if;
    if not exists (
      select 1 from public.texas_scramble_squad_players player
      where player.squad_id = squad_record.id and player.user_id = replacement_tee_shot_player_id
    ) then raise exception 'The selected tee shot must belong to the exact squad'; end if;
    update public.texas_scramble_hole_scores set gross_score = replacement_gross_score,
      tee_shot_player_id = replacement_tee_shot_player_id, updated_at = now() where id = target_id
    returning to_jsonb(texas_scramble_hole_scores.*) into after_value;

    if squad_record.status = 'final' then
      if exists (
        select 1
        from public.texas_scramble_squad_players player
        where player.squad_id = squad_record.id
          and (select count(*) from public.texas_scramble_hole_scores score
               where score.squad_id = squad_record.id and score.tee_shot_player_id = player.user_id) < session_record.required_tee_shots
      ) then raise exception 'Correction would violate the required tee shot minimum'; end if;
      select sum(gross_score) into gross_total_value from public.texas_scramble_hole_scores where squad_id = squad_record.id;
      net_score_value := gross_total_value - squad_record.playing_handicap;
      points_value := greatest(0, squad_record.par_total - net_score_value);
      update public.texas_scramble_squads
      set gross_total = gross_total_value, net_score = net_score_value,
          points = points_value, updated_at = now()
      where id = squad_record.id;
      update public.match_segments
      set point_value = points_value,
          differential = case when squad_record.side = 'cardinal' then 1 else -1 end,
          updated_at = now()
      where id = segment_record.id;
    end if;
  else
    if replacement_winner not in ('cardinal', 'silver', 'halved') then raise exception 'Choose Blue, Halved, or White'; end if;
    update public.match_hole_outcomes set winner = replacement_winner, updated_at = now() where id = target_id
    returning to_jsonb(match_hole_outcomes.*) into after_value;
    select count(*), coalesce(sum(case winner when 'cardinal' then 1 when 'silver' then -1 else 0 end), 0)
    into played_value, differential_value
    from public.match_hole_outcomes where segment_id = segment_record.id;
    total_holes_value := segment_record.end_hole - segment_record.start_hole + 1;
    remaining_value := total_holes_value - played_value;
    if played_value = total_holes_value or abs(differential_value) > remaining_value then
      update public.match_segments
      set status = 'final', differential = differential_value,
          holes_played = played_value, updated_at = now()
      where id = segment_record.id;
      update public.matches set status = 'final'
      where id = match_record.id and status <> 'final'
        and not exists (select 1 from public.match_segments where match_id = match_record.id and status <> 'final');
    elsif segment_record.status = 'final' then
      raise exception 'Correction would reopen the finalized segment; its result must remain mathematically decided';
    end if;
  end if;
  insert into public.team_score_correction_audit(target_type, target_id, match_id, before_value, after_value, reason, corrected_by)
  values (target_type, target_id, match_record.id, before_value, after_value, btrim(target_reason), auth.uid());
  return after_value;
end;
$$;

-- Keep 003's lineup validation for unplayed plans, but make its destructive
-- implementation private. Both generations of the client enter the same guard.
revoke all on function public.save_match_plan(jsonb, jsonb) from public, anon, authenticated, service_role;
alter function public.save_match_plan(jsonb, jsonb) rename to rebuild_unplayed_match_plan;

create or replace function public.save_match_plan_with_entry_modes(match_payload jsonb, segment_payload jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  saved_match_id uuid := nullif(match_payload ->> 'id', '')::uuid;
  tournament_id_value uuid := (match_payload ->> 'tournament_id')::uuid;
  existing_match public.matches%rowtype;
  same_segments boolean;
begin
  perform public.lock_editable_plan_tournament(tournament_id_value, allow_tournament_admin => false);
  if jsonb_typeof(segment_payload) is distinct from 'array' or jsonb_array_length(segment_payload) = 0 then
    raise exception 'At least one segment is required';
  end if;

  if saved_match_id is not null then
    select * into existing_match from public.matches
    where id = saved_match_id and tournament_id = tournament_id_value for update;
    if not found then raise exception 'Match not found in this tournament'; end if;
    if existing_match.status = 'final' then raise exception 'Finalized matches cannot be edited'; end if;
    if exists (select 1 from public.texas_scramble_squads where match_id = saved_match_id) then
      raise exception 'Use the Texas Scramble session planner for a shared scorecard';
    end if;

    -- Compare typed definitions and ordered assignments, not JSON key/array
    -- order, result fields, or just the number of segments. Check cardinality
    -- as well as missing/extra keys so duplicate segment numbers cannot match.
    select jsonb_array_length(segment_payload) = (select count(*) from public.match_segments where match_id = saved_match_id)
      and not exists (
        select 1 from (select * from public.match_segments where match_id = saved_match_id) s
        full join jsonb_to_recordset(segment_payload) as p(id uuid, segment_number int, start_hole int, end_hole int,
          format text, scoring_mode text, handicap_allowance text, point_value numeric, entry_mode text, players jsonb)
          on p.segment_number = s.segment_number
        where s.id is null or p.segment_number is null or (p.id is not null and p.id <> s.id)
          or (s.start_hole, s.end_hole, s.format, s.scoring_mode, s.handicap_allowance, s.point_value, s.entry_mode)
             is distinct from (p.start_hole, p.end_hole, p.format, p.scoring_mode, nullif(p.handicap_allowance, '')::numeric,
                               p.point_value, coalesce(p.entry_mode, 'individual_scores'))
          or (select jsonb_agg(jsonb_build_array(a.user_id, a.team, a.side, a.playing_order) order by a.playing_order)
              from public.match_segment_players a where a.segment_id = s.id)
             is distinct from
             (select jsonb_agg(jsonb_build_array(a.user_id, a.team, a.side, a.playing_order) order by a.playing_order)
              from jsonb_to_recordset(p.players) as a(user_id uuid, team text, side text, playing_order int))
      ) into same_segments;

    if same_segments
       and (existing_match.session, existing_match.starts_at, existing_match.course_id)
           is not distinct from (btrim(match_payload ->> 'session'), nullif(match_payload ->> 'starts_at', '')::timestamptz,
                                 nullif(match_payload ->> 'course_id', '')::uuid)
       and coalesce(match_payload ->> 'format', existing_match.format) = existing_match.format
       and coalesce(match_payload ->> 'scoring_mode', existing_match.scoring_mode) = existing_match.scoring_mode
       and coalesce(match_payload ->> 'status', 'scheduled') in ('scheduled', existing_match.status) then
      -- Status is scoring-owned; even a stale planner sending 'scheduled' may
      -- rename a live match without touching its state or any child row.
      update public.matches set name = btrim(match_payload ->> 'name')
      where id = saved_match_id and name is distinct from btrim(match_payload ->> 'name');
      return saved_match_id;
    end if;
    if public.match_plan_has_recorded_play(saved_match_id) then
      raise exception 'Only the match name can be changed after play is recorded';
    end if;
  end if;

  saved_match_id := public.rebuild_unplayed_match_plan(match_payload, segment_payload);
  update public.match_segments s set entry_mode = coalesce(p.entry_mode, 'individual_scores')
  from jsonb_to_recordset(segment_payload) as p(segment_number int, entry_mode text)
  where s.match_id = saved_match_id and s.segment_number = p.segment_number
    and s.entry_mode is distinct from coalesce(p.entry_mode, 'individual_scores');
  return saved_match_id;
end;
$$;

create function public.save_match_plan(match_payload jsonb, segment_payload jsonb)
returns uuid language sql set search_path = pg_catalog, public as $$
  select public.save_match_plan_with_entry_modes(match_payload, segment_payload);
$$;
revoke all on function public.save_match_plan(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_match_plan(jsonb, jsonb) to authenticated;

revoke all on function public.is_texas_scramble_squad_member(uuid) from public, anon;
revoke all on function public.can_administer_scramble_session(uuid) from public, anon;
revoke all on function public.save_texas_scramble_plan(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.select_texas_scramble_course_tee(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.submit_texas_scramble_hole(uuid, integer, integer, uuid) from public, anon, authenticated;
revoke all on function public.submit_match_hole_outcome(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.correct_team_score_entry(text, uuid, text, integer, uuid, text) from public, anon, authenticated;
revoke all on function public.save_match_plan_with_entry_modes(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.is_texas_scramble_squad_member(uuid) to authenticated;
grant execute on function public.can_administer_scramble_session(uuid) to authenticated;
grant execute on function public.save_texas_scramble_plan(jsonb, jsonb) to authenticated;
grant execute on function public.select_texas_scramble_course_tee(uuid, uuid, uuid) to authenticated;
grant execute on function public.submit_texas_scramble_hole(uuid, integer, integer, uuid) to authenticated;
grant execute on function public.submit_match_hole_outcome(uuid, integer, text) to authenticated;
grant execute on function public.correct_team_score_entry(text, uuid, text, integer, uuid, text) to authenticated;
grant execute on function public.save_match_plan_with_entry_modes(jsonb, jsonb) to authenticated;

-- Texas Scramble-aware tournament completion and Past Trips generation.
create or replace function public.complete_tournament_archive(target_tournament_id uuid)
returns public.legacy_editions
language plpgsql
security definer
set search_path = public
as $$
declare
  tournament_record public.tournaments%rowtype;
  edition_record public.legacy_editions%rowtype;
  match_count integer;
  segment_count integer;
  generated_count integer;
  expected_points_value numeric(7,2);
  cardinal_total_value numeric(7,2);
  silver_total_value numeric(7,2);
  generated_expected_points numeric(7,2);
  generated_cardinal_total numeric(7,2);
  generated_silver_total numeric(7,2);
  winner_value text;
  runner_up_value text;
  final_score_value text;
begin
  perform pg_advisory_xact_lock(
    hashtextextended(target_tournament_id::text, 0)
  );

  select tournament.* into tournament_record
  from public.tournaments tournament
  where tournament.id = target_tournament_id
  for update;
  if tournament_record.id is null then raise exception 'Tournament not found'; end if;
  if not (public.is_admin() or public.is_tournament_admin(tournament_record.id)) then
    raise exception 'Administrator access required';
  end if;
  if tournament_record.status not in ('open', 'live', 'complete') then
    raise exception 'Only an open or live tournament can be completed';
  end if;

  perform locked_match.id
  from public.matches locked_match
  where locked_match.tournament_id = target_tournament_id
  order by locked_match.starts_at nulls last, locked_match.name, locked_match.id
  for update;

  perform locked_segment.id
  from public.match_segments locked_segment
  join public.matches locked_match on locked_match.id = locked_segment.match_id
  where locked_match.tournament_id = target_tournament_id
  order by locked_segment.match_id, locked_segment.segment_number, locked_segment.id
  for update of locked_segment;

  perform locked_assignment.segment_id
  from public.match_segment_players locked_assignment
  join public.match_segments locked_segment on locked_segment.id = locked_assignment.segment_id
  join public.matches locked_match on locked_match.id = locked_segment.match_id
  where locked_match.tournament_id = target_tournament_id
  order by locked_assignment.segment_id, locked_assignment.playing_order, locked_assignment.user_id
  for update of locked_assignment;

  select count(*) into match_count
  from public.matches match_record
  where match_record.tournament_id = target_tournament_id;
  if match_count = 0 then raise exception 'No tournament matches are available to archive'; end if;

  if exists (
    select 1 from public.matches match_record
    where match_record.tournament_id = target_tournament_id
      and match_record.status <> 'final'
  ) then
    raise exception 'Every tournament match must be finalized';
  end if;

  if exists (
    select 1
    from public.match_segments segment_record
    join public.matches match_record on match_record.id = segment_record.match_id
    where match_record.tournament_id = target_tournament_id
      and segment_record.status <> 'final'
  ) then
    raise exception 'Every tournament segment must be finalized';
  end if;

  if exists (
    select 1
    from public.match_segments segment_record
    join public.matches match_record on match_record.id = segment_record.match_id
    where match_record.tournament_id = target_tournament_id
      and segment_record.format not in ('singles', 'fourball', 'foursomes', 'scramble')
  ) then
    raise exception 'Only Singles, Four-Ball, Foursomes, and Texas Scramble segments can be archived';
  end if;

  if exists (
    select 1
    from public.match_segments segment_record
    join public.matches match_record on match_record.id = segment_record.match_id
    where match_record.tournament_id = target_tournament_id
      and (
        segment_record.holes_played < 1
        or segment_record.holes_played > segment_record.end_hole - segment_record.start_hole + 1
        or abs(segment_record.differential) > segment_record.end_hole - segment_record.start_hole + 1
        or (
          segment_record.holes_played < segment_record.end_hole - segment_record.start_hole + 1
          and abs(segment_record.differential)
            <= segment_record.end_hole - segment_record.start_hole + 1 - segment_record.holes_played
        )
      )
  ) then
    raise exception 'Segment final results are not valid completed match-play results';
  end if;

  if exists (
    select 1
    from public.match_segments segment_record
    join public.matches match_record on match_record.id = segment_record.match_id
    where match_record.tournament_id = target_tournament_id
      and (
        (segment_record.format = 'scramble' and not exists (
          select 1
          from public.match_segment_players assignment
          join public.profiles profile on profile.id = assignment.user_id
          where assignment.segment_id = segment_record.id
            and assignment.side = case when segment_record.differential > 0 then 'cardinal' else 'silver' end
            and nullif(trim(profile.display_name), '') is not null
        ))
        or (segment_record.format <> 'scramble' and (
          not exists (
            select 1
            from public.match_segment_players assignment
            join public.profiles profile on profile.id = assignment.user_id
            where assignment.segment_id = segment_record.id
              and assignment.side = 'cardinal'
              and nullif(trim(profile.display_name), '') is not null
          )
          or not exists (
            select 1
            from public.match_segment_players assignment
            join public.profiles profile on profile.id = assignment.user_id
            where assignment.segment_id = segment_record.id
              and assignment.side = 'silver'
              and nullif(trim(profile.display_name), '') is not null
          )
        ))
      )
  ) then
    raise exception 'Every archived segment requires its named scoring participants';
  end if;

  select edition.* into edition_record
  from public.legacy_editions edition
  where edition.source_tournament_id = target_tournament_id
  for update;

  if edition_record.id is null then
    select edition.* into edition_record
    from public.legacy_editions edition
    where edition.edition_year = tournament_record.edition_year
    for update;
  end if;

  if edition_record.id is null then
    raise exception 'A planned Past Trips edition is required before tournament completion';
  end if;
  if edition_record.source_tournament_id is distinct from null
     and edition_record.source_tournament_id <> target_tournament_id then
    raise exception 'Archive edition conflicts with authoritative completion';
  end if;
  if edition_record.source_tournament_id is null and (
    edition_record.status <> 'planned'
    or edition_record.winner_name is not null
    or edition_record.runner_up_name is not null
    or edition_record.final_score is not null
    or edition_record.expected_points is not null
    or edition_record.cardinal_total is not null
    or edition_record.silver_total is not null
    or edition_record.score_confidence <> 'unresolved'
    or exists (select 1 from public.legacy_results result where result.edition_id = edition_record.id)
  ) then
    raise exception 'Archive edition conflicts with authoritative completion';
  end if;

  select
    count(*),
    coalesce(sum(segment_record.point_value), 0),
    coalesce(sum(case when segment_record.differential > 0 then segment_record.point_value else 0 end), 0)
      + coalesce(sum(case when segment_record.differential = 0 then segment_record.point_value / 2 else 0 end), 0),
    coalesce(sum(case when segment_record.differential < 0 then segment_record.point_value else 0 end), 0)
      + coalesce(sum(case when segment_record.differential = 0 then segment_record.point_value / 2 else 0 end), 0)
    into segment_count, expected_points_value, cardinal_total_value, silver_total_value
  from public.match_segments segment_record
  join public.matches match_record on match_record.id = segment_record.match_id
  where match_record.tournament_id = target_tournament_id;

  if segment_count = 0 then raise exception 'No finalized tournament segments are available to archive'; end if;
  if cardinal_total_value + silver_total_value <> expected_points_value then
    raise exception 'Authoritative tournament points do not reconcile';
  end if;

  if cardinal_total_value > silver_total_value then
    winner_value := 'Blue';
    runner_up_value := 'White';
  elsif silver_total_value > cardinal_total_value then
    winner_value := 'White';
    runner_up_value := 'Blue';
  else
    winner_value := null;
    runner_up_value := null;
  end if;
  final_score_value := 'Blue '
    || regexp_replace(cardinal_total_value::text, '\.?0+$', '')
    || ' - White '
    || regexp_replace(silver_total_value::text, '\.?0+$', '');

  if tournament_record.status = 'complete' then
    if edition_record.source_tournament_id is distinct from target_tournament_id
       or edition_record.status <> 'completed'
       or edition_record.published is not true
       or edition_record.score_confidence <> 'confirmed'
       or edition_record.expected_points is distinct from expected_points_value
       or edition_record.cardinal_total is distinct from cardinal_total_value
       or edition_record.silver_total is distinct from silver_total_value
       or edition_record.winner_name is distinct from winner_value
       or edition_record.runner_up_name is distinct from runner_up_value
       or edition_record.final_score is distinct from final_score_value then
      raise exception 'Completed tournament archive has drifted from authoritative results';
    end if;

    select
      count(*),
      coalesce(sum(result.points_available), 0),
      coalesce(sum(result.cardinal_points), 0),
      coalesce(sum(result.silver_points), 0)
      into generated_count, generated_expected_points, generated_cardinal_total, generated_silver_total
    from public.legacy_results result
    where result.edition_id = edition_record.id
      and result.source_segment_id is not null;

    if generated_count <> segment_count
       or generated_expected_points <> expected_points_value
       or generated_cardinal_total <> cardinal_total_value
       or generated_silver_total <> silver_total_value
       or exists (
         select 1
         from public.match_segments segment_record
         join public.matches match_record on match_record.id = segment_record.match_id
         left join public.legacy_results result
           on result.source_segment_id = segment_record.id
          and result.edition_id = edition_record.id
         where match_record.tournament_id = target_tournament_id
           and (
             result.id is null
             or result.source_match_id <> segment_record.match_id
             or result.points_available <> segment_record.point_value
             or result.cardinal_points <> case
               when segment_record.differential > 0 then segment_record.point_value
               when segment_record.differential = 0 then segment_record.point_value / 2
               else 0 end
             or result.silver_points <> case
               when segment_record.differential < 0 then segment_record.point_value
               when segment_record.differential = 0 then segment_record.point_value / 2
               else 0 end
           )
       ) then
      raise exception 'Completed tournament archive has drifted from authoritative results';
    end if;

    return edition_record;
  end if;

  perform set_config('app.completing_tournament_archive', target_tournament_id::text, true);

  with ranked_matches as (
    select
      match_record.id,
      match_record.name,
      row_number() over (order by match_record.starts_at nulls last, match_record.name, match_record.id) as round_number,
      (
        select string_agg(format_name, ' / ' order by format_order)
        from (
          select distinct
            case segment.format
              when 'singles' then 'Singles'
              when 'fourball' then 'Four-Ball'
              when 'foursomes' then 'Foursomes'
              when 'scramble' then 'Texas Scramble'
            end as format_name,
            case segment.format
              when 'fourball' then 1
              when 'foursomes' then 2
              when 'singles' then 3
              when 'scramble' then 4
            end as format_order
          from public.match_segments segment
          where segment.match_id = match_record.id
        ) formats
      ) as game_style
    from public.matches match_record
    where match_record.tournament_id = target_tournament_id
  )
  insert into public.legacy_results(
    edition_id,
    label,
    cardinal_entry,
    silver_entry,
    result,
    sort_order,
    event_group,
    format_label,
    handicap_allowance,
    points_available,
    cardinal_points,
    silver_points,
    confidence,
    source_note,
    public_visible,
    source_match_id,
    source_segment_id
  )
  select
    edition_record.id,
    ranked_match.name || ' - ' || case segment_record.format
      when 'singles' then '1v1'
      when 'fourball' then '2v2 Best Ball'
      when 'foursomes' then '2v2 Foursomes'
      when 'scramble' then (case when segment_squad.squad_size = 2 then '2-player' else '4-player' end) || ' Texas Scramble'
    end,
    (
      select string_agg(trim(profile.display_name), ' & ' order by assignment.playing_order, profile.display_name, profile.id)
      from public.match_segment_players assignment
      join public.profiles profile on profile.id = assignment.user_id
      where assignment.segment_id = segment_record.id and assignment.side = 'cardinal'
    ),
    (
      select string_agg(trim(profile.display_name), ' & ' order by assignment.playing_order, profile.display_name, profile.id)
      from public.match_segment_players assignment
      join public.profiles profile on profile.id = assignment.user_id
      where assignment.segment_id = segment_record.id and assignment.side = 'silver'
    ),
    case
      when segment_record.format = 'scramble' then
        (case when segment_record.differential > 0 then 'Blue' else 'White' end)
        || ' earns ' || regexp_replace(segment_record.point_value::text, '\.?0+$', '')
        || ' point' || case when segment_record.point_value = 1 then '' else 's' end
        || ' at ' || greatest(0, segment_squad.par_total - segment_squad.net_score)::text || ' under net par'
      when segment_record.differential = 0 then 'Match Halved'
      when segment_record.differential > 0 then 'Blue wins ' || case
        when segment_record.holes_played < segment_record.end_hole - segment_record.start_hole + 1
          then abs(segment_record.differential)::text || ' & '
            || (segment_record.end_hole - segment_record.start_hole + 1 - segment_record.holes_played)::text
        when abs(segment_record.differential) = 1 then '1 Up'
        else abs(segment_record.differential)::text || ' Up'
      end
      else 'White wins ' || case
        when segment_record.holes_played < segment_record.end_hole - segment_record.start_hole + 1
          then abs(segment_record.differential)::text || ' & '
            || (segment_record.end_hole - segment_record.start_hole + 1 - segment_record.holes_played)::text
        when abs(segment_record.differential) = 1 then '1 Up'
        else abs(segment_record.differential)::text || ' Up'
      end
    end,
    ranked_match.round_number::integer * 100 + segment_record.segment_number,
    'Round ' || ranked_match.round_number || ' - ' || ranked_match.game_style,
    (case segment_record.format
      when 'singles' then '1v1'
      when 'fourball' then '2v2 Best Ball'
      when 'foursomes' then '2v2 Foursomes'
      when 'scramble' then (case when segment_squad.squad_size = 2 then '2-player' else '4-player' end) || ' Texas Scramble'
    end) || case
      when segment_record.start_hole = 1 and segment_record.end_hole = 18 then ''
      when segment_record.start_hole = 1 then ' - Front 9'
      when segment_record.end_hole = 18 then ' - Back 9'
      else ' - Holes ' || segment_record.start_hole || '-' || segment_record.end_hole
    end,
    case when segment_record.format = 'scramble' then 'WHS team allowance'
      when segment_record.scoring_mode = 'net'
        then regexp_replace(segment_record.handicap_allowance::text, '\.?0+$', '') || '%'
      else null end,
    segment_record.point_value,
    case when segment_record.differential > 0 then segment_record.point_value
         when segment_record.differential = 0 then segment_record.point_value / 2
         else 0 end,
    case when segment_record.differential < 0 then segment_record.point_value
         when segment_record.differential = 0 then segment_record.point_value / 2
         else 0 end,
    'confirmed',
    null,
    true,
    segment_record.match_id,
    segment_record.id
  from public.match_segments segment_record
  join ranked_matches ranked_match on ranked_match.id = segment_record.match_id
  left join public.texas_scramble_squads segment_squad on segment_squad.segment_id = segment_record.id
  order by ranked_match.round_number, segment_record.segment_number, segment_record.id;

  update public.legacy_editions
  set source_tournament_id = target_tournament_id,
      status = 'completed',
      winner_name = winner_value,
      runner_up_name = runner_up_value,
      final_score = final_score_value,
      published = true,
      expected_points = expected_points_value,
      cardinal_total = cardinal_total_value,
      silver_total = silver_total_value,
      score_confidence = 'confirmed',
      updated_at = now()
  where id = edition_record.id
  returning * into edition_record;

  update public.tournaments
  set status = 'complete', updated_at = now()
  where id = target_tournament_id;

  return edition_record;
end;
$$;

revoke all on function public.complete_tournament_archive(uuid) from public, anon, authenticated;
grant execute on function public.complete_tournament_archive(uuid) to authenticated;

commit;
