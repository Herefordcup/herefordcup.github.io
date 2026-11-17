-- Separate authenticated accounts from private Hereford Cup tournament access.
-- Apply after 001_hereford_cup.sql.

create table if not exists public.tournaments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  edition_year integer not null check (edition_year between 2000 and 2200),
  starts_on date,
  ends_on date,
  status text not null default 'setup' check (status in ('setup', 'open', 'live', 'complete', 'archived')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on is null or starts_on is null or ends_on >= starts_on)
);

create table if not exists public.tournament_memberships (
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'active', 'removed')),
  role text not null default 'player' check (role in ('player', 'captain', 'admin')),
  team text check (team in ('cardinal', 'silver')),
  invited_by uuid references public.profiles(id),
  joined_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tournament_id, user_id)
);

create table if not exists public.tournament_invitations (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments(id) on delete cascade,
  email text not null check (email = lower(trim(email))),
  token_hash text not null unique,
  role text not null default 'player' check (role in ('player', 'captain', 'admin')),
  team text check (team in ('cardinal', 'silver')),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null default (now() + interval '14 days'),
  invited_by uuid not null references public.profiles(id),
  accepted_by uuid references public.profiles(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists one_open_invitation_per_email
  on public.tournament_invitations(tournament_id, email)
  where status = 'pending';

alter table public.matches
  add column if not exists tournament_id uuid references public.tournaments(id) on delete cascade;

create index if not exists matches_tournament_id_idx on public.matches(tournament_id);
create index if not exists memberships_user_id_idx on public.tournament_memberships(user_id, status);

-- Replace the original role guard. SECURITY DEFINER changes SQL execution
-- identity, so authorization must use the invoker's session/JWT identity.
create or replace function public.prevent_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.role is distinct from new.role
     and session_user not in ('postgres', 'supabase_admin')
     and coalesce(auth.role(), '') <> 'service_role'
     and not public.is_admin() then
    raise exception 'Only an administrator can change roles';
  end if;
  return new;
end;
$$;

create or replace function public.has_tournament_access(target_tournament_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tournament_memberships membership
    where membership.tournament_id = target_tournament_id
      and membership.user_id = auth.uid()
      and membership.status = 'active'
  );
$$;

create or replace function public.has_any_tournament_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tournament_memberships membership
    where membership.user_id = auth.uid()
      and membership.status = 'active'
  );
$$;

create or replace function public.shares_active_tournament(other_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.tournament_memberships mine
    join public.tournament_memberships theirs
      on theirs.tournament_id = mine.tournament_id
    where mine.user_id = auth.uid()
      and mine.status = 'active'
      and theirs.user_id = other_user_id
      and theirs.status = 'active'
  );
$$;

create or replace function public.can_create_round(target_user_id uuid, target_match_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_user_id = auth.uid()
    and (
      (target_match_id is null and public.has_any_tournament_access())
      or exists (
        select 1
        from public.matches match_record
        join public.match_players assignment
          on assignment.match_id = match_record.id
        where match_record.id = target_match_id
          and assignment.user_id = auth.uid()
          and public.has_tournament_access(match_record.tournament_id)
      )
    );
$$;

create or replace function public.can_write_round(target_round_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.rounds round_record
    where round_record.id = target_round_id
      and public.can_create_round(round_record.user_id, round_record.match_id)
  );
$$;

create or replace function public.can_write_score(target_round_id uuid, target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select target_user_id = auth.uid()
    and public.can_write_round(target_round_id);
$$;

create or replace function public.create_tournament_invitation(
  target_tournament_id uuid,
  target_email text,
  target_role text default 'player',
  target_team text default null
)
returns table(invitation_id uuid, invite_token text)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_email text := lower(trim(target_email));
  raw_token text := encode(extensions.gen_random_bytes(24), 'hex');
  new_id uuid;
  inviter_role text;
  global_admin boolean := public.is_admin();
begin
  if not global_admin then
    select membership.role into inviter_role
    from public.tournament_memberships membership
    where membership.tournament_id = target_tournament_id
      and membership.user_id = auth.uid()
      and membership.status = 'active';

    if inviter_role is null or inviter_role not in ('admin', 'captain') then
      raise exception 'Tournament administrator access required';
    end if;

    if inviter_role = 'captain' and target_role <> 'player' then
      raise exception 'Captains may invite players only';
    end if;
  end if;

  if normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+[.][^@[:space:]]+$' then
    raise exception 'A valid email address is required';
  end if;

  if target_role not in ('player', 'captain', 'admin') then
    raise exception 'Invalid tournament role';
  end if;

  if target_team is not null and target_team not in ('cardinal', 'silver') then
    raise exception 'Invalid team';
  end if;

  insert into public.tournament_invitations(
    tournament_id, email, token_hash, role, team, invited_by
  ) values (
    target_tournament_id,
    normalized_email,
    encode(extensions.digest(raw_token, 'sha256'), 'hex'),
    target_role,
    target_team,
    auth.uid()
  )
  returning id into new_id;

  return query select new_id, raw_token;
end;
$$;

create or replace function public.claim_tournament_invitation(invite_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  invitation public.tournament_invitations%rowtype;
  signed_in_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if auth.uid() is null then
    raise exception 'Sign in before accepting an invitation';
  end if;

  select * into invitation
  from public.tournament_invitations
  where token_hash = encode(extensions.digest(invite_token, 'sha256'), 'hex')
  for update;

  if invitation.id is null
     or invitation.status <> 'pending'
     or invitation.expires_at <= now() then
    raise exception 'This invitation is invalid or has expired';
  end if;

  if invitation.email <> signed_in_email then
    raise exception 'Sign in with the email address that received this invitation';
  end if;

  insert into public.tournament_memberships(
    tournament_id, user_id, status, role, team, invited_by, joined_at
  ) values (
    invitation.tournament_id,
    auth.uid(),
    'active',
    invitation.role,
    invitation.team,
    invitation.invited_by,
    now()
  )
  on conflict (tournament_id, user_id) do update set
    status = 'active',
    role = excluded.role,
    team = excluded.team,
    invited_by = excluded.invited_by,
    joined_at = coalesce(public.tournament_memberships.joined_at, now()),
    updated_at = now();

  update public.tournament_invitations set
    status = 'accepted',
    accepted_by = auth.uid(),
    accepted_at = now()
  where id = invitation.id;

  return invitation.tournament_id;
end;
$$;

revoke all on function public.can_create_round(uuid, uuid) from public;
revoke all on function public.can_write_round(uuid) from public;
revoke all on function public.can_write_score(uuid, uuid) from public;
revoke all on function public.create_tournament_invitation(uuid, text, text, text) from public;
revoke all on function public.claim_tournament_invitation(text) from public;
grant execute on function public.has_tournament_access(uuid) to authenticated;
grant execute on function public.has_any_tournament_access() to authenticated;
grant execute on function public.shares_active_tournament(uuid) to authenticated;
grant execute on function public.can_create_round(uuid, uuid) to authenticated;
grant execute on function public.can_write_round(uuid) to authenticated;
grant execute on function public.can_write_score(uuid, uuid) to authenticated;
grant execute on function public.create_tournament_invitation(uuid, text, text, text) to authenticated;
grant execute on function public.claim_tournament_invitation(text) to authenticated;

alter table public.tournaments enable row level security;
alter table public.tournament_memberships enable row level security;
alter table public.tournament_invitations enable row level security;

create policy "members view their tournaments" on public.tournaments
  for select to authenticated
  using (public.is_admin() or public.has_tournament_access(id));
create policy "global admins manage tournaments" on public.tournaments
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "members view tournament rosters" on public.tournament_memberships
  for select to authenticated
  using (
    public.is_admin()
    or user_id = auth.uid()
    or public.has_tournament_access(tournament_id)
  );
create policy "global admins manage tournament memberships" on public.tournament_memberships
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy "players view their invitations" on public.tournament_invitations
  for select to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')));
create policy "global admins manage tournament invitations" on public.tournament_invitations
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Remove the original broad read policies. Authenticated but unapproved accounts
-- keep access only to their own profile until membership becomes active.
drop policy if exists "authenticated profiles are visible" on public.profiles;
create policy "players view permitted profiles" on public.profiles
  for select to authenticated
  using (id = auth.uid() or public.is_admin() or public.shares_active_tournament(id));

drop policy if exists "players view courses" on public.courses;
create policy "approved players view courses" on public.courses
  for select to authenticated using (public.is_admin() or public.has_any_tournament_access());

drop policy if exists "players view tees" on public.tees;
create policy "approved players view tees" on public.tees
  for select to authenticated using (public.is_admin() or public.has_any_tournament_access());

drop policy if exists "players view holes" on public.holes;
create policy "approved players view holes" on public.holes
  for select to authenticated using (public.is_admin() or public.has_any_tournament_access());

drop policy if exists "players view matches" on public.matches;
create policy "members view tournament matches" on public.matches
  for select to authenticated
  using (public.is_admin() or public.has_tournament_access(tournament_id));

drop policy if exists "players view pairings" on public.match_players;
create policy "members view tournament pairings" on public.match_players
  for select to authenticated
  using (
    public.is_admin()
    or exists (
      select 1 from public.matches match_record
      where match_record.id = match_id
        and public.has_tournament_access(match_record.tournament_id)
    )
  );

drop policy if exists "players view tournament rounds" on public.rounds;
create policy "members view tournament rounds" on public.rounds
  for select to authenticated
  using (
    public.is_admin()
    or user_id = auth.uid()
    or exists (
      select 1 from public.matches match_record
      where match_record.id = match_id
        and public.has_tournament_access(match_record.tournament_id)
    )
  );

drop policy if exists "players create their round" on public.rounds;
create policy "members create their round" on public.rounds
  for insert to authenticated
  with check (public.can_create_round(user_id, match_id));

drop policy if exists "players update their round" on public.rounds;
create policy "members update their round" on public.rounds
  for update to authenticated
  using (public.can_write_round(id))
  with check (public.can_create_round(user_id, match_id));

drop policy if exists "players view tournament scores" on public.scores;
create policy "members view tournament scores" on public.scores
  for select to authenticated
  using (
    public.is_admin()
    or user_id = auth.uid()
    or exists (
      select 1
      from public.rounds round_record
      join public.matches match_record on match_record.id = round_record.match_id
      where round_record.id = round_id
        and public.has_tournament_access(match_record.tournament_id)
    )
  );

drop policy if exists "players create their scores" on public.scores;
create policy "members create their scores" on public.scores
  for insert to authenticated
  with check (public.can_write_score(round_id, user_id));

drop policy if exists "players update their scores" on public.scores;
create policy "members update their scores" on public.scores
  for update to authenticated
  using (public.can_write_score(round_id, user_id))
  with check (public.can_write_score(round_id, user_id));

grant select on public.tournaments, public.tournament_memberships, public.tournament_invitations to authenticated;
grant insert, update, delete on public.tournaments, public.tournament_memberships, public.tournament_invitations to authenticated;
