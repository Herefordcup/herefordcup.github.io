import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8').catch(() => '');
const migration = await read('supabase/migrations/041_texas_scramble_team_scoring.sql');
const adminHtml = await read('admin.html');
const adminScript = await read('src/admin.js');
const portalHtml = await read('portal.html');
const portalScript = await read('src/portal.js');
const supabaseScript = await read('src/supabase.js');

test('migration 041 adds server-authoritative Texas Scramble sessions and shared scorecards', () => {
  for (const table of [
    'texas_scramble_sessions',
    'texas_scramble_squads',
    'texas_scramble_squad_players',
    'texas_scramble_hole_scores',
    'match_hole_outcomes',
    'team_score_correction_audit',
  ]) assert.match(migration, new RegExp(`create table public\\.${table}`));
  assert.match(migration, /squad_size in \(2, 4\)/);
  assert.match(migration, /required_tee_shots >= 0/);
  assert.match(migration, /unique \(squad_id, hole_number\)/);
  assert.match(migration, /tee_shot_player_id/);
  assert.match(migration, /entry_mode[^\n]+individual_scores[^\n]+hole_outcomes/);
});

test('Texas Scramble writes use narrow authenticated RPCs and direct mutations are revoked', () => {
  for (const rpc of [
    'save_texas_scramble_plan',
    'select_texas_scramble_course_tee',
    'submit_texas_scramble_hole',
    'submit_match_hole_outcome',
    'correct_team_score_entry',
  ]) {
    assert.match(migration, new RegExp(`function public\\.${rpc}`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${rpc}`));
  }
  assert.match(migration, /revoke insert, update, delete on public\.texas_scramble_hole_scores from authenticated/);
  assert.match(migration, /revoke insert, update, delete on public\.match_hole_outcomes from authenticated/);
  assert.match(migration, /auth\.uid\(\)/);
  assert.match(migration, /is_tournament_admin/);
});

test('Texas Scramble completion derives WHS handicap, tee-shot requirements, net points, and authoritative match results', () => {
  assert.match(migration, /0\.25[\s\S]*0\.20[\s\S]*0\.15[\s\S]*0\.10/);
  assert.match(migration, /0\.35[\s\S]*0\.15/);
  assert.match(migration, /required tee shot/i);
  assert.match(migration, /greatest\(0,[\s\S]*par[\s\S]*net_score/);
  assert.match(migration, /update public\.match_segments[\s\S]*point_value/);
  assert.match(migration, /update public\.matches[\s\S]*status = 'final'/);
});

test('administrator UI configures a 16-player four-squad Texas Scramble plan', () => {
  assert.match(adminHtml, /id="texasScrambleForm"/);
  assert.match(adminHtml, /id="texasScrambleSquads"/);
  assert.match(adminHtml, /Required tee shots per player/);
  assert.match(adminScript, /function renderTexasScrambleSquads/);
  assert.match(adminScript, /Blue A/);
  assert.match(adminScript, /Blue B/);
  assert.match(adminScript, /White A/);
  assert.match(adminScript, /White B/);
  assert.match(supabaseScript, /export async function saveTexasScramblePlan/);
});

test('Play auto-selects an assignment and exposes shared course, tee, team score, and tee-shot tracking', () => {
  assert.match(portalHtml, /id="assignmentSummary"/);
  assert.match(portalHtml, /id="teamScorecard"/);
  assert.match(portalHtml, /id="holeOutcomeScorecard"/);
  assert.match(portalScript, /function selectNextPlayableAssignment/);
  assert.match(portalScript, /function renderTexasScrambleScorecard/);
  assert.match(portalScript, /function renderHoleOutcomeScorecard/);
  assert.match(portalScript, /Tee shot used/);
  assert.match(supabaseScript, /export async function submitTexasScrambleHole/);
  assert.match(supabaseScript, /export async function submitMatchHoleOutcome/);
});

test('ordinary match planning exposes full scores or hole-winner entry without fabricating player scores', () => {
  assert.match(adminHtml, /Hole winner entry/);
  assert.match(migration, /match_hole_outcomes/);
  assert.match(migration, /winner[^\n]+cardinal[^\n]+silver[^\n]+halved/);
  assert.doesNotMatch(migration, /match_hole_outcomes[\s\S]{0,800}insert into public\.scores/);
});

test('database enforces one squad per player in a shared session', () => {
  assert.match(migration, /session_id uuid not null/);
  assert.match(migration, /unique \(session_id, user_id\)/);
  assert.match(migration, /foreign key \(squad_id, session_id\)/);
});

test('team scoring integrates correction, audit, tournament completion, and Past Trips', () => {
  assert.match(migration, /create or replace function public\.complete_tournament_archive/);
  assert.match(migration, /when 'scramble' then 'Texas Scramble'/);
  assert.match(migration, /WHS team allowance/);
  assert.match(migration, /team_score_correction_audit/);
  assert.match(migration, /correct_team_score_entry[\s\S]*complete_match_if_ready|correct_team_score_entry[\s\S]*point_value/);
});

test('outcome and scramble correction preserve immutable audit identity and recalculate results', () => {
  assert.match(migration, /correct_team_score_entry[\s\S]*before_value[\s\S]*after_value/);
  assert.match(migration, /correct_team_score_entry[\s\S]*update public\.match_segments/);
  assert.match(migration, /correct_team_score_entry[\s\S]*points_value := greatest/);
  assert.match(migration, /team_score_correction_audit[\s\S]*corrected_by/);
});

test('shared score writes lock session before match, squad, and score rows', () => {
  const submit = migration.slice(
    migration.indexOf('create or replace function public.submit_texas_scramble_hole'),
    migration.indexOf('create or replace function public.submit_match_hole_outcome'),
  );
  const sessionLock = submit.indexOf('texas_scramble_sessions where id = squad_session_id for update');
  const matchLock = submit.indexOf('matches where id = squad_match_id for update');
  const squadLock = submit.indexOf('texas_scramble_squads where id = target_squad_id for update');
  assert.ok(sessionLock >= 0 && matchLock > sessionLock && squadLock > matchLock);
});

test('administrator Texas Scramble times use the tournament timezone conversion', () => {
  assert.match(adminScript, /starts_at: easternDateTimeToIso\(data\.get\('startsAt'\)\)/);
});
