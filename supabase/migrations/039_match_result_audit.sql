-- Keep an immutable, administrator-visible history of authoritative segment results.

create table if not exists public.match_result_audit (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null,
  segment_id uuid not null,
  action text not null check (action in ('baseline', 'finalized', 'recalculated')),
  old_status text,
  new_status text not null,
  old_differential integer,
  new_differential integer not null,
  old_holes_played integer,
  new_holes_played integer not null,
  change_reason text not null check (length(trim(change_reason)) between 1 and 500),
  changed_by uuid references public.profiles(id) on delete set null,
  changed_at timestamptz not null default now(),
  foreign key (segment_id, match_id) references public.match_segments(id, match_id) on delete cascade
);

create index if not exists match_result_audit_match_changed_idx
  on public.match_result_audit(match_id, changed_at desc, id desc);

create unique index if not exists match_result_audit_baseline_segment_idx
  on public.match_result_audit(segment_id)
  where action = 'baseline';

alter table public.match_result_audit enable row level security;

drop policy if exists match_result_audit_admin_read on public.match_result_audit;
create policy match_result_audit_admin_read
on public.match_result_audit
for select
to authenticated
using (
  public.is_admin()
  or exists (
    select 1
    from public.matches audit_match
    where audit_match.id = match_result_audit.match_id
      and public.is_tournament_admin(audit_match.tournament_id)
  )
);

revoke all on public.match_result_audit from public, anon, authenticated;
revoke insert, update, delete on public.match_result_audit from authenticated;
grant select on public.match_result_audit to authenticated;

-- Preserve an honest baseline for results that predate this append-only log. This is
-- not presented as the original finalization event or attributed to an administrator.
insert into public.match_result_audit(
  match_id,
  segment_id,
  action,
  old_status,
  new_status,
  old_differential,
  new_differential,
  old_holes_played,
  new_holes_played,
  change_reason,
  changed_by
)
select
  segment.match_id,
  segment.id,
  'baseline',
  null,
  segment.status,
  null,
  segment.differential,
  null,
  segment.holes_played,
  'Existing final result when audit logging was enabled.',
  null
from public.match_segments segment
where segment.status = 'final'
on conflict (segment_id) where action = 'baseline' do nothing;

-- A correction's audit row is inserted immediately before authoritative results are
-- recalculated. Carry its verified reason and affected hole through the transaction.
create or replace function public.set_result_change_reason_from_score_audit()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform set_config('app.result_change_reason', new.correction_reason, true);
  perform set_config('app.result_change_hole', new.hole_number::text, true);
  return new;
end;
$$;

revoke all on function public.set_result_change_reason_from_score_audit() from public, anon, authenticated;

drop trigger if exists set_result_change_reason_from_score_audit on public.score_correction_audit;
create trigger set_result_change_reason_from_score_audit
after insert on public.score_correction_audit
for each row execute function public.set_result_change_reason_from_score_audit();

create or replace function public.audit_authoritative_result_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  correction_match_id text := coalesce(current_setting('app.correcting_final_match_id', true), '');
  automatic_match_id text := coalesce(current_setting('app.auto_finalize_match_id', true), '');
  corrected_hole integer := nullif(current_setting('app.result_change_hole', true), '')::integer;
  result_action text;
  result_reason text;
begin
  -- Record actual authoritative-value changes. During an audited correction, also
  -- record a same-result recalculation for the segment containing the changed hole.
  if not (
    old.status is distinct from new.status
    or old.differential is distinct from new.differential
    or old.holes_played is distinct from new.holes_played
    or (
      correction_match_id = new.match_id::text
      and corrected_hole between new.start_hole and new.end_hole
    )
  ) then
    return new;
  end if;

  result_action := case
    when old.status is distinct from 'final' and new.status = 'final' then 'finalized'
    else 'recalculated'
  end;

  result_reason := coalesce(
    nullif(trim(current_setting('app.result_change_reason', true)), ''),
    case
      when automatic_match_id = new.match_id::text then 'Completed automatically from verified scorecards.'
      when correction_match_id = new.match_id::text then 'Recalculated after an audited score correction.'
      else 'Recorded by an administrator.'
    end
  );

  insert into public.match_result_audit(
    match_id,
    segment_id,
    action,
    old_status,
    new_status,
    old_differential,
    new_differential,
    old_holes_played,
    new_holes_played,
    change_reason,
    changed_by
  ) values (
    new.match_id,
    new.id,
    result_action,
    old.status,
    new.status,
    old.differential,
    new.differential,
    old.holes_played,
    new.holes_played,
    result_reason,
    auth.uid()
  );

  return new;
end;
$$;

revoke all on function public.audit_authoritative_result_change() from public, anon, authenticated;

drop trigger if exists audit_authoritative_result_change on public.match_segments;
create trigger audit_authoritative_result_change
after update on public.match_segments
for each row execute function public.audit_authoritative_result_change();
