-- Give every registered Hereford Cup account access to every tournament.
-- Team assignments and tournament-specific roles remain editable per membership.
-- Apply after 005_integrity_hardening.sql.

-- Supabase applies each migration transactionally. These locks wait for any
-- in-flight signup/tournament creation and block new ones until the trigger
-- replacement and backfill commit, closing the deployment-time race.
lock table auth.users in share row exclusive mode;
lock table public.tournaments in share row exclusive mode;

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
    'active',
    case when profile.role = 'admin' then 'admin' else 'player' end,
    now()
  from public.tournaments tournament
  join public.profiles profile on profile.id = target_user_id
  on conflict (tournament_id, user_id) do nothing;
$$;

revoke all on function public.enroll_profile_in_all_tournaments(uuid) from public;
revoke all on function public.enroll_profile_in_all_tournaments(uuid) from anon;
revoke all on function public.enroll_profile_in_all_tournaments(uuid) from authenticated;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  insert into public.profiles(id, display_name, avatar_url)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    ),
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;

  perform public.enroll_profile_in_all_tournaments(new.id);
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon;
revoke all on function public.handle_new_user() from authenticated;

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
    'active',
    case when profile.role = 'admin' then 'admin' else 'player' end,
    now()
  from public.profiles profile
  on conflict (tournament_id, user_id) do nothing;

  return new;
end;
$$;

revoke all on function public.enroll_accounts_for_new_tournament() from public;
revoke all on function public.enroll_accounts_for_new_tournament() from anon;
revoke all on function public.enroll_accounts_for_new_tournament() from authenticated;

drop trigger if exists enroll_accounts_for_new_tournament on public.tournaments;
create trigger enroll_accounts_for_new_tournament
after insert on public.tournaments
for each row execute procedure public.enroll_accounts_for_new_tournament();

-- Serialize the backfill with account and tournament creation so no pair can
-- be missed by two concurrent transactions.
select pg_advisory_xact_lock(202603180006);

-- Accounts that were waiting under the old approval model become active.
-- Explicitly removed memberships stay removed.
update public.tournament_memberships
set
  status = 'active',
  joined_at = coalesce(joined_at, now()),
  updated_at = now()
where status = 'pending';

-- Backfill every missing account/tournament combination without reactivating a
-- membership that an administrator explicitly removed.
insert into public.tournament_memberships(
  tournament_id,
  user_id,
  status,
  role,
  joined_at
)
select
  tournament.id,
  profile.id,
  'active',
  case when profile.role = 'admin' then 'admin' else 'player' end,
  now()
from public.profiles profile
cross join public.tournaments tournament
on conflict (tournament_id, user_id) do nothing;
