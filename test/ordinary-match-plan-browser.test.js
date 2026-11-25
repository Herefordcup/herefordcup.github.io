import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';

const root = new URL('../', import.meta.url);
const origin = 'http://127.0.0.1';
const player = (user_id, team, side, playing_order) => ({ user_id, team, side, playing_order });
const front = {
  id: 'front', segment_number: 2, start_hole: 1, end_hole: 9, format: 'singles',
  scoring_mode: 'net', entry_mode: 'hole_outcomes', handicap_allowance: 83.25, point_value: 0.35,
  match_segment_players: [player('white', 'silver', 'cardinal', 4), player('blue', 'cardinal', 'silver', 1)],
  match_hole_outcomes: [],
};
const back = {
  id: 'back', segment_number: 5, start_hole: 10, end_hole: 18, format: 'foursomes',
  scoring_mode: 'gross', entry_mode: 'individual_scores', handicap_allowance: null, point_value: 1.5,
  match_segment_players: [player('blue2', 'cardinal', 'cardinal', 3), player('white', 'silver', 'silver', 2),
    player('blue', 'cardinal', 'cardinal', 1), player('white2', 'silver', 'silver', 4)],
  match_hole_outcomes: [],
};
const ordinary = {
  id: 'ordinary', tournament_id: 'current', name: 'Friday mixed match', session: 'Friday evening',
  // The second occurrence of 01:30 in New York, with sub-minute precision.
  starts_at: '2027-11-07T06:30:45.123456+00:00', course_id: 'pine', status: 'scheduled',
  format: 'singles', scoring_mode: 'net', match_segments: [back, front],
};
function fixture() {
  return structuredClone({
    tournaments: [{ id: 'current', name: 'Cup', edition_year: 2027, status: 'open' },
      { id: 'other', name: 'Other Cup', edition_year: 2026, status: 'complete' }],
    courses: [{ id: 'pine', name: 'Pine', tees: [] }],
    matches: [ordinary, { ...ordinary, id: 'final', status: 'final' },
      { ...ordinary, id: 'other-match', tournament_id: 'other' },
      { ...ordinary, id: 'squad', name: 'Blue A', format: 'scramble' }],
    memberships: ['blue', 'white', 'blue2', 'white2'].map(id => ({ user_id: id, tournament_id: 'current',
      team: id.startsWith('blue') ? 'cardinal' : 'silver', status: 'active', role: 'player', profiles: { display_name: id } })),
    scrambleSessions: [{ texas_scramble_squads: [{ match_id: 'squad' }] }],
    rules: [], rounds: [], legacyEditions: [], settings: [], commentaries: [], resultAudits: [],
  });
}

let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome' }); });
after(async () => { await browser?.close(); });

// Serve the real page, templates, and handlers from disk. Only the data boundary is stubbed;
// no HTTP server, CDN, Supabase endpoint, credentials, or live data is used.
async function openPlanner(t, data, api = {}) {
  const page = await browser.newPage({ timezoneId: 'America/Los_Angeles' });
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const requests = {
    loadAdminData: () => data,
    loadTournamentMatchPlans: tournamentId => data.matches.filter(match => match.tournament_id === tournamentId),
    loadMembershipRosterData: () => ({ tournaments: data.tournaments, memberships: data.memberships }),
    ...api,
  };
  await page.exposeFunction('plannerTestRequest', (method, ...args) => requests[method](...args));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/admin.html') {
      const html = await readFile(new URL('admin.html', root), 'utf8');
      const imports = { 'https://esm.sh/@supabase/supabase-js@2': '/planner-test-sdk.js' };
      return route.fulfill({ contentType: 'text/html', body: html.replace('</head>', `<script type="importmap">${JSON.stringify({ imports })}</script></head>`) });
    }
    if (url.pathname === '/src/config.js') return route.fulfill({ contentType: 'text/javascript', body: `
      export const SUPABASE_URL = 'http://127.0.0.1', SUPABASE_PUBLISHABLE_KEY = 'local-fixture', hasSupabaseConfig = () => true;` });
    // Exercise the real saveMatchPlan + loadTournamentMatchPlans, right up to their SDK calls.
    if (url.pathname === '/planner-test-sdk.js') return route.fulfill({ contentType: 'text/javascript', body: `
      export const createClient = () => ({
        async rpc(name, { match_payload: match, segment_payload: segments }) {
          if (name !== 'save_match_plan_with_entry_modes') throw new Error('Unexpected RPC: ' + name);
          try { return { data: await window.plannerTestRequest('saveMatchPlan', { match, segments }) }; }
          catch (error) { return { error: { message: error.message } }; }
        },
        from(table) {
          if (table !== 'matches') throw new Error('Unexpected planner read: ' + table);
          return { select(fields) { this.fields = fields; return this; }, order() { return this; }, limit() { return this; },
            eq(key, value) { if (key === 'tournament_id') this.tournamentId = value; return this; },
            then(yes, no) {
              if (!this.tournamentId || !this.fields.includes('match_hole_outcomes(hole_number)') || !this.fields.includes('scores!scores_round_id_fkey(hole_number)')) throw new Error('Missing scoped play evidence');
              return window.plannerTestRequest('loadTournamentMatchPlans', this.tournamentId).then(data => ({ data })).then(yes, no);
            } };
        }
      });` });
    if (url.pathname === '/src/supabase.js' && !url.searchParams.has('real')) {
      const stubbedReads = Object.keys(requests).filter(name => !['saveMatchPlan', 'loadTournamentMatchPlans'].includes(name));
      return route.fulfill({ contentType: 'text/javascript', body: `
        export * from './supabase.js?real';
        export const getCurrentSession = async () => ({ user: { id: 'organizer' } });
        export const loadPlayerData = async () => ({ profile: { role: 'admin' }, memberships: [] });
        ${stubbedReads.map(name => `export const ${name} = (...args) => window.plannerTestRequest('${name}', ...args);`).join('\n')}
      ` });
    }
    if (!/^\/(admin\.html|[\w-]+\.css|src\/[\w-]+\.js|assets\/icon\.svg)$/.test(url.pathname)) return route.abort();
    return route.fulfill({ path: fileURLToPath(new URL(`.${url.pathname}`, root)) });
  });
  await page.goto(`${origin}/admin.html`);
  await page.locator('#adminContent').waitFor();
  return page;
}

const selectValues = locator => locator.evaluateAll(nodes => nodes.map(node => node.value));

test('the ordinary planner opens the exact tournament match and its ordered segments and lineup', async t => {
  const page = await openPlanner(t, fixture());
  const form = page.locator('#matchPlanForm');
  const existing = form.locator('#matchPlanExisting');
  assert.deepEqual(await selectValues(existing.locator('option')), ['', 'ordinary', 'final']);
  await existing.selectOption('ordinary');
  assert.equal(await form.locator('[name=matchName]').inputValue(), ordinary.name);
  assert.equal(await form.locator('[name=session]').inputValue(), ordinary.session);
  assert.equal(await form.locator('[name=startsAt]').inputValue(), '2027-11-07T01:30');
  assert.equal(await form.locator('#matchCourse').inputValue(), 'pine');
  const cards = form.locator('.segment-card');
  assert.equal(await cards.count(), 2);
  for (const [i, values] of [[0, ['1', '9', 'singles', 'net', 'hole_outcomes', '83.25', '0.35']],
    [1, ['10', '18', 'foursomes', 'gross', 'individual_scores', '', '1.5']]]) {
    assert.deepEqual(await selectValues(cards.nth(i).locator('.segment-fields [name]')), values);
  }
  assert.deepEqual(await selectValues(cards.nth(0).locator('[data-player-select]')), ['blue', '', '', 'white']);
  assert.deepEqual(await selectValues(cards.nth(1).locator('[data-player-select]')), ['blue', 'white', 'blue2', 'white2']);
  assert.match(await cards.nth(0).locator('[data-player-select]').first().locator(':checked').textContent(), /White/);
  await form.locator('#matchTournament').selectOption('other');
  assert.deepEqual(await selectValues(existing.locator('option')), ['', 'other-match']);
  assert.equal(await existing.inputValue(), '');
});

const rpcSegment = ({ id, match_segment_players, match_hole_outcomes, ...definition }) => ({
  ...definition, players: [...match_segment_players].sort((a, b) => a.playing_order - b.playing_order),
});

test('a real rename submits the selected ID and unchanged structure, then reopens authoritative data without resetting other forms', async t => {
  const data = fixture();
  const match = data.matches[0];
  match.status = 'live';
  const [last, first] = match.match_segments;
  first.point_value = 0.5;
  last.handicap_allowance = 74.25; // A valid recorded gross allowance must not become null.
  data.memberships = data.memberships.filter(row => row.user_id !== 'blue2');
  const calls = [];
  const page = await openPlanner(t, data, { saveMatchPlan: payload => {
    calls.push(payload);
    match.name = payload.match.name.trim();
    match.session = 'Authoritative session';
    return match.id;
  } });
  const form = page.locator('#matchPlanForm');
  await form.locator('#matchPlanExisting').selectOption(match.id);
  const ruleTitle = page.locator('#ruleForm [name=title]');
  await ruleTitle.fill('Unsubmitted rule');
  await form.locator('[name=matchName]').fill('  New name  ');
  await form.locator('button[type=submit]').click();
  await expect(form.locator('#matchPlanMessage')).toHaveText('Match plan saved.');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].match, { id: match.id, name: '  New name  ', session: ordinary.session,
    starts_at: ordinary.starts_at, course_id: 'pine', tournament_id: 'current', status: 'live' });
  assert.deepEqual(calls[0].segments, [rpcSegment(first), rpcSegment(last)]);
  assert.equal(await form.locator('#matchPlanExisting').inputValue(), match.id);
  assert.match(await form.locator('#matchPlanExisting :checked').textContent(), /New name/);
  assert.equal(await form.locator('[name=session]').inputValue(), 'Authoritative session');
  assert.equal(await ruleTitle.inputValue(), 'Unsubmitted rule');
});

for (const source of ['hole outcome', 'individual score']) {
  test(`after a saved ${source}, only the name can change; all other persisted fields round-trip exactly`, async t => {
    const data = fixture();
    const match = data.matches[0];
    if (source === 'hole outcome') match.match_segments[1].match_hole_outcomes.push({ hole_number: 1 });
    else data.rounds.push({ id: 'r', match_id: match.id, scores: [{ hole_number: 10 }] });
    // A renamed match must not lose a historic course omitted from the active course catalog.
    match.course_id = 'retired';
    match.courses = { name: 'Old course' };
    match.session = 'Recorded\nsession'; // text inputs cannot represent every stored string
    if (source === 'individual score') match.starts_at = null;
    const calls = [];
    const page = await openPlanner(t, data, { saveMatchPlan: payload => { calls.push(payload); return match.id; } });
    const form = page.locator('#matchPlanForm');
    await form.locator('#matchPlanExisting').selectOption(match.id);
    const buttons = form.locator('[name=session], [name=startsAt], #matchCourse, #addSegment, .segment-card :is(button,input,select)');
    assert.equal(await buttons.evaluateAll(nodes => nodes.every(node => node.matches(':disabled'))), true);
    assert.equal(await form.locator('#matchCourse').inputValue(), 'retired');
    await expect(form.locator('#matchPlanState')).toHaveText('Only the match name can be changed after play is recorded.');
    await form.locator('[name=matchName]').fill('New label');
    await form.locator('button[type=submit]').click();
    await expect(form.locator('#matchPlanMessage')).toHaveText('Match plan saved.');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].match, { id: match.id, name: 'New label', session: match.session,
      starts_at: match.starts_at, course_id: 'retired', tournament_id: 'current', status: 'scheduled' });
    assert.deepEqual(calls[0].segments, [rpcSegment(match.match_segments[1]), rpcSegment(match.match_segments[0])]);
  });
}

test('final matches and closed tournaments are visibly read-only; a new plan in an open tournament is editable', async t => {
  const page = await openPlanner(t, fixture());
  const form = page.locator('#matchPlanForm');
  const submit = form.locator('button[type=submit]');
  await form.locator('#matchPlanExisting').selectOption('final');
  assert.equal(await submit.isDisabled(), true);
  assert.equal(await form.locator('[name=matchName]').isDisabled(), true);
  await expect(form.locator('#matchPlanState')).toContainText('read-only');
  await form.locator('#matchTournament').selectOption('other');
  assert.equal(await submit.isDisabled(), true);
  await form.locator('#matchPlanExisting').selectOption('other-match');
  assert.equal(await submit.isDisabled(), true);
  await form.locator('#matchTournament').selectOption('current');
  assert.equal(await submit.isEnabled(), true);
  assert.equal(await form.locator('[name=matchName]').inputValue(), '');
  assert.equal(await form.locator('[name=pointValue]').first().isEditable(), true);
  assert.deepEqual(await selectValues(form.locator('[name=format]')), ['fourball', 'foursomes']);
});

test('a stale pre-play point edit submits once, displays the server refusal verbatim and keeps the draft on the same ID', async t => {
  const data = fixture();
  const match = data.matches[0];
  data.rounds.push({ match_id: match.id, scores: [] }, { match_id: 'other-match', scores: [{ hole_number: 1 }] });
  const calls = [];
  const gate = Promise.withResolvers();
  const refusal = 'Only the match name can be changed after play is recorded';
  const page = await openPlanner(t, data, { saveMatchPlan: async payload => {
    calls.push(payload);
    await gate.promise;
    if (match.match_segments[1].match_hole_outcomes.length && payload.segments[0].point_value !== front.point_value) throw new Error(refusal);
    throw new Error('Expected a changed point value on a scored match');
  } });
  const form = page.locator('#matchPlanForm');
  await form.locator('#matchPlanExisting').selectOption(match.id);
  const point = form.locator('[name=pointValue]').first();
  assert.equal(await point.isEditable(), true);
  await point.fill('1.25');
  await form.locator('[name=matchName]').fill('Unsubmitted rename');
  match.match_segments[1].match_hole_outcomes.push({ hole_number: 1 }); // another scorer; page remains open
  const submit = form.locator('button[type=submit]');
  await submit.click();
  const disabledWhileSaving = await submit.isDisabled();
  await form.evaluate(node => node.requestSubmit()); // repeated Enter/submit while the first request is outstanding
  gate.resolve();
  await expect(form.locator('#matchPlanMessage')).toHaveText(refusal);
  assert.equal(disabledWhileSaving, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].match.id, match.id);
  assert.equal(calls[0].segments[0].point_value, 1.25);
  assert.equal(await form.locator('#matchPlanExisting').inputValue(), match.id);
  assert.equal(await form.locator('[name=matchName]').inputValue(), 'Unsubmitted rename');
  assert.equal(await point.inputValue(), '1.25');
  assert.equal(await submit.isEnabled(), true);
});

test('before play the form accepts recorded point precision and interprets a changed schedule in New York', async t => {
  const data = fixture();
  const match = data.matches[0];
  const calls = [];
  const page = await openPlanner(t, data, { saveMatchPlan: payload => {
    calls.push(payload);
    match.match_segments[1].point_value = payload.segments[0].point_value;
    match.rounds = [{ scores: [{ hole_number: 1 }] }]; // new evidence returned by the planner-only refresh
    return match.id;
  } });
  const form = page.locator('#matchPlanForm');
  await form.locator('#matchPlanExisting').selectOption(match.id);
  const point = form.locator('[name=pointValue]').first();
  assert.equal(await form.evaluate(node => node.checkValidity()), true, 'the stored 0.35 must not block an ordinary submit');
  await point.fill('0.65');
  await form.locator('[name=session]').fill('Sunday');
  await form.locator('[name=startsAt]').fill('2027-03-21T08:45');
  await form.locator('button[type=submit]').click();
  await expect(form.locator('#matchPlanMessage')).toHaveText('Match plan saved.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].match.id, match.id);
  assert.equal(calls[0].match.session, 'Sunday');
  assert.equal(calls[0].match.starts_at, '2027-03-21T12:45:00.000Z');
  assert.equal(calls[0].segments[0].point_value, 0.65);
  assert.equal(await point.inputValue(), '0.65');
  assert.equal(await point.isDisabled(), true);
});

async function fillNewPlan(page) {
  const form = page.locator('#matchPlanForm');
  await form.locator('[name=matchName]').fill('New singles');
  await form.locator('[name=session]').fill('Morning');
  await form.locator('[name=startsAt]').fill('2027-03-19T08:00');
  await form.locator('#matchCourse').selectOption('pine');
  await form.locator('.remove-segment').last().click();
  await form.locator('[name=endHole]').fill('18');
  await form.locator('[name=format]').selectOption('singles');
  await form.locator('[data-player-select]').nth(0).selectOption('blue');
  await form.locator('[data-player-select]').nth(3).selectOption('white');
  return form;
}

test('a confirmed new-plan save whose readback fails cannot be retried as another insert', async t => {
  const calls = [];
  const page = await openPlanner(t, fixture(), {
    saveMatchPlan: payload => { calls.push(payload); return 'created'; },
    loadTournamentMatchPlans: () => { throw new Error('Readback unavailable'); },
  });
  const form = await fillNewPlan(page);
  await form.locator('button[type=submit]').click();
  await expect(form.locator('#matchPlanMessage')).toHaveText('Match plan saved, but it could not be reloaded: Readback unavailable');
  assert.equal(Object.hasOwn(calls[0].match, 'id'), false);
  assert.equal(await form.locator('#matchPlanExisting').inputValue(), 'created');
  assert.equal(await form.locator('button[type=submit]').isDisabled(), true);
  await form.evaluate(node => node.requestSubmit());
  assert.equal(calls.length, 1);
});

test('refreshing the roster keeps a new draft, clears unavailable players and binds a successful insert to its returned ID', async t => {
  const data = fixture();
  const calls = [];
  const page = await openPlanner(t, data, { saveMatchPlan: payload => {
    calls.push(payload);
    data.matches.push({ ...payload.match, id: 'created', match_segments: payload.segments.map(({ players, ...segment }) =>
      ({ ...segment, id: 'saved-segment', match_segment_players: players, match_hole_outcomes: [] })) });
    return 'created';
  } });
  const form = await fillNewPlan(page);
  data.memberships.find(row => row.user_id === 'blue').team = null;
  await page.locator('#refreshMemberships').click();
  await expect(page.locator('#membershipMessage')).toHaveText('Membership requests refreshed.');
  const slots = form.locator('[data-player-select]');
  assert.deepEqual(await selectValues(slots), ['', '', '', 'white']);
  assert.equal(await slots.first().locator('option[value=blue]').isDisabled(), true);
  assert.equal(await form.locator('[name=matchName]').inputValue(), 'New singles');
  await slots.first().selectOption('blue2');
  await form.locator('button[type=submit]').click();
  await expect(form.locator('#matchPlanMessage')).toHaveText('Match plan saved.');
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0].match, 'id'), false);
  assert.deepEqual(calls[0].segments[0].players, [player('blue2', 'cardinal', 'cardinal', 1), player('white', 'silver', 'silver', 4)]);
  assert.equal(await form.locator('#matchPlanExisting').inputValue(), 'created');
  assert.deepEqual(await selectValues(slots), ['blue2', '', '', 'white']);
});

test('another Admin readback does not reset the tournament or course underneath a dirty ordinary plan', async t => {
  const data = fixture();
  data.tournaments.reverse();
  data.legacyEditions.push({ id: 'archive', edition_year: 2026, source_tournament_id: 'other', status: 'completed', legacy_results: [], legacy_photos: [] });
  const page = await openPlanner(t, data, { completeTournamentArchive: () => null });
  const form = page.locator('#matchPlanForm');
  await form.locator('#matchTournament').selectOption('current');
  await form.locator('#matchPlanExisting').selectOption('ordinary');
  await form.locator('[name=matchName]').fill('In progress');
  await page.locator('#completionTournament').selectOption('other');
  await page.locator('#completionConfirmation').fill('COMPLETE 2026 HEREFORD CUP');
  await page.locator('#tournamentCompletionForm button[type=submit]').click();
  await expect(page.locator('#completionMessage')).toHaveText('Completed tournament archive verified without changes.');
  assert.equal(await form.locator('#matchTournament').inputValue(), 'current');
  assert.equal(await form.locator('#matchPlanExisting').inputValue(), 'ordinary');
  assert.equal(await form.locator('#matchCourse').inputValue(), 'pine');
  assert.equal(await form.locator('[name=matchName]').inputValue(), 'In progress');
});

test('changing tournaments while drafting a new plan keeps its details but resets the tournament lineups', async t => {
  const data = fixture();
  data.tournaments[1].status = 'setup';
  const form = await fillNewPlan(await openPlanner(t, data));
  await form.locator('#matchTournament').selectOption('other');
  assert.equal(await form.locator('#matchPlanExisting').inputValue(), '');
  assert.equal(await form.locator('[name=matchName]').inputValue(), 'New singles');
  assert.equal(await form.locator('[name=session]').inputValue(), 'Morning');
  assert.equal(await form.locator('[name=startsAt]').inputValue(), '2027-03-19T08:00');
  assert.equal(await form.locator('#matchCourse').inputValue(), 'pine');
  assert.deepEqual(await selectValues(form.locator('[name=format]')), ['fourball', 'foursomes']);
  assert.deepEqual(await selectValues(form.locator('[data-player-select]')), Array(8).fill(''));
});

test('a stored historical segment format is visible on its own card without adding a new-plan format', async t => {
  const data = fixture();
  data.matches[1].match_segments = structuredClone(data.matches[1].match_segments);
  data.matches[1].match_segments[1].format = 'shamble';
  const form = (await openPlanner(t, data)).locator('#matchPlanForm');
  const existing = form.locator('#matchPlanExisting');
  await existing.selectOption('final');
  assert.equal(await form.locator('[name=format]').first().inputValue(), 'shamble');
  await existing.selectOption('');
  assert.equal(await form.locator('[name=format] option[value=shamble]').count(), 0);
});
