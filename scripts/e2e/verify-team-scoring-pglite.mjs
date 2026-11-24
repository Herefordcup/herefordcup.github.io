import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';

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
await db.query(`insert into public.tournaments(id, name, slug, edition_year, status, created_by)
  values ($1, 'Disposable Texas Scramble', 'disposable-texas-scramble', 2099, 'open', $2)`, [tournamentId, ids[0]]);
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
const sessionPayload = {
  tournament_id: tournamentId,
  name: 'Texas Scramble',
  session_label: 'Friday AM',
  starts_at: '2099-04-17T13:00:00Z',
  start_hole: 1,
  end_hole: 18,
  required_tee_shots: 3,
};
const savedPlan = await db.query('select public.save_texas_scramble_plan($1::jsonb, $2::jsonb) as id', [JSON.stringify(sessionPayload), JSON.stringify(squads)]);
const sessionId = savedPlan.rows[0].id;
const countRows = await db.query(`select
  (select count(*)::int from public.texas_scramble_squads where session_id = $1) squads,
  (select count(*)::int from public.texas_scramble_squad_players where session_id = $1) players`, [sessionId]);
if (countRows.rows[0].squads !== 4 || countRows.rows[0].players !== 16) throw new Error('Plan topology mismatch');

await db.query("select set_config('request.jwt.claim.sub', $1, false)", [ids[1]]);
await db.query('select public.select_texas_scramble_course_tee($1, $2, $3)', [sessionId, courseId, teeId]);
const squadRows = await db.query('select id, side from public.texas_scramble_squads where session_id = $1 order by side, squad_number', [sessionId]);
for (const squad of squads) {
  const persisted = squadRows.rows.find(row => row.side === squad.side && !row.used);
  persisted.used = true;
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [squad.player_ids[0]]);
  for (let hole = 1; hole <= 18; hole += 1) {
    await db.query('select public.submit_texas_scramble_hole($1, $2, $3, $4)', [persisted.id, hole, 4, squad.player_ids[(hole - 1) % 4]]);
  }
}
const resultRows = await db.query(`select count(*)::int finalized from public.texas_scramble_squads
  where session_id = $1 and status = 'final'`, [sessionId]);
if (resultRows.rows[0].finalized !== 4) throw new Error('Squads did not finalize');

await db.query("select set_config('request.jwt.claim.sub', $1, false)", [ids[0]]);
const firstScore = await db.query(`select score.id, score.gross_score, score.tee_shot_player_id
  from public.texas_scramble_hole_scores score join public.texas_scramble_squads squad on squad.id = score.squad_id
  where squad.session_id = $1 order by score.id limit 1`, [sessionId]);
await db.query(`select public.correct_team_score_entry('texas_scramble_hole', $1, 'PGlite correction check', $2, $3, null)`,
  [firstScore.rows[0].id, firstScore.rows[0].gross_score + 1, firstScore.rows[0].tee_shot_player_id]);

const outcomeMatchId = '20000000-0000-4000-8000-000000000001';
const outcomeSegmentId = '30000000-0000-4000-8000-000000000001';
await db.query(`insert into public.matches(id, name, session, format, scoring_mode, starts_at, status, tournament_id)
  values ($1, 'Outcome entry QA', 'Friday PM', 'singles', 'gross', '2099-04-17T19:00:00Z', 'live', $2)`, [outcomeMatchId, tournamentId]);
await db.query(`insert into public.match_segments(id, match_id, segment_number, start_hole, end_hole, format, scoring_mode,
  handicap_allowance, point_value, status, entry_mode)
  values ($1, $2, 1, 1, 18, 'singles', 'gross', null, 1, 'live', 'hole_outcomes')`, [outcomeSegmentId, outcomeMatchId]);
for (const [playingOrder, userId, side] of [[1, ids[1], 'cardinal'], [2, ids[9], 'silver']]) {
  await db.query('insert into public.match_players(match_id, user_id, team) values ($1, $2, $3)', [outcomeMatchId, userId, side]);
  await db.query(`insert into public.match_segment_players(segment_id, user_id, team, side, playing_order)
    values ($1, $2, $3, $3, $4)`, [outcomeSegmentId, userId, side, playingOrder]);
}
await db.query("select set_config('request.jwt.claim.sub', $1, false)", [ids[1]]);
for (let hole = 1; hole <= 18; hole += 1) {
  await db.query('select public.submit_match_hole_outcome($1, $2, $3)', [outcomeSegmentId, hole, hole % 2 ? 'cardinal' : 'silver']);
}
const outcomeResult = await db.query('select status, differential, holes_played from public.match_segments where id = $1', [outcomeSegmentId]);
if (outcomeResult.rows[0].status !== 'final' || outcomeResult.rows[0].differential !== 0 || outcomeResult.rows[0].holes_played !== 18) {
  throw new Error('Outcome entry did not finalize an 18-hole halve');
}
await db.query("select set_config('request.jwt.claim.sub', $1, false)", [ids[0]]);
const firstOutcome = await db.query('select id from public.match_hole_outcomes where segment_id = $1 and hole_number = 1', [outcomeSegmentId]);
await db.query(`select public.correct_team_score_entry('match_hole_outcome', $1, 'PGlite outcome correction', null, null, 'silver')`, [firstOutcome.rows[0].id]);
const correctedOutcome = await db.query('select differential from public.match_segments where id = $1', [outcomeSegmentId]);
if (correctedOutcome.rows[0].differential !== -2) throw new Error('Outcome correction did not recalculate the result');
const auditRows = await db.query('select count(*)::int count from public.team_score_correction_audit');
if (auditRows.rows[0].count !== 2) throw new Error('Correction audits missing');

await db.query(`insert into public.legacy_editions(edition_year, venue, destination, status, published)
  values (2099, 'Disposable Venue', 'Disposable Destination', 'planned', false)`);
await db.query('select public.complete_tournament_archive($1)', [tournamentId]);
const archiveRows = await db.query(`select edition.status, edition.published, count(result.id)::int result_count
  from public.legacy_editions edition left join public.legacy_results result on result.edition_id = edition.id
  where edition.edition_year = 2099 group by edition.id`);
if (archiveRows.rows[0].status !== 'completed' || !archiveRows.rows[0].published || archiveRows.rows[0].result_count !== 5) {
  throw new Error('Archive integration mismatch');
}
console.log(`Applied ${files.length} migrations and verified 4 squads, 72 shared holes, outcome entry, corrections, points, and archive in PGlite`);
await db.close();
