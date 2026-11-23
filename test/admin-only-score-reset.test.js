import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const publicHtmlUrl = new URL('../index.html', import.meta.url);
const publicScriptUrl = new URL('../src/app.js', import.meta.url);
const adminHtmlUrl = new URL('../admin.html', import.meta.url);
const integrityMigrationUrl = new URL('../supabase/migrations/005_integrity_hardening.sql', import.meta.url);

test('public visitors cannot reset scores', async () => {
  const [html, script] = await Promise.all([
    readFile(publicHtmlUrl, 'utf8'),
    readFile(publicScriptUrl, 'utf8'),
  ]);

  assert.doesNotMatch(html, /id=["']resetScores["']/i);
  assert.doesNotMatch(html, /Scores saved on this device/i);
  assert.doesNotMatch(script, /resetScores|Reset every Hereford Cup match score/i);
  assert.match(html, /src\/app\.js\?v=itinerary-1/i);
});

test('score deletion remains an audited administrator-only operation', async () => {
  const [adminHtml, sql] = await Promise.all([
    readFile(adminHtmlUrl, 'utf8'),
    readFile(integrityMigrationUrl, 'utf8'),
  ]);

  assert.match(adminHtml, /id=["']correctionDelete["']/i);
  assert.match(sql, /create or replace function public\.correct_hole_score/i);
  assert.match(sql, /if not public\.is_admin\(\)/i);
  assert.match(sql, /correction_reason text not null/i);
});
