-- Complete a tournament and publish its authoritative Past Trips archive atomically.

alter table public.legacy_editions
  add column if not exists source_tournament_id uuid references public.tournaments(id) on delete restrict;

alter table public.legacy_results
  add column if not exists source_match_id uuid,
  add column if not exists source_segment_id uuid;

create unique index if not exists legacy_editions_source_tournament_unique
  on public.legacy_editions(source_tournament_id)
  where source_tournament_id is not null;

create unique index if not exists legacy_results_source_segment_unique
  on public.legacy_results(source_segment_id)
  where source_segment_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'legacy_results_source_pair_check'
      and conrelid = 'public.legacy_results'::regclass
  ) then
    alter table public.legacy_results
      add constraint legacy_results_source_pair_check
      check ((source_match_id is null) = (source_segment_id is null));
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conname = 'legacy_results_source_segment_match_fkey'
      and conrelid = 'public.legacy_results'::regclass
  ) then
    alter table public.legacy_results
      add constraint legacy_results_source_segment_match_fkey
      foreign key (source_segment_id, source_match_id)
      references public.match_segments(id, match_id)
      on delete restrict;
  end if;
end
$$;

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
      and segment_record.format not in ('singles', 'fourball', 'foursomes')
  ) then
    raise exception 'Only Singles, Four-Ball, and Foursomes segments can be archived';
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
      )
  ) then
    raise exception 'Every archived segment requires named Blue and White participants';
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
            end as format_name,
            case segment.format
              when 'fourball' then 1
              when 'foursomes' then 2
              when 'singles' then 3
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
    end) || case
      when segment_record.start_hole = 1 and segment_record.end_hole = 18 then ''
      when segment_record.start_hole = 1 then ' - Front 9'
      when segment_record.end_hole = 18 then ' - Back 9'
      else ' - Holes ' || segment_record.start_hole || '-' || segment_record.end_hole
    end,
    case when segment_record.scoring_mode = 'net'
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

create or replace function public.protect_generated_legacy_archive()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  completion_context text := current_setting('app.completing_tournament_archive', true);
  source_tournament uuid;
begin
  if tg_table_name = 'legacy_results' then
    if tg_op = 'INSERT' then
      if new.source_segment_id is not null then
        select match_record.tournament_id into source_tournament
        from public.matches match_record
        where match_record.id = new.source_match_id;
        if completion_context is distinct from source_tournament::text then
          raise exception 'Generated Past Trips provenance can only be written by tournament completion';
        end if;
      end if;
      select edition.source_tournament_id into source_tournament
      from public.legacy_editions edition
      where edition.id = new.edition_id;
      if source_tournament is not null and completion_context is distinct from source_tournament::text then
        raise exception 'Generated Past Trips results cannot be added manually';
      end if;
      return new;
    end if;

    if old.source_segment_id is not null then
      raise exception 'Generated Past Trips results cannot be changed or deleted';
    end if;
    if tg_op = 'UPDATE' then
      if new.source_segment_id is not null then
        raise exception 'Generated Past Trips results cannot be changed or deleted';
      end if;
      select edition.source_tournament_id into source_tournament
      from public.legacy_editions edition
      where edition.id = new.edition_id;
      if source_tournament is not null then
        raise exception 'Generated Past Trips results cannot be changed or deleted';
      end if;
      return new;
    end if;
    select edition.source_tournament_id into source_tournament
    from public.legacy_editions edition
    where edition.id = old.edition_id;
    if source_tournament is not null then
      raise exception 'Generated Past Trips results cannot be changed or deleted';
    end if;
    return old;
  end if;

  if tg_table_name = 'legacy_editions' then
    if tg_op = 'INSERT' then
      if new.source_tournament_id is not null then
        raise exception 'Generated Past Trips provenance can only be written by tournament completion';
      end if;
      return new;
    end if;

    if tg_op = 'DELETE' then
      if old.source_tournament_id is not null then
        raise exception 'Generated Past Trips editions cannot be deleted';
      end if;
      return old;
    end if;

    if new.source_tournament_id is distinct from old.source_tournament_id
       and completion_context is distinct from coalesce(new.source_tournament_id, old.source_tournament_id)::text then
      raise exception 'Generated Past Trips scoring fields are immutable';
    end if;

    if old.source_tournament_id is not null then
      if new.edition_year is distinct from old.edition_year
         or new.status is distinct from old.status
         or new.winner_name is distinct from old.winner_name
         or new.runner_up_name is distinct from old.runner_up_name
         or new.final_score is distinct from old.final_score
         or new.published is distinct from old.published
         or new.expected_points is distinct from old.expected_points
         or new.cardinal_total is distinct from old.cardinal_total
         or new.silver_total is distinct from old.silver_total
         or new.score_confidence is distinct from old.score_confidence
         or new.source_notes is distinct from old.source_notes then
        raise exception 'Generated Past Trips scoring fields are immutable';
      end if;
      -- Story edits remain allowed without weakening generated scoring fields.
      if new.story is distinct from old.story then null; end if;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.protect_generated_legacy_archive() from public;

drop trigger if exists protect_generated_legacy_results on public.legacy_results;
create trigger protect_generated_legacy_results
before insert or update or delete on public.legacy_results
for each row execute function public.protect_generated_legacy_archive();

drop trigger if exists protect_generated_legacy_editions on public.legacy_editions;
create trigger protect_generated_legacy_editions
before insert or update or delete on public.legacy_editions
for each row execute function public.protect_generated_legacy_archive();

revoke all on function public.complete_tournament_archive(uuid) from public, anon, authenticated;
grant execute on function public.complete_tournament_archive(uuid) to authenticated;
