import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createTeamScoringFixture } from '../scripts/e2e/team-scoring-fixture.mjs';

let db, ids, tournamentId, courseId, teeId, squads;
before(async () => {
  ({ db, ids, tournamentId, courseId, teeId, squads } = await createTeamScoringFixture());
});
after(async () => db?.close());

// Use the actual authenticated RPC grants and JWT identity, then read back independently.
const rows = async (sql, args) => (await db.query(sql, args)).rows;
const rpc = (actor, sql, args) => db.transaction(async tx => {
  await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [actor]);
  await tx.exec('set local role authenticated');
  return (await tx.query(sql, args)).rows[0];
});
const save = async (match, segments, { legacy = false, actor = ids[0] } = {}) => (await rpc(actor,
  legacy ? 'select public.save_match_plan($1, $2) as id' : 'select public.save_match_plan_with_entry_modes($1, $2) as id',
  [JSON.stringify(match), JSON.stringify(segments)])).id;
const submit = (segmentId, hole, winner) => rpc(ids[1],
  'select public.submit_match_hole_outcome($1, $2, $3) as entry', [segmentId, hole, winner]);
const matchPayload = name => ({ tournament_id: tournamentId, name, session: 'Friday',
  starts_at: '2099-04-17T13:00:00Z', course_id: courseId, status: 'scheduled' });
const singles = () => ({ segment_number: 1, start_hole: 1, end_hole: 18, format: 'singles',
  scoring_mode: 'gross', entry_mode: 'hole_outcomes', handicap_allowance: null, point_value: 1,
  players: [{ user_id: ids[1], side: 'cardinal', team: 'cardinal', playing_order: 1 },
    { user_id: ids[9], side: 'silver', team: 'silver', playing_order: 2 }] });
async function matchState(id) {
  const args = [id];
  return {
    match: (await rows('select * from public.matches where id = $1', args))[0],
    segments: await rows('select * from public.match_segments where match_id = $1 order by segment_number', args),
    players: await rows('select * from public.match_players where match_id = $1 order by user_id', args),
    lineups: await rows(`select p.* from public.match_segment_players p join public.match_segments s on s.id = p.segment_id
      where s.match_id = $1 order by s.segment_number, p.playing_order`, args),
    outcomes: await rows(`select o.* from public.match_hole_outcomes o join public.match_segments s on s.id = o.segment_id
      where s.match_id = $1 order by s.segment_number, o.hole_number`, args),
    history: await rows('select * from public.match_result_audit where match_id = $1 order by event_sequence', args),
    corrections: await rows('select * from public.team_score_correction_audit where match_id = $1 order by event_sequence', args),
  };
}

test('renaming a match after an assigned player posts a hole preserves the original plan and score', async () => {
  const match = matchPayload('Original match');
  const segment = singles();
  const id = await save(match, [segment]);
  const [original] = (await matchState(id)).segments;
  // A currently live match must not be reset by the planner's normal scheduled payload.
  await db.query("update public.matches set status = 'live' where id = $1", [id]);
  assert.equal((await rpc(ids[1], 'select public.is_admin() as admin')).admin, false);
  const { entry } = await submit(original.id, 1, 'cardinal');
  const before = await matchState(id);
  assert.equal(before.outcomes.length, 1);
  assert.equal(before.outcomes[0].id, entry.outcome.id);
  assert.equal(before.outcomes[0].submitted_by, ids[1]);
  assert.equal(before.outcomes[0].winner, 'cardinal');
  assert.equal(before.lineups.length, 2);

  const name = 'Renamed match';
  assert.equal(await save({ ...match, id, name }, [segment]), id);
  const after = await matchState(id);
  assert.deepEqual({ name: after.match.name, status: after.match.status, sameSegment: after.segments[0].id === original.id,
    saved: after.outcomes.length }, { name, status: 'live', sameSegment: true, saved: 1 });
  assert.deepEqual(after, { ...before, match: { ...before.match, name, updated_at: after.match.updated_at } });
});

test('a played plan rejects same-count structural edits and stale legacy saves atomically', async () => {
  const match = matchPayload('Mixed match');
  const plan = [{ ...singles(), end_hole: 1 }, { ...singles(), segment_number: 2, start_hole: 2 }];
  const id = await save(match, plan);
  const [first, second] = (await matchState(id)).segments;
  await submit(second.id, 2, 'silver');
  const before = await matchState(id);
  const renamed = { ...match, id, name: 'Must not persist' };
  for (const [label, edit] of Object.entries({
    holes: p => { p[0].end_hole = 2; p[1].start_hole = 3; },
    points: p => { p[1].point_value = 2; },
    mode: p => { p[1].entry_mode = 'individual_scores'; },
    handicap: p => { p[1].handicap_allowance = 50; },
    scoring: p => { p[1].scoring_mode = 'net'; p[1].handicap_allowance = 100; },
    format: p => { p[1].format = 'fourball'; },
    number: p => { p[1].segment_number = 3; },
    assignment: p => { p[1].players[0].user_id = ids[2]; },
    side: p => { [p[1].players[0].side, p[1].players[1].side] = ['silver', 'cardinal']; },
    team: p => { p[1].players[0].team = 'silver'; },
    order: p => { [p[1].players[0].playing_order, p[1].players[1].playing_order] = [2, 1]; },
    duplicate: p => { p[1] = p[0]; },
  })) {
    const edited = structuredClone(plan);
    edit(edited);
    await assert.rejects(save(renamed, edited), /play|score/i, label);
    assert.deepEqual(await matchState(id), before, label);
  }
  for (const fields of [{ session: 'Other' }, { starts_at: '2099-06-01T15:00Z' }, { course_id: null },
    { status: 'final' }, { format: 'fourball' }, { scoring_mode: 'net' }]) {
    await assert.rejects(save({ ...renamed, ...fields }, plan), /play|score/i);
    assert.deepEqual(await matchState(id), before);
  }
  const stale = plan.map(({ entry_mode, ...segment }) => segment);
  await assert.rejects(save(renamed, stale, { legacy: true }), /play|score/i);
  assert.deepEqual(await matchState(id), before);

  // Finish just the first segment to produce real result history on a nonfinal match.
  await submit(first.id, 1, 'halved');
  const withHistory = await matchState(id);
  assert.equal(withHistory.history.length, 1);
  assert.equal(withHistory.history[0].segment_id, first.id);
  await assert.rejects(save(renamed, [{ ...plan[0], point_value: 2 }, plan[1]]), /play|score/i);
  assert.deepEqual(await matchState(id), withHistory);
});

const sessionPayload = name => ({ tournament_id: tournamentId, name, session_label: 'Friday AM',
  starts_at: '2099-04-17T13:00Z', start_hole: 1, end_hole: 9, required_tee_shots: 1 });
const saveSession = async (session, roster, actor = ids[0]) => (await rpc(actor,
  'select public.save_texas_scramble_plan($1, $2) as id', [JSON.stringify(session), JSON.stringify(roster)])).id;
async function sessionState(id) {
  const cards = await rows('select * from public.texas_scramble_squads where session_id = $1 order by side, squad_number', [id]);
  return {
    session: (await rows('select * from public.texas_scramble_sessions where id = $1', [id]))[0],
    cards,
    players: await rows(`select * from public.texas_scramble_squad_players where session_id = $1 order by squad_id, playing_order`, [id]),
    holes: await rows(`select h.* from public.texas_scramble_hole_scores h join public.texas_scramble_squads q on q.id = h.squad_id
      where q.session_id = $1 order by q.id, h.hole_number`, [id]),
    matches: await Promise.all(cards.map(card => matchState(card.match_id))),
  };
}
async function assertReplacedCleanly(before, after, roster) {
  assert.equal(after.cards.length, roster.length);
  assert.equal(after.players.length, roster.flatMap(squad => squad.player_ids).length);
  for (const [i, card] of after.cards.entries()) {
    const expected = roster.find(squad => squad.side === card.side && squad.squad_number === card.squad_number);
    assert.equal(card.label, expected.label);
    assert.deepEqual(after.players.filter(p => p.squad_id === card.id).map(p => p.user_id), expected.player_ids);
    const match = after.matches[i];
    assert.equal(match.match.id, card.match_id);
    assert.deepEqual(match.segments.map(s => s.id), [card.segment_id]);
    assert.deepEqual(match.lineups.map(p => p.user_id), expected.player_ids);
    assert.deepEqual(match.players.map(p => p.user_id), [...expected.player_ids].sort());
  }
  for (const old of before.cards) {
    if (!after.cards.some(q => q.id === old.id)) {
      assert.deepEqual(await rows('select id from public.texas_scramble_squads where id = $1', [old.id]), []);
      assert.deepEqual(await rows('select user_id from public.texas_scramble_squad_players where squad_id = $1', [old.id]), []);
    }
    if (!after.cards.some(q => q.match_id === old.match_id)) {
      assert.deepEqual(await rows('select id from public.matches where id = $1', [old.match_id]), []);
      assert.deepEqual(await rows('select user_id from public.match_players where match_id = $1', [old.match_id]), []);
    }
    if (!after.cards.some(q => q.segment_id === old.segment_id)) {
      assert.deepEqual(await rows('select id from public.match_segments where id = $1', [old.segment_id]), []);
      assert.deepEqual(await rows('select user_id from public.match_segment_players where segment_id = $1', [old.segment_id]), []);
    }
  }
}

for (const preselected of [false, true]) {
  test(`dedicated Scramble editor keeps the session and one clean lineup (${preselected ? 'preselected tee' : 'scheduled'})`, async () => {
    const session = sessionPayload('Initial Scramble');
    const id = await saveSession(preselected ? { ...session, course_id: courseId, tee_id: teeId } : session, squads);
    const before = await sessionState(id);
    assert.equal(before.session.status, preselected ? 'live' : 'scheduled');
    assert.equal(before.holes.length, 0);
    const roster = [{ ...squads[0], label: 'Revised Blue', player_ids: [ids[2], ids[5]] }, squads[2]];
    // No new course selection was requested. Keep an existing selection and its handicaps.
    assert.equal(await saveSession({ ...session, id, name: 'Edited Scramble' }, roster), id);
    const after = await sessionState(id);
    assert.equal(after.session.name, 'Edited Scramble');
    assert.equal(after.session.status, preselected ? 'live' : 'scheduled');
    assert.equal(after.session.course_id, preselected ? courseId : null);
    assert.equal(after.session.tee_id, preselected ? teeId : null);
    assert.equal(after.holes.length, 0);
    if (preselected) assert.ok(after.players.every(p => p.course_handicap !== null));
    await assertReplacedCleanly(before, after, roster);
  });
}

test('the first shared hole freezes the whole session, including its unscored siblings and legacy match mirrors', async () => {
  const session = { ...sessionPayload('Shared cards'), course_id: courseId, tee_id: teeId };
  const id = await saveSession(session, squads);
  const [card] = (await sessionState(id)).cards;
  const { entry } = await rpc(ids[1], 'select public.submit_texas_scramble_hole($1, 1, 5, $2) as entry', [card.id, ids[2]]);
  const before = await sessionState(id);
  assert.equal(before.holes.length, 1);
  assert.equal(before.holes[0].id, entry.hole.id);
  assert.equal(before.holes[0].submitted_by, ids[1]);
  assert.equal(before.holes[0].tee_shot_player_id, ids[2]);
  const changed = structuredClone(squads);
  [changed[2].player_ids[0], changed[3].player_ids[0]] = [changed[3].player_ids[0], changed[2].player_ids[0]];
  await assert.rejects(saveSession({ ...session, id, name: 'Must not persist' }, changed), /play|score/i);
  assert.deepEqual(await sessionState(id), before);
  for (const legacy of [false, true]) {
    await assert.rejects(save({ ...matchPayload('Wrong planner'), id: card.match_id }, [singles()], { legacy }), /scramble|shared/i);
    assert.deepEqual(await sessionState(id), before);
  }
});

test('unplayed legacy edits still work; individual scores lock both planner entry points', async () => {
  const match = matchPayload('Legacy plan');
  const { entry_mode, ...segment } = singles(); // Older clients do not send an entry mode.
  const id = await save(match, [segment], { legacy: true });
  const edited = { ...segment, point_value: 2 };
  assert.equal(await save({ ...match, id, name: 'Edited before play' }, [edited], { legacy: true }), id);
  const before = await matchState(id);
  assert.equal(before.match.name, 'Edited before play');
  assert.equal(before.segments[0].entry_mode, 'individual_scores');
  assert.equal(Number(before.segments[0].point_value), 2);
  const round = await rpc(ids[1], `insert into public.rounds(user_id,match_id,course_id,tee_id) values ($1,$2,$3,$4) returning *`,
    [ids[1], id, courseId, teeId]);
  const score = await rpc(ids[1], `insert into public.scores(round_id,user_id,hole_number,gross_score) values ($1,$2,1,5) returning *`,
    [round.id, ids[1]]);
  for (const legacy of [false, true]) {
    await assert.rejects(save({ ...match, id, name: 'Must not persist' }, [segment], { legacy }), /play|score/i);
    assert.deepEqual(await matchState(id), before);
    assert.deepEqual(await rows('select * from public.rounds where match_id = $1', [id]), [round]);
    assert.deepEqual(await rows('select * from public.scores where round_id = $1', [round.id]), [score]);
  }
});

async function newTournament(year) {
  const [{ id }] = await rows(`insert into public.tournaments(name, slug, edition_year, status, created_by)
    values ('Plan-edit fixture', $1, $2, 'open', $3) returning id`, [`plan-edits-${year}`, year, ids[0]]);
  await db.query(`insert into public.tournament_memberships(tournament_id,user_id,role,status,team)
    select $1,user_id,'player','active',team from public.tournament_memberships where tournament_id = $2 and user_id <> $3
    on conflict (tournament_id,user_id) do update set role = excluded.role, status = excluded.status, team = excluded.team`, [id, tournamentId, ids[0]]);
  return id;
}

test('ordinary and dedicated planners retain their distinct admin permissions and exact tournament scope', async () => {
  const other = await newTournament(2098);
  await db.query("update public.tournament_memberships set role = 'admin' where tournament_id = $1 and user_id = $2", [other, ids[16]]);
  const match = { ...matchPayload('Scoped match'), tournament_id: other };
  const id = await save(match, [singles()]);
  const before = await matchState(id);
  for (const legacy of [false, true]) {
    await assert.rejects(save({ ...match, id }, [singles()], { actor: ids[16], legacy }), /administrator/i);
    await assert.rejects(save({ ...match, id, tournament_id: tournamentId }, [singles()], { legacy }), /tournament/i);
  }
  assert.deepEqual(await matchState(id), before);
  assert.equal((await rows(`select has_function_privilege('authenticated','public.rebuild_unplayed_match_plan(jsonb,jsonb)','execute') as executable`))[0].executable, false);

  const session = { ...sessionPayload('Scoped Scramble'), tournament_id: other };
  const sessionId = await saveSession(session, [squads[0]], ids[16]);
  const existing = await sessionState(sessionId);
  await assert.rejects(saveSession({ ...session, id: sessionId }, [squads[0]], ids[1]), /administrator/i);
  await assert.rejects(saveSession({ ...session, id: sessionId, tournament_id: tournamentId }, [squads[0]]), /tournament/i);
  await assert.rejects(save({ ...match, id: existing.cards[0].match_id }, [singles()], { legacy: true }), /scramble|shared/i);
  assert.deepEqual(await sessionState(sessionId), existing);
});

test('finalized and archived identities cannot be replaced or extended by a planner', async () => {
  const editionYear = 2097;
  const other = await newTournament(editionYear);
  const session = { ...sessionPayload('Final Scramble'), tournament_id: other, end_hole: 1,
    required_tee_shots: 0, course_id: courseId, tee_id: teeId };
  const roster = [squads[0]];
  const id = await saveSession(session, roster);
  const [card] = (await sessionState(id)).cards;
  await rpc(ids[1], 'select public.submit_texas_scramble_hole($1, 1, 4, $2)', [card.id, ids[1]]);
  const finalSession = await sessionState(id);
  assert.equal(finalSession.session.status, 'final');
  const match = { ...matchPayload('Final match'), tournament_id: other };
  const matchId = await save(match, [singles()]);
  const [segment] = (await matchState(matchId)).segments;
  for (let hole = 1; hole <= 10; ++hole) await submit(segment.id, hole, 'cardinal');
  const finalMatch = await matchState(matchId);
  assert.equal(finalMatch.match.status, 'final');
  await assert.rejects(saveSession({ ...session, id, name: 'Must not persist' }, roster), /final|played/i);
  await assert.rejects(save({ ...match, id: matchId, name: 'Must not persist' }, [singles()]), /final/i);

  await db.query(`insert into public.legacy_editions(edition_year, venue, destination, status, published)
    values ($1, 'Fixture course', 'Fixture trip', 'planned', false)`, [editionYear]);
  await rpc(ids[0], 'select public.complete_tournament_archive($1)', [other]);
  const archived = () => rows(`select r.* from public.legacy_results r join public.legacy_editions e on e.id = r.edition_id
    where e.source_tournament_id = $1 and e.published order by r.id`, [other]);
  const history = await archived();
  assert.deepEqual(history.map(r => r.source_segment_id).sort(), [segment.id, card.segment_id].sort());
  for (const fields of [{ id }, {}]) await assert.rejects(saveSession({ ...session, ...fields }, roster), /archiv|current/i);
  for (const fields of [{ id: matchId }, {}]) await assert.rejects(save({ ...match, ...fields }, [singles()]), /archiv|current/i);
  assert.deepEqual(await sessionState(id), finalSession);
  assert.deepEqual(await matchState(matchId), finalMatch);
  assert.deepEqual(await archived(), history);
});
