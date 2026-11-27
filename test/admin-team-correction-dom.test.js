import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const root = new URL('../', import.meta.url);
const origin = 'http://127.0.0.1';
const apiSource = await readFile(new URL('src/supabase.js', root), 'utf8');
const apiStub = [...apiSource.matchAll(/^export (?:async )?function (\w+)\(/gm)]
  .map(([, name]) => `export const ${name} = (...args) => window.organizerTestApi('${name}', ...args);`).join('\n');
let browser;
before(async () => {
  const executablePath = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].find(existsSync);
  browser = await chromium.launch({ executablePath });
});
after(async () => browser?.close());

const makeSegment = (matchId, format, entryMode = 'individual_scores') => ({
  id: `${matchId}-segment`, match_id: matchId, format, entry_mode: entryMode, start_hole: 1, end_hole: 9,
  status: 'live', point_value: 1, scoring_mode: 'gross', match_segment_players: [],
});
const makeMatch = (id, format, entryMode) => ({
  id, name: `Match ${id}`, tournament_id: 'cup', status: 'live', match_segments: [makeSegment(id, format, entryMode)],
});
function makeSquad(matchId, label, driver) {
  const squadId = `${matchId}-squad`;
  return {
    id: squadId, match_id: matchId, label, segment_id: `${matchId}-segment`,
    texas_scramble_squad_players: [driver, `${driver}-partner`].map((user_id, i) => ({
      user_id, squad_id: squadId, playing_order: i + 1, profiles: { display_name: `Player ${user_id}` },
    })),
    texas_scramble_hole_scores: [7, 2].map(hole_number => ({
      id: `${squadId}-hole-${hole_number}`, squad_id: squadId, hole_number, gross_score: 4, tee_shot_player_id: driver,
    })),
  };
}
function organizerData() {
  const squads = [makeSquad('blue', 'Blue A', 'alex'), makeSquad('white', 'White A', 'wren')];
  return {
    tournaments: [{ id: 'cup', name: 'Test Cup', edition_year: 2027, status: 'live' }],
    memberships: [], courses: [], rules: [], rounds: [], settings: [], commentaries: [], legacyEditions: [], resultAudits: [],
    matches: [makeMatch('blue', 'scramble'), makeMatch('white', 'scramble')],
    scrambleSessions: [{ id: 'session', texas_scramble_squads: squads }],
  };
}

// The actual page, CSS and event handlers run in Chrome. Only the Supabase boundary is replaced;
// requests cannot reach a real site or database, and each test gets its own organizer state.
async function openAdmin(t, data = organizerData(), overrides = {}, probeEditor = false) {
  const calls = [];
  const api = {
    getCurrentSession: () => ({ user: { id: 'organizer' } }),
    loadPlayerData: () => ({ profile: { role: 'admin' }, memberships: [] }),
    loadAdminData: () => data,
    readRounds: (_table, _fields, _column, id) => data.rounds.filter(round => round.match_id === id),
    loadMembershipRosterData: () => ({ tournaments: data.tournaments, memberships: data.memberships }),
    loadMatchResultAudits: () => [], loadTeamCorrectionAudits: () => [],
    loadCorrectionMatch: id => ({ ...data.matches.find(match => match.id === id),
      correctionSquads: data.scrambleSessions.flatMap(s => s.texas_scramble_squads).filter(s => s.match_id === id),
    }),
    ...overrides,
  };
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.exposeFunction('organizerTestApi', (name, ...args) => {
    calls.push([name, ...args]);
    assert.ok(api[name], `Unexpected API call: ${name}`);
    return api[name](...args);
  });
  await page.route('**/*', async route => {
    const { origin: host, pathname } = new URL(route.request().url());
    if (host !== origin) return route.abort();
    if (pathname === '/src/scorecard-hole-editor.js' && probeEditor) {
      // Test Admin's half of the shared editor contract; the modal itself has its own tests.
      return route.fulfill({ contentType: 'text/javascript', body: `export const createHoleEditor = callbacks => ({
        open(target, trigger) { window.editorOpens = (window.editorOpens || 0) + 1; window.holeProbe = { callbacks, target, trigger }; }
      });` });
    }
    if (pathname === '/src/supabase.js') {
      const body = apiStub.replace(/^export const getSupabase = .*$/m, `export const getSupabase = async () => ({
        from: table => ({select: fields => ({eq: async (column, id) => ({data: await window.organizerTestApi('readRounds', table, fields, column, id)})})})
      });`);
      return route.fulfill({ contentType: 'text/javascript', body });
    }
    if (!/^\/(admin\.html|[\w-]+\.css|src\/[\w-]+\.js)$/.test(pathname)) return route.abort();
    const contentType = pathname.endsWith('.js') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html';
    return route.fulfill({ contentType, body: await readFile(new URL(pathname.slice(1), root)) });
  });
  // These tests exercise the scorecard itself, including its durable direct link.
  await page.goto(`${origin}/admin.html?tool=scorecards`);
  await expect(page.locator('#adminContent')).toBeVisible();
  return { page, calls };
}

test('unselected Scorecards is one small picker at the top on phone and desktop', async t => {
  const { page, calls } = await openAdmin(t);
  const panel = page.locator('#resultMatch').locator('xpath=ancestor::section[1]');
  const measurements = [];
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    measurements.push(await panel.evaluate(el => {
      const { width, height, top } = el.getBoundingClientRect();
      return { viewport: innerWidth, width, height, top, pageWidth: document.documentElement.scrollWidth };
    }));
  }
  t.diagnostic(JSON.stringify(measurements));
  assert.ok(measurements.every(m => m.height <= 104 && m.top < 420 && m.pageWidth <= m.viewport));
  await expect(panel.getByLabel('Scorecards', { exact: true })).toHaveValue('');
  await expect(panel.locator('button:visible, summary:visible, h1:visible, h2:visible')).toHaveCount(0);
  assert.equal(calls.some(([n]) => ['loadMatchResultAudits', 'loadTeamCorrectionAudits', 'loadCorrectionMatch'].includes(n)), false);
});

test('browser Back does not move a still-open correction to another workspace or discard its draft', async t => {
  const { page, calls } = await openAdmin(t);
  await page.locator('#adminBack').click();
  const scorecards = page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link', { name: 'Scorecards', exact: true });
  await scorecards.click();
  await page.selectOption('#resultMatch', 'blue');
  await page.locator('button[data-entry-id="blue-squad-hole-2"]').click();
  const sheet = page.locator('#holeEditDialog');
  await expect(sheet).toBeVisible();
  await sheet.locator('#holeEditReason').fill('Unsaved card note');
  await page.goBack();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('#adminContent')).toHaveAttribute('data-admin-route', 'scorecards', { timeout: 900 });
  await expect(sheet.locator('#holeEditReason')).toHaveValue('Unsaved card note');
  await sheet.locator('#holeEditCancel').click();
  await expect(scorecards).toBeVisible();
  await expect(scorecards).toBeFocused();
  assert.equal(calls.some(([name]) => name === 'correctTeamScoreEntry'), false);
});

test('selecting a mixed scorecard shows one bounded card, exact submitted rows and scoped history', async t => {
  const data = organizerData();
  const match = outcomeMatch('mixed');
  match.match_segments.push({ ...makeSegment('mixed', 'singles'), id: 'back-nine', start_hole: 10, end_hole: 18 });
  data.matches.push(match);
  data.rounds = ['alpha', 'beta'].map(id => ({ id, match_id: 'mixed', profiles: { display_name: `${id} <scorer>` },
    scores: Array.from({ length: 18 }, (_, n) => ({ id: `${id}-${n + 1}`, round_id: id, hole_number: n + 1, gross_score: 5 })) }));
  const { page } = await openAdmin(t, data);
  await page.setViewportSize({ width: 390, height: 650 });
  const select = page.locator('#resultMatch');
  const rows = page.locator('#scorecardHoles');
  const history = page.locator('#scorecardHistory');
  await select.selectOption('mixed');
  await expect(page.locator('#scorecardCard')).toBeVisible();
  await page.locator('#scorecardCard').selectOption('round:beta');
  const hole = rows.locator('button[data-edit-hole][data-entry-id="beta-10"][data-round-id="beta"][data-hole="10"]');
  await expect(hole).toHaveText('Edit');
  await expect(rows.locator('button[data-edit-hole]')).toHaveCount(18);
  assert.ok(await rows.evaluate(el => el.clientHeight <= 360 && el.scrollHeight > el.clientHeight));
  assert.equal(await rows.locator('scorer').count(), 0);
  await page.locator('#scorecardCard').selectOption('segment:mixed-segment');
  await expect(rows.locator('button[data-entry-id="mixed-first"]').locator('..')).toContainText('White');
  await expect(rows.locator('button[data-edit-hole]')).toHaveCount(2);
  await expect(history).not.toHaveAttribute('open', '');
  await history.getByText('View change history', { exact: true }).click();
  await expect(page.locator('#teamCorrectionHistory')).toBeVisible();
  await select.selectOption('white');
  await expect(history).not.toHaveAttribute('open', '');
  await expect(rows.locator('button[data-entry-id="white-squad-hole-2"]').locator('..')).toContainText('Gross 4 · tee shot: Player wren');
  await expect(rows).not.toContainText('alpha');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await select.selectOption('');
  await expect(history).toBeHidden();
  await expect(rows.locator('button')).toHaveCount(0);
});

test('row Edit opens the immutable individual target and rereads its match, scores, recap and audit without replacing another draft', async t => {
  const data = organizerData();
  const match = makeMatch('singles', 'singles');
  match.status = match.match_segments[0].status = 'final';
  Object.assign(match.match_segments[0], { differential: 1, holes_played: 9 });
  data.matches.push(match);
  data.settings.push({ tournament_id: 'cup', enabled: true });
  const round = { id: 'round', match_id: match.id, profiles: { display_name: 'Jordan' }, scores: [
    { id: 'immutable-4', round_id: 'round', hole_number: 4, gross_score: 5 },
    { id: 'immutable-5', round_id: 'round', hole_number: 5, gross_score: 6 },
  ] };
  data.rounds.push(round);
  const commentary = { id: 'recap', status: 'approved', commentary: 'Initial recap', matches: { name: 'Other match' } };
  data.commentaries.push(commentary);
  const { page, calls } = await openAdmin(t, data, {
    correctHoleScore: () => {
      round.scores[0].gross_score = 3; // A later correction already superseded this RPC response.
      match.match_segments[0].differential = -1;
      return { score: { ...round.scores[0], gross_score: 4 }, audit: { action: 'updated' } };
    },
    readRounds: (table, fields, column, id) => { assert.deepEqual([table, column, id], ['rounds', 'match_id', match.id]); return [round]; },
    generateMatchCommentary: () => ({ ...commentary, id: 'saved-recap', commentary: 'Regenerated recap', matches: { name: 'Match singles' } }),
  }, true);
  await page.locator('#ruleForm [name=title]').evaluate(el => { el.value = 'Unpublished rule'; });
  await page.locator('#commentaryApprovalList').getByText('Edit', { exact: true }).evaluate(el => el.click());
  await page.locator('#commentaryApprovalList textarea').evaluate(el => { el.value = 'Private recap draft'; });
  await page.locator('#resultMatch').selectOption(match.id);
  const button = page.locator('[data-entry-id="immutable-4"][data-round-id="round"][data-hole="4"]');
  await expect(page.locator('#scorecardCaption')).toBeVisible();
  await expect(page.locator('#scorecardCaption')).toHaveText('Jordan');
  await button.evaluate(el => { el.click(); el.click(); });
  await expect.poll(() => page.evaluate(() => window.editorOpens)).toBe(1);
  const [target, allowed] = await page.evaluate(() => [holeProbe.target, holeProbe.callbacks.canEdit(holeProbe.target)]);
  assert.deepEqual([target.kind, target.matchId, target.roundId, target.row.id, target.row.gross_score, allowed],
    ['individual', 'singles', 'round', 'immutable-4', 5, true]);
  await assert.rejects(page.evaluate(() => holeProbe.callbacks.correctHoleScore({ roundId: 'round', holeNumber: 4,
    expectedScoreId: 'immutable-5', grossScore: 4, reason: 'Wrong saved entry' })), /reopen|target/i);
  assert.equal(calls.some(([n]) => n === 'correctHoleScore'), false);
  await page.evaluate(async () => {
    const { target, callbacks } = holeProbe;
    const result = await callbacks.correctHoleScore({ roundId: target.roundId, holeNumber: target.row.hole_number, expectedScoreId: target.row.id, grossScore: 4, reason: 'Checked card' });
    const warning = await callbacks.onSaved(target, result);
    callbacks.notify(`Hole 4 corrected.${warning ? ' ' + warning : ''}`, Boolean(warning), target);
  });
  await expect(button.locator('..')).toContainText('Gross 3');
  await expect(page.locator('[data-entry-id="immutable-5"]').locator('..')).toContainText('Gross 6');
  await expect(page.locator('#resultSegmentRows')).toContainText('White wins 1 Up');
  await expect(page.locator('#resultMessage')).toHaveText('Hole 4 corrected.');
  await expect(page.locator('#ruleForm [name=title]')).toHaveValue('Unpublished rule');
  await expect(page.getByLabel('Edit commentary for Other match')).toHaveValue('Private recap draft');
  await expect(page.getByLabel('Edit commentary for Match singles')).toHaveValue('Regenerated recap');
  assert.deepEqual(calls.filter(([n]) => n === 'generateMatchCommentary'), [['generateMatchCommentary', match.id, { regenerate: true }]]);
  assert.equal(calls.filter(([n]) => n === 'loadMatchResultAudits').length, 1);
  assert.equal(await page.evaluate(() => holeProbe.callbacks.canEdit(holeProbe.target)), false, 'old snapshot no longer editable');
});

test('an unconfirmed correction receipt never freezes Edit on a different hole', async t => {
  const data = organizerData();
  const { page, calls } = await openAdmin(t, data, { correctTeamScoreEntry: () => ({ id: 'unconfirmed' }) }, true);
  await page.selectOption('#resultMatch', 'blue');
  const edit = id => page.locator(`button[data-edit-hole][data-entry-id="blue-squad-hole-${id}"]`);
  await edit(2).click();
  await expect.poll(() => page.evaluate(() => window.holeProbe?.target.row.hole_number)).toBe(2);
  await page.evaluate(async () => {
    const { target, callbacks } = holeProbe;
    const receipt = await callbacks.correctTeamScoreEntry({ targetType: target.kind, targetId: target.row.id, grossScore: 3, teeShotPlayerId: 'alex', reason: 'Verified' });
    if (receipt.id === target.row.id) throw new Error('Test must exercise an unconfirmed return');
    // The sheet must NOT apply a mismatched receipt with onSaved or retry it.
    callbacks.notify('Could not confirm the saved hole.', true, target);
  });
  await edit(7).click();
  await expect.poll(() => page.evaluate(() => window.holeProbe?.target.row.hole_number), { timeout: 1200 }).toBe(7);
  assert.equal(calls.filter(([name]) => name === 'correctTeamScoreEntry').length, 1);
});

test('final manual segments are read-only, use text labels and cannot submit an outcome-only match', async t => {
  const data = organizerData();
  const match = makeMatch('finished-manual', 'foursomes');
  Object.assign(match.match_segments[0], { status: 'final', differential: 1, holes_played: 9, scoring_mode: '<b>gross</b>' });
  data.matches.push(match, outcomeMatch('winners'));
  const { page, calls } = await openAdmin(t, data);
  await page.locator('#resultMatch').selectOption(match.id);
  await expect(page.locator('#resultFinalizationForm button[type=submit]')).toBeHidden();
  await expect(page.locator('#resultSegmentRows input:visible')).toHaveCount(0);
  await expect(page.locator('#resultSegmentRows b')).toHaveCount(0);
  await expect(page.locator('#resultSegmentRows')).toContainText('Blue wins 1 Up');
  await page.locator('#resultMatch').selectOption('winners');
  await page.locator('#resultFinalizationForm').evaluate(form => form.requestSubmit());
  assert.equal(calls.some(([n]) => n === 'finalizeMatchResults'), false);
});

test('submitted shared edits bind their own driver or winner and stop when tournament authority changes', async t => {
  const data = organizerData();
  data.matches.push(outcomeMatch('winners'));
  data.memberships.push({ tournament_id: 'cup', user_id: 'organizer', status: 'active', role: 'admin' });
  const { page, calls } = await openAdmin(t, data, {
    loadPlayerData: () => ({ profile: { role: 'player' }, memberships: data.memberships }),
    correctTeamScoreEntry: ({ targetId, grossScore, teeShotPlayerId }) => {
      const row = data.scrambleSessions[0].texas_scramble_squads[1].texas_scramble_hole_scores.find(h => h.id === targetId);
      return Object.assign(row, { gross_score: grossScore, tee_shot_player_id: teeShotPlayerId });
    },
  }, true);
  const picker = page.locator('#resultMatch');
  await picker.selectOption('white');
  const button = page.locator('[data-entry-id="white-squad-hole-7"]');
  await button.click();
  await expect.poll(() => page.evaluate(() => window.editorOpens)).toBe(1);
  const snap = await page.evaluate(() => holeProbe.target);
  assert.deepEqual(Object.keys(snap.row).sort(), ['gross_score', 'hole_number', 'id', 'tee_shot_player_id']);
  assert.deepEqual([snap.kind, snap.matchId, snap.row.id, snap.players], ['texas_scramble_hole', 'white', 'white-squad-hole-7',
    [{ id: 'wren', name: 'Player wren' }, { id: 'wren-partner', name: 'Player wren-partner' }]]);
  await page.evaluate(async () => {
    const { target, callbacks } = holeProbe;
    const saved = await callbacks.correctTeamScoreEntry({ targetType: target.kind, targetId: target.row.id, grossScore: 6, teeShotPlayerId: 'wren-partner', reason: 'Verified' });
    await callbacks.onSaved(target, saved);
    callbacks.notify('Hole 7 corrected.', false, target);
  });
  await expect(button.locator('..')).toContainText('Gross 6 · tee shot: Player wren-partner');
  assert.equal(await page.evaluate(() => holeProbe.trigger.isConnected), true, 'focus return target survives readback');
  await picker.selectOption('winners');
  assert.equal(await page.evaluate(() => holeProbe.callbacks.canEdit(holeProbe.target)), false);
  await assert.rejects(page.evaluate(() => holeProbe.callbacks.correctTeamScoreEntry({ targetType: holeProbe.target.kind,
    targetId: holeProbe.target.row.id, grossScore: 9, teeShotPlayerId: 'wren', reason: 'Stale tab' })), /scorecard|submitted hole/i);
  await page.locator('[data-entry-id="winners-second"]').click();
  const outcome = await page.evaluate(() => holeProbe.target);
  assert.deepEqual([outcome.kind, outcome.matchId, outcome.row.id, outcome.row.winner], ['match_hole_outcome', 'winners', 'winners-second', 'halved']);
  data.memberships[0].role = 'player';
  await page.locator('#refreshMemberships').evaluate(el => el.click());
  await expect(page.locator('#membershipMessage')).toContainText('requests refreshed');
  assert.equal(await page.evaluate(() => holeProbe.callbacks.canEdit(holeProbe.target)), false);
  await expect(page.locator('button[data-edit-hole]:visible')).toHaveCount(0);
  await expect(page.locator('#scorecardHistory')).toBeHidden();
  assert.equal(calls.filter(([name]) => name === 'correctTeamScoreEntry').length, 1);
});

test('manual Foursomes submit runs once and does not reset another form or restore a previous match', async t => {
  const data = organizerData();
  const manual = makeMatch('manual', 'foursomes');
  data.matches.push(manual);
  const gate = deferred();
  const { page, calls } = await openAdmin(t, data, { finalizeMatchResults: () => gate.promise });
  await page.locator('#resultMatch').selectOption('manual');
  await page.locator('#ruleForm [name=title]').evaluate(el => { el.value = 'Unpublished rule'; });
  await page.locator('#resultSegmentRows [name=differential]').fill('2');
  await page.locator('#resultFinalizationForm').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
  await page.locator('#resultMatch').selectOption('blue');
  await expect(page.locator('#scorecardHoles [data-entry-id="blue-squad-hole-2"]')).toBeVisible();
  gate.resolve();
  await expect(page.locator('#commentaryMatch option[value=manual]')).toHaveCount(1);
  await expect(page.locator('#resultMessage')).not.toContainText('Match finalized');
  await expect(page.locator('#ruleForm [name=title]')).toHaveValue('Unpublished rule');
  assert.equal(calls.filter(([n]) => n === 'finalizeMatchResults').length, 1);
});

test('a corrected shared hole preserves an unfinished manual segment draft in the same match', async t => {
  const data = organizerData();
  const match = outcomeMatch('mixed');
  match.match_segments.push({ ...makeSegment('mixed', 'foursomes'), id: 'mixed-back', start_hole: 10, end_hole: 18 });
  data.matches.push(match);
  const { page } = await openAdmin(t, data, { correctTeamScoreEntry: ({ winner }) => Object.assign(match.match_segments[0].match_hole_outcomes[0], { winner }) }, true);
  await page.locator('#resultMatch').selectOption('mixed');
  const differential = page.locator('[data-segment-id="mixed-back"] [name=differential]');
  await differential.fill('3');
  await page.locator('[data-entry-id="mixed-first"]').click();
  await page.waitForFunction(() => Boolean(window.holeProbe));
  await page.evaluate(async () => {
    const { callbacks, target } = holeProbe;
    const result = await callbacks.correctTeamScoreEntry({ targetType: target.kind, targetId: target.row.id, winner: 'halved', reason: 'Checked' });
    await callbacks.onSaved(target, result);
  });
  await expect(differential).toHaveValue('3');
  await expect(page.locator('[data-entry-id="mixed-first"]').locator('..')).toContainText('Halved');
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function reveal(page, id) {
  const details = page.locator(id);
  if (!await details.evaluate(el => el.open)) await details.locator('summary').click();
}

async function editMatch(page, matchId) {
  await page.locator('#resultMatch').selectOption(matchId);
  await reveal(page, '#scorecardMore');
  await page.locator('#openScoreCorrection').click();
  await expect(page.locator('#scoreCorrectionDialog')).toBeVisible();
}

test('a pure scramble opens the first submitted hole in the selected squad, with only that squad’s drivers', async t => {
  const { page } = await openAdmin(t);
  await page.setViewportSize({ width: 390, height: 550 });
  await editMatch(page, 'white');
  const entries = page.locator('#teamCorrectionEntry');
  await expect(entries).toHaveValue('white-squad-hole-2');
  assert.deepEqual(await entries.locator('option').evaluateAll(opts => opts.map(o => o.value)), ['white-squad-hole-2', 'white-squad-hole-7']);
  await expect(page.locator('#teamCorrectionGross')).toHaveValue('4');
  await expect(page.locator('#teamCorrectionDriver')).toHaveValue('wren');
  assert.deepEqual(await page.locator('#teamCorrectionDriver option').evaluateAll(opts => opts.map(o => o.value)), ['wren', 'wren-partner']);
  for (const id of ['correctionRound', 'correctionHole', 'correctionScore', 'correctionDelete', 'teamCorrectionWinner']) {
    await expect(page.locator(`#${id}`)).toBeHidden();
    await expect(page.locator(`#${id}`)).toBeDisabled();
  }
  await page.locator('#correctionReason').fill('Verified on scorecard');
  assert.equal(await page.locator('#scoreCorrectionForm').evaluate(form => form.checkValidity()), true);
  assert.equal(await page.locator('#scoreCorrectionDialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth), true);
});

function outcomeMatch(id) {
  const match = makeMatch(id, 'foursomes', 'hole_outcomes');
  const segment = match.match_segments[0];
  segment.match_hole_outcomes = [
    { id: `${id}-first`, segment_id: segment.id, hole_number: 1, winner: 'silver' },
    { id: `${id}-second`, segment_id: segment.id, hole_number: 2, winner: 'halved' },
  ];
  return match;
}

test('hole-winner entry uses submitted outcomes, not manual Foursomes results or individual strokes', async t => {
  const data = organizerData();
  data.matches.push(outcomeMatch('alternate'));
  const { page } = await openAdmin(t, data);
  await editMatch(page, 'alternate');
  await expect(page.locator('#teamCorrectionEntry')).toHaveValue('alternate-first');
  await expect(page.locator('#teamCorrectionWinner')).toHaveValue('silver');
  await page.locator('#teamCorrectionEntry').selectOption('alternate-second');
  await expect(page.locator('#teamCorrectionWinner')).toHaveValue('halved');
  assert.deepEqual(await page.locator('#teamCorrectionWinner option').evaluateAll(opts => opts.map(o => [o.value, o.label])),
    [['cardinal', 'Blue'], ['halved', 'Halved'], ['silver', 'White']]);
  for (const id of ['teamCorrectionGross', 'teamCorrectionDriver', 'correctionRound', 'correctionDelete']) {
    await expect(page.locator(`#${id}`)).toBeHidden();
    await expect(page.locator(`#${id}`)).toBeDisabled();
  }
  await page.locator('#correctionReason').fill('Checked with both sides');
  assert.equal(await page.locator('#scoreCorrectionForm').evaluate(form => form.checkValidity()), true);
  await page.locator('#closeScoreCorrection').click();
  await expect(page.locator('#resultFinalizationForm button[type=submit]')).toBeHidden();
});

test('a mixed match preserves the round and shared entry choices when switching modes', async t => {
  const data = organizerData();
  const mixed = outcomeMatch('mixed');
  mixed.match_segments.push({ ...makeSegment('mixed', 'singles'), id: 'back-nine', start_hole: 10, end_hole: 18 });
  data.matches.push(mixed);
  data.rounds = [{ id: 'round-id', match_id: 'mixed', profiles: { display_name: 'Jordan' }, scores: [] }];
  const { page } = await openAdmin(t, data);
  await editMatch(page, 'mixed');
  await expect(page.locator('#correctionMode')).toHaveValue('individual');
  await page.locator('#correctionRound').selectOption('round-id');
  await page.locator('#correctionMode').selectOption('team');
  await page.locator('#teamCorrectionEntry').selectOption('mixed-second');
  await page.locator('#correctionMode').selectOption('individual');
  await expect(page.locator('#correctionRound')).toHaveValue('round-id');
  await expect(page.locator('#teamCorrectionEntry')).toBeDisabled();
  await page.locator('#correctionMode').selectOption('team');
  await expect(page.locator('#teamCorrectionEntry')).toHaveValue('mixed-second');
});

test('a scramble correction saves once, reloads the exact result and selected hole, and shows persisted history', async t => {
  const data = organizerData();
  const audits = [];
  const squad = data.scrambleSessions[0].texas_scramble_squads[1];
  const row = squad.texas_scramble_hole_scores[0];
  const match = data.matches[1];
  const segment = match.match_segments[0];
  Object.assign(segment, { status: 'final', differential: -1, holes_played: 9, point_value: 2 });
  match.status = 'final';
  const reason = 'Corrected from <signed card>';
  const { page, calls } = await openAdmin(t, data, {
    correctTeamScoreEntry: payload => {
      const before = { ...row };
      Object.assign(row, { gross_score: payload.grossScore, tee_shot_player_id: payload.teeShotPlayerId });
      const saved = { ...row };
      audits.push({ match_id: match.id, target_type: payload.targetType, target_id: row.id, before_value: before, after_value: saved,
        reason: payload.reason, corrected_at: '2027-03-01T14:00:00Z', profiles: { display_name: 'Morgan' } });
      // The authoritative read can already include a subsequent organizer's correction.
      row.gross_score = 6;
      segment.point_value = 3;
      return saved;
    },
    loadTeamCorrectionAudits: id => audits.filter(a => a.match_id === id),
  });
  assert.equal(calls.some(([name]) => name === 'loadTeamCorrectionAudits'), false);
  await editMatch(page, match.id);
  await page.locator('#teamCorrectionEntry').selectOption(row.id);
  await page.locator('#teamCorrectionGross').fill('5');
  await page.locator('#teamCorrectionDriver').selectOption('wren-partner');
  await page.locator('#correctionReason').fill(`  ${reason}  `);
  await page.locator('#scoreCorrectionForm button[type=submit]').click();
  await expect(page.locator('#resultMessage')).toContainText('Team correction saved and audited.');
  await expect(page.locator('#resultMessage')).toContainText('Gross 6');
  await expect(page.locator('#scoreCorrectionDialog')).not.toBeVisible();
  await expect(page.locator('#resultMatch')).toHaveValue('white');
  await expect(page.locator('#resultSegmentRows')).toContainText('White earns 3 Cup points');
  await reveal(page, '#scorecardHistory');
  const history = page.locator('#teamCorrectionHistory');
  await expect(history).toContainText('Gross 4 · tee shot: Player wren → Gross 5 · tee shot: Player wren-partner');
  await expect(history).toContainText(reason);
  await expect(history).toContainText('Morgan');
  assert.equal(await history.locator('signed').count(), 0);
  assert.deepEqual(calls.filter(([name]) => name === 'correctTeamScoreEntry'), [['correctTeamScoreEntry', {
    targetType: 'texas_scramble_hole', targetId: row.id, reason, grossScore: 5, teeShotPlayerId: 'wren-partner',
  }]]);
  assert.equal(calls.some(([name]) => name === 'correctHoleScore'), false);
  assert.deepEqual(calls.filter(([name]) => name === 'loadCorrectionMatch').map(([, id]) => id), ['white', 'white']);
  await page.locator('#openScoreCorrection').click();
  await expect(page.locator('#teamCorrectionEntry')).toHaveValue(row.id);
  await expect(page.locator('#teamCorrectionGross')).toHaveValue('6');
});

test('archived or completed tournaments are read-only, including a published archive linked to the edition', async t => {
  const data = organizerData();
  for (const status of ['complete', 'archived', 'open']) {
    data.tournaments.push({ id: status, status, name: status, edition_year: 2026 });
    data.matches.push({ ...outcomeMatch(status), tournament_id: status });
  }
  data.legacyEditions.push({ id: 'published', source_tournament_id: 'open', published: true });
  const { page, calls } = await openAdmin(t, data);
  for (const id of ['complete', 'archived', 'open']) {
    await page.locator('#resultMatch').selectOption(id);
    await expect(page.locator('#openScoreCorrection')).toBeDisabled();
    await expect(page.locator('#resultMessage')).toContainText('Submitted scores are read-only.');
  }
  await editMatch(page, 'white');
  assert.deepEqual(calls.filter(([name]) => name === 'loadCorrectionMatch').map(([, id]) => id), ['white']);
});

test('an active tournament organizer can correct only their own tournament, not another where they are a player', async t => {
  const data = organizerData();
  data.tournaments.push({ id: 'other', status: 'live', name: 'Other Cup', edition_year: 2028 });
  data.matches.push({ ...outcomeMatch('other'), tournament_id: 'other' });
  data.memberships = [{ tournament_id: 'cup', user_id: 'organizer', role: 'admin', status: 'active' },
    { tournament_id: 'other', user_id: 'organizer', role: 'player', status: 'active' }];
  const { page, calls } = await openAdmin(t, data, { loadPlayerData: () => ({ profile: { role: 'player' }, memberships: data.memberships }) });
  await page.locator('#resultMatch').selectOption('other');
  await expect(page.locator('#openScoreCorrection')).toBeDisabled();
  await expect(page.locator('#resultMessage')).toContainText('Only an administrator of this tournament');
  assert.equal(calls.some(([name, id]) => name === 'loadTeamCorrectionAudits' && id === 'other'), false);
  await editMatch(page, 'blue');
  await expect(page.locator('#teamCorrectionEntry')).toHaveValue('blue-squad-hole-2');
});

test('a committed hole winner still reports success and the returned value when score and audit reloads are unavailable', async t => {
  const data = organizerData();
  const match = outcomeMatch('winner');
  data.matches.push(match);
  let saved = false;
  const { page, calls } = await openAdmin(t, data, {
    loadCorrectionMatch: () => { if (saved) throw new Error('Scores offline'); return { ...match, correctionSquads: [] }; },
    loadTeamCorrectionAudits: () => { if (saved) throw new Error('Log offline'); return []; },
    correctTeamScoreEntry: () => { saved = true; return { ...match.match_segments[0].match_hole_outcomes[0], winner: 'halved', completion_warning: 'Tee stroke indexes disagree' }; },
  });
  await editMatch(page, 'winner');
  await page.locator('#teamCorrectionWinner').selectOption('halved');
  await page.locator('#correctionReason').fill('Confirmed halve');
  await page.locator('#scoreCorrectionForm button[type=submit]').click();
  await expect(page.locator('#resultMessage')).toContainText('Team correction saved and audited.');
  await expect(page.locator('#resultMessage')).toContainText('Halved');
  await expect(page.locator('#resultMessage')).not.toContainText('White');
  await expect(page.locator('#resultMessage')).toContainText('Individual scorecards need review: Tee stroke indexes disagree');
  await expect(page.locator('#resultMessage')).toContainText('Score/result refresh failed: Scores offline');
  await expect(page.locator('#resultMessage')).toContainText('Team correction history refresh failed: Log offline');
  await reveal(page, '#scorecardHistory');
  await expect(page.locator('#teamCorrectionHistory')).toContainText('Log offline');
  await expect(page.locator('#resultMatch')).toHaveValue('winner');
  assert.deepEqual(calls.filter(([name]) => name === 'correctTeamScoreEntry'), [['correctTeamScoreEntry', {
    targetType: 'match_hole_outcome', targetId: 'winner-first', reason: 'Confirmed halve', winner: 'halved',
  }]]);
});

test('ordinary rounds retain the non-dialog fallback, delete on live matches, and audit warnings after saving', async t => {
  const data = organizerData();
  // Pre-edition matches do not have a tournament_id; global organizers could already correct them.
  data.matches.push({ ...makeMatch('players', 'foursomes'), tournament_id: null });
  data.rounds.push({ id: 'ordinary', match_id: 'players', profiles: { display_name: 'Jordan' }, scores: [{ hole_number: 7, gross_score: 4 }] });
  const { page, calls } = await openAdmin(t, data, { correctHoleScore: () => ({ score: null, auditWarning: 'Score audit refresh failed: Log offline' }) });
  await page.evaluate(() => { HTMLDialogElement.prototype.showModal = undefined; HTMLDialogElement.prototype.close = undefined; });
  await page.locator('#resultMatch').selectOption('players');
  await expect(page.locator('#openScoreCorrection')).toBeEnabled();
  await editMatch(page, 'players');
  const dialog = page.locator('#scoreCorrectionDialog');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(page.locator('#correctionRound')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('#openScoreCorrection')).toBeFocused();
  await page.locator('#openScoreCorrection').click();
  await page.locator('#correctionRound').selectOption('ordinary');
  await page.locator('#correctionHole').fill('7');
  await page.locator('#correctionDelete').check();
  await expect(page.locator('#correctionScore')).toBeDisabled();
  await page.locator('#correctionReason').fill('Duplicate hole');
  await page.locator('#scoreCorrectionForm button[type=submit]').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#resultMessage')).toContainText('Correction saved and audited');
  await expect(page.locator('#resultMessage')).toContainText('Score audit refresh failed: Log offline');
  await expect(page.locator('#resultFinalizationForm button[type=submit]')).toBeVisible();
  assert.deepEqual(calls.filter(([name]) => name === 'correctHoleScore'), [['correctHoleScore', {
    roundId: 'ordinary', holeNumber: 7, deleteScore: true, grossScore: null, reason: 'Duplicate hole',
  }]]);
  assert.equal(calls.some(([name]) => ['loadCorrectionMatch', 'correctTeamScoreEntry', 'loadTeamCorrectionAudits'].includes(name)), false);
});

test('a rejected outcome correction stays editable, while a successful retry shows the persisted before and after', async t => {
  const data = organizerData();
  const match = outcomeMatch('winner');
  const row = match.match_segments[0].match_hole_outcomes[0];
  data.matches.push(match);
  const audits = [];
  const gate = deferred();
  let attempts = 0;
  const { page } = await openAdmin(t, data, {
    correctTeamScoreEntry: async ({ winner, reason }) => {
      if (++attempts === 1) { await gate.promise; throw new Error('Remaining holes are required'); }
      const before = { ...row };
      row.winner = winner;
      audits.push({ match_id: match.id, target_type: 'match_hole_outcome', target_id: row.id,
        before_value: before, after_value: row, reason, corrected_at: '2027-03-01T14:00:00Z' });
      return row;
    },
    loadTeamCorrectionAudits: () => audits,
  });
  await editMatch(page, 'winner');
  await page.locator('#teamCorrectionWinner').selectOption('cardinal');
  await page.locator('#correctionReason').fill('Scorer confirmed Blue');
  const submit = page.locator('#scoreCorrectionForm button[type=submit]');
  await submit.click();
  await expect(submit).toBeDisabled();
  await expect(page.locator('#resultMatch')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('#scoreCorrectionDialog')).toBeVisible();
  gate.resolve();
  await expect(page.locator('#correctionMessage')).toContainText('Remaining holes are required');
  await expect(page.locator('#teamCorrectionWinner')).toHaveValue('cardinal');
  await expect(page.locator('#correctionReason')).toHaveValue('Scorer confirmed Blue');
  await submit.click();
  await reveal(page, '#scorecardHistory');
  await expect(page.locator('#teamCorrectionHistory')).toContainText('White → Blue');
  await expect(page.locator('#teamCorrectionHistory')).toContainText('Scorer confirmed Blue');
  await expect(page.locator('#resultMessage')).toContainText('Team correction saved and audited.');
  assert.equal(attempts, 2);
});

test('a late entry read cannot replace the selected match and an unsubmitted card offers nothing to correct', async t => {
  const data = organizerData();
  const gate = deferred();
  const { page } = await openAdmin(t, data, {
    loadCorrectionMatch: async id => {
      if (id === 'blue') await gate.promise;
      return { ...data.matches.find(match => match.id === id), correctionSquads: [] };
    },
  });
  await page.locator('#resultMatch').selectOption('blue');
  await reveal(page, '#scorecardMore');
  await page.locator('#openScoreCorrection').click();
  await expect(page.locator('#resultMessage')).toHaveText('Loading submitted team entries…');
  await editMatch(page, 'white');
  gate.resolve();
  await expect(page.locator('#correctionMatchLabel')).toHaveText('Match white');
  await expect(page.locator('#teamCorrectionEntry option')).toHaveCount(0);
  await expect(page.locator('#correctionMessage')).toHaveText('No shared holes have been submitted for this match.');
  await expect(page.locator('#scoreCorrectionForm button[type=submit]')).toBeDisabled();
  await expect(page.locator('#correctionRound')).toBeHidden();
});
