# Atomic tournament completion handoff

## Status

Branch: `feat/atomic-tournament-completion`

This change is not deployed and has not exercised any production Finalize match or Complete tournament control. Production tournament, match, and Past Trips data remain untouched.

## Architecture

- Migration `037_atomic_tournament_completion.sql` adds stable tournament/match/segment provenance to future generated Past Trips records.
- Authenticated global administrators and active tournament administrators call one `SECURITY DEFINER` RPC: `public.complete_tournament_archive(uuid)`.
- The RPC takes the tournament advisory lock shared with roster mutations, locks tournament → match → segment → assignment rows, and authorizes after the tournament lock.
- The server rejects unsupported tournament states, missing or non-final matches/segments, unsupported formats, invalid completed match-play results, missing named Blue/White participants, conflicting history, and drifted completed archives.
- The server calculates Blue/White points, winner/tie, final score, participant labels, human results, and deterministic `Round N - <game style>` archive rows from authoritative finalized data.
- Generated rows, edition publication, and final tournament status change happen in one transaction. The tournament status update is the final mutation.
- Repeating completion is read-only and succeeds only when the completed tournament and generated archive still match authoritative results.
- Database triggers block direct generated-result mutation and generated-edition scoring/provenance drift while retaining administrator-editable story metadata.
- `admin.html` exposes a guarded action beside authoritative match finalization. It requires the exact phrase `COMPLETE <YEAR> HEREFORD CUP`; the database remains authoritative.
- Disposable Playwright creates a two-player finalized 2099 fixture, completes it through the real Admin UI, repeats the RPC to verify idempotence, reads the public Past Trips page, then performs exact service-context database readback and proves generated-result mutation is rejected.

## Primary files

- `supabase/migrations/037_atomic_tournament_completion.sql`
- `src/admin.js`
- `src/admin-helpers.js`
- `src/supabase.js`
- `admin.html`
- `scripts/e2e/seed.mjs`
- `scripts/e2e/verify-completion.mjs`
- `e2e/portal-admin.smoke.spec.mjs`
- `test/tournament-completion.test.js`
- `test/disposable-e2e.test.js`
- `.github/workflows/disposable-e2e.yml`

## Checkout and verification

```sh
git fetch origin
git checkout feat/atomic-tournament-completion
npm ci
node --test test/tournament-completion.test.js test/disposable-e2e.test.js
npm test
```

Validate workflows with the reviewed `actionlint` 1.7.12 binary and run:

```sh
actionlint .github/workflows/disposable-e2e.yml .github/workflows/production.yml
git diff --check
npm audit --audit-level=high
```

The full database/browser path requires Docker through GitHub Actions because the development computer has no local Docker runtime. Push the branch, open its separate PR, and require the `Disposable authenticated browser smoke` workflow to pass for the exact final commit.

## Disposable E2E environment variables

These are generated from the isolated local Supabase stack at workflow runtime and are never protected production secrets:

- `E2E_SUPABASE_URL`
- `E2E_SUPABASE_PUBLISHABLE_KEY`
- `E2E_SERVICE_ROLE_KEY`
- `E2E_USER_EMAIL`
- `E2E_USER_PASSWORD`
- `E2E_WORKDIR`

The workflow fails unless the Supabase URL is loopback HTTP on port 54321. It separately prohibits the production project identifier, protected environments, and `${{ secrets.* }}`.

## Deployment behavior

After approval and squash merge, the protected production workflow must:

1. Pass the repository test suite.
2. Verify migration history.
3. Run a dry-run.
4. Apply migration 037.
5. Verify exact migration history.
6. Build and deploy GitHub Pages.

Do not claim the completion workflow is live until the exact merge-SHA production run passes its migration push/history checks and the deployed Admin assets are read back.

## Remaining gates

- Independent security/concurrency review of the final diff.
- Local full suite, Actionlint, audit, diff check, syntax checks, and added-line security scan.
- Real disposable Supabase migration execution, authenticated Chromium completion, exact database readback, rollback/immutability checks, and cleanup in GitHub Actions.
- Final PR state, head SHA, and clean mergeability readback.
- User approval before merge.

## Known limitation

No production completion action is exercised by automated testing. Production authenticated smoke testing after deployment must remain read-only unless the user separately authorizes completing a real tournament.
