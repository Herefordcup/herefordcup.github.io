# Authoritative result audit and Legacy workspace handoff

## Scope

- Add an append-only administrator-visible history for authoritative match-segment results.
- Record an honest baseline for results that were already final when migration `039` is applied.
- Record future automatic/player-driven finalization, administrator-entered Foursomes finalization, and post-final score-correction recalculation.
- Carry the required score-correction reason into the corresponding result-recalculation entry.
- Present the selected match's current result and change history side by side on desktop and stacked on tablet/phone.
- Replace the long two-column Legacy editor with three horizontal, keyboard-accessible tabs: Edition details, Scores & results, and Photos.
- Bound saved result/photo lists so large archives do not lengthen the entire administrator page.

## Data design

Migration: `supabase/migrations/039_match_result_audit.sql`

`public.match_result_audit` stores:

- exact match and segment scope, protected by a composite foreign key;
- action (`baseline`, `finalized`, or `recalculated`);
- before/after status, differential, and holes played;
- reason, actor, and timestamp.

The table has RLS. Only a global administrator or an active administrator of the exact tournament can select rows. Browser roles receive `SELECT` only; inserts, updates, and deletes are revoked. A `SECURITY DEFINER` trigger appends rows from authoritative `match_segments` updates. An internal trigger carries the audited score-correction reason and affected hole through the same transaction.

Historical final segments receive a clearly labeled baseline snapshot. It does not claim to identify the original actor or finalization time.

## Browser behavior

- `src/supabase.js` loads result audits with the actor display name and exposes a match-scoped refresh helper.
- `src/admin.js` renders all stored text with text nodes/`textContent` and refreshes the selected match history after finalization or correction.
- `admin.html` and `admin.css` implement the responsive result workspace and Legacy tabs.
- Shared Supabase-module cache keys and every parent entrypoint are advanced to `result-audit-layout-1`.

## Verification

Local commands:

```text
npm test
npm audit --audit-level=high
node --check e2e/four-admin-scenarios.spec.mjs
node --check scripts/e2e/verify-scenario-matrix.mjs
git diff --check
```

Disposable QA must run the label-gated four-player scenario matrix. The matrix now verifies:

- visible automatic-finalization and correction history in Admin;
- exact automatic and administrator finalization reasons;
- exact audited correction reason and administrator identity;
- one affected-segment recalculation entry;
- Foursomes/manual result history;
- Legacy tab interaction;
- existing scores, results, points, standings, commentary, tournament completion, Past Trips, and teardown guarantees.

Responsive visual checks were performed at 390, 820, and 1264 CSS pixels. The 390px checks assert `body.scrollWidth === innerWidth`; all three Legacy tabs remain visible, and the result/history layout stacks without clipping.

## Continuation

```text
git fetch origin
git checkout feat/result-audit-legacy-layout
npm ci
npm test
```

Before production:

1. Require a green disposable four-player matrix on the final commit.
2. Require independent review of migration authorization, trigger behavior, immutable audit grants, and correction reason propagation.
3. Merge only after approval.
4. Watch the exact merge-SHA production workflow through migration `039` and Pages deployment.
5. Verify the live Admin HTML/CSS/module cache tokens and a clean browser console.
6. Exercise an authenticated selected-match history read in production. Do not create or correct a production score only for smoke testing.

## Known limits

- Result history begins with migration `039`. Older final results receive a baseline snapshot, not fabricated event history.
- Foursomes still uses the explicit administrator result fallback until a shared team-score entry model exists.
- The result log is intentionally administrator-only and is not displayed in the public or player views.
