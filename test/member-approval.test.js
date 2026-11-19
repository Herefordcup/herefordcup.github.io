import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const migrationUrl = new URL('supabase/migrations/018_membership_approval.sql', root);
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

test('administrator portal exposes pending, active, and removed member controls', () => {
  for (const id of ['membershipTournament', 'pendingMembers', 'activeMembers', 'removedMembers', 'membershipMessage']) {
    assert.match(adminHtml, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(adminScript, /function renderMemberships\(/);
  assert.match(adminScript, /Approve/);
  assert.match(adminScript, /Remove/);
  assert.match(adminScript, /Restore/);
  assert.match(adminScript, /await setTournamentMembershipStatus\(/);
  assert.match(adminScript, /membership\.status === 'active'/);
  assert.match(adminCss, /\.membership-card \.button\{[^}]*min-height:44px/);
  assert.match(supabaseScript, /export async function setTournamentMembershipStatus/);
  assert.match(supabaseScript, /rpc\('set_tournament_membership_status'/);
  assert.doesNotMatch(supabaseScript, /tournament_memberships'\)\.select\([^\n]+\)\.eq\('status', 'active'\)/);
});

test('newly registered players see an approval-pending state instead of automatic access copy', () => {
  assert.match(portalHtml, /administrator approval/i);
  assert.doesNotMatch(portalHtml, /account automatically carries into every Hereford Cup tournament/i);
  assert.match(portalScript, /membership\.role === 'admin'/);
});
