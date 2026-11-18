import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateProfilePhoto } from '../src/profile.js';

const root = new URL('../', import.meta.url);
const html = await readFile(new URL('portal.html', root), 'utf8');
const portalScript = await readFile(new URL('src/portal.js', root), 'utf8');
const supabaseScript = await readFile(new URL('src/supabase.js', root), 'utf8');
const homeCss = await readFile(new URL('home.css', root), 'utf8');
const migration = await readFile(new URL('supabase/migrations/013_private_profile_photos.sql', root), 'utf8');

test('profile photo validation accepts supported images within five megabytes', () => {
  assert.deepEqual(validateProfilePhoto({ type: 'image/jpeg', size: 1_500_000 }), { type: 'image/jpeg', extension: 'jpg' });
  assert.deepEqual(validateProfilePhoto({ type: 'image/png', size: 5 * 1024 * 1024 }), { type: 'image/png', extension: 'png' });
  assert.deepEqual(validateProfilePhoto({ type: 'image/webp', size: 400_000 }), { type: 'image/webp', extension: 'webp' });
});

test('profile photo validation rejects unsupported or oversized files', () => {
  assert.throws(() => validateProfilePhoto({ type: 'image/gif', size: 10 }), /JPG, PNG, or WebP/);
  assert.throws(() => validateProfilePhoto({ type: 'image/png', size: 5 * 1024 * 1024 + 1 }), /5 MB or smaller/);
});

test('profile dialog offers upload, replacement, and removal controls', () => {
  assert.match(html, /id="profilePhotoInput"[^>]*accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(html, /id="profilePhotoRemove"/);
  assert.match(portalScript, /uploadProfilePhoto/);
  assert.match(portalScript, /removeProfilePhoto/);
  assert.match(portalScript, /validateProfilePhoto/);
});

test('profile dialog remains scrollable when picture controls exceed the viewport', () => {
  assert.match(homeCss, /\.profile-dialog\{[^}]*overflow-y:auto/);
});

test('profile photos use a private bucket and owner-scoped writes', () => {
  assert.match(migration, /insert into storage\.buckets[\s\S]*'profile-photos'[\s\S]*false/i);
  assert.match(migration, /file_size_limit[\s\S]*5242880/i);
  assert.match(migration, /allowed_mime_types[\s\S]*image\/jpeg[\s\S]*image\/png[\s\S]*image\/webp/i);
  assert.match(migration, /\(storage\.foldername\(name\)\)\[1\][\s\S]*auth\.uid\(\)::text/i);
  assert.match(migration, /shared active tournament members view profile photos/i);
  assert.match(migration, /profile_photo_path[\s\S]*id::text \|\| '\/%'/i);
});

test('profile photo client stores only a private path and creates signed URLs', () => {
  assert.match(supabaseScript, /export async function uploadProfilePhoto\(file\)/);
  assert.match(supabaseScript, /storage\.from\('profile-photos'\)\.upload/);
  assert.match(supabaseScript, /profile_photo_path/);
  assert.match(supabaseScript, /createSignedUrls/);
  assert.match(supabaseScript, /export async function removeProfilePhoto\(\)/);
  assert.doesNotMatch(supabaseScript, /getPublicUrl\([^)]*profile-photos/);
});
