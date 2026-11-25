import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createMixedEntryFixture } from '../scripts/e2e/mixed-entry-fixture.mjs';

const root = new URL('../', import.meta.url);
const origin = 'http://127.0.0.1';
let f, browser;
before(async () => {
  f = await createMixedEntryFixture();
  browser = await chromium.launch({ channel: 'chrome' });
});
after(async () => { try { await browser?.close(); } finally { await f?.db.close(); } });

// No HTTP requests leave Playwright's router. Only the session/data transport
// is substituted; the DOM, controls and click handlers are the shipped portal.
// Each score write uses its page's ordinary player role in the in-memory DB.
async function localAssets(page, transport) {
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || !/^\/((?:admin|portal)\.html|[\w-]+\.css|src\/[\w-]+\.js|assets\/icon\.svg)$/.test(url.pathname)) return route.abort();
    if (url.pathname === '/src/config.js') return route.fulfill({ contentType: 'text/javascript', body: "export const hasSupabaseConfig=()=>true, SUPABASE_URL=location.origin, SUPABASE_PUBLISHABLE_KEY='';" });
    if (url.pathname === '/src/supabase.js' && url.search !== '?fixture-original') return route.fulfill({ contentType: 'text/javascript', body: transport });
    const type = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml' }[url.pathname.split('.').at(-1)];
    return route.fulfill({ contentType: type, body: await readFile(new URL(url.pathname.slice(1), root)) });
  });
}

async function openPlayer(user, matchId, width, saveProfile = async () => {}) {
  const page = await browser.newPage({ viewport: { width, height: 850 }, serviceWorkers: 'block' });
  const rows = async (sql, params) => (await f.db.query(sql, params)).rows;
  const roundRows = () => rows(`select r.*, coalesce((select jsonb_agg(s order by s.hole_number) from public.scores s
    where s.round_id=r.id),'[]') as scores from public.rounds r where r.match_id=$1 and r.user_id=$2`, [matchId, user]);
  const [match] = await rows('select * from public.matches where id=$1', [matchId]);
  const [tournament] = await rows('select * from public.tournaments where id=$1', [match.tournament_id]);
  const membership = { team: f.players.find(p => p.user_id === user).team, status: 'active', role: 'player', tournaments: tournament };
  const holes = await rows('select * from public.holes where tee_id=$1 order by hole_number', [f.tee.id]);
  const data = async () => ({
    profile: { id: user, display_name: 'Fixture player', role: 'player', handicap_index: null }, memberships: [membership], tournament,
    assignments: [{ team: membership.team, matches: match }], matches: [match], courses: [{ id: f.tee.course_id, name: 'Fixture links', tees: [{ ...f.tee, holes }] }],
    segments: await rows(`select s.*, (select jsonb_agg(p) from public.match_segment_players p where p.segment_id=s.id) match_segment_players
      from public.match_segments s where s.match_id=$1 order by s.segment_number`, [matchId]),
    rounds: await roundRows(), holeOutcomes: await rows(`select o.* from public.match_hole_outcomes o join public.match_segments s on s.id=o.segment_id where s.match_id=$1`, [matchId]),
    events: [], rules: [], statistics: [], commentaries: [], players: [], scrambleSquads: [],
  });
  await page.exposeFunction('fixtureData', data);
  await page.exposeFunction('fixtureProfile', saveProfile);
  await page.exposeFunction('fixtureOutcome', ({ segmentId, holeNumber, winner }) => f.saveOutcome(user, segmentId, holeNumber, winner));
  await page.exposeFunction('fixtureComplete', id => f.complete(user, id));
  await page.exposeFunction('fixtureRound', async ({ userId, matchId: selected, teeId, courseId, scores, existingRound }) => {
    assert.deepEqual([userId, selected, teeId, courseId], [user, matchId, f.tee.id, f.tee.course_id]);
    const round = existingRound?.id ?? await f.openRound(user, matchId);
    await f.saveScores(user, round, scores);
    return (await roundRows())[0];
  });
  const transport = `export * from './supabase.js?fixture-original';
    export const getCurrentSession = async () => ({user: {id: ${JSON.stringify(user)}}});
    export const loadPlayerData = window.fixtureData, submitMatchHoleOutcome = window.fixtureOutcome,
      saveRound = window.fixtureRound, completeMatchIfReady = window.fixtureComplete;
    export const requestTournamentMembership = async () => {}, saveProfile = window.fixtureProfile,
      loadOwnTournamentMemberships = async () => (await window.fixtureData()).memberships;`;
  await localAssets(page, transport);
  await page.goto(`${origin}/portal.html`);
  await page.locator('[data-member-view="score"]').click();
  return page;
}

test('players can play a mixed Singles / hole-winner Foursomes match from the actual controls', async () => {
  const { id } = await f.plan({ outcomeFormat: 'foursomes' });
  const blue = await openPlayer(f.blue, id, 390);
  const white = await openPlayer(f.white, id, 1200);
  const partner = await openPlayer(f.whitePartner, id, 390);
  await expect(partner.locator('#holeOutcomeScorecard')).toBeVisible();
  await expect(partner.locator('#saveRound')).toBeHidden();
  await partner.locator('#matchSelect').selectOption('');
  await partner.locator('#courseSelect').selectOption(f.tee.course_id);
  await partner.locator('#teeSelect').selectOption(f.tee.id);
  await partner.locator('#holeRangeSelect').selectOption('18');
  await expect(partner.locator('#scorecard input:visible')).toHaveCount(18);
  await expect(partner.locator('#saveRound')).toBeVisible();
  await expect(partner.locator('#holeOutcomeScorecard')).toBeHidden();
  await partner.locator('#matchSelect').selectOption(id);
  await expect(partner.locator('#saveRound')).toBeHidden();
  for (const page of [blue, white]) {
    await page.locator('#teeSelect').selectOption(f.tee.id);
    const grossInputs = page.locator('#scorecard input:visible');
    assert.deepEqual(await grossInputs.evaluateAll(inputs => inputs.map(i => i.getAttribute('aria-label'))),
      Array.from({ length: 9 }, (_, i) => `Hole ${i + 1} gross score`), 'no gross control for an outcome hole');
    assert.deepEqual(await page.locator('#holeOutcomeRows .hole-id:visible').allTextContents(), Array.from({ length: 9 }, (_, i) => String(i + 10)));
    await expect(page.locator('#saveRound')).toBeVisible();
  }
  const outcomeRow = (page, hole) => page.locator('#holeOutcomeRows .outcome-hole-row').nth(hole - 10);
  const winner = async (page, hole) => {
    const row = outcomeRow(page, hole);
    await row.locator('select').selectOption('silver');
    await row.getByRole('button', { name: 'Save hole' }).click();
    await expect(row.locator('select')).toBeDisabled();
  };
  await blue.getByLabel('Hole 1 gross score', { exact: true }).fill('3');
  await winner(blue, 10);
  await expect(blue.getByLabel('Hole 1 gross score', { exact: true })).toHaveValue('3');
  await expect(blue.locator('#grossTotal')).toHaveText('3');
  await outcomeRow(blue, 11).locator('select').selectOption('halved'); // Not yet submitted.
  // Blank handicap is valid: this player's net segment records winners only.
  for (const [page, gross] of [[blue, '3'], [white, '4']]) {
    for (let hole = 1; hole <= 9; hole++) await page.getByLabel(`Hole ${hole} gross score`, { exact: true }).fill(gross);
    await page.locator('#saveRound').click();
    await expect(page.locator('#scorecard input[readonly]')).toHaveCount(9);
    if (page === blue) await expect(outcomeRow(blue, 11).locator('select')).toHaveValue('halved');
  }
  for (let hole = 11; hole <= 14; hole++) await winner(partner, hole);
  await expect(outcomeRow(partner, 15).locator('select')).toBeDisabled(); // Early finish: no more winner entries.
  await expect(partner.locator('#saveMessage')).toContainText('Match complete.');
  assert.equal((await f.db.query('select status from public.matches where id=$1', [id])).rows[0].status, 'final');
  const readback = (await f.db.query(`select r.user_id, array_agg(s.hole_number order by s.hole_number) as holes,
    sum(s.gross_score)::int as total from public.rounds r join public.scores s on s.round_id=r.id where r.match_id=$1
    group by r.user_id order by total`, [id])).rows;
  assert.deepEqual(readback, [f.blue, f.white].map((user, i) => ({ user_id: user, holes: [1,2,3,4,5,6,7,8,9], total: i ? 36 : 27 })));
  const outcomes = (await f.db.query(`select o.hole_number,o.winner,o.submitted_by from public.match_hole_outcomes o
    join public.match_segments s on s.id=o.segment_id where s.match_id=$1 order by o.hole_number`, [id])).rows;
  assert.deepEqual(outcomes, [10,11,12,13,14].map(h => ({ hole_number: h, winner: 'silver', submitted_by: h === 10 ? f.blue : f.whitePartner })));
});

test('a last individual save closes even a stale local hole-winner panel', async () => {
  const { id, outcome } = await f.plan();
  const white = await openPlayer(f.white, id, 1200);
  await white.locator('#teeSelect').selectOption(f.tee.id);
  await f.saveScores(f.blue, await f.openRound(f.blue, id), Array.from({ length: 9 }, (_, i) => ({ hole_number: i + 1, gross_score: 3 })));
  for (let hole = 10; hole <= 14; hole++) await f.saveOutcome(f.whitePartner, outcome.id, hole, 'silver');
  for (let hole = 1; hole <= 9; hole++) await white.getByLabel(`Hole ${hole} gross score`, { exact: true }).fill('4');
  await white.locator('#saveRound').click();
  await expect(white.locator('#saveMessage')).toContainText('Match complete.');
  await expect(white.locator('#holeOutcomeRows select:enabled')).toHaveCount(0);
  assert.equal((await f.db.query('select status from public.matches where id=$1', [id])).rows[0].status, 'final');
});

test('switching to standalone during a mixed score save cannot redirect the submitted hole', async () => {
  const { id } = await f.plan();
  let signalStart, resume;
  const started = new Promise(resolve => { signalStart = resolve; });
  const hold = new Promise(resolve => { resume = resolve; });
  const page = await openPlayer(f.blue, id, 390, async () => { signalStart(); await hold; });
  await page.locator('#teeSelect').selectOption(f.tee.id);
  await page.getByLabel('Hole 1 gross score', { exact: true }).fill('3');
  await page.locator('#saveRound').click();
  await started;
  await page.locator('#matchSelect').selectOption('');
  resume();
  await expect.poll(async () => (await f.db.query(`select r.match_id,s.hole_number,s.gross_score from public.rounds r
    join public.scores s on s.round_id=r.id where r.user_id=$1 and r.match_id=$2`, [f.blue,id])).rows)
    .toEqual([{ match_id: id, hole_number: 1, gross_score: 3 }]);
  await expect(page.locator('#holeOutcomeScorecard')).toBeHidden();
  await expect(page.locator('#scorecard input[readonly]:visible')).toHaveCount(0);
});

test('Record Foursomes result is available only for a genuine manual Foursomes segment', async () => {
  const outcome = await f.plan({ outcomeFormat: 'foursomes' });
  const manual = await f.plan({ outcomeFormat: 'foursomes', backMode: 'individual_scores' });
  const matches = [outcome, manual].map(m => ({ id: m.id, name: 'Fixture match', status: 'scheduled', match_segments: [m.individual, m.outcome] }));
  const page = await browser.newPage({ serviceWorkers: 'block' });
  await localAssets(page, `export * from './supabase.js?fixture-original';
    export const getCurrentSession = async () => ({user: {id: ${JSON.stringify(f.admin)}}}),
      loadPlayerData = async () => ({profile: {role:'admin'}, memberships: []}), loadMatchResultAudits = async () => [], loadTeamCorrectionAudits = async () => [],
      loadAdminData = async () => ({matches:${JSON.stringify(matches)},tournaments:[],memberships:[],courses:[],rules:[],settings:[],rounds:[],scrambleSessions:[],legacyEditions:[],commentaries:[]});`);
  await page.goto(`${origin}/admin.html`);
  await expect(page.locator('#adminContent')).toBeVisible();
  const button = page.locator('#resultFinalizationForm button[type="submit"]');
  await page.locator('#resultMatch').selectOption(manual.id);
  await expect(button).toBeVisible();
  await page.locator('#resultMatch').selectOption(outcome.id);
  await expect(button).toBeHidden();
});
