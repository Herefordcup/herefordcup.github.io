import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tournamentCompletionReadiness } from '../src/admin-helpers.js';

const migrationUrl = new URL('../supabase/migrations/037_atomic_tournament_completion.sql', import.meta.url);
const adminHtmlUrl = new URL('../admin.html', import.meta.url);
const adminScriptUrl = new URL('../src/admin.js', import.meta.url);
const supabaseClientUrl = new URL('../src/supabase.js', import.meta.url);

async function migrationSql() {
  try {
    return await readFile(migrationUrl, 'utf8');
  } catch {
    assert.fail('forward atomic tournament-completion migration is required');
  }
}

test('tournament completion adds stable archive provenance and one protected atomic RPC', async () => {
  const sql = await migrationSql();
  assert.match(sql, /alter table public\.legacy_editions[\s\S]*add column if not exists source_tournament_id uuid/i);
  assert.match(sql, /alter table public\.legacy_results[\s\S]*add column if not exists source_match_id uuid[\s\S]*add column if not exists source_segment_id uuid/i);
  assert.match(sql, /unique[\s\S]*source_tournament_id/i);
  assert.match(sql, /unique[\s\S]*source_segment_id/i);
  assert.match(sql, /foreign key \(source_segment_id, source_match_id\)[\s\S]*references public\.match_segments\(id, match_id\)/i);
  assert.match(sql, /create or replace function public\.complete_tournament_archive\(target_tournament_id uuid\)/i);
  assert.match(sql, /security definer[\s\S]*set search_path = public/i);
  assert.match(sql, /revoke all on function public\.complete_tournament_archive\(uuid\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.complete_tournament_archive\(uuid\) to authenticated/i);
});

test('completion locks authoritative scope before authorization and rejects incomplete tournaments', async () => {
  const sql = await migrationSql();
  const body = sql.match(/create or replace function public\.complete_tournament_archive[\s\S]*?\$\$;/i)?.[0] ?? '';
  const advisoryPosition = body.search(/pg_advisory_xact_lock/i);
  const tournamentLockPosition = body.search(/from public\.tournaments[\s\S]*for update/i);
  const authorizationPosition = body.search(/public\.is_admin\(\) or public\.is_tournament_admin\(tournament_record\.id\)/i);
  const matchLockPosition = body.search(/from public\.matches[\s\S]*for update/i);
  const segmentLockPosition = body.search(/from public\.match_segments[\s\S]*for update/i);
  const assignmentLockPosition = body.search(/from public\.match_segment_players[\s\S]*for update/i);

  assert.match(body, /pg_advisory_xact_lock\(\s*hashtextextended\(target_tournament_id::text, 0\)\s*\)/i);
  assert.ok(advisoryPosition >= 0, 'completion needs a transaction-scoped tournament lock');
  assert.ok(tournamentLockPosition > advisoryPosition, 'tournament row lock must follow the advisory lock');
  assert.ok(authorizationPosition > tournamentLockPosition, 'authorization must use the locked tournament');
  assert.ok(matchLockPosition > authorizationPosition, 'matches must lock after target authorization');
  assert.ok(segmentLockPosition > matchLockPosition, 'segments must lock after matches');
  assert.ok(assignmentLockPosition > segmentLockPosition, 'assignments must lock after segments');
  assert.match(body, /tournament_record\.status not in \('open', 'live', 'complete'\)/i);
  assert.match(body, /No tournament matches are available to archive/i);
  assert.match(body, /Every tournament match must be finalized/i);
  assert.match(body, /Every tournament segment must be finalized/i);
  assert.match(body, /Only Singles, Four-Ball, and Foursomes segments can be archived/i);
  assert.match(body, /Segment final results are not valid completed match-play results/i);
  assert.match(body, /segment_record\.format not in \('singles', 'fourball', 'foursomes'\)/i);
  assert.match(body, /segment_record\.holes_played < segment_record\.end_hole - segment_record\.start_hole \+ 1[\s\S]*abs\(segment_record\.differential\)/i);
  assert.match(body, /Every archived segment requires named Blue and White participants/i);
});

test('completion derives exact points and deterministic Round archive rows before publishing', async () => {
  const sql = await migrationSql();
  const body = sql.match(/create or replace function public\.complete_tournament_archive[\s\S]*?\$\$;/i)?.[0] ?? '';

  assert.match(body, /from public\.legacy_editions[\s\S]*source_tournament_id = target_tournament_id[\s\S]*edition_year = tournament_record\.edition_year[\s\S]*for update/i);
  assert.match(body, /Archive edition conflicts with authoritative completion/i);
  assert.match(body, /sum\(segment_record\.point_value\)/i);
  assert.match(body, /case when segment_record\.differential > 0 then segment_record\.point_value else 0 end/i);
  assert.match(body, /case when segment_record\.differential = 0 then segment_record\.point_value \/ 2 else 0 end/i);
  assert.match(body, /row_number\(\) over \(order by match_record\.starts_at nulls last, match_record\.name, match_record\.id\)/i);
  assert.match(body, /'Round ' \|\| ranked_match\.round_number \|\| ' - '/i);
  assert.match(body, /when 'singles' then '1v1'/i);
  assert.match(body, /when 'fourball' then '2v2 Best Ball'/i);
  assert.match(body, /when 'foursomes' then '2v2 Foursomes'/i);
  assert.match(body, /'Match Halved'/i);
  assert.match(body, /'Blue wins '/i);
  assert.match(body, /'White wins '/i);
  assert.match(body, /insert into public\.legacy_results[\s\S]*source_match_id[\s\S]*source_segment_id/i);

  const insertPosition = body.search(/insert into public\.legacy_results/i);
  const editionUpdatePosition = body.search(/update public\.legacy_editions[\s\S]*status = 'completed'/i);
  const tournamentUpdatePosition = body.search(/update public\.tournaments[\s\S]*status = 'complete'/i);
  assert.ok(insertPosition >= 0, 'archive rows must be generated');
  assert.ok(editionUpdatePosition > insertPosition, 'edition publication must follow generated rows');
  assert.ok(tournamentUpdatePosition > editionUpdatePosition, 'tournament completion must be the final mutation');
});

test('completed tournaments are idempotent and generated archive scoring cannot drift', async () => {
  const sql = await migrationSql();
  const body = sql.match(/create or replace function public\.complete_tournament_archive[\s\S]*?\$\$;/i)?.[0] ?? '';
  const completeBranch = body.match(/if tournament_record\.status = 'complete' then[\s\S]*?return edition_record;[\s\S]*?end if;/i)?.[0] ?? '';

  assert.match(completeBranch, /source_tournament_id is distinct from target_tournament_id/i);
  assert.match(completeBranch, /status <> 'completed'/i);
  assert.match(completeBranch, /published/i);
  assert.match(completeBranch, /score_confidence <> 'confirmed'/i);
  assert.match(completeBranch, /count\(\*\)[\s\S]*source_segment_id/i);
  assert.match(completeBranch, /sum\(result\.points_available\)/i);
  assert.match(completeBranch, /sum\(result\.cardinal_points\)/i);
  assert.match(completeBranch, /sum\(result\.silver_points\)/i);
  assert.match(completeBranch, /return edition_record/i);
  assert.doesNotMatch(completeBranch, /insert|update|delete/i);

  assert.match(sql, /create or replace function public\.protect_generated_legacy_archive\(\)/i);
  assert.match(sql, /tg_table_name = 'legacy_results'[\s\S]*old\.source_segment_id is not null[\s\S]*Generated Past Trips results cannot be changed or deleted/i);
  assert.match(sql, /if tg_op = 'UPDATE' then[\s\S]*new\.source_segment_id is not null[\s\S]*new\.edition_id[\s\S]*Generated Past Trips results cannot be changed or deleted/i);
  assert.match(sql, /tg_table_name = 'legacy_editions'[\s\S]*old\.source_tournament_id is not null/i);
  assert.match(sql, /new\.source_tournament_id is distinct from old\.source_tournament_id[\s\S]*coalesce\(new\.source_tournament_id, old\.source_tournament_id\)::text/i);
  assert.match(sql, /new\.story is distinct from old\.story/i);
  assert.match(sql, /Generated Past Trips scoring fields are immutable/i);
  assert.match(sql, /create trigger protect_generated_legacy_results/i);
  assert.match(sql, /before insert or update or delete on public\.legacy_results/i);
  assert.match(sql, /create trigger protect_generated_legacy_editions/i);
  assert.match(sql, /before insert or update or delete on public\.legacy_editions/i);
});

test('administrator completion requires an exact typed confirmation and refreshes authoritative data', async () => {
  const [html, adminScript, supabaseClient] = await Promise.all([
    readFile(adminHtmlUrl, 'utf8'),
    readFile(adminScriptUrl, 'utf8'),
    readFile(supabaseClientUrl, 'utf8'),
  ]);

  for (const id of ['tournamentCompletionForm', 'completionTournament', 'completionReadiness', 'completionConfirmation', 'completionMessage']) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(html, /Complete tournament and publish Past Trips/i);
  assert.match(html, /This cannot be used until every match is finalized/i);
  assert.match(supabaseClient, /export async function completeTournamentArchive/);
  assert.match(supabaseClient, /rpc\('complete_tournament_archive',\s*\{\s*target_tournament_id: tournamentId\s*\}/);
  assert.match(adminScript, /completeTournamentArchive/);
  assert.match(adminScript, /COMPLETE \$\{tournament\.edition_year\} HEREFORD CUP/);
  assert.match(adminScript, /confirmation !== completionPhrase\(tournament\)/);
  assert.match(adminScript, /await completeTournamentArchive\(tournament\.id\)/);
  assert.match(adminScript, /adminData = await loadAdminData\(\)/);
  assert.match(adminScript, /submitButton\.disabled = true/);
  assert.match(adminScript, /finally[\s\S]*submitButton\.disabled = false/);
  assert.match(html, /src\/admin\.js\?v=compact-scorecard-1/);
  assert.match(adminScript, /admin-helpers\.js\?v=compact-scorecard-1/);
  assert.match(adminScript, /supabase\.js\?v=compact-scorecard-1/);
});

test('tournament administrators can proceed when RLS hides the unpublished planned edition', () => {
  const tournament = { id: 'tournament-1', edition_year: 2099, status: 'open' };
  const matches = [
    { id: 'match-1', tournament_id: tournament.id, status: 'final' },
    { id: 'match-2', tournament_id: tournament.id, status: 'final' },
  ];
  const readiness = tournamentCompletionReadiness({ tournament, matches, editions: [] });
  assert.equal(readiness.ready, true);
  assert.match(readiness.text, /All 2 matches are final/);
  assert.match(readiness.text, /server will verify the planned Past Trips edition/i);
});
