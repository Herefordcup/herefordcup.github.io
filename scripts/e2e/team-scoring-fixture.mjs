import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';

export async function createTeamScoringFixture({ live = false } = {}) {
  const root = new URL('../../supabase/migrations/', import.meta.url);
  const db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema if not exists extensions;
    create schema if not exists auth;
    create schema if not exists storage;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create or replace function auth.role() returns text language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon') $$;
    create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    create or replace function extensions.gen_random_uuid() returns uuid language sql volatile as $$ select pg_catalog.gen_random_uuid() $$;
    create or replace function extensions.gen_random_bytes(size integer) returns bytea language sql volatile as $$ select decode(repeat('00', size), 'hex') $$;
    create or replace function extensions.digest(value text, algorithm text) returns bytea language sql immutable as $$ select convert_to(value, 'UTF8') $$;
    create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
    create table storage.buckets (id text primary key, name text, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
    create or replace function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
  `);
  const files = (await readdir(root)).filter(name => /^\d+_.*\.sql$/.test(name)).sort();
  for (const file of files) {
    const sql = (await readFile(new URL(file, root), 'utf8')).replace(/\r/g, '')
      .replace(/create extension if not exists [a-z0-9_]+(?: with schema [a-z0-9_]+)?;/gi, '')
      .replace(",\n  exclude using gist (\n    match_id with =,\n    int4range(start_hole, end_hole, '[]') with &&\n  )", '');
    await db.exec(sql);
  }

  const ids = Array.from({ length: 17 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  for (let index = 0; index < ids.length; index += 1) {
    await db.query('insert into auth.users(id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)', [
      ids[index], `qa${index}@local.test`, JSON.stringify({ full_name: index === 0 ? 'QA Admin' : `QA Player ${index}` }),
    ]);
    await db.query('update public.profiles set handicap_index = $2 where id = $1', [ids[index], index - 4]);
  }
  await db.query("update public.profiles set role = 'admin' where id = $1", [ids[0]]);
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claim.role', 'authenticated', false)", [ids[0]]);
  const tournamentId = '10000000-0000-4000-8000-000000000001';
  await db.query(`insert into public.tournaments(id, name, slug, edition_year, starts_on, ends_on, status, created_by)
    values ($1, 'Disposable Texas Scramble', 'disposable-texas-scramble', 2099, $2, $3, $4, $5)`,
    [tournamentId, live ? '2099-04-17' : null, live ? '2099-04-18' : null, live ? 'live' : 'open', ids[0]]);
  await db.query(`update public.tournament_memberships
    set status = 'active', role = 'admin', team = 'cardinal', joined_at = now()
    where tournament_id = $1 and user_id = $2`, [tournamentId, ids[0]]);
  for (let index = 1; index <= 16; index += 1) {
    await db.query(`insert into public.tournament_memberships(tournament_id, user_id, status, role, team, joined_at)
      values ($1, $2, 'active', 'player', $3, now())
      on conflict (tournament_id, user_id) do update
      set status = excluded.status, role = excluded.role, team = excluded.team, joined_at = excluded.joined_at`, [tournamentId, ids[index], index <= 8 ? 'cardinal' : 'silver']);
  }
  const teeRows = await db.query(`select tee.id as tee_id, tee.course_id
    from public.tees tee join public.courses course on course.id = tee.course_id
    join public.holes hole on hole.tee_id = tee.id
    where course.active and tee.rating_category in ('M', 'U') and tee.rating is not null and tee.slope is not null
    group by tee.id having count(*) = 18 order by tee.name limit 1`);
  if (!teeRows.rows.length) throw new Error('No complete rated tee fixture');
  const { tee_id: teeId, course_id: courseId } = teeRows.rows[0];
  const squads = [
    { label: 'Blue A', side: 'cardinal', squad_number: 1, player_ids: ids.slice(1, 5) },
    { label: 'Blue B', side: 'cardinal', squad_number: 2, player_ids: ids.slice(5, 9) },
    { label: 'White A', side: 'silver', squad_number: 1, player_ids: ids.slice(9, 13) },
    { label: 'White B', side: 'silver', squad_number: 2, player_ids: ids.slice(13, 17) },
  ];
  return { db, ids, tournamentId, courseId, teeId, squads, files };
}
