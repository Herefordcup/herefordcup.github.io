import { readFile } from 'node:fs/promises';
import { assertDisposableSupabaseUrl } from './safety.mjs';

const apiUrl = assertDisposableSupabaseUrl(process.env.E2E_SUPABASE_URL);
const publishableKey = process.env.E2E_SUPABASE_PUBLISHABLE_KEY;
const serviceRoleKey = process.env.E2E_SERVICE_ROLE_KEY;
const password = process.env.E2E_USER_PASSWORD;
const fixtureFile = process.env.E2E_FIXTURE_FILE;
if (!publishableKey || !serviceRoleKey || !password || !fixtureFile) {
  throw new Error('Disposable matrix environment is incomplete.');
}
const manifest = JSON.parse(await readFile(fixtureFile, 'utf8'));

async function request(path, { method = 'GET', body, token = serviceRoleKey, prefer } = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      apikey: token === serviceRoleKey ? serviceRoleKey : publishableKey,
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { ok: response.ok, status: response.status, data, text };
}

async function requireOk(promise, label) {
  const response = await promise;
  if (!response.ok) throw new Error(`${label} failed (${response.status}): ${response.text}`);
  return response.data;
}

async function expectRejected(promise, expectedText, label) {
  const response = await promise;
  if (response.ok || !response.text.includes(expectedText)) {
    throw new Error(`${label} expected rejection containing ${JSON.stringify(expectedText)}; received ${response.status}: ${response.text}`);
  }
  return response;
}

function exactSingle(rows, label) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`${label} expected exactly one row; received ${Array.isArray(rows) ? rows.length : 'invalid data'}.`);
  }
  return rows[0];
}

function equal(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label} expected ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}.`);
}

async function login(playerIndex) {
  const response = await request('/auth/v1/token?grant_type=password', {
    method: 'POST',
    token: publishableKey,
    body: { email: manifest.admins[playerIndex].email, password },
  });
  if (!response.ok || !response.data?.access_token) throw new Error(`Player ${playerIndex + 1} login failed.`);
  return response.data.access_token;
}

const [adminOneToken, playerTwoToken] = await Promise.all([login(0), login(1)]);
const rpc = (name, body, token) => request(`/rest/v1/rpc/${name}`, { method: 'POST', body, token });
const finalPayload = code => ({
  target_match_id: manifest.fixtures[code].match,
  segment_results: manifest.fixtures[code].segments.map(segmentId => ({
    segment_id: segmentId,
    differential: 0,
    holes_played: 18,
    status: 'final',
  })),
});

// Prove every browser-entered hole persisted exactly; C1 includes the later audited correction.
for (const [code, fixture] of Object.entries(manifest.fixtures)) {
  if (!fixture.browserScored) continue;
  for (const [playerIndex, roundId] of Object.entries(fixture.rounds)) {
    const expectedScores = [...fixture.expectedScores[playerIndex]];
    if (code === 'C1' && playerIndex === '0') expectedScores[17] = 4;
    const scores = await requireOk(request(
      `/rest/v1/scores?round_id=eq.${roundId}&select=hole_number,gross_score&order=hole_number`,
    ), `[${code}] player ${Number(playerIndex) + 1} score readback`);
    equal(scores.length, 18, `[${code}] player ${Number(playerIndex) + 1} submitted hole count`);
    scores.forEach((score, index) => {
      equal(Number(score.hole_number), index + 1, `[${code}] player ${Number(playerIndex) + 1} hole order`);
      equal(Number(score.gross_score), expectedScores[index], `[${code}] player ${Number(playerIndex) + 1} hole ${index + 1} gross score`);
    });
  }
}

const f2Rounds = await requireOk(request(
  `/rest/v1/rounds?match_id=eq.${manifest.fixtures.F2.match}&select=user_id,course_handicap`,
), '[F2] handicap readback');
equal(f2Rounds.length, 4, '[F2] round count');
const f2BlueRound = exactSingle(f2Rounds.filter(round => round.user_id === manifest.admins[0].id), '[F2] zero-handicap Blue round');
const f2WhiteRound = exactSingle(f2Rounds.filter(round => round.user_id === manifest.admins[2].id), '[F2] three-handicap White round');
equal(Number(f2BlueRound.course_handicap), 0, '[F2] Blue course handicap');
equal(Number(f2WhiteRound.course_handicap), 3, '[F2] White course handicap');

const expectedFinals = {
  S1: [{ differential: 1, holes: 18, pointValue: 1, bluePoints: 1, whitePoints: 0 }],
  S2: [{ differential: -2, holes: 17, pointValue: 1, bluePoints: 0, whitePoints: 1 }],
  F1: [{ differential: 0, holes: 18, pointValue: 1, bluePoints: 0.5, whitePoints: 0.5 }],
  F2: [{ differential: -3, holes: 16, pointValue: 1, bluePoints: 0, whitePoints: 1 }],
  M1: [
    { differential: 1, holes: 9, pointValue: 0.5, bluePoints: 0.5, whitePoints: 0 },
    { differential: -3, holes: 7, pointValue: 0.5, bluePoints: 0, whitePoints: 0.5 },
  ],
  C1: [{ differential: 1, holes: 18, pointValue: 1, bluePoints: 1, whitePoints: 0 }],
};
for (const [code, expectedSegments] of Object.entries(expectedFinals)) {
  const match = exactSingle(await requireOk(request(`/rest/v1/matches?id=eq.${manifest.fixtures[code].match}&select=id,status`), `[${code}] match readback`), `[${code}] match`);
  equal(match.status, 'final', `[${code}] match status`);
  const segments = await requireOk(request(`/rest/v1/match_segments?match_id=eq.${match.id}&select=id,status,differential,holes_played,point_value&order=segment_number`), `[${code}] segment readback`);
  equal(segments.length, expectedSegments.length, `[${code}] segment count`);
  segments.forEach((segment, index) => {
    const expected = expectedSegments[index];
    const pointValue = Number(segment.point_value);
    const bluePoints = Number(segment.differential) > 0 ? pointValue : Number(segment.differential) === 0 ? pointValue / 2 : 0;
    const whitePoints = Number(segment.differential) < 0 ? pointValue : Number(segment.differential) === 0 ? pointValue / 2 : 0;
    equal(segment.status, 'final', `[${code}] segment ${index + 1} status`);
    equal(Number(segment.differential), expected.differential, `[${code}] segment ${index + 1} differential`);
    equal(Number(segment.holes_played), expected.holes, `[${code}] segment ${index + 1} holes played`);
    equal(pointValue, expected.pointValue, `[${code}] segment ${index + 1} point value`);
    equal(bluePoints, expected.bluePoints, `[${code}] segment ${index + 1} Blue points`);
    equal(whitePoints, expected.whitePoints, `[${code}] segment ${index + 1} White points`);
  });
}

const correctionAudit = exactSingle(await requireOk(request(
  `/rest/v1/score_correction_audit?round_id=eq.${manifest.fixtures.C1.rounds['0']}&select=action,hole_number,old_gross_score,new_gross_score,correction_reason,corrected_by`,
), '[C1] correction audit readback'), '[C1] correction audit');
equal(correctionAudit.action, 'update', '[C1] audit action');
equal(Number(correctionAudit.hole_number), 18, '[C1] audit hole');
equal(Number(correctionAudit.old_gross_score), 5, '[C1] old score');
equal(Number(correctionAudit.new_gross_score), 4, '[C1] new score');
equal(correctionAudit.correction_reason, '[C1] deterministic QA correction', '[C1] reason');
equal(correctionAudit.corrected_by, manifest.admins[0].id, '[C1] correcting administrator');
// [C1] Score corrected and result recalculated; deletion still fails closed after completion.
await expectRejected(rpc('correct_hole_score', {
  target_round_id: manifest.fixtures.C1.rounds['0'],
  target_hole_number: 18,
  target_reason: '[C1] forbidden finalized delete',
  target_gross_score: null,
  delete_score: true,
}, adminOneToken), 'Finalized scores can be corrected but not deleted', '[C1] finalized delete rejection');

// [R1] Missing score keeps automatic completion waiting without mutating state.
const r1Waiting = await requireOk(rpc('complete_match_if_ready', {
  target_match_id: manifest.fixtures.R1.match,
}, adminOneToken), '[R1] automatic completion wait');
equal(r1Waiting.finalized, false, '[R1] finalized flag');
equal(r1Waiting.reason, 'incomplete_scores', '[R1] wait reason');
// The privileged finalizer independently remains fail-closed on that same incomplete card.
await expectRejected(rpc('finalize_match_results', finalPayload('R1'), adminOneToken), 'complete persisted hole scores', '[R1] incomplete finalization');
// [R2] Two individually valid tees with different indexes must reject net finalization.
await expectRejected(rpc('complete_match_if_ready', {
  target_match_id: manifest.fixtures.R2.match,
}, playerTwoToken), 'matching tee stroke indexes', '[R2] mismatched-index automatic completion');
for (const code of ['R1', 'R2']) {
  const match = exactSingle(await requireOk(request(`/rest/v1/matches?id=eq.${manifest.fixtures[code].match}&select=status`), `[${code}] unchanged match readback`), `[${code}] unchanged match`);
  equal(match.status, 'scheduled', `[${code}] unchanged match status`);
  const segments = await requireOk(request(`/rest/v1/match_segments?match_id=eq.${manifest.fixtures[code].match}&select=status,differential,holes_played`), `[${code}] unchanged segment readback`);
  for (const segment of segments) {
    equal(segment.status, 'scheduled', `[${code}] unchanged segment status`);
    equal(Number(segment.differential), 0, `[${code}] unchanged differential`);
    equal(Number(segment.holes_played), 0, `[${code}] unchanged holes`);
  }
}

// [R3] A no-team member cannot be smuggled into a plan; the transaction creates no match.
const rejectedMatchName = '[DISPOSABLE-QA][R3] No-team player rejection';
await expectRejected(rpc('save_match_plan', {
  match_payload: {
    name: rejectedMatchName,
    session: '[R3] rejection probe',
    starts_at: '2098-03-19T13:00:00Z',
    course_id: manifest.course.id,
    tournament_id: manifest.tournaments.rejection,
  },
  segment_payload: [{
    segment_number: 1,
    start_hole: 1,
    end_hole: 18,
    format: 'singles',
    scoring_mode: 'gross',
    handicap_allowance: null,
    point_value: 1,
    players: [
      { user_id: manifest.admins[0].id, team: 'cardinal', side: 'cardinal', playing_order: 1 },
      { user_id: manifest.admins[3].id, team: 'silver', side: 'silver', playing_order: 2 },
    ],
  }],
}, adminOneToken), 'active tournament member with a team', '[R3] no-team plan');
const r3Rows = await requireOk(request(`/rest/v1/matches?name=eq.${encodeURIComponent(rejectedMatchName)}&select=id`), '[R3] rollback readback');
equal(r3Rows.length, 0, '[R3] rolled-back match count');

// [A2] Self-demotion and last-admin demotion both fail closed.
await expectRejected(rpc('set_tournament_member_role', {
  target_tournament_id: manifest.tournaments.roleProtection,
  target_user_id: manifest.admins[1].id,
  target_role: 'player',
}, playerTwoToken), 'cannot demote your own administrator membership', '[A2] self-demotion');
await expectRejected(rpc('set_tournament_member_role', {
  target_tournament_id: manifest.tournaments.roleProtection,
  target_user_id: manifest.admins[1].id,
  target_role: 'player',
}, adminOneToken), 'last active tournament administrator', '[A2] last-admin demotion');

// [T1] Incomplete rejection tournament cannot publish a Past Trips edition.
await expectRejected(rpc('complete_tournament_archive', {
  target_tournament_id: manifest.tournaments.rejection,
}, adminOneToken), 'Every tournament match must be finalized', '[T1] premature completion');
const rejectionTournament = exactSingle(await requireOk(request(`/rest/v1/tournaments?id=eq.${manifest.tournaments.rejection}&select=status`), '[T1] tournament readback'), '[T1] tournament');
equal(rejectionTournament.status, 'open', '[T1] unchanged tournament status');

// [X1] Two last-save completion requests serialize to one write and one idempotent replay.
const x1Calls = await Promise.all([
  rpc('complete_match_if_ready', { target_match_id: manifest.fixtures.X1.match }, adminOneToken),
  rpc('complete_match_if_ready', { target_match_id: manifest.fixtures.X1.match }, adminOneToken),
]);
equal(x1Calls.filter(response => response.ok).length, 2, '[X1] successful idempotent call count');
equal(x1Calls.filter(response => response.data?.already_final === false).length, 1, '[X1] completing call count');
equal(x1Calls.filter(response => response.data?.already_final === true).length, 1, '[X1] already-final replay count');
const x1Segment = exactSingle(await requireOk(request(`/rest/v1/match_segments?id=eq.${manifest.fixtures.X1.segments[0]}&select=status,differential,holes_played,point_value`), '[X1] segment readback'), '[X1] segment');
equal(x1Segment.status, 'final', '[X1] segment status');
equal(Number(x1Segment.differential), 0, '[X1] segment differential');
equal(Number(x1Segment.holes_played), 18, '[X1] holes played');
equal(Number(x1Segment.point_value) / 2, 0.5, '[X1] Blue points');
equal(Number(x1Segment.point_value) / 2, 0.5, '[X1] White points');

const mainMatches = await requireOk(request(`/rest/v1/matches?tournament_id=eq.${manifest.tournaments.main}&select=id,name,status`), 'Main match readback');
equal(mainMatches.length, 7, 'Main match count');
equal(mainMatches.filter(match => match.status === 'final').length, 7, 'Final main match count');

// Seed one deterministic active recap per finalized match so commentary storage/readback is exercised without a hosted model secret.
await requireOk(request('/rest/v1/match_commentaries', {
  method: 'POST',
  body: mainMatches.map(match => ({
    match_id: match.id,
    segment_id: null,
    commentary_type: 'post_match',
    commentary: `[DISPOSABLE-QA] Verified recap for ${match.name}.`,
    facts: { source: 'disposable-matrix' },
    ai_generated: false,
    status: 'approved',
    generated_by: manifest.admins[0].id,
    approved_by: manifest.admins[0].id,
    approved_at: new Date().toISOString(),
  })),
  prefer: 'return=representation',
}), 'Commentary fixture insert');

// [X2][T2] Concurrent completion serializes to one edition/result set.
const completionCalls = await Promise.all([
  rpc('complete_tournament_archive', { target_tournament_id: manifest.tournaments.main }, adminOneToken),
  rpc('complete_tournament_archive', { target_tournament_id: manifest.tournaments.main }, adminOneToken),
]);
equal(completionCalls.filter(response => response.ok).length, 2, '[X2] successful serialized completions');

const tournament = exactSingle(await requireOk(request(`/rest/v1/tournaments?id=eq.${manifest.tournaments.main}&select=id,status`), '[T2] tournament readback'), '[T2] tournament');
equal(tournament.status, 'complete', '[T2] tournament status');
const edition = exactSingle(await requireOk(request(`/rest/v1/legacy_editions?source_tournament_id=eq.${manifest.tournaments.main}&select=id,status,published,final_score,expected_points,cardinal_total,silver_total,source_tournament_id,updated_at`), '[T2] edition readback'), '[T2] generated edition');
equal(edition.status, 'completed', '[T2] edition status');
equal(edition.published, true, '[T2] edition published');
equal(edition.final_score, 'Blue 3.5 - White 3.5', '[T2] final score');
equal(Number(edition.expected_points), 7, '[T2] expected points');
equal(Number(edition.cardinal_total), 3.5, '[T2] Blue points');
equal(Number(edition.silver_total), 3.5, '[T2] White points');

const resultsPath = `/rest/v1/legacy_results?edition_id=eq.${edition.id}&select=id,source_match_id,source_segment_id,event_group,label,format_label,points_available,cardinal_points,silver_points&order=sort_order`;
const results = await requireOk(request(resultsPath), '[T5] generated results readback');
equal(results.length, 8, '[T5] generated result count');
equal(new Set(results.map(result => result.source_segment_id)).size, 8, '[T5] unique source segment count');
equal(results.reduce((sum, result) => sum + Number(result.points_available), 0), 7, '[T5] points available total');
equal(results.reduce((sum, result) => sum + Number(result.cardinal_points), 0), 3.5, '[T5] Blue result total');
equal(results.reduce((sum, result) => sum + Number(result.silver_points), 0), 3.5, '[T5] White result total');
for (const text of ['Round', '1v1', '2v2 Best Ball', '2v2 Foursomes']) {
  if (!results.some(result => `${result.event_group} ${result.label} ${result.format_label}`.includes(text))) {
    throw new Error(`[T5] generated results are missing ${text}.`);
  }
}

const commentaries = await requireOk(request(`/rest/v1/match_commentaries?match_id=in.(${mainMatches.map(match => match.id).join(',')})&select=id,match_id,status`), 'Commentary readback');
equal(commentaries.length, 7, 'Commentary count');
equal(commentaries.filter(commentary => commentary.status === 'approved').length, 7, 'Approved commentary count');
equal(new Set(commentaries.map(commentary => commentary.match_id)).size, 7, 'One recap per finalized match');

// [T3] A later replay is read-only and preserves the generated archive timestamp/count.
const replay = await requireOk(rpc('complete_tournament_archive', { target_tournament_id: manifest.tournaments.main }, adminOneToken), '[T3] idempotent completion replay');
equal(replay.id, edition.id, '[T3] replay edition id');
const replayEdition = exactSingle(await requireOk(request(`/rest/v1/legacy_editions?id=eq.${edition.id}&select=updated_at`), '[T3] edition replay readback'), '[T3] replay edition');
equal(replayEdition.updated_at, edition.updated_at, '[T3] unchanged edition timestamp');
const replayResults = await requireOk(request(resultsPath), '[T3] result replay readback');
equal(replayResults.length, 8, '[T3] unchanged result count');

// [T4] Generated Past Trips rows cannot be changed directly.
await expectRejected(request(`/rest/v1/legacy_results?id=eq.${results[0].id}`, {
  method: 'PATCH',
  body: { cardinal_points: 0 },
  prefer: 'return=representation',
}), 'Generated Past Trips results cannot be changed or deleted', '[T4] generated result mutation');
const unchangedResult = exactSingle(await requireOk(request(`/rest/v1/legacy_results?id=eq.${results[0].id}&select=cardinal_points,silver_points`), '[T4] unchanged result readback'), '[T4] unchanged result');
equal(Number(unchangedResult.cardinal_points), Number(results[0].cardinal_points), '[T4] unchanged Blue points');
equal(Number(unchangedResult.silver_points), Number(results[0].silver_points), '[T4] unchanged White points');

console.log('Verified the disposable four-admin matrix, rollback, concurrency, completion, commentary, and archive protection.');
