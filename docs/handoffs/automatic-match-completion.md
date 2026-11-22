# Automatic match completion handoff

## Scope

This change removes the ordinary administrator Finalize step for score-derived Singles and Four-Ball matches. After an assigned player saves scores, the portal calls a server-authoritative readiness RPC. The match completes only after every assigned player has one valid round and every required hole score exists.

Foursomes remains on the clearly labeled `Record Foursomes result` administrator fallback because the player scorecard does not yet support one alternate-shot score per side.

## Architecture

- `supabase/migrations/038_automatic_match_completion.sql`
  - adds authenticated `complete_match_if_ready(uuid)`;
  - preserves the locked scoring calculation in `finalize_match_results`;
  - makes concurrent completion idempotent;
  - allows only an assigned active player to request automatic completion;
  - keeps unsupported/team-score formats waiting;
  - permits an administrator to replace, but not delete, a finalized score through the audited correction RPC;
  - recalculates finalized segments atomically after that correction;
  - permits an assigned player to create only the initial recap while regeneration remains administrator-only.
- `src/portal.js` calls readiness after a successful score save and requests the initial recap only when commentary is enabled and the match is eligible.
- `src/admin.js` hides the result-submit action for score-derived matches, keeps the Foursomes fallback, exposes finalized matches for correction, and regenerates enabled commentary after a finalized-score correction.
- `supabase/functions/generate-match-commentary/index.ts` admits an assigned participant for initial generation only. Existing deterministic scoring facts and the server-owned phrase allowlist remain authoritative.

## Verification

Local gates:

```text
npm test
npm audit --audit-level=high
npx --yes deno check supabase/functions/generate-match-commentary/index.ts
git diff --check
```

The disposable four-player matrix must pass on the exact PR head. It covers browser-authenticated score entry, automatic completion, gross/net/handicap results, incomplete and invalid scorecards, concurrent completion, post-completion correction, deletion rejection, Foursomes fallback, points, tournament completion, replay, commentary storage, and Past Trips.

## Branch and PR sequence

This feature branch is stacked on `test/four-player-full-e2e` / PR #55 so the expanded four-player matrix is available. Create the feature PR with that branch as its base until PR #55 merges; then retarget or update it to `main` and rerun every check.

## Deployment

On merge to `main`, the protected production workflow must apply migration `038`, verify exact migration history, deploy the changed commentary Edge Function, and only then publish GitHub Pages. A failure in migration or function deployment must block the frontend deployment.

## Known limitation

Foursomes cannot auto-complete from player score entry until the portal supports a real team-score scorecard. Do not infer Foursomes from individual gross totals.

No production tournament/member/score data is used by the disposable matrix. The three historical Matt/Jose test rounds are a separate manifest-gated cleanup task and are untouched by this change.
