-- Public, read-only tournament preview for the anonymous homepage.
-- Source tables remain protected by their existing member-only RLS policies.

create or replace function public.get_public_tournament_preview()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with selected_tournament as (
    select tournament.id, tournament.name, tournament.edition_year,
           tournament.starts_on, tournament.ends_on, tournament.status
    from public.tournaments tournament
    where tournament.starts_on is not null
      and tournament.ends_on is not null
      and tournament.status in ('setup', 'open', 'live')
      and (tournament.status = 'live'
        or tournament.ends_on >= (current_timestamp at time zone 'America/New_York')::date)
    order by
      case tournament.status when 'live' then 0 when 'open' then 1 else 2 end,
      tournament.starts_on,
      tournament.edition_year desc
    limit 1
  ),
  public_matches as (
    select match_record.*
    from public.matches match_record
    cross join selected_tournament
    where match_record.tournament_id = selected_tournament.id
      and selected_tournament.status in ('open', 'live')
      and match_record.status <> 'cancelled'
      and match_record.starts_at is not null
      and (match_record.starts_at at time zone 'America/New_York')::date
          between selected_tournament.starts_on and selected_tournament.ends_on
      and exists (
        select 1
        from public.match_segments planned_segment
        where planned_segment.match_id = match_record.id
      )
  ),
  public_segments as (
    select segment.*
    from public.match_segments segment
    join public_matches match_record on match_record.id = segment.match_id
  ),
  point_summary as (
    select
      count(*) as segment_count,
      coalesce(sum(segment.point_value), 0) as planned_points,
      bool_and(segment.point_value = 1) as standard_points,
      coalesce(sum(
        case
          when segment.status = 'final' and segment.differential > 0 then segment.point_value
          when segment.status = 'final' and segment.differential = 0 then segment.point_value / 2
          else 0
        end
      ), 0) as blue_points,
      coalesce(sum(
        case
          when segment.status = 'final' and segment.differential < 0 then segment.point_value
          when segment.status = 'final' and segment.differential = 0 then segment.point_value / 2
          else 0
        end
      ), 0) as white_points
    from public_segments segment
  )
  select jsonb_build_object(
    'tournament', jsonb_build_object(
      'name', selected_tournament.name,
      'editionYear', selected_tournament.edition_year,
      'startsOn', selected_tournament.starts_on,
      'endsOn', selected_tournament.ends_on,
      'status', selected_tournament.status
    ),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'title', event_record.title,
        'eventType', event_record.event_type,
        'startsAt', event_record.starts_at,
        'endsAt', event_record.ends_at,
        'course', course.name,
        'isCompetitive', event_record.is_competitive
      ) order by event_record.starts_at, event_record.sort_order, event_record.title)
      from public.tournament_events event_record
      left join public.courses course on course.id = event_record.course_id
      where event_record.tournament_id = selected_tournament.id
        and event_record.status <> 'cancelled'
        and (event_record.starts_at at time zone 'America/New_York')::date
            between selected_tournament.starts_on and selected_tournament.ends_on
    ), '[]'::jsonb),
    'matches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', match_record.name,
        'session', match_record.session,
        'startsAt', match_record.starts_at,
        'course', course.name,
        'status', match_record.status,
        'segments', coalesce((
          select jsonb_agg(jsonb_build_object(
            'segmentNumber', segment.segment_number,
            'startHole', segment.start_hole,
            'endHole', segment.end_hole,
            'format', segment.format,
            'pointValue', segment.point_value,
            'status', segment.status,
            'pairings', coalesce((
              select jsonb_agg(jsonb_build_object(
                'team', pairing.side,
                'displayName', pairing.display_name
              ) order by pairing.side, pairing.display_name, pairing.profile_id)
              from (
                select assignment.side, profile.display_name, profile.id as profile_id
                from public.match_segment_players assignment
                join public.profiles profile on profile.id = assignment.user_id
                where assignment.segment_id = segment.id
              ) pairing
            ), '[]'::jsonb),
            'result', case when segment.status = 'final' then jsonb_build_object(
              'differential', segment.differential,
              'holesPlayed', segment.holes_played
            ) else null end
          ) order by segment.segment_number)
          from public_segments segment
          where segment.match_id = match_record.id
        ), '[]'::jsonb)
      ) order by match_record.starts_at, match_record.name)
      from public_matches match_record
      left join public.courses course on course.id = match_record.course_id
    ), '[]'::jsonb),
    'totals', jsonb_build_object(
      'blue', point_summary.blue_points,
      'white', point_summary.white_points,
      'target', case
        when point_summary.segment_count > 0 and point_summary.standard_points
          then point_summary.planned_points / 2 + 0.5
        else null
      end
    )
  )
  from selected_tournament
  cross join point_summary;
$$;

revoke all on function public.get_public_tournament_preview() from public, anon, authenticated;
grant execute on function public.get_public_tournament_preview() to anon, authenticated;
