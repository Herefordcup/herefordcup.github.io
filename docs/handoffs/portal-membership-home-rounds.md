# Portal membership, Home link, and historical Round headings

## Scope

This branch completes the returning-member lifecycle hardening and related public display corrections:

- Monitors a signed-in player's exact displayed tournament membership.
- Recreates a fresh pending request when an administrator deletes active access.
- Never recreates an administrator-denied pending request automatically.
- Reloads stale tabs after approval, tournament completion, or active-tournament priority changes.
- Refreshes the administrator membership roster without overwriting dirty handicap edits or racing membership mutations.
- Adds a signed-in `Home` link before the conditional `Admin`, player name, and `Sign out` controls.
- Clarifies that email verification happens before administrator membership approval.
- Corrects historical participant spelling from `Pimental` to `Pimentel` without changing labels, scores, notes, confidence, attribution, or other metadata.
- Displays every numbered Past Trips group as `Round N`; standalone events retain their recorded names.

## Database migrations

- `032_legacy_pimentel_name_correction.sql`
  - Changes only `legacy_results.cardinal_entry` and `legacy_results.silver_entry`.
  - Idempotent and metadata-preserving.
- `033_targeted_membership_rerequest.sql`
  - Adds the authenticated `request_tournament_membership(uuid)` overload.
  - Accepts only an exact tournament in `setup`, `open`, or `live` status.
  - Creates only a fresh pending player membership and remains idempotent.

Production remains at migrations `001`-`031` until this PR is merged and the protected production workflow applies `032` and `033` before deploying Pages.

## Verification completed

- `npm test`: 264/264 passing.
- `git diff --check`: passing.
- PGlite migration 032 fixture: passed twice with participant-only correction and metadata preservation.
- PGlite migration 033 fixture: passed twice; exact-target insertion, rerun idempotence, and completed-tournament rejection verified.
- Local browser with production public data: 2024-2026 numbered historical headings all render as `Round`; no `Match N` headings remain.
- Signed-in header simulation: `Home`, `Admin`, player name, and `Sign out` align in the requested top-right order.
- Independent fail-closed review: passed with no security concerns, logic errors, or suggestions.

## Continue from another work computer

```bash
git fetch origin
git checkout fix/returning-member-request-visibility
git pull --ff-only origin fix/returning-member-request-visibility
npm install
npm test
```

Review the PR and its checks. Do not apply migrations manually or merge browser code separately: the protected production workflow must run migrations first and deploy Pages only after migration verification succeeds.

After merge, verify:

1. The production workflow succeeds for the exact merge SHA.
2. Production migration history is exactly `001`-`033`.
3. `portal.html` shows `Home` for every signed-in player and `Admin` only for administrators.
4. A controlled delete → portal revisit creates one fresh pending request and a new administrator notification.
5. Denying a pending request does not cause polling to recreate it.
6. Past Trips shows `Round N` headings for every numbered historical group.
7. Historical participant entries show `Pimentel`, while labels and private metadata remain unchanged.

## Not included

Automatic generation of a future Past Trips edition when a tournament is completed is not implemented in this PR. Future generated historical headings must use `Round`, not `Match`.
