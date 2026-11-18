import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/014_tobacco_road_event_label.sql', import.meta.url), 'utf8');

test('the 2027 itinerary displays Tobacco Road without the fun-round suffix', () => {
  assert.match(migration, /set title = 'Tobacco Road'/i);
  assert.match(migration, /title = 'Tobacco Road fun round'/i);
  assert.match(migration, /edition_year = 2027/i);
});
