-- Align commentary lifecycle constraints with the actual hidden status and harden Legacy photo publication.

drop index if exists public.match_commentaries_one_active_post_match;
drop index if exists public.match_commentaries_one_active_segment;

with ranked as (
  select id,
         row_number() over (
           partition by match_id, commentary_type, coalesce(segment_id, '00000000-0000-0000-0000-000000000000'::uuid)
           order by created_at desc, id desc
         ) as position
  from public.match_commentaries
  where status <> 'hidden'
)
update public.match_commentaries commentary
set status = 'hidden'
from ranked
where ranked.id = commentary.id
  and ranked.position > 1;

create unique index match_commentaries_one_active_post_match
  on public.match_commentaries(match_id, commentary_type)
  where commentary_type = 'post_match'
    and segment_id is null
    and status <> 'hidden';

create unique index match_commentaries_one_active_segment
  on public.match_commentaries(match_id, segment_id, commentary_type)
  where commentary_type = 'segment'
    and segment_id is not null
    and status <> 'hidden';

alter table public.legacy_editions
  alter column published set default false;

update storage.buckets
set public = false
where id = 'legacy-photos';

drop policy if exists "legacy photos are publicly readable" on storage.objects;
drop policy if exists "published legacy photos are readable" on storage.objects;
create policy "published legacy photos are readable"
on storage.objects for select to anon, authenticated
using (
  bucket_id = 'legacy-photos'
  and exists (
    select 1
    from public.legacy_photos photo
    join public.legacy_editions edition on edition.id = photo.edition_id
    where photo.storage_path = storage.objects.name
      and edition.published
  )
);

create or replace function public.delete_legacy_photo(target_photo_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  removed_path text;
begin
  if not public.is_admin() then
    raise exception 'Administrator access is required';
  end if;

  delete from public.legacy_photos
  where id = target_photo_id
  returning storage_path into removed_path;

  if removed_path is null then
    raise exception 'Legacy photo was not found';
  end if;

  return removed_path;
end;
$$;

revoke all on function public.delete_legacy_photo(uuid) from public;
grant execute on function public.delete_legacy_photo(uuid) to authenticated;
