import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

// An in-memory database only. Supply the Supabase-owned objects, then run the
// repository's migration files verbatim, including the hole-range exclusion.
export async function createMixedEntryFixture({ throughMigration = Infinity } = {}) {
  const db = new PGlite({ extensions: { btree_gist, pgcrypto } });
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema extensions; create schema auth; create schema storage;
      grant usage on schema auth to authenticated;
      alter default privileges in schema public grant select on tables to authenticated;
      create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      create function auth.role() returns text language sql stable as $$ select current_setting('request.jwt.claim.role', true) $$;
      create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
      create table storage.objects (id uuid primary key, bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz, updated_at timestamptz);
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
    `);
    const root = new URL('../../supabase/migrations/', import.meta.url);
    for (const file of (await readdir(root)).filter(name => /^\d+_.*\.sql$/.test(name)).sort()) {
      if (parseInt(file, 10) > throughMigration) break;
      await db.exec(await readFile(new URL(file, root), 'utf8'));
    }
    const [admin, blue, white, bluePartner, whitePartner] = Array.from({ length: 5 }, () => randomUUID());
    const tournament = randomUUID();
    for (const [i, user] of [admin, blue, white, bluePartner, whitePartner].entries()) {
      await db.query('insert into auth.users(id,email) values($1,$2)', [user, `mixed-${i}@local.test`]);
    }
    await db.query("update public.profiles set role = 'admin' where id = $1", [admin]);
    await db.query(`insert into public.tournaments(id,name,slug,edition_year,status,created_by)
      values($1,'Mixed entry fixture','mixed-entry-fixture',2099,'open',$2)`, [tournament, admin]);
    const players = [blue, white, bluePartner, whitePartner].map((user_id, i) => {
      const side = i % 2 ? 'silver' : 'cardinal';
      return { user_id, side, team: side, playing_order: i + 1 };
    });
    for (const p of players) {
      await db.query(`insert into public.tournament_memberships(tournament_id,user_id,status,role,team)
        values ($1,$2,'active','player',$3) on conflict (tournament_id,user_id)
        do update set status='active',role='player',team=excluded.team`, [tournament, p.user_id, p.team]);
    }
    const { rows: [course] } = await db.query("insert into public.courses(name,created_by) values ('Fixture links',$1) returning *", [admin]);
    const { rows: [tee, alternate] } = await db.query(`insert into public.tees(course_id,name,rating_category,rating,slope,rating_par,par,yardage)
      values ($1,'Fixture tee','M',72,113,72,72,6300), ($1,'Alternate tee','M',72,113,72,72,6300) returning *`, [course.id]);
    await db.query(`insert into public.holes(tee_id,hole_number,par,stroke_index,yardage)
      select $1::uuid,n,4,n,350 from generate_series(1,18) n union all
      select $2::uuid,n,4,19-n,350 from generate_series(1,18) n`, [tee.id, alternate.id]);
    // Keep each normal player operation in its own authenticated transaction.
    const as = (user, sql, params = []) => db.transaction(async tx => {
      await tx.exec('set local role authenticated');
      await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role','authenticated',true)", [user]);
      return (await tx.query(sql, params)).rows;
    });
    const plan = async ({ outcomeFormat = 'fourball', backMode = 'hole_outcomes', frontScoring = 'gross' } = {}) => {
      const front = { segment_number: 1, start_hole: 1, end_hole: 9, format: 'singles', scoring_mode: frontScoring, handicap_allowance: frontScoring === 'net' ? 100 : null,
        entry_mode: 'individual_scores', point_value: 1, players: players.slice(0, 2) };
      const back = { segment_number: 2, start_hole: 10, end_hole: 18, format: outcomeFormat, scoring_mode: 'net',
        handicap_allowance: 100, entry_mode: backMode, point_value: 2, players: outcomeFormat === 'singles' ? players.slice(0, 2) : players };
      const [{ id }] = await as(admin, 'select public.save_match_plan_with_entry_modes($1,$2) as id', [
        JSON.stringify({ tournament_id: tournament, course_id: tee.course_id, name: 'Mixed entry', session: 'Morning', starts_at: '2099-03-20T10:00:00Z' }),
        JSON.stringify([front, back]),
      ]);
      const { rows: [individual, outcome] } = await db.query('select * from public.match_segments where match_id=$1 order by segment_number', [id]);
      return { id, individual, outcome };
    };
    const openRound = async (user, match, teeId = tee.id, handicap = 0) => (await as(user, `insert into public.rounds(user_id,match_id,course_id,tee_id,course_handicap)
      values($1,$2,$3,$4,$5) returning id`, [user, match, tee.course_id, teeId, handicap]))[0].id;
    const saveScores = (user, round, scores) => as(user, `insert into public.scores(user_id,round_id,hole_number,gross_score)
      select $1,$2,s.hole_number,s.gross_score from jsonb_to_recordset($3::jsonb) s(hole_number int,gross_score int)`, [user, round, JSON.stringify(scores)]);
    const complete = async (user, match) => (await as(user, 'select public.complete_match_if_ready($1) as result', [match]))[0].result;
    const saveOutcome = async (user, segment, hole, winner) => (await as(user,
      'select public.submit_match_hole_outcome($1,$2,$3) as result', [segment, hole, winner]))[0].result;
    return { db, as, admin, blue, white, bluePartner, whitePartner, tournament, tee, alternate, players, plan, openRound, saveScores, complete, saveOutcome };
  } catch (error) {
    await db.close();
    throw error;
  }
}
