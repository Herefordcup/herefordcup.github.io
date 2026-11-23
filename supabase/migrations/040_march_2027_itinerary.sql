alter table public.tournament_events
  add column time_precision text not null default 'exact'
    check (time_precision in ('exact', 'approximate', 'tbd')),
  add column public_details text;

-- Refresh only itinerary records, without sending schedule-change emails.
alter table public.tournament_events disable trigger enqueue_event_notifications;

do $$
declare
  trip_id uuid;
  changed_count integer;
begin
  select id into trip_id
  from public.tournaments
  where slug = 'hereford-cup-2027' and status = 'setup'
    and starts_on = date '2027-03-18' and ends_on = date '2027-03-21';

  -- Migration 003 skips seeding if there is no administrator yet.
  if trip_id is null then
    if exists (select from public.tournaments where slug = 'hereford-cup-2027') then
      raise exception 'Unexpected status or dates for the March 2027 itinerary';
    end if;
    return;
  end if;

  -- Keep the existing Thursday timestamp as the sort/day anchor, not a published tee time.
  update public.tournament_events e
  set title = v.new_title, starts_at = v.new_start, ends_at = v.new_end,
      time_precision = v.precision, public_details = v.details,
      notes = case when e.notes in ('Non-competition opening round.', 'Team competition begins.',
        'Tee-time window 10:00–10:30 AM; caddies optional.',
        'Par-3 course; competition status to be confirmed.',
        'Tee-time window 7:30–8:00 AM; walking only.') then null else e.notes end
  from (values
    (10, 'Tobacco Road', 'Tobacco Road', '2027-03-18 13:00-04'::timestamptz, null::timestamptz, 'tbd', 'Optional, non-competition round.'),
    (40, 'Pinehurst No. 3', 'Pinehurst No. 3', '2027-03-19 08:00-04', '2027-03-19 08:32-04', 'exact', 'Team competition begins.'),
    (50, 'Pinehurst No. 4', 'Pinehurst No. 4', '2027-03-19 13:40-04', '2027-03-19 14:20-04', 'exact', null),
    (60, 'Dinner at Pinehurst Brewing Company', 'Dinner', '2027-03-19 19:00-04', null, 'exact', 'Venue TBD.'),
    (70, 'Pinehurst No. 2', 'Pinehurst No. 2', '2027-03-20 10:12-04', '2027-03-20 10:48-04', 'exact', 'Caddies optional.'),
    (80, 'Long drive', 'Long drive competition', '2027-03-20 15:30-04', null, 'exact', 'Location TBD.'),
    (90, 'The Cradle', 'The Cradle', '2027-03-20 17:20-04', '2027-03-20 18:00-04', 'exact', 'Par-3 competition.'),
    (100, 'Dinner', 'Dinner at Pinehurst Brewing Company', '2027-03-20 20:00-04', null, 'exact', 'Confirmed.'),
    (110, 'Pinehurst No. 10', 'Pinehurst No. 10', '2027-03-21 07:30-04', '2027-03-21 08:10-04', 'exact', 'Walking only.')
  ) as v(sort_order, old_title, new_title, new_start, new_end, precision, details)
  where e.tournament_id = trip_id and e.sort_order = v.sort_order and e.title = v.old_title
    and e.status = 'scheduled'
    and (e.starts_at at time zone 'America/New_York')::date = (v.new_start at time zone 'America/New_York')::date;

  get diagnostics changed_count = row_count;
  if changed_count <> 9 then
    raise exception 'Expected nine March 2027 itinerary rows, found %', changed_count;
  end if;

  insert into public.tournament_events
    (tournament_id, title, event_type, starts_at, time_precision, public_details, sort_order)
  values
    (trip_id, 'The Matchbox', 'golf', '2027-03-18 16:32-04', 'exact',
      'Tobacco Road''s 12-hole par-3 course. One foursome.', 15),
    (trip_id, 'Airport shuttle pickup', 'travel', '2027-03-21 13:30-04', 'approximate', null, 120);

  update public.notification_jobs j
  set status = 'cancelled'
  from public.tournament_events e
  where e.tournament_id = trip_id and e.sort_order = 10 and e.title = 'Tobacco Road'
    and j.tournament_id = trip_id and j.source_type = 'event' and j.source_id = e.id
    and j.notification_type = 'reminder' and j.status = 'queued';

  -- Preserve future reminders for timed events and replace stale times or titles.
  update public.notification_jobs j
  set status = 'cancelled'
  from public.tournament_events e
  where e.tournament_id = trip_id and e.sort_order in (40, 50, 60, 70, 80, 90, 100, 110)
    and (e.starts_at at time zone 'America/New_York')::date between date '2027-03-18' and date '2027-03-21'
    and j.tournament_id = trip_id and j.source_type = 'event' and j.source_id = e.id
    and j.notification_type = 'reminder' and j.status = 'queued'
    and j.idempotency_key <> format('event-reminder:%s:%s', e.id, extract(epoch from e.starts_at));

  insert into public.notification_jobs
    (tournament_id, notification_type, source_type, source_id, idempotency_key,
      subject, body, payload, scheduled_for)
  select trip_id, 'reminder', 'event', e.id,
    format('event-reminder:%s:%s', e.id, extract(epoch from e.starts_at)),
    'Hereford Cup activity reminder',
    format('%s begins %s%s. Open Hereford Cup for the full schedule.', e.title,
      case when e.time_precision = 'approximate' then 'around ' else '' end,
      to_char(e.starts_at at time zone 'America/New_York', 'FMDay, FMMonth DD at FMHH12:MI AM')),
    jsonb_build_object('starts_at', e.starts_at, 'event_type', e.event_type),
    e.starts_at - interval '12 hours'
  from public.tournament_events e
  where e.tournament_id = trip_id and e.sort_order in (15, 40, 50, 60, 70, 80, 90, 100, 110, 120)
    and (e.starts_at at time zone 'America/New_York')::date between date '2027-03-18' and date '2027-03-21'
    and e.status = 'scheduled' and e.starts_at - interval '12 hours' > current_timestamp
  on conflict (idempotency_key) do update
    set body = excluded.body, payload = excluded.payload, scheduled_for = excluded.scheduled_for
    where notification_jobs.status = 'queued';
end;
$$;

alter table public.tournament_events enable trigger enqueue_event_notifications;

-- Extend only the schedule projection. Keep the existing tournament and scoring selection.
do $$
declare
  definition text := pg_get_functiondef('public.get_public_tournament_preview()'::regprocedure);
  anchor constant text := '''endsAt'', event_record.ends_at,';
begin
  if (length(definition) - length(replace(definition, anchor, ''))) <> length(anchor) then
    raise exception 'Unexpected public itinerary projection';
  end if;
  execute replace(definition, anchor,
    anchor || E'\n        ''timePrecision'', event_record.time_precision,\n        ''publicDetails'', event_record.public_details,');
end;
$$;
