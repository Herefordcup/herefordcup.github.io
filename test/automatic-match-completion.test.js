import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const migration = await readFile(new URL('supabase/migrations/038_automatic_match_completion.sql', root), 'utf8').catch(() => '');
const portal = await readFile(new URL('src/portal.js', root), 'utf8');
const admin = await readFile(new URL('src/admin.js', root), 'utf8');
const supabase = await readFile(new URL('src/supabase.js', root), 'utf8');
const adminHtml = await readFile(new URL('admin.html', root), 'utf8');
const commentaryFunction = await readFile(new URL('supabase/functions/generate-match-commentary/index.ts', root), 'utf8');

test('assigned players automatically complete score-derived matches only when every score exists', () => {
  assert.ok(migration, 'forward migration 038 is required');
  assert.match(migration, /create or replace function public\.complete_match_if_ready\(target_match_id uuid\)/i);
  assert.match(migration, /match_segment_players[\s\S]*auth\.uid\(\)/i);
  assert.match(migration, /format not in \('singles', 'fourball'\)/i);
  assert.match(migration, /generate_series\(segment_record\.start_hole, segment_record\.end_hole\)/i);
  assert.match(migration, /public\.finalize_match_results\(target_match_id, automatic_results\)/i);
  assert.match(migration, /set_config\('app\.auto_finalize_match_id', target_match_id::text, true\)/i);
  assert.match(migration, /grant execute on function public\.complete_match_if_ready\(uuid\) to authenticated/i);
});

test('automatic completion is idempotent and preserves the explicit Foursomes fallback', () => {
  assert.match(migration, /match_record\.status = 'final'[\s\S]*already_final/i);
  assert.match(migration, /team_score_required/i);
  assert.match(migration, /current_setting\('app\.auto_finalize_match_id', true\)/i);
  assert.match(migration, /Administrator access required/i);
  assert.match(adminHtml, /Record Foursomes result/);
  assert.doesNotMatch(adminHtml, />Finalize match</);
  assert.match(admin, /requiresManualTeamResult/);
});

test('portal attempts completion and initial recap after an assigned score save', () => {
  assert.match(supabase, /export async function completeMatchIfReady/);
  assert.match(supabase, /rpc\('complete_match_if_ready'/);
  assert.match(portal, /await completeMatchIfReady\(matchSelect\.value\)/);
  assert.match(portal, /generateMatchCommentary\(matchSelect\.value\)/);
  assert.match(portal, /Match complete\./);
});

test('assigned players may request only the first recap while regeneration remains administrator-only', () => {
  assert.match(commentaryFunction, /const regenerate = body\.regenerate === true/);
  assert.match(commentaryFunction, /match_segment_players/);
  assert.match(commentaryFunction, /regenerate[\s\S]*Administrator access required/);
  assert.match(migration, /target_regenerate[\s\S]*assigned/i);
  assert.match(migration, /target_regenerate[\s\S]*Administrator access required/i);
});

test('audited administrators can replace a finalized score and atomically recalculate the result', () => {
  assert.match(migration, /Finalized scores can be corrected but not deleted/i);
  assert.match(migration, /set_config\('app\.correcting_final_match_id', target_match_id::text, true\)/i);
  assert.match(migration, /public\.finalize_match_results\(target_match_id, recompute_results\)/i);
  assert.match(migration, /score_correction_audit/i);
  assert.match(admin, /generateMatchCommentary\(matchId, \{ regenerate: true \}\)/);
  assert.match(admin, /Score corrected, result recalculated, and commentary regenerated\./);
});
