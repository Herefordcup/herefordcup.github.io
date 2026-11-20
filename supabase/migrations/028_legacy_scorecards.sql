-- Normalize public Legacy scorecards and add the supplied 2026 Kiawah ledger.
-- Confidence and source metadata remain available to administrators but are not public-facing.

create or replace function public.stamp_legacy_editor()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_table_name = 'legacy_editions' then
    if tg_op = 'INSERT' then
      new.updated_by := coalesce(auth.uid(), new.updated_by);
      new.created_by := coalesce(auth.uid(), new.created_by);
    else
      new.updated_by := coalesce(auth.uid(), old.updated_by, new.updated_by);
    end if;
    new.updated_at := now();
  elsif tg_table_name = 'legacy_results' then
    new.updated_at := now();
    if tg_op = 'INSERT' then
      new.created_by := coalesce(auth.uid(), new.created_by);
    end if;
  elsif tg_table_name = 'legacy_photos' and tg_op = 'INSERT' then
    new.uploaded_by := coalesce(auth.uid(), new.uploaded_by);
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_legacy_editor() from public;

alter table public.legacy_results
  add column if not exists public_visible boolean not null default true;

drop policy if exists "published legacy results are public" on public.legacy_results;
create policy "published legacy results are public"
on public.legacy_results for select to anon, authenticated
using (
  public_visible
  and exists (
    select 1 from public.legacy_editions edition
    where edition.id = edition_id and edition.published
  )
);

update public.legacy_results
set public_visible = false
where event_group = 'Reconciliation';

update public.legacy_editions
set winner_name = 'Blue Team',
    runner_up_name = 'White Team',
    updated_at = now()
where edition_year = 2023;

update public.legacy_editions
set winner_name = 'Blue Team',
    runner_up_name = 'White Team',
    final_score = 'Blue 23.5 – White 19.5',
    updated_at = now()
where edition_year = 2024;

update public.legacy_editions
set expected_points = 41,
    cardinal_total = 18,
    silver_total = 23,
    score_confidence = 'confirmed',
    winner_name = 'White Team',
    runner_up_name = 'Blue Team',
    final_score = 'Blue 18 – White 23',
    updated_at = now()
where edition_year = 2026;

do $$
declare
  kiawah_id uuid;
  supplied record;
  supplied_total numeric := 0;
  supplied_blue numeric := 0;
  supplied_white numeric := 0;
  persisted_count integer := 0;
  persisted_total numeric := 0;
  persisted_blue numeric := 0;
  persisted_white numeric := 0;
begin
  select edition.id into kiawah_id
  from public.legacy_editions edition
  where edition.edition_year = 2026
  for update;

  if kiawah_id is null then
    raise exception 'Kiawah Legacy edition not found';
  end if;

  -- Preserve prior rows for administrator reference, but replace the public Kiawah
  -- ledger with exactly one canonical row for each supplied scorecard line.
  update public.legacy_results
  set public_visible = false
  where edition_id = kiawah_id;

  for supplied in
    select *
    from (values
      ('Round 1 · Texas Scramble', 'Round 1 — Texas Scramble', 'Texas Scramble', 'Blue Team', 'White Team', 'White Team won 10–9', 19::numeric, 9::numeric, 10::numeric, 100),

      ('Round 2 · Front 9 · Gilbert & Abel vs Sul & Nicolai', 'Round 2 — 2v2 Scramble', '2v2 Scramble · Front 9', 'Gilbert & Abel', 'Sul & Nicolai', 'Gilbert & Abel won', 1, 1, 0, 200),
      ('Round 2 · Front 9 · PH & Trond vs Radway & Ben', 'Round 2 — 2v2 Scramble', '2v2 Scramble · Front 9', 'PH & Trond', 'Radway & Ben', 'PH & Trond won', 1, 1, 0, 210),
      ('Round 2 · Front 9 · Carl & Jose vs Seo & Lee', 'Round 2 — 2v2 Scramble', '2v2 Scramble · Front 9', 'Carl & Jose', 'Seo & Lee', 'Seo & Lee won', 1, 0, 1, 220),
      ('Round 2 · Front 9 · Szabo & Lukas vs Cam & Colt', 'Round 2 — 2v2 Scramble', '2v2 Scramble · Front 9', 'Szabo & Lukas', 'Cam & Colt', 'Szabo & Lukas won', 1, 1, 0, 230),
      ('Round 2 · Back 9 · Gilbert & Abel vs Sul & Nicolai', 'Round 2 — 2v2 Scramble', '2v2 Scramble · Back 9', 'Gilbert & Abel', 'Sul & Nicolai', 'Gilbert & Abel won', 1, 1, 0, 240),
      ('Round 2 · Back 9 · PH & Trond vs Radway & Ben', 'Round 2 — 2v2 Scramble', '2v2 Scramble · Back 9', 'PH & Trond', 'Radway & Ben', 'Radway & Ben won', 1, 0, 1, 250),
      ('Round 2 · Back 9 · Carl & Jose vs Seo & Lee', 'Round 2 — 2v2 Scramble', '2v2 Scramble · Back 9', 'Carl & Jose', 'Seo & Lee', 'Carl & Jose won', 1, 1, 0, 260),
      ('Round 2 · Back 9 · Szabo & Lukas vs Cam & Colt', 'Round 2 — 2v2 Scramble', '2v2 Scramble · Back 9', 'Szabo & Lukas', 'Cam & Colt', 'Cam & Colt won', 1, 0, 1, 270),

      ('Round 3 · Front 9 · Gilbert & Szabo vs Lee & Nicolai', 'Round 3 — 2v2 Best Ball', '2v2 Best Ball · Front 9', 'Gilbert & Szabo', 'Lee & Nicolai', 'Lee & Nicolai won', 1, 0, 1, 300),
      ('Round 3 · Front 9 · PH & Abel vs Colt & Seo', 'Round 3 — 2v2 Best Ball', '2v2 Best Ball · Front 9', 'PH & Abel', 'Colt & Seo', 'Colt & Seo won', 1, 0, 1, 310),
      ('Round 3 · Front 9 · Jose & Lukas vs Ben & Cam', 'Round 3 — 2v2 Best Ball', '2v2 Best Ball · Front 9', 'Jose & Lukas', 'Ben & Cam', 'Points split 1–1', 2, 1, 1, 320),
      ('Round 3 · Front 9 · Carl & Trond vs Radway & Sul', 'Round 3 — 2v2 Best Ball', '2v2 Best Ball · Front 9', 'Carl & Trond', 'Radway & Sul', 'Points split 1–1', 2, 1, 1, 330),
      ('Round 3 · Back 9 · Gilbert & Szabo vs Lee & Nicolai', 'Round 3 — 2v2 Best Ball', '2v2 Best Ball · Back 9', 'Gilbert & Szabo', 'Lee & Nicolai', 'Lee & Nicolai won', 1, 0, 1, 340),
      ('Round 3 · Back 9 · PH & Abel vs Colt & Seo', 'Round 3 — 2v2 Best Ball', '2v2 Best Ball · Back 9', 'PH & Abel', 'Colt & Seo', 'Colt & Seo won', 1, 0, 1, 350),
      ('Round 3 · Back 9 · Jose & Lukas vs Ben & Cam', 'Round 3 — 2v2 Best Ball', '2v2 Best Ball · Back 9', 'Jose & Lukas', 'Ben & Cam', 'Ben & Cam won', 1, 0, 1, 360),
      ('Round 3 · Back 9 · Carl & Trond vs Radway & Sul', 'Round 3 — 2v2 Best Ball', '2v2 Best Ball · Back 9', 'Carl & Trond', 'Radway & Sul', 'Carl & Trond won', 1, 1, 0, 370),

      ('Long Drive · 1st · Radway', 'Long Drive', 'Long Drive', null, 'Radway', 'Radway won 1 point', 1, 0, 1, 400),
      ('Long Drive · 2nd · Gilbert', 'Long Drive', 'Long Drive', 'Gilbert', null, 'Gilbert won 0.5 points', 0.5, 0.5, 0, 410),
      ('Long Drive · 3rd · Carl', 'Long Drive', 'Long Drive', 'Carl', null, 'Carl won 0.5 points', 0.5, 0.5, 0, 420),

      ('Chip Off · Gilbert & Trond vs Nicolai & Cam', 'Chip Off', 'Chip Off', 'Gilbert & Trond', 'Nicolai & Cam', 'Nicolai & Cam won', 0.5, 0, 0.5, 500),
      ('Chip Off · Abel & Lukas vs Sul & Ben', 'Chip Off', 'Chip Off', 'Abel & Lukas', 'Sul & Ben', 'Sul & Ben won', 0.5, 0, 0.5, 510),
      ('Chip Off · Carl & Szabo vs Radway & Seo', 'Chip Off', 'Chip Off', 'Carl & Szabo', 'Radway & Seo', 'Radway & Seo won', 0.5, 0, 0.5, 520),
      ('Chip Off · PH & Jose vs Colt & Lee', 'Chip Off', 'Chip Off', 'PH & Jose', 'Colt & Lee', 'Colt & Lee won', 0.5, 0, 0.5, 530),

      ('Round 4 · Front 9 · Gilbert vs Seo', 'Round 4 — 1v1', '1v1 · Front 9', 'Gilbert', 'Seo', 'No points awarded', 0, 0, 0, 600),
      ('Round 4 · Front 9 · PH vs Nicolai', 'Round 4 — 1v1', '1v1 · Front 9', 'PH', 'Nicolai', 'No points awarded', 0, 0, 0, 610),
      ('Round 4 · Front 9 · Szabo vs Colt', 'Round 4 — 1v1', '1v1 · Front 9', 'Szabo', 'Colt', 'No points awarded', 0, 0, 0, 620),
      ('Round 4 · Front 9 · Carl vs Ben', 'Round 4 — 1v1', '1v1 · Front 9', 'Carl', 'Ben', 'No points awarded', 0, 0, 0, 630),
      ('Round 4 · Front 9 · Jose vs Radway', 'Round 4 — 1v1', '1v1 · Front 9', 'Jose', 'Radway', 'No points awarded', 0, 0, 0, 640),
      ('Round 4 · Front 9 · Abel vs Sul', 'Round 4 — 1v1', '1v1 · Front 9', 'Abel', 'Sul', 'No points awarded', 0, 0, 0, 650),
      ('Round 4 · Front 9 · Lukas vs Lee', 'Round 4 — 1v1', '1v1 · Front 9', 'Lukas', 'Lee', 'No points awarded', 0, 0, 0, 660),
      ('Round 4 · Front 9 · Trond vs Cam', 'Round 4 — 1v1', '1v1 · Front 9', 'Trond', 'Cam', 'No points awarded', 0, 0, 0, 670),
      ('Round 4 · Back 9 · Gilbert vs Nicolai', 'Round 4 — 1v1', '1v1 · Back 9', 'Gilbert', 'Nicolai', 'No points awarded', 0, 0, 0, 680),
      ('Round 4 · Back 9 · PH vs Seo', 'Round 4 — 1v1', '1v1 · Back 9', 'PH', 'Seo', 'No points awarded', 0, 0, 0, 690),
      ('Round 4 · Back 9 · Szabo vs Ben', 'Round 4 — 1v1', '1v1 · Back 9', 'Szabo', 'Ben', 'No points awarded', 0, 0, 0, 700),
      ('Round 4 · Back 9 · Carl vs Colt', 'Round 4 — 1v1', '1v1 · Back 9', 'Carl', 'Colt', 'No points awarded', 0, 0, 0, 710),
      ('Round 4 · Back 9 · Jose vs Sul', 'Round 4 — 1v1', '1v1 · Back 9', 'Jose', 'Sul', 'No points awarded', 0, 0, 0, 720),
      ('Round 4 · Back 9 · Abel vs Radway', 'Round 4 — 1v1', '1v1 · Back 9', 'Abel', 'Radway', 'No points awarded', 0, 0, 0, 730),
      ('Round 4 · Back 9 · Lukas vs Cam', 'Round 4 — 1v1', '1v1 · Back 9', 'Lukas', 'Cam', 'No points awarded', 0, 0, 0, 740),
      ('Round 4 · Back 9 · Trond vs Lee', 'Round 4 — 1v1', '1v1 · Back 9', 'Trond', 'Lee', 'No points awarded', 0, 0, 0, 750)
    ) as source_rows(
      label, event_group, format_label, cardinal_entry, silver_entry, result,
      points_available, cardinal_points, silver_points, sort_order
    )
  loop
    supplied_total := supplied_total + supplied.points_available;
    supplied_blue := supplied_blue + supplied.cardinal_points;
    supplied_white := supplied_white + supplied.silver_points;

    update public.legacy_results candidate
    set event_group = supplied.event_group,
        format_label = supplied.format_label,
        handicap_allowance = null,
        cardinal_entry = supplied.cardinal_entry,
        silver_entry = supplied.silver_entry,
        result = supplied.result,
        points_available = supplied.points_available,
        cardinal_points = supplied.cardinal_points,
        silver_points = supplied.silver_points,
        confidence = 'confirmed',
        public_visible = true,
        sort_order = supplied.sort_order,
        updated_at = now()
    where candidate.id = (
      select existing.id
      from public.legacy_results existing
      where existing.edition_id = kiawah_id
        and existing.label = supplied.label
      order by existing.created_at, existing.id
      limit 1
    );

    if not found then
      insert into public.legacy_results(
        edition_id, label, event_group, format_label, handicap_allowance,
        cardinal_entry, silver_entry, result, points_available,
        cardinal_points, silver_points, confidence, source_note, public_visible, sort_order
      ) values (
        kiawah_id, supplied.label, supplied.event_group, supplied.format_label, null,
        supplied.cardinal_entry, supplied.silver_entry, supplied.result, supplied.points_available,
        supplied.cardinal_points, supplied.silver_points, 'confirmed', null, true, supplied.sort_order
      );
    end if;
  end loop;

  if supplied_total <> 41 or supplied_blue <> 18 or supplied_white <> 23 then
    raise exception 'Kiawah scoring rows do not reconcile';
  end if;

  select count(*),
         coalesce(sum(result.points_available), 0),
         coalesce(sum(result.cardinal_points), 0),
         coalesce(sum(result.silver_points), 0)
    into persisted_count, persisted_total, persisted_blue, persisted_white
  from public.legacy_results result
  where result.edition_id = kiawah_id
    and result.public_visible;

  if persisted_count <> 40
     or persisted_total <> 41
     or persisted_blue <> 18
     or persisted_white <> 23 then
    raise exception 'Persisted Kiawah scoring rows do not reconcile';
  end if;
end
$$;
