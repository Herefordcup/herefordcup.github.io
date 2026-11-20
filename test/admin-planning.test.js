import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMutationGate, easternDateTimeToIso, optionalNumber, segmentPlayerFromMembership, segmentPlayerOptions, tournamentTeamLabel } from '../src/admin-helpers.js';

const html = await readFile(new URL('../admin.html', import.meta.url), 'utf8');
const adminScript = await readFile(new URL('../src/admin.js', import.meta.url), 'utf8');
const supabaseScript = await readFile(new URL('../src/supabase.js', import.meta.url), 'utf8');
const gitignore = await readFile(new URL('../.gitignore', import.meta.url), 'utf8');
const orderedRulesMigrationUrl = new URL('../supabase/migrations/021_ordered_rule_editor.sql', import.meta.url);
const automaticFinalizationMigrationUrl = new URL('../supabase/migrations/022_atomic_automatic_match_finalization.sql', import.meta.url);
const adminHandicapMigrationUrl = new URL('../supabase/migrations/023_admin_member_handicap.sql', import.meta.url);

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
  for (const format of ['singles', 'fourball', 'foursomes']) {
    assert.match(html, new RegExp(`value=["']${format}["']`), `missing ${format}`);
  }
  for (const unsupported of ['scramble', 'shamble', 'chapman']) {
    assert.doesNotMatch(html, new RegExp(`value=["']${unsupported}["']`), `unexpected ${unsupported}`);
  }
});

test('membership mutation gate keeps the roster inert until every overlapping save settles', () => {
  const roster = { inert: false };
  const gate = createMutationGate(roster);

  gate.begin();
  gate.begin();
  assert.equal(gate.active, true);
  assert.equal(roster.inert, true);

  gate.end();
  assert.equal(gate.active, true);
  assert.equal(roster.inert, true);

  gate.end();
  assert.equal(gate.active, false);
  assert.equal(roster.inert, false);
});

test('only supported active matches can enter the finalization workflow', async () => {
  assert.match(adminScript, /\['scheduled', 'live'\]\.includes\(match\.status\)/);
  const sql = await readFile(automaticFinalizationMigrationUrl, 'utf8');
  assert.match(sql, /match_record\.status not in \('scheduled', 'live'\)/i);
  assert.match(sql, /Only scheduled or live matches can be finalized/i);
});

test('admin planner validates and saves independent segment lineups', () => {
  assert.match(adminScript, /validateSegments/);
  assert.match(adminScript, /saveMatchPlan/);
  assert.match(adminScript, /match_segment_players/);
});

test('segment player selection shows tournament teams and derives the scoring side automatically', () => {
  const blue = { user_id: 'blue-player', team: 'cardinal', status: 'active' };
  const white = { user_id: 'white-player', team: 'silver', status: 'active' };
  const unassigned = { user_id: 'waiting-player', team: null, status: 'active' };
  const inactive = { user_id: 'inactive-player', team: 'cardinal', status: 'pending' };

  assert.equal(tournamentTeamLabel(blue.team), 'Blue');
  assert.equal(tournamentTeamLabel(white.team), 'White');
  assert.equal(tournamentTeamLabel(unassigned.team), 'No team');
  assert.deepEqual(segmentPlayerFromMembership(blue, 1), {
    userId: 'blue-player', team: 'cardinal', side: 'cardinal', playingOrder: 1,
  });
  assert.deepEqual(segmentPlayerFromMembership(white, 2), {
    userId: 'white-player', team: 'silver', side: 'silver', playingOrder: 2,
  });
  assert.equal(segmentPlayerFromMembership(unassigned, 3), null);
  assert.equal(segmentPlayerFromMembership(inactive, 4), null);
  assert.doesNotMatch(adminScript, /Match side|data-side-select|Blue side|White side/);
  assert.match(adminScript, /option\.disabled = disabled/);
  assert.match(html, /src="src\/admin\.js\?v=savage-commentary-1"/);
  assert.match(adminScript, /from '\.\/admin-helpers\.js\?v=member-role-1'/);
});

test('planner options refresh team labels and preserve only valid selections after roster changes', () => {
  const refreshed = segmentPlayerOptions([
    { user_id: 'selected-player', team: 'silver', status: 'active', profiles: { display_name: 'Selected Player' } },
    { user_id: 'waiting-player', team: null, status: 'active', profiles: { display_name: 'Waiting Player' } },
  ], 'selected-player');
  assert.equal(refreshed.selectedUserId, 'selected-player');
  assert.deepEqual(refreshed.options, [
    { value: '', label: 'Unassigned', disabled: false },
    { value: 'selected-player', label: 'Selected Player · White', disabled: false },
    { value: 'waiting-player', label: 'Waiting Player · No team', disabled: true },
  ]);

  const unassignedSelection = segmentPlayerOptions([
    { user_id: 'selected-player', team: null, status: 'active', profiles: { display_name: 'Selected Player' } },
  ], 'selected-player');
  assert.equal(unassignedSelection.selectedUserId, '');
  assert.match(adminScript, /function refreshSegmentPlayerOptions/);
  assert.match(adminScript, /membership\.team = saved\.team;[\s\S]*refreshSegmentPlayerOptions\(\)/);
  assert.match(adminScript, /adminData\.memberships = freshData\.memberships;[\s\S]*refreshSegmentPlayerOptions\(\)/);
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

test('tournament administrators can edit an active member handicap through a scoped RPC', async () => {
  assert.match(adminScript, /membership\.profiles\?\.handicap_index/);
  assert.match(adminScript, /Save handicap/);
  assert.match(adminScript, /await setTournamentMemberHandicap\(/);
  assert.match(supabaseScript, /export async function setTournamentMemberHandicap/);
  assert.match(supabaseScript, /rpc\('set_tournament_member_handicap'/);

  const sql = await readFile(adminHandicapMigrationUrl, 'utf8');
  assert.match(sql, /create or replace function public\.set_tournament_member_handicap/i);
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*target_tournament_id/i);
  assert.match(sql, /from public\.tournaments[\s\S]*for update[\s\S]*status not in \('live', 'open', 'setup'\)/i);
  assert.match(sql, /from public\.tournament_memberships[\s\S]*status = 'active'[\s\S]*for update/i);
  assert.match(sql, /public\.is_admin\(\) or public\.is_tournament_admin\(target_tournament_id\)/i);
  assert.match(sql, /target_handicap_index not between -10 and 54/i);
  assert.match(sql, /target_handicap_index <> round\(target_handicap_index, 1\)/i);
  assert.match(sql, /update public\.profiles[\s\S]*handicap_index = target_handicap_index/i);
  assert.match(sql, /grant execute on function public\.set_tournament_member_handicap\(uuid, uuid, numeric\) to authenticated/i);
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

test('rules editor shows published rules and saves an explicit display position atomically', async () => {
  for (const id of ['ruleExisting', 'ruleSortOrder', 'rulePublishedList']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(adminScript, /function renderRuleEditor/);
  assert.match(adminScript, /Add a new rule/);
  assert.match(adminScript, /adminData\.rules/);
  assert.match(supabaseScript, /supabase\.from\('tournament_rules'\)\.select\('\*'\)\.eq\('active', true\)\.order\('sort_order'/);
  assert.match(supabaseScript, /rpc\('save_tournament_rule_ordered'/);

  const sql = await readFile(orderedRulesMigrationUrl, 'utf8');
  assert.match(sql, /create or replace function public\.save_tournament_rule_ordered/i);
  assert.match(sql, /returns setof public\.tournament_rules/i);
  assert.match(sql, /pg_advisory_xact_lock/i);
  assert.match(sql, /row_number\(\) over \(order by sort_order, created_at, id\)/i);
  assert.match(sql, /return query[\s\S]*order by rule\.sort_order, rule\.created_at, rule\.id/i);
  assert.match(adminScript, /adminData\.rules = \[[\s\S]*filter\(rule => rule\.tournament_id !== tournamentId\)[\s\S]*\.\.\.savedRules/);
  assert.match(adminScript, /Number\(a\.sort_order\) - Number\(b\.sort_order\)[\s\S]*a\.created_at\.localeCompare\(b\.created_at\)[\s\S]*a\.id\.localeCompare\(b\.id\)/);
  assert.match(supabaseScript, /\.order\('sort_order'\)\.order\('created_at'\)\.order\('id'\)/);
  assert.match(sql, /public\.is_admin\(\)/i);
  assert.match(sql, /revoke all on function public\.save_tournament_rule_ordered/i);
  assert.match(sql, /grant execute on function public\.save_tournament_rule_ordered/i);
});

test('ordered rules accept only global or target-tournament administrators', async () => {
  const sql = await readFile(orderedRulesMigrationUrl, 'utf8');
  assert.match(
    sql,
    /if not \(public\.is_admin\(\) or public\.is_tournament_admin\(target_tournament_id\)\) then/i,
  );
});

test('admin result workflow automatically derives compatible match-play results before finalization', () => {
  for (const id of ['resultFinalizationForm', 'resultMatch', 'resultSegmentRows']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(supabaseScript, /export async function finalizeMatchResults/);
  assert.match(supabaseScript, /rpc\('finalize_match_results'/);
  assert.match(adminScript, /deriveSegmentResult/);
  assert.match(supabaseScript, /tees\(name, holes\(hole_number, stroke_index\)\)/);
  assert.match(adminScript, /Calculated automatically from submitted hole-by-hole scores/);
  assert.match(adminScript, /All assigned players must submit every score/);
  assert.doesNotMatch(adminScript, /Official differential/);
  assert.match(adminScript, /differential/);
  assert.match(adminScript, /holes_played/);
  assert.match(adminScript, /status: 'final'/);
});

test('forward migration derives automatic results under locks and keeps only the Foursomes fallback client-authored', async () => {
  let sql;
  try {
    sql = await readFile(automaticFinalizationMigrationUrl, 'utf8');
  } catch {
    assert.fail('forward automatic-finalization migration is required');
  }
  assert.match(sql, /create or replace function public\.finalize_match_results/i);
  assert.match(sql, /from public\.matches[\s\S]*for update[\s\S]*from public\.match_segments[\s\S]*for update[\s\S]*from public\.rounds[\s\S]*for update[\s\S]*from public\.scores[\s\S]*for update/i);
  assert.match(sql, /segment_record\.format in \('singles', 'fourball'\)/i);
  assert.match(sql, /public\.match_segment_players/i);
  assert.match(sql, /public\.holes/i);
  assert.match(sql, /round_record\.course_handicap/i);
  assert.match(sql, /segment_record\.handicap_allowance/i);
  assert.match(sql, /Client automatic result does not match persisted scores/i);
  assert.match(sql, /segment_record\.format = 'foursomes'[\s\S]*result_record ->> 'differential'/i);
  assert.match(sql, /update public\.matches[\s\S]*set status = 'final'/i);
  assert.match(sql, /create or replace function public\.correct_hole_score[\s\S]*from public\.matches[\s\S]*for update[\s\S]*from public\.rounds[\s\S]*for update/i);
  assert.match(sql, /Finalized matches cannot be corrected/i);
});

test('match finalization locks its target before authorizing that exact tournament administrator', async () => {
  const sql = await readFile(automaticFinalizationMigrationUrl, 'utf8');
  const body = sql.match(/create or replace function public\.finalize_match_results[\s\S]*?\$\$;/i)?.[0] ?? '';
  const lockPosition = body.search(/select source_match\.\* into match_record[\s\S]*?for update/i);
  const authorizationPosition = body.search(/public\.is_admin\(\) or public\.is_tournament_admin\(match_record\.tournament_id\)/i);
  assert.ok(lockPosition >= 0, 'target match must be resolved and locked');
  assert.ok(authorizationPosition > lockPosition, 'authorization must follow the target match lock');
});

test('score correction authorizes the locked match tournament and keeps standalone rounds global-admin-only', async () => {
  const sql = await readFile(automaticFinalizationMigrationUrl, 'utf8');
  const body = sql.match(/create or replace function public\.correct_hole_score[\s\S]*?\$\$;/i)?.[0] ?? '';
  const lockPosition = body.search(/select source_match\.\* into target_match[\s\S]*?for update/i);
  const scopedAuthorizationPosition = body.search(/public\.is_admin\(\) or public\.is_tournament_admin\(target_match\.tournament_id\)/i);
  assert.ok(lockPosition >= 0, 'target match must be resolved and locked');
  assert.ok(scopedAuthorizationPosition > lockPosition, 'match-scoped authorization must follow the lock');
  assert.match(body, /if target_match_id is null[\s\S]*?if not public\.is_admin\(\)/i);
});

test('automatic finalization uses an unambiguous qualified hole loop variable', async () => {
  const sql = await readFile(automaticFinalizationMigrationUrl, 'utf8');
  const body = sql.match(/create or replace function public\.finalize_match_results[\s\S]*?\$\$;/i)?.[0] ?? '';
  assert.match(body, /current_hole_number integer/i);
  assert.match(body, /for current_hole_number in segment_record\.start_hole\.\.segment_record\.end_hole loop/i);
  assert.match(body, /score_record\.hole_number = current_hole_number/i);
  assert.match(body, /hole_record\.hole_number = current_hole_number/i);
  assert.doesNotMatch(body, /\bhole_number integer|= hole_number\b/i);
});

test('server automatic results validate and score match sides independently of tournament teams', async () => {
  const sql = await readFile(automaticFinalizationMigrationUrl, 'utf8');
  const body = sql.match(/create or replace function public\.finalize_match_results[\s\S]*?\$\$;/i)?.[0] ?? '';
  assert.match(body, /count\(\*\) filter \(where assignment\.side = 'cardinal'\)/i);
  assert.match(body, /count\(\*\) filter \(where assignment\.side = 'silver'\)/i);
  assert.match(body, /case when assignment\.side = 'cardinal'/i);
  assert.match(body, /case when assignment\.side = 'silver'/i);
  assert.doesNotMatch(body, /assignment\.team/i);
});

test('server net finalization rejects missing and out-of-range stroke indexes for every assigned round', async () => {
  const sql = await readFile(automaticFinalizationMigrationUrl, 'utf8');
  const body = sql.match(/create or replace function public\.finalize_match_results[\s\S]*?\$\$;/i)?.[0] ?? '';
  assert.match(
    body,
    /segment_record\.scoring_mode = 'net'[\s\S]*?hole_record\.stroke_index is null[\s\S]*?hole_record\.stroke_index not between 1 and 18/i,
  );
});

test('server automatic handicap allowance rounding matches JavaScript for plus handicaps', async () => {
  const sql = await readFile(automaticFinalizationMigrationUrl, 'utf8');
  assert.match(sql, /floor\(round_record\.course_handicap \* segment_record\.handicap_allowance \/ 100\.0 \+ 0\.5\)::integer/i);
  assert.doesNotMatch(sql, /round\(round_record\.course_handicap \* segment_record\.handicap_allowance/i);
});

test('server finalization rejects a missing client final-status marker', async () => {
  const sql = await readFile(automaticFinalizationMigrationUrl, 'utf8');
  assert.match(sql, /result_record ->> 'status' is distinct from 'final'/i);
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
