import { assertDisposableSupabaseUrl } from './safety.mjs';

const apiUrl = assertDisposableSupabaseUrl(process.env.E2E_SUPABASE_URL);
const serviceRoleKey = process.env.E2E_SERVICE_ROLE_KEY;

if (!serviceRoleKey) throw new Error('Missing local E2E service-role key.');

async function request(path, { method = 'GET', body, prefer } = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    data: text ? JSON.parse(text) : null,
    text,
  };
}

function exactSingle(rows, label) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`${label} expected exactly one row; received ${Array.isArray(rows) ? rows.length : 'invalid data'}.`);
  }
  return rows[0];
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} expected ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}.`);
  }
}

const tournamentResponse = await request(
  '/rest/v1/tournaments?slug=eq.disposable-hereford-cup-e2e&select=id,status',
);
if (!tournamentResponse.ok) throw new Error(`Tournament readback failed (${tournamentResponse.status}).`);
const tournament = exactSingle(tournamentResponse.data, 'Disposable tournament');
assertEqual(tournament.status, 'complete', 'Tournament status');

const editionResponse = await request(
  '/rest/v1/legacy_editions?edition_year=eq.2099&select=id,source_tournament_id,status,published,winner_name,runner_up_name,final_score,expected_points,cardinal_total,silver_total,score_confidence',
);
if (!editionResponse.ok) throw new Error(`Past Trips edition readback failed (${editionResponse.status}).`);
const edition = exactSingle(editionResponse.data, 'Generated Past Trips edition');
assertEqual(edition.source_tournament_id, tournament.id, 'Archive source_tournament_id');
assertEqual(edition.status, 'completed', 'Archive status');
assertEqual(edition.published, true, 'Archive publication');
assertEqual(edition.winner_name, 'Blue', 'Archive winner');
assertEqual(edition.runner_up_name, 'White', 'Archive runner-up');
assertEqual(edition.final_score, 'Blue 1 - White 0', 'Archive final score');
assertEqual(Number(edition.expected_points), 1, 'Archive expected points');
assertEqual(Number(edition.cardinal_total), 1, 'Archive cardinal_total');
assertEqual(Number(edition.silver_total), 0, 'Archive silver_total');
assertEqual(edition.score_confidence, 'confirmed', 'Archive score confidence');

const resultPath = `/rest/v1/legacy_results?edition_id=eq.${encodeURIComponent(edition.id)}&select=id,source_match_id,source_segment_id,event_group,label,format_label,cardinal_entry,silver_entry,result,points_available,cardinal_points,silver_points`;
const resultResponse = await request(resultPath);
if (!resultResponse.ok) throw new Error(`Past Trips result readback failed (${resultResponse.status}).`);
const result = exactSingle(resultResponse.data, 'Generated Past Trips result');
if (!result.source_match_id || !result.source_segment_id) throw new Error('Generated result is missing source provenance.');
assertEqual(result.event_group, 'Round 1 - Singles', 'Generated Round heading');
assertEqual(result.label, 'Disposable Final Match - 1v1', 'Generated result label');
assertEqual(result.format_label, '1v1', 'Generated format label');
assertEqual(result.cardinal_entry, 'Disposable E2E Admin', 'Generated Blue participant');
assertEqual(result.silver_entry, 'Disposable E2E Opponent', 'Generated White participant');
assertEqual(result.result, 'Blue wins 1 Up', 'Generated match result');
assertEqual(Number(result.points_available), 1, 'Generated points available');
assertEqual(Number(result.cardinal_points), 1, 'Generated Blue points');
assertEqual(Number(result.silver_points), 0, 'Generated White points');

const forbiddenMutation = await request(`/rest/v1/legacy_results?id=eq.${encodeURIComponent(result.id)}`, {
  method: 'PATCH',
  body: { cardinal_points: 0 },
  prefer: 'return=representation',
});
if (forbiddenMutation.ok || !forbiddenMutation.text.includes('Generated Past Trips results cannot be changed or deleted')) {
  throw new Error(`Generated result mutation was not rejected by the database trigger (status ${forbiddenMutation.status}).`);
}

const unchangedResponse = await request(resultPath);
if (!unchangedResponse.ok) throw new Error(`Post-rejection readback failed (${unchangedResponse.status}).`);
const unchanged = exactSingle(unchangedResponse.data, 'Unchanged generated Past Trips result');
assertEqual(Number(unchanged.cardinal_points), 1, 'Generated Blue points after rejected mutation');
assertEqual(Number(unchanged.silver_points), 0, 'Generated White points after rejected mutation');

console.log('Verified atomic completion readback, exact archive rows, and generated-result immutability.');
