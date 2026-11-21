import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = relativePath => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8').catch(() => '');

const workflow = await read('.github/workflows/qa-scenario-matrix.yml');
const seedSource = await read('scripts/e2e/seed-scenario-matrix.mjs');
const browserSource = await read('e2e/four-admin-scenarios.spec.mjs');
const verificationSource = await read('scripts/e2e/verify-scenario-matrix.mjs');
const matrixConfig = await read('playwright.matrix.config.mjs');
const ordinaryPlaywrightConfig = await read('playwright.config.mjs');
const packageJson = JSON.parse(await read('package.json'));

const productionProjectReference = 'mqulycovrogurvmjcimt';
const matrixIds = [
  'S1', 'S2', 'F1', 'F2', 'M1', 'R1', 'R2', 'R3',
  'C1', 'A1', 'A2', 'X1', 'X2', 'T1', 'T2', 'T3', 'T4', 'T5',
];

test('manual QA workflow is loopback-only, secret-free, and always destroys its stack', () => {
  assert.match(workflow, /^name: Four-player disposable E2E matrix/m);
  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/);
  assert.match(workflow, /pull_request:\s*\n\s*branches: \[main\]\s*\n\s*types: \[opened, synchronize, reopened, labeled\]/);
  assert.match(workflow, /if: github\.event_name == 'workflow_dispatch' \|\| contains\(github\.event\.pull_request\.labels\.\*\.name, 'run-qa-matrix'\)/);
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
  assert.match(workflow, /node scripts\/e2e\/prepare-project\.mjs "\$workdir"/);
  assert.match(workflow, /supabase db reset --workdir "\$E2E_WORKDIR" --no-seed/);
  assert.match(workflow, /test "\$API_URL" = "http:\/\/127\.0\.0\.1:54321"/);
  assert.match(workflow, /password="QA-\$\(openssl rand -hex 18\)"/);
  assert.match(workflow, /::add-mask::\$password/);
  assert.match(workflow, /node scripts\/e2e\/seed-scenario-matrix\.mjs/);
  assert.match(workflow, /npm run test:e2e:matrix/);
  assert.match(workflow, /node scripts\/e2e\/verify-scenario-matrix\.mjs/);
  assert.match(workflow, /if: always\(\)[\s\S]*supabase stop --workdir "\$E2E_WORKDIR" --no-backup/);
  assert.match(workflow, /Verify disposable Supabase is stopped/);
  assert.doesNotMatch(workflow, /environment:\s*production|SUPABASE_ACCESS_TOKEN|\$\{\{\s*secrets\.|supabase\.co/);
  assert.doesNotMatch(workflow, new RegExp(productionProjectReference));
});

test('matrix sources reserve four synthetic players and enumerate every scenario', () => {
  for (const [email, team] of [
    ['qa-player-1@local.test', 'cardinal'],
    ['qa-player-2@local.test', 'cardinal'],
    ['qa-player-3@local.test', 'silver'],
    ['qa-player-4@local.test', 'silver'],
  ]) {
    assert.match(seedSource, new RegExp(email.replace('.', '\\.')));
    assert.match(seedSource, new RegExp(`email: '${email}'[\\s\\S]*team: '${team}'`));
  }
  assert.match(seedSource, /assertDisposableSupabaseUrl/);
  assert.match(seedSource, /\/rest\/v1\/tournament_memberships\?on_conflict=tournament_id,user_id/);
  assert.match(seedSource, /resolution=merge-duplicates,return=representation/);
  assert.match(seedSource, /const mainTournament = await insert\('tournaments', \{[^}]*edition_year: 2027/);
  assert.doesNotMatch(seedSource, /const mainTournament = await insert\('tournaments', \{[^}]*edition_year: 2100/);
  assert.match(browserSource, /COMPLETE 2027 HEREFORD CUP/);
  assert.match(seedSource, /tournament_id: mainTournament\.id,[\s\S]*role: 'player'/);
  assert.match(seedSource, /tournament_id: roleProtectionTournament\.id,[\s\S]*role: index === 1 \? 'admin' : 'player'/);
  assert.match(seedSource, /qa-player-3@local\.test[^\n]*handicap: 3/);
  assert.match(browserSource, /async function scoreFromPortal/);
  assert.match(browserSource, /test\.setTimeout\(180_000\)/);
  assert.match(browserSource, /Hole \$\{holeNumber\} gross score/);
  assert.match(browserSource, /#saveRound/);
  assert.match(seedSource, /browserScored: true/);
  assert.match(seedSource, /disposable-four-admin-qa/);
  assert.match(seedSource, /\[DISPOSABLE-QA\]/);
  assert.doesNotMatch(`${seedSource}\n${browserSource}\n${verificationSource}`, new RegExp(productionProjectReference));

  const allSources = `${seedSource}\n${browserSource}\n${verificationSource}`;
  for (const id of matrixIds) assert.match(allSources, new RegExp(`\\[${id}\\]`));
});

test('matrix browser configuration is serial and emits no credential-bearing media', () => {
  assert.equal(packageJson.scripts?.['test:e2e:matrix'], 'playwright test --config playwright.matrix.config.mjs');
  assert.match(ordinaryPlaywrightConfig, /testIgnore: 'four-admin-scenarios\.spec\.mjs'/);
  assert.match(matrixConfig, /workers: 1/);
  assert.match(matrixConfig, /retries: 0/);
  assert.match(matrixConfig, /screenshot: 'off'/);
  assert.match(matrixConfig, /trace: 'off'/);
  assert.match(matrixConfig, /video: 'off'/);
  assert.match(browserSource, /portal\.html/);
  assert.match(browserSource, /admin\.html/);
  assert.match(browserSource, /past-trips\.html/);
});

test('exact verifier covers rollback, concurrency, completion, and generated archive protection', () => {
  assert.match(verificationSource, /Promise\.all/);
  assert.match(verificationSource, /finalize_match_results/);
  assert.match(verificationSource, /complete_tournament_archive/);
  assert.match(verificationSource, /score_correction_audit/);
  assert.match(verificationSource, /match_commentaries/);
  assert.match(verificationSource, /source_tournament_id/);
  assert.match(verificationSource, /source_segment_id/);
  assert.match(verificationSource, /course_handicap/);
  assert.match(verificationSource, /expectedScores/);
  assert.match(verificationSource, /\/rest\/v1\/scores\?round_id=eq\./);
  assert.doesNotMatch(verificationSource, /\/rest\/v1\/round_scores\?/);
  assert.match(verificationSource, /gross_score/);
  assert.match(verificationSource, /bluePoints/);
  assert.match(verificationSource, /whitePoints/);
  assert.match(verificationSource, /point_value/);
  assert.match(verificationSource, /Generated Past Trips results cannot be changed or deleted/);
  assert.match(verificationSource, /Round/);
  assert.match(verificationSource, /1v1/);
  assert.match(verificationSource, /2v2 Best Ball/);
  assert.match(verificationSource, /2v2 Foursomes/);
});
