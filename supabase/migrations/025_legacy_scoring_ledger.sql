-- Add structured, source-aware scoring fields to the existing Legacy archive.

alter table public.legacy_editions
  add column if not exists expected_points numeric(7,2),
  add column if not exists cardinal_total numeric(7,2),
  add column if not exists silver_total numeric(7,2),
  add column if not exists score_confidence text not null default 'unresolved',
  add column if not exists source_notes text;

alter table public.legacy_results
  add column if not exists event_group text,
  add column if not exists format_label text,
  add column if not exists handicap_allowance text,
  add column if not exists points_available numeric(7,2),
  add column if not exists cardinal_points numeric(7,2),
  add column if not exists silver_points numeric(7,2),
  add column if not exists confidence text not null default 'unresolved',
  add column if not exists source_note text;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'legacy_editions_score_confidence_check' and conrelid = 'public.legacy_editions'::regclass) then
    alter table public.legacy_editions add constraint legacy_editions_score_confidence_check
      check (score_confidence in ('confirmed', 'probable', 'unresolved'));
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'legacy_editions_expected_points_nonnegative' and conrelid = 'public.legacy_editions'::regclass) then
    alter table public.legacy_editions add constraint legacy_editions_expected_points_nonnegative
      check (expected_points is null or expected_points >= 0);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'legacy_editions_cardinal_total_nonnegative' and conrelid = 'public.legacy_editions'::regclass) then
    alter table public.legacy_editions add constraint legacy_editions_cardinal_total_nonnegative
      check (cardinal_total is null or cardinal_total >= 0);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'legacy_editions_silver_total_nonnegative' and conrelid = 'public.legacy_editions'::regclass) then
    alter table public.legacy_editions add constraint legacy_editions_silver_total_nonnegative
      check (silver_total is null or silver_total >= 0);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'legacy_editions_totals_within_expected' and conrelid = 'public.legacy_editions'::regclass) then
    alter table public.legacy_editions add constraint legacy_editions_totals_within_expected
      check (expected_points is null or cardinal_total is null or silver_total is null or cardinal_total + silver_total <= expected_points);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'legacy_editions_cardinal_within_expected' and conrelid = 'public.legacy_editions'::regclass) then
    alter table public.legacy_editions add constraint legacy_editions_cardinal_within_expected
      check (cardinal_total is null or expected_points is null or cardinal_total <= expected_points);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'legacy_editions_silver_within_expected' and conrelid = 'public.legacy_editions'::regclass) then
    alter table public.legacy_editions add constraint legacy_editions_silver_within_expected
      check (silver_total is null or expected_points is null or silver_total <= expected_points);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'legacy_editions_confirmed_publication_reconciles' and conrelid = 'public.legacy_editions'::regclass) then
    alter table public.legacy_editions add constraint legacy_editions_confirmed_publication_reconciles
      check (
        published is not true
        or score_confidence <> 'confirmed'
        or (
          expected_points is not null
          and cardinal_total is not null
          and silver_total is not null
          and cardinal_total + silver_total = expected_points
        )
      );
  end if;

  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'legacy_results_confidence_check' and conrelid = 'public.legacy_results'::regclass) then
    alter table public.legacy_results add constraint legacy_results_confidence_check
      check (confidence in ('confirmed', 'probable', 'unresolved'));
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'legacy_results_points_available_nonnegative' and conrelid = 'public.legacy_results'::regclass) then
    alter table public.legacy_results add constraint legacy_results_points_available_nonnegative
      check (points_available is null or points_available >= 0);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'legacy_results_cardinal_points_nonnegative' and conrelid = 'public.legacy_results'::regclass) then
    alter table public.legacy_results add constraint legacy_results_cardinal_points_nonnegative
      check (cardinal_points is null or cardinal_points >= 0);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'legacy_results_silver_points_nonnegative' and conrelid = 'public.legacy_results'::regclass) then
    alter table public.legacy_results add constraint legacy_results_silver_points_nonnegative
      check (silver_points is null or silver_points >= 0);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'legacy_results_awards_within_available' and conrelid = 'public.legacy_results'::regclass) then
    alter table public.legacy_results add constraint legacy_results_awards_within_available
      check (points_available is null or cardinal_points is null or silver_points is null or cardinal_points + silver_points <= points_available);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'legacy_results_cardinal_within_available' and conrelid = 'public.legacy_results'::regclass) then
    alter table public.legacy_results add constraint legacy_results_cardinal_within_available
      check (cardinal_points is null or points_available is null or cardinal_points <= points_available);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint where conname = 'legacy_results_silver_within_available' and conrelid = 'public.legacy_results'::regclass) then
    alter table public.legacy_results add constraint legacy_results_silver_within_available
      check (silver_points is null or points_available is null or silver_points <= points_available);
  end if;
end
$$;

create index if not exists legacy_results_edition_group_order_idx
  on public.legacy_results(edition_id, event_group, sort_order);

with backfill(edition_year, expected_points, cardinal_total, silver_total, score_confidence, source_notes) as (
  values
    (2024, 43, 23.5, 19.5, 'confirmed', 'The final source total accounts for all 43 points; individual working rows retain their uncertainty.'),
    (2025, 52, 23.5, 21.5, 'unresolved', 'Working totals account for 45 of 52 expected points; seven points remain unallocated in the source.')
)
update public.legacy_editions edition
set expected_points = backfill.expected_points,
    cardinal_total = backfill.cardinal_total,
    silver_total = backfill.silver_total,
    score_confidence = backfill.score_confidence,
    source_notes = backfill.source_notes
from backfill
where edition.edition_year = backfill.edition_year;

with backfill(
  edition_year, label, event_group, format_label, handicap_allowance,
  points_available, cardinal_points, silver_points, confidence, source_note
) as (
  values
    (2024, 'Match 1 · Texas Scramble · Team score A', 'Match 1 — Texas Scramble', 'Texas Scramble', '25% low / 20% / 15% / 10% high', 9, 4, 5, 'confirmed', null),
    (2024, 'Match 1 · Texas Scramble · Team score B', 'Match 1 — Texas Scramble', 'Texas Scramble', '35% low / 15% high', 2, 2, 0, 'probable', 'Pretty sure Blue won both; retained as probable rather than confirmed.'),
    (2024, 'Match 2 · Scramble 2v2 · Pairing 1', 'Match 2 — Scramble', 'Scramble 2v2', '35% low / 15% high', 2, 1, 1, 'confirmed', null),
    (2024, 'Match 2 · Scramble 2v2 · Pairing 2', 'Match 2 — Scramble', 'Scramble 2v2', '35% low / 15% high', 2, 2, 0, 'unresolved', 'Award entry conflicts with the nearby note: Pretty sure White won both.'),
    (2024, 'Match 2 · Scramble 2v2 · Pairing 3', 'Match 2 — Scramble', 'Scramble 2v2', '35% low / 15% high', 2, 0, 2, 'probable', 'Pretty sure White won both; retained as probable rather than confirmed.'),
    (2024, 'Putt-Putt · Round 1', 'Putt-Putt', 'Putt-Putt', null, 1, 0, 1, 'confirmed', null),
    (2024, 'Putt-Putt · Round 2', 'Putt-Putt', 'Putt-Putt', null, 1, 0, 1, 'confirmed', null),
    (2024, 'Match 3 · Best Ball 2v2 · Pairing 1', 'Match 3 — Best Ball', 'Best Ball 2v2', '90%', 2, 2, 0, 'confirmed', null),
    (2024, 'Match 3 · Best Ball 2v2 · Pairing 2', 'Match 3 — Best Ball', 'Best Ball 2v2', '90%', 2, 1, 1, 'confirmed', null),
    (2024, 'Match 3 · Best Ball 2v2 · Pairing 3', 'Match 3 — Best Ball', 'Best Ball 2v2', '90%', 2, 0, 2, 'confirmed', null),
    (2024, 'Match 4 · Shamble 2v2 · Pairing 1', 'Match 4 — Shamble', 'Shamble 2v2', '75%', 2, 0.5, 1.5, 'confirmed', null),
    (2024, 'Match 4 · Shamble 2v2 · Pairing 2', 'Match 4 — Shamble', 'Shamble 2v2', '75%', 2, null, null, 'unresolved', 'No awarded score entered in source.'),
    (2024, 'Match 4 · Shamble 2v2 · Pairing 3', 'Match 4 — Shamble', 'Shamble 2v2', '75%', 2, 1, 1, 'confirmed', null),
    (2024, 'Source sheet checkpoint before Singles', 'Reconciliation', null, null, null, null, null, 'unresolved', 'Conflicting working figures are preserved in the source result text.'),
    (2024, 'Match 5 · Singles · Front 9 · Pairing 1', 'Match 5 — Singles — Front 9', 'Singles', '100%', 1, 1, 0, 'confirmed', null),
    (2024, 'Match 5 · Singles · Front 9 · Pairing 2', 'Match 5 — Singles — Front 9', 'Singles', '100%', 1, 1, 0, 'confirmed', null),
    (2024, 'Match 5 · Singles · Front 9 · Pairing 3', 'Match 5 — Singles — Front 9', 'Singles', '100%', 1, 1, 0, 'confirmed', null),
    (2024, 'Match 5 · Singles · Front 9 · Pairing 4', 'Match 5 — Singles — Front 9', 'Singles', '100%', 1, 0.5, 0.5, 'confirmed', null),
    (2024, 'Match 5 · Singles · Front 9 · Pairing 5', 'Match 5 — Singles — Front 9', 'Singles', '100%', 1, 0.5, 0.5, 'confirmed', null),
    (2024, 'Match 5 · Singles · Front 9 · Pairing 6', 'Match 5 — Singles — Front 9', 'Singles', '100%', 1, 1, 0, 'confirmed', null),
    (2024, 'Match 5 · Singles · Back 9 · Pairing 1', 'Match 5 — Singles — Back 9', 'Singles', '100%', 1, 0.5, 0.5, 'confirmed', null),
    (2024, 'Match 5 · Singles · Back 9 · Pairing 2', 'Match 5 — Singles — Back 9', 'Singles', '100%', 1, 1, 0, 'confirmed', null),
    (2024, 'Match 5 · Singles · Back 9 · Pairing 3', 'Match 5 — Singles — Back 9', 'Singles', '100%', 1, 1, 0, 'confirmed', null),
    (2024, 'Match 5 · Singles · Back 9 · Pairing 4', 'Match 5 — Singles — Back 9', 'Singles', '100%', 1, 0, 1, 'confirmed', null),
    (2024, 'Match 5 · Singles · Back 9 · Pairing 5', 'Match 5 — Singles — Back 9', 'Singles', '100%', 1, 0, 1, 'confirmed', null),
    (2024, 'Match 5 · Singles · Back 9 · Pairing 6', 'Match 5 — Singles — Back 9', 'Singles', '100%', 1, 0, 1, 'confirmed', null),
    (2024, 'Final source sheet total', 'Reconciliation', null, null, null, null, null, 'confirmed', 'Edition-level total; excluded from per-result award sums.'),

    (2025, 'Match 1 · Texas Scramble · Team score A', 'Match 1 — Texas Scramble', 'Texas Scramble', '25% low / 20% / 15% / 10% high', 7, 3, 4, 'confirmed', null),
    (2025, 'Match 1 · Texas Scramble · Team score B', 'Match 1 — Texas Scramble', 'Texas Scramble', '35% low / 15% high', 8, 4, 4, 'confirmed', null),
    (2025, 'Match 2 · Scramble 2v2 · Pairing 1', 'Match 2 — Scramble', 'Scramble 2v2', '35% low / 15% high', 2, 0, 2, 'confirmed', null),
    (2025, 'Match 2 · Scramble 2v2 · Pairing 2', 'Match 2 — Scramble', 'Scramble 2v2', '35% low / 15% high', 2, null, null, 'unresolved', 'No awarded score entered in source.'),
    (2025, 'Match 2 · Scramble 2v2 · Pairing 3', 'Match 2 — Scramble', 'Scramble 2v2', '35% low / 15% high', 2, 1, 1, 'confirmed', null),
    (2025, 'Match 2 · Scramble 2v2 · Pairing 4', 'Match 2 — Scramble', 'Scramble 2v2', '35% low / 15% high', 2, null, null, 'unresolved', 'No awarded score entered in source.'),
    (2025, 'Match 3 · Best Ball 2v2 · Pairing 1', 'Match 3 — Best Ball', 'Best Ball 2v2', '90%', 2, 1, 1, 'confirmed', null),
    (2025, 'Match 3 · Best Ball 2v2 · Pairing 2', 'Match 3 — Best Ball', 'Best Ball 2v2', '90%', 2, null, 1, 'unresolved', 'Blue award is blank in source; blank remains null rather than zero.'),
    (2025, 'Match 3 · Best Ball 2v2 · Pairing 3', 'Match 3 — Best Ball', 'Best Ball 2v2', '90%', 2, 1, 1, 'confirmed', null),
    (2025, 'Match 3 · Best Ball 2v2 · Pairing 4', 'Match 3 — Best Ball', 'Best Ball 2v2', '90%', 2, 2, 0, 'confirmed', null),
    (2025, 'Long Drive · Lukas?', 'Long Drive', 'Long Drive', null, 1, 1, 0, 'probable', 'Winner name includes a source question mark.'),
    (2025, 'Long Drive · PH?', 'Long Drive', 'Long Drive', null, 0.5, 0.5, 0, 'probable', 'Winner name includes a source question mark.'),
    (2025, 'Par 3 · Shamble · Zhou', 'Par 3 — Shamble', 'Shamble', null, 2, 2, 0, 'confirmed', null),
    (2025, 'Par 3 · Shamble · Gilbert', 'Par 3 — Shamble', 'Shamble', null, 1, 1, 0, 'confirmed', null),
    (2025, 'Par 3 · Shamble · ? Blue Team. Carl?', 'Par 3 — Shamble', 'Shamble', null, 0.5, 0.5, 0, 'unresolved', 'Source attribution remains uncertain.'),
    (2025, 'Match 5 · Singles · Front 9 · Pairing 1', 'Match 5 — Singles — Front 9', 'Singles', '100%', 1, 1, 0, 'confirmed', null),
    (2025, 'Match 5 · Singles · Front 9 · Pairing 2', 'Match 5 — Singles — Front 9', 'Singles', '100%', 1, 1, 0, 'confirmed', null),
    (2025, 'Match 5 · Singles · Front 9 · Pairing 3', 'Match 5 — Singles — Front 9', 'Singles', '100%', 1, 0, 1, 'confirmed', null),
    (2025, 'Match 5 · Singles · Front 9 · Pairing 4', 'Match 5 — Singles — Front 9', 'Singles', '100%', 1, 0, 1, 'confirmed', null),
    (2025, 'Match 5 · Singles · Front 9 · Pairing 5', 'Match 5 — Singles — Front 9', 'Singles', '100%', 1, 1, 0, 'confirmed', null),
    (2025, 'Match 5 · Singles · Front 9 · Pairing 6', 'Match 5 — Singles — Front 9', 'Singles', '100%', 1, null, null, 'unresolved', 'No awarded score entered in source.'),
    (2025, 'Match 5 · Singles · Front 9 · Pairing 7', 'Match 5 — Singles — Front 9', 'Singles', '100%', 1, 0, 1, 'confirmed', null),
    (2025, 'Match 5 · Singles · Front 9 · Pairing 8', 'Match 5 — Singles — Front 9', 'Singles', '100%', 1, 0, 1, 'confirmed', null),
    (2025, 'Match 5 · Singles · Back 9 · Pairing 1', 'Match 5 — Singles — Back 9', 'Singles', '100%', 1, 1, 0, 'confirmed', null),
    (2025, 'Match 5 · Singles · Back 9 · Pairing 2', 'Match 5 — Singles — Back 9', 'Singles', '100%', 1, 1, 0, 'confirmed', null),
    (2025, 'Match 5 · Singles · Back 9 · Pairing 3', 'Match 5 — Singles — Back 9', 'Singles', '100%', 1, 0.5, 0.5, 'confirmed', null),
    (2025, 'Match 5 · Singles · Back 9 · Pairing 4', 'Match 5 — Singles — Back 9', 'Singles', '100%', 1, 0, 1, 'confirmed', null),
    (2025, 'Match 5 · Singles · Back 9 · Pairing 5', 'Match 5 — Singles — Back 9', 'Singles', '100%', 1, 1, 0, 'confirmed', null),
    (2025, 'Match 5 · Singles · Back 9 · Pairing 6', 'Match 5 — Singles — Back 9', 'Singles', '100%', 1, null, null, 'unresolved', 'No awarded score entered in source.'),
    (2025, 'Match 5 · Singles · Back 9 · Pairing 7', 'Match 5 — Singles — Back 9', 'Singles', '100%', 1, 0, 1, 'confirmed', null),
    (2025, 'Match 5 · Singles · Back 9 · Pairing 8', 'Match 5 — Singles — Back 9', 'Singles', '100%', 1, 0, 1, 'confirmed', null),
    (2025, 'Source sheet working total', 'Reconciliation', null, null, null, null, null, 'unresolved', 'Working total only; seven expected points remain unallocated.')
)
update public.legacy_results result
set event_group = backfill.event_group,
    format_label = backfill.format_label,
    handicap_allowance = backfill.handicap_allowance,
    points_available = backfill.points_available,
    cardinal_points = backfill.cardinal_points,
    silver_points = backfill.silver_points,
    confidence = backfill.confidence,
    source_note = backfill.source_note
from backfill
join public.legacy_editions edition
  on edition.edition_year = backfill.edition_year
where result.edition_id = edition.id
  and result.label = backfill.label;

do $$
begin
  if exists (
    select 1
    from public.legacy_results result
    join public.legacy_editions edition on edition.id = result.edition_id
    where edition.edition_year in (2024, 2025)
      and (result.event_group is null or result.confidence is null)
  ) then
    raise exception 'Legacy scoring backfill is incomplete for 2024 or 2025';
  end if;
end
$$;
