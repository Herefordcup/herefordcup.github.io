import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';

const root = new URL('../', import.meta.url);
const origin = 'http://127.0.0.1';
const tournament = { id: 'trip', name: 'Hereford Cup', edition_year: 2027, status: 'open', starts_on: '2027-03-18', ends_on: '2027-03-21' };
const events = [
  { title: 'Airport shuttle pickup', starts_at: '2027-03-21T17:30:00Z', event_type: 'travel', time_precision: 'approximate' },
  { title: 'Dinner at The Deuce', starts_at: '2027-03-19T00:00:00Z', event_type: 'meal' },
  { title: 'Pinehurst No. 3', starts_at: '2027-03-19T12:00:00Z', ends_at: '2027-03-19T12:32:00Z', event_type: 'golf', is_competitive: true, public_details: 'Team competition begins.', notes: 'Team competition begins.' },
  { title: 'Tobacco Road', starts_at: '2027-03-18T17:00:00Z', event_type: 'golf', time_precision: 'tbd', courses: { name: 'Tobacco Road Golf Club' }, public_details: 'Optional, non-competition round.', notes: 'Meet the group at the clubhouse.' },
  { title: 'The Cradle', starts_at: '2027-03-20T21:20:00Z', event_type: 'golf' },
];

let browser;
before(async () => { browser = await chromium.launch({ channel: 'chrome' }); });
after(async () => { await browser?.close(); });

// Exercise the real portal HTML, scripts, CSS and membership gate. Only the
// transport is a fixture. No production session, data or external network.
async function openHome(t, { width = 390, rows = events, membership = 'active' } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 844 }, timezoneId: 'Asia/Tokyo', serviceWorkers: 'block' });
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const data = { tournament, memberships: [{ tournaments: tournament, status: membership, role: 'player', team: 'silver' }],
    profile: { id: 'player', role: 'player', display_name: 'Fixture Player' }, events: rows,
    assignments: [], matches: [], segments: [], rules: [], commentaries: [], statistics: [], courses: [], players: [], rounds: [], scrambleSquads: [], holeOutcomes: [] };
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || route.request().method() !== 'GET' || !/^\/(portal\.html|[\w-]+\.css|src\/[\w-]+\.js|assets\/icon\.svg)$/.test(url.pathname)) return route.abort();
    const js = body => route.fulfill({ contentType: 'text/javascript', body });
    if (url.pathname === '/src/config.js') return js("export const hasSupabaseConfig=()=>true, SUPABASE_URL=location.origin, SUPABASE_PUBLISHABLE_KEY='';");
    if (url.pathname === '/src/supabase.js' && url.search !== '?fixture-base') return js(`export * from './supabase.js?fixture-base';
      const data = ${JSON.stringify(data)};
      export const getCurrentSession = async () => ${membership === 'signed-out' ? 'null' : "({user:{id:'player'}})"}, requestTournamentMembership = async () => {},
        loadOwnTournamentMemberships = async () => data.memberships, loadPlayerData = async () => data;`);
    const contentType = { html: 'text/html', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml' }[url.pathname.split('.').at(-1)];
    return route.fulfill({ contentType, body: await readFile(new URL(url.pathname.slice(1), root)) });
  });
  await page.goto(`${origin}/portal.html`);
  if (membership === 'active') await expect(page.locator('#homeScheduleTitle')).toHaveText('March 18–21, 2027 itinerary');
  t.after(() => assert.deepEqual(errors, []));
  return page;
}

test('the player sees one tournament day at a time, with Eastern times and all member event details', async t => {
  const page = await openHome(t);
  const tabs = page.getByRole('tablist', { name: 'Itinerary days' }).getByRole('tab');
  await expect(tabs).toHaveCount(4, { timeout: 1500 });
  const active = page.getByRole('tabpanel');
  await expect(active).toHaveAccessibleName(/Day 1.*Thu, Mar 18/i);
  await expect(active.getByRole('article').locator('strong')).toHaveText(['Tobacco Road', 'Dinner at The Deuce']);
  for (const text of ['Time TBD', 'Golf · Tobacco Road Golf Club', 'Optional, non-competition round.', 'Meet the group at the clubhouse.', '8:00 PM']) await expect(active.getByText(text, { exact: true })).toBeVisible();
  await tabs.nth(1).click();
  await expect(active).toHaveAccessibleName(/Day 2.*Fri, Mar 19/i);
  await expect(active.getByRole('article')).toHaveCount(1);
  for (const text of ['Pinehurst No. 3', '8:00–8:32 AM', 'Cup event', 'Team competition begins.']) await expect(active.getByText(text, { exact: true })).toHaveCount(1);
  await tabs.nth(2).click();
  await expect(active.getByText('The Cradle', { exact: true })).toBeVisible();
  await tabs.nth(3).click();
  await expect(active.getByText('Around 1:30 PM', { exact: true })).toBeVisible();
  await expect(page.getByText('Dinner at The Deuce', { exact: true })).not.toBeVisible();
});

test('keyboard navigation selects and focuses days, and leaving Home keeps the chosen day', async t => {
  const page = await openHome(t, { width: 1280 });
  const tabs = page.getByRole('tablist', { name: 'Itinerary days' }).getByRole('tab');
  await tabs.first().focus();
  for (const [key, index] of [['ArrowRight', 1], ['End', 3], ['ArrowRight', 0], ['ArrowLeft', 3], ['Home', 0], ['ArrowRight', 1]]) {
    await page.keyboard.press(key);
    await expect(tabs.nth(index)).toBeFocused({ timeout: 1000 });
    await expect(tabs.nth(index)).toHaveAttribute('aria-selected', 'true');
    assert.deepEqual(await tabs.evaluateAll(nodes => nodes.map(n => n.tabIndex)), [0, 1, 2, 3].map(i => i === index ? 0 : -1));
    assert.equal(await tabs.nth(index).getAttribute('aria-controls'), await page.getByRole('tabpanel').getAttribute('id'));
  }
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tabpanel')).toBeFocused();
  await page.locator('#memberNav').getByRole('button', { name: 'Cup', exact: true }).click();
  await expect(page.getByRole('tablist', { name: 'Itinerary days' })).toBeHidden();
  await page.locator('#memberNav').getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName(/Fri, Mar 19/);
});

for (const width of [320, 390, 1280]) {
  test(`day controls and full member notes fit inside the itinerary at ${width}px`, async t => {
    const rows = events.map(row => row.title !== 'Tobacco Road' ? row : { ...row, notes: 'ClubhouseMeetingInstructions'.repeat(8) });
    const page = await openHome(t, { width, rows });
    const schedule = page.locator('#schedulePreview');
    const tabs = schedule.getByRole('tab');
    await expect(tabs).toHaveCount(4);
    for (const tab of await tabs.all()) {
      const box = await tab.boundingBox();
      assert.ok(box.height >= 44 && box.x >= 0 && box.x + box.width <= width + 1, 'day button fits and is tappable');
    }
    assert.ok(await schedule.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'itinerary must not scroll sideways');
    const notes = schedule.getByText('ClubhouseMeetingInstructions'.repeat(8), { exact: true });
    assert.ok(await notes.evaluate(el => el.scrollWidth <= el.clientWidth + 1), 'long member notes wrap, not clip or overflow');
  });
}

test('an unpublished itinerary keeps its empty message without empty day controls', async t => {
  const page = await openHome(t, { rows: [] });
  await expect(page.locator('#schedulePreview')).toHaveText('The itinerary has not been published yet.');
  await expect(page.getByRole('tablist', { name: 'Itinerary days' })).toHaveCount(0);
});

for (const membership of ['signed-out', 'pending']) {
  test(`${membership} visitors do not get itinerary markup or member notes`, async t => {
    const page = await openHome(t, { membership });
    await expect(page.locator(membership === 'pending' ? '#accessPendingView' : '#authView')).toBeVisible();
    await expect(page.locator('#dashboardView')).toBeHidden();
    await expect(page.locator('#schedulePreview')).toBeEmpty();
  });
}
