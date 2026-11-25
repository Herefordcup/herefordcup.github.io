import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMixedEntryFixture } from '../scripts/e2e/mixed-entry-fixture.mjs';

let f;
before(async () => { f = await createMixedEntryFixture(); });
after(async () => { await f?.db.close(); });

const frontNine = gross => Array.from({ length: 9 }, (_, i) => ({ hole_number: i + 1, gross_score: gross }));
const status = async match => (await f.db.query('select status from public.matches where id=$1', [match])).rows[0].status;

test('an outcome-only hole cannot accept an individual gross score', async () => {
  const { id } = await f.plan();
  const round = await f.openRound(f.blue, id);
  await assert.rejects(f.saveScores(f.blue, round, [{ hole_number: 10, gross_score: 4 }]), /hole winner entry/i);
  assert.deepEqual((await f.db.query('select id from public.scores where round_id=$1', [round])).rows, []);
});

test('manual Foursomes result cannot substitute for unplayed hole winners', async () => {
  const { id, individual, outcome } = await f.plan({ outcomeFormat: 'foursomes' });
  for (const [user, gross] of [[f.blue, 3], [f.white, 4]]) {
    await f.saveScores(user, await f.openRound(user, id), frontNine(gross));
  }
  const payload = JSON.stringify([
    { segment_id: individual.id, status: 'final' },
    { segment_id: outcome.id, status: 'final', differential: 0, holes_played: 9 },
  ]);
  await assert.rejects(f.as(f.admin, 'select public.finalize_match_results($1,$2)', [id, payload]), /hole outcomes/i);
  assert.notEqual(await status(id), 'final');
  assert.deepEqual((await f.db.query('select action from public.match_result_audit where match_id=$1', [id])).rows, []);
});

test('individual-only Singles / net Four-Ball still finish from all four cards', async () => {
  const { id } = await f.plan({ backMode: 'individual_scores' });
  for (const [i, user] of [f.blue, f.white, f.bluePartner, f.whitePartner].entries()) {
    const round = await f.openRound(user, id, f.tee.id, user === f.whitePartner ? 12 : 0);
    const back = frontNine(4).map(s => ({ ...s, hole_number: s.hole_number + 9 }));
    await f.saveScores(user, round, i < 2 ? [...frontNine(4), ...back] : back);
    assert.equal((await f.complete(user, id)).finalized, i === 3);
  }
  assert.deepEqual((await f.db.query('select differential,holes_played from public.match_segments where match_id=$1 order by segment_number', [id])).rows,
    [{ differential: 0, holes_played: 9 }, { differential: -3, holes_played: 7 }]);
});

test('only an administrator can record a genuine manual Foursomes result', async () => {
  const { id, individual, outcome: manual } = await f.plan({ outcomeFormat: 'foursomes', backMode: 'individual_scores' });
  for (const user of [f.blue, f.white]) await f.saveScores(user, await f.openRound(user, id), frontNine(4));
  assert.equal((await f.complete(f.blue, id)).reason, 'team_score_required');
  const result = JSON.stringify([{ segment_id: individual.id, status: 'final' }, { segment_id: manual.id, status: 'final', differential: 0, holes_played: 9 }]);
  await assert.rejects(f.as(f.blue, 'select public.finalize_match_results($1,$2)', [id, result]), /administrator access required/i);
  await f.as(f.admin, 'select public.finalize_match_results($1,$2)', [id, result]);
  assert.equal(await status(id), 'final');
});

test('a settled hole winner survives incompatible individual net tees without closing the match', async () => {
  const { id, outcome } = await f.plan({ frontScoring: 'net' });
  for (const [user, tee] of [[f.blue, f.tee], [f.white, f.alternate]]) {
    await f.saveScores(user, await f.openRound(user, id, tee.id), frontNine(4));
  }
  let saved;
  for (let h = 10; h <= 14; h++) saved = await f.saveOutcome(f.whitePartner, outcome.id, h, 'silver');
  assert.equal(saved.finalized, true);
  assert.equal(saved.match_finalized, false);
  assert.match(saved.completion_warning, /matching tee stroke indexes/i);
  assert.notEqual(await status(id), 'final');
  assert.equal((await f.db.query('select count(*)::int n from public.match_hole_outcomes where segment_id=$1', [outcome.id])).rows[0].n, 5);
  await assert.rejects(f.complete(f.blue, id), /matching tee stroke indexes/i);
});

for (const last of ['individual scores', 'hole winner']) {
  test(`both authoritative segments finish when ${last} is the last entry`, async () => {
    const { id, individual, outcome } = await f.plan();
    const blueRound = await f.openRound(f.blue, id);
    const whiteRound = await f.openRound(f.white, id);
    await f.saveScores(f.blue, blueRound, frontNine(3));
    await f.saveScores(f.white, whiteRound, frontNine(4).slice(0, 8));
    for (let hole = 10; hole < 14; hole++) await f.saveOutcome(f.whitePartner, outcome.id, hole, 'silver');
    const finishScores = async () => {
      await f.saveScores(f.white, whiteRound, frontNine(4).slice(8));
      return f.complete(f.white, id); // Same readiness call as the individual Save round button.
    };
    const finishWinners = () => f.saveOutcome(f.whitePartner, outcome.id, 14, 'silver');
    assert.equal((await f.complete(f.blue, id)).finalized, false);
    if (last === 'individual scores') {
      const saved = await finishWinners();
      assert.equal(saved.finalized, true, 'outcome segment should close early at 5 & 4');
      assert.equal(saved.match_finalized, false);
      assert.notEqual(await status(id), 'final', 'missing one required individual hole');
      assert.equal((await finishScores()).finalized, true, 'settled hole winners must not require player scores');
    } else {
      assert.equal((await finishScores()).finalized, false, 'unsettled outcome segment must wait');
      assert.notEqual(await status(id), 'final');
      assert.equal((await finishWinners()).match_finalized, true); // No extra individual save or completion RPC.
    }
    assert.equal(await status(id), 'final', 'last entry should close the parent match');
    const result = (await f.db.query(`select id,status,differential,holes_played,point_value::int as points
      from public.match_segments where match_id=$1 order by segment_number`, [id])).rows;
    assert.deepEqual(result, [
      { id: individual.id, status: 'final', differential: 5, holes_played: 5, points: 1 },
      { id: outcome.id, status: 'final', differential: -5, holes_played: 5, points: 2 },
    ]);
    assert.equal((await f.complete(f.blue, id)).already_final, true);
    const stored = (await f.db.query(`select r.user_id, s.hole_number, s.gross_score from public.rounds r
      join public.scores s on s.round_id=r.id where r.match_id=$1 order by s.hole_number`, [id])).rows;
    assert.equal(stored.length, 18);
    for (const [user, gross] of [[f.blue, 3], [f.white, 4]]) {
      assert.deepEqual(stored.filter(r => r.user_id === user).map(({ hole_number, gross_score }) => ({ hole_number, gross_score })), frontNine(gross));
    }
    const stats = (await f.db.query(`select user_id,holes_played,gross_total from public.official_round_statistics
      where match_id=$1 order by gross_total`, [id])).rows;
    assert.deepEqual(stats, [
      { user_id: f.blue, holes_played: 9, gross_total: 27 },
      { user_id: f.white, holes_played: 9, gross_total: 36 },
    ], 'real individual scores count; outcome-only partners and holes do not');
    const audits = (await f.db.query(`select segment_id,action,changed_by from public.match_result_audit
      where match_id=$1 order by event_sequence`, [id])).rows;
    assert.deepEqual(audits, [
      { segment_id: outcome.id, action: 'finalized', changed_by: f.whitePartner },
      { segment_id: individual.id, action: 'finalized', changed_by: last === 'individual scores' ? f.white : f.whitePartner },
    ]);
    await assert.rejects(f.saveOutcome(f.whitePartner, outcome.id, 15, 'halved'), /segment is final/i);
    await assert.rejects(f.complete(f.admin, id), /assigned active player/i); // Global admin is not a participant.
    const correction = 'select public.correct_hole_score($1,1,$2,6,false)';
    const reason = 'Correct the front-nine tee score';
    await assert.rejects(f.as(f.blue, correction, [blueRound, reason]), /administrator access required/i);
    await f.as(f.admin, correction, [blueRound, reason]);
    assert.deepEqual((await f.db.query(`select segment_id,changed_by,change_reason,new_differential,new_holes_played
      from public.match_result_audit where match_id=$1 and action='recalculated'`, [id])).rows,
      [{ segment_id: individual.id, changed_by: f.admin, change_reason: reason, new_differential: 4, new_holes_played: 6 }]);
    assert.equal(await status(id), 'final');
  });
}
