-- Email notification preferences, durable jobs, and delivery tracking.
-- Sender credentials and account email addresses remain outside public tables.

alter table public.tournament_events
  add column if not exists status text not null default 'scheduled';
alter table public.tournament_events drop constraint if exists tournament_events_status_check;
alter table public.tournament_events add constraint tournament_events_status_check
  check (status in ('scheduled', 'cancelled'));

alter table public.matches add column if not exists updated_at timestamptz not null default now();
alter table public.matches drop constraint if exists matches_status_check;
alter table public.matches add constraint matches_status_check
  check (status in ('scheduled', 'live', 'final', 'cancelled'));

create table public.notification_preferences (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  reminders_enabled boolean not null default true,
  schedule_updates_enabled boolean not null default true,
  new_member_admin_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (tournament_id, user_id)
);

create table public.notification_jobs (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  notification_type text not null check (notification_type in ('new_member', 'reminder', 'schedule_change', 'cancellation')),
  source_type text not null check (source_type in ('membership', 'event', 'match')),
  source_id uuid not null,
  idempotency_key text not null unique,
  subject text not null check (char_length(subject) between 1 and 160),
  body text not null check (char_length(body) between 1 and 4000),
  payload jsonb not null default '{}'::jsonb,
  scheduled_for timestamptz not null default now(),
  status text not null default 'queued' check (status in ('queued', 'expanded', 'cancelled')),
  created_at timestamptz not null default now()
);

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.notification_jobs(id) on delete cascade,
  recipient_user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_delivery_recipient_unique unique (job_id, recipient_user_id)
);

create index notification_jobs_due_idx
  on public.notification_jobs(status, scheduled_for);
create index notification_deliveries_due_idx
  on public.notification_deliveries(status, next_attempt_at);

alter table public.notification_preferences enable row level security;
alter table public.notification_jobs enable row level security;
alter table public.notification_deliveries enable row level security;

create policy "members view their notification preferences"
  on public.notification_preferences for select to authenticated
  using (user_id = auth.uid() and public.has_tournament_access(tournament_id));
create policy "members create their notification preferences"
  on public.notification_preferences for insert to authenticated
  with check (user_id = auth.uid() and public.has_tournament_access(tournament_id));
create policy "members update their notification preferences"
  on public.notification_preferences for update to authenticated
  using (user_id = auth.uid() and public.has_tournament_access(tournament_id))
  with check (user_id = auth.uid() and public.has_tournament_access(tournament_id));

grant select, insert, update on public.notification_preferences to authenticated;
revoke all on public.notification_jobs from anon, authenticated;
revoke all on public.notification_deliveries from anon, authenticated;

create or replace function public.touch_notification_source_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

drop trigger if exists touch_tournament_event_notification_time on public.tournament_events;
create trigger touch_tournament_event_notification_time
before update on public.tournament_events
for each row execute function public.touch_notification_source_updated_at();

drop trigger if exists touch_match_notification_time on public.matches;
create trigger touch_match_notification_time
before update on public.matches
for each row execute function public.touch_notification_source_updated_at();

create or replace function public.enqueue_notification_job(
  target_tournament_id uuid,
  target_notification_type text,
  target_source_type text,
  target_source_id uuid,
  target_idempotency_key text,
  target_subject text,
  target_body text,
  target_payload jsonb,
  target_scheduled_for timestamptz
)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  insert into public.notification_jobs(
    tournament_id, notification_type, source_type, source_id,
    idempotency_key, subject, body, payload, scheduled_for
  ) values (
    target_tournament_id, target_notification_type, target_source_type, target_source_id,
    target_idempotency_key, target_subject, target_body, coalesce(target_payload, '{}'::jsonb),
    target_scheduled_for
  )
  on conflict (idempotency_key) do nothing;
$$;

revoke all on function public.enqueue_notification_job(uuid, text, text, uuid, text, text, text, jsonb, timestamptz) from public, anon, authenticated;

create or replace function public.enqueue_new_member_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  member_name text;
begin
  if new.status <> 'active' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'active' then
    return new;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select coalesce(nullif(trim(profile.display_name), ''), 'A new member')
      into member_name
    from public.profiles profile
    where profile.id = new.user_id;

    perform public.enqueue_notification_job(
      new.tournament_id,
      'new_member',
      'membership',
      new.user_id,
      format('new-member:%s:%s', new.tournament_id, new.user_id),
      'A new member joined Hereford Cup',
      format('%s joined the tournament. Open the administrator portal to review the roster.', member_name),
      jsonb_build_object('member_user_id', new.user_id, 'member_name', member_name),
      clock_timestamp()
    );
  end if;
  return new;
end;
$$;

revoke all on function public.enqueue_new_member_notification() from public, anon, authenticated;
drop trigger if exists enqueue_new_member_notification on public.tournament_memberships;
create trigger enqueue_new_member_notification
after insert or update of status on public.tournament_memberships
for each row execute function public.enqueue_new_member_notification();

create or replace function public.enqueue_event_notifications()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  change_key text;
begin
  if tg_op = 'DELETE' then
    update public.notification_jobs
      set status = 'cancelled'
      where source_type = 'event' and source_id = old.id and notification_type = 'reminder' and status = 'queued';
    perform public.enqueue_notification_job(
      old.tournament_id, 'cancellation', 'event', old.id,
      format('event-cancelled:%s:%s', old.id, extract(epoch from clock_timestamp())),
      'Hereford Cup activity cancelled',
      format('%s scheduled for %s has been cancelled.', old.title, to_char(old.starts_at at time zone 'America/New_York', 'FMDay, FMMonth DD at FMHH12:MI AM')),
      jsonb_build_object('old_starts_at', old.starts_at), clock_timestamp()
    );
    return old;
  end if;

  if tg_op = 'UPDATE' and (
    old.title is distinct from new.title or
    old.starts_at is distinct from new.starts_at or
    old.ends_at is distinct from new.ends_at or
    old.course_id is distinct from new.course_id or
    old.notes is distinct from new.notes or
    (old.status = 'cancelled') is distinct from (new.status = 'cancelled')
  ) then
    update public.notification_jobs
      set status = 'cancelled'
      where source_type = 'event' and source_id = new.id and notification_type = 'reminder' and status = 'queued';
    change_key := format('event-%s:%s:%s', case when new.status = 'cancelled' then 'cancelled' else 'changed' end, new.id, extract(epoch from new.updated_at));
    perform public.enqueue_notification_job(
      new.tournament_id,
      case when new.status = 'cancelled' then 'cancellation' else 'schedule_change' end,
      'event', new.id, change_key,
      case when new.status = 'cancelled' then 'Hereford Cup activity cancelled' else 'Hereford Cup schedule changed' end,
      case when new.status = 'cancelled'
        then format('%s scheduled for %s has been cancelled.', old.title, to_char(old.starts_at at time zone 'America/New_York', 'FMDay, FMMonth DD at FMHH12:MI AM'))
        else format('%s changed from %s to %s. Open Hereford Cup for the latest details.', new.title,
          to_char(old.starts_at at time zone 'America/New_York', 'FMDay, FMMonth DD at FMHH12:MI AM'),
          to_char(new.starts_at at time zone 'America/New_York', 'FMDay, FMMonth DD at FMHH12:MI AM'))
      end,
      jsonb_build_object('old_starts_at', old.starts_at, 'new_starts_at', new.starts_at, 'old_status', old.status, 'new_status', new.status),
      clock_timestamp()
    );
  end if;

  if new.status = 'scheduled' and new.starts_at > clock_timestamp() then
    perform public.enqueue_notification_job(
      new.tournament_id, 'reminder', 'event', new.id,
      format('event-reminder:%s:%s', new.id, extract(epoch from new.starts_at)),
      'Hereford Cup activity reminder',
      format('%s begins %s. Open Hereford Cup for the full schedule.', new.title, to_char(new.starts_at at time zone 'America/New_York', 'FMDay, FMMonth DD at FMHH12:MI AM')),
      jsonb_build_object('starts_at', new.starts_at, 'event_type', new.event_type),
      new.starts_at - interval '12 hours'
    );
  end if;
  return new;
end;
$$;

revoke all on function public.enqueue_event_notifications() from public, anon, authenticated;
drop trigger if exists enqueue_event_notifications on public.tournament_events;
create trigger enqueue_event_notifications
after insert or update or delete on public.tournament_events
for each row execute function public.enqueue_event_notifications();

create or replace function public.enqueue_match_notifications()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  change_key text;
begin
  if tg_op = 'DELETE' then
    update public.notification_jobs
      set status = 'cancelled'
      where source_type = 'match' and source_id = old.id and notification_type = 'reminder' and status = 'queued';
    perform public.enqueue_notification_job(
      old.tournament_id, 'cancellation', 'match', old.id,
      format('match-cancelled:%s:%s', old.id, extract(epoch from clock_timestamp())),
      'Hereford Cup match cancelled',
      format('%s scheduled for %s has been cancelled.', old.name, to_char(old.starts_at at time zone 'America/New_York', 'FMDay, FMMonth DD at FMHH12:MI AM')),
      jsonb_build_object('old_starts_at', old.starts_at), clock_timestamp()
    );
    return old;
  end if;

  if tg_op = 'UPDATE' and (
    old.name is distinct from new.name or
    old.session is distinct from new.session or
    old.starts_at is distinct from new.starts_at or
    old.course_id is distinct from new.course_id or
    (old.status = 'cancelled') is distinct from (new.status = 'cancelled')
  ) then
    update public.notification_jobs
      set status = 'cancelled'
      where source_type = 'match' and source_id = new.id and notification_type = 'reminder' and status = 'queued';
    change_key := format('match-%s:%s:%s', case when new.status = 'cancelled' then 'cancelled' else 'changed' end, new.id, extract(epoch from new.updated_at));
    perform public.enqueue_notification_job(
      new.tournament_id,
      case when new.status = 'cancelled' then 'cancellation' else 'schedule_change' end,
      'match', new.id, change_key,
      case when new.status = 'cancelled' then 'Hereford Cup match cancelled' else 'Hereford Cup match changed' end,
      case when new.status = 'cancelled'
        then format('%s scheduled for %s has been cancelled.', old.name, to_char(old.starts_at at time zone 'America/New_York', 'FMDay, FMMonth DD at FMHH12:MI AM'))
        else format('%s changed from %s to %s. Open Hereford Cup for the latest match details.', new.name,
          to_char(old.starts_at at time zone 'America/New_York', 'FMDay, FMMonth DD at FMHH12:MI AM'),
          to_char(new.starts_at at time zone 'America/New_York', 'FMDay, FMMonth DD at FMHH12:MI AM'))
      end,
      jsonb_build_object('old_starts_at', old.starts_at, 'new_starts_at', new.starts_at, 'old_status', old.status, 'new_status', new.status),
      clock_timestamp()
    );
  end if;

  if new.status = 'scheduled' and new.starts_at is not null and new.starts_at > clock_timestamp() then
    perform public.enqueue_notification_job(
      new.tournament_id, 'reminder', 'match', new.id,
      format('match-reminder:%s:%s', new.id, extract(epoch from new.starts_at)),
      'Hereford Cup match reminder',
      format('%s begins %s. Open Hereford Cup for pairings and match details.', new.name, to_char(new.starts_at at time zone 'America/New_York', 'FMDay, FMMonth DD at FMHH12:MI AM')),
      jsonb_build_object('starts_at', new.starts_at),
      new.starts_at - interval '12 hours'
    );
  end if;
  return new;
end;
$$;

revoke all on function public.enqueue_match_notifications() from public, anon, authenticated;
drop trigger if exists enqueue_match_notifications on public.matches;
create trigger enqueue_match_notifications
after insert or update or delete on public.matches
for each row execute function public.enqueue_match_notifications();

-- Existing future schedule rows predate the triggers, so seed their 12-hour jobs.
insert into public.notification_jobs(
  tournament_id, notification_type, source_type, source_id,
  idempotency_key, subject, body, payload, scheduled_for
)
select
  event.tournament_id,
  'reminder',
  'event',
  event.id,
  format('event-reminder:%s:%s', event.id, extract(epoch from event.starts_at)),
  'Hereford Cup activity reminder',
  format('%s begins %s. Open Hereford Cup for the full schedule.', event.title, to_char(event.starts_at at time zone 'America/New_York', 'FMDay, FMMonth DD at FMHH12:MI AM')),
  jsonb_build_object('starts_at', event.starts_at, 'event_type', event.event_type),
  event.starts_at - interval '12 hours'
from public.tournament_events event
where event.status = 'scheduled' and event.starts_at > clock_timestamp()
on conflict (idempotency_key) do nothing;

insert into public.notification_jobs(
  tournament_id, notification_type, source_type, source_id,
  idempotency_key, subject, body, payload, scheduled_for
)
select
  match_record.tournament_id,
  'reminder',
  'match',
  match_record.id,
  format('match-reminder:%s:%s', match_record.id, extract(epoch from match_record.starts_at)),
  'Hereford Cup match reminder',
  format('%s begins %s. Open Hereford Cup for pairings and match details.', match_record.name, to_char(match_record.starts_at at time zone 'America/New_York', 'FMDay, FMMonth DD at FMHH12:MI AM')),
  jsonb_build_object('starts_at', match_record.starts_at),
  match_record.starts_at - interval '12 hours'
from public.matches match_record
where match_record.tournament_id is not null
  and match_record.status = 'scheduled'
  and match_record.starts_at > clock_timestamp()
on conflict (idempotency_key) do nothing;

create or replace function public.claim_notification_deliveries(target_limit integer default 20)
returns table(delivery_id uuid, recipient_user_id uuid, subject text, body text)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  job_record public.notification_jobs%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service role required';
  end if;
  if target_limit < 1 or target_limit > 50 then
    raise exception 'Claim limit must be between 1 and 50';
  end if;

  update public.notification_deliveries
  set status = 'pending', claimed_at = null, next_attempt_at = clock_timestamp(), updated_at = clock_timestamp()
  where status = 'processing'
    and claimed_at < clock_timestamp() - interval '15 minutes'
    and attempt_count < 5;

  update public.notification_deliveries
  set status = 'failed', updated_at = clock_timestamp(), last_error = coalesce(last_error, 'Maximum delivery attempts reached')
  where status in ('pending', 'processing') and attempt_count >= 5;

  for job_record in
    select job.*
    from public.notification_jobs job
    where job.status = 'queued' and job.scheduled_for <= clock_timestamp()
    order by job.scheduled_for, job.created_at
    for update skip locked
    limit target_limit
  loop
    insert into public.notification_deliveries(job_id, recipient_user_id)
    select job_record.id, membership.user_id
    from public.tournament_memberships membership
    left join public.notification_preferences preference
      on preference.tournament_id = membership.tournament_id
     and preference.user_id = membership.user_id
    where membership.tournament_id = job_record.tournament_id
      and membership.status = 'active'
      and case
        when job_record.notification_type = 'new_member' then
          membership.role = 'admin'
          and membership.user_id <> (job_record.payload ->> 'member_user_id')::uuid
          and coalesce(preference.new_member_admin_enabled, true)
        when job_record.notification_type = 'reminder' then
          coalesce(preference.reminders_enabled, true)
        else coalesce(preference.schedule_updates_enabled, true)
      end
    on conflict on constraint notification_delivery_recipient_unique do nothing;

    update public.notification_jobs set status = 'expanded' where id = job_record.id;
  end loop;

  return query
  with candidates as (
    select delivery.id
    from public.notification_deliveries delivery
    where delivery.status = 'pending'
      and delivery.next_attempt_at <= clock_timestamp()
      and delivery.attempt_count < 5
    order by delivery.next_attempt_at, delivery.created_at
    for update skip locked
    limit target_limit
  ), claimed as (
    update public.notification_deliveries delivery
    set status = 'processing',
        attempt_count = delivery.attempt_count + 1,
        claimed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    from candidates
    where delivery.id = candidates.id
    returning delivery.id, delivery.recipient_user_id, delivery.job_id
  )
  select claimed.id, claimed.recipient_user_id, job.subject, job.body
  from claimed
  join public.notification_jobs job on job.id = claimed.job_id;
end;
$$;

create or replace function public.complete_notification_deliveries(delivery_results jsonb)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  result_record jsonb;
  result_status text;
  result_error text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Service role required';
  end if;
  if jsonb_typeof(delivery_results) <> 'array' or jsonb_array_length(delivery_results) > 50 then
    raise exception 'Delivery results must be an array of at most 50 items';
  end if;

  for result_record in select value from jsonb_array_elements(delivery_results)
  loop
    result_status := result_record ->> 'status';
    result_error := left(coalesce(result_record ->> 'error', ''), 500);
    if result_status not in ('sent', 'failed') then
      raise exception 'Invalid delivery result status';
    end if;

    update public.notification_deliveries
    set status = case
          when result_status = 'sent' then 'sent'
          when attempt_count >= 5 then 'failed'
          else 'pending'
        end,
        sent_at = case when result_status = 'sent' then clock_timestamp() else sent_at end,
        claimed_at = null,
        next_attempt_at = case when result_status = 'failed' then clock_timestamp() + make_interval(mins => greatest(1, attempt_count * attempt_count)) else next_attempt_at end,
        last_error = case when result_status = 'failed' then nullif(result_error, '') else null end,
        updated_at = clock_timestamp()
    where id = (result_record ->> 'delivery_id')::uuid
      and status = 'processing';
  end loop;
end;
$$;

revoke all on function public.claim_notification_deliveries(integer) from public, anon, authenticated;
revoke all on function public.complete_notification_deliveries(jsonb) from public, anon, authenticated;
grant execute on function public.claim_notification_deliveries(integer) to service_role;
grant execute on function public.complete_notification_deliveries(jsonb) to service_role;
