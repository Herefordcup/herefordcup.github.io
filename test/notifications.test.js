import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase/migrations/017_member_email_notifications.sql', import.meta.url);
const edgeFunctionUrl = new URL('../supabase/functions/process-notifications/index.ts', import.meta.url);
const appsScriptUrl = new URL('../google-apps-script/notification-worker.gs', import.meta.url);
const portalUrl = new URL('../portal.html', import.meta.url);
const portalScriptUrl = new URL('../src/portal.js', import.meta.url);
const supabaseScriptUrl = new URL('../src/supabase.js', import.meta.url);
const supabaseConfigUrl = new URL('../supabase/config.toml', import.meta.url);

async function sources() {
  return Promise.all([
    readFile(migrationUrl, 'utf8'),
    readFile(edgeFunctionUrl, 'utf8'),
    readFile(appsScriptUrl, 'utf8'),
  ]);
}

test('notification storage separates preferences, jobs, and per-recipient delivery tracking', async () => {
  const [sql] = await sources();
  for (const table of ['notification_preferences', 'notification_jobs', 'notification_deliveries']) {
    assert.match(sql, new RegExp(`create table public\\.${table}`, 'i'), `missing ${table}`);
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'), `RLS missing for ${table}`);
  }
  assert.match(sql, /unique \(job_id, recipient_user_id\)/i);
  assert.match(sql, /idempotency_key text not null unique/i);
  assert.doesNotMatch(sql, /notification_(?:jobs|deliveries)[\s\S]{0,500}\bemail\b/i,
    'notification storage must use account IDs instead of persisting email addresses');
});

test('new active members enqueue one logical notification whose admins are resolved at claim time', async () => {
  const [sql] = await sources();
  assert.match(sql, /create or replace function public\.enqueue_new_member_notification/i);
  assert.match(sql, /after insert or update of status on public\.tournament_memberships/i);
  assert.match(sql, /if new\.status <> 'active' then[\s\S]*return new/i);
  assert.match(sql, /job_record\.notification_type = 'new_member'/i);
  assert.match(sql, /membership\.role = 'admin'/i);
  assert.match(sql, /membership\.status = 'active'/i);
  assert.match(sql, /membership\.user_id <> \(job_record\.payload ->> 'member_user_id'\)::uuid/i);
  assert.doesNotMatch(sql, /@gmail\.com|@herefordcup/i);
});

test('event and match reminders are queued twelve hours before and changes or cancellations notify immediately', async () => {
  const [sql] = await sources();
  assert.match(sql, /starts_at - interval '12 hours'/i);
  assert.match(sql, /insert into public\.notification_jobs[\s\S]*from public\.tournament_events/i,
    'existing future itinerary activities must receive reminder jobs');
  assert.match(sql, /insert into public\.notification_jobs[\s\S]*from public\.matches/i,
    'existing future matches must receive reminder jobs');
  assert.match(sql, /source_type = 'event'/i);
  assert.match(sql, /source_type = 'match'/i);
  assert.match(sql, /then 'cancellation' else 'schedule_change' end/i);
  assert.match(sql, /'cancellation'/i);
  assert.match(sql, /status in \('scheduled', 'cancelled'\)/i);
  assert.match(sql, /status in \('scheduled', 'live', 'final', 'cancelled'\)/i);
  assert.match(sql, /old\.starts_at is distinct from new\.starts_at/i);
  assert.match(sql, /\(old\.status = 'cancelled'\) is distinct from \(new\.status = 'cancelled'\)/i);
});

test('delivery claiming dynamically applies active membership and notification preferences', async () => {
  const [sql] = await sources();
  assert.match(sql, /create or replace function public\.claim_notification_deliveries/i);
  assert.match(sql, /for update skip locked/i);
  assert.match(sql, /membership\.status = 'active'/i);
  assert.match(sql, /coalesce\(preference\.reminders_enabled, true\)/i);
  assert.match(sql, /coalesce\(preference\.schedule_updates_enabled, true\)/i);
  assert.match(sql, /coalesce\(preference\.new_member_admin_enabled, true\)/i);
  assert.match(sql, /claimed_at < clock_timestamp\(\) - interval '15 minutes'/i);
  assert.match(sql, /create or replace function public\.complete_notification_deliveries/i);
  assert.match(sql, /attempt_count >= 5/i);
  assert.match(sql, /revoke all on function public\.claim_notification_deliveries/i);
  assert.match(sql, /grant execute on function public\.claim_notification_deliveries[^;]*service_role/i);
});

test('notification Edge Function authenticates the worker and resolves email only in the trusted service context', async () => {
  const [[, source], config] = await Promise.all([sources(), readFile(supabaseConfigUrl, 'utf8')]);
  assert.match(source, /Deno\.env\.get\('NOTIFICATION_WORKER_SECRET'\)/);
  assert.match(source, /Deno\.env\.get\('SUPABASE_SERVICE_ROLE_KEY'\)/);
  assert.match(source, /timingSafeEqual/);
  assert.match(source, /rpc\('claim_notification_deliveries'/);
  assert.match(source, /auth\.admin\.getUserById/);
  assert.match(source, /rpc\('complete_notification_deliveries'/);
  assert.match(source, /UUID_PATTERN/);
  assert.match(source, /'Cache-Control': 'no-store'/);
  assert.match(config, /\[functions\.process-notifications\][\s\S]*verify_jwt\s*=\s*false/i);
  assert.doesNotMatch(source, /console\.(?:log|info|debug)\([^)]*(?:email|messages|body)/i);
});

test('Apps Script worker sends through the dedicated Gmail account without logging secrets or duplicating acknowledged deliveries', async () => {
  const [, , source] = await sources();
  assert.match(source, /PropertiesService\.getScriptProperties\(\)/);
  assert.match(source, /NOTIFICATION_WORKER_SECRET/);
  assert.match(source, /SUPABASE_NOTIFICATION_FUNCTION_URL/);
  assert.match(source, /MailApp\.sendEmail/);
  assert.match(source, /MailApp\.getRemainingDailyQuota/);
  assert.match(source, /ScriptApp\.newTrigger\('runNotificationWorker'\)/);
  assert.match(source, /everyMinutes\(1\)/);
  assert.match(source, /delivery_id/);
  assert.match(source, /sentDeliveryIds/);
  assert.match(source, /MAX_SENT_CACHE_SIZE\s*=\s*100/);
  assert.doesNotMatch(source, /Logger\.log|console\.log/);
  assert.doesNotMatch(source, /herefordcup@gmail\.com/i, 'sender address is implicit in the authorized account');
});

test('members can manage email notification preferences without accessing delivery records', async () => {
  const [html, portal, supabase] = await Promise.all([
    readFile(portalUrl, 'utf8'),
    readFile(portalScriptUrl, 'utf8'),
    readFile(supabaseScriptUrl, 'utf8'),
  ]);
  assert.match(html, /id="notificationPreferencesForm"/);
  assert.match(html, /name="remindersEnabled"/);
  assert.match(html, /name="scheduleUpdatesEnabled"/);
  assert.match(html, /name="newMemberAdminEnabled"/);
  assert.match(portal, /saveNotificationPreferences/);
  assert.match(portal, /playerData\.notificationPreferences/);
  assert.match(supabase, /from\('notification_preferences'\)/);
  assert.match(supabase, /export async function saveNotificationPreferences/);
  assert.doesNotMatch(supabase, /from\('notification_(?:jobs|deliveries)'\)/);
});
