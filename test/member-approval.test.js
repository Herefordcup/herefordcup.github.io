import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const migrationUrl = new URL('supabase/migrations/018_membership_approval.sql', root);
const deletionMigrationUrl = new URL('supabase/migrations/019_delete_membership_reenroll.sql', root);
const denialMigrationUrl = new URL('supabase/migrations/020_deny_pending_membership.sql', root);
const reRequestCleanupMigrationUrl = new URL('supabase/migrations/030_membership_rerequest_cleanup.sql', root);
const targetedReRequestMigrationUrl = new URL('supabase/migrations/033_targeted_membership_rerequest.sql', root);
const memberTeamMigrationUrl = new URL('supabase/migrations/034_tournament_member_team_assignment.sql', root);
const memberRoleMigrationUrl = new URL('supabase/migrations/035_tournament_member_role_assignment.sql', root);
const adminHtml = await readFile(new URL('admin.html', root), 'utf8');
const adminCss = await readFile(new URL('admin.css', root), 'utf8');
const adminScript = await readFile(new URL('src/admin.js', root), 'utf8');
const portalHtml = await readFile(new URL('portal.html', root), 'utf8');
const portalScript = await readFile(new URL('src/portal.js', root), 'utf8');
const supabaseScript = await readFile(new URL('src/supabase.js', root), 'utf8');

test('new player accounts require administrator approval without demoting existing members', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /create or replace function public\.enroll_profile_in_all_tournaments/i);
  assert.match(sql, /case when profile\.role = 'admin' then 'active' else 'pending' end/i);
  assert.match(sql, /case when profile\.role = 'admin' then now\(\) else null end/i);
  assert.doesNotMatch(sql, /update public\.tournament_memberships[\s\S]{0,200}set[\s\S]{0,200}status = 'pending'/i,
    'the forward migration must not demote existing active members');
  assert.match(sql, /on conflict \(tournament_id, user_id\) do nothing/i,
    'removed memberships must not be silently reactivated');
});

test('membership approval and removal use one audited administrator-only RPC', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /create table public\.membership_status_audit/i);
  assert.match(sql, /create or replace function public\.set_tournament_membership_status/i);
  assert.match(sql, /auth\.uid\(\)/i);
  assert.match(sql, /membership\.role = 'admin'/i);
  assert.match(sql, /membership\.status = 'active'/i);
  assert.match(sql, /target_status not in \('active', 'removed'\)/i);
  assert.match(sql, /cannot remove your own administrator membership/i);
  assert.match(sql, /cannot remove the last active tournament administrator/i);
  assert.match(sql, /insert into public\.membership_status_audit/i);
  assert.match(sql, /revoke insert, update, delete on public\.tournament_memberships from authenticated/i);
  assert.match(sql, /grant execute on function public\.set_tournament_membership_status\(uuid, uuid, text, text\) to authenticated/i);
});

test('pending signup emails ask every active tournament admin to review the member', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /create or replace function public\.enqueue_new_member_notification/i);
  assert.match(sql, /if new\.status <> 'pending' then/i);
  assert.match(sql, /Member approval requested/i);
  assert.match(sql, /Open the administrator portal to approve or remove this request/i);
  assert.match(sql, /member-approval:%s:%s/i);
});

test('administrator portal exposes pending, active, and permanent membership deletion controls', () => {
  for (const id of ['pendingMembers', 'activeMembers', 'activeMemberCount', 'activeMemberSearch', 'activeMemberTeamFilter', 'activeMemberRoleFilter', 'activeMemberFilterEmpty', 'membershipMessage']) {
    assert.match(adminHtml, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.doesNotMatch(adminHtml, /id=["']membershipTournament["']/);
  assert.match(adminScript, /function membershipTournamentId\(/);
  assert.match(adminScript, /for \(const status of \['live', 'open', 'setup'\]\)/);
  assert.doesNotMatch(adminScript, /adminData\.tournaments\[0\]/);
  assert.doesNotMatch(adminHtml, /id=["']removedMembers["']/);
  assert.doesNotMatch(adminHtml, />\s*Removed\s*</);
  assert.match(adminScript, /function renderMemberships\(/);
  assert.match(adminScript, /Approve/);
  assert.match(adminScript, /Deny/);
  assert.match(adminScript, /Deny this membership request/);
  assert.match(adminScript, /Denied by administrator/);
  assert.match(adminScript, /await denyTournamentMembership\(/);
  assert.match(adminScript, /Delete/);
  assert.doesNotMatch(adminScript, /Restore/);
  assert.match(adminScript, /await setTournamentMembershipStatus\(/);
  assert.match(adminScript, /await deleteTournamentMembership\(/);
  assert.match(adminScript, /membership\.profiles\?\.role === 'admin'/);
  assert.match(adminScript, /membership\.status === 'active'/);
  assert.match(supabaseScript, /profiles!tournament_memberships_user_id_fkey\(id, display_name, handicap_index, role\)/);
  assert.match(adminHtml, /id="pendingMembers"[\s\S]*id="activeMemberSearch"[\s\S]*id="activeMembers"/);
  assert.match(adminScript, /filterActiveMemberships\(/);
  assert.match(adminScript, /function applyActiveMemberFilters\(\)[\s\S]*applyMemberCardVisibility\([^;]+visibleIds\)/);
  assert.match(adminScript, /membership\.team = saved\.team[\s\S]*applyActiveMemberFilters\(\)[\s\S]*membershipMutationGate\.whenIdle\(\(\) => moveFocusFromFilteredCard\(card, activeMemberSearch\)\)[\s\S]*membershipMutationGate\.end\(\)/);
  assert.match(adminScript, /activeMemberSearch\.addEventListener\('input', applyActiveMemberFilters\)/);
  assert.match(adminScript, /activeMemberTeamFilter\.addEventListener\('change', applyActiveMemberFilters\)/);
  assert.match(adminScript, /activeMemberRoleFilter\.addEventListener\('change', applyActiveMemberFilters\)/);
  assert.doesNotMatch(adminScript, /activeMember(?:Search|TeamFilter|RoleFilter)\.addEventListener\([^\n]*renderMemberships/);
  assert.match(adminCss, /\.active-member-list\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)[^}]*max-height:[^;}]+[^}]*overflow-y:auto/i);
  assert.match(adminCss, /@media\(max-width:900px\)[\s\S]*\.active-member-list\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/i);
  assert.match(adminCss, /@media\(max-width:520px\)[\s\S]*\.active-member-list\{grid-template-columns:1fr\}/i);
  assert.match(adminCss, /\.membership-card \.button\{[^}]*min-height:44px/);
  assert.match(adminHtml, /admin\.css\?v=member-roster-grid-1/);
  assert.match(adminHtml, /admin\.js\?v=production-readiness-1/);
  assert.match(adminScript, /supabase\.js\?v=member-role-1/);
  assert.match(adminScript, /match-results\.js\?v=automatic-results-2/);
  assert.match(portalHtml, /portal\.js\?v=member-role-1/);
  assert.match(portalScript, /supabase\.js\?v=member-role-1/);
  assert.match(portalScript, /member\.js\?v=member-role-1/);
  assert.match(supabaseScript, /export async function setTournamentMembershipStatus/);
  assert.match(supabaseScript, /rpc\('set_tournament_membership_status'/);
  assert.match(supabaseScript, /export async function deleteTournamentMembership/);
  assert.match(supabaseScript, /rpc\('delete_tournament_membership'/);
  assert.doesNotMatch(supabaseScript, /tournament_memberships'\)\.select\([^\n]+\)\.eq\('status', 'active'\)/);
});

test('denial is a pending-only server-side operation that cannot delete a concurrently approved member', async () => {
  const sql = await readFile(denialMigrationUrl, 'utf8');

  assert.match(sql, /create or replace function public\.deny_tournament_membership/i);
  assert.match(sql, /for update/i);
  assert.match(sql, /current_membership\.status <> 'pending'/i);
  assert.match(sql, /Membership request is no longer pending/i);
  assert.match(sql, /delete from public\.tournament_memberships/i);
  assert.match(sql, /grant execute on function public\.deny_tournament_membership\(uuid, uuid, text\) to authenticated/i);
  assert.match(supabaseScript, /export async function denyTournamentMembership/);
  assert.match(supabaseScript, /rpc\('deny_tournament_membership'/);
});

test('deleting a tournament member removes only the membership and permits a fresh pending request', async () => {
  const sql = await readFile(deletionMigrationUrl, 'utf8');

  assert.match(sql, /delete from public\.tournament_memberships[\s\S]*where status = 'removed'/i,
    'legacy removed rows should not remain visible after the migration');
  assert.match(sql, /create or replace function public\.delete_tournament_membership/i);
  assert.match(sql, /delete from public\.tournament_memberships/i);
  assert.match(sql, /target_status <> 'active'/i,
    'the old status RPC must no longer create removed membership records');
  assert.match(sql, /pg_advisory_xact_lock[\s\S]*target_tournament_id/i,
    'membership deletion must serialize per tournament before authorization and counting');
  assert.match(sql, /cannot delete a global administrator tournament membership/i,
    'global administrators must not be deletable into a pending state they can bypass');
  assert.match(sql, /cannot delete your own administrator membership/i);
  assert.match(sql, /cannot delete the last active tournament administrator/i);
  assert.match(sql, /create or replace function public\.request_tournament_membership/i);
  assert.match(sql, /auth\.uid\(\)/i);
  assert.match(sql, /insert into public\.tournament_memberships/i);
  assert.match(sql, /'pending'/i);
  assert.match(sql, /on conflict \(tournament_id, user_id\) do nothing/i);
  assert.match(sql, /grant execute on function public\.delete_tournament_membership\(uuid, uuid, text\) to authenticated/i);
  assert.match(sql, /grant execute on function public\.request_tournament_membership\(\) to authenticated/i);
});

test('deleting or denying membership purges stale request data so a future request needs approval and notifies again', async () => {
  const sql = await readFile(reRequestCleanupMigrationUrl, 'utf8').catch(() => '');

  assert.match(sql, /create or replace function public\.delete_tournament_membership/i);
  assert.match(sql, /create or replace function public\.deny_tournament_membership/i);
  assert.match(sql, /current_membership\.status <> 'active'[\s\S]*Membership is not active/i,
    'general deletion must reject pending requests so it cannot bypass denial race protection');
  assert.match(sql, /delete from public\.tournament_memberships membership[\s\S]*membership\.status = 'active'/i,
    'the final membership delete must remain conditional on active status');
  assert.match(sql, /delete from public\.notification_jobs[\s\S]*notification_type = 'new_member'[\s\S]*source_type = 'membership'/i);
  assert.doesNotMatch(sql, /delete from public\.notification_preferences/i,
    'notification preferences are not membership-request history and must be preserved');
  assert.match(sql, /delete from public\.membership_status_audit/i);
  assert.match(sql, /delete from public\.tournament_memberships/i);
  assert.match(sql, /delete from public\.notification_jobs orphaned_job[\s\S]*not exists[\s\S]*public\.tournament_memberships/i,
    'already-orphaned approval jobs must be removed during the forward migration');
  assert.match(sql, /membership\.status = 'pending'[\s\S]*perform public\.enqueue_notification_job/i,
    'a currently suppressed pending re-request must receive a fresh approval job');
  assert.doesNotMatch(sql, /delete from (?:auth\.users|public\.profiles)/i,
    'login identities and profiles must remain so the person can request access again');
});

test('returning members and administrators refresh access without reopening stale tabs', () => {
  assert.match(supabaseScript, /export async function loadOwnTournamentMemberships/);
  assert.match(supabaseScript, /if \(!tournament\)[\s\S]*memberships,[\s\S]*tournament: null/,
    'pending membership state must remain available to the lifecycle monitor');
  assert.match(portalScript, /async function refreshMembershipAccess/);
  assert.match(portalScript, /await loadOwnTournamentMemberships\(session\.user\.id\)/);
  assert.match(portalScript, /transition === 'request'[\s\S]*await requestTournamentMembership\(\)/);
  assert.doesNotMatch(portalScript, /setInterval[\s\S]*requestTournamentMembership\(\)/,
    'the monitor must not recreate a request after an administrator denial');
  assert.match(portalScript, /window\.addEventListener\('focus',[\s\S]*refreshMembershipAccess/);
  assert.match(portalScript, /visibilitychange[\s\S]*refreshMembershipAccess/);
  assert.match(portalScript, /setInterval\(refreshMembershipAccessFromLifecycle, 30000\)/);
  assert.match(adminHtml, /id="refreshMemberships"[^>]*>Refresh requests</i);
  assert.match(adminScript, /async function refreshMembershipRoster/);
  assert.match(supabaseScript, /export async function loadMembershipRosterData/);
  assert.match(adminScript, /freshData = await loadMembershipRosterData\(\)[\s\S]*adminData\.memberships = freshData\.memberships[\s\S]*renderMemberships\(\)/);
  assert.match(adminScript, /membershipMutationGate\.active/);
  assert.doesNotMatch(adminScript, /button:disabled:not\(#refreshMemberships\)/);
  assert.match(adminScript, /membershipManagement\.inert = true[\s\S]*membershipManagement\.inert = false/);
  assert.match(adminScript, /document\.activeElement\?\.closest\('#membershipManagement'\)[\s\S]*refreshMembershipRoster/);
});

test('stale active deletion re-requests the exact displayed tournament', async () => {
  const sql = await readFile(targetedReRequestMigrationUrl, 'utf8').catch(() => '');
  assert.match(sql, /create or replace function public\.request_tournament_membership\(target_tournament_id uuid\)/i);
  assert.match(sql, /tournament\.id = target_tournament_id[\s\S]*tournament\.status in \('setup', 'open', 'live'\)/i);
  assert.match(sql, /on conflict \(tournament_id, user_id\) do nothing/i);
  assert.match(sql, /grant execute on function public\.request_tournament_membership\(uuid\) to authenticated/i);
  assert.match(supabaseScript, /requestTournamentMembership\(targetTournamentId = null\)[\s\S]*target_tournament_id: targetTournamentId/);
  assert.match(portalScript, /selectActiveTournament[\s\S]*transition === 'request'[\s\S]*requestTournamentMembership\(selectActiveTournament\(playerData\.memberships\)\?\.id\)/);
});

test('administrators assign annual teams in a compact active-member roster', async () => {
  const sql = await readFile(memberTeamMigrationUrl, 'utf8').catch(() => '');
  assert.match(sql, /create or replace function public\.set_tournament_member_team\(\s*target_tournament_id uuid,\s*target_user_id uuid,\s*target_team text\s*\)/i);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(target_tournament_id::text, 0\)\)[\s\S]*from public\.tournaments[\s\S]*for update/i);
  assert.match(sql, /status = 'active'[\s\S]*for update[\s\S]*public\.is_admin\(\)[\s\S]*public\.is_tournament_admin\(target_tournament_id\)/i);
  assert.match(sql, /target_team is not null and target_team not in \('cardinal', 'silver'\)/i);
  assert.match(sql, /set team = target_team/i);
  assert.match(sql, /grant execute on function public\.set_tournament_member_team\(uuid, uuid, text\) to authenticated/i);
  assert.match(supabaseScript, /export async function setTournamentMemberTeam/);
  assert.match(adminScript, /setTournamentMemberTeam/);
  assert.match(adminScript, /teamSelect\.addEventListener\('change', async \(\) =>/);
  assert.match(adminScript, /teamSelect\.addEventListener\('change',[\s\S]*await setTournamentMemberTeam\(/);
  assert.doesNotMatch(adminScript, /saveTeam|Save team/);
  assert.match(adminScript, /setMessage\(membershipMessage, `\$\{name\.textContent\}'s team is now/);
  assert.match(adminScript, /membership\.team = saved\.team[\s\S]*applyActiveMemberFilters\(\)/);
  assert.match(adminScript, /new Option\('Unassigned', ''\)[\s\S]*new Option\('Blue', 'cardinal'\)[\s\S]*new Option\('White', 'silver'\)/);
  assert.match(adminHtml, /<div[^>]*class="[^"]*active-member-list[^"]*"[^>]*id="activeMembers"/);
  assert.match(adminCss, /\.active-member-list\{[^}]*max-height:[^;}]+;[^}]*overflow-y:auto/i);
});

test('administrators manage tournament-specific Player and Admin roles from Active Members', async () => {
  const sql = await readFile(memberRoleMigrationUrl, 'utf8').catch(() => '');
  assert.match(sql, /create or replace function public\.set_tournament_member_role\(\s*target_tournament_id uuid,\s*target_user_id uuid,\s*target_role text\s*\)/i);
  assert.match(sql, /target_role not in \('player', 'admin'\)/i);
  assert.match(sql, /pg_advisory_xact_lock\(hashtextextended\(target_tournament_id::text, 0\)\)[\s\S]*from public\.tournaments[\s\S]*for update/i);
  assert.match(sql, /from public\.tournament_memberships[\s\S]*status = 'active'[\s\S]*for update[\s\S]*public\.is_admin\(\)[\s\S]*public\.is_tournament_admin\(target_tournament_id\)/i);
  assert.match(sql, /target_user_id = auth\.uid\(\)[\s\S]*current_membership\.role = 'admin'[\s\S]*target_role = 'player'/i);
  assert.match(sql, /global_profile_role = 'admin'[\s\S]*target_role = 'player'/i);
  assert.match(sql, /count\(\*\)[\s\S]*role = 'admin'[\s\S]*status = 'active'[\s\S]*active_admin_count <= 1/i);
  assert.match(sql, /set role = target_role,[\s\S]*updated_at = now\(\)/i);
  assert.match(sql, /grant execute on function public\.set_tournament_member_role\(uuid, uuid, text\) to authenticated/i);

  assert.match(supabaseScript, /export async function setTournamentMemberRole/);
  assert.match(supabaseScript, /rpc\('set_tournament_member_role'/);
  assert.match(adminScript, /new Option\('Player', 'player'\)[\s\S]*new Option\('Admin', 'admin'\)/);
  assert.match(adminScript, /roleSelect\.addEventListener\('change', async \(\) =>[\s\S]*membershipMutationGate\.begin\(\)[\s\S]*await setTournamentMemberRole\([\s\S]*membershipMutationGate\.end\(\)/);
  assert.match(adminScript, /membership\.user_id === session\.user\.id[\s\S]*membership\.role === 'admin'/);
  assert.match(adminScript, /membership\.profiles\?\.role === 'admin'/);
  assert.match(adminScript, /membership\.role = saved\.role[\s\S]*renderMemberships\(\)/);
  assert.match(adminHtml, /admin\.js\?v=production-readiness-1/);
});

test('an authenticated user requests missing tournament membership before portal data loads', () => {
  assert.match(supabaseScript, /export async function requestTournamentMembership/);
  assert.match(supabaseScript, /rpc\('request_tournament_membership'/);
  assert.match(portalScript, /await requestTournamentMembership\(\);[\s\S]*await loadPlayerData\(session\.user\.id\)/);
});

test('newly registered players see an approval-pending state instead of automatic access copy', () => {
  assert.match(portalHtml, /administrator approval/i);
  assert.doesNotMatch(portalHtml, /account automatically carries into every Hereford Cup tournament/i);
  assert.match(portalScript, /membership\.role === 'admin'/);
});
