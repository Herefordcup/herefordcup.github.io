# Compact organizer scorecards

## User flow

- In Admin, show a single workspace at a time. Scorecards opens without a blank result panel, audit log or manual action. The other organizer forms stay mounted, so switching tools preserves an unfinished draft. Bookmarks can select a tool with `admin.html?tool=scorecards` (or `members`, `matches`, `scramble`, `completion`, `rules`, `commentary`, `legacy`, `courses`, `all`).
- Pick a match and, only if needed, a player's/shared card. Tap **Edit** next to a submitted hole, change the score/driver/winner, give a reason and save. Ordinary players retain the existing entry and lock behavior. An organizer looking at their own assigned card in Play uses the same contextual dialog, not another Admin page.
- Open **View change history** to inspect the selected match. A genuine unfinished manual Foursomes result remains available on its own match. Less-common legacy correction options remain behind **More options**; the exact-row editor never inserts or deletes a score. Published editions remain read-only.
- Tournament formats, team names and point rules are unchanged.

## Code and data boundary

`src/admin-workspaces.js` selects a workspace; `src/admin-scorecard.js` renders the selected card's submitted rows. `src/admin.js` and `src/portal.js` derive the target and organizer authority from current records. `src/scorecard-hole-editor.js` is loaded on demand and uses the existing audited Supabase paths, with an optional exact row ID for individual replacements. `scorecard-edit.css` scopes the editor and keeps its actions reachable on short screens. Public landing and Past Trips pages do not expose editing controls.

Migration 042 (`supabase/migrations/042_individual_score_correction.sql`) is forward-only. It keeps the five-argument individual correction call and adds the six-argument exact-row variant of the same RPC. Both serialize with tournament publication and preserve the existing scoring and audit logic. The extra argument is `expected_score_id`; older clients that omit it retain their previous legitimate behavior on open tournaments. The migration does not rewrite score, archive, membership or roster rows.

## Verification and release

Run `npm ci --include=dev --ignore-scripts`, `npm test`, and `git diff --check`. For a feature checkout use branch `feat/compact-scorecard-corrections`. The two signed-in workflows are `disposable-e2e.yml` (16-player Scramble, ordinary/outcome organizer edits and archive replay) and `qa-scenario-matrix.yml` (individual row corrections on Play and Admin plus manual Foursomes). They run with disposable loopback Supabase, synthetic identities, independent readback, and teardown. Verify the full run SHA, not a skipped draft job. Keep corrective writes and failure/rollback scenarios off the live tournament.

Production remains the protected `test → migrate → build → deploy` workflow on `main`. Verify 042 in the remote migration-history readback, the Pages deployment for the exact merge commit, and the actual released HTML, stylesheets and modules. On production use read-only navigation and anonymous access-gate checks; report the authenticated test against its real environment rather than implying synthetic scores were played in production.
