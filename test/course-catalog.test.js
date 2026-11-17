import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase/migrations/004_course_catalog.sql', import.meta.url);

async function migration() {
  return readFile(migrationUrl, 'utf8');
}

function catalogs(sql) {
  return [...sql.matchAll(/\$catalog\$\s*([\s\S]*?)\s*\$catalog\$::jsonb/g)].map(match => JSON.parse(match[1]));
}

test('course catalog supports nine-hole courses, unrated tees, rating categories, and source provenance', async () => {
  const sql = await migration();
  assert.match(sql, /alter table public\.tees drop constraint if exists tees_slope_check/i);
  assert.match(sql, /alter table public\.tees alter column rating drop not null/i);
  assert.match(sql, /alter table public\.tees alter column slope drop not null/i);
  assert.match(sql, /add column if not exists rating_category text/i);
  assert.match(sql, /add column if not exists source_url text/i);
  assert.match(sql, /add column if not exists source_notes text/i);
  assert.match(sql, /alter table public\.holes alter column stroke_index drop not null/i);
  assert.match(sql, /where stroke_index is not null/i);
  assert.match(sql, /par between 27 and 90/i);
  assert.match(sql, /yardage between 500 and 9000/i);
});

test('course catalog seeds Tobacco Road and the complete current Pinehurst roster', async () => {
  const sql = await migration();
  for (const course of [
    'Tobacco Road Golf Club',
    'Pinehurst No. 1', 'Pinehurst No. 2', 'Pinehurst No. 3',
    'Pinehurst No. 4', 'Pinehurst No. 5', 'Pinehurst No. 6',
    'Pinehurst No. 7', 'Pinehurst No. 8', 'Pinehurst No. 9',
    'Pinehurst No. 10', 'Pinehurst No. 11', 'The Cradle',
  ]) {
    assert.match(sql, new RegExp(course.replaceAll('.', '\\.'), 'i'), `missing ${course}`);
  }
  assert.match(sql, /Pinehurst No\. 7[\s\S]*2027-07/i, 'No. 7 renovation availability is not preserved');
  assert.match(sql, /Pinehurst No\. 11[\s\S]*2027-03-29/i, 'No. 11 opening date is not preserved');
});

test('every seeded tee has coherent hole geometry and rating metadata', async () => {
  const seeded = catalogs(await migration());
  for (const course of seeded) {
    for (const tee of course.tees) {
      assert.ok([9, 18].includes(tee.yardages.length), `${course.name} ${tee.name} has invalid hole count`);
      assert.equal(tee.pars.length, tee.yardages.length, `${course.name} ${tee.name} par count mismatch`);
      assert.equal(tee.stroke_indexes.length, tee.yardages.length, `${course.name} ${tee.name} stroke-index count mismatch`);
      assert.ok(tee.yardages.every(value => Number.isInteger(value) && value >= 25), `${course.name} ${tee.name} has invalid yardage`);
      const indexes = tee.stroke_indexes.filter(value => value !== null);
      if (indexes.length) assert.equal(new Set(indexes).size, indexes.length, `${course.name} ${tee.name} repeats a stroke index`);
      for (const rating of tee.ratings) {
        assert.ok(['M', 'F', 'U'].includes(rating.category), `${course.name} ${tee.name} has invalid rating category`);
        assert.equal(rating.rating === null, rating.slope === null, `${course.name} ${tee.name} has a partial rating`);
      }
    }
  }
});

test('catalog migration links itinerary golf events to their verified course records', async () => {
  const sql = await migration();
  assert.match(sql, /update public\.tournament_events[\s\S]*set course_id = course\.id/i);
  for (const event of ['Tobacco Road fun round', 'Pinehurst No. 3', 'Pinehurst No. 4', 'Pinehurst No. 2', 'The Cradle', 'Pinehurst No. 10']) {
    assert.match(sql, new RegExp(`'${event.replaceAll('.', '\\.')}'`, 'i'), `missing itinerary link for ${event}`);
  }
});
test('seed preserves verified tee geometry without inventing conflicting ratings', async () => {
  const sql = await migration();
  const seeded = catalogs(sql);
  const byName = new Map(seeded.map(course => [course.name, course]));

  const cradle = byName.get('The Cradle').tees[0];
  assert.equal(cradle.yardages.reduce((sum, yards) => sum + yards, 0), 789);
  assert.equal(cradle.pars.reduce((sum, par) => sum + par, 0), 27);
  assert.equal(cradle.ratings[0].rating, null);

  assert.match(byName.get('Pinehurst No. 9').source_notes, /ratings unavailable for current post-renovation yardages/i);
  assert.match(byName.get('Pinehurst No. 2').source_notes, /incompatible USGA registered ratings are not attached/i);

  const ripper = byName.get('Tobacco Road Golf Club').tees.find(tee => tee.name === 'Ripper');
  assert.equal(ripper.yardages.reduce((sum, yards) => sum + yards, 0), 6557);
  assert.deepEqual(ripper.ratings[0], { category: 'M', rating: 72.5, slope: 145, rating_par: 71 });
  assert.doesNotMatch(sql, /Venmo|Alexander-Gilbert|235-8403|\$2,160|\$300/i);
});
