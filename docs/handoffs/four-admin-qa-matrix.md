# Four-player disposable end-to-end scoring matrix

## Scope

This QA harness exercises the supported Hereford Cup scoring and completion paths with four synthetic players in a loopback-only Supabase stack. All four hold tournament `player` memberships; the first also has a disposable global-administrator profile solely to run finalization, correction, and completion controls. It never uses production identities, production credentials, the production project reference, or the real trip tournament.

## Safety boundary

- Workflow: `.github/workflows/qa-scenario-matrix.yml`
- Trigger: explicit `workflow_dispatch`, or a pull request carrying the `run-qa-matrix` opt-in label
- Supabase URL: exactly `http://127.0.0.1:54321`
- Accounts: `qa-player-1@local.test` through `qa-player-4@local.test`
- No protected GitHub environment and no repository secrets
- Runtime password is generated and masked
- Fixture IDs remain in a runner-temporary file and are not uploaded
- Screenshots, traces, and video are disabled
- `supabase stop --no-backup` runs under `if: always()`
- A final status probe fails if the disposable stack remains running

## Matrix

- S1: Singles gross, Blue 1 Up
- S2: Singles net, White 2 & 1
- F1: Four-Ball gross, halved
- F2: Four-Ball net, White 3 & 2 from a three-stroke handicap differential with identical gross scores
- M1: front-nine Four-Ball plus back-nine Foursomes manual fallback
- R1: incomplete-score rejection with rollback proof
- R2: mismatched stroke-index rejection with rollback proof
- R3: no-team lineup rejection with rollback proof
- C1: audited correction by a different administrator
- A1: all four tournament players authenticate, open their assigned scorecards, enter every supported individual score through the real portal, save, and read back 18 locked holes
- A2: ordinary players have no Admin link; the disposable controller exercises self-demotion and last-administrator protections
- X1: simultaneous finalization calls serialize to one final state
- X2: simultaneous completion calls produce one archive
- T1: premature completion rejection
- T2: authoritative completion and exact totals
- T3: idempotent completion replay
- T4: generated Past Trips mutation rejection
- T5: exact Round headings, format labels, and points

Foursomes remains an explicit administrator-entered match-play result because the player scorecard does not yet support one score per side. The player E2E confirms that mixed Foursomes score entry fails closed with the team-score message, then tests the supported administrator fallback. For every finalized segment, the verifier reads back the differential, holes played, point value, and exact Blue/White allocation; it also reconciles the complete tournament to Blue 3.5 and White 3.5, including a Four-Ball net result created solely by a verified three-stroke handicap differential. The matrix does not claim automatic Foursomes derivation.

## Execution order

1. Copy the project to runner-temporary storage and adapt only the disposable migration copy.
2. Start local Supabase and rebuild all migrations.
3. Generate local credentials and seed deterministic fixtures.
4. Run pre-completion Playwright scenarios through the real portal/Admin controls.
5. Run exact REST/RPC readback, rollback, protection, and concurrency probes.
6. Run post-completion Admin replay and public Past Trips rendering checks.
7. Destroy the stack and prove it is stopped.

## Commands

Local source and contract checks:

    node --test test/qa-scenario-matrix.test.js test/disposable-e2e.test.js test/tournament-completion.test.js
    npm test
    npm audit --audit-level=high
    node --check scripts/e2e/seed-scenario-matrix.mjs
    node --check scripts/e2e/verify-scenario-matrix.mjs
    node --check e2e/four-admin-scenarios.spec.mjs
    node --check playwright.matrix.config.mjs
    actionlint .github/workflows/qa-scenario-matrix.yml
    git diff --check

Manual GitHub Actions run:

    gh workflow run qa-scenario-matrix.yml --ref <branch>
    gh run watch <run-id> --exit-status

## Environment variables

Values are generated or read only from local Supabase runtime output:

- `E2E_WORKDIR`
- `E2E_SUPABASE_URL`
- `E2E_SUPABASE_PUBLISHABLE_KEY`
- `E2E_SERVICE_ROLE_KEY`
- `E2E_USER_PASSWORD`
- `E2E_WEB_PORT`
- `E2E_FIXTURE_FILE`

No value belongs in source control, artifacts, logs, or this document.

## Production test-round cleanup

The disposable matrix does not delete production rows and does not introduce a production reset bypass. The three historical Matt/Jose test rounds require a separate read-only inventory, exact match/round ID manifest, disposable proof of the finalized-row cleanup path, explicit manifest confirmation, and post-deletion readback. Auth identities, profiles, tournament memberships, notification preferences, real matches, and generated Past Trips data remain outside that cleanup boundary.

## Current handoff state

Branch: `test/four-admin-qa-matrix`

Local verification before the first push:

- Focused contracts: 14/14 passed
- Full repository suite: 294/294 passed
- npm audit: 0 vulnerabilities
- Actionlint, JavaScript syntax checks, and `git diff --check`: passed

The full local Supabase/browser matrix requires GitHub Actions because Docker/Supabase is unavailable on the Windows host. Do not mark the matrix complete until the manual workflow passes for the exact PR head and the cleanup step is verified.
