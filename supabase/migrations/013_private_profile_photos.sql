-- Private player profile photos with owner-only writes and shared-tournament reads.

alter table public.profiles
  add column if not exists profile_photo_path text;

alter table public.profiles
  drop constraint if exists profiles_profile_photo_path_owner_check;
alter table public.profiles
  add constraint profiles_profile_photo_path_owner_check
  check (profile_photo_path is null or profile_photo_path like id::text || '/%');

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-photos',
  'profile-photos',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_view_profile_photo(target_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  target_user_id uuid;
  target_user_text text := split_part(target_path, '/', 1);
begin
  if public.is_admin() then
    return true;
  end if;

  if target_user_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;

  target_user_id := target_user_text::uuid;
  if target_user_id = auth.uid() then
    return true;
  end if;

  return exists (
    select 1
    from public.tournament_memberships viewer
    join public.tournament_memberships subject
      on subject.tournament_id = viewer.tournament_id
     and subject.status = 'active'
    where viewer.user_id = auth.uid()
      and viewer.status = 'active'
      and subject.user_id = target_user_id
  );
end;
$$;

grant execute on function public.can_view_profile_photo(text) to authenticated;

-- Authenticated owners may write only inside their own UUID folder.
drop policy if exists "owners upload profile photos" on storage.objects;
create policy "owners upload profile photos"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'profile-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "owners update profile photos" on storage.objects;
create policy "owners update profile photos"
on storage.objects for update to authenticated
using (
  bucket_id = 'profile-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
)
with check (
  bucket_id = 'profile-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "owners delete profile photos" on storage.objects;
create policy "owners delete profile photos"
on storage.objects for delete to authenticated
using (
  bucket_id = 'profile-photos'
  and (storage.foldername(name))[1] = auth.uid()::text
);

-- Shared active tournament members view profile photos through signed URLs.
drop policy if exists "shared active tournament members view profile photos" on storage.objects;
create policy "shared active tournament members view profile photos"
on storage.objects for select to authenticated
using (
  bucket_id = 'profile-photos'
  and public.can_view_profile_photo(name)
);
