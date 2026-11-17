# Hereford Cup work handoff

Last updated: 2026-11-17

This document is the continuation point for a separate Hermes installation. It contains no credentials, tokens, private account identities, payment details, or secret values.

## Repository state

- Repository: `https://github.com/Herefordcup/herefordcup.github.io`
- Production site: `https://herefordcup.github.io/`
- Production portal: `https://herefordcup.github.io/portal.html`
- Production admin page: `https://herefordcup.github.io/admin.html`
- Default branch: `main`
- Current deployed feature commit: `2c167ae3ac953ade041b6a51f89aadc8b0a55358`
- Pull request: `https://github.com/Herefordcup/herefordcup.github.io/pull/3` (merged)
- GitHub Pages serves `main`. Do not assume migrations `003`–`005` or the Edge Function are deployed.

## Product boundaries

- This is a conventional responsive browser website, not an installable app or PWA.
- Do not add a web manifest, installation prompts, service-worker caching, or offline/app-store positioning.
- Authentication supports verified email/password and Google OAuth. Apple remains disabled.
- Authentication and tournament membership are separate. A signed-in account still needs an invitation, approval, or administrator role.
- Static assets deploy through GitHub Pages. Supabase provides Auth, PostgreSQL, RLS, and Edge Functions.
- Browser code may contain only the Supabase project URL and publishable key. Never commit a service-role key, OAuth client secret, database password, or AI-provider key.

## Architecture

### Static browser layer

- `index.html`, `styles.css`, `src/app.js`: public landing page.
- `portal.html`, `portal.css`, `src/portal.js`: account flows, membership gate, member Home, scoring, Cup/matches, statistics, rules, and approved commentary.
- `admin.html`, `admin.css`, `src/admin.js`: course entry, match/segment planning, independent segment lineups, audited score corrections, rules, commentary settings, generation, editing, approval, and hiding.
- `src/supabase.js`: browser-safe Supabase client and data operations.
- `src/golf.js`: course handicaps, stroke allocation, net scores, and format-aware hole scoring helpers.
- `src/scoring.js`: match state, completion, status, and points, including segment-specific hole totals.
- `src/formats.js`: supported formats, segment labels, hole counts, and segment validation.
- `src/member.js`: active-2027 tournament selection, upcoming-match filtering, and assigned-segment relationship helpers.
- `src/admin-helpers.js`: nullable numeric parsing and browser-timezone-independent Eastern datetime conversion.
- `src/stats.js`: league/player aggregates from finalized-round rows.
- `src/commentary.js`: prompt construction and numeric-claim validation shared by tests.

### Supabase layer

For a fresh project, apply `001` and `002`, authenticate and promote the first administrator with an exact email/ID join and readback, then apply `003`, `004`, and `005`. The 2027 seed intentionally skips when no administrator exists. Production already has `002`; keep it byte-for-byte at HEAD and use `005` for all forward authorization changes.

1. `supabase/migrations/001_hereford_cup.sql`
   - Profiles, courses, tees, holes, matches, match players, rounds, scores, base RLS.
2. `supabase/migrations/002_tournament_access.sql`
   - Tournaments, memberships, invitations, assignment-aware write authorization, secure invitation claiming.
3. `supabase/migrations/003_2027_planning.sql`
   - 2027 itinerary, hole-range match segments, validated RPC-only lineup writes, rules, complete-finalized-round statistics, finalized-score immutability, coherent commentary storage, RLS, and atomic `save_match_plan` RPC.
4. `supabase/migrations/004_course_catalog.sql`
   - Source provenance and availability metadata; nine-hole/unrated tee support; verified Tobacco Road and Pinehurst catalog; itinerary-to-course links.
5. `supabase/migrations/005_integrity_hardening.sql`
   - Course/tee-aware round authorization; score-to-round ownership constraint; monitored honor-system, insert-only player scores; audited administrator-only score correction RPC; finalized metadata guards; and server-derived commentary drafts/edit audit.

Edge Function:

- `supabase/functions/generate-match-commentary/index.ts`
- Requires an authenticated administrator.
- Reads finalized authoritative match/segment facts without member display names and computes the result deterministically.
- Uses server-only AI credentials.
- Sends only an allowlisted phrase identifier and model metadata to the database RPC; the database independently rechecks settings, timing, finalized scope, and derives the exact fact snapshot and prose.
- Always stores generated text as a draft for administrator review/audit. Edited copy is marked administrator-edited, records `edited_by`/`edited_at`, and preserves the original generated text.

## Completed on this branch

- Replaced scorecard-first login landing with a member Home dashboard.
- Added member navigation: Home, Score a Round, Cup/Matches, Stats, More.
- Added schedule and next-match previews that exclude past/final matches and show only the member's assigned segments, partners, and opponents.
- Added complete-finalized-round-only league and player statistics and froze round/score writes after match finalization.
- Added administrator-maintained Rules under More.
- Added match segments with independent hole ranges, formats, gross/net mode, explicit handicap allowance, point value, lineups, and sides.
- Added planning support for Singles, Four-Ball, Foursomes, Scramble, Shamble, and Chapman; scoring support remains limited as documented below.
- Added segment-length-aware match completion and Cup points.
- Added atomic administrator match-plan saving with format cardinality, unique-player/order, and side validation; tournament membership remains the trusted source for each player's Cardinal/Silver team. Direct authenticated segment writes are revoked.
- Added the March 18–21, 2027 itinerary without lodging price, payment handle, deposit amount, shuttle phone number, or other private trip details.
- Added Tobacco Road and the current Pinehurst roster with current hole geometry where authoritative data was available.
- Added rating categories so men's and women's ratings can coexist for one named tee.
- Preserved official-source conflicts rather than joining mismatched ratings to current hole rows.
- Added an enabled, administrator-controlled AI recap workflow with Clean/Playful/Ruthless tones, anonymous deterministic result facts, template-constrained server-side generation, mandatory draft approval, edit, hide, and approved member display.
- Added allowance-aware mixed gross/net display for individual-score-compatible segments. Scramble, Foursomes, and Chapman remain plannable but are blocked in individual score entry with a clear team-score limitation.
- Added a validated `SECURITY DEFINER` administrator result workflow. It records one authoritative final differential/holes-played result per segment, verifies complete coherent rounds for individual-score-compatible assignments, finalizes the match, and produces Cup points and official statistics. This does not fabricate player scores for team-score formats.
- Course rating and slope are nullable in the administrator form, and match datetime-local values are interpreted explicitly in `America/New_York`.
- Kept all AI calculations out of authoritative scoring.
- Implemented the approved monitored honor-system scoring rule: a player with active access and a match assignment may submit their own scores across that match without per-segment hole enforcement. Submitted holes are immutable to players; only the audited administrator correction RPC may insert, change, or delete them.
- Added score ownership integrity (`scores(round_id,user_id)` to `rounds(id,user_id)`) with an upgrade-time mismatch check, and changed the browser save path from upsert to insert-only with a locked-score conflict message.
- Added partial-round resume: owned rounds and scores load with member data, submitted holes are read-only, assigned non-final matches force their course, persisted rounds force their tee, and saves insert only new holes before reading the round back.
- Added a mobile-ready administrator correction form with required reason, score/delete actions, and score/audit readback confirmation.
- Commentary settings hydrate per tournament; drafts expose Approve/Edit/Hide, approved copy stays listed with Edit/Hide, and member provenance labels distinguish untouched AI text from administrator edits.
- Hardened commentary draft creation so direct RPC callers cannot supply prose or facts, while retaining enabled administrator controls, mandatory approval, result finalization, and commentary publication.

## 2027 itinerary modeled

All times use the Eastern timezone.

- Thursday, March 18: Tobacco Road fun round at 1:00 PM; Thistle Dhu at 7:00 PM; dinner at The Deuce.
- Friday, March 19: Pinehurst No. 3 at 8:00 AM; Pinehurst No. 4 at 2:00 PM; dinner at Pinehurst Brewing Company.
- Saturday, March 20: Pinehurst No. 2 at 10:00–10:30 AM; long drive at 4:00 PM; The Cradle at 6:00 PM; dinner.
- Sunday, March 21: Pinehurst No. 10 at 7:30–8:00 AM; walking only.
- Thursday is non-competition by default. Team competition begins Friday.

## Course-data decisions and caveats

- Pinehurst currently lists Nos. 1–11 plus The Cradle.
- Pinehurst No. 7 closes January 18, 2027 and is expected to reopen in late July 2027. It is inactive for this event, and pre-renovation tees are intentionally not seeded as event-ready data.
- Pinehurst No. 11 opens March 29, 2027, after the event. It is inactive and has no invented scorecard data.
- Pinehurst No. 2 and No. 3 current Pinehurst card lengths conflict with their USGA registered rows. Their current hole geometry is seeded, but ratings are null until confirmed.
- Pinehurst No. 5 Gold has conflicting current 6,823/6,828-yard official rows. The live 6,823-yard geometry is retained without attaching the 6,828-yard rating.
- Pinehurst No. 9 reopened after an August 2026 renovation. Current hole geometry is seeded; stale/mismatched rating records are not attached.
- The Cradle current Pinehurst card is 789 yards, while USGA ratings refer to 766 yards. The 789-yard course is seeded unrated.
- Tobacco Road's named tees have no verified color mapping. Do not invent colors. Its first-party single-row card conflicts with the detailed current rating listings, so provenance notes remain attached.
- An unrated tee is labeled `Rating pending`. Gross scoring can use it; net scoring is blocked until rating and slope are confirmed.

## Known limitations / next work

1. Migrations `003`, `004`, and `005` have not been applied to production.
2. The commentary Edge Function has not been deployed, and no AI secret has been configured in production.
3. The member scorecard still records individual gross scores, so Scramble, Foursomes, and Chapman remain deliberately blocked from member entry. Administrators can finalize those segments from the official result through the authoritative workflow, but there is still no member/team side-score scorecard or automatic derivation from synchronized participant scores.
4. Segment planning currently creates plans; a full edit-existing-plan picker remains future work. The authoritative result/finalization view is implemented.
5. Commentary result facts and final prose are deterministic: the model can select only a server-owned tone phrase identifier. The server composes that phrase with the exact result and stores it as a draft; administrator approval remains mandatory.
6. Migration SQL has been parsed with PostgreSQL grammar, but `003`/`004`/`005` still need a live Supabase-compatible staging application and readback before production.
7. No production finalized-round dataset exists yet for a real statistics readback.
8. No. 7 and No. 11 require new official scorecards after they become available.

## Environment variable names

Values must be stored in Supabase Edge Function secrets, never in GitHub Pages code or this repository.

Required:

- `SUPABASE_URL` (provided automatically in Supabase Edge Functions)
- `SUPABASE_ANON_KEY` (provided automatically in Supabase Edge Functions)
- `AI_API_KEY`

Optional:

- `AI_API_BASE_URL` (defaults to an OpenAI-compatible `/v1` endpoint)
- `AI_MODEL` (defaults to `gpt-4o-mini`)

Browser-safe configuration in `src/config.js`:

- Supabase project URL
- Supabase publishable key

Do not replace the publishable key with a secret/service-role key.

## Setup on another computer

```sh
git clone https://github.com/Herefordcup/herefordcup.github.io.git
cd herefordcup.github.io
git fetch origin
npm test
npm run serve
```

Open the local URL printed by `serve`, then check `portal.html` and `admin.html` in Chrome.

## Verification commands

```sh
npm test
node --check src/admin.js
node --check src/admin-helpers.js
node --check src/commentary.js
node --check src/formats.js
node --check src/golf.js
node --check src/member.js
node --check src/portal.js
node --check src/round-entry.js
node --check src/scoring.js
node --check src/stats.js
node --check src/supabase.js
npx --yes deno check supabase/functions/generate-match-commentary/index.ts
# Parse every migration in numeric order (001 through 005) with PostgreSQL grammar.
git diff --check
```

The migration parser used during development was installed only in Hermes scratch space, not in the repository. The required gate is successful PostgreSQL grammar parsing for migrations `001` through `005`.

## Safe production rollout

1. Review the complete PR and require green tests.
2. Confirm `002_tournament_access.sql` exactly matches HEAD; do not reapply or edit the production-applied migration.
3. Apply migrations `003`, `004`, and `005`, in order, to a staging Supabase project or disposable database first.
4. Verify row counts, RLS, event-to-course links, tee categories, 9-hole Cradle rows, inactive No. 7/No. 11, unrated-tee behavior, composite score ownership, immutable player grants, correction audit rows, finalized metadata guards, and safe commentary RPC signatures.
5. Deploy the Edge Function with JWT verification enabled.
6. Configure secret names above; commentary may be enabled by an administrator but approval must remain required.
7. Generate one recap from a finalized staging match; verify server-derived facts/text, draft state, edit audit, approve, hide, and member readback.
8. Exercise a partial player score insertion, reload and confirm saved holes are locked, submit a new hole without a duplicate rollback, confirm a second write to the same hole fails, and verify an administrator RPC correction with a reason creates the expected audit row.
9. Apply the migrations and function to production only after staging passes.
10. Merge the PR to `main`; wait for GitHub Pages deployment.
11. Read back exact production assets and exercise Google login, membership gating, Home navigation, course/tee selection, rules, stats empty states, and administrator access.
12. Do not create or save a real tournament round merely to test configuration.

## Authoritative course sources

Pinehurst roster and courses:

- `https://pinehurst.com/golf`
- `https://www.pinehurst.com/golf/courses/no-1/`
- `https://www.pinehurst.com/golf/courses/no-2/`
- `https://www.pinehurst.com/golf/courses/no-3/`
- `https://www.pinehurst.com/golf/courses/no-4/`
- `https://www.pinehurst.com/golf/courses/no-5/`
- `https://www.pinehurst.com/golf/courses/no-6`
- `https://www.pinehurst.com/golf/courses/no-7`
- `https://www.pinehurst.com/golf/courses/no-8`
- `https://www.pinehurst.com/golf/courses/no-9`
- `https://www.pinehurst.com/golf/courses/no-10`
- `https://www.pinehurst.com/golf/courses/cradle-short-course`
- `https://pinehurst.com/news/weirdly-wonderful-and-mysterious-pinehurst-no-11-to-debut-march-29-2027`

USGA rating records used for corroboration/conflict handling:

- No. 2: `https://ncrdb.usga.org/courseTeeInfo?CourseID=23725`
- No. 4: `https://ncrdb.usga.org/courseTeeInfo?CourseID=23727`
- No. 9: `https://ncrdb.usga.org/courseTeeInfo?CourseID=23739`
- No. 10: `https://ncrdb.usga.org/courseTeeInfo?CourseID=34035`
- The Cradle: `https://ncrdb.usga.org/courseTeeInfo?CourseID=33642`

Tobacco Road:

- `https://tobaccoroadgolf.com/golf`
- `https://course.bluegolf.com/bluegolf/course/course/tobaccoroadgc/detailedscorecard.htm`
- `https://www.golfpass.com/travel-advisor/courses/1223-tobacco-road-golf-club/scorecard-and-layout`

## Existing production foundation

- PR #1: browser-based player scoring portal.
- PR #2: email/password and Google authentication, tournament membership separation, invitation flow, security hardening, and administrator bootstrap.
- Production Google OAuth and the protected administrator path were verified before this branch.
- Preserve all prior RLS protections: round ownership, assigned-match access, active membership, invitation role limits, and protected profile roles.
