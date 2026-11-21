import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { assertDisposableSupabaseUrl, runtimeConfigSource } from '../scripts/e2e/safety.mjs';

const workflow = await readFile(new URL('../.github/workflows/disposable-e2e.yml', import.meta.url), 'utf8').catch(() => '');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const supabaseConfig = await readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8');
const seedSource = await readFile(new URL('../scripts/e2e/seed.mjs', import.meta.url), 'utf8').catch(() => '');
const smokeSource = await readFile(new URL('../e2e/portal-admin.smoke.spec.mjs', import.meta.url), 'utf8').catch(() => '');
const playwrightConfig = await readFile(new URL('../playwright.config.mjs', import.meta.url), 'utf8').catch(() => '');

const productionUrl = 'https://mqulycovrogurvmjcimt.supabase.co';

test('disposable E2E accepts only loopback Supabase and rejects production or hosted projects', () => {
  assert.equal(assertDisposableSupabaseUrl('http://127.0.0.1:54321'), 'http://127.0.0.1:54321');
  assert.equal(assertDisposableSupabaseUrl('http://localhost:54321/'), 'http://localhost:54321');
  for (const unsafeUrl of [
    productionUrl,
    'https://example.supabase.co',
    'http://192.168.1.5:54321',
    'https://127.0.0.1:54321',
  ]) {
    assert.throws(() => assertDisposableSupabaseUrl(unsafeUrl), /disposable loopback Supabase/i);
  }
});

test('runtime config generation keeps the browser on the validated disposable project', () => {
  const source = runtimeConfigSource('http://127.0.0.1:54321', 'local-publishable-key');
  assert.match(source, /SUPABASE_URL = "http:\/\/127\.0\.0\.1:54321"/);
  assert.match(source, /SUPABASE_PUBLISHABLE_KEY = "local-publishable-key"/);
  assert.doesNotMatch(source, /mqulycovrogurvmjcimt/);
  assert.throws(() => runtimeConfigSource(productionUrl, 'key'), /disposable loopback Supabase/i);
});

test('disposable browser workflow is local-only, secret-free, and never targets production', () => {
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\s*[\s\S]*contents: read/);
  assert.match(workflow, /supabase start/);
  assert.match(workflow, /supabase db reset/);
  assert.match(workflow, /npm run test:e2e/);
  assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
  assert.match(workflow, /if: failure\(\)/);
  assert.match(workflow, /supabase stop/);
  assert.doesNotMatch(workflow, /environment:\s*production|SUPABASE_ACCESS_TOKEN|secrets\.|mqulycovrogurvmjcimt/);
  assert.match(playwrightConfig, /screenshot: 'off'/);
  assert.match(playwrightConfig, /trace: 'off'/);
  assert.match(playwrightConfig, /video: 'off'/);
  assert.equal(packageJson.scripts['test:e2e'], 'playwright test');
  assert.match(supabaseConfig, /^project_id = "hereford-cup-disposable-e2e"/m);
});

test('controlled account seed and browser smoke cover authenticated player and administrator paths', () => {
  assert.match(seedSource, /\/auth\/v1\/admin\/users/);
  assert.match(seedSource, /email_confirm/);
  assert.match(seedSource, /role: 'admin'/);
  assert.match(seedSource, /status: 'active'/);
  assert.match(seedSource, /team: 'cardinal'/);
  assert.match(smokeSource, /#emailAddress/);
  assert.match(smokeSource, /#dashboardView/);
  assert.match(smokeSource, /#profileSetupDialog/);
  assert.match(smokeSource, /admin\.html/);
  assert.match(smokeSource, /#membershipManagement/);
});
