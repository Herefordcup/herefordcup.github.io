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

for (const width of [320, 390, 1280]) {
  test(`only Scorecards opens by default at ${width}px`, async t => {
    const page = await visit(t, { width });
    await expect(page.locator('#adminContent')).toBeVisible();
    const current = await layout(page);
    assert.deepEqual(current.tools, ['scorecards']);
    assert.equal(current.grid, false, 'a hidden rules/commentary pair must not leave an empty grid');
    const chooser = page.getByRole('combobox', { name: 'Admin tool', exact: true });
    await expect(chooser).toHaveAttribute('id', 'adminTool');
    await expect(chooser).toHaveValue('scorecards');
    assert.equal(current.width, width, 'no horizontal page overflow');
    const { x, y, width: w, height } = await chooser.boundingBox();
    assert.ok(height >= 44 && w >= 44 && x >= 0 && x + w <= width, `chooser bounds: ${x}, ${w} × ${height}`);
    assert.ok(y < 250, 'the chooser is near the top, before the first workspace');
  });
}

for (const width of [390, 1280]) {
  test(`all workspaces and the full view remain reachable at ${width}px`, async t => {
    const page = await visit(t, { width });
    await expect(page.locator('#adminContent')).toBeVisible();
    const chooser = page.locator('#adminTool');
    const keys = Object.keys(anchors);
    const options = await chooser.locator('option').evaluateAll(options => options.map(option => option.value));
    assert.deepEqual(options, [...keys, 'all']);
    const compact = await layout(page);
    const overflowing = [];
    for (const key of options) {
      await chooser.selectOption(key);
      const current = await layout(page);
      assert.deepEqual(current.tools, key === 'all' ? keys : [key]);
      assert.equal(current.grid, ['rules', 'commentary', 'all'].includes(key));
      if (current.width > width) overflowing.push([key, current.width]);
    }
    const full = await layout(page);
    t.diagnostic(`Scorecards: ${compact.height}px; All tools: ${full.height}px`);
    assert.ok(compact.height < full.height / 2, 'the default no longer stacks the full page');
    assert.deepEqual(overflowing, [], 'no horizontal page overflow');
  });
}

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

test('unknown tool bookmarks fall back to Scorecards', async t => {
  const page = await visit(t, { query: '?tool=not-a-workspace' });
  await expect(page.locator('#adminContent')).toBeVisible();
  await expect(page.locator('#adminTool')).toHaveValue('scorecards');
  assert.deepEqual((await layout(page)).tools, ['scorecards']);
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
  const page = await visit(t, { width: 1280 });
  const chooser = page.locator('#adminTool');
  await expect(chooser).toBeVisible();
  await page.getByRole('link', { name: 'Player portal' }).focus();
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
      const page = await visit(t, { width, query: '?tool=all', api });
      await expect(page.locator('#adminStatus')).toContainText(status);
      await expect(page.locator('#adminContent')).toBeHidden();
      await expect(page.locator('#adminTool')).toBeHidden();
      const current = await layout(page);
      assert.deepEqual(current.tools, []);
      assert.equal(current.width, width);
      await expect(page.getByRole('combobox')).toHaveCount(0);
    }
  });
}

test('an authorized Admin retains the original full page if the chooser module is unavailable', async t => {
  const page = await visit(t, { skipChooser: true, query: '?tool=rules' });
  await expect(page.locator('#adminContent')).toBeVisible();
  await expect(page.locator('#adminTool')).toHaveCount(0);
  assert.deepEqual((await layout(page)).tools, Object.keys(anchors));
  await expect(page.locator('#ruleForm')).toBeVisible();
  await expect(page.locator('#commentarySettingsForm')).toBeVisible();
});
