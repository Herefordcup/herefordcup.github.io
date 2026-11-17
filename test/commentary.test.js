import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { composeCommentary, phraseIdsForTone } from '../src/commentary.js';

const edgeFunctionUrl = new URL('../supabase/functions/generate-match-commentary/index.ts', import.meta.url);
const autoPublicationMigrationUrl = new URL('../supabase/migrations/007_auto_commentary_publication.sql', import.meta.url);

test('commentary composition accepts only server-owned tone phrase identifiers', () => {
  assert.deepEqual(phraseIdsForTone('playful'), ['playful_pressure', 'playful_scoreboard']);
  assert.equal(
    composeCommentary('Cardinal wins 2 & 1', 'playful', 'playful_scoreboard'),
    'Cardinal wins 2 & 1. The scoreboard gets the final word.',
  );
  assert.throws(
    () => composeCommentary('Cardinal wins 2 & 1', 'playful', 'invented_claim'),
    /Invalid commentary phrase identifier/,
  );
});

test('edge function constrains AI to deterministic anonymous facts and always saves a draft', async () => {
  const source = await readFile(edgeFunctionUrl, 'utf8');
  assert.doesNotMatch(source, /profiles\(display_name\)/);
  assert.match(source, /settings\.timing !== 'segment_and_match'/);
  assert.match(source, /selectedSegments\.length === 0/);
  assert.match(source, /selectedSegments\.some\(.*status !== 'final'/s);
  assert.match(source, /function deterministicResult/);
  assert.match(source, /function deterministicMatchResult/);
  assert.match(source, /result: commentaryType === 'segment'[\s\S]*deterministicMatchResult/);
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

test('automatic commentary retries reuse an existing active recap instead of duplicating publication', async () => {
  const [source, sql] = await Promise.all([
    readFile(edgeFunctionUrl, 'utf8'),
    readFile(autoPublicationMigrationUrl, 'utf8'),
  ]);
  assert.match(sql, /create unique index[^;]*match_commentaries[^;]*post_match/is);
  assert.match(sql, /status <> 'rejected'/i);
  assert.match(source, /from\('match_commentaries'\)/);
  assert.match(source, /\.neq\('status', 'rejected'\)/);
  assert.match(source, /return json\(\{ commentary: existingCommentary, reused: true \}\)/);
});

test('edge function authenticates an administrator and keeps AI credentials server-side', async () => {
  const source = await readFile(edgeFunctionUrl, 'utf8');
  assert.match(source, /Authorization/);
  assert.match(source, /global: \{ headers: \{ Authorization: authorization \} \}/);
  assert.match(source, /Authorization: `Bearer \$\{apiKey\}`/);
  assert.doesNotMatch(source, /\*\*\*/);
  assert.match(source, /rpc\('is_admin'\)/);
  assert.match(source, /selectedSegments\.length !== 1/);
  assert.match(source, /AbortSignal\.timeout/);
  assert.match(source, /Deno\.env\.get\('AI_API_KEY'\)/);
  assert.match(source, /const PHRASE_ALLOWLIST/);
  assert.match(source, /allowedPhraseIds/);
  assert.match(source, /phraseId = String/);
  assert.match(source, /PHRASE_ALLOWLIST\[settings\.tone\]\?\.\[phraseId\]/);
  assert.match(source, /const commentary = `\$\{facts\.result\}\. \$\{closingPhrase\}`/);
  assert.doesNotMatch(source, /commentaryNumbersAreGrounded\(commentary/);
  assert.match(source, /rpc\('create_commentary_draft'/);
  assert.match(source, /target_phrase_id: phraseId/);
  assert.doesNotMatch(source, /target_commentary:/);
  assert.doesNotMatch(source, /target_facts:/);
  assert.doesNotMatch(source, /from\('match_commentaries'\)\.insert/);
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY/);
});
