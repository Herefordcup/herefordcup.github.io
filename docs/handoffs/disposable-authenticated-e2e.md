# Disposable authenticated browser E2E

## Purpose

This change adds an authenticated player/Admin smoke test without allowing browser automation to reach production or any hosted Supabase project.

## Safety architecture

- GitHub Actions starts a disposable loopback Supabase stack at `http://127.0.0.1:54321`.
- The complete repository migration chain is applied with `supabase db reset --no-seed`.
- `scripts/e2e/prepare-project.mjs` copies the Supabase project into runner-temporary storage, removes any local CLI link metadata, and wraps legacy migration `006` in an explicit transaction for Supabase CLI 3 without editing the already-applied production migration.
- `scripts/e2e/safety.mjs` accepts only HTTP loopback Supabase URLs and rejects malformed, LAN, HTTPS, and hosted URLs before seeding or serving the app.
- The workflow does not declare the protected `production` environment, reference GitHub secrets, or use the production project identifier.
- A generated password and local service key exist only in the job environment. The password is masked.
- `scripts/e2e/seed.mjs` creates one confirmed `@local.test` administrator, one setup tournament, and one active Blue-team membership.
- `scripts/e2e/serve.mjs` overrides only `src/config.js` so the checked-out static app talks to the validated local Supabase endpoint.
- Playwright signs in, verifies the member dashboard, saves and reads back a profile handicap, opens the administrator page, and verifies the one-member roster.
- Screenshots, traces, and video are disabled so failure artifacts cannot capture credentials. The credential-free HTML report is retained for seven days only on failure.
- `supabase stop --no-backup` runs unconditionally to destroy the disposable data.

## Files

- `.github/workflows/disposable-e2e.yml`
- `playwright.config.mjs`
- `e2e/portal-admin.smoke.spec.mjs`
- `scripts/e2e/safety.mjs`
- `scripts/e2e/seed.mjs`
- `scripts/e2e/serve.mjs`
- `test/disposable-e2e.test.js`
- `supabase/config.toml`

## Verification

Run the source-contract and full unit suite:

    npm ci
    npm test

Run the browser test only after a disposable local Supabase stack is active and these job-local variables are set:

- `E2E_SUPABASE_URL`
- `E2E_SUPABASE_PUBLISHABLE_KEY`
- `E2E_SERVICE_ROLE_KEY`
- `E2E_USER_EMAIL`
- `E2E_USER_PASSWORD`

Then run:

    node scripts/e2e/seed.mjs
    npx playwright install chromium
    npm run test:e2e

Never point these variables at a hosted project. The scripts reject non-loopback URLs, but the workflow remains the supported execution path.

## Current state and continuation

- Branch: `feat/controlled-e2e-smoke`
- Base: `main`
- Local source-contract/full test suite, Actionlint, dependency audit, diff check, and added-line security scan pass.
- The development computer has no Docker runtime; the real Supabase/Playwright path passed in pull-request CI, including full migration application, authenticated write/readback, and unconditional cleanup.
- Independent reviewer agents timed out without returning a verdict; they did not change files. The executable CI gate remains fail-closed.
- This PR does not change production frontend behavior, production data, migrations, Edge Functions, or deployment credentials.

Hermes continuation:

1. Fetch and check out `feat/controlled-e2e-smoke`.
2. Confirm the PR head SHA matches the local branch.
3. Watch `Disposable authenticated browser smoke` to completion.
4. If it fails, inspect the failed step and credential-free report; fix only the disposable test path and rerun the full suite.
5. Do not approve or merge until the real local Supabase stack, authenticated Playwright write/readback, and unconditional cleanup all pass in CI.
6. After approval, verify the PR state before merging, then watch the exact production workflow for the merge SHA even though this change should not mutate production data.
