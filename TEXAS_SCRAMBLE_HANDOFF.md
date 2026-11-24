# Texas Scramble implementation handoff

## Scope

This branch adds the first shared team-score workflow for a 16-player Hereford Cup:

- Blue A, Blue B, White A, and White B, with four players per squad.
- One independent shared scorecard per squad.
- Administrator-configurable roster, schedule, course/tee, and required selected tee shots.
- WHS four-player allowance: 25%, 20%, 15%, and 10% from lowest to highest Course Handicap.
- One Cup point per stroke under net par; zero for even par or worse.
- Assignment-first Play setup, shared course/tee locking, team score entry, and tee-shot attribution.
- Outcome-only match play using Blue, Halved, or White per hole.
- Server-authoritative completion, correction audit, standings points, and Past Trips generation.

## Architecture

- `supabase/migrations/041_texas_scramble_team_scoring.sql` owns schema, RLS, RPC authorization, shared-card writes, outcome writes, corrections, result updates, and archive generation.
- `src/team-scoring.js` contains pure WHS, net-score, point, contribution, and outcome helpers.
- `src/supabase.js` contains browser RPC wrappers and member-data loading.
- `src/admin.js` and `admin.html` contain the 16-player planner.
- `src/portal.js` and `portal.html` contain assignment selection and shared scoring.
- `scripts/e2e/verify-team-scoring-pglite.mjs` applies migrations 001–041 to an isolated PGlite database and exercises the 16-player database workflow.

## Verification

Run from the repository root:

```text
npm ci
npm test
node --check src/admin.js
node --check src/portal.js
node --check src/supabase.js
node --check src/match-results.js
```

`npm test` includes the isolated PGlite migration/runtime fixture through `test/team-scoring-database.test.js`.

The disposable browser workflow also runs the `@scramble` Playwright test. It signs in all 16 ordinary players, submits 72 holes through the four shared cards, verifies every stored score, tee-shot contributor and submitter, and checks the final Cup totals. On desktop and phone it checks that inactive scoring controls are hidden and that switching back to individual play restores its Save round button. For a draft, dispatch `gh workflow run disposable-e2e.yml --ref feat/texas-scramble-team-scoring` and verify that the run's head SHA matches the PR head and the final teardown check passes. Do not use production accounts.

## Checkout and continuation

```text
git fetch origin
git checkout feat/texas-scramble-team-scoring
git pull --ff-only
npm ci
npm test
```

The production deployment workflow applies migrations before publishing browser assets. Required protected configuration names remain unchanged: `SUPABASE_ACCESS_TOKEN` in the GitHub `production` environment and `SUPABASE_PROJECT_REF` as a repository variable.

## Release status and remaining gate

This branch has not been deployed to production and has not modified production tournament data. PGlite verifies PostgreSQL migration/runtime behavior, but it does not replace JWT-backed RLS, PostgREST, or browser verification against a real disposable Supabase stack. The exact pushed head must pass GitHub CI, including disposable authenticated browser checks, before merge.

Do not test destructive completion, corrections, or cleanup against real members or the live tournament. Use synthetic identities in disposable Supabase and destroy the stack afterward.
