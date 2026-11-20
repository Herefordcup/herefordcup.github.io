# Production readiness maintenance handoff

## Scope

This maintenance change addresses deployment warnings, credential readiness, and roster-filter accessibility without changing tournament data or database schema.

### Deployment maintenance

- Updates `actions/checkout` to the reviewed Node.js 24 release commit for v7.0.1.
- Updates `supabase/setup-cli` to the reviewed v3.2.0 release commit, whose composite action provisions current Node/Bun dependencies.
- Adds a non-mutating `supabase functions list` preflight before any production migration preview or application. A missing Edge Function read scope now fails before database changes.
- Keeps migration prefix validation, dry-run, migration application, exact-history verification, Edge Function deployment, Pages build, and Pages deployment fail-closed and in their existing order.

### Credential readiness

- Protected environment variable: `SUPABASE_ACCESS_TOKEN_EXPIRES_ON`.
- Recorded current value: `2026-11-27`.
- GitHub issue: `#48`, assigned to `pimentelaj`.
- `.github/workflows/deployment-readiness.yml` runs daily at 13:00 UTC and on manual dispatch.
- It performs only non-mutating checks: token lifetime, migration read access, and Edge Function read access.
- When action is needed, it opens or reopens one exact deployment-readiness issue rather than intentionally failing and generating another generic workflow-failure email.
- When the expiry is more than 30 days away and both read checks pass, it comments on and closes that issue.

The readiness check cannot prove Edge Function write scope without performing a deployment. The protected production workflow remains the authoritative fail-closed write check.

### Roster accessibility and browser regression coverage

- Filter visibility is implemented through a tested helper that preserves the existing card and unsaved handicap input node.
- If a successful team change makes the currently focused card disappear under the active filter, focus waits until every overlapping roster mutation has settled and the membership panel is no longer inert, then moves to the member-search field without scrolling the page.
- A real headless Chrome regression test loads the production CSS and helper module with 18 fixture cards at desktop and phone breakpoints. It verifies column count, bounded scrolling, absence of horizontal overflow, and that focus moves only after the final inert gate releases.

## Token rotation procedure

Before November 27, 2026:

1. Create a replacement project-scoped token for project `mqulycovrogurvmjcimt` with the longest practical lifetime (prefer about one year).
2. Retain only the required permissions: Database read/write, Migrations read/write, Edge Functions read/write, Connection Pooling read, Production Branches read, and Projects read.
3. Update GitHub environment secret `production / SUPABASE_ACCESS_TOKEN` without exposing its value.
4. Update GitHub environment variable `production / SUPABASE_ACCESS_TOKEN_EXPIRES_ON` to the replacement token's `YYYY-MM-DD` expiration date.
5. Run the Deployment credential readiness workflow manually and verify issue #48 closes.

Never place the token value in chat, issues, logs, screenshots, repository files, or handoff documents.

## Verification

```text
npm test
node --test test/deployment-workflow.test.js test/admin-planning.test.js test/member-approval.test.js test/active-member-roster-browser.test.js
git diff --check
```

No migration or Edge Function source change is included.

## Hermes continuation

```text
cd C:\Users\pimen\hereford-cup
git fetch origin
git checkout chore/production-readiness
npm test
git diff origin/main...HEAD
```

After merge, verify the production run for the exact merge SHA. The scheduled readiness workflow may leave issue #48 open until the token is rotated because the currently recorded expiration is within 30 days.
