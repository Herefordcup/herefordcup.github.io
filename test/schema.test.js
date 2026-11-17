import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase/migrations/002_tournament_access.sql', import.meta.url);
const baseMigrationUrl = new URL('../supabase/migrations/001_hereford_cup.sql', import.meta.url);
const planningMigrationUrl = new URL('../supabase/migrations/003_2027_planning.sql', import.meta.url);
const integrityMigrationUrl = new URL('../supabase/migrations/005_integrity_hardening.sql', import.meta.url);

test('tournament access migration separates accounts from membership', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const table of ['tournaments', 'tournament_memberships', 'tournament_invitations']) {
    assert.match(sql, new RegExp(`create table(?: if not exists)? public\\.${table}`, 'i'), `missing ${table}`);
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'), `RLS missing for ${table}`);
  }
  assert.match(sql, /create or replace function public\.has_tournament_access/i);
  assert.match(sql, /create or replace function public\.claim_tournament_invitation/i);
});

test('unapproved accounts cannot read tournament scoring data', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  for (const policy of [
    'players view courses',
    'players view tees',
    'players view holes',
    'players view matches',
    'players view pairings',
    'players view tournament rounds',
    'players view tournament scores',
  ]) {
    assert.match(sql, new RegExp(`drop policy if exists "${policy}"`, 'i'), `broad policy remains: ${policy}`);
  }
  assert.match(sql, /public\.has_any_tournament_access\(\)/i);
});

test('score writes require round ownership and assigned match access', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /create or replace function public\.can_create_round/i);
  assert.match(sql, /create or replace function public\.can_write_round/i);
  assert.match(sql, /create or replace function public\.can_write_score/i);
  assert.match(sql, /public\.can_write_score\(round_id, user_id\)/i);
  assert.match(sql, /assignment\.user_id = auth\.uid\(\)/i);
});

test('captains cannot invite captains or administrators', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /inviter_role = 'captain' and target_role <> 'player'/i);
});

test('profile role protection uses invoker identity instead of definer current_user', async () => {
  const [baseSql, accessSql] = await Promise.all([
    readFile(baseMigrationUrl, 'utf8'),
    readFile(migrationUrl, 'utf8'),
  ]);
  for (const sql of [baseSql, accessSql]) {
    assert.match(sql, /create or replace function public\.prevent_role_escalation/i);
    assert.doesNotMatch(sql, /\bcurrent_user\b/i);
    assert.match(sql, /session_user/i);
    assert.match(sql, /auth\.role\(\)/i);
  }
});

test('pgcrypto functions resolve from the Supabase extensions schema', async () => {
  const [baseSql, accessSql] = await Promise.all([
    readFile(baseMigrationUrl, 'utf8'),
    readFile(migrationUrl, 'utf8'),
  ]);
  assert.match(baseSql, /create extension if not exists pgcrypto with schema extensions/i);
  assert.match(accessSql, /extensions\.gen_random_bytes\(/i);
  assert.match(accessSql, /extensions\.digest\(/i);
  assert.doesNotMatch(accessSql, /(?<!extensions\.)\bgen_random_bytes\(/i);
  assert.doesNotMatch(accessSql, /(?<!extensions\.)\bdigest\(/i);
});

test('2027 planning migration supports itinerary, mixed formats, rules, and commentary', async () => {
  const sql = await readFile(planningMigrationUrl, 'utf8');
  for (const table of [
    'tournament_events',
    'match_segments',
    'match_segment_players',
    'tournament_rules',
    'commentary_settings',
    'match_commentaries',
  ]) {
    assert.match(sql, new RegExp(`create table(?: if not exists)? public\\.${table}`, 'i'), `missing ${table}`);
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'), `RLS missing for ${table}`);
  }
  assert.match(sql, /select membership\.team into member_team/i, 'saved lineup must derive team from active membership');
  assert.match(sql, /player_record ->> 'team'[^;]*is distinct from member_team/i, 'spoofed segment teams must be rejected');
  assert.match(sql, /values \([\s\S]*member_team,[\s\S]*player_record ->> 'side'/i, 'trusted membership team must be persisted');
  assert.match(sql, /format in \('singles', 'fourball', 'foursomes', 'scramble', 'shamble', 'chapman'\)/i);
  assert.match(sql, /exclude using gist/i, 'segment overlap protection missing');
  assert.match(sql, /start_hole integer not null check \(start_hole between 1 and 18\)/i);
  assert.match(sql, /end_hole integer not null check \(end_hole between 1 and 18 and end_hole >= start_hole\)/i);
  assert.match(sql, /handicap_allowance numeric\(5,2\)/i);
  assert.match(sql, /point_value numeric\(4,2\)/i);
  assert.match(sql, /ai_generated boolean not null default true/i);
  assert.match(sql, /approved_by uuid references public\.profiles/i);
});

test('official statistics require complete rounds and finalized matches freeze score data', async () => {
  const sql = await readFile(planningMigrationUrl, 'utf8');
  assert.match(sql, /create or replace view public\.official_round_statistics/i);
  assert.match(sql, /match_record\.status = 'final'/i);
  assert.match(sql, /having count\(score\.id\) = \([\s\S]*count\(distinct expected_hole\.hole_number\)[\s\S]*generate_series/i);
  assert.match(sql, /create or replace function public\.prevent_final_match_score_changes/i);
  assert.match(sql, /old_match_id uuid/i);
  assert.match(sql, /new_match_id uuid/i);
  assert.match(sql, /match_record\.id in \(old_match_id, new_match_id\)/i);
  assert.match(sql, /create trigger freeze_final_match_rounds[\s\S]*on public\.rounds/i);
  assert.match(sql, /create trigger freeze_final_match_scores[\s\S]*on public\.scores/i);
});

test('match plans validate lineups server-side and segment tables are RPC-write-only', async () => {
  const sql = await readFile(planningMigrationUrl, 'utf8');
  assert.match(sql, /expected_players_per_side integer/i);
  assert.match(sql, /count\(\*\).*filter.*player ->> 'side' = 'cardinal'/is);
  assert.match(sql, /count\(distinct player ->> 'user_id'\)/i);
  assert.match(sql, /count\(distinct \(player ->> 'playing_order'\)::integer\)/i);
  assert.match(sql, /revoke insert, update, delete on public\.match_segments from authenticated/i);
  assert.match(sql, /revoke insert, update, delete on public\.match_segment_players from authenticated/i);
  assert.doesNotMatch(sql, /grant select, insert, update, delete on public\.match_segments to authenticated/i);
  assert.doesNotMatch(sql, /grant select, insert, update, delete on public\.match_segment_players to authenticated/i);
});

test('commentary rows enforce scope and match-segment coherence', async () => {
  const sql = await readFile(planningMigrationUrl, 'utf8');
  assert.match(sql, /unique \(id, match_id\)/i);
  assert.match(sql, /foreign key \(segment_id, match_id\) references public\.match_segments\(id, match_id\)/i);
  assert.match(sql, /commentary_type = 'segment' and segment_id is not null/i);
  assert.match(sql, /commentary_type = 'post_match' and segment_id is null/i);
});

test('final match records, plans, rounds, and tee metadata are immutable', async () => {
  const sql = await readFile(planningMigrationUrl, 'utf8');
  assert.match(sql, /create or replace function public\.prevent_final_match_changes/i);
  assert.match(sql, /before update or delete on public\.matches[\s\S]*prevent_final_match_changes/i);
  assert.match(sql, /old\.status = 'final'/i);
  assert.match(sql, /before update or delete on public\.match_segments[\s\S]*prevent_final_match_plan_changes/i);
  assert.match(sql, /before update or delete on public\.match_players[\s\S]*prevent_final_match_plan_changes/i);
  assert.match(sql, /before update or delete on public\.match_segment_players[\s\S]*prevent_final_match_plan_changes/i);
  assert.match(sql, /before update or delete on public\.tees[\s\S]*prevent_final_tee_changes/i);
  assert.match(sql, /before update or delete on public\.holes[\s\S]*prevent_final_tee_changes/i);
});

test('round authorization and official statistics bind match course, tee, and assigned segment scope', async () => {
  const [accessSql, planningSql] = await Promise.all([
    readFile(integrityMigrationUrl, 'utf8'),
    readFile(planningMigrationUrl, 'utf8'),
  ]);
  assert.match(accessSql, /can_create_round\(\s*target_user_id uuid,\s*target_match_id uuid,\s*target_course_id uuid,\s*target_tee_id uuid\s*\)/i);
  assert.match(accessSql, /tee_record\.course_id = target_course_id/i);
  assert.match(accessSql, /match_record\.course_id = target_course_id/i);
  assert.match(accessSql, /can_create_round\(\s*round_record\.user_id,\s*round_record\.match_id,\s*round_record\.course_id,\s*round_record\.tee_id\s*\)/i);
  assert.match(planningSql, /tee_record\.course_id = match_record\.course_id/i);
  assert.match(planningSql, /match_segment_players expected_assignment/i);
  assert.match(planningSql, /generate_series\(expected_segment\.start_hole, expected_segment\.end_hole\)/i);
});

test('commentary mutations are RPC-only and derive audit identities from auth uid', async () => {
  const sql = await readFile(planningMigrationUrl, 'utf8');
  assert.match(sql, /revoke insert, update, delete on public\.match_commentaries from authenticated/i);
  assert.match(sql, /create or replace function public\.create_commentary_draft/i);
  assert.match(sql, /generated_by[\s\S]*auth\.uid\(\)/i);
  assert.match(sql, /create or replace function public\.edit_commentary_draft/i);
  assert.match(sql, /create or replace function public\.set_commentary_status/i);
  assert.match(sql, /approved_by = case when target_status = 'approved' then auth\.uid\(\)/i);
});

test('playing orders are unique after integer coercion', async () => {
  const sql = await readFile(planningMigrationUrl, 'utf8');
  assert.match(sql, /unique \(segment_id, playing_order\)/i);
  assert.match(sql, /count\(distinct \(player ->> 'playing_order'\)::integer\)/i);
});

test('administrator result finalization is validated and RPC-only', async () => {
  const sql = await readFile(planningMigrationUrl, 'utf8');
  assert.match(sql, /create or replace function public\.finalize_match_results/i);
  assert.match(sql, /Administrator access required/i);
  assert.match(sql, /Every segment must have one authoritative final result/i);
  assert.match(sql, /Assigned rounds required for official statistics are incomplete/i);
  assert.match(sql, /update public\.matches[\s\S]*set status = 'final'/i);
  assert.match(sql, /grant execute on function public\.finalize_match_results\(uuid, jsonb\) to authenticated/i);
  assert.match(sql, /revoke insert, update, delete on public\.matches from authenticated/i);
  assert.doesNotMatch(sql, /coalesce\(nullif\(match_payload ->> 'status'/i);
  assert.match(sql, /status = 'scheduled'/i);
});

test('commentary approval cannot be disabled', async () => {
  const sql = await readFile(planningMigrationUrl, 'utf8');
  assert.match(sql, /check \(require_approval\)/i);
  assert.match(sql, /values \(tournament_id_value, true, 'playful', 'post_match', true, admin_id\)/i);
});

test('production access migration stays on its applied two-argument round authorization contract', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /can_create_round\(target_user_id uuid, target_match_id uuid\)/i);
  assert.doesNotMatch(sql, /target_course_id uuid/i);
});

test('forward hardening migration upgrades round authorization without changing migration 002', async () => {
  const sql = await readFile(integrityMigrationUrl, 'utf8');
  assert.match(sql, /drop function if exists public\.can_create_round\(uuid, uuid\)/i);
  assert.match(sql, /can_create_round\(\s*target_user_id uuid,\s*target_match_id uuid,\s*target_course_id uuid,\s*target_tee_id uuid\s*\)/i);
  assert.match(sql, /match_record\.course_id = target_course_id/i);
  assert.match(sql, /tee_record\.course_id = target_course_id/i);
  assert.match(sql, /with check \(public\.can_create_round\(user_id, match_id, course_id, tee_id\)\)/i);
});

test('player score submissions are insert-only and bound to the owned round', async () => {
  const sql = await readFile(integrityMigrationUrl, 'utf8');
  assert.match(sql, /unique \(id, user_id\)/i);
  assert.match(sql, /foreign key \(round_id, user_id\) references public\.rounds\(id, user_id\)/i);
  assert.match(sql, /Score ownership integrity check failed/i);
  assert.match(sql, /create policy "members create immutable scores"[\s\S]*for insert[\s\S]*can_write_score\(round_id, user_id\)/i);
  assert.match(sql, /drop policy if exists "members update their scores"/i);
  assert.match(sql, /revoke update, delete on public\.scores from authenticated/i);
  assert.doesNotMatch(sql, /create policy "members update their scores"/i);
});

test('persisted tournament rounds are immutable to players', async () => {
  const sql = await readFile(integrityMigrationUrl, 'utf8');
  assert.match(sql, /drop policy if exists "members update their round" on public\.rounds/i);
  assert.match(sql, /revoke update, delete on public\.rounds from authenticated/i);
  assert.doesNotMatch(sql, /create policy "members update their round"/i);
});

test('administrator score correction is an authenticated audited RPC that derives score ownership', async () => {
  const sql = await readFile(integrityMigrationUrl, 'utf8');
  assert.match(sql, /create or replace function public\.correct_hole_score/i);
  assert.match(sql, /if not public\.is_admin\(\)/i);
  assert.match(sql, /score_user_id := target_round\.user_id/i);
  assert.match(sql, /insert into public\.scores\(round_id, user_id, hole_number, gross_score/i);
  assert.match(sql, /on conflict \(round_id, hole_number\) do update/i);
  assert.match(sql, /delete from public\.scores/i);
  assert.match(sql, /auth\.uid\(\)/i);
  assert.match(sql, /grant execute on function public\.correct_hole_score/i);
});

test('score correction SQL avoids ambiguous round record identifiers and requires a reason', async () => {
  const sql = await readFile(integrityMigrationUrl, 'utf8');
  assert.doesNotMatch(sql, /round_record public\.rounds%rowtype[\s\S]*from public\.rounds round_record/i);
  assert.match(sql, /correction_reason text not null/i);
  assert.match(sql, /target_reason text/i);
  assert.match(sql, /char_length\(trim\(target_reason\)\)/i);
});

test('finalized metadata guards cover match courses and both old and new tee relationships', async () => {
  const sql = await readFile(integrityMigrationUrl, 'utf8');
  assert.match(sql, /from public\.matches match_record[\s\S]*match_record\.course_id/i);
  assert.match(sql, /old_course_id/i);
  assert.match(sql, /new_course_id/i);
  assert.match(sql, /old_tee_id/i);
  assert.match(sql, /new_tee_id/i);
  assert.match(sql, /before insert or update or delete on public\.holes/i);
  assert.match(sql, /before update or delete on public\.tees/i);
  assert.match(sql, /before update or delete on public\.courses/i);
  assert.match(sql, /select tee_record\.course_id into old_course_id[\s\S]*tee_record\.id = old_tee_id/i);
  assert.match(sql, /select tee_record\.course_id into new_course_id[\s\S]*tee_record\.id = new_tee_id/i);
});

test('commentary draft RPC derives deterministic facts and text from an allowlisted phrase', async () => {
  const sql = await readFile(integrityMigrationUrl, 'utf8');
  assert.match(sql, /create or replace function public\.create_commentary_draft\(\s*target_match_id uuid,\s*target_segment_id uuid,\s*target_commentary_type text,\s*target_phrase_id text,\s*target_model text/i);
  assert.doesNotMatch(sql, /create or replace function public\.create_commentary_draft\([\s\S]{0,250}target_commentary text/i);
  assert.doesNotMatch(sql, /create or replace function public\.create_commentary_draft\([\s\S]{0,250}target_facts jsonb/i);
  assert.match(sql, /settings_record\.enabled/i);
  assert.match(sql, /settings_record\.timing/i);
  assert.match(sql, /status = 'final'/i);
  assert.match(sql, /Invalid commentary phrase identifier/i);
  assert.match(sql, /generated_by[\s\S]*auth\.uid\(\)/i);
});

test('commentary edits preserve audit identity and mark text as administrator edited', async () => {
  const sql = await readFile(integrityMigrationUrl, 'utf8');
  assert.match(sql, /add column if not exists original_commentary text/i);
  assert.match(sql, /add column if not exists edited_by uuid/i);
  assert.match(sql, /add column if not exists edited_at timestamptz/i);
  assert.match(sql, /ai_generated = false/i);
  assert.match(sql, /model = null/i);
  assert.match(sql, /edited_by = auth\.uid\(\)/i);
  assert.match(sql, /edited_at = now\(\)/i);
});

test('2027 itinerary seed omits private payment and contact details', async () => {
  const sql = await readFile(planningMigrationUrl, 'utf8');
  assert.match(sql, /Tobacco Road/i);
  assert.match(sql, /Pinehurst No\. 2/i);
  assert.doesNotMatch(sql, /Venmo|Alexander-Gilbert|235-8403|\$2,160|\$300/i);
});
