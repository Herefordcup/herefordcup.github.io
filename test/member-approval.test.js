import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const migrationUrl = new URL('supabase/migrations/018_membership_approval.sql', root);
const deletionMigrationUrl = new URL('supabase/migrations/019_delete_membership_reenroll.sql', root);
const denialMigrationUrl = new URL('supabase/migrations/020_deny_pending_membership.sql', root);
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
  for (const id of ['pendingMembers', 'activeMembers', 'membershipMessage']) {
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
  assert.match(adminCss, /\.membership-columns\{[^}]*grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(adminCss, /\.membership-card \.button\{[^}]*min-height:44px/);
  assert.match(adminHtml, /admin\.css\?v=admin-handicap-1/);
  assert.match(adminHtml, /admin\.js\?v=commentary-banter-1/);
  assert.match(adminScript, /supabase\.js\?v=commentary-banter-1/);
  assert.match(adminScript, /match-results\.js\?v=automatic-results-2/);
  assert.match(portalHtml, /portal\.js\?v=match-commentary-inline-1/);
  assert.match(portalScript, /supabase\.js\?v=match-commentary-inline-1/);
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
