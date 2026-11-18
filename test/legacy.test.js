import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const indexHtml = await readFile(new URL('index.html', root), 'utf8');
const portalHtml = await readFile(new URL('portal.html', root), 'utf8');
const pastTripsHtml = await readFile(new URL('past-trips.html', root), 'utf8');
const pastTripsScript = await readFile(new URL('src/past-trips.js', root), 'utf8');
const legacyScript = await readFile(new URL('src/legacy.js', root), 'utf8');
const adminHtml = await readFile(new URL('admin.html', root), 'utf8');
const appScript = await readFile(new URL('src/app.js', root), 'utf8');
const adminScript = await readFile(new URL('src/admin.js', root), 'utf8');
const supabaseScript = await readFile(new URL('src/supabase.js', root), 'utf8');
const migrationUrl = new URL('supabase/migrations/009_legacy_archive.sql', root);
const hardeningMigrationUrl = new URL('supabase/migrations/012_commentary_and_legacy_hardening.sql', root);

test('public home shows a champions-only Legacy summary', () => {
  assert.doesNotMatch(indexHtml, /EST\. 2026/);
  assert.match(indexHtml, /EST\. 2023/);
  assert.match(indexHtml, /id="legacyWinners"/);
  assert.doesNotMatch(indexHtml, /id="legacyTimeline"|id="legacyDetails"|id="legacyGallery"/);
  assert.match(appScript, /renderLegacyWinners/);
  assert.doesNotMatch(appScript, /renderLegacyArchive/);
});

test('More links to a full Past Trips page with stories, results, and moments', () => {
  assert.match(portalHtml, /href="past-trips\.html"/);
  assert.match(portalHtml, />Past Trips</);
  for (const id of ['legacyTimeline', 'legacyDetails', 'legacyGallery']) {
    assert.match(pastTripsHtml, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(pastTripsHtml, /MOMENTS CAPTURED/i);
  assert.match(pastTripsScript, /loadLegacyArchive/);
  assert.match(pastTripsScript, /renderLegacyArchive/);
});

test('uploaded Past Trips photos open in an accessible full-view dialog', () => {
  for (const id of ['legacyPhotoDialog', 'legacyPhotoFull', 'legacyPhotoCaption', 'legacyPhotoClose']) {
    assert.match(pastTripsHtml, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(legacyScript, /legacy-photo-open/);
  assert.match(legacyScript, /View .* full size/);
  assert.match(pastTripsScript, /showModal\(\)/);
  assert.match(pastTripsScript, /legacyPhotoDialog\.close\(\)/);
  assert.match(pastTripsHtml, /href="past-trips\.css\?v=photo-lightbox-1"/);
  assert.match(pastTripsHtml, /src="src\/past-trips\.js\?v=photo-lightbox-1"/);
  assert.match(pastTripsScript, /from '\.\/legacy\.js\?v=photo-lightbox-1'/);
});

test('legacy schema is publicly readable, admin-write-only, and seeds the known trips without fabricated winners', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const table of ['legacy_editions', 'legacy_results', 'legacy_photos']) {
    assert.match(sql, new RegExp(`create table[^;]*public\\.${table}`, 'is'), `missing ${table}`);
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  }
  assert.match(sql, /grant select on public\.legacy_editions, public\.legacy_results, public\.legacy_photos to anon/i);
  assert.match(sql, /public\.is_admin\(\)/i);
  assert.match(sql, /legacy-photos/i);
  assert.match(sql, /auth\.uid\(\)/);
  assert.match(sql, /before insert or update on public\.legacy_editions/i);
  assert.match(sql, /file_size_limit[\s\S]{0,120}8388608/i);
  for (const trip of [
    ['2023', 'Barefoot', 'Myrtle Beach'],
    ['2024', 'Innisbrook', 'Tampa'],
    ['2025', 'PGA Frisco', 'Texas'],
    ['2026', 'Kiawah', 'South Carolina'],
    ['2027', 'Pinehurst', 'North Carolina'],
  ]) {
    for (const value of trip) assert.match(sql, new RegExp(value, 'i'));
  }
  assert.doesNotMatch(sql, /winner_name[^;]*values[^;]*['"][^'"]+['"]/is);
});

test('administrators can manage editions, result rows, and photo uploads', () => {
  for (const id of ['legacyEditionForm', 'legacyEditionSelect', 'legacyResultForm', 'legacyPhotoForm', 'legacyPhotoFile']) {
    assert.match(adminHtml, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  for (const fn of ['saveLegacyEdition', 'saveLegacyResult', 'uploadLegacyPhoto', 'deleteLegacyPhoto']) {
    assert.match(supabaseScript, new RegExp(`export async function ${fn}`), `missing ${fn}`);
    assert.match(adminScript, new RegExp(fn), `admin does not use ${fn}`);
  }
  assert.match(supabaseScript, /\.storage\.from\('legacy-photos'\)/);
  assert.match(supabaseScript, /image\/(jpeg|png|webp)/);
  assert.doesNotMatch(supabaseScript, /export async function (?:saveLegacyEdition|saveLegacyResult|uploadLegacyPhoto)\([^)]*userId/);
});

test('legacy rendering uses text nodes for administrator-authored content', async () => {
  const legacyScript = await readFile(new URL('src/legacy.js', root), 'utf8');
  assert.doesNotMatch(legacyScript, /innerHTML/);
  assert.match(legacyScript, /textContent/);
  assert.match(legacyScript, /replaceChildren/);
});

test('Legacy photos are private, publication-aware, and use signed URLs', async () => {
  const sql = await readFile(hardeningMigrationUrl, 'utf8');
  assert.match(sql, /update storage\.buckets[\s\S]*set public = false[\s\S]*legacy-photos/i);
  assert.match(sql, /published legacy photos are readable/i);
  assert.match(sql, /edition\.published/i);
  assert.match(supabaseScript, /createSignedUrl\(photo\.storage_path/);
  assert.doesNotMatch(supabaseScript, /object\/public\/legacy-photos/);
});

test('Legacy photo deletion removes metadata before attempting storage cleanup', async () => {
  const sql = await readFile(hardeningMigrationUrl, 'utf8');
  assert.match(sql, /function public\.delete_legacy_photo\(target_photo_id uuid\)/i);
  assert.match(sql, /if not public\.is_admin\(\)/i);
  assert.match(supabaseScript, /rpc\('delete_legacy_photo'/);
  const rpcPosition = supabaseScript.indexOf("rpc('delete_legacy_photo'");
  const removePosition = supabaseScript.indexOf("storage.from('legacy-photos').remove", rpcPosition);
  assert.ok(rpcPosition >= 0 && removePosition > rpcPosition);
});

test('Legacy publication state is authoritative and tab controls are keyboard accessible', async () => {
  const legacyScript = await readFile(new URL('src/legacy.js', root), 'utf8');
  const sql = await readFile(hardeningMigrationUrl, 'utf8');
  assert.match(sql, /alter column published set default false/i);
  assert.doesNotMatch(adminHtml, /name="published" type="checkbox" checked/);
  assert.doesNotMatch(appScript, /editions: knownLegacyTrips/);
  assert.doesNotMatch(legacyScript, /editions\?\.length \? editions : knownLegacyTrips/);
  assert.match(legacyScript, /aria-controls/);
  assert.match(legacyScript, /ArrowLeft|ArrowRight/);
  assert.match(legacyScript, /tabIndex/);
});

test('administrators can update and remove Legacy result rows', () => {
  for (const fn of ['saveLegacyResult', 'deleteLegacyResult']) {
    assert.match(supabaseScript, new RegExp(`export async function ${fn}`));
    assert.match(adminScript, new RegExp(fn));
  }
  assert.match(adminHtml, /id="legacyResultList"/);
  assert.match(adminScript, /renderLegacyResultList/);
});
