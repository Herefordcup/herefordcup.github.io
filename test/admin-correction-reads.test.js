import test from 'node:test';
import assert from 'node:assert/strict';
import { correctHoleScore, loadCorrectionMatch, loadTeamCorrectionAudits } from '../src/supabase.js';

// A local PostgREST query recorder. No network or hosted credentials are needed.
function reader(resolve) {
  const calls = [];
  return {
    calls,
    from(table) {
      const query = { table, filters: [] };
      calls.push(query);
      return {
        select(fields) { query.fields = fields; return this; },
        eq(column, value) { query.filters.push([column, value]); return this; },
        order(...args) { query.order = args; return this; },
        range(...args) { query.range = args; return this; },
        single() { return this; }, maybeSingle() { return this; }, limit() { return this; },
        then(ok, fail) { return Promise.resolve().then(() => resolve(query)).then(ok, fail); },
      };
    },
  };
}

test('admin correction reads restrict submitted outcomes and squads to the selected match', async () => {
  const client = reader(query => ({ data: query.table === 'matches' ? { id: 'chosen' } : [{ id: 'squad' }] }));
  assert.deepEqual(await loadCorrectionMatch('chosen', client), { id: 'chosen', correctionSquads: [{ id: 'squad' }] });
  assert.deepEqual(client.calls.map(q => [q.table, q.filters]), [['matches', [['id', 'chosen']]], ['texas_scramble_squads', [['match_id', 'chosen']]]]);
  assert.match(client.calls[0].fields, /match_segments\([^)]*match_segment_players\(\*\), match_hole_outcomes\(id, segment_id, hole_number, winner\)/);
  assert.match(client.calls[1].fields, /texas_scramble_squad_players!texas_scramble_squad_players_squad_id_fkey/);
});

test('every page of private correction history has the same exact match filter and newest-first event order', async () => {
  const client = reader(({ range: [from, to] }) => ({ data: from ? ['last'] : Array(to - from + 1).fill('first page') }));
  const rows = await loadTeamCorrectionAudits('chosen', client);
  assert.equal(client.calls.length, 2);
  for (const q of client.calls) {
    assert.equal(q.table, 'team_score_correction_audit');
    assert.deepEqual(q.filters, [['match_id', 'chosen']]);
    assert.deepEqual(q.order, ['event_sequence', { ascending: false }]);
  }
  assert.equal(client.calls[1].range[0], client.calls[0].range[1] + 1);
  assert.equal(rows.at(-1), 'last');
});

test('an individual correction RPC success is not undone by an unavailable audit readback', async () => {
  const client = reader(() => ({ error: { message: 'Audit unavailable' } }));
  let saves = 0;
  const score = { id: 'score', round_id: 'round', hole_number: 7, gross_score: 4 };
  client.rpc = async (name, args) => {
    assert.equal(name, 'correct_hole_score');
    assert.deepEqual(args, { target_round_id: 'round', target_hole_number: 7, target_reason: 'Verified', target_gross_score: 4, delete_score: false });
    saves++;
    return { data: score };
  };
  const saved = await correctHoleScore({ roundId: 'round', holeNumber: 7, grossScore: 4, reason: 'Verified' }, client);
  assert.equal(saves, 1);
  assert.deepEqual(saved.score, score);
  assert.match(saved.auditWarning, /Audit unavailable/);
  assert.deepEqual(client.calls.map(q => q.filters), [[['round_id', 'round'], ['hole_number', 7]]]);
});

test('an exact individual edit passes its displayed score ID and keeps the score/audit return contract', async () => {
  const score = { id: 'original' }, audit = { score_id: score.id };
  const client = reader(() => ({ data: audit }));
  client.rpc = async (name, args) => {
    assert.equal(name, 'correct_hole_score');
    assert.deepEqual(args, { target_round_id: 'round', target_hole_number: 7, target_reason: 'Verified', target_gross_score: 4,
      delete_score: false, expected_score_id: score.id });
    return { data: score };
  };
  assert.deepEqual(await correctHoleScore({ roundId: 'round', holeNumber: 7, grossScore: 4, reason: ' Verified ', expectedScoreId: score.id }, client), { score, audit });
});

test('the exact-row guard works on browsers without Object.hasOwn', async () => {
  const args = [];
  const client = reader(() => ({ data: null }));
  client.rpc = async (name, payload) => { args.push(payload); return { data: { id: 'exact-id' } }; };
  const descriptor = Object.getOwnPropertyDescriptor(Object, 'hasOwn');
  let pending;
  try {
    Object.defineProperty(Object, 'hasOwn', { ...descriptor, value: undefined });
    pending = correctHoleScore({ roundId: 'round', holeNumber: 3, grossScore: 5, reason: 'Signed card', expectedScoreId: 'exact-id' }, client);
  } finally { Object.defineProperty(Object, 'hasOwn', descriptor); }
  await pending;
  assert.equal(args.length, 1);
  assert.equal(args[0].expected_score_id, 'exact-id');
});

test('an explicitly missing displayed ID never falls back to an old-client insert', async () => {
  const client = { rpc: () => assert.fail('A form missing its displayed ID must not send a mutation') };
  for (const expectedScoreId of [null, undefined]) {
    await assert.rejects(correctHoleScore({ roundId: 'round', holeNumber: 7, grossScore: 4, reason: 'Verified', expectedScoreId }, client), /submitted score ID/i);
  }
});
