# Homepage, itinerary, and compact roster handoff

## Scope

This branch implements three approved Hereford Cup updates:

1. The public homepage standings show only the Blue and White point totals. The “First to … points” target is removed; no recorded scores or historical results are changed.
2. The signed-in player itinerary heading uses the tournament start and end dates. The 2027 trip renders as `March 18–21, 2027 itinerary`.
3. The administrator Active members roster is capped at 520 px with internal scrolling for a 16+ player roster. Each active member has a compact Blue / White / Unassigned team assignment control alongside the existing handicap and membership actions.

## Database change

Migration `040_march_2027_itinerary.sql` refreshes the shared March 2027
event records. Both views use Eastern time and show tee-time windows, an
approximate shuttle time, and a TBD Tobacco Road tee time. The public RPC
exposes dedicated public details, not member notes. The refresh does not
change match plans or results or send schedule-change emails.

`supabase/migrations/034_tournament_member_team_assignment.sql` adds `set_tournament_member_team(uuid, uuid, text)`.

The RPC:

- accepts only persisted `cardinal` / `silver` values or `null` while the UI says Blue / White / Unassigned;
- accepts only setup, open, or live tournaments and active target memberships;
- authorizes global or exact-tournament administrators;
- uses the tournament advisory lock and row locks before authorization/mutation;
- updates only `team` and `updated_at`;
- leaves direct membership mutations revoked.

Production deployment must keep the existing workflow order: tests, migration checks and migration 034, then frontend build/Pages deployment. Do not deploy the frontend team control if migration 034 fails.

## Verification completed

- `npm test`: 267/267 passed.
- `node C:/Users/pimen/AppData/Local/hermes/cache/scratch/hereford-migration-034.mjs`: passed, including idempotence, assignment/unassignment, invalid/pending/completed rejection, field preservation, and revoked-admin rejection.
- `git diff --check`: passed.
- Local browser verification:
  - homepage has two equal standings columns, no target element/text, and no horizontal overflow;
  - a simulated 20-player Active members roster has a 520 px client height, 3128 px scroll height, and `overflow-y: auto`;
  - compact team controls are readable with no overlap.
- Final independent fail-closed review passed with no security concerns, logic errors, or suggestions.

## Hermes continuation

```bash
git fetch origin
git checkout fix/home-scoreboard-points-only
npm test
node C:/Users/pimen/AppData/Local/hermes/cache/scratch/hereford-migration-034.mjs
git diff --check
```

After approval and merge, watch the exact production workflow. Confirm migration 034 succeeded before claiming the team selector is live. Then verify the deployed homepage, authenticated portal itinerary heading, and authenticated administrator roster/team save/readback in Chrome.
