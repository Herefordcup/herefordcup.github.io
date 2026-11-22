import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const migration = await readFile(new URL('supabase/migrations/039_match_result_audit.sql', root), 'utf8').catch(() => '');
const adminHtml = await readFile(new URL('admin.html', root), 'utf8');
const adminScript = await readFile(new URL('src/admin.js', root), 'utf8');
const supabaseScript = await readFile(new URL('src/supabase.js', root), 'utf8');
const adminCss = await readFile(new URL('admin.css', root), 'utf8');
const browserMatrix = await readFile(new URL('e2e/four-admin-scenarios.spec.mjs', root), 'utf8');
const matrixVerifier = await readFile(new URL('scripts/e2e/verify-scenario-matrix.mjs', root), 'utf8');


test('authoritative result changes append immutable match-scoped audit entries', () => {
  assert.ok(migration, 'forward migration 039 is required');
  assert.match(migration, /create table if not exists public\.match_result_audit/i);
  assert.match(migration, /action text not null check \(action in \('baseline', 'finalized', 'recalculated'\)\)/i);
  assert.match(migration, /old_differential[\s\S]*new_differential[\s\S]*change_reason[\s\S]*changed_by[\s\S]*changed_at/i);
  assert.match(migration, /foreign key \(segment_id, match_id\) references public\.match_segments\(id, match_id\) on delete cascade/i);
  assert.match(migration, /create or replace function public\.audit_authoritative_result_change\(\)/i);
  assert.match(migration, /after update on public\.match_segments/i);
  assert.match(migration, /current_setting\('app\.correcting_final_match_id', true\)/i);
  assert.match(migration, /current_setting\('app\.auto_finalize_match_id', true\)/i);
  assert.match(migration, /insert into public\.match_result_audit/i);
  assert.match(migration, /revoke insert, update, delete on public\.match_result_audit from authenticated/i);
});


test('score-correction reasons flow into result recalculation history', () => {
  assert.match(migration, /create or replace function public\.set_result_change_reason_from_score_audit\(\)/i);
  assert.match(migration, /set_config\('app\.result_change_reason', new\.correction_reason, true\)/i);
  assert.match(migration, /after insert on public\.score_correction_audit/i);
  assert.match(migration, /coalesce\([\s\S]*current_setting\('app\.result_change_reason', true\)/i);
});


test('result history is readable only by global or exact-tournament administrators', () => {
  assert.match(migration, /alter table public\.match_result_audit enable row level security/i);
  assert.match(migration, /public\.is_admin\(\)[\s\S]*public\.is_tournament_admin\(audit_match\.tournament_id\)/i);
  assert.match(migration, /grant select on public\.match_result_audit to authenticated/i);
  assert.match(migration, /create unique index[\s\S]*where action = 'baseline'/i);
  assert.match(migration, /Existing final result when audit logging was enabled/i);
});


test('administrator data and selected-match UI expose safe result history', () => {
  assert.match(supabaseScript, /from\('match_result_audit'\)/);
  assert.match(supabaseScript, /profiles!match_result_audit_changed_by_fkey\(display_name\)/);
  assert.match(adminHtml, /id="resultAuditHistory"/);
  assert.match(adminScript, /function renderResultAuditHistory/);
  assert.match(adminScript, /resultAuditHistory\.replaceChildren/);
  assert.match(adminScript, /textContent/);
  assert.match(adminScript, /adminData\.resultAudits/);
  assert.doesNotMatch(adminScript, /resultAuditHistory\.innerHTML/);
});


test('disposable browser and database matrices prove the visible result log and Legacy tabs', () => {
  assert.match(browserMatrix, /#legacyResultsTab/);
  assert.match(browserMatrix, /#legacyPhotosTab/);
  assert.match(browserMatrix, /#resultAuditHistory/);
  assert.match(browserMatrix, /Result recalculated/);
  assert.match(matrixVerifier, /\/rest\/v1\/match_result_audit\?/);
  assert.match(matrixVerifier, /\[C1\] deterministic QA correction/);
  assert.match(matrixVerifier, /Completed automatically from verified scorecards/);
});


test('Legacy management uses horizontal accessible tabs and bounded record lists', () => {
  assert.match(adminHtml, /class="legacy-tabs" role="tablist"/);
  assert.equal((adminHtml.match(/data-legacy-tab=/g) || []).length, 3);
  assert.equal((adminHtml.match(/data-legacy-panel=/g) || []).length, 3);
  assert.match(adminHtml, /aria-controls="legacyEditionPanel"/);
  assert.match(adminHtml, /aria-controls="legacyResultsPanel"/);
  assert.match(adminHtml, /aria-controls="legacyPhotosPanel"/);
  assert.match(adminScript, /function activateLegacyTab/);
  assert.match(adminScript, /aria-selected/);
  assert.match(adminScript, /panel\.hidden/);
  assert.match(adminCss, /\.legacy-tabs\{[^}]*display:grid[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/i);
  assert.match(adminCss, /\.legacy-record-list\{[^}]*max-height:[^;}]+[^}]*overflow-y:auto/i);
  assert.match(adminCss, /\.admin-main,#adminContent,\.admin-grid\{[^}]*min-width:0/i);
  assert.match(adminCss, /\.admin-panel\{[^}]*min-width:0/i);
  assert.match(adminCss, /\.legacy-workspace\{[^}]*min-width:0/i);
  assert.match(adminCss, /@media\(max-width:520px\)\{\.legacy-tabs\{display:grid;max-width:100%;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/i);
  assert.match(adminCss, /@media\(max-width:520px\)[\s\S]*\.legacy-tabs\{[^}]*max-width:100%/i);
  assert.match(adminCss, /@media\(max-width:520px\)[\s\S]*\.legacy-tabs/i);
});
