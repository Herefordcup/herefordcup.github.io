import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

const root = new URL('../', import.meta.url);
const origin = 'http://127.0.0.1';
const anchors = {
  members: '#membershipManagement', matches: '#matchPlanForm', scramble: '#texasScrambleForm',
  scorecards: '#resultFinalizationForm, #resultMatch', completion: '#tournamentCompletionForm',
  rules: '#ruleForm', commentary: '#commentarySettingsForm', legacy: '.legacy-workspace', courses: '#courseForm',
};
const apiSource = await readFile(new URL('src/supabase.js', root), 'utf8');
const apiStub = [...apiSource.matchAll(/^export (?:async )?function (\w+)\(/gm)]
  .map(([, name]) => `export const ${name} = (...args) => window.testApi('${name}', ...args);`).join('\n');

let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome' }); });
after(async () => { await browser?.close(); });

// Use the real page, styles, Admin access gate and form handlers. All data is local and disposable.
async function visit(t, { width = 390, query = '', api = {}, skipChooser = false } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width < 600, serviceWorkers: 'block' });
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const data = { tournaments: [{ id: 'cup', name: 'Cup', edition_year: 2027, status: 'open' }],
    memberships: [], matches: [], courses: [], scrambleSessions: [], settings: [], commentaries: [],
    rounds: [], resultAudits: [], legacyEditions: [], rules: [] };
  const boundary = {
    getCurrentSession: () => ({ user: { id: 'organizer' } }),
    loadPlayerData: () => ({ profile: { role: 'admin' }, memberships: [] }),
    loadAdminData: () => data,
    loadMembershipRosterData: () => ({ tournaments: data.tournaments, memberships: [] }),
    ...api,
  };
  await page.exposeFunction('testApi', (name, ...args) => boundary[name](...args));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/src/supabase.js') return route.fulfill({ contentType: 'text/javascript', body: apiStub });
    if (skipChooser && url.pathname === '/src/admin-workspaces.js') return route.abort();
    if (!/^\/(admin\.html|[\w-]+\.css|src\/[\w-]+\.js|assets\/icon\.svg)$/.test(url.pathname)) return route.abort();
    return route.fulfill({ path: fileURLToPath(new URL(`.${url.pathname}`, root)) });
  });
  await page.goto(`${origin}/admin.html${query}`);
  return page;
}

const layout = page => page.evaluate(anchors => {
  const root = document.querySelector('#adminContent');
  const panels = Object.entries(anchors).filter(([, selector]) => root.querySelector(selector).closest('.admin-panel').checkVisibility());
  return { tools: panels.map(([key]) => key), grid: root.querySelector('#ruleForm').closest('.admin-grid').checkVisibility(),
    width: Math.max(document.body.scrollWidth, document.documentElement.scrollWidth), height: document.documentElement.scrollHeight };
}, anchors);

const homeTitles = ['Scorecards', 'Players & teams', 'Rounds & pairings', 'Tournament tools'];

for (const width of [320, 390, 1280]) {
  test(`the four-section Admin home opens without any forms at ${width}px`, async t => {
    const page = await visit(t, { width });
    await expect(page.locator('#adminContent')).toBeVisible();
    if (width === 320) await page.setViewportSize({ width, height: 568 });
    const home = page.getByRole('navigation', { name: 'Admin sections' });
    assert.deepEqual(await home.locator('a strong').allTextContents(), homeTitles);
    await expect(page.getByRole('heading', { name: 'Tournament Admin', exact: true })).toBeVisible();
    const current = await layout(page);
    assert.deepEqual(current.tools, [], 'do not open results, editors or another workspace on landing');
    assert.equal(current.grid, false, 'hidden tools leave no empty wrapper');
    await expect(page.locator('#adminTool')).toBeHidden();
    assert.equal(current.width, width);
    for (const title of homeTitles) {
      const link = home.getByRole('link', { name: title, exact: true });
      await expect(link).toBeInViewport({ ratio: 1 });
      assert.ok((await link.boundingBox()).height >= 44, 'each section is a touch target');
    }
  });
}

for (const width of [390, 1280]) {
  test(`all workspaces and the full view remain reachable at ${width}px`, async t => {
    const page = await visit(t, { width, query: '?tool=scorecards' });
    await expect(page.locator('#adminContent')).toBeVisible();
    const chooser = page.locator('#adminTool');
    const keys = Object.keys(anchors);
    const options = await chooser.locator('option').evaluateAll(options => options.map(option => option.value));
    assert.deepEqual(options, [...keys, 'requests', 'roster', 'all']);
    const compact = await layout(page);
    const overflowing = [];
    for (const key of options) {
      await chooser.selectOption(key);
      const current = await layout(page);
      assert.deepEqual(current.tools, key === 'all' ? keys : [['requests', 'roster'].includes(key) ? 'members' : key]);
      if (['requests', 'roster', 'members', 'all'].includes(key)) {
        assert.equal(await page.locator('#pendingMembers').isVisible(), key !== 'roster');
        assert.equal(await page.locator('#activeMemberSearch').isVisible(), key !== 'requests');
      }
      assert.equal(current.grid, ['rules', 'commentary', 'all'].includes(key));
      if (current.width > width) overflowing.push([key, current.width]);
    }
    const full = await layout(page);
    t.diagnostic(`Scorecards: ${compact.height}px; All tools: ${full.height}px`);
    assert.ok(compact.height < full.height / 2, 'the default no longer stacks the full page');
    assert.deepEqual(overflowing, [], 'no horizontal page overflow');
  });
}

test('each section points to its published tools and the Back link returns to the right section', async t => {
  const page = await visit(t);
  const nav = page.locator('#adminSectionLinks');
  const groups = {
    'Players & teams': [['Membership requests', '#pendingMembers'], ['Team roster', '#activeMemberSearch']],
    'Rounds & pairings': [['Match plans & pairings', '#matchPlanForm'], ['Texas Scramble lineups', '#texasScrambleForm'], ['Courses & tees', '#courseForm']],
    'Tournament tools': [['Playing rules', '#ruleForm'], ['Match commentary', '#commentarySettingsForm'], ['Past Trips', '#legacyEditionPanel'], ['Finish tournament', '#tournamentCompletionForm']],
  };
  for (const [section, items] of Object.entries(groups)) {
    await nav.getByRole('link', { name: section, exact: true }).click();
    await expect(nav.locator('a strong')).toHaveText(items.map(([label]) => label));
    for (const [label, panel] of items) {
      const link = nav.getByRole('link', { name: label, exact: true });
      await link.click();
      await expect(page.locator(panel)).toBeVisible();
      await page.locator('#adminBack').click();
      await expect(link).toBeFocused();
    }
    await page.locator('#adminBack').click();
    await expect(nav.getByRole('link', { name: section, exact: true })).toBeFocused();
  }
});

test('a bookmarked tool opens after authorization, and switching preserves other URL state', async t => {
  const gate = Promise.withResolvers();
  const page = await visit(t, { query: '?ref=portal&tool=commentary#adminContent', api: { loadPlayerData: () => gate.promise } });
  await expect(page.locator('#adminContent')).toBeHidden();
  await expect(page.locator('#adminTool')).toBeHidden();
  gate.resolve({ profile: { role: 'player' }, memberships: [{ status: 'active', role: 'admin', tournament_id: 'cup' }] });
  const chooser = page.locator('#adminTool');
  await expect(chooser).toBeVisible();
  await expect(chooser).toHaveValue('commentary');
  assert.deepEqual((await layout(page)).tools, ['commentary']);
  await chooser.selectOption('all');
  const bookmark = new URL(page.url());
  assert.equal(bookmark.searchParams.get('tool'), 'all');
  assert.equal(bookmark.searchParams.get('ref'), 'portal');
  assert.equal(bookmark.hash, '#adminContent');
  await page.reload();
  await expect(chooser).toHaveValue('all');
  await expect(page.locator('#adminContent')).toBeVisible();
  assert.deepEqual((await layout(page)).tools, Object.keys(anchors));
});

test('unknown tool bookmarks fall back to the four-section home', async t => {
  const page = await visit(t, { query: '?tool=not-a-workspace' });
  await expect(page.locator('#adminContent')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Admin sections' })).toBeVisible();
  assert.deepEqual((await layout(page)).tools, []);
});

test('section links, Back and Forward keep the actual form and the unsaved draft', async t => {
  const page = await visit(t, { query: '?ref=portal#adminContent' });
  const nav = page.locator('#adminSectionLinks');
  await nav.getByRole('link', { name: 'Tournament tools', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tournament tools', exact: true })).toBeFocused();
  await nav.getByRole('link', { name: 'Playing rules', exact: true }).click();
  const title = page.locator('#ruleForm [name=title]');
  await title.fill('Draft survives navigation');
  const original = await title.elementHandle();
  const back = page.locator('#adminBack');
  await back.click();
  await expect(nav.getByRole('link', { name: 'Playing rules', exact: true })).toBeFocused();
  await nav.getByRole('link', { name: 'Match commentary', exact: true }).click();
  await expect(page.locator('#commentarySettingsForm')).toBeVisible();
  await page.goBack();
  await expect(nav.getByRole('link', { name: 'Match commentary', exact: true })).toBeFocused();
  await nav.getByRole('link', { name: 'Playing rules', exact: true }).click();
  await expect(title).toHaveValue('Draft survives navigation');
  assert.ok(await original.evaluate(node => node === document.querySelector('#ruleForm [name=title]')));
  await page.goBack();
  await expect(nav).toBeVisible();
  await page.goForward();
  await expect(title).toBeVisible();
  await expect(title).toHaveValue('Draft survives navigation');
  const url = new URL(page.url());
  assert.deepEqual([url.searchParams.get('tool'), url.searchParams.get('ref'), url.hash], ['rules', 'portal', '#adminContent']);
  await back.click();
  await back.click();
  await expect(nav.getByRole('link', { name: 'Tournament tools', exact: true })).toBeFocused();
  await nav.getByRole('link', { name: 'Scorecards', exact: true }).click();
  await expect(page.locator('#resultMatch')).toBeFocused();
  await expect(page.locator('#resultMatch')).toHaveValue('');
});

test('Players & teams shows a count only for real pending requests, without displaying names on home', async t => {
  const tournament = { id: 'cup', name: 'Cup', edition_year: 2027, status: 'open' };
  const data = { tournaments: [tournament], memberships: [{ user_id: 'pending1', tournament_id: 'cup',
    status: 'pending', role: 'player', profiles: { display_name: 'Test Applicant' } }], matches: [], courses: [],
    scrambleSessions: [], settings: [], commentaries: [], rounds: [], resultAudits: [], legacyEditions: [], rules: [] };
  const page = await visit(t, { api: { loadAdminData: () => data } });
  const list = page.locator('#adminSectionLinks');
  const players = list.getByRole('link', { name: 'Players & teams', exact: true });
  await expect(players).toHaveAccessibleDescription(/1 pending request\b/, { timeout: 1000 });
  await expect(list).not.toContainText('Test Applicant');
  await players.click();
  await list.getByRole('link', { name: 'Membership requests', exact: true }).click();
  await expect(page.locator('#pendingMembers')).toContainText('Test Applicant');
  await expect(page.locator('#activeMembers')).toBeHidden();
  await page.locator('#refreshMemberships').click();
  await expect(page.locator('#pendingMembers .membership-card')).toHaveCount(0);
  await page.locator('#adminBack').click();
  await list.getByRole('link', { name: 'Team roster', exact: true }).click();
  await expect(page.locator('#activeMemberSearch')).toBeVisible();
  await expect(page.locator('#pendingMembers')).toBeHidden();
  await page.locator('#adminBack').click();
  await page.locator('#adminBack').click();
  await expect(players).not.toHaveAccessibleDescription(/\d+ pending/);
});

test('switching keeps the original draft field and the selected Legacy tab mounted', async t => {
  const page = await visit(t, { query: '?tool=rules' });
  const chooser = page.locator('#adminTool');
  const title = page.locator('#ruleForm [name=title]');
  await title.fill('Unpublished local rule draft');
  const originalField = await title.elementHandle();

  await chooser.selectOption('legacy');
  const tabs = page.getByRole('tab');
  await expect(tabs).toHaveCount(3);
  for (const name of ['Edition details', 'Scores & results', 'Photos']) {
    await page.getByRole('tab', { name, exact: true }).click();
    await expect(page.getByRole('tabpanel', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('tabpanel')).toHaveCount(1);
  }
  await chooser.selectOption('rules');
  await expect(title).toHaveValue('Unpublished local rule draft');
  assert.ok(await originalField.evaluate(input => input === document.querySelector('#ruleForm [name=title]')));
  await chooser.selectOption('legacy');
  await expect(page.getByRole('tab', { name: 'Photos' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Photos' })).toBeVisible();
  assert.equal(new URL(page.url()).search, '?tool=legacy');
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
});

test('keyboard selection keeps focus on the chooser; the next Tab enters only the chosen workspace', async t => {
  const page = await visit(t, { width: 1280, query: '?tool=scorecards' });
  const chooser = page.locator('#adminTool');
  await expect(chooser).toBeVisible();
  await page.locator('#adminBack').focus();
  await page.keyboard.press('Tab');
  await expect(chooser).toBeFocused();
  await chooser.press('ArrowDown');
  await chooser.press('ArrowDown');
  await expect(chooser).toHaveValue('rules');
  await expect(chooser).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#ruleTournament')).toBeFocused();
});

for (const [name, api, status] of [
  ['signed-out visitor', { getCurrentSession: () => null }, /Sign in through the player portal/],
  ['ordinary member', { loadPlayerData: () => ({ profile: { role: 'player' }, memberships: [{ role: 'player', status: 'active' }] }) }, /limited to the tournament administrator/],
  ['pending administrator', { loadPlayerData: () => ({ profile: { role: 'player' }, memberships: [{ role: 'admin', status: 'pending' }] }) }, /limited to the tournament administrator/],
  ['failed Admin load', { loadAdminData: () => { throw new Error('Test data unavailable'); } }, /Test data unavailable/],
]) {
  test(`the ${name} cannot expose tools through a bookmark`, async t => {
    for (const width of [390, 1280]) {
      const page = await visit(t, { width, query: width === 390 ? '' : '?tool=all', api });
      await expect(page.locator('#adminStatus')).toContainText(status);
      await expect(page.locator('#adminContent')).toBeHidden();
      await expect(page.locator('#adminTool')).toBeHidden();
      await expect(page.locator('#adminSectionLinks')).toBeHidden();
      const current = await layout(page);
      assert.deepEqual(current.tools, []);
      assert.equal(current.width, width);
      await expect(page.getByRole('combobox')).toHaveCount(0);
    }
  });
}

test('the empty access status is already in the accessibility tree before a sign-in message arrives', async t => {
  const session = Promise.withResolvers();
  const page = await visit(t, { api: { getCurrentSession: () => session.promise } });
  const status = page.locator('#adminStatus');
  await expect(status).toHaveText('');
  const cdp = await page.context().newCDPSession(page);
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#adminStatus' });
  const axStatus = async () => (await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false })).nodes[0];
  const before = await axStatus();
  assert.ok(!before.ignored && before.role?.value === 'status', 'keep the empty live region present for the first asynchronous message');
  assert.ok(await status.evaluate(el => el.getBoundingClientRect().height <= 1), 'the empty status should not reserve visible space');
  session.resolve(null);
  await expect(status).toBeVisible();
  await expect(status).toContainText('Sign in through the player portal first.');
  assert.ok(await status.evaluate(el => el.getBoundingClientRect().height > 1), 'show the message at its natural height');
  assert.equal((await axStatus()).role?.value, 'status');
  await expect(page.locator('#adminContent')).toBeHidden();
  await cdp.detach();
});

test('an authorized Admin retains the original full page if the chooser module is unavailable', async t => {
  const page = await visit(t, { skipChooser: true, query: '?tool=rules' });
  await expect(page.locator('#adminContent')).toBeVisible();
  await expect(page.locator('#adminTool')).toHaveCount(0);
  assert.deepEqual((await layout(page)).tools, Object.keys(anchors));
  await expect(page.locator('#ruleForm')).toBeVisible();
  await expect(page.locator('#commentarySettingsForm')).toBeVisible();
});
