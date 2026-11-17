import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase/migrations/002_tournament_access.sql', import.meta.url);
const baseMigrationUrl = new URL('../supabase/migrations/001_hereford_cup.sql', import.meta.url);

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
