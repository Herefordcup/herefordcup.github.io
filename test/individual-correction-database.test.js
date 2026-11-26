import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMixedEntryFixture } from '../scripts/e2e/mixed-entry-fixture.mjs';
import { correctHoleScore } from '../src/supabase.js';

const reason = 'Organizer verified the submitted card';
const card = Array.from({ length: 18 }, (_, i) => ({ hole_number: i + 1, gross_score: 4 }));

async function fixture(t, options) {
  const f = await createMixedEntryFixture(options);
  t.after(() => f.db.close());
  const organizer = f.bluePartner; // Active tournament organizer, not a global admin or a score submitter.
  await f.as(f.admin, "select public.set_tournament_member_role($1,$2,'admin')", [f.tournament, organizer]);
  await f.as(f.admin, "update public.tournaments set status='live',starts_on='2099-03-20',ends_on='2099-03-21' where id=$1", [f.tournament]);
  await f.as(f.admin, `insert into public.legacy_editions(edition_year,venue,destination,status,published)
    values(2099,'Fixture links','Fixture destination','planned',false)`);
  const { id: match } = await f.plan({ backMode: 'individual_scores', outcomeFormat: 'singles' });
  const round = await f.openRound(f.blue, match);
  await f.saveScores(f.blue, round, card);
  const [submitted] = await f.as(organizer, 'select * from public.scores where round_id=$1 and hole_number=1', [round]);
  assert.ok(submitted.id);
  return { ...f, organizer, match, round, submitted };
}

async function finish(f) {
  await f.saveScores(f.white, await f.openRound(f.white, f.match), card);
  assert.equal((await f.complete(f.white, f.match)).finalized, true);
}

const standings = async f => (await f.db.query("select public.get_public_tournament_preview()->'totals' as totals")).rows[0].totals;
const state = async f => (await f.db.query(`select to_jsonb(t) as tournament, to_jsonb(m) as match, to_jsonb(e) as edition,
  (select jsonb_agg(l order by l.id) from public.legacy_results l where l.edition_id=e.id) as published_results,
  (select jsonb_agg(r order by r.id) from public.rounds r where r.match_id=m.id) as rounds,
  (select jsonb_agg(s order by s.id) from public.scores s join public.rounds r on r.id=s.round_id where r.match_id=m.id) as scores,
  (select jsonb_agg(s order by s.id) from public.match_segments s where s.match_id=m.id) as segments,
  (select jsonb_agg(a order by a.id) from public.score_correction_audit a join public.rounds r on r.id=a.round_id where r.match_id=m.id) as corrections,
  (select jsonb_agg(a order by a.event_sequence) from public.match_result_audit a where a.match_id=m.id) as history
  from public.matches m join public.tournaments t on t.id=m.tournament_id
  join public.legacy_editions e on e.edition_year=t.edition_year where m.id=$1`, [f.match])).rows[0];

async function upgradeFrom041(f) {
  const before = await state(f);
  const legacyContract = async () => (await f.db.query(`select oid,proowner,proacl::text from pg_proc
    where oid='public.correct_hole_score(uuid,integer,text,integer,boolean)'::regprocedure`)).rows[0];
  const original = await legacyContract();
  const apiGrants = async () => new Set((await f.db.query(`select roles.name || ':' || p.oid::regprocedure::text as grant_key
    from pg_proc p cross join (values ('anon'), ('authenticated'), ('service_role')) as roles(name)
    where p.pronamespace='public'::regnamespace and has_function_privilege(roles.name,p.oid,'EXECUTE')`)).rows.map(r => r.grant_key));
  const allowed = await apiGrants();
  allowed.add('authenticated:correct_hole_score(uuid,integer,text,integer,boolean,uuid)');
  const migration = await readFile(new URL('../supabase/migrations/042_individual_score_correction.sql', import.meta.url), 'utf8');
  for (let run = 0; run < 2; run++) {
    await f.db.exec(migration);
    assert.deepEqual(await state(f), before, 'Migration must not rewrite populated scorecards, audits or archives');
    assert.deepEqual(await legacyContract(), original, 'Existing SQL callers must keep the same function and its exact grants');
    assert.deepEqual(await apiGrants(), allowed, 'Only the equally guarded exact call may be added; neither helper is public');
  }
}

// Drive the real JS form contract into the local database. The synthetic client
// has no network; a committed score and its audits are read back independently.
function saveForm(f, grossScore, { exact = true } = {}) {
  const row = f.submitted;
  return correctHoleScore({ roundId: row.round_id, holeNumber: row.hole_number, reason, grossScore,
    ...(exact ? { expectedScoreId: row.id } : {}) }, {
    async rpc(name, a) {
      assert.equal(name, 'correct_hole_score');
      const args = [a.target_round_id, a.target_hole_number, a.target_reason, a.target_gross_score, a.delete_score];
      const hasId = Object.hasOwn(a, 'expected_score_id');
      if (hasId) args.push(a.expected_score_id);
      const [score] = await f.as(f.organizer,
        `select * from public.correct_hole_score(target_round_id => $1, target_hole_number => $2, target_reason => $3,
          target_gross_score => $4, delete_score => $5${hasId ? ', expected_score_id => $6' : ''})`, args);
      return { data: score };
    },
    from() { throw new Error('Offline audit read'); },
  });
}

for (const resubmitted of [false, true]) {
  test(`an open Edit form cannot ${resubmitted ? 'change a replacement submission' : 'recreate a removed submission'}`, async t => {
    const f = await fixture(t);
    await f.as(f.organizer, "select public.correct_hole_score($1,1,'Withdraw mistaken submission',null,true)", [f.round]);
    if (resubmitted) await f.saveScores(f.blue, f.round, [{ hole_number: 1, gross_score: 5 }]);
    const before = await state(f);
    assert.equal(before.corrections.length, 1);
    const replacement = before.scores.find(row => row.round_id === f.round && row.hole_number === 1);
    if (resubmitted) { assert.equal(replacement.gross_score, 5); assert.notEqual(replacement.id, f.submitted.id); }
    else assert.equal(replacement, undefined);
    await assert.rejects(saveForm(f, 3), /submitted score.*changed|no longer exists/i);
    assert.deepEqual(await state(f), before);
    if (!resubmitted) {
      const { score } = await saveForm(f, 3, { exact: false }); // An intentional legacy insert is still supported.
      assert.notEqual(score.id, f.submitted.id);
      assert.equal((await state(f)).corrections.find(a => a.score_id === score.id).action, 'insert');
    }
  });
}

test('publication freezes score, result, standings and audit for both old and exact forms', async t => {
  const f = await fixture(t);
  await finish(f);
  await f.as(f.organizer, 'select public.complete_tournament_archive($1)', [f.tournament]);
  for (const status of ['complete', 'archived']) {
    if (status === 'archived') await f.as(f.admin, "update public.tournaments set status='archived' where id=$1", [f.tournament]);
    const before = await state(f);
    assert.equal(before.tournament.status, status);
    assert.equal(before.edition.published, true);
    assert.deepEqual([before.edition.cardinal_total, before.edition.silver_total], [1.5, 1.5]);
    assert.equal(before.published_results.length, 2);
    for (const gross of [3, 4]) { // A same-value save must not write an audit either.
      for (const exact of [false, true]) {
        await assert.rejects(saveForm(f, gross, { exact }), /completed or archived tournament/i);
        assert.deepEqual(await state(f), before);
      }
    }
    if (status === 'complete') await f.as(f.organizer, 'select public.complete_tournament_archive($1)', [f.tournament]);
  }
});

for (const upgrade of [false, true]) {
  test(`${upgrade ? 'populated 041 upgrade' : 'clean install'}: exact individual replacement returns the same ID and one audited standings change`, async t => {
    const f = await fixture(t, upgrade ? { throughMigration: 41 } : {});
    // Keep a genuine old-client score correction and its audit across the upgrade.
    await f.as(f.organizer, "select public.correct_hole_score($1,2,'Confirmed card',4)", [f.round]);
    await finish(f);
    const before = await state(f);
    assert.equal(before.corrections.length, 1);
    if (upgrade) await upgradeFrom041(f);
    const oldPoints = await standings(f);
    assert.deepEqual([oldPoints.blue, oldPoints.white], [1.5, 1.5]);
    const { score } = await saveForm(f, 3);
    const after = await state(f);
    assert.deepEqual([score.id, score.round_id, score.hole_number, score.gross_score], [f.submitted.id, f.round, 1, 3]);
    const saved = after.scores.find(row => row.id === score.id);
    assert.deepEqual(after.scores, before.scores.map(row => row.id === score.id ? { ...row, gross_score: 3, updated_at: saved.updated_at } : row));
    assert.equal(after.corrections.length, before.corrections.length + 1);
    const [audit] = after.corrections.filter(a => a.score_id === score.id);
    assert.deepEqual([audit.action, audit.old_gross_score, audit.new_gross_score, audit.correction_reason, audit.corrected_by], ['update', 4, 3, reason, f.organizer]);
    assert.equal(after.history.length, before.history.length + 1);
    assert.deepEqual([after.history.at(-1).action, after.history.at(-1).change_reason, after.history.at(-1).changed_by], ['recalculated', reason, f.organizer]);
    const newPoints = await standings(f);
    assert.deepEqual([newPoints.blue, newPoints.white], [2, 1]);
  });
}

test('upgrading a published 041 edition keeps its score and archive frozen', async t => {
  const f = await fixture(t, { throughMigration: 41 });
  await finish(f);
  await f.as(f.organizer, 'select public.complete_tournament_archive($1)', [f.tournament]);
  await upgradeFrom041(f);
  const before = await state(f);
  await assert.rejects(saveForm(f, 3), /completed or archived tournament/i);
  assert.deepEqual(await state(f), before);
});

test('both authorized correction calls hold the archive lock until commit', async t => {
  const f = await fixture(t);
  for (const exact of [false, true]) {
    await f.db.transaction(async tx => {
      await tx.exec('set local role authenticated');
      await tx.query("select set_config('request.jwt.claim.sub',$1,true), set_config('request.jwt.claim.role','authenticated',true)", [f.organizer]);
      await tx.query(`select * from public.correct_hole_score($1,1,$2,4,false${exact ? ',expected_score_id => $3' : ''})`,
        exact ? [f.round, reason, f.submitted.id] : [f.round, reason]);
      assert.equal((await tx.query(`select exists(select 1 from pg_locks where pid=pg_backend_pid() and locktype='advisory'
        and granted and mode='ExclusiveLock' and objsubid=1
        and ((classid::bigint << 32) | objid::bigint)=hashtextextended($1::text,0)) as held`, [f.tournament])).rows[0].held, true);
    });
  }
});

test('the global organizer can still use the old call for standalone and pre-edition cards', async t => {
  const f = await createMixedEntryFixture();
  t.after(() => f.db.close());
  const standalone = await f.openRound(f.blue, null);
  // Pre-edition match/round fixture, as originally permitted by migration 001.
  const { rows: [match] } = await f.db.query(`insert into public.matches(name,session,format,scoring_mode,course_id)
    values('Pre-edition fixture','Morning','singles','gross',$1) returning id`, [f.tee.course_id]);
  const { rows: [legacy] } = await f.db.query(`insert into public.rounds(user_id,match_id,course_id,tee_id)
    values($1,$2,$3,$4) returning id`, [f.blue, match.id, f.tee.course_id, f.tee.id]);
  for (const round of [standalone, legacy.id]) {
    const [added] = await f.as(f.admin, 'select * from public.correct_hole_score($1,1,$2,4)', [round, reason]);
    const [updated] = await f.as(f.admin, 'select * from public.correct_hole_score($1,1,$2,5,false)', [round, reason]);
    const [removed] = await f.as(f.admin, 'select * from public.correct_hole_score($1,1,$2,null,true)', [round, reason]);
    assert.deepEqual([updated.id, removed.id, updated.gross_score], [added.id, added.id, 5]);
    assert.deepEqual((await f.db.query('select action from public.score_correction_audit where round_id=$1 order by corrected_at', [round])).rows.map(a => a.action), ['insert','update','delete']);
    assert.deepEqual((await f.db.query('select id from public.scores where round_id=$1', [round])).rows, []);
  }
});
