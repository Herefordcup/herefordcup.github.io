# Texas Scramble and Shared Team Scoring Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a complete 16-player Texas Scramble workflow with shared squad scorecards, required-tee-shot tracking, official WHS team-handicap allowances, net-to-par Cup points, and an optional match-play entry mode where players record the winner of each hole instead of individual scores.

**Architecture:** Keep the current individual score path as the default for Singles and Four-Ball. Add explicit server-authoritative team-scoring models rather than forcing team scores into individual `rounds`/`scores`. A Texas Scramble session contains multiple independent squads assigned to Blue or White; each squad owns one shared scorecard and earns Cup points from its final net score relative to par. Match-play segments may independently choose either the current individual-score mode or a shared hole-outcome mode.

**Tech Stack:** Static HTML/CSS/ES modules, Supabase/PostgreSQL with RLS and `SECURITY DEFINER` RPCs, Node test runner, Playwright, disposable local Supabase.

---

## Confirmed initial rules

- Plan initially for 16 players.
- Blue and White each have two independent four-player Texas Scramble squads.
- The schema must also support two-player squads later without forcing the 2027 roster size now.
- Each squad keeps one shared team scorecard.
- Any active member of the squad may enter an unsubmitted hole; every squad member may view the shared entries.
- Submitted team holes lock immediately. Corrections require an administrator, a reason, and an audit entry.
- The administrator chooses the minimum selected tee shots required from each player for each Texas Scramble session/segment.
- The server prevents completion until every required team score is present and every squad member meets the selected-tee-shot requirement.
- Team handicap uses the official WHS scramble allowances:
  - four-player squad: 25% / 20% / 15% / 10% of Course Handicap, ordered lowest to highest;
  - two-player squad: 35% low / 15% high.
- The administrator configures the matchup, squads, format, scoring method, holes, points, and tee-shot requirement. Course and tee may be left open for Play.
- When an assigned player opens Play, the site automatically selects their next match. If course/tee were not prefilled by the administrator, the first authorized player selects one shared course and tee for the session; the server validates and locks that choice for every squad. Other players see the same selection without repeating setup.
- All players in the initial version use that shared course and tee, so squad handicaps are calculated from authoritative Handicap Indexes and the same rating/slope/par data.
- Squad net score is team gross total minus rounded team playing handicap.
- Each stroke under net par earns that squad's Cup side one point. Even par or worse earns zero. There is no cap unless the organizer later adds one.
- For ordinary match-play segments, the administrator may choose `Full player scores` or `Hole winner entry`.
- Hole winner entry presents Blue, Halved, and White for each configured hole. It does not fabricate individual gross scores or player statistics.

## Current behavior and UX gap

- The Play screen in the supplied screenshot is showing `Standalone gross scorecard` because no active assigned match is selected or available for that player.
- Assigned non-final matches are currently added to the `Assigned match` dropdown and the player's Home preview shows the configured segment format and hole range.
- The database schema recognizes a generic `scramble` value, but the administrator planner intentionally offers only Singles, Four-Ball, and Foursomes.
- `src/formats.js` explicitly blocks Scramble, Foursomes, and Chapman from individual score entry because no shared team scorecard exists.
- Therefore the site does not currently support Texas Scramble end to end and must not expose the format until the shared scoring path below is complete.

---

### Task 1: Define pure Texas Scramble calculations

**Objective:** Create deterministic, independently testable squad handicap, net-to-par, Cup-point, tee-shot, and hole-outcome calculations.

**Files:**
- Create: `src/team-scoring.js`
- Create: `test/team-scoring.test.js`
- Modify: `src/formats.js`

**Step 1: Write failing tests**

Cover:

- four-player WHS weighting in lowest-to-highest Course Handicap order;
- two-player 35%/15% weighting;
- rounding the combined playing handicap only after the weighted sum;
- plus/negative Course Handicaps;
- team gross minus team playing handicap;
- `max(0, par - netScore)` Cup points;
- no points at even par or over par;
- required tee-shot counts by player ID;
- fail-closed validation when any player is below the configured minimum;
- Blue/White/halved hole-outcome accumulation;
- mathematical match-play completion and result labels;
- no individual statistics generated from hole-outcome mode.

**Step 2: Verify RED**

Run: `node --test test/team-scoring.test.js`

Expected: FAIL because `src/team-scoring.js` does not exist.

**Step 3: Implement minimal pure functions**

Export focused helpers such as:

- `scramblePlayingHandicap(courseHandicaps)`;
- `scrambleNetScore({ grossTotal, playingHandicap })`;
- `scrambleCupPoints({ netScore, par })`;
- `teeShotContributionCounts(entries, playerIds)`;
- `validateRequiredTeeShots({ entries, playerIds, minimum })`;
- `summarizeHoleOutcomes(entries)`.

**Step 4: Verify GREEN**

Run: `node --test test/team-scoring.test.js`

Expected: all team-scoring tests pass.

---

### Task 2: Add forward-only team scoring schema

**Objective:** Persist Texas Scramble sessions, squads, squad membership, shared hole scores, selected tee-shot attribution, results, and match-play hole outcomes with fail-closed authorization.

**Files:**
- Create: `supabase/migrations/040_team_scoring_modes.sql`
- Create or extend: `test/team-scoring-migration.test.js`

**Step 1: Write failing source and integration contracts**

Require:

- `team_scoring_mode` constrained to `individual_scores`, `team_scores`, or `hole_outcomes` where appropriate;
- Texas Scramble session linked to exact tournament, match, course, tee, holes, and par;
- squads linked to one session and one persisted Cup side;
- squad size constrained to exactly 2 or 4 at activation/finalization;
- no player assigned to two squads in the same session;
- squad player identity validated against an active tournament membership on the same Cup side;
- required tee shots nonnegative and mathematically possible for squad size/hole count;
- one shared hole row per squad/hole;
- one selected tee-shot player per scored hole, and that player must belong to the exact squad;
- one hole-outcome row per segment/hole;
- append-only correction audit for score changes, tee-shot attribution changes, and outcome changes;
- ordinary players cannot directly update/delete submitted rows;
- browser roles cannot bypass RPC validation with direct table writes;
- active squad members can read their squad's shared entries;
- tournament/global administrators can read the exact tournament scope;
- public users cannot read private in-progress scorecards.

**Step 2: Verify RED**

Run the focused migration/source-contract test and confirm it fails because migration `040` is absent.

**Step 3: Implement migration**

Add new relations rather than overloading individual `rounds` and `scores`, for example:

- `team_scoring_sessions`;
- `team_scoring_squads`;
- `team_scoring_squad_players`;
- `team_hole_scores`;
- `match_hole_outcomes`;
- `team_score_correction_audit`.

Use composite foreign keys where paired identifiers must agree. Revoke direct browser insert/update/delete privileges when an RPC owns cross-row invariants.

**Step 4: Add narrow RPCs**

Implement server-authoritative functions for:

- saving an unsubmitted squad hole and selected tee-shot player;
- saving an unsubmitted match-play hole outcome;
- automatic completion under locks;
- administrator correction with a required reason;
- readback of the exact authoritative saved row.

Lock root-to-leaf in a consistent order: session/match → squad/segment → membership/assignment → hole row → result/audit.

**Step 5: Verify GREEN in disposable PostgreSQL**

Execute migration `040` on both a fresh disposable database and an upgrade from migration `039`. Apply it twice where safe and verify constraints, grants, policies, functions, and exact row behavior.

---

### Task 3: Extend administrator planning for Texas Scramble

**Objective:** Let administrators configure the 16-player session without exposing an unusable format.

**Files:**
- Modify: `admin.html`
- Modify: `admin.css`
- Modify: `src/admin.js`
- Modify: `src/supabase.js`
- Modify: `test/admin-planning.test.js`

**Step 1: Write failing behavior tests**

Cover:

- Texas Scramble appears only after the backing migration/client path exists;
- selecting Texas Scramble switches the editor from ordinary Blue-vs-White segment assignments to squad planning;
- initial 16-player preset creates Blue A, Blue B, White A, and White B with four slots each;
- each slot shows player name and Blue/White membership;
- inactive, pending, unassigned, or wrong-side players cannot be submitted;
- a player cannot appear in two squads;
- administrator may preselect course/tee, but may leave them open for the assigned players; administrator still sets holes and minimum tee shots per player;
- minimum requirement cannot exceed available holes;
- all fields are explicitly persisted through one atomic planning RPC;
- two-player squads remain supported but are not forced into the initial 16-player preset.

**Step 2: Verify RED**

Run the focused administrator planning tests and confirm expected failures.

**Step 3: Implement the planner**

Add a clear `Texas Scramble` format and a squad workspace. Display the calculated WHS allowance formula next to each squad, but calculate final Course Handicaps and team playing handicap on the server from authoritative values.

**Step 4: Verify GREEN and browser behavior**

Run focused tests and inspect desktop, tablet, and phone layouts. Ensure 16-player squad controls are bounded and do not recreate a long unmanageable page.

---

### Task 4: Make assignments obvious on Home and Play

**Objective:** Ensure players know what they are playing before opening a scorecard.

**Files:**
- Modify: `portal.html`
- Modify: `portal.css`
- Modify: `src/portal.js`
- Modify: `src/member.js`
- Modify: `test/member-portal.test.js`

**Step 1: Write failing behavior tests**

Require the player Home preview and Play screen to show:

- session/match name and scheduled time;
- `Texas Scramble` or the selected match-play format;
- squad name and Cup side;
- squad partners;
- course and tee;
- assigned holes;
- `Net stroke play` and the WHS squad allowance;
- required selected tee shots per player;
- current contribution progress such as `2 of 3 tee shots used`;
- whether entry is `Shared team scorecard` or `Hole winner entry`.
- only the two remaining setup choices when not already fixed: course and tee.

Also require the next playable assignment to be selected prominently instead of leaving a player on `Standalone gross scorecard` without explanation. Standalone play must remain available as an explicit choice.

**Step 2: Verify RED**

Run the focused member portal tests.

**Step 3: Implement assignment-first UX**

On Play:

- add an `Your assigned format` summary above the controls;
- auto-select the next eligible assignment when there is exactly one clear upcoming assignment;
- keep the dropdown for switching assignments or choosing standalone play;
- hide unrelated setup controls after an assignment is selected; show course and tee only when the session has not locked them yet;
- let the first authorized player save the shared course/tee atomically, then consume the server readback and lock those controls for every other player;
- replace the individual-format cards with squad-specific information for Texas Scramble;
- show a clear empty state when the player has no assignment: `No scheduled assignment yet — standalone scorecard selected.`

**Step 4: Verify GREEN and accessibility**

Test keyboard use, screen-reader labels, no horizontal overflow, and mobile scrolling.

---

### Task 5: Build the shared Texas Scramble scorecard

**Objective:** Allow any squad member to enter the team's hole score and selected tee-shot player while every squad member sees the same locked data.

**Files:**
- Modify: `portal.html`
- Modify: `portal.css`
- Modify: `src/portal.js`
- Modify: `src/supabase.js`
- Test: `test/team-scoring.test.js`
- Test: `test/member-portal.test.js`

**Step 1: Write failing tests**

Cover:

- one team gross score input per hole;
- required `Tee shot used` player selector populated only with the exact squad;
- successful save consumes the authoritative returned row and locks that hole for all squad members;
- concurrent attempts cannot create duplicates or overwrite the first submission;
- partial scorecards resume from persisted shared rows;
- current gross, projected net, and tee-shot contribution counters update safely;
- completion is blocked until every configured hole and minimum tee-shot requirement is satisfied;
- another Cup side or unrelated player cannot read/write the scorecard;
- no individual `rounds`/`scores` are fabricated.

**Step 2: Verify RED**

Run the focused tests.

**Step 3: Implement shared entry**

Render one score stepper and one tee-shot selector per hole. Save only new holes through the narrow RPC. Treat the database as authoritative after every save.

**Step 4: Verify GREEN**

Test two authenticated squad members viewing the same scorecard, including an overlapping save race.

---

### Task 6: Build optional match-play hole-winner entry

**Objective:** Let administrators choose a simpler honor-system match-play workflow without collecting individual stroke scores.

**Files:**
- Modify: `admin.html`
- Modify: `src/admin.js`
- Modify: `portal.html`
- Modify: `src/portal.js`
- Modify: `src/scoring.js`
- Modify: `src/supabase.js`
- Create or extend: `test/hole-outcome-entry.test.js`

**Step 1: Write failing tests**

Cover:

- administrator chooses `Full player scores` or `Hole winner entry` per match-play segment;
- player sees three explicit buttons per hole: Blue, Halved, White;
- any assigned participant may save an unsubmitted outcome;
- outcomes lock after save;
- server counts holes won/halved and finishes the segment mathematically;
- exact match result and Cup points are generated without individual gross scores;
- individual statistics exclude these outcome-only holes;
- administrator corrections require a reason and append audit history;
- result history displays the correction before/after state.

**Step 2: Verify RED**

Run the focused outcome-entry tests.

**Step 3: Implement server and browser paths**

Keep this mode separate from score-derived Singles/Four-Ball so the site never pretends a Blue/White/Halved selection is a player score.

**Step 4: Verify GREEN**

Run focused tests and an authenticated browser scenario.

---

### Task 7: Calculate standings, completion, archive, and commentary

**Objective:** Make Texas Scramble points authoritative everywhere the Cup total appears.

**Files:**
- Modify in migration `040`: authoritative standings/public-preview/completion functions as needed
- Modify: `src/app.js`
- Modify: `src/portal.js`
- Modify: `src/past-trips.js`
- Modify: `supabase/functions/generate-match-commentary/index.ts` only if a server snapshot extension is required
- Modify: `test/tournament-completion.test.js`
- Modify: `test/public-home.test.js`
- Modify: `test/commentary.test.js`

**Step 1: Write failing tests**

Require:

- each squad contributes `max(0, par - netScore)` to its Cup side;
- two Blue and two White four-player squads aggregate correctly for 16 players;
- incomplete squads contribute zero and keep the session/tournament incomplete;
- replay is idempotent;
- public standings use only finalized authoritative squad points;
- Past Trips records each squad and its net result without inventing a head-to-head winner;
- commentary uses only server-derived squad facts and does not invent individual shots;
- tournament completion rejects any incomplete team scorecard or unmet tee-shot requirement.

**Step 2: Verify RED**

Run focused standings/completion tests.

**Step 3: Implement authoritative aggregation**

Perform points and completion inside protected database functions. Do not trust browser-calculated handicaps, net scores, tee-shot counts, or Cup points.

**Step 4: Verify GREEN**

Run focused tests and read back exact database rows.

---

### Task 8: Expand disposable end-to-end coverage

**Objective:** Prove the complete workflow without touching production members or scores.

**Files:**
- Modify: `scripts/e2e/seed-scenario-matrix.mjs`
- Modify: `e2e/four-admin-scenarios.spec.mjs`
- Modify: `scripts/e2e/verify-scenario-matrix.mjs`
- Modify: `.github/workflows/qa-scenario-matrix.yml` only if runtime needs change
- Modify: `test/qa-scenario-matrix.test.js`

**Step 1: Add failing matrix contracts**

Require a deterministic 16-player Texas Scramble fixture plus a smaller match-play outcome fixture. Synthetic identities only; no production data.

**Step 2: Exercise Texas Scramble**

Prove:

- four squads of four;
- official WHS playing-handicap arithmetic;
- shared score entry by more than one squad member;
- selected tee-shot attribution and minimum contribution counters;
- rejection of early completion;
- exact gross, handicap, net, points, and Blue/White aggregates;
- correction audit and recalculation;
- standings, commentary, tournament completion, and Past Trips;
- unauthorized and cross-squad access denial.

**Step 3: Exercise hole-winner mode**

Prove Blue, White, and halved outcomes, mathematical closure, exact Cup points, no fabricated gross scores, correction audit, and replay idempotence.

**Step 4: Destroy and verify**

Stop disposable Supabase, verify it is stopped, and prove no hosted/production identifier or credential was used.

---

### Task 9: Final review and release

**Objective:** Release only after database, browser, accessibility, and security behavior are proven.

**Files:**
- Create: `docs/handoffs/texas-scramble-team-scoring.md`
- Update cache-bust tokens in every affected HTML/module import chain

**Verification gates:**

1. Focused RED/GREEN test history exists for every new behavior.
2. `npm test` passes.
3. `npm audit --audit-level=high` reports zero high-severity vulnerabilities.
4. JavaScript syntax and Edge Function type checks pass.
5. Migration `040` passes fresh-install and `039 → 040` upgrade tests.
6. Direct-table bypass, cross-squad access, duplicate submission, stale client, and concurrency probes fail closed.
7. Real Chrome checks pass at phone, tablet, and desktop widths with a clean console.
8. Independent security/logic review passes.
9. Exact-head disposable 16-player matrix and browser smoke pass sequentially.
10. Open a focused PR with a work-computer continuation handoff.
11. After explicit approval, watch the exact merge-SHA production migration and Pages deployment.
12. Verify live assets and an authenticated read-only view. Do not create a production Texas Scramble or score solely for smoke testing.

## Deferred decisions

- The actual 2027 player count remains TBD. The first administrator preset is 16 players, while the persisted squad model supports two- and four-player squads for a possible 20-player arrangement.
- The exact required tee-shot minimum is deliberately administrator-configurable per session rather than hard-coded.
- Mixed tees within one session are out of initial scope. The initial workflow intentionally uses one shared course and tee so players only make those choices once and the team-handicap calculation remains unambiguous.
- A point cap is not included because the confirmed rule awards one point per stroke under net par with no stated cap.
