import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Exercise the real admin page and event handlers. Only the data API is replaced;
// every request is intercepted, and no configured Supabase client is loaded.
const root = new URL('../', import.meta.url);
const apiSource = await readFile(new URL('src/supabase.js', root), 'utf8');
const fakeApi = [...apiSource.matchAll(/^export (?:async )?function (\w+)/gm)]
  .map(([, name]) => `export const ${name} = (...args) => window.plannerApi('${name}', ...args);`).join('\n');
let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome' }); });
after(async () => { await browser?.close(); });

function sampleData() {
  const playerName = id => ['b1', 'b2'].includes(id) ? 'Blue guest' : `Golfer ${id}`;
  const tournaments = ['other', 'cup'].map((id, index) => ({ id, name: id, edition_year: 2028 - index, status: 'open' }));
  const squads = [
    { id: 'white', label: 'White visitors', side: 'silver', squad_number: 7, ids: ['w2', 'w4', 'w3', 'w1'] },
    { id: 'blue', label: 'Blue pair', side: 'cardinal', squad_number: 3, ids: ['b2', 'b1'] },
  ].map(({ ids, ...s }) => ({ ...s, session_id: 'lineup', match_id: `match-${s.id}`, segment_id: `segment-${s.id}`,
    squad_size: ids.length, status: 'live', texas_scramble_hole_scores: [],
    texas_scramble_squad_players: ids.map((user_id, i) => ({ user_id, playing_order: i + 1, profiles: { display_name: playerName(user_id) } })).reverse() }));
  const matches = squads.map(s => ({ id: s.match_id, tournament_id: 'cup', name: s.label, format: 'scramble', status: 'live',
    match_segments: [{ id: s.segment_id, format: 'scramble', status: 'live', holes_played: 0, differential: 0, point_value: 0 }] }));
  const memberships = Array.from({ length: 8 }, (_, i) => i + 1).flatMap(n => ['b', 'w'].map(prefix => ({
    user_id: `${prefix}${n}`, tournament_id: 'cup', status: 'active', team: prefix === 'b' ? 'cardinal' : 'silver',
    role: 'player', profiles: { display_name: playerName(`${prefix}${n}`) },
  })));
  const session = { id: 'lineup', tournament_id: 'cup', name: 'Back nine', session_label: 'Morning groups', status: 'live',
    starts_at: '2027-03-19T12:35:00Z', course_id: 'links', tee_id: 'tee', start_hole: 10, end_hole: 18,
    required_tee_shots: 2, texas_scramble_squads: squads };
  return { tournaments, memberships, matches, courses: [{ id: 'links', name: 'Links', tees: [{ id: 'tee', name: 'Medal', rating_category: 'M', rating: 72, slope: 113 }] }],
    scrambleSessions: [session, { ...session, id: 'other-lineup', tournament_id: 'other', texas_scramble_squads: [] }],
    legacyEditions: [], rounds: [], settings: [], commentaries: [], rules: [], resultAudits: [] };
}

async function openPlanner(t, data = sampleData(), overrides = {}) {
  const page = await browser.newPage({ timezoneId: 'America/Los_Angeles' });
  t.after(() => page.close());
  const api = { getCurrentSession: () => ({ user: { id: 'organizer' } }), loadPlayerData: () => ({ profile: { role: 'admin' }, memberships: [] }),
    loadAdminData: () => data, loadMembershipRosterData: () => data, loadMatchResultAudits: () => [], ...overrides };
  await page.exposeFunction('plannerApi', (name, ...args) => {
    assert.ok(api[name], `Unexpected data API: ${name}`);
    return api[name](...args);
  });
  await page.route('**/*', route => {
    const { origin, pathname } = new URL(route.request().url());
    if (origin !== 'http://127.0.0.1') return route.abort();
    if (pathname === '/src/supabase.js') return route.fulfill({ contentType: 'text/javascript', body: fakeApi });
    if (/^\/(?:admin\.html|[\w-]+\.css|src\/[\w-]+\.js)$/.test(pathname)) return route.fulfill({ path: fileURLToPath(new URL(`.${pathname}`, root)) });
    return route.abort();
  });
  await page.goto('http://127.0.0.1/admin.html?tool=scramble');
  await page.locator('#adminContent:not([hidden])').waitFor({ timeout: 5000 });
  return page;
}

const form = '#texasScrambleForm';
const saved = '#texasScrambleSavedSession';
const cards = '#texasScrambleSquads [data-squad-side]';
const squadState = page => page.locator(cards).evaluateAll(nodes => nodes.map(card => ({
  label: card.querySelector('legend').textContent, side: card.dataset.squadSide, number: card.dataset.squadNumber,
  players: [...card.querySelectorAll('[data-scramble-player]')].map(select => select.value),
})));

async function saveLineup(page) {
  await page.click(`${form} button[type=submit]`);
  await page.waitForFunction(() => document.querySelector('#texasScrambleMessage').textContent.includes('plan saved.'), null, { timeout: 3000 });
}

test('open the exact tournament lineup with its local start, tee and ordered two-/four-player squads', async t => {
  const page = await openPlanner(t);
  assert.equal(await page.locator(saved).count(), 1, 'planner must offer a saved-session selector');
  await page.selectOption('#texasScrambleTournament', 'cup');
  assert.deepEqual(await page.locator(`${saved} option`).evaluateAll(options => options.map(o => o.value)), ['', 'lineup']);
  await page.selectOption(saved, 'lineup');
  assert.deepEqual(await page.locator(form).evaluate(f => ['name', 'sessionLabel', 'startsAt', 'courseId', 'teeId', 'requiredTeeShots'].map(key => f.elements[key].value)),
    ['Back nine', 'Morning groups', '2027-03-19T08:35', 'links', 'tee', '2']);
  assert.deepEqual(await squadState(page), [
    { label: 'Blue pair', side: 'cardinal', number: '3', players: ['b2', 'b1'] },
    { label: 'White visitors', side: 'silver', number: '7', players: ['w2', 'w4', 'w3', 'w1'] },
  ]);
  assert.equal(await page.locator(`${form} button[type=submit]`).isEnabled(), true, 'a tee-selected live session without play remains editable');
  assert.match(await page.textContent(`${form} button[type=submit]`), /update/i, 'do not present a saved lineup as a new plan');
  const firstBlue = page.locator('#texasScrambleSquads [data-squad-id="blue"] [data-playing-order="1"]');
  assert.equal(await firstBlue.inputValue(), 'b2', 'the two identically named guests remain distinct');
  assert.equal(await firstBlue.locator('option:checked').textContent(), 'Blue guest');
  await page.selectOption(saved, '');
  assert.deepEqual((await squadState(page)).map(s => [s.label, s.players]),
    ['Blue A', 'Blue B', 'White A', 'White B'].map(label => [label, ['', '', '', '']]));
  assert.equal(await page.inputValue(`${form} [name=sessionLabel]`), '');
  assert.equal(await page.inputValue('#texasScrambleCourse'), '');
});

test('editing submits one update for the original ID and preserves another organizer draft across readback', async t => {
  const data = sampleData();
  const original = data.scrambleSessions[0];
  original.starts_at = '2027-11-07T06:30:47Z'; // the second 01:30 after the clocks go back
  const writes = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const page = await openPlanner(t, data, { saveTexasScramblePlan: async payload => {
    writes.push(payload);
    await pending;
    original.name = payload.session.name.trim();
    const blue = original.texas_scramble_squads.find(s => s.side === 'cardinal');
    blue.texas_scramble_squad_players = payload.squads[0].player_ids.map((user_id, i) => ({ user_id, playing_order: i + 1 }));
    return original.id;
  } });
  await page.selectOption('#adminTool', 'rules');
  await page.fill('#ruleForm [name=title]', 'Unpublished rule draft');
  await page.selectOption('#adminTool', 'scramble');
  await page.selectOption('#texasScrambleTournament', 'cup');
  await page.selectOption(saved, original.id);
  await page.fill(`${form} [name=name]`, ' New pairings ');
  await page.locator(`${cards}[data-squad-side=cardinal] select`).first().selectOption('b3');
  await page.locator(form).evaluate(f => { f.requestSubmit(); f.requestSubmit(); });
  const submit = page.locator(`${form} button[type=submit]`);
  assert.equal(await submit.isDisabled(), true, `save must be pending: ${await page.textContent('#texasScrambleMessage')}`);
  assert.equal(await page.locator(saved).isDisabled(), true);
  release();
  await page.waitForFunction(() => /saved|updated/i.test(document.querySelector('#texasScrambleMessage').textContent), null, { timeout: 3000 });
  assert.deepEqual(writes.map(w => w.session.id), ['lineup'], 'one existing-ID RPC; no create call on edit or double submit');
  assert.deepEqual(writes[0].session, { id: 'lineup', tournament_id: 'cup', name: ' New pairings ', session_label: 'Morning groups',
    starts_at: original.starts_at, start_hole: 10, end_hole: 18, required_tee_shots: 2 });
  assert.deepEqual(writes[0].squads, [
    { label: 'Blue pair', side: 'cardinal', squad_number: 3, player_ids: ['b3', 'b1'] },
    { label: 'White visitors', side: 'silver', squad_number: 7, player_ids: ['w2', 'w4', 'w3', 'w1'] },
  ]);
  assert.equal(await page.inputValue('#texasScrambleTournament'), 'cup');
  assert.equal(await page.inputValue(saved), original.id);
  assert.equal(await page.inputValue(`${form} [name=name]`), 'New pairings', 'render the authoritative readback');
  assert.equal(await page.inputValue('#ruleForm [name=title]'), 'Unpublished rule draft');
  assert.deepEqual((await squadState(page))[0].players, ['b3', 'b1']);
  assert.equal(await submit.isEnabled(), true);
});

test('a lineup-only retry preserves a tee chosen by a player after the organizer opened a blank tee selection', async t => {
  const data = sampleData();
  const stored = Object.assign(data.scrambleSessions[0], { course_id: null, tee_id: null });
  const writes = [];
  const page = await openPlanner(t, data, { saveTexasScramblePlan: ({ session }) => {
    writes.push(session);
    if (writes.length === 1) throw new Error('Save interrupted');
    Object.assign(stored, session); // Omitted keys preserve the pair; explicit nulls clear it.
    return stored.id;
  } });
  await page.selectOption('#texasScrambleTournament', 'cup');
  await page.selectOption(saved, stored.id);
  await page.locator(`${cards}[data-squad-side=cardinal] select`).first().selectOption('b3');
  Object.assign(stored, { course_id: 'links', tee_id: 'tee' }); // The player's choice races the lineup edit.
  await page.click(`${form} button[type=submit]`);
  await page.getByText('Save interrupted', { exact: true }).waitFor();
  // The failed save refreshed the data cache, not the organizer's still-open draft.
  assert.equal(await page.inputValue('#texasScrambleTee'), '');
  await saveLineup(page);
  assert.deepEqual([stored.course_id, stored.tee_id], ['links', 'tee'], 'the stale lineup must not clear the player-selected tee');
  assert.deepEqual(writes.map(s => [Object.hasOwn(s, 'course_id'), Object.hasOwn(s, 'tee_id')]), [[false, false], [false, false]]);
  assert.equal(await page.inputValue('#texasScrambleTee'), 'tee', 'the successful readback shows the player-selected tee');
});

test('changing or clearing a hydrated tee sends the explicit pair, but returning to the hydrated selection does not', async t => {
  const data = sampleData();
  data.courses[0].tees.push({ ...data.courses[0].tees[0], id: 'forward', name: 'Forward' });
  const writes = [];
  const page = await openPlanner(t, data, { saveTexasScramblePlan: ({ session }) => {
    writes.push(session);
    Object.assign(data.scrambleSessions[0], session);
    return session.id;
  } });
  await page.selectOption('#texasScrambleTournament', 'cup');
  await page.selectOption(saved, 'lineup');
  await page.selectOption('#texasScrambleTee', 'forward');
  await saveLineup(page);
  await page.selectOption('#texasScrambleTee', 'tee');
  await page.selectOption('#texasScrambleTee', 'forward');
  await saveLineup(page);
  await page.selectOption('#texasScrambleCourse', '');
  await saveLineup(page);
  assert.deepEqual(writes.map(s => [s.course_id, s.tee_id]), [['links', 'forward'], [undefined, undefined], [null, null]]);
  assert.equal(await page.inputValue('#texasScrambleTee'), '');
});

test('played, finalized, archived or unverifiable lineups stay read-only, even on a direct submit event', async t => {
  for (const [caseName, change] of [
    ['submitted hole in one squad', (d, s) => { s.texas_scramble_squads[0].texas_scramble_hole_scores.push({ hole_number: 10 }); }],
    ['final session', (d, s) => { s.status = 'final'; }],
    ['final squad', (d, s) => { s.texas_scramble_squads[0].status = 'final'; }],
    ['final linked match', d => { d.matches[0].status = 'final'; }],
    ['played linked segment', d => { d.matches[0].match_segments[0].holes_played = 1; }],
    ['linked individual round', d => { d.rounds.push({ match_id: d.matches[0].id }); }],
    ['archived tournament', d => { d.tournaments[1].status = 'archived'; }],
    ['generated archive', d => { d.legacyEditions.push({ id: 'archive', source_tournament_id: 'cup', legacy_results: [] }); }],
    ['missing shared-score evidence', (d, s) => { delete s.texas_scramble_squads[0].texas_scramble_hole_scores; }],
    ['incomplete player list', (d, s) => { s.texas_scramble_squads[0].texas_scramble_squad_players = []; }],
  ]) await t.test(caseName, async t => {
    const data = sampleData();
    change(data, data.scrambleSessions[0]);
    const writes = [];
    const page = await openPlanner(t, data, { saveTexasScramblePlan: payload => { writes.push(payload); } });
    await page.selectOption('#texasScrambleTournament', 'cup');
    await page.selectOption(saved, 'lineup');
    for (const control of ['button[type=submit]', '[name=name]', '[data-scramble-player]']) {
      assert.equal(await page.locator(`${form} ${control}`).first().isDisabled(), true, caseName);
    }
    await page.locator(form).dispatchEvent('submit');
    assert.match(await page.textContent('#texasScrambleMessage'), /locked|read.only/i);
    assert.equal(await page.inputValue(saved), 'lineup');
    assert.equal(await page.locator(saved).isEnabled(), true);
    assert.deepEqual(writes, []);
  });
});

test('a first hole arriving during an edit locks the same lineup after the RPC rejects it', async t => {
  const data = sampleData();
  const writes = [];
  const page = await openPlanner(t, data, { saveTexasScramblePlan: payload => {
    writes.push(payload.session.id);
    data.scrambleSessions[0].texas_scramble_squads[0].texas_scramble_hole_scores.push({ hole_number: 10 });
    throw new Error('Cannot replace the scored plan');
  } });
  await page.selectOption('#texasScrambleTournament', 'cup');
  await page.selectOption(saved, 'lineup');
  const submit = page.locator(`${form} button[type=submit]`);
  await submit.click();
  await page.waitForFunction(() => document.querySelector('#texasScrambleForm').getAttribute('aria-busy') === 'false');
  assert.equal(await page.inputValue(saved), 'lineup');
  assert.equal(await submit.isDisabled(), true, 'refresh evidence of play after a rejected save');
  assert.match(await page.textContent('#texasScrambleMessage'), /locked.*play|submitted hole/i);
  await page.locator(form).dispatchEvent('submit');
  assert.deepEqual(writes, ['lineup']);
});

test('a new 16-player save sticks to the returned ID when readback fails instead of allowing another create', async t => {
  const data = sampleData();
  let reads = 0;
  const writes = [];
  const page = await openPlanner(t, data, {
    loadAdminData: () => { if (++reads > 1) throw new Error('Read unavailable'); return data; },
    saveTexasScramblePlan: payload => { writes.push(payload); return 'created-id'; },
  });
  await page.selectOption('#texasScrambleTournament', 'cup');
  await page.fill(`${form} [name=sessionLabel]`, 'Winter morning');
  await page.fill(`${form} [name=startsAt]`, '2027-01-16T08:15');
  await page.locator(cards).evaluateAll(nodes => nodes.forEach(card => {
    const prefix = card.dataset.squadSide === 'cardinal' ? 'b' : 'w';
    [...card.querySelectorAll('select')].forEach((select, i) => {
      select.value = `${prefix}${(Number(card.dataset.squadNumber) - 1) * 4 + i + 1}`;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }));
  await page.click(`${form} button[type=submit]`);
  await page.waitForFunction(() => document.querySelector('#texasScrambleForm').getAttribute('aria-busy') === 'false');
  assert.equal(await page.inputValue(saved), 'created-id', 'do not fall back to New after a committed save');
  assert.match(await page.textContent('#texasScrambleMessage'), /saved.*reload/i);
  assert.equal(await page.locator(`${form} button[type=submit]`).isDisabled(), true);
  await page.locator(form).dispatchEvent('submit');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].session.id, undefined);
  assert.equal(writes[0].session.starts_at, '2027-01-16T13:15:00.000Z');
  assert.equal(new Set(writes[0].squads.flatMap(s => s.player_ids)).size, 16);
});

test('a saved two-player round can keep a tee-shot minimum above the four-player preset limit', async t => {
  const data = sampleData();
  const s = data.scrambleSessions[0];
  s.texas_scramble_squads = s.texas_scramble_squads.filter(row => row.squad_size === 2);
  s.start_hole = 1;
  s.required_tee_shots = 8;
  const page = await openPlanner(t, data);
  await page.selectOption('#texasScrambleTournament', 'cup');
  await page.selectOption(saved, 'lineup');
  const minimum = page.locator(`${form} [name=requiredTeeShots]`);
  assert.equal(await minimum.evaluate(input => input.checkValidity()), true, 'eight tee shots per player fit an 18-hole two-player round');
  assert.equal(await minimum.getAttribute('max'), '9');
  assert.match(await page.textContent('#texasScrambleHoleRange'), /1–18/);
  await page.selectOption(saved, '');
  assert.equal(await minimum.getAttribute('max'), '4');
});

test('unavailable saved players and tees remain identifiable and cannot be silently dropped on save', async t => {
  const data = sampleData();
  data.memberships.find(m => m.user_id === 'b2').team = 'silver';
  data.courses = [];
  const writes = [];
  const page = await openPlanner(t, data, { saveTexasScramblePlan: payload => { writes.push(payload); } });
  await page.selectOption('#texasScrambleTournament', 'cup');
  await page.selectOption(saved, 'lineup');
  const first = page.locator(`${cards}[data-squad-side=cardinal] select`).first();
  assert.equal(await first.inputValue(), 'b2');
  assert.equal(await first.evaluate(select => select.selectedOptions[0].disabled), true);
  assert.equal(await page.inputValue('#texasScrambleCourse'), 'links');
  assert.equal(await page.inputValue('#texasScrambleTee'), 'tee');
  await page.locator(form).dispatchEvent('submit');
  assert.match(await page.textContent('#texasScrambleMessage'), /active|eligible/i);
  await first.selectOption('b3');
  await page.locator(form).dispatchEvent('submit');
  assert.match(await page.textContent('#texasScrambleMessage'), /course|tee/i);
  assert.deepEqual(writes, []);
});

test('an unrelated admin refresh preserves a dirty lineup, but never preserves permission to edit after play', async t => {
  const data = sampleData();
  data.tournaments[0].status = 'complete';
  data.legacyEditions.push({ id: 'other-archive', edition_year: 2028, venue: 'Other', source_tournament_id: 'other',
    status: 'completed', legacy_results: [], legacy_photos: [] });
  let reads = 0;
  const page = await openPlanner(t, data, { completeTournamentArchive: () => {}, loadAdminData: () => { reads++; return data; } });
  await page.selectOption('#texasScrambleTournament', 'cup');
  await page.selectOption(saved, 'lineup');
  await page.fill(`${form} [name=name]`, 'Unsubmitted lineup draft');
  await page.selectOption('#adminTool', 'completion');
  await page.selectOption('#completionTournament', 'other');
  const refreshFromOtherForm = async () => {
    await page.fill('#completionConfirmation', 'COMPLETE 2028 HEREFORD CUP');
    await page.click('#tournamentCompletionForm button[type=submit]');
    await page.waitForFunction(() => !document.querySelector('#completionConfirmation').value);
  };
  await refreshFromOtherForm();
  assert.equal(await page.inputValue(saved), 'lineup');
  assert.equal(await page.inputValue(`${form} [name=name]`), 'Unsubmitted lineup draft');
  data.scrambleSessions[0].texas_scramble_squads[0].texas_scramble_hole_scores.push({ hole_number: 10 });
  await refreshFromOtherForm();
  assert.equal(reads, 3);
  assert.equal(await page.inputValue(saved), 'lineup');
  assert.equal(await page.locator(`${form} button[type=submit]`).isDisabled(), true);
  assert.match(await page.textContent('#texasScrambleMessage'), /locked.*play/i);
  data.scrambleSessions = data.scrambleSessions.filter(s => s.id !== 'lineup');
  await refreshFromOtherForm();
  assert.equal(await page.inputValue(saved), 'lineup', 'a disappeared lineup is not a request to create one');
  assert.equal(await page.locator(cards).count(), 0);
  assert.equal(await page.inputValue(`${form} [name=name]`), '', 'do not present new-plan defaults as saved metadata');
  assert.equal(await page.locator(`${form} button[type=submit]`).isDisabled(), true);
});

test('planner readback leaves the mounted member editor attached to its roster record', async t => {
  const data = sampleData();
  data.tournaments[1].status = 'live';
  const page = await openPlanner(t, data, {
    saveTexasScramblePlan: ({ session }) => session.id,
    setTournamentMemberRole: ({ role }) => ({ role }),
  });
  const member = page.locator('#activeMembers [data-member-id=b1]');
  await page.selectOption('#adminTool', 'members');
  await member.getByLabel('Handicap index').fill('7.5');
  await page.selectOption('#adminTool', 'scramble');
  await page.selectOption('#texasScrambleTournament', 'cup');
  await page.selectOption(saved, 'lineup');
  await page.click(`${form} button[type=submit]`);
  await page.waitForFunction(() => /plan saved/.test(document.querySelector('#texasScrambleMessage').textContent));
  await page.selectOption('#adminTool', 'members');
  assert.equal(await member.getByLabel('Handicap index').inputValue(), '7.5');
  await member.getByLabel('Tournament role').selectOption('admin');
  await page.waitForFunction(() => /role is now Admin/.test(document.querySelector('#membershipMessage').textContent));
  assert.equal(await member.getByLabel('Tournament role').inputValue(), 'admin');
});

// Return fresh match/segment IDs on save, as the RPC does. Pause the save so an
// organizer can open the correction dialog while the lineup operation is pending.
async function openPickerFixture(t, data) {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const page = await openPlanner(t, data, {
    loadTeamCorrectionAudits: () => [],
    loadCorrectionMatch: id => ({ ...data.matches.find(m => m.id === id),
      correctionSquads: data.scrambleSessions.flatMap(s => s.texas_scramble_squads).filter(s => s.match_id === id) }),
    saveTexasScramblePlan: async ({ session, squads }) => {
      await pending;
      const prior = data.scrambleSessions.find(s => s.id === session.id);
      const next = { ...prior, ...session, id: session.id ?? 'created' };
      const retired = new Set(prior?.texas_scramble_squads.map(s => s.match_id));
      data.matches = data.matches.filter(m => !retired.has(m.id));
      next.status = next.tee_id ? 'live' : 'scheduled';
      next.texas_scramble_squads = squads.map(({ player_ids, ...squad }, i) => {
        const id = `fresh-${i}`, match_id = `match-${id}`, segment_id = `segment-${id}`;
        data.matches.push({ id: match_id, name: squad.label, tournament_id: next.tournament_id, format: 'scramble', status: next.status,
          match_segments: [{ id: segment_id, format: 'scramble', status: next.status, start_hole: next.start_hole, end_hole: next.end_hole,
            scoring_mode: 'net', holes_played: 0, differential: 0, point_value: 0 }] });
        return { ...squad, id, session_id: next.id, match_id, segment_id, status: next.status, squad_size: player_ids.length,
          texas_scramble_hole_scores: [], texas_scramble_squad_players: player_ids.map((user_id, j) => ({ user_id, squad_id: id, playing_order: j + 1 })) };
      });
      data.scrambleSessions = [...data.scrambleSessions.filter(s => s.id !== next.id), next];
      return next.id;
    },
  });
  // These two race tests deliberately use two mounted tools at once.
  await page.selectOption('#adminTool', 'all');
  return { page, finishSave: async () => { release(); await page.getByText(/Texas Scramble plan saved\./).waitFor(); } };
}

const resultMatchIds = page => page.locator('#resultMatch option').evaluateAll(options => options.map(o => o.value));

test('creating a lineup adds the returned squad matches to corrections without resetting a surviving result or correction draft', async t => {
  const data = sampleData();
  data.matches.push({ id: 'ordinary', name: 'Other foursomes', tournament_id: 'other', status: 'live',
    match_segments: [{ id: 'ordinary-segment', format: 'foursomes', start_hole: 1, end_hole: 9, scoring_mode: 'gross', point_value: 1 }] });
  data.rounds.push({ id: 'ordinary-round', match_id: 'ordinary', scores: [] });
  const { page, finishSave } = await openPickerFixture(t, data);
  await page.selectOption('#resultMatch', 'ordinary');
  await page.fill('#resultSegmentRows [name=differential]', '2');
  await page.fill('#ruleForm [name=title]', 'Unpublished rule');
  await page.selectOption('#texasScrambleTournament', 'cup');
  await page.fill(`${form} [name=sessionLabel]`, 'New groups');
  await page.fill(`${form} [name=startsAt]`, '2027-03-20T08:15');
  for (const [side, prefix] of [['cardinal', 'b'], ['silver', 'w']]) {
    const slots = await page.locator(`${cards}[data-squad-side=${side}] select`).all();
    for (const [i, slot] of slots.entries()) await slot.selectOption(`${prefix}${i + 1}`);
  }
  await page.click(`${form} button[type=submit]`);
  await page.click('#openScoreCorrection');
  await page.selectOption('#correctionRound', 'ordinary-round');
  await page.fill('#correctionReason', 'Checking the card');
  await finishSave();
  const created = data.scrambleSessions.find(s => s.id === 'created');
  assert.deepEqual([created.course_id, created.tee_id], [null, null], 'creation still sends both tee keys');
  assert.deepEqual(await resultMatchIds(page), ['', ...data.matches.map(m => m.id)], 'offer all newly created squad match IDs');
  assert.equal(await page.inputValue('#resultMatch'), 'ordinary');
  assert.equal(await page.inputValue('#resultSegmentRows [name=differential]'), '2');
  assert.equal(await page.inputValue('#ruleForm [name=title]'), 'Unpublished rule');
  assert.equal(await page.locator('#scoreCorrectionDialog').isVisible(), true);
  assert.equal(await page.inputValue('#correctionRound'), 'ordinary-round');
  assert.equal(await page.inputValue('#correctionReason'), 'Checking the card');
  await page.click('#closeScoreCorrection');

  const squad = created.texas_scramble_squads[0];
  squad.texas_scramble_hole_scores.push({ id: 'fresh-hole', squad_id: squad.id, hole_number: 1, gross_score: 4, tee_shot_player_id: 'b1' });
  await page.selectOption('#resultMatch', squad.match_id);
  await page.click('#openScoreCorrection');
  await page.locator('#scoreCorrectionDialog[open]').waitFor();
  assert.equal(await page.textContent('#correctionMatchLabel'), squad.label);
  assert.equal(await page.inputValue('#teamCorrectionEntry'), 'fresh-hole');
});

test('replacing a lineup removes retired squad match IDs, clears their selected results and history, and explains the change', async t => {
  const data = sampleData();
  const { page, finishSave } = await openPickerFixture(t, data);
  await page.selectOption('#resultMatch', 'match-blue');
  await page.locator('#resultSegmentRows [data-segment-id=segment-blue]').waitFor();
  await page.getByText('No authoritative result changes have been logged for this match.').waitFor();
  await page.getByText('No shared score corrections have been logged for this match.').waitFor();
  await page.selectOption('#texasScrambleTournament', 'cup');
  await page.selectOption(saved, 'lineup');
  await page.locator(`${cards}[data-squad-side=cardinal] select`).first().selectOption('b3');
  await page.click(`${form} button[type=submit]`);
  await page.click('#openScoreCorrection');
  await page.locator('#scoreCorrectionDialog[open]').waitFor();
  await finishSave();
  assert.deepEqual(await resultMatchIds(page), ['', ...data.matches.map(m => m.id)], 'replace retired IDs with authoritative squad match IDs');
  assert.equal(await page.inputValue('#resultMatch'), '');
  assert.equal(await page.locator('#resultSegmentRows [data-segment-id]').count(), 0);
  assert.match(await page.textContent('#resultTransitions'), /select a match/i);
  assert.equal(await page.locator('#teamCorrectionLog').isHidden(), true);
  assert.equal(await page.textContent('#teamCorrectionHistory'), '');
  assert.equal(await page.locator('#scoreCorrectionDialog').isHidden(), true);
  assert.match(await page.textContent('#resultMessage'), /match.*(?:no longer available|removed|replaced)/i);
});
