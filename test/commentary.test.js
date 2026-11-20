import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { commentaryPhrasesForTone, composeCommentary, phraseIdsForTone } from '../src/commentary.js';

const commentaryModuleUrl = new URL('../src/commentary.js', import.meta.url);
const edgeFunctionUrl = new URL('../supabase/functions/generate-match-commentary/index.ts', import.meta.url);
const autoPublicationMigrationUrl = new URL('../supabase/migrations/007_auto_commentary_publication.sql', import.meta.url);
const commentaryLifecycleMigrationUrl = new URL('../supabase/migrations/012_commentary_and_legacy_hardening.sql', import.meta.url);
const commentaryBanterMigrationUrl = new URL('../supabase/migrations/024_commentary_banter.sql', import.meta.url);
const ruthlessDefaultMigrationUrl = new URL('../supabase/migrations/026_ruthless_commentary_default.sql', import.meta.url);
const savageDefaultMigrationUrl = new URL('../supabase/migrations/036_savage_commentary_default.sql', import.meta.url);
const adminHtmlUrl = new URL('../admin.html', import.meta.url);
const supabaseClientUrl = new URL('../src/supabase.js', import.meta.url);
const adminUrl = new URL('../src/admin.js', import.meta.url);

test('commentary composition accepts only server-owned tone phrase identifiers', () => {
  assert.ok(phraseIdsForTone('playful').length >= 6);
  assert.ok(phraseIdsForTone('ruthless').length >= 6);
  assert.ok(phraseIdsForTone('savage').length >= 6);
  assert.equal(
    composeCommentary('Blue wins 2 & 1', 'playful', 'playful_excuses'),
    'Blue wins 2 & 1. The winners get bragging rights; the losers get first crack at the excuses.',
  );
  assert.throws(
    () => composeCommentary('Blue wins 2 & 1', 'playful', 'invented_claim'),
    /Invalid commentary phrase identifier/,
  );
});

test('Savage commentary uses scorecard-grounded roasting from the server allowlist', () => {
  assert.equal(
    composeCommentary('Blue wins 5 & 4', 'savage', 'savage_competition_left'),
    'Blue wins 5 & 4. The losing side was still on the scorecard, but the competition had already left.',
  );
  assert.equal(
    composeCommentary('Match Halved', 'savage', 'savage_halved_afternoon'),
    'Match Halved. Nobody lost, nobody won, and the scorecard would like its afternoon back.',
  );
});

test('Savage phrase identifiers and text stay identical in the browser, Edge Function, and database', async () => {
  const [edgeSource, sql] = await Promise.all([
    readFile(edgeFunctionUrl, 'utf8'),
    readFile(savageDefaultMigrationUrl, 'utf8'),
  ]);
  const normalizedEdgeSource = edgeSource.replaceAll('\r\n', '\n');
  const edgeBlock = /savage:\s*\{([\s\S]*?)\n\s*\},\n\};/.exec(normalizedEdgeSource)?.[1] ?? '';
  const edgePhrases = Object.fromEntries(
    [...edgeBlock.matchAll(/^\s*(savage_[a-z_]+): '([^']+)',?$/gm)].map(match => [match[1], match[2]]),
  );
  const databasePhrases = Object.fromEntries(
    [...sql.matchAll(/when 'savage:(savage_[a-z_]+)' then '([^']+)'/g)].map(match => [match[1], match[2]]),
  );
  const browserPhrases = commentaryPhrasesForTone('savage');
  assert.equal(Object.keys(browserPhrases).length, 8);
  assert.deepEqual(edgePhrases, browserPhrases);
  assert.deepEqual(databasePhrases, browserPhrases);
});

test('Ruthless migration originally changed only the default', async () => {
  const sql = await readFile(ruthlessDefaultMigrationUrl, 'utf8');
  assert.match(sql, /alter table public\.commentary_settings[\s\S]*alter column tone set default 'ruthless'/i);
  assert.doesNotMatch(sql, /update public\.commentary_settings[\s\S]*set tone/i);
});

test('Savage becomes the default commentary tone without overwriting saved choices', async () => {
  const [sql, html, adminSource, edgeSource] = await Promise.all([
    readFile(savageDefaultMigrationUrl, 'utf8').catch(() => ''),
    readFile(adminHtmlUrl, 'utf8'),
    readFile(adminUrl, 'utf8'),
    readFile(edgeFunctionUrl, 'utf8'),
  ]);
  assert.match(sql, /alter table public\.commentary_settings[\s\S]*alter column tone set default 'savage'/i);
  assert.match(sql, /check \(tone in \('clean', 'playful', 'ruthless', 'savage'\)\)/i);
  assert.doesNotMatch(sql, /update public\.commentary_settings[\s\S]*set tone/i);
  assert.match(sql, /savage:savage_competition_left[\s\S]*competition had already left/i);
  assert.match(sql, /savage:savage_halved_afternoon[\s\S]*scorecard would like its afternoon back/i);
  assert.match(html, /<option value="savage" selected>Savage<\/option>/i);
  assert.doesNotMatch(html, /<option value="ruthless" selected>Ruthless<\/option>/i);
  assert.match(adminSource, /settings\?\.tone \?\? 'savage'/);
  assert.match(edgeSource, /savage_competition_left:[\s\S]*competition had already left/i);
  assert.match(edgeSource, /savage_halved_afternoon:[\s\S]*scorecard would like its afternoon back/i);
});

test('server-owned banter avoids invented play and course details', async () => {
  const source = await readFile(commentaryModuleUrl, 'utf8');
  assert.doesNotMatch(source, /one putt|cart ride|eighteen holes produced/i);
});

test('authoritative recap names participants and replays the exact one-segment match-play result', async () => {
  const [source, sql] = await Promise.all([
    readFile(edgeFunctionUrl, 'utf8'),
    readFile(commentaryBanterMigrationUrl, 'utf8'),
  ]);
  assert.match(source, /selectedSegments\.length !== 1/);
  assert.match(sql, /segment_count <> 1[\s\S]*one-segment/i);
  assert.match(sql, /segment_record\.format not in \('singles', 'fourball'\)/i);
  assert.match(sql, /join public\.profiles[\s\S]*display_name/i);
  assert.match(sql, /string_agg[\s\S]*order by assignment\.playing_order/i);
  assert.match(sql, /update public\.commentary_settings[\s\S]*timing = 'post_match'/i);
  assert.match(sql, /from public\.rounds round_record[\s\S]*for share/i);
  assert.match(sql, /from public\.scores score_record[\s\S]*for share/i);
  assert.match(sql, /for current_hole_number in segment_record\.start_hole\.\.segment_record\.end_hole loop/i);
  assert.match(sql, /result_text := winner_label[\s\S]*' Up'[\s\S]*' & '/i);
  assert.match(sql, /recap_text := participant_text \|\| result_text/i);
  assert.doesNotMatch(sql, /\|\| cardinal_points \|\| '-' \|\| silver_points/);
});

test('authoritative recap chooses an objective turning point and a factual halve fallback', async () => {
  const sql = await readFile(commentaryBanterMigrationUrl, 'utf8');
  assert.match(sql, /longest_streak >= 2/i);
  assert.match(sql, /streak_start_hole[\s\S]*streak_end_hole/i);
  assert.match(sql, /lead_for_good_hole/i);
  assert.match(sql, /took the lead for good on hole/i);
  assert.match(sql, /reverse derived_holes_played\.\.2/i);
  assert.match(sql, /squared the match on hole/i);
  assert.match(sql, /Every counted hole was halved/i);
  assert.match(sql, /order by[\s\S]*streak_length desc[\s\S]*start_hole asc/i);
});

test('manual recap regeneration replaces the active recap without duplicating its admin card', async () => {
  const [edgeSource, clientSource, adminSource, sql] = await Promise.all([
    readFile(edgeFunctionUrl, 'utf8'),
    readFile(supabaseClientUrl, 'utf8'),
    readFile(adminUrl, 'utf8'),
    readFile(commentaryBanterMigrationUrl, 'utf8'),
  ]);
  assert.match(edgeSource, /const regenerate = body\.regenerate === true/);
  assert.match(edgeSource, /if \(!regenerate\)[\s\S]*findActiveCommentary/);
  assert.match(edgeSource, /target_regenerate: regenerate/);
  assert.match(clientSource, /generateMatchCommentary\(matchId, \{ regenerate = false \} = \{\}\)/);
  assert.match(clientSource, /body: \{ matchId, commentaryType: 'post_match', regenerate \}/);
  assert.match(adminSource, /generateMatchCommentary\(matchId, \{ regenerate: true \}\)/);
  assert.match(adminSource, /upsertCommentaryById\(adminData\.commentaries, commentary\)/);
  assert.doesNotMatch(adminSource, /adminData\.commentaries\.unshift\(commentary\)/);
  assert.match(sql, /if target_regenerate and saved\.id is not null then/i);
  assert.match(sql, /update public\.match_commentaries[\s\S]*where id = saved\.id/i);
});

test('edge function constrains AI to deterministic anonymous facts and always saves a draft', async () => {
  const source = await readFile(edgeFunctionUrl, 'utf8');
  assert.doesNotMatch(source, /profiles\(display_name\)/);
  assert.match(source, /commentaryType !== 'post_match'/);
  assert.match(source, /selectedSegments\.length === 0/);
  assert.match(source, /selectedSegments\.some\(.*status !== 'final'/s);
  assert.match(source, /const outcomeClass = Number\(selectedSegments\[0\]\.differential\) === 0 \? 'halved' : 'decisive'/);
  assert.doesNotMatch(source, /'Cardinal'|'Silver'/);
  assert.match(source, /Do not name or quote people/i);
  assert.match(source, /injuries, weather, shots, emotions, or events/i);
  assert.match(source, /rpc\('create_commentary_draft'/);
  assert.doesNotMatch(source, /status: approved \? 'approved' : 'draft'/);
});

test('automatic commentary migration publishes AI output without weakening write controls', async () => {
  const sql = await readFile(autoPublicationMigrationUrl, 'utf8');
  assert.match(sql, /alter column require_approval set default false/i);
  assert.match(sql, /drop constraint if exists commentary_settings_require_approval_check/i);
  assert.match(sql, /update public\.commentary_settings[\s\S]*require_approval = false/i);
  assert.match(sql, /create or replace function public\.prepare_commentary_publication/i);
  assert.match(sql, /before insert on public\.match_commentaries/i);
  assert.match(sql, /new\.status := 'approved'/i);
  assert.match(sql, /new\.approved_by := new\.generated_by/i);
  assert.match(sql, /new\.approved_at := now\(\)/i);
  assert.doesNotMatch(sql, /grant insert[^;]*match_commentaries[^;]*authenticated/i);
});

test('automatic commentary retries ignore hidden recaps and recover concurrent generation', async () => {
  const [source, initialSql, lifecycleSql] = await Promise.all([
    readFile(edgeFunctionUrl, 'utf8'),
    readFile(autoPublicationMigrationUrl, 'utf8'),
    readFile(commentaryLifecycleMigrationUrl, 'utf8'),
  ]);
  assert.match(initialSql, /create unique index[^;]*match_commentaries[^;]*post_match/is);
  assert.match(lifecycleSql, /drop index if exists public\.match_commentaries_one_active_post_match/i);
  assert.match(lifecycleSql, /status <> 'hidden'/i);
  assert.match(source, /\.neq\('status', 'hidden'\)/);
  assert.match(source, /saveError\?\.code === '23505'/);
  assert.match(source, /return json\(\{ commentary: concurrentCommentary, reused: true \}\)/);
  assert.match(source, /return json\(\{ commentary: existingCommentary, reused: true \}\)/);
});

test('commentary tournament administrators can manage exact-tournament settings and operational backstops', async () => {
  const sql = await readFile(commentaryBanterMigrationUrl, 'utf8');
  assert.match(sql, /drop policy if exists "admins manage commentary settings"/i);
  assert.match(sql, /create policy "admins manage commentary settings"[\s\S]*is_tournament_admin\(tournament_id\)/i);
  assert.match(sql, /create or replace function public\.edit_commentary_draft[\s\S]*for update of commentary[\s\S]*is_tournament_admin\(commentary_tournament_id\)/i);
  assert.match(sql, /create or replace function public\.set_commentary_status[\s\S]*for update of commentary[\s\S]*is_tournament_admin\(commentary_tournament_id\)/i);
});

test('commentary administrator functions lock the row without a composite multi-target INTO', async () => {
  const sql = await readFile(commentaryBanterMigrationUrl, 'utf8');
  assert.doesNotMatch(
    sql,
    /select\s+commentary\s*,\s*match_record\.tournament_id\s+into\s+saved\s*,\s*commentary_tournament_id/gi,
  );
  const tournamentScopeLocks = sql.match(
    /select\s+match_record\.tournament_id\s+into\s+commentary_tournament_id[\s\S]*?for update of commentary/gi,
  ) ?? [];
  assert.equal(tournamentScopeLocks.length, 2);
});

test('edge function CORS permits Supabase browser SDK headers', async () => {
  const source = await readFile(edgeFunctionUrl, 'utf8');
  const allowHeaders = source.match(/'Access-Control-Allow-Headers': '([^']+)'/)?.[1]
    .split(',')
    .map(header => header.trim());
  assert.ok(allowHeaders?.includes('x-client-info'));
});

test('edge function authenticates an administrator and keeps AI credentials server-side', async () => {
  const source = await readFile(edgeFunctionUrl, 'utf8');
  assert.match(source, /Authorization/);
  assert.match(source, /global: \{ headers: \{ Authorization: authorization \} \}/);
  assert.match(source, /Authorization: `Bearer \$\{apiKey\}`/);
  assert.doesNotMatch(source, /\*\*\*/);
  assert.match(source, /rpc\('is_admin'\)/);
  assert.match(source, /selectedSegments\.length !== 1/);
  assert.match(source, /\['singles', 'fourball'\]\.includes/);
  assert.match(source, /AbortSignal\.timeout/);
  assert.match(source, /Deno\.env\.get\('AI_API_KEY'\)/);
  assert.match(source, /const PHRASE_ALLOWLIST/);
  assert.match(source, /allowedPhraseIds/);
  assert.match(source, /phraseId = String/);
  assert.match(source, /PHRASE_ALLOWLIST\[settings\.tone\]\?\.\[phraseId\]/);
  assert.doesNotMatch(source, /Verified result:/);
  assert.doesNotMatch(source, /facts\.result/);
  assert.doesNotMatch(source, /commentaryNumbersAreGrounded\(commentary/);
  assert.match(source, /rpc\('create_commentary_draft'/);
  assert.match(source, /target_phrase_id: phraseId/);
  assert.doesNotMatch(source, /target_commentary:/);
  assert.doesNotMatch(source, /target_facts:/);
  assert.doesNotMatch(source, /from\('match_commentaries'\)\.insert/);
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY/);
});

test('admin entrypoint cache-busts both changed modules', async () => {
  const [html, adminSource] = await Promise.all([
    readFile(new URL('../admin.html', import.meta.url), 'utf8'),
    readFile(adminUrl, 'utf8'),
  ]);
  assert.match(html, /src\/admin\.js\?v=savage-commentary-1/);
  assert.match(adminSource, /from '\.\/supabase\.js\?v=member-role-1'/);
});
