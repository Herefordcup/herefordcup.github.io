import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { composeCommentary, phraseIdsForTone } from '../src/commentary.js';

const edgeFunctionUrl = new URL('../supabase/functions/generate-match-commentary/index.ts', import.meta.url);

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

test('edge function authenticates an administrator and keeps AI credentials server-side', async () => {
  const source = await readFile(edgeFunctionUrl, 'utf8');
  assert.match(source, /Authorization/);
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
