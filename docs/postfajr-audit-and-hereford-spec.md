# PostFajr audit and Hereford Cup product specification

## Scope and safety

This audit covers the authenticated player-facing PostFajr experience and its publicly delivered assets. It was performed read-only. No round was created, no score was submitted, and no profile or league data was changed. A player checkbox selected while inspecting the round form was immediately cleared before leaving the page; the form was never submitted.

The PostFajr source repository is not public. The site is a server-rendered Node/Express application behind Nginx on an AWS EC2 host. Its behavior and delivered front-end can be studied, but its private server code cannot be reviewed without repository access.

## What PostFajr does well

### Persistent tournament shell

Every authenticated page uses the same tournament context:

- Current season and status
- Current user's handicap
- A horizontally scrollable strip of recent and live results
- Fixed mobile navigation: Home, Scores, Play, Race, More
- A full-screen More menu grouped into League, Stats, Rules, and Me

This makes every page feel connected to one live competition rather than a collection of unrelated tools.

### Home dashboard

The home page is a tournament pulse:

- Live-match callout with a direct watch link
- Current seed, points, handicap, and qualification status
- Championship and consolation brackets
- Deadlines, walkovers, commissioner decisions, and live/final states
- Compact standings and latest results
- Direct explanations of how to play the next required match

For Hereford Cup, this should become the Cup dashboard: current team score, active session, next tee times, live matches, completed matches, and the remaining points needed to retain or win the Cup.

### Ryder Cup page

PostFajr's Ryder Cup view is the closest model for Hereford Cup. It contains:

- Event date, course, and tee-time window
- Large team score with the winning team clearly declared
- Team rosters, captains, handicap indexes, groups, and tee times
- Group-by-group pairings
- Front-nine Four-Ball and back-nine Singles match cards
- Per-match status and allocated Cup points
- Format explanation and day-of procedures

The observed event used two six-player teams, three tee-time groups, nine total points, and first to five points. Hereford Cup must make all of those values administrator-configurable rather than hard-coded.

### Match and score presentation

A finalized match page shows:

- Competitors, course, date, format, and final match-play result
- Gross scorecard and a Show Net toggle
- Hole-by-hole gross scores
- Net scores after stroke allocation
- The side that won each hole
- Running match state
- Final result such as 3&2, 2 Up, or Halved
- Post-match summary/commentary and share action

The rules describe one scorecard serving the whole group. Any player in the group can correct a score, and everyone else can watch live. The scorekeeper supports concessions, gross/net visibility, Four-Ball best-ball logic, Singles, and finalization.

### Round setup

The round setup form supports:

- League, tournament/playoff, casual, and simulator round types
- Administrator-defined courses and tees
- Front 9, back 9, or 18 holes
- The signed-in player automatically included
- Other players selected from the roster
- Eligibility validation before a league round
- A four-player maximum per card

For Hereford Cup, players should normally open an assigned match rather than manually create a Cup match. Admin-created sessions, pairings, format, course, tee, and start hole must be authoritative. A separate casual-practice flow can remain optional.

### Teams, standings, and players

PostFajr tracks:

- Teams and rosters
- Team points and recent form
- Individual starting and current handicap
- Handicap movement
- Rounds played
- Match completion requirements
- Individual Stableford performance
- Player profiles linked from tables and match cards

Hereford Cup should replace season-long free scheduling with scheduled Ryder Cup sessions while retaining the roster, handicap, history, and profile concepts.

### Profiles and progression

A player profile includes:

- Digital club card
- Name, avatar, handicap index, and handicap source/status
- QR code
- Match record, points, and participation count
- Achievement badges and milestones
- Personal game report after enough finalized golf
- Finalized round history
- Basic profile settings

Hereford Cup should include a player card, Google/Apple avatar, preferred name, handicap index, optional GHIN number, team history, Cup record, format records, partners, opponents, points earned, rounds, and achievements. The QR card is optional and lower priority.

### Courses and yardage book

The course catalog separates real and simulator courses and shows how many tees are available. A course page includes:

- Course name and location
- Multiple tees and yardages
- Par
- Front-nine and 18-hole stroke indexes
- Per-hole table
- Opponent selector for a personalized game plan
- Highlighting of where handicap strokes fall

Hereford Cup needs administrator-owned course data with list, add, edit, archive, multiple tees, rating, slope, par, yardage, and stroke index for all holes. Match pages should show exactly where each player receives strokes.

### Statistics and history

League-wide views include:

- Scoring average versus par
- Best Stableford round
- Birdies or better
- Holes played
- Starting versus current handicap
- Rounds and required matches
- Player table with team and performance columns
- Honors/history pages

Hereford Cup statistics should focus on match play:

- Career Cup record and points percentage
- Singles, Four-Ball, and Foursomes records
- Gross and net records
- Partner and opponent records
- Holes won, halved, and lost
- Largest win and comeback
- Session and year splits
- Course and tee splits
- Team championships and past captains

## Recommended Hereford Cup information architecture

### Fixed navigation

1. **Home** — live Cup dashboard
2. **Matches** — all sessions and match cards
3. **Score** — assigned active match or next match
4. **Cup** — team score, rosters, session totals, and path to victory
5. **More** — Players, Courses, Stats, History, Rules, Profile, and admin links

This preserves PostFajr's strongest mobile pattern without retaining its installable-app behavior. Hereford Cup remains a conventional responsive website.

### Player-facing pages

- Sign in / invitation acceptance
- First-login profile setup
- Home dashboard
- Tournament schedule
- Session detail
- Match detail and live scorecard
- Team rosters
- Cup scoreboard
- Player directory
- Player profile and history
- Course and tee yardage book
- Statistics
- Past Cups / honors board
- Rules and format guide
- Account settings

### Administrator pages

- Tournament editions
- Invitations and membership approvals
- Roles and captains
- Teams and rosters
- Courses, tees, and holes
- Sessions and formats
- Tee times, groups, and pairings
- Match handicap mode and allowance
- Scoring corrections and audit log
- Match finalization/reopen controls
- Tournament status and public visibility
- Historical import/export

## Authentication and onboarding

Required authentication options:

- Create an account with email and password
- Google sign-in
- Apple sign-in
- Email verification, forgotten-password recovery, and secure session management

Recommended signup and first-login flow:

1. User creates an email/password account or signs in with Google or Apple.
2. The site verifies the email address when applicable.
3. The site verifies an invitation or administrator allowlist.
4. User confirms preferred display name and avatar.
5. User enters handicap index and optional GHIN number.
6. User accepts tournament rules and privacy notice.
7. Admin assigns the player to a team and tournament roster.

Authentication must not be the same thing as tournament membership. Creating an account or possessing a valid Google or Apple identity should not automatically grant access to private tournament data.

## Authoritative data model

The current repository needs a stronger tournament model before live scoring is connected.

Core entities:

- `profiles`
- `identities` / provider metadata
- `invitations`
- `tournaments`
- `tournament_memberships`
- `teams`
- `team_memberships`
- `courses`
- `tees`
- `holes`
- `sessions`
- `matches`
- `match_sides`
- `match_players`
- `rounds`
- `hole_scores`
- `match_hole_results`
- `match_results`
- `cup_points`
- `achievements`
- `audit_events`

Important model rules:

- Tournament, session, format, course, tee, and pairing are administrator-controlled.
- A player can score only a match to which they are assigned, unless explicitly delegated.
- Hole scores are stored once; net scores and match results are derived from authoritative rules.
- Every correction and finalization is auditable.
- A finalized match is immutable to normal players and reopenable only by an administrator.
- Team and individual totals are derived from finalized matches, not manually typed.

## Scoring requirements

Supported formats:

- Singles
- Four-Ball
- Foursomes / Alternate Shot

Required options per match or session:

- Gross or net match play
- Handicap allowance percentage
- Tee assignment
- 9 or 18 holes
- Starting hole
- Concessions
- Finalization and administrator override

Live match status must calculate:

- All Square
- N Up
- Dormie where appropriate
- N&K final result
- N Up final result
- Halved
- Remaining holes
- Session points and total Cup points

Calculations should be enforced transactionally in PostgreSQL functions or trusted server-side logic so concurrent clients cannot create conflicting standings.

## Current Hereford Cup repository: keep versus replace

### Keep and extend

- MIT-inspired cardinal, silver, black, and white visual system
- Responsive browser-only delivery
- Existing Singles, Four-Ball, Foursomes, handicap, and Cup-point calculations
- Supabase direction
- Existing course/tee/hole schema as a starting point
- Existing 13 passing scoring tests

### Replace or substantially rebuild

- Device-local placeholder match state
- Hard-coded sessions and match cards
- Blank Supabase configuration
- One-course/one-tee admin form
- Unassigned free-form round entry as the main Cup flow
- Client-only authoritative scoring
- Broad profile/round visibility policies
- Implicit OAuth flow

### Add

- Apple login
- Invitation/allowlist enforcement
- Complete profile onboarding
- Tournament editions and multi-year history
- Teams, rosters, captains, sessions, groups, pairings, and tee times
- Assigned-match scoring dashboard
- Score resume/edit/finalize lifecycle
- Realtime subscriptions
- Live Cup scoreboard
- Match and session history
- Player statistics and achievements
- Full admin CRUD and audit trail
- Database, RLS, integration, concurrency, browser, and auth tests

## Build sequence

1. Provision and secure Supabase; configure verified email/password accounts plus Google and Apple with PKCE.
2. Add invitations, tournament editions, memberships, teams, sessions, and match assignments.
3. Build complete admin workflows for rosters, courses, tees, sessions, and pairings.
4. Build first-login profile onboarding and assigned-match dashboard.
5. Connect hole-by-hole scoring to authoritative match calculations and finalization.
6. Replace local placeholder standings with Supabase queries and realtime updates.
7. Build the PostFajr-style Home, Matches, Cup, Players, Courses, Stats, History, and Rules views.
8. Add recovery, correction, audit, accessibility, mobile, concurrency, and end-to-end tests.
9. Deploy only after account creation, email verification/recovery, Google login, Apple login, two-client live scoring, match finalization, and Cup-total readback are verified in production.

## Product direction

The goal is not to copy PostFajr's private code or branding. The goal is to reproduce its strongest product qualities—persistent tournament context, fast mobile score entry, live match visibility, rich profiles, course intelligence, and history—using Hereford Cup branding and a true Ryder Cup domain model.