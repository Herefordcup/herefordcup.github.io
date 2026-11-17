# Hereford Cup

A mobile-first browser website for the annual Ryder Cup-style Hereford Cup golf trip.

## Features

- Email/password account creation with email verification and password recovery
- Google sign-in through Supabase Auth
- Every registered account automatically receives access to existing and future tournaments
- Individual player profiles and handicap indexes
- Administrator-managed courses, tees, nullable ratings/slopes, pars, and hole data
- Mobile hole-by-hole gross score entry that resumes assigned-match rounds, locks submitted holes, and sends only newly entered holes
- Monitored honor-system scoring for assigned matches: players may submit their own hole scores match-wide, but every submitted score is immutable to the player and requires an audited administrator correction
- Member home dashboard with schedule and match previews
- Home, Score a Round, Cup/Matches, Stats, and More/Rules navigation
- Administrator-defined hole-range segments with independent formats, lineups, sides, allowances, and points
- Validated administrator-only authoritative segment-result finalization that produces Cup points and unlocks complete official round statistics
- Planning support for Singles, Four-Ball, Foursomes, Scramble, Shamble, and Chapman; member individual score entry remains blocked for Scramble, Foursomes, and Chapman, while administrators may enter their official result without fabricating member scores
- Complete, finalized-round-only league and player statistics
- Verified Tobacco Road and Pinehurst course catalog with source-conflict notes
- Mobile-ready audited administrator score correction/deletion with a required reason and readback confirmation
- Administrator-controlled, server-side AI match recaps that are always saved as drafts for explicit approval, editing, or hiding; approved copy remains available to edit or hide
- Browser-based website for phones, tablets, and computers

## Supabase setup

1. Create a Supabase project.
2. Run only the foundation migrations first:
   - `supabase/migrations/001_hereford_cup.sql`
   - `supabase/migrations/002_tournament_access.sql`
3. Enable Email under Authentication > Providers, require email confirmation, and disable anonymous access.
4. Configure Google under Authentication > Providers.
5. Set the production site URL to `https://herefordcup.github.io/` and allow `https://herefordcup.github.io/portal.html` plus `https://herefordcup.github.io/portal.html?recovery=1` as redirect URLs.
6. Add the project URL and publishable key to `src/config.js`.
7. Create and verify the first account, sign in once, then promote that exact user to `admin` in the SQL editor. Read the profile row back and confirm its ID, email join, and `role = 'admin'` before continuing.
8. Run the feature migrations only after the administrator exists, so the 2027 seed is created:
   - `supabase/migrations/003_2027_planning.sql`
   - `supabase/migrations/004_course_catalog.sql`
   - `supabase/migrations/005_integrity_hardening.sql`
   - `supabase/migrations/006_automatic_tournament_access.sql`
9. Read back the 2027 tournament, automatic account memberships, itinerary/course links, segment constraints, score ownership constraint, immutable-score grants, administrator correction RPC/audit table, commentary RPC signatures/revokes, and seeded course/tee/hole counts. Treat these migrations as staging-only until that readback succeeds in a disposable or staging project.
10. Configure Edge Function secrets by name only: `AI_API_KEY`; optionally `AI_API_BASE_URL` and `AI_MODEL`.
11. Deploy `supabase/functions/generate-match-commentary` with JWT verification enabled.

Migration `002_tournament_access.sql` is already applied in production and must not be edited. Migration `005_integrity_hardening.sql` performs the forward-only authorization upgrade, safely validates existing score ownership before adding the composite foreign key, and replaces the unsafe commentary draft RPC. Migration `006_automatic_tournament_access.sql` enrolls every existing and future account in every tournament while preserving explicitly removed memberships. Apply `003` through `006` in order in staging before any production rollout.

Player scoring is intentionally monitored rather than segment-write-enforced in the database. A player still needs an active membership, an assigned non-final match, and their own round, but may enter any hole on that assigned match. Match selection fixes the course; an existing round also fixes its persisted tee. Saved holes reload as read-only, and later saves insert only new holes. After insertion, authenticated players cannot update or delete a score. Administrators correct, insert, or delete a hole only through `correct_hole_score`; a reason is required and each correction is written to `score_correction_audit`.

The browser receives only Supabase's publishable key. Database writes are protected by row-level security; never put a service-role key in this repository.

## Local development

```sh
npm test
npm run serve
```

## Hosting

The static browser interface is deployed through GitHub Pages. Supabase provides authentication and will become the authoritative shared source for membership, tournaments, pairings, scores, and standings once the project is connected and its migrations are applied.
