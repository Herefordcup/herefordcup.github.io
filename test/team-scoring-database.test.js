import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

test('disposable PostgreSQL verifies Texas Scramble and outcome-entry workflows', { timeout: 120_000 }, async () => {
  const script = new URL('../scripts/e2e/verify-team-scoring-pglite.mjs', import.meta.url);
  const { stdout, stderr } = await execFileAsync(process.execPath, [fileURLToPath(script)], {
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(stderr, '');
  assert.match(stdout, /verified 4 squads, 72 shared holes, outcome entry, corrections, points, and archive/);
});
