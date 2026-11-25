import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

test('team corrections take the archive and submission locks before reading the hole for update', async () => {
  const sql = await readFile(new URL('../supabase/migrations/041_texas_scramble_team_scoring.sql', import.meta.url), 'utf8');
  const body = sql.match(/function public\.correct_team_score_entry\([\s\S]*?as \$\$([\s\S]*?)\$\$;/i)[1];
  const statements = body.replace(/--[^\n]*/g, '').split(';');
  const locks = statements.filter(s => /pg_advisory_xact_lock|\bfor update\b/i.test(s)).map(s => {
    if (/pg_advisory_xact_lock/i.test(s)) return 'tournament advisory'; // Key checked inside the actual RPC transaction.
    return s.match(/\bfrom public\.(\w+)\b/i)?.[1];
  });
  const common = ['tournament advisory', 'tournaments'];
  assert.deepEqual(locks.filter(lock => lock !== 'match_hole_outcomes'),
    [...common, 'texas_scramble_sessions', 'matches', 'match_segments', 'texas_scramble_squads', 'texas_scramble_hole_scores']);
  assert.deepEqual(locks.filter(lock => !lock?.startsWith('texas_scramble_')),
    [...common, 'matches', 'match_segments', 'match_hole_outcomes']);
  assert.ok(statements.findLastIndex(s => /is_tournament_admin\(/i.test(s)) > statements.findLastIndex(s => /\bfor update\b/i.test(s)),
    'Check organizer authority after locking and revalidating the target');
});

test('disposable PostgreSQL verifies Texas Scramble and outcome-entry workflows', { timeout: 120_000 }, async () => {
  const script = new URL('../scripts/e2e/verify-team-scoring-pglite.mjs', import.meta.url);
  const { stdout, stderr } = await execFileAsync(process.execPath, [fileURLToPath(script)], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(stderr, '');
  assert.match(stdout, /verified 4 squads, 72 shared holes, outcome entry, corrections, points, and archive/);
});
