-- Public Hereford Cup archive with administrator-managed results and photos.

create table if not exists public.legacy_editions (
  id uuid primary key default extensions.gen_random_uuid(),
  edition_year integer not null unique check (edition_year between 2023 and 2100),
  venue text not null check (char_length(trim(venue)) between 1 and 120),
  destination text not null check (char_length(trim(destination)) between 1 and 120),
  status text not null default 'completed' check (status in ('completed', 'planned')),
  winner_name text check (winner_name is null or char_length(trim(winner_name)) between 1 and 120),
  runner_up_name text check (runner_up_name is null or char_length(trim(runner_up_name)) between 1 and 120),
  final_score text check (final_score is null or char_length(trim(final_score)) between 1 and 120),
  story text check (story is null or char_length(trim(story)) <= 4000),
  published boolean not null default true,
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.legacy_results (
  id uuid primary key default extensions.gen_random_uuid(),
  edition_id uuid not null references public.legacy_editions(id) on delete cascade,
  label text not null check (char_length(trim(label)) between 1 and 160),
  cardinal_entry text check (cardinal_entry is null or char_length(trim(cardinal_entry)) <= 160),
  silver_entry text check (silver_entry is null or char_length(trim(silver_entry)) <= 160),
  result text not null check (char_length(trim(result)) between 1 and 240),
  sort_order integer not null default 0,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.legacy_photos (
  id uuid primary key default extensions.gen_random_uuid(),
  edition_id uuid not null references public.legacy_editions(id) on delete cascade,
  storage_path text not null unique check (char_length(trim(storage_path)) between 1 and 500),
  caption text check (caption is null or char_length(trim(caption)) <= 240),
  sort_order integer not null default 0,
  uploaded_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create or replace function public.stamp_legacy_editor()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_table_name = 'legacy_editions' then
    new.updated_by := auth.uid();
    new.updated_at := now();
    if tg_op = 'INSERT' then new.created_by := auth.uid(); end if;
  elsif tg_table_name = 'legacy_results' then
    new.updated_at := now();
    if tg_op = 'INSERT' then new.created_by := auth.uid(); end if;
  elsif tg_table_name = 'legacy_photos' and tg_op = 'INSERT' then
    new.uploaded_by := auth.uid();
  end if;
  return new;
end;
$$;

revoke all on function public.stamp_legacy_editor() from public;

drop trigger if exists stamp_legacy_edition_editor on public.legacy_editions;
create trigger stamp_legacy_edition_editor
before insert or update on public.legacy_editions
for each row execute function public.stamp_legacy_editor();

drop trigger if exists stamp_legacy_result_editor on public.legacy_results;
create trigger stamp_legacy_result_editor
before insert or update on public.legacy_results
for each row execute function public.stamp_legacy_editor();

drop trigger if exists stamp_legacy_photo_editor on public.legacy_photos;
create trigger stamp_legacy_photo_editor
before insert on public.legacy_photos
for each row execute function public.stamp_legacy_editor();

alter table public.legacy_editions enable row level security;
alter table public.legacy_results enable row level security;
alter table public.legacy_photos enable row level security;

create policy "published legacy editions are public"
on public.legacy_editions for select to anon, authenticated
using (published);

create policy "administrators manage legacy editions"
on public.legacy_editions for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "published legacy results are public"
on public.legacy_results for select to anon, authenticated
using (exists (
  select 1 from public.legacy_editions edition
  where edition.id = edition_id and edition.published
));

create policy "administrators manage legacy results"
on public.legacy_results for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "published legacy photos are public"
on public.legacy_photos for select to anon, authenticated
using (exists (
  select 1 from public.legacy_editions edition
  where edition.id = edition_id and edition.published
));

create policy "administrators manage legacy photos"
on public.legacy_photos for all to authenticated
using (public.is_admin()) with check (public.is_admin());

grant select on public.legacy_editions, public.legacy_results, public.legacy_photos to anon;
grant select, insert, update, delete on public.legacy_editions, public.legacy_results, public.legacy_photos to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('legacy-photos', 'legacy-photos', true, 8388608, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "legacy photos are publicly readable"
on storage.objects for select to anon, authenticated
using (bucket_id = 'legacy-photos');

create policy "administrators upload legacy photos"
on storage.objects for insert to authenticated
with check (bucket_id = 'legacy-photos' and public.is_admin());

create policy "administrators update legacy photos"
on storage.objects for update to authenticated
using (bucket_id = 'legacy-photos' and public.is_admin())
with check (bucket_id = 'legacy-photos' and public.is_admin());

create policy "administrators delete legacy photos"
on storage.objects for delete to authenticated
using (bucket_id = 'legacy-photos' and public.is_admin());

insert into public.legacy_editions(edition_year, venue, destination, status)
values
  (2023, 'Barefoot', 'Myrtle Beach', 'completed'),
  (2024, 'Innisbrook', 'Tampa', 'completed'),
  (2025, 'PGA Frisco', 'Texas', 'completed'),
  (2026, 'Kiawah', 'South Carolina', 'completed'),
  (2027, 'Pinehurst', 'North Carolina', 'planned')
on conflict (edition_year) do update
set venue = excluded.venue,
    destination = excluded.destination,
    status = excluded.status,
    updated_at = now();
