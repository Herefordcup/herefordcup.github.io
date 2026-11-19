-- Restore administrator approval for newly registered players and provide
-- audited approve/remove/restore controls. Existing active memberships remain active.
-- Apply after 017_member_email_notifications.sql.

create table public.membership_status_audit (
  id uuid primary key default extensions.gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  previous_status text not null check (previous_status in ('pending', 'active', 'removed')),
  new_status text not null check (new_status in ('active', 'removed')),
  reason text not null check (char_length(trim(reason)) between 2 and 500),
  changed_by uuid not null references public.profiles(id),
  changed_at timestamptz not null default now()
);

create index membership_status_audit_membership_idx
  on public.membership_status_audit(tournament_id, user_id, changed_at desc);

alter table public.membership_status_audit enable row level security;

create or replace function public.is_tournament_admin(target_tournament_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_admin() or exists (
    select 1
    from public.tournament_memberships membership
    where membership.tournament_id = target_tournament_id
      and membership.user_id = auth.uid()
      and membership.role = 'admin'
      and membership.status = 'active'
  );
$$;

revoke all on function public.is_tournament_admin(uuid) from public, anon;
grant execute on function public.is_tournament_admin(uuid) to authenticated;

drop policy if exists "administrators view membership status audit" on public.membership_status_audit;
create policy "administrators view membership status audit"
  on public.membership_status_audit for select to authenticated
  using (public.is_tournament_admin(tournament_id));

grant select on public.membership_status_audit to authenticated;
revoke insert, update, delete on public.membership_status_audit from authenticated;

-- New ordinary accounts receive pending memberships. Global administrators stay
-- active so a new deployment cannot lock every administrator out.
create or replace function public.enroll_profile_in_all_tournaments(target_user_id uuid)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  select pg_advisory_xact_lock(202603180006);

  insert into public.tournament_memberships(
    tournament_id,
    user_id,
    status,
    role,
    joined_at
  )
  select
    tournament.id,
    target_user_id,
    case when profile.role = 'admin' then 'active' else 'pending' end,
    case when profile.role = 'admin' then 'admin' else 'player' end,
    case when profile.role = 'admin' then now() else null end
  from public.tournaments tournament
  join public.profiles profile on profile.id = target_user_id
  on conflict (tournament_id, user_id) do nothing;
$$;

revoke all on function public.enroll_profile_in_all_tournaments(uuid) from public, anon, authenticated;

create or replace function public.enroll_accounts_for_new_tournament()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform pg_advisory_xact_lock(202603180006);

  insert into public.tournament_memberships(
    tournament_id,
    user_id,
    status,
    role,
    joined_at
  )
  select
    new.id,
    profile.id,
    case when profile.role = 'admin' then 'active' else 'pending' end,
    case when profile.role = 'admin' then 'admin' else 'player' end,
    case when profile.role = 'admin' then now() else null end
  from public.profiles profile
  on conflict (tournament_id, user_id) do nothing;

  return new;
end;
$$;

revoke all on function public.enroll_accounts_for_new_tournament() from public, anon, authenticated;

create or replace function public.set_tournament_membership_status(
  target_tournament_id uuid,
  target_user_id uuid,
  target_status text,
  change_reason text
)
returns public.tournament_memberships
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  current_membership public.tournament_memberships%rowtype;
  updated_membership public.tournament_memberships%rowtype;
  active_admin_count integer;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if not public.is_tournament_admin(target_tournament_id) then
    raise exception 'Tournament administrator access required';
  end if;
  if target_status not in ('active', 'removed') then
    raise exception 'Membership status must be active or removed';
  end if;
  if char_length(trim(coalesce(change_reason, ''))) < 2 then
    raise exception 'A reason is required';
  end if;

  select membership.* into current_membership
  from public.tournament_memberships membership
  where membership.tournament_id = target_tournament_id
    and membership.user_id = target_user_id
  for update;

  if not found then
    raise exception 'Tournament membership not found';
  end if;

  if target_status = 'removed' and target_user_id = auth.uid() then
    raise exception 'You cannot remove your own administrator membership';
  end if;

  if target_status = 'removed'
     and current_membership.status = 'active'
     and current_membership.role = 'admin' then
    select count(*) into active_admin_count
    from public.tournament_memberships membership
    where membership.tournament_id = target_tournament_id
      and membership.role = 'admin'
      and membership.status = 'active';
    if active_admin_count <= 1 then
      raise exception 'You cannot remove the last active tournament administrator';
    end if;
  end if;

  update public.tournament_memberships membership
  set status = target_status,
      joined_at = case when target_status = 'active' then coalesce(membership.joined_at, now()) else membership.joined_at end,
      updated_at = now()
  where membership.tournament_id = target_tournament_id
    and membership.user_id = target_user_id
  returning membership.* into updated_membership;

  if current_membership.status is distinct from updated_membership.status then
    insert into public.membership_status_audit(
      tournament_id, user_id, previous_status, new_status, reason, changed_by
    ) values (
      target_tournament_id, target_user_id, current_membership.status,
      updated_membership.status, trim(change_reason), auth.uid()
    );
  end if;

  return updated_membership;
end;
$$;

revoke all on function public.set_tournament_membership_status(uuid, uuid, text, text) from public, anon;
grant execute on function public.set_tournament_membership_status(uuid, uuid, text, text) to authenticated;

-- Force membership status changes through the audited RPC. Security-definer
-- invitation and enrollment functions continue to work as their owners.
revoke insert, update, delete on public.tournament_memberships from authenticated;

-- A pending signup, not an already-approved membership, creates the admin email.
create or replace function public.enqueue_new_member_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  member_name text;
begin
  if new.status <> 'pending' then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.status = 'pending' then
    return new;
  end if;

  select coalesce(nullif(trim(profile.display_name), ''), 'A new player')
    into member_name
  from public.profiles profile
  where profile.id = new.user_id;

  perform public.enqueue_notification_job(
    new.tournament_id,
    'new_member',
    'membership',
    new.user_id,
    format('member-approval:%s:%s', new.tournament_id, new.user_id),
    'Member approval requested',
    format('%s created an account. Open the administrator portal to approve or remove this request.', member_name),
    jsonb_build_object('member_user_id', new.user_id, 'member_name', member_name),
    clock_timestamp()
  );

  return new;
end;
$$;

revoke all on function public.enqueue_new_member_notification() from public, anon, authenticated;
