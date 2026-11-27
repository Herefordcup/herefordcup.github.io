import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const text = path => readFile(new URL(path, root), 'utf8');

test('public entries and organizer scoring imports use the same release cache key', async () => {
  const key = 'compact-scorecard-1';
  for (const [page, entry] of [['index', 'app'], ['portal', 'portal'], ['admin', 'admin'], ['past-trips', 'past-trips']]) {
    const [html, js] = await Promise.all([text(`${page}.html`), text(`src/${entry}.js`)]);
    assert.ok(html.includes(`src="src/${entry}.js?v=${key}"`), `${page} loads this release's entrypoint`);
    assert.ok(js.includes(`from './supabase.js?v=${key}'`), `${entry} loads this release's data client`);
  }
  const admin = await text('src/admin.js');
  for (const name of ['admin-helpers', 'team-correction-editor', 'texas-scramble-planner', 'match-results']) {
    assert.ok(admin.includes(`from './${name}.js?v=${key}'`), `Admin loads this release's ${name}`);
  }
});
