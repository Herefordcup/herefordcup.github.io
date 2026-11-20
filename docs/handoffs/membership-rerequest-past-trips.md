# Membership re-request and Past Trips handoff

Updated: 2026-11-19

This handoff contains no credentials, tokens, private account identities, or secret values.

## Scope

Branch: `fix/membership-rerequest-and-legacy-uniformity`
Repository: `https://github.com/Herefordcup/herefordcup.github.io`
Base: protected `main`

This release:

- Deletes stale tournament-scoped membership approval jobs, their cascading deliveries, and membership-status audit rows when an active member is removed or a pending request is denied.
- Preserves the Auth identity, profile, notification preferences, and memberships in other tournaments.
- Requires the same login to create a new `pending` membership after removal, so administrator approval is required again.
- Removes the stale stable approval-notification key so the repeated request queues a fresh administrator notification.
- Prevents the general member-deletion RPC from deleting pending requests; pending requests remain restricted to the race-safe deny RPC.
- Applies the same structured scorecard presentation to completed Past Trips, with an explicit empty `Results not recorded` card when no structured rows exist.
- Normalizes 2024 Innisbrook and 2025 PGA Frisco participant presentation while preserving scores and private source/audit metadata.
- Converts standalone unknown participants to `TBD`, removes trailing uncertainty marks from recorded Frisco names, and preserves embedded punctuation.

## Forward migrations

- `030_membership_rerequest_cleanup.sql`
  - Removes orphaned approval jobs.
  - Requeues already-suppressed pending requests when the old job predates the recreated membership.
  - Replaces delete/deny RPCs with tournament-scoped stale-data cleanup and strict active/pending status checks.
- `031_frisco_public_name_cleanup.sql`
  - Updates only the 2025 edition's public participant fields.
  - Preserves labels, points, source notes, confidence, editor attribution, and unrelated editions.

Production currently has migrations through `029`. Migrations `030` and `031` are pending until this branch is merged to `main`; the migration-first production workflow must apply both before Pages deploys.

## Verification completed

- `npm test`: 251/251 passing.
- `git diff --check`: passing.
- Independent fail-closed security/logic review: passed with no blockers.
- PostgreSQL 18.6-compatible PGlite upgrade/rerun fixture: passed.
  - Executed migrations 030 and 031 twice.
  - Verified orphan cleanup and notification-delivery cascade.
  - Verified preference/profile preservation and unrelated-tournament isolation.
  - Verified active delete → fresh pending request → reusable approval key → fresh job.
  - Verified general deletion rejects pending and denial rejects active.
  - Verified Frisco `?`, `(?)`, `Lukas?`, `John Jr.?`, mixed unknown/known names, embedded punctuation, metadata preservation, and unrelated-edition preservation.

## Release and production verification

1. Push this branch and open a pull request into protected `main`.
2. Confirm PR checks pass for the exact head SHA.
3. Squash-merge only after checks pass.
4. Confirm the production workflow validates history `001`–`029`, applies `030` and `031`, verifies exact history `001`–`031`, then deploys Pages.
5. Read back production migration history.
6. Verify live Past Trips for all completed editions, including Frisco names, `TBD` placeholders, Kiawah's 40 rows and Blue 18 / White 23 totals, and a clean browser console.
7. Use a controlled authenticated account for the full production membership state machine before declaring it proven live: active member deletion → membership absent → same login revisits → fresh pending membership → fresh administrator notification → explicit approval → active access. Do not delete an actual member merely for testing.

## Hermes continuation

```sh
git fetch origin
git checkout fix/membership-rerequest-and-legacy-uniformity
npm test
git diff --check
gh pr checks
```

Do not modify already-applied migrations. Do not expose the protected production Supabase token. The production workflow is the only intended migration/deployment path after merge.
