import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';

const origin = 'http://127.0.0.1';
const root = new URL('../', import.meta.url);
const edit = 'button[data-edit-hole][data-entry-id]';
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome' }); });
after(async () => { await browser?.close(); });

function memberCard() {
  const tournament = { id: 'cup', name: 'Fixture Cup', status: 'live', edition_year: 2027 };
  const match = { id: 'mixed', name: 'Mixed card', tournament_id: 'cup', course_id: 'links', status: 'live', format: 'singles', scoring_mode: 'gross' };
  const segments = [[1, 2, 'individual_scores'], [3, 4, 'hole_outcomes']].map(([start_hole, end_hole, entry_mode], i) => ({
    id: `segment-${i}`, match_id: match.id, start_hole, end_hole, entry_mode, format: 'singles', scoring_mode: 'gross',
    status: 'live', holes_played: 0, differential: 0, point_value: 1, match_segment_players: [{ user_id: 'member', side: 'cardinal' }],
  }));
  const holes = Array.from({ length: 4 }, (_, i) => ({ hole_number: i + 1, par: 4, yardage: 360, stroke_index: i + 1 }));
  return {
    tournament, memberships: [{ status: 'active', role: 'admin', tournaments: tournament }], profile: { id: 'member', display_name: 'Fixture golfer', role: 'player' },
    assignments: [{ matches: match, team: 'cardinal' }], matches: [match], segments,
    courses: [{ id: 'links', name: 'Links', tees: [{ id: 'tee', name: 'White', par: 72, rating: 72, slope: 113, holes }] }],
    rounds: [{ id: 'round', match_id: match.id, user_id: 'member', course_id: 'links', tee_id: 'tee',
      scores: [{ id: 'score', round_id: 'round', hole_number: 1, gross_score: 5 }] }],
    holeOutcomes: [{ id: 'outcome', segment_id: 'segment-1', hole_number: 3, winner: 'silver' }],
    scrambleSquads: [], events: [], players: [], rules: [], statistics: [], commentaries: [],
  };
}

function addScramble(data) {
  const match = { ...data.matches[0], id: 'texas', name: 'Scramble card', format: 'scramble' };
  data.matches.push(match);
  data.assignments.push({ matches: match, team: 'cardinal' });
  data.scrambleSquads.push({ id: 'squad', match_id: 'texas', side: 'cardinal', label: 'Shared card',
    texas_scramble_sessions: { tournament_id: 'cup', course_id: 'links', tee_id: 'tee', start_hole: 1, end_hole: 4, required_tee_shots: 1 },
    texas_scramble_squad_players: [{ user_id: 'member', profiles: { display_name: 'Fixture golfer' } }, { user_id: 'partner', profiles: { display_name: 'Fixture partner' } }],
    texas_scramble_hole_scores: [{ id: 'drive', squad_id: 'squad', hole_number: 1, gross_score: 4, tee_shot_player_id: 'member' }],
  });
  return data;
}

// All assets and transport stay inside the router. The editor boundary records
// the target/callbacks; the actual portal owns every scorecard DOM interaction.
async function openPortal(t, { data = memberCard(), width = 390, archived = false, hooks = {} } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 800 }, serviceWorkers: 'block' });
  t.after(() => page.close());
  const calls = [];
  const read = async (table, filters) => {
    calls.push([table, filters]);
    await hooks.beforeRead?.(table);
    const entries = { scores: data.rounds.flatMap(round => round.scores), match_hole_outcomes: data.holeOutcomes,
      texas_scramble_hole_scores: data.scrambleSquads.flatMap(squad => squad.texas_scramble_hole_scores) };
    if (table in entries) return { data: entries[table].find(row => Object.entries(filters).every(([k,v]) => row[k] === v)) ?? null, error: null };
    if (table === 'profiles') { assert.deepEqual(filters, { id: 'member' }); return { data: { role: data.profile.role }, error: null }; }
    if (table === 'commentary_settings') return { data: { enabled: Boolean(hooks.commentary) }, error: null };
    assert.equal(table, 'tournaments');
    assert.deepEqual(filters, { id: data.tournament.id });
    return { data: { id: data.tournament.id, status: data.tournament.status, legacy_editions: archived ? [{ id: 'archive' }] : [] }, error: null };
  };
  await page.exposeFunction('fixtureRead', read);
  await page.exposeFunction('fixtureData', async () => { await hooks.beforeLoad?.(); return structuredClone(data); });
  await page.exposeFunction('fixtureWrite', (method, payload) => {
    calls.push([method, payload]);
    if (hooks.write) return hooks.write(method, payload);
    throw new Error(`Unexpected write: ${method}`);
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || !/^\/(?:portal\.html|[\w-]+\.css|src\/[\w-]+\.js|assets\/icon\.svg)$/.test(url.pathname)) return route.abort();
    const js = body => route.fulfill({ contentType: 'text/javascript', body });
    if (url.pathname === '/src/config.js') return js("export const hasSupabaseConfig=()=>true, SUPABASE_URL=location.origin, SUPABASE_PUBLISHABLE_KEY='';");
    if (url.pathname === '/src/supabase.js' && url.search !== '?original') return js(`export * from './supabase.js?original';
      export const getCurrentSession = async () => ({ user: { id: 'member' } }), requestTournamentMembership = async () => {},
        loadOwnTournamentMemberships = async () => (await window.fixtureData()).memberships, loadPlayerData = window.fixtureData;
      export const correctHoleScore = p => window.fixtureWrite('correctHoleScore',p), correctTeamScoreEntry = p => window.fixtureWrite('correctTeamScoreEntry',p),
        generateMatchCommentary = (matchId,options) => window.fixtureWrite('generateMatchCommentary',{matchId,...options});
      export const getSupabase = async () => ({from(table){const filters={};return {select(){return this},eq(key,value){filters[key]=value;return this},
        maybeSingle(){return window.fixtureRead(table,filters)},single(){return window.fixtureRead(table,filters)}}}});`);
    if (url.pathname === '/src/scorecard-hole-editor.js') {
      calls.push(['editor import', url.search]);
      return js(`export function createHoleEditor(callbacks) { return {open(target,trigger){window.edited = {target,trigger,callbacks}}}; }`);
    }
    const contentType = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml' }[url.pathname.split('.').at(-1)];
    return route.fulfill({ contentType, body: await readFile(new URL(url.pathname.slice(1), root)) });
  });
  await page.goto(`${origin}/portal.html`);
  await expect(page.locator('#dashboardView:not([hidden]),#accessPendingView:not([hidden])')).toHaveCount(1);
  if (await page.locator('#dashboardView').isVisible()) await page.locator('[data-member-view="score"]').click();
  return { page, calls, data };
}

test('an exact-tournament organizer opens the submitted individual hole, not a picker or a draft', async t => {
  const { page, calls } = await openPortal(t);
  const button = page.locator(`#scorecard ${edit}[data-entry-id="score"][data-hole="1"][data-round-id="round"]`);
  await expect(page.locator('#scorecard input[readonly]')).toHaveCount(1);
  await expect(button).toHaveText('Edit', { timeout: 1200 });
  await expect(button).toHaveAccessibleName(/edit.*hole 1/i);
  await expect(page.locator(`#scorecard ${edit}`)).toHaveCount(1);
  assert.equal(calls.some(([name]) => name === 'editor import'), false);
  await button.click();
  await page.waitForFunction(() => window.edited);
  const { kind, matchId, roundId, row, label } = await page.evaluate(() => window.edited.target);
  assert.deepEqual([kind, matchId, roundId, row.id, row.hole_number, row.gross_score], ['individual', 'mixed', 'round', 'score', 1, 5]);
  assert.match(label, /Mixed card/);
  assert.deepEqual(calls.filter(([tag]) => tag === 'editor import'), [['editor import', '?v=compact-scorecard-1']]);
  await page.locator('#matchSelect').selectOption('');
  await expect(page.locator(edit)).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.edited.callbacks.canEdit(window.edited.target)), false);
});

for (const width of [390, 1200]) test(`shared cards send the precise outcome or gross + squad drivers to Edit at ${width}px`, async t => {
  const data = addScramble(memberCard());
  data.profile.role = 'admin';
  data.memberships[0].role = 'player'; // Global administrator, not tournament organizer.
  const { page } = await openPortal(t, { data, width });
  const outcome = page.locator(`#holeOutcomeRows ${edit}`);
  await expect(outcome).toHaveCount(1, { timeout: 1200 });
  await expect(outcome).toHaveAttribute('data-hole', '3');
  await outcome.click();
  await page.waitForFunction(() => window.edited?.target.kind === 'match_hole_outcome');
  assert.deepEqual(await page.evaluate(() => [window.edited.target.matchId, window.edited.target.row.id, window.edited.target.row.winner]), ['mixed', 'outcome', 'silver']);
  await page.locator('#matchSelect').selectOption('texas');
  const drive = page.locator(`#teamScorecardRows ${edit}[data-entry-id="drive"][data-hole="1"]`);
  await expect(page.locator(edit)).toHaveCount(1);
  await expect(drive).toBeVisible();
  await drive.click();
  await page.waitForFunction(() => window.edited?.target.kind === 'texas_scramble_hole');
  const target = await page.evaluate(() => window.edited.target);
  assert.deepEqual([target.matchId, target.row.id, target.row.gross_score, target.row.tee_shot_player_id, target.players],
    ['texas', 'drive', 4, 'member', [{ id: 'member', name: 'Fixture golfer' }, { id: 'partner', name: 'Fixture partner' }]]);
  const rect = await drive.boundingBox();
  assert.ok(rect.x >= 0 && rect.x + rect.width <= width, 'the row action fits the viewport');
  assert.ok(rect.height >= 32, 'the compact Edit still has a usable touch target');
  await expect(page.locator('#saveMessage')).toHaveAttribute('role', 'status');
  await page.locator('#matchSelect').selectOption('');
  await expect(page.locator(edit)).toHaveCount(0);
});

for (const scope of ['player phone', 'player desktop', 'pending', 'different tournament', 'foreign match', 'complete', 'published']) {
  test(`${scope}: no Edit nodes and no editor request`, async t => {
    const data = addScramble(memberCard());
    if (scope.startsWith('player')) data.memberships[0].role = 'player';
    if (scope === 'pending') data.memberships[0].status = 'pending';
    if (scope === 'different tournament') {
      data.memberships[0].role = 'player';
      data.memberships.push({ role: 'admin', status: 'active', tournaments: { ...data.tournament, id: 'other', status: 'setup' } });
    }
    if (scope === 'foreign match') for (const match of data.matches) match.tournament_id = 'other';
    if (scope === 'complete') { data.tournament.status = 'complete'; data.profile.role = 'admin'; }
    const { page, calls } = await openPortal(t, { data, archived: scope === 'published', width: scope === 'player desktop' ? 1200 : 390 });
    if (scope !== 'pending') {
      await expect(page.locator('#scorecard input[readonly]')).toHaveCount(1);
      await expect(page.locator(edit)).toHaveCount(0);
      await page.locator('#matchSelect').selectOption('texas');
      await expect(page.getByRole('button', { name: 'Locked', exact: true })).toBeDisabled();
    } else await expect(page.locator('#accessPendingView')).toBeVisible();
    await expect(page.locator(edit)).toHaveCount(0);
    assert.equal(calls.some(([name]) => name === 'editor import'), false);
    if (scope !== 'published') assert.deepEqual(calls, [], 'no correction-specific data fetched');
  });
}

async function saveCaptured(page, method, payload) {
  return page.evaluate(async ({ method, payload }) => {
    const { callbacks, target } = window.edited;
    if (!callbacks.canEdit(target)) throw new Error('Target no longer editable');
    const result = await callbacks[method](payload);
    const warning = await callbacks.onSaved(target, result);
    callbacks.notify(warning ? `Correction saved. ${warning}` : 'Correction saved.', false, target);
    return warning || '';
  }, { method, payload });
}

test('mixed readback refreshes only the submitted card and standings, preserving drafts and the Edit focus target', async t => {
  const data = addScramble(memberCard());
  data.segments.push({ ...data.segments[0], id: 'another-result', match_id: 'texas', point_value: 2 });
  const hooks = { write(method, payload) {
    assert.equal(method, 'correctHoleScore');
    const row = data.rounds[0].scores[0];
    row.gross_score = payload.grossScore;
    Object.assign(data.segments[0], { status: 'final', holes_played: 2, differential: -1 });
    Object.assign(data.segments.at(-1), { status: 'final', holes_played: 2, differential: 1 }); // A different card also finished.
    return { score: { ...row }, audit: { action: 'update' } };
  } };
  const { page, calls } = await openPortal(t, { data, hooks });
  const draft = page.getByLabel('Hole 2 gross score');
  await draft.fill('6');
  const draftOutcome = page.locator('#holeOutcomeRows select').last();
  await draftOutcome.selectOption('halved');
  const button = page.locator(`${edit}[data-entry-id="score"]`);
  await button.click();
  await page.waitForFunction(() => window.edited);
  const payload = { roundId: 'round', holeNumber: 1, grossScore: 3, reason: 'Signed card', deleteScore: false };
  assert.equal(await saveCaptured(page, 'correctHoleScore', payload), '');
  await expect(page.getByLabel('Hole 1 gross score')).toHaveValue('3');
  await expect(draft).toHaveValue('6');
  await expect(page.locator('#grossTotal')).toHaveText('9');
  await expect(draftOutcome).toHaveValue('halved');
  await expect(page.locator('#cupScorePreview strong')).toHaveText(['2', '1']);
  await expect(page.locator('#matchSelect')).toHaveValue('mixed');
  assert.equal(await page.evaluate(() => window.edited.trigger.isConnected), true, 'keep the actual focus-return target');
  await button.click();
  await expect.poll(() => page.evaluate(() => window.edited.target.row.gross_score)).toBe(3);
  assert.deepEqual(calls.filter(([op]) => op.startsWith('correct')), [['correctHoleScore', payload]]);
});

const individualPayload = { roundId: 'round', holeNumber: 1, grossScore: 3, reason: 'Signed card', deleteScore: false };
const openIndividual = async page => {
  await page.locator(`${edit}[data-entry-id="score"]`).click();
  await page.waitForFunction(() => window.edited?.target.row.id === 'score');
};

test('a deleted or replaced individual ID is not recreated by the live round/hole RPC', async t => {
  const { page, data, calls } = await openPortal(t);
  await openIndividual(page);
  data.rounds[0].scores[0].id = 'another-submission'; // Same round and hole, different DB row.
  await assert.rejects(saveCaptured(page, 'correctHoleScore', individualPayload), /no longer|changed/i);
  assert.deepEqual(calls.filter(([op]) => op.startsWith('correct')), []);
  await expect(page.locator(`${edit}[data-entry-id="score"]`)).toHaveCount(0);
});

function gate() {
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  return { started, release, hold: () => { start(); return wait; } };
}

test('changing cards after a committed write cannot move focus, report success on, or rewrite the new card', async t => {
  const data = addScramble(memberCard());
  const delay = gate();
  const hooks = { write(method, p) {
    assert.equal(method, 'correctHoleScore');
    const row = data.rounds[0].scores[0];
    row.gross_score = p.grossScore;
    hooks.beforeLoad = delay.hold;
    return { score: row };
  } };
  const { page, calls } = await openPortal(t, { data, hooks, width: 1200 });
  await openIndividual(page);
  const pending = saveCaptured(page, 'correctHoleScore', individualPayload);
  await delay.started;
  await page.locator('#matchSelect').selectOption('texas');
  const otherInput = page.locator('#teamScorecardRows input').nth(1);
  await otherInput.fill('7');
  const message = await page.locator('#saveMessage').textContent();
  delay.release();
  await pending;
  await expect(otherInput).toBeFocused();
  await expect(otherInput).toHaveValue('7');
  await expect(page.locator('#saveMessage')).toHaveText(message);
  await page.locator('#matchSelect').selectOption('mixed');
  await expect(page.getByLabel('Hole 1 gross score')).toHaveValue('3');
  assert.deepEqual(calls.filter(([op]) => op.startsWith('correct')), [['correctHoleScore', individualPayload]]);
});

test('Texas drive + gross readback preserves a different unsaved drive, score and focus on desktop', async t => {
  const data = addScramble(memberCard());
  const { page, calls } = await openPortal(t, { data, width: 1200, hooks: { write(method, p) {
    assert.equal(method, 'correctTeamScoreEntry');
    const row = data.scrambleSquads[0].texas_scramble_hole_scores[0];
    return Object.assign(row, { gross_score: p.grossScore, tee_shot_player_id: p.teeShotPlayerId });
  } } });
  await page.locator('#matchSelect').selectOption('texas');
  const drafts = page.locator('#teamScorecardRows .team-hole-row').nth(1);
  await drafts.locator('input').fill('6');
  await drafts.locator('select').selectOption('member');
  await page.locator(`${edit}[data-entry-id="drive"]`).click();
  await page.waitForFunction(() => window.edited);
  const payload = { targetType: 'texas_scramble_hole', targetId: 'drive', grossScore: 3, teeShotPlayerId: 'partner', reason: 'Reviewed drive' };
  assert.equal(await saveCaptured(page, 'correctTeamScoreEntry', payload), '');
  await expect(page.locator('#teamScorecardRows input:disabled')).toHaveValue('3');
  await expect(page.locator('#teamScorecardRows select:disabled')).toHaveValue('partner');
  await expect(page.locator('#teeShotProgress')).toContainText('Fixture partner: 1 of 1');
  await expect(drafts.locator('input')).toHaveValue('6');
  await expect(drafts.locator('select')).toHaveValue('member');
  await expect(page.locator(`${edit}[data-entry-id="drive"]`)).toBeFocused();
  assert.deepEqual(calls.filter(([op]) => op.startsWith('correct')), [['correctTeamScoreEntry', payload]]);
});

test('readback outage reports a saved-with-warning outcome and keeps the confirmed row instead of retrying the write', async t => {
  const data = memberCard();
  const hooks = { write(method, p) {
    const row = data.holeOutcomes[0];
    row.winner = p.winner;
    hooks.beforeLoad = () => { throw new Error('Readback offline'); };
    return { ...row };
  } };
  const { page, calls } = await openPortal(t, { data, hooks });
  await page.locator(`${edit}[data-entry-id="outcome"]`).click();
  await page.waitForFunction(() => window.edited);
  const payload = { targetType: 'match_hole_outcome', targetId: 'outcome', winner: 'cardinal', reason: 'Card verified' };
  assert.match(await saveCaptured(page, 'correctTeamScoreEntry', payload), /readback|refresh/i);
  await expect(page.locator('#saveMessage')).toContainText(/saved.*offline/i);
  await expect(page.locator('#holeOutcomeRows select:disabled')).toHaveValue('cardinal');
  assert.deepEqual(calls.filter(([op]) => op.startsWith('correct')), [['correctTeamScoreEntry', payload]]);
});

for (const enabled of [true, false]) test(`an assigned match that finalized since opening regenerates its recap only when enabled (${enabled})`, async t => {
  const data = memberCard();
  data.segments.splice(1);
  const hooks = { commentary: enabled, write(method, p) {
    if (method === 'generateMatchCommentary') return { id: 'recap', match_id: 'mixed', status: 'approved', commentary: 'Updated fixture recap.' };
    const row = data.rounds[0].scores[0];
    row.gross_score = p.grossScore;
    data.matches[0].status = data.segments[0].status = 'final';
    return { score: row };
  } };
  const { page, calls } = await openPortal(t, { data, hooks });
  await openIndividual(page);
  assert.equal(await saveCaptured(page, 'correctHoleScore', individualPayload), '');
  await expect(page.locator('#cupMatchList')).toContainText('FINAL');
  await expect(page.locator('#liveMatchLabel')).not.toHaveText('LIVE NOW', { timeout: 1200 });
  const expected = enabled ? [['generateMatchCommentary', { matchId: 'mixed', regenerate: true }]] : [];
  assert.deepEqual(calls.filter(([op]) => op === 'generateMatchCommentary'), expected);
  assert.deepEqual(calls.filter(([op]) => op === 'commentary_settings'), [['commentary_settings', { tournament_id: 'cup' }]]);
  if (enabled) await expect(page.locator('#recentResults .result-commentary')).toHaveText(/Updated fixture recap/);
});

test('refreshing an organizer demotion removes the actual buttons and disables an already open edit without losing drafts', async t => {
  const { page, data, calls } = await openPortal(t);
  await openIndividual(page);
  const draft = page.getByLabel('Hole 2 gross score');
  await draft.fill('8');
  data.memberships[0].role = 'player';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator(edit)).toHaveCount(0, { timeout: 1300 });
  await expect(draft).toHaveValue('8');
  assert.equal(await page.evaluate(() => window.edited.callbacks.canEdit(window.edited.target)), false);
  assert.deepEqual(calls.filter(([op]) => op.startsWith('correct')), []);
});

test('a newly final card keeps unsubmitted selections visible but will not accept another player submission', async t => {
  const data = memberCard();
  const { page } = await openPortal(t, { data, hooks: { write(method, p) {
    const row = data.holeOutcomes[0];
    row.winner = p.winner;
    data.matches[0].status = 'final';
    return row;
  } } });
  const draft = page.getByLabel('Hole 2 gross score');
  await draft.fill('8');
  const outcome = page.locator('#holeOutcomeRows select').last();
  await outcome.selectOption('halved');
  await page.locator(`${edit}[data-entry-id="outcome"]`).click();
  await page.waitForFunction(() => window.edited);
  await saveCaptured(page, 'correctTeamScoreEntry', { targetType: 'match_hole_outcome', targetId: 'outcome', winner: 'cardinal', reason: 'Verified' });
  await expect(draft).toHaveValue('8');
  assert.equal(await draft.evaluate(input => input.readOnly || input.disabled), true);
  await expect(page.locator('#saveRound')).toBeDisabled();
  await expect(outcome).toHaveValue('halved');
  await expect(outcome).toBeDisabled();
  await expect(page.locator(`${edit}[data-hole="2"],${edit}[data-hole="4"]`)).toHaveCount(0);
});

test('closing or publishing in another tab before Save blocks the already-open edit', async t => {
  const { page, calls, data } = await openPortal(t);
  await openIndividual(page);
  data.tournament.status = 'archived';
  await assert.rejects(saveCaptured(page, 'correctHoleScore', individualPayload), /closed/);
  await expect(page.locator(edit)).toHaveCount(0);
  assert.deepEqual(calls.filter(([op]) => op.startsWith('correct')), []);
});

test('a delayed preflight after navigating away and back cannot submit a stale edit', async t => {
  const data = addScramble(memberCard());
  const delay = gate();
  const { page, calls } = await openPortal(t, { data, width: 1200, hooks: { beforeRead: table => table === 'scores' ? delay.hold() : undefined } });
  await openIndividual(page);
  const pending = assert.rejects(saveCaptured(page, 'correctHoleScore', individualPayload), /scorecard changed/i);
  await delay.started;
  await page.locator('#matchSelect').selectOption('texas');
  await page.locator('#matchSelect').selectOption('mixed');
  const draft = page.getByLabel('Hole 2 gross score');
  await draft.fill('7');
  delay.release();
  await pending;
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue('7');
  assert.deepEqual(calls.filter(([op]) => op.startsWith('correct')), []);
});

test('a revoked global administrator cannot keep Edit via an ordinary tournament membership', async t => {
  const data = memberCard();
  data.profile.role = 'admin';
  data.memberships[0].role = 'player';
  const { page } = await openPortal(t, { data });
  await openIndividual(page);
  data.profile.role = 'player';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator(edit)).toHaveCount(0, { timeout: 1200 });
  assert.equal(await page.evaluate(() => window.edited.callbacks.canEdit(window.edited.target)), false);
});

test('a disappeared assignment after the audited write warns without leaving an actionable stale card', async t => {
  const data = memberCard();
  const hooks = { write(method, payload) {
    data.assignments = [];
    return { score: { ...data.rounds[0].scores[0], gross_score: payload.grossScore } };
  } };
  const { page, calls } = await openPortal(t, { data, hooks });
  await openIndividual(page);
  assert.match(await saveCaptured(page, 'correctHoleScore', individualPayload), /no longer available/);
  await expect(page.locator(edit)).toHaveCount(0, { timeout: 1200 });
  assert.equal(await page.evaluate(() => window.edited.callbacks.canEdit(window.edited.target)), false);
  assert.deepEqual(calls.filter(([op]) => op.startsWith('correct')), [['correctHoleScore', individualPayload]]);
});

test('leaving Play invalidates the open edit even if the same assigned match stays selected', async t => {
  const { page } = await openPortal(t);
  await openIndividual(page);
  await page.locator('[data-member-view="cup"]').click();
  assert.equal(await page.evaluate(() => window.edited.callbacks.canEdit(window.edited.target)), false);
  await page.locator('[data-member-view="score"]').click();
  assert.equal(await page.evaluate(() => window.edited.callbacks.canEdit(window.edited.target)), false);
});

test('double submission of one open editor makes one audited write; a different round or deletion makes none', async t => {
  const data = memberCard();
  const { page, calls } = await openPortal(t, { data, hooks: { write(method, p) { return { score: Object.assign(data.rounds[0].scores[0], { gross_score: p.grossScore }) }; } } });
  await openIndividual(page);
  for (const wrong of [{ roundId: 'other' }, { holeNumber: 2 }, { deleteScore: true }]) {
    await assert.rejects(saveCaptured(page, 'correctHoleScore', { ...individualPayload, ...wrong }), /changed|target/i);
  }
  const results = await Promise.allSettled([saveCaptured(page, 'correctHoleScore', individualPayload), saveCaptured(page, 'correctHoleScore', individualPayload)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.deepEqual(calls.filter(([op]) => op.startsWith('correct')), [['correctHoleScore', individualPayload]]);
});
