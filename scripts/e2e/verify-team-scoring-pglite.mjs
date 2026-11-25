import assert from 'node:assert/strict';
import { createTeamScoringFixture } from './team-scoring-fixture.mjs';

const { db, ids, tournamentId, courseId, teeId, squads, files } = await createTeamScoringFixture({ live: true });
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
const organizerId = ids[2]; // Tournament organizer, not a global admin or the outcome submitter.
await db.query("select public.set_tournament_member_role($1, $2, 'admin')", [tournamentId, organizerId]);
async function one(sql, params = []) {
  const { rows } = await db.query(sql, params);
  assert.equal(rows.length, 1);
  return rows[0];
}
async function correct(type, id, reason, { winner = null, gross = null, driver = null }) {
  return db.transaction(async tx => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [organizerId]);
    const { rows: [{ entry }] } = await tx.query('select public.correct_team_score_entry($1, $2, $3, $4, $5, $6) as entry',
      [type, id, reason, gross, driver, winner]);
    const { rows: [{ locked }] } = await tx.query(`select exists (select 1 from pg_locks
      where pid = pg_backend_pid() and locktype = 'advisory' and granted and mode = 'ExclusiveLock' and objsubid = 1
        and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1::text, 0)) as locked`, [tournamentId]);
    assert.equal(locked, true, 'Correction must hold the same tournament lock as archive completion until commit');
    return entry;
  });
}
async function cupTotals() {
  const { preview } = await one('select public.get_public_tournament_preview() as preview');
  assert.equal(preview.tournament.editionYear, 2099);
  return { blue: preview.totals.blue, white: preview.totals.white };
}
async function correctionState(matchId) {
  return one(`select to_jsonb(m) as match,
    (select jsonb_agg(s order by s.id) from public.match_segments s where s.match_id = m.id) as segments,
    (select jsonb_agg(o order by o.id) from public.match_hole_outcomes o join public.match_segments s on s.id = o.segment_id
      where s.match_id = m.id) as outcomes,
    (select jsonb_agg(q order by q.id) from public.texas_scramble_squads q where q.match_id = m.id) as squads,
    (select jsonb_agg(h order by h.id) from public.texas_scramble_hole_scores h join public.texas_scramble_squads q on q.id = h.squad_id
      where q.match_id = m.id) as shared_holes,
    (select jsonb_agg(a order by a.event_sequence) from public.team_score_correction_audit a where a.match_id = m.id) as corrections,
    (select jsonb_agg(a order by a.event_sequence) from public.match_result_audit a where a.match_id = m.id) as results
    from public.matches m where m.id = $1`, [matchId]);
}
async function checkAudit(type, matchId, reason, before, after) {
  assert.deepEqual(await one(`select before_value, after_value, reason, corrected_by, match_id
    from public.team_score_correction_audit where target_type = $1 and target_id = $2`, [type, before.id]),
    { before_value: before, after_value: after, reason, corrected_by: organizerId, match_id: matchId });
}

assert.deepEqual((await db.query(`select name from (values ('public.texas_scramble_hole_scores'), ('public.match_hole_outcomes'),
  ('public.team_score_correction_audit')) targets(name) where has_table_privilege('authenticated', name, 'UPDATE,DELETE')`)).rows, []);
const { entry: shared, match_id: sharedMatch } = await one(`select to_jsonb(score) as entry, squad.match_id
  from public.texas_scramble_hole_scores score join public.texas_scramble_squads squad on squad.id = score.squad_id
  where squad.session_id = $1 and squad.side = 'silver' and squad.squad_number = 2 and score.hole_number = 3`, [sessionId]);
const originalSquad = await correctionState(sharedMatch);
const originalCup = await cupTotals();
const drivers = squads[3].player_ids;
const scrambleReason = 'Verified strokes and selected tee shot';
const savedShared = await correct('texas_scramble_hole', shared.id, scrambleReason, { gross: 3, driver: drivers[0] });
const savedSquad = await correctionState(sharedMatch);
assert.deepEqual(savedShared, { ...shared, gross_score: 3, tee_shot_player_id: drivers[0], updated_at: savedShared.updated_at });
assert.deepEqual(savedSquad.shared_holes.find(hole => hole.id === shared.id), savedShared);
assert.deepEqual(savedSquad.match, originalSquad.match, 'Do not write the already-final match');
assert.deepEqual(drivers.map(id => savedSquad.shared_holes.filter(hole => hole.tee_shot_player_id === id).length), [6, 5, 3, 4]);
const oldSquad = originalSquad.squads[0];
const gross = 17 * 4 + 3;
const net = gross - oldSquad.playing_handicap;
const points = Math.max(0, oldSquad.par_total - net);
assert.deepEqual([savedSquad.squads[0].gross_total, savedSquad.squads[0].net_score, savedSquad.squads[0].points,
  savedSquad.segments[0].point_value, savedSquad.segments[0].differential], [gross, net, points, points, -1]);
assert.equal(points, oldSquad.points + 1);
assert.deepEqual(await cupTotals(), { blue: originalCup.blue, white: originalCup.white + 1 });
await checkAudit('texas_scramble_hole', sharedMatch, scrambleReason, shared, savedShared);
const nextDrive = savedSquad.shared_holes.find(hole => hole.hole_number === 7);
await assert.rejects(correct('texas_scramble_hole', nextDrive.id, 'Review second tee shot', { gross: 5, driver: drivers[0] }),
  /would violate the required tee shot minimum/);
assert.deepEqual(await correctionState(sharedMatch), savedSquad, 'Losing a required contribution must roll back score, results and audit');
assert.deepEqual(await cupTotals(), { blue: originalCup.blue, white: originalCup.white + 1 });

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
const { entry: submitted } = await one("select public.submit_match_hole_outcome($1, 1, 'silver')->'outcome' as entry", [outcomeSegmentId]);
const beforeLiveCorrection = await cupTotals();
const reason = 'Organizer verified the winner of hole 1';
const corrected = await correct('match_hole_outcome', submitted.id, reason, { winner: 'cardinal' });
assert.deepEqual(corrected, { ...submitted, winner: 'cardinal', updated_at: corrected.updated_at });
assert.deepEqual(await one('select to_jsonb(o) as entry from public.match_hole_outcomes o where id = $1', [submitted.id]), { entry: corrected });
await checkAudit('match_hole_outcome', outcomeMatchId, reason, submitted, corrected);
assert.deepEqual(await one(`select s.status as segment, m.status as match from public.match_segments s
  join public.matches m on m.id = s.match_id where s.id = $1`, [outcomeSegmentId]), { segment: 'live', match: 'live' });
assert.deepEqual(await cupTotals(), beforeLiveCorrection, 'An undecided hole must not award Cup points');
for (let hole = 2; hole <= 18; hole += 1) {
  await db.query('select public.submit_match_hole_outcome($1, $2, $3)', [outcomeSegmentId, hole, hole % 2 ? 'cardinal' : 'silver']);
}
const outcomeResult = await db.query('select status, differential, holes_played from public.match_segments where id = $1', [outcomeSegmentId]);
if (outcomeResult.rows[0].status !== 'final' || outcomeResult.rows[0].differential !== 0 || outcomeResult.rows[0].holes_played !== 18) {
  throw new Error('Outcome entry did not finalize an 18-hole halve');
}
assert.deepEqual(await cupTotals(), { blue: beforeLiveCorrection.blue + 0.5, white: beforeLiveCorrection.white + 0.5 });
await db.query("select set_config('request.jwt.claim.sub', $1, false)", [ids[0]]);
const firstOutcome = await db.query('select id from public.match_hole_outcomes where segment_id = $1 and hole_number = 1', [outcomeSegmentId]);
await db.query(`select public.correct_team_score_entry('match_hole_outcome', $1, 'PGlite outcome correction', null, null, 'silver')`, [firstOutcome.rows[0].id]);
const correctedOutcome = await db.query('select differential from public.match_segments where id = $1', [outcomeSegmentId]);
if (correctedOutcome.rows[0].differential !== -2) throw new Error('Outcome correction did not recalculate the result');
assert.deepEqual(await cupTotals(), { blue: beforeLiveCorrection.blue, white: beforeLiveCorrection.white + 1 });
const auditRows = await db.query('select count(*)::int count from public.team_score_correction_audit');
if (auditRows.rows[0].count !== 3) throw new Error('Correction audits missing');

// Two nine-hole segments: a correction may clinch its own segment, not its live sibling.
const { id: splitMatch } = await one(`insert into public.matches(name, session, format, scoring_mode, starts_at, status, tournament_id)
  values ('Correction closure QA', 'Saturday AM', 'singles', 'gross', '2099-04-18T13:00:00Z', 'live', $1) returning id`, [tournamentId]);
await db.query(`insert into public.match_players(match_id, user_id, team)
  select $1, user_id, team from public.match_players where match_id = $2`, [splitMatch, outcomeMatchId]);
const splitTotals = await cupTotals();
const segments = [];
for (const [number, start] of [[1, 1], [2, 10]]) {
  const { id } = await one(`insert into public.match_segments(match_id, segment_number, start_hole, end_hole, format, scoring_mode, status, entry_mode)
    values ($1, $2, $3, $4, 'singles', 'gross', 'live', 'hole_outcomes') returning id`, [splitMatch, number, start, start + 8]);
  await db.query(`insert into public.match_segment_players(segment_id, user_id, team, side, playing_order)
    select $1, user_id, team, side, playing_order from public.match_segment_players where segment_id = $2`, [id, outcomeSegmentId]);
  segments.push({ id, number, start });
}
await db.query("select set_config('request.jwt.claim.sub', $1, false)", [ids[1]]);
for (const { id, number, start } of segments) {
  const outcomes = [];
  for (const winner of ['silver', 'cardinal', 'cardinal', 'silver', 'cardinal', 'cardinal']) {
    const { result } = await one('select public.submit_match_hole_outcome($1, $2, $3) as result', [id, start + outcomes.length, winner]);
    assert.equal(result.finalized, false);
    outcomes.push(result.outcome);
  }
  // Three up with three remaining is not a win, even when a correction creates that lead.
  const beforeClinch = await cupTotals();
  await correct('match_hole_outcome', outcomes[3].id, 'Verified the fourth hole was halved', { winner: 'halved' });
  assert.equal((await one('select status from public.match_segments where id = $1', [id])).status, 'live');
  assert.deepEqual(await cupTotals(), beforeClinch);
  await correct('match_hole_outcome', outcomes[0].id, 'Verified first hole against the card', { winner: 'cardinal' });
  assert.deepEqual(await one(`select s.status, s.differential, s.holes_played, m.status as match_status from public.match_segments s
    join public.matches m on m.id = s.match_id where s.id = $1`, [id]),
    { status: 'final', differential: 5, holes_played: 6, match_status: number === 1 ? 'live' : 'final' });
  assert.deepEqual(await cupTotals(), { blue: splitTotals.blue + number, white: splitTotals.white });

  // Changing 5 & 3 to 4 & 3 is valid, even when the whole match is already final.
  await correct('match_hole_outcome', outcomes[1].id, 'Verified a halved hole', { winner: 'halved' });
  const locked = await correctionState(splitMatch);
  const segment = locked.segments.find(row => row.id === id);
  assert.deepEqual([segment.status, segment.differential, segment.holes_played], ['final', 4, 6]);
  const result = locked.results.at(-1);
  assert.deepEqual([result.segment_id, result.action, result.change_reason, result.changed_by], [id, 'recalculated', 'Verified a halved hole', organizerId]);
  // The same immutable-segment policy applies before and after the sibling finishes.
  await assert.rejects(correct('match_hole_outcome', outcomes[0].id, 'Review early finish', { winner: 'halved' }),
    { message: 'Correction would reopen the finalized segment; its result must remain mathematically decided' });
  assert.deepEqual(await correctionState(splitMatch), locked, 'No partial score, result, or audit may survive');
  assert.deepEqual(await cupTotals(), { blue: splitTotals.blue + number, white: splitTotals.white });
}
await db.query("select set_config('request.jwt.claim.sub', $1, false)", [ids[0]]);
await db.query(`insert into public.legacy_editions(edition_year, venue, destination, status, published)
  values (2099, 'Disposable Venue', 'Disposable Destination', 'planned', false)`);
const cupAtCompletion = await cupTotals();
await db.query('select public.complete_tournament_archive($1)', [tournamentId]);
const archiveRows = await db.query(`select edition.status, edition.published, count(result.id)::int result_count,
    edition.cardinal_total::float8 as blue, edition.silver_total::float8 as white
  from public.legacy_editions edition left join public.legacy_results result on result.edition_id = edition.id
  where edition.edition_year = 2099 group by edition.id`);
if (archiveRows.rows[0].status !== 'completed' || !archiveRows.rows[0].published || archiveRows.rows[0].result_count !== 7) {
  throw new Error('Archive integration mismatch');
}
assert.deepEqual({ blue: archiveRows.rows[0].blue, white: archiveRows.rows[0].white }, cupAtCompletion);
for (const status of ['complete', 'archived']) {
  if (status === 'archived') await db.query("update public.tournaments set status = 'archived' where id = $1", [tournamentId]);
  assert.equal((await one('select status from public.tournaments where id = $1', [tournamentId])).status, status);
  for (const [type, id, match, replacement] of [
    ['match_hole_outcome', submitted.id, outcomeMatchId, { winner: 'cardinal' }],
    ['texas_scramble_hole', shared.id, sharedMatch, { gross: shared.gross_score, driver: shared.tee_shot_player_id }],
  ]) {
    const before = await correctionState(match);
    await assert.rejects(correct(type, id, 'Review after publication', replacement), /cannot correct team scores.*completed or archived tournament/i);
    assert.deepEqual(await correctionState(match), before);
  }
  // Completion replay independently reconciles every generated result and both published Cup totals.
  if (status === 'complete') await db.query('select public.complete_tournament_archive($1)', [tournamentId]);
}
console.log(`Applied ${files.length} migrations and verified 4 squads, 72 shared holes, outcome entry, corrections, points, and archive in PGlite`);
await db.close();
