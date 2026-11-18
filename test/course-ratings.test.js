import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const catalogUrl = new URL('../supabase/migrations/004_course_catalog.sql', import.meta.url);
const ratingsUrl = new URL('../supabase/migrations/015_current_course_ratings.sql', import.meta.url);
const portalScriptUrl = new URL('../src/portal.js', import.meta.url);

function catalogs(sql) {
  return [...sql.matchAll(/\$catalog\$\s*([\s\S]*?)\s*\$catalog\$::jsonb/g)].map(match => JSON.parse(match[1]));
}

function ratingRows(sql) {
  const match = sql.match(/\$ratings\$\s*([\s\S]*?)\s*\$ratings\$::jsonb/);
  assert.ok(match, 'migration must expose its verified rows as a JSON payload');
  return JSON.parse(match[1]);
}

test('forward migration supplies complete ratings for every previously unrated active tee', async () => {
  const catalogSql = await readFile(catalogUrl, 'utf8');
  const ratingsSql = await readFile(ratingsUrl, 'utf8');
  const rows = ratingRows(ratingsSql);
  const covered = new Set(rows.map(row => `${row.course}|${row.tee}`));

  const unrated = catalogs(catalogSql)
    .filter(course => course.active)
    .flatMap(course => course.tees
      .filter(tee => !tee.ratings.some(rating => rating.rating !== null && rating.slope !== null))
      .map(tee => `${course.name}|${tee.name}`));

  assert.deepEqual([...covered].sort(), unrated.sort());
  assert.ok(rows.every(row => ['M', 'F'].includes(row.category)));
  assert.ok(rows.every(row => Number.isFinite(row.rating) && Number.isInteger(row.slope)));
  assert.ok(rows.every(row => row.source_url.startsWith('https://ncrdb.usga.org/courseTeeInfo')));
  assert.ok(rows.every(row => Number.isInteger(row.source_yardage) && row.source_yardage > 0));
});

test('current USGA rows include the requested ratings and slopes for key tee mappings', async () => {
  const rows = ratingRows(await readFile(ratingsUrl, 'utf8'));
  const lookup = new Map(rows.map(row => [`${row.course}|${row.tee}|${row.category}`, row]));

  assert.deepEqual(
    { rating: lookup.get('Pinehurst No. 2|Blue|M').rating, slope: lookup.get('Pinehurst No. 2|Blue|M').slope },
    { rating: 75.4, slope: 143 },
  );
  assert.deepEqual(
    { rating: lookup.get('Pinehurst No. 3|White|F').rating, slope: lookup.get('Pinehurst No. 3|White|F').slope },
    { rating: 71.2, slope: 125 },
  );
  assert.deepEqual(
    { rating: lookup.get('Pinehurst No. 9|National|M').rating, slope: lookup.get('Pinehurst No. 9|National|M').slope },
    { rating: 69.3, slope: 130 },
  );
  assert.deepEqual(
    { rating: lookup.get('The Cradle|Current course tee|F').rating, slope: lookup.get('The Cradle|Current course tee|F').slope },
    { rating: 26.3, slope: 75 },
  );
});

test('portal loads the corrected handicap calculation through a cache-busted dependency', async () => {
  const source = await readFile(portalScriptUrl, 'utf8');
  assert.match(source, /from '\.\/golf\.js\?v=course-ratings-1'/);
});

test('rating migration preserves existing unrated tee ids and clones holes only for extra categories', async () => {
  const sql = await readFile(ratingsUrl, 'utf8');
  assert.match(sql, /update public\.tees[\s\S]*rating_category = row_record ->> 'category'/i);
  assert.match(sql, /insert into public\.holes[\s\S]*select new_tee_id/i);
  assert.match(sql, /drop function public\.apply_current_course_ratings\(jsonb\)/i);
});
