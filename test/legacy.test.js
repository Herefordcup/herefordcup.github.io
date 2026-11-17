import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const indexHtml = await readFile(new URL('index.html', root), 'utf8');
const adminHtml = await readFile(new URL('admin.html', root), 'utf8');
const appScript = await readFile(new URL('src/app.js', root), 'utf8');
const adminScript = await readFile(new URL('src/admin.js', root), 'utf8');
const supabaseScript = await readFile(new URL('src/supabase.js', root), 'utf8');
const migrationUrl = new URL('supabase/migrations/009_legacy_archive.sql', root);

test('public site establishes the Cup in 2023 and exposes a data-backed Legacy archive', () => {
  assert.doesNotMatch(indexHtml, /EST\. 2026/);
  assert.match(indexHtml, /EST\. 2023/);
  for (const id of ['legacyTimeline', 'legacyDetails', 'legacyGallery']) {
    assert.match(indexHtml, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(appScript, /loadLegacyArchive/);
  assert.match(appScript, /renderLegacyArchive/);
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
