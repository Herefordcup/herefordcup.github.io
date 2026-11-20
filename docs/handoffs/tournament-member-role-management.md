# Tournament member role management handoff

## Scope

This branch adds tournament-specific Player/Admin management to the existing Active Members roster on `admin.html`.

- Administrators select `Player` or `Admin` from an inline Tournament role dropdown.
- A change saves immediately through a narrow Supabase RPC.
- The browser restores the previous value when the RPC fails.
- Self-demotion and global-administrator demotion are disabled in the UI and rejected by the database.
- The database also rejects demotion of the last active tournament administrator.
- Existing `captain` memberships remain visible and are not silently rewritten; the save RPC accepts only `player` or `admin` as a requested role.
- Roles remain scoped to one tournament membership, so future editions can use different administrators.

## Architecture

Frontend:

- `src/admin.js` renders and auto-saves the Tournament role selector.
- `src/supabase.js` exposes `setTournamentMemberRole()`.
- All entrypoints reaching the changed shared Supabase module use the new `member-role-1` cache token.

Database:

- `supabase/migrations/035_tournament_member_role_assignment.sql` adds `public.set_tournament_member_role(uuid, uuid, text)`.
- The RPC takes the tournament-scoped advisory transaction lock before row locks.
- It locks the current tournament, exact active membership, and target profile before authorization.
- It authorizes only a global administrator or active administrator of that exact tournament.
- It updates only `role` and `updated_at` and returns the authoritative membership row.
- Direct membership-table mutations remain revoked by earlier migrations.

## Verification completed

- Targeted test was observed failing before implementation and passing afterward.
- `npm test`: 271/271 passing.
- Overlapping roster mutations are blocked by a tested mutation gate that keeps the entire membership section inert until the active save settles.
- `git diff --check`: passing.
- Static added-line scan: no hardcoded secrets, dangerous eval/exec, shell injection, or unsafe deserialization.
- Migration 035 executed twice in an isolated PGlite database.
- Runtime checks covered promotion, demotion, idempotence, preservation of status/team, invalid role, pending member, completed tournament, unauthorized caller, self-demotion, global-admin demotion, and last-admin demotion.
- Local browser QA showed the Role, Team, and Handicap controls aligned in the bounded Active Members roster without horizontal clipping; browser console remained clean.

## Release sequence

Production deployment is migration-first and automated on protected `main`:

1. GitHub Actions runs the complete Node test suite.
2. It validates remote migration history is a contiguous prefix.
3. It runs the pinned Supabase CLI dry run.
4. It applies migration 035 and verifies exact local/remote migration equality.
5. Only then does it build and deploy GitHub Pages.

A database failure blocks the frontend deployment.

## Continue from another Hermes installation

```text
git fetch origin
git checkout feat/admin-member-role-control
npm test
git diff --check
```

Before merge, confirm the PR head SHA and checks. After merge, watch the exact production workflow for the merge SHA. Verify migration `035` appears in production history before checking the deployed assets. Then verify live `admin.html` references `src/admin.js?v=member-role-1`, the entry module references `supabase.js?v=member-role-1`, and an authenticated administrator can promote and demote a controlled non-self member with database readback.

Do not test by demoting the current administrator or the last active administrator. Do not alter `profiles.role`; this feature manages only `tournament_memberships.role`.

## Not yet production-tested

Until the PR is merged, migration 035 and the browser controls are not live. The authenticated production save/readback remains a post-deployment smoke test.
