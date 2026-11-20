import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  BASELINE_VERSIONS,
  localMigrationVersions,
  remoteMigrationVersions,
  verifyMigrationHistory,
} from '../scripts/verify-migration-history.mjs';

const root = new URL('../', import.meta.url);
const workflow = await readFile(new URL('.github/workflows/production.yml', root), 'utf8').catch(() => '');
const bootstrap = await readFile(new URL('.github/workflows/bootstrap-migration-history.yml', root), 'utf8').catch(() => '');

function listOutput(local, remote, remoteOnly = []) {
  const rows = local.map((version, index) => `   \`${version}\` | \`${remote[index] ?? ' '}\` | \`2026-01-01\``);
  rows.push(...remoteOnly.map(version => `   \` \` | \`${version}\` | \`2026-01-01\``));
  return `Local | Remote | Time\n------|--------|-----\n${rows.join('\n')}`;
}

test('production deploy runs only on main and strictly gates build and Pages deployment on migrations', () => {
  assert.match(workflow, /on:\s*[\s\S]*push:\s*[\s\S]*branches:\s*\[main\]/);
  assert.doesNotMatch(workflow, /workflow_dispatch:|pull_request:/);
  assert.match(workflow, /test:\s*[\s\S]*npm test/);
  assert.match(workflow, /migrate:\s*[\s\S]*needs: test[\s\S]*environment: production/);
  assert.match(workflow, /build:\s*[\s\S]*needs: migrate[\s\S]*jekyll-build-pages/);
  assert.match(workflow, /deploy:\s*[\s\S]*needs: build[\s\S]*pages: write[\s\S]*id-token: write[\s\S]*deploy-pages/);
});

test('production mutation paths are serialized, exact-project-scoped, and use step-scoped secrets', () => {
  assert.match(workflow, /concurrency:\s*[\s\S]*group: production-database/);
  assert.match(bootstrap, /concurrency:\s*[\s\S]*group: production-database/);
  assert.match(workflow, /PROJECT_REF: \$\{\{ vars\.SUPABASE_PROJECT_ID \}\}[\s\S]*test "\$PROJECT_REF" = "mqulycovrogurvmjcimt"/);
  assert.match(bootstrap, /PROJECT_REF: \$\{\{ vars\.SUPABASE_PROJECT_ID \}\}[\s\S]*test "\$PROJECT_REF" = "mqulycovrogurvmjcimt"/);
  assert.doesNotMatch(workflow, /--remote=\$\{\{/);
  assert.doesNotMatch(bootstrap, /--remote=\$\{\{/);
  assert.doesNotMatch(workflow, /migrate:[\s\S]{0,350}\n\s+env:\s*\n\s+SUPABASE_ACCESS_TOKEN/);
  assert.doesNotMatch(bootstrap, /bootstrap:[\s\S]{0,350}\n\s+env:\s*\n\s+SUPABASE_ACCESS_TOKEN/);
  assert.doesNotMatch(`${workflow}\n${bootstrap}`, /SUPABASE_(?:ACCESS_TOKEN|DB_PASSWORD):\s*[^$\s]/);
  assert.doesNotMatch(`${workflow}\n${bootstrap}`, /SUPABASE_DB_PASSWORD/);
  const patDeclaration = /SUPABASE_ACCESS_TOKEN:\s*\$\{\{ secrets\.SUPABASE_ACCESS_TOKEN \}\}/g;
  assert.equal([...workflow.matchAll(patDeclaration)].length, 5);
  assert.equal([...bootstrap.matchAll(patDeclaration)].length, 3);
});

test('all production actions and the Supabase CLI are pinned', () => {
  const combined = `${workflow}\n${bootstrap}`;
  assert.doesNotMatch(combined, /uses:\s*[^\s]+@v\d|version:\s*latest/);
  assert.match(combined, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/);
  assert.match(combined, /supabase\/setup-cli@1dedf2c611547ede7232d26866dd3c56ab903bbb[\s\S]*version: 3\.2\.0/);
});

test('bootstrap is main-only, confirmation-gated, and repairs exactly 001-028 without replaying SQL', () => {
  assert.match(bootstrap, /workflow_dispatch:/);
  assert.match(bootstrap, /test "\$GITHUB_REF" = "refs\/heads\/main"/);
  assert.match(bootstrap, /test "\$CONFIRMATION" = "MARK_001_TO_028_APPLIED"/);
  assert.match(bootstrap, /environment: production/);
  const repair = /supabase migration repair([\s\S]*?)--status applied/.exec(bootstrap)?.[1] ?? '';
  assert.deepEqual([...repair.matchAll(/\b\d{3}\b/g)].map(match => match[0]), BASELINE_VERSIONS);
  assert.doesNotMatch(repair, /\b029\b/);
  assert.match(bootstrap, /verify-migration-history\.mjs empty[\s\S]*migration repair[\s\S]*verify-migration-history\.mjs baseline/);
  assert.doesNotMatch(bootstrap, /supabase db push/);
});

test('migration history parser rejects incomplete, divergent, and unexpected histories', () => {
  const local = localMigrationVersions();
  assert.deepEqual(local, [...BASELINE_VERSIONS, '029', '030', '031', '032', '033', '034', '035', '036']);
  const empty = listOutput(local, []);
  const baseline = listOutput(local, BASELINE_VERSIONS);
  const complete = listOutput(local, local);
  assert.deepEqual(remoteMigrationVersions(baseline), BASELINE_VERSIONS);
  assert.doesNotThrow(() => verifyMigrationHistory('empty', empty, local));
  assert.doesNotThrow(() => verifyMigrationHistory('baseline', baseline, local));
  assert.doesNotThrow(() => verifyMigrationHistory('prefix', baseline, local));
  assert.doesNotThrow(() => verifyMigrationHistory('complete', complete, local));
  assert.throws(() => verifyMigrationHistory('baseline', complete, local), /exactly 001-028/);
  assert.throws(() => verifyMigrationHistory('prefix', listOutput(local, BASELINE_VERSIONS.slice(0, 27)), local), /missing/);
  const divergent = [...BASELINE_VERSIONS.slice(0, 27), '029'];
  assert.throws(() => verifyMigrationHistory('prefix', listOutput(local, divergent), local), /valid local migration prefix/);
  const remoteOnly = listOutput(local, BASELINE_VERSIONS, ['999']);
  assert.deepEqual(remoteMigrationVersions(remoteOnly), [...BASELINE_VERSIONS, '999']);
  assert.throws(() => verifyMigrationHistory('empty', listOutput(local, [], ['999']), local), /must be empty/);
  assert.throws(() => verifyMigrationHistory('baseline', remoteOnly, local), /exactly 001-028/);
  assert.throws(() => verifyMigrationHistory('prefix', remoteOnly, local), /valid local migration prefix/);
  assert.throws(() => verifyMigrationHistory('complete', remoteOnly, local), /every checked-out migration/);
  assert.throws(() => remoteMigrationVersions('unexpected output'), /missing the Local\/Remote header/);
  assert.throws(() => remoteMigrationVersions('Local | Remote | Time\n------|--------|-----'), /contains no migration rows/);
  assert.throws(
    () => remoteMigrationVersions('Local | Remote | Time\n------|--------|-----\n`001` | `unexpected` | `-`'),
    /Unrecognized Supabase migration row/,
  );
});

test('production verifies a valid prefix before push and an exact history afterward', () => {
  assert.match(workflow, /migration list[\s\S]*verify-migration-history\.mjs prefix[\s\S]*db push[\s\S]*--dry-run[\s\S]*db push[\s\S]*--yes[\s\S]*migration list[\s\S]*verify-migration-history\.mjs complete/);
});

test('production deploys the commentary Edge Function after migration verification and before Pages build', () => {
  assert.match(
    workflow,
    /verify-migration-history\.mjs complete[\s\S]*functions deploy generate-match-commentary --remote="\$PROJECT_REF" --use-api --yes[\s\S]*build:\s*[\s\S]*needs: migrate/,
  );
});
