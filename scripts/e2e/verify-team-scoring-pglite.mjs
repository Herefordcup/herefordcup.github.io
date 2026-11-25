import { createTeamScoringFixture } from './team-scoring-fixture.mjs';

const { db, ids, tournamentId, courseId, teeId, squads, files } = await createTeamScoringFixture();
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
