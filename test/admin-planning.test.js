import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { easternDateTimeToIso, optionalNumber } from '../src/admin-helpers.js';

const html = await readFile(new URL('../admin.html', import.meta.url), 'utf8');
const adminScript = await readFile(new URL('../src/admin.js', import.meta.url), 'utf8');
const supabaseScript = await readFile(new URL('../src/supabase.js', import.meta.url), 'utf8');
const gitignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');

test('admin portal exposes planning, rules, and commentary controls', () => {
  for (const id of [
    'matchPlanForm',
    'segmentRows',
    'addSegment',
    'ruleForm',
    'commentarySettingsForm',
    'commentaryMatch',
    'generateCommentary',
    'commentaryApprovalList',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  for (const format of ['singles', 'fourball', 'foursomes', 'scramble', 'shamble', 'chapman']) {
    assert.match(html, new RegExp(`value=["']${format}["']`), `missing ${format}`);
  }
});

test('admin planner validates and saves independent segment lineups', () => {
  assert.match(adminScript, /validateSegments/);
  assert.match(adminScript, /saveMatchPlan/);
  assert.match(adminScript, /match_segment_players/);
});

test('course form supports unrated tees and match times are interpreted in Eastern time', () => {
  assert.doesNotMatch(html, /name="rating" required/);
  assert.doesNotMatch(html, /name="slope" required/);
  assert.equal(optionalNumber(''), null);
  assert.equal(optionalNumber('72.5'), 72.5);
  assert.equal(easternDateTimeToIso('2027-03-19T08:00'), '2027-03-19T12:00:00.000Z');
  assert.equal(easternDateTimeToIso('2027-01-19T08:00'), '2027-01-19T13:00:00.000Z');
  assert.match(adminScript, /easternDateTimeToIso/);
  assert.match(adminScript, /optionalNumber/);
  assert.match(supabaseScript, /rating: tee\.rating === null \? null : Number\(tee\.rating\)/);
  assert.match(supabaseScript, /slope: tee\.slope === null \? null : Number\(tee\.slope\)/);
});

test('admin membership roster names the member profile relationship', () => {
  assert.match(
    supabaseScript,
    /profiles!tournament_memberships_user_id_fkey\(id, display_name, handicap_index, role\)/,
  );
  assert.doesNotMatch(
    supabaseScript,
    /tournament_memberships'\)\.select\('\*, profiles\(id, display_name, handicap_index\)'/,
  );
});

test('Supabase layer saves match plans atomically through a database RPC', () => {
  assert.match(supabaseScript, /export async function saveMatchPlan/);
  assert.match(supabaseScript, /rpc\('save_match_plan'/);
  assert.match(supabaseScript, /export async function saveTournamentRule/);
  assert.match(supabaseScript, /export async function saveCommentarySettings/);
  assert.match(supabaseScript, /export async function generateMatchCommentary/);
  assert.match(supabaseScript, /functions\.invoke\('generate-match-commentary'/);
  assert.match(supabaseScript, /export async function updateCommentaryText/);
  assert.match(adminScript, /Save edit/);
  assert.match(supabaseScript, /export async function updateCommentaryStatus/);
  assert.match(supabaseScript, /rpc\('edit_commentary_draft'/);
  assert.match(supabaseScript, /rpc\('set_commentary_status'/);
});

test('admin result workflow finalizes authoritative segment results through RPC', () => {
  for (const id of ['resultFinalizationForm', 'resultMatch', 'resultSegmentRows']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(supabaseScript, /export async function finalizeMatchResults/);
  assert.match(supabaseScript, /rpc\('finalize_match_results'/);
  assert.match(adminScript, /differential/);
  assert.match(adminScript, /holes_played/);
  assert.match(adminScript, /status: 'final'/);
});

test('finalizing a match automatically generates commentary and reports retryable failures', () => {
  assert.match(adminScript, /await finalizeMatchResults\([\s\S]*await generateMatchCommentary\(/);
  assert.match(adminScript, /Match finalized, but automatic commentary failed/);
  assert.match(adminScript, /commentary\.status === 'approved'/);
  assert.match(supabaseScript, /require_approval: false/);
  assert.doesNotMatch(html, /Administrator approval is mandatory/);
});

test('admin controls fail closed and commentary auto-publication is explicit', () => {
  assert.match(html, /id="adminContent" hidden/);
  assert.doesNotMatch(html, /name="requireApproval"/);
  assert.match(adminScript, /adminContent\.hidden = false/);
  assert.match(supabaseScript, /require_approval: false/);
});

test('administrator score correction is contextual instead of a standalone page section', () => {
  assert.doesNotMatch(html, /<h1>Correct a submitted hole<\/h1>/);
  for (const id of ['openScoreCorrection', 'scoreCorrectionDialog', 'closeScoreCorrection', 'scoreCorrectionForm', 'correctionRound', 'correctionHole', 'correctionScore', 'correctionDelete', 'correctionReason', 'correctionMessage']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(adminScript, /scoreCorrectionDialog\.showModal\(\)/);
  assert.match(adminScript, /scoreCorrectionDialog\.close\(\)/);
  assert.match(html, /id="scoreCorrectionDialog"[^>]*aria-labelledby="scoreCorrectionTitle"/);
  assert.match(html, /id="scoreCorrectionTitle"/);
  assert.match(html, /id="resultMessage" role="status"/);
  assert.match(adminScript, /round\.match_id === matchId/);
  assert.match(adminScript, /Select a match before editing a submitted score/);
  assert.match(adminScript, /handleCorrectionDialogKeydown/);
  assert.match(adminScript, /submitButton\.disabled = true/);
  assert.match(supabaseScript, /export async function correctHoleScore/);
  assert.match(supabaseScript, /target_reason:/);
  assert.match(supabaseScript, /from\('score_correction_audit'\)/);
  assert.match(adminScript, /await correctHoleScore/);
  assert.match(adminScript, /Correction saved and audited/);
});

test('generated Supabase CLI state stays out of commits', () => {
  assert.match(gitignore, /^supabase\/\.temp\/$/m);
});

test('commentary settings hydrate on tournament change and approved copy stays manageable', () => {
  assert.match(adminScript, /function hydrateCommentarySettings/);
  assert.match(adminScript, /commentaryTournament.*addEventListener\('change', hydrateCommentarySettings\)/s);
  assert.match(adminScript, /\['draft', 'approved'\]\.includes\(commentary\.status\)/);
  assert.match(adminScript, /commentary\.status === 'draft'.*Approve/s);
  assert.match(adminScript, /copy\.readOnly = true/);
  assert.match(adminScript, /edit\.textContent = 'Edit'/);
  assert.match(adminScript, /Hide/);
});
