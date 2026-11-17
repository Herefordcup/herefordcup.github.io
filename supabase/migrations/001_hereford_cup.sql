-- Hereford Cup database schema for Supabase
-- Run this entire migration in the Supabase SQL editor.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  handicap_index numeric(4,1) not null default 0 check (handicap_index between -10 and 54),
  role text not null default 'player' check (role in ('player','admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  location text,
  active boolean not null default true,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

create table if not exists public.tees (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  name text not null,
  rating numeric(4,1) not null,
  slope integer not null check (slope between 55 and 155),
  par integer not null check (par between 54 and 90),
  yardage integer check (yardage between 3000 and 9000),
  unique(course_id, name)
);

create table if not exists public.holes (
  id uuid primary key default gen_random_uuid(),
  tee_id uuid not null references public.tees(id) on delete cascade,
  hole_number integer not null check (hole_number between 1 and 18),
  par integer not null check (par between 3 and 6),
  stroke_index integer not null check (stroke_index between 1 and 18),
  yardage integer check (yardage between 50 and 750),
  unique(tee_id, hole_number),
  unique(tee_id, stroke_index)
);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  session text not null,
  format text not null check (format in ('singles','fourball','foursomes')),
  scoring_mode text not null check (scoring_mode in ('gross','net')),
  starts_at timestamptz,
  course_id uuid references public.courses(id),
  status text not null default 'scheduled' check (status in ('scheduled','live','final')),
  created_at timestamptz not null default now()
);

create table if not exists public.match_players (
  match_id uuid not null references public.matches(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  team text not null check (team in ('cardinal','silver')),
  primary key(match_id, user_id)
);

create table if not exists public.rounds (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  match_id uuid references public.matches(id) on delete cascade,
  course_id uuid not null references public.courses(id),
  tee_id uuid not null references public.tees(id),
  course_handicap integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists one_tournament_round_per_player
  on public.rounds(user_id, match_id) where match_id is not null;

create table if not exists public.scores (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  hole_number integer not null check (hole_number between 1 and 18),
  gross_score integer not null check (gross_score between 1 and 15),
  updated_at timestamptz not null default now(),
  unique(round_id, hole_number)
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, display_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    new.raw_user_meta_data ->> 'avatar_url'
  ) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

create or replace function public.prevent_role_escalation()
returns trigger language plpgsql security definer set search_path = public as $$
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

drop trigger if exists protect_profile_role on public.profiles;
create trigger protect_profile_role before update on public.profiles
for each row execute procedure public.prevent_role_escalation();

grant execute on function public.is_admin() to authenticated;

alter table public.profiles enable row level security;
alter table public.courses enable row level security;
alter table public.tees enable row level security;
alter table public.holes enable row level security;
alter table public.matches enable row level security;
alter table public.match_players enable row level security;
alter table public.rounds enable row level security;
alter table public.scores enable row level security;

create policy "authenticated profiles are visible" on public.profiles for select to authenticated using (true);
create policy "players update their own profile" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy "admins manage profiles" on public.profiles for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "players view courses" on public.courses for select to authenticated using (true);
create policy "admins manage courses" on public.courses for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "players view tees" on public.tees for select to authenticated using (true);
create policy "admins manage tees" on public.tees for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "players view holes" on public.holes for select to authenticated using (true);
create policy "admins manage holes" on public.holes for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "players view matches" on public.matches for select to authenticated using (true);
create policy "admins manage matches" on public.matches for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "players view pairings" on public.match_players for select to authenticated using (true);
create policy "admins manage pairings" on public.match_players for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "players view tournament rounds" on public.rounds for select to authenticated using (true);
create policy "players create their round" on public.rounds for insert to authenticated with check (user_id = auth.uid());
create policy "players update their round" on public.rounds for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "admins manage rounds" on public.rounds for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "players view tournament scores" on public.scores for select to authenticated using (true);
create policy "players create their scores" on public.scores for insert to authenticated with check (user_id = auth.uid());
create policy "players update their scores" on public.scores for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "admins manage scores" on public.scores for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;

-- After your first account sign-in, promote yourself once in the SQL editor:
-- update public.profiles set role = 'admin' where id = '<your auth user id>';
