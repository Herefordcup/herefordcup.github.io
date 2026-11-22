import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarizeLeagueStats, summarizePlayerStats } from '../src/stats.js';
import {
  assignedSegmentsForPlayer,
  membershipAccessTransition,
  nextUpcomingAssignment,
  playerDirectoryEntries,
  segmentRelationships,
  selectActiveTournament,
} from '../src/member.js';

const html = await readFile(new URL('../portal.html', import.meta.url), 'utf8');
const portalScript = await readFile(new URL('../src/portal.js', import.meta.url), 'utf8');
const supabaseScript = await readFile(new URL('../src/supabase.js', import.meta.url), 'utf8');
const formatsScript = await readFile(new URL('../src/formats.js', import.meta.url), 'utf8');
const portalCss = await readFile(new URL('../portal.css', import.meta.url), 'utf8');
const homeCss = await readFile(new URL('../home.css', import.meta.url), 'utf8');

test('membership refresh recreates deleted active access but does not resurrect denied requests', () => {
  const tournament = { edition_year: 2027, status: 'setup' };
  const active = { status: 'active', tournaments: tournament };
  const pending = { status: 'pending', tournaments: tournament };
  assert.equal(membershipAccessTransition([active], []), 'request');
  assert.equal(membershipAccessTransition([pending], []), 'denied');
  assert.equal(membershipAccessTransition([pending], [active]), 'reload');
  assert.equal(membershipAccessTransition([active], [pending]), 'reload');
  assert.equal(membershipAccessTransition([active], [active]), 'none');
  assert.equal(membershipAccessTransition([
    { status: 'active', tournaments: { edition_year: 2026, status: 'complete' } },
    active,
  ], [{ status: 'active', tournaments: { edition_year: 2026, status: 'complete' } }]), 'request');
});

test('membership refresh tracks the priority tournament identity instead of masking deletion with another active edition', () => {
  const live = { id: 'live-2027', edition_year: 2027, status: 'live' };
  const setup = { id: 'setup-2027', edition_year: 2027, status: 'setup' };
  const liveActive = { tournament_id: live.id, status: 'active', tournaments: live };
  const setupActive = { tournament_id: setup.id, status: 'active', tournaments: setup };

  assert.equal(membershipAccessTransition([liveActive, setupActive], [setupActive]), 'request');
});

test('membership refresh follows the displayed active tournament ahead of a higher-priority pending request', () => {
  const live = { id: 'live-2027', edition_year: 2027, status: 'live' };
  const setup = { id: 'setup-2027', edition_year: 2027, status: 'setup' };
  const livePending = { tournament_id: live.id, status: 'pending', tournaments: live };
  const setupActive = { tournament_id: setup.id, status: 'active', tournaments: setup };

  assert.equal(membershipAccessTransition([livePending, setupActive], [livePending]), 'request');
});

test('membership refresh reloads when any pending request becomes active behind a higher-priority pending request', () => {
  const live = { id: 'live-2027', edition_year: 2027, status: 'live' };
  const setup = { id: 'setup-2027', edition_year: 2027, status: 'setup' };
  const livePending = { tournament_id: live.id, status: 'pending', tournaments: live };
  const setupPending = { tournament_id: setup.id, status: 'pending', tournaments: setup };
  const setupActive = { ...setupPending, status: 'active' };

  assert.equal(membershipAccessTransition([livePending, setupPending], [livePending, setupActive]), 'reload');
});

test('membership refresh reloads rather than re-requesting when the displayed tournament completes', () => {
  const setup = { id: 'setup-2027', edition_year: 2027, status: 'setup' };
  const complete = { ...setup, status: 'complete' };
  const active = { tournament_id: setup.id, status: 'active', tournaments: setup };
  const completed = { ...active, tournaments: complete };

  assert.equal(membershipAccessTransition([active], [completed]), 'reload');
});

test('membership refresh reloads when a higher-priority tournament becomes active', () => {
  const live = { id: 'live-2027', edition_year: 2027, status: 'live' };
  const setup = { id: 'setup-2027', edition_year: 2027, status: 'setup' };
  const livePending = { tournament_id: live.id, status: 'pending', tournaments: live };
  const liveActive = { ...livePending, status: 'active' };
  const setupActive = { tournament_id: setup.id, status: 'active', tournaments: setup };

  assert.equal(membershipAccessTransition(
    [livePending, setupActive],
    [liveActive, setupActive],
  ), 'reload');
});

test('member portal opens with home and provides primary navigation', () => {
  for (const id of [
    'memberNav',
    'homeView',
    'scoreView',
    'cupView',
    'statsView',
    'moreView',
    'schedulePreview',
    'matchPreview',
    'leagueStats',
    'playerStats',
    'rulesList',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  for (const label of ['Home', 'Play', 'Cup', 'Stats', 'More']) {
    assert.match(html, new RegExp(`>${label}<`), `missing ${label} navigation`);
  }
  assert.match(portalScript, /showMemberView\('home'\)/);
});

test('member home is a summary-first dashboard with live action, player snapshot, results, and schedule', () => {
  for (const id of [
    'homeSeason',
    'homeTournamentStatus',
    'homeHandicap',
    'homeTeam',
    'homeRounds',
    'liveMatchPanel',
    'recentResults',
    'schedulePreview',
    'cupScorePreview',
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(html, /data-open-view="score"[^>]*>Play now</);
  assert.match(portalScript, /function renderHomeSummary\(/);
  assert.match(portalScript, /function renderRecentResults\(/);
  assert.match(portalScript, /function renderLiveMatch\(/);
  assert.match(portalScript, /homeTeam[\s\S]*membership\?\.team === 'cardinal' \? 'Blue' : membership\?\.team === 'silver' \? 'White' : 'Unassigned'/);
  assert.match(portalScript, /formatHomeDateRange\(tournament\?\.starts_on, tournament\?\.ends_on\)/);
  assert.match(portalScript, /homeScheduleTitle/);
});

test('More includes a tournament player directory without private contact data', () => {
  assert.match(html, /id="playersList"/);
  assert.match(html, />Players</);
  assert.match(supabaseScript, /profiles!tournament_memberships_user_id_fkey\(display_name, handicap_index, profile_photo_path\)/);
  assert.match(portalScript, /from '\.\/supabase\.js\?v=automatic-match-completion-1'/);
  assert.match(portalScript, /function renderPlayers\(/);
  assert.doesNotMatch(portalScript, /player\.email|profiles\(email/);
});

test('player directory shows active members with golf-relevant information', () => {
  const rows = playerDirectoryEntries([
    { status: 'active', user_id: 'b', team: 'silver', role: 'player', profiles: { display_name: 'Zoe', handicap_index: 12.4, profile_photo_path: 'b/avatar.webp' } },
    { status: 'active', user_id: 'a', team: 'cardinal', role: 'captain', profiles: { display_name: 'Alex', handicap_index: 8.1 } },
    { status: 'removed', user_id: 'c', team: 'cardinal', role: 'player', profiles: { display_name: 'Removed', handicap_index: 2 } },
  ], [
    { user_id: 'a' },
    { user_id: 'a' },
    { user_id: 'b' },
  ]);
  assert.deepEqual(rows, [
    { userId: 'a', displayName: 'Alex', team: 'Blue', role: 'Captain', handicapIndex: 8.1, rounds: 2, photoPath: null },
    { userId: 'b', displayName: 'Zoe', team: 'White', role: 'Player', handicapIndex: 12.4, rounds: 1, photoPath: 'b/avatar.webp' },
  ]);
});

test('member data loader requests itinerary, segments, rules, official stats, commentary, and the full trip range', () => {
  assert.match(supabaseScript, /tournaments\(id, name, slug, edition_year, status, starts_on, ends_on\)/);
  for (const table of [
    'tournament_events',
    'match_segments',
    'tournament_rules',
    'official_round_statistics',
    'match_commentaries',
  ]) {
    assert.match(supabaseScript, new RegExp(`from\\('${table}'\\)`), `missing ${table} query`);
  }
});

test('member loader and preview wire tournament and assignment isolation helpers', () => {
  assert.match(supabaseScript, /selectActiveTournament/);
  assert.match(supabaseScript, /const tournament = selectActiveTournament/);
  assert.match(supabaseScript, /\.eq\('tournament_id', tournament\.id\)/);
  assert.match(portalScript, /nextUpcomingAssignment/);
  assert.match(portalScript, /assignedSegmentsForPlayer/);
  assert.match(portalScript, /segmentRelationships/);
  assert.match(portalScript, /Partner/);
  assert.match(portalScript, /Opponent/);
});

test('scorecard labels rating categories and blocks net scoring when an official rating is unavailable', () => {
  assert.match(portalScript, /courseHandicapForTee/);
  assert.match(portalScript, /rating_category/);
  assert.match(portalScript, /Rating pending/);
  assert.match(portalScript, /A course rating and slope are required for net scoring/);
});

test('scorecard computes mixed gross/net segments with allowances and blocks team-score entry', () => {
  assert.match(portalScript, /scoreIndividualHoleForSegment/);
  assert.match(portalScript, /individualEntryBlockReason/);
  assert.match(formatsScript, /team-score scorecard/);
  assert.match(portalScript, /handicap_allowance/);
  assert.match(html, /id="adjustedLabel">ADJUSTED<\/small><strong id="netTotal">/);
  assert.match(html, /id="segmentSummaries"/);
  assert.match(portalScript, /segment-adjusted-subtotal/);
  assert.match(portalScript, /handicapAllowance/);
});

test('scorecard explains standalone gross play and assigned mixed segment scoring', () => {
  assert.match(html, /No assigned match uses a standalone gross scorecard/i);
  assert.match(html, /Assigned matches follow the format and gross or net scoring set for each hole range/i);
  assert.match(portalScript, /Course handicap is calculated from your index, tee rating, slope, and rating par/i);
  assert.match(portalScript, /Gross holes ignore handicap strokes; net holes apply the segment allowance/i);
});

test('mixed segment summaries stack at phone widths', () => {
  assert.match(html, /href="portal\.css\?v=handicap-scoring-1"/);
  assert.match(portalCss, /@media\(max-width:820px\)[\s\S]*#segmentSummaries\{grid-template-columns:1fr\}/);
});

test('course handicap display is calculated independently of gross or net segment mode', () => {
  assert.match(portalScript, /from '\.\/formats\.js\?v=handicap-scoring-1'/);
  assert.match(portalScript, /courseHandicapForTee\([^\n]+selectedTee, 'net'\)/);
  assert.doesNotMatch(portalScript, /courseHandicapForTee\([^\n]+selectedTee, selectedScoringMode\(\)\)/);
});

test('scorecard blocking and segment display use only the signed-in players assigned segments', () => {
  assert.match(portalScript, /return assignedSegmentsForPlayer\(matchSegments, session\.user\.id\)/);
  assert.match(portalScript, /individualEntryBlockReason\(selectedMatchSegments\(\)\)/);
});

test('player score saving is insert-only and explains immutable conflicts', () => {
  assert.doesNotMatch(supabaseScript, /from\('scores'\)\.upsert/);
  assert.doesNotMatch(supabaseScript, /from\('rounds'\)\.update\(roundPayload\)/);
  assert.match(supabaseScript, /from\('scores'\)\.insert\(rows\)/);
  assert.match(supabaseScript, /Submitted scores are locked/i);
  assert.match(html, /submitted scores are locked/i);
  assert.match(html, /administrator correction/i);
});

test('partial match scoring resumes from persisted immutable scores and submits only new holes', async () => {
  const { mergePersistedScores, unsavedScoreRows, assertRoundAssignment } = await import('../src/round-entry.js');
  const blank = Array.from({ length: 3 }, (_, index) => ({ hole_number: index + 1, gross_score: null }));
  const merged = mergePersistedScores(blank, [
    { id: 'score-1', hole_number: 1, gross_score: 4 },
    { id: 'score-2', hole_number: 2, gross_score: 5 },
  ]);
  merged[2].gross_score = 3;
  assert.deepEqual(merged.map(score => [score.gross_score, score.locked]), [[4, true], [5, true], [3, false]]);
  assert.deepEqual(unsavedScoreRows(merged), [{ hole_number: 3, gross_score: 3 }]);
  assert.doesNotThrow(() => assertRoundAssignment(
    { match_id: 'match-1', course_id: 'course-1', tee_id: 'tee-1' },
    { matchId: 'match-1', courseId: 'course-1', teeId: 'tee-1' },
  ));
  assert.throws(() => assertRoundAssignment(
    { match_id: 'match-1', course_id: 'course-1', tee_id: 'tee-1' },
    { matchId: 'match-1', courseId: 'course-1', teeId: 'tee-2' },
  ), /persisted course and tee/i);
});

test('standalone rounds can select 18 holes, the front nine, or the back nine', async () => {
  const { holeNumbersForRound } = await import('../src/round-entry.js');
  assert.deepEqual(holeNumbersForRound('18'), Array.from({ length: 18 }, (_, index) => index + 1));
  assert.deepEqual(holeNumbersForRound('front9'), Array.from({ length: 9 }, (_, index) => index + 1));
  assert.deepEqual(holeNumbersForRound('back9'), Array.from({ length: 9 }, (_, index) => index + 10));
});

test('assigned match segments determine the playable holes instead of the standalone selection', async () => {
  const { holeNumbersForRound } = await import('../src/round-entry.js');
  const segments = [
    { start_hole: 1, end_hole: 6 },
    { start_hole: 7, end_hole: 9 },
  ];
  assert.deepEqual(holeNumbersForRound('back9', segments), Array.from({ length: 9 }, (_, index) => index + 1));
});

test('scorecard setup includes an 18-hole, front-nine, and back-nine selector', () => {
  assert.match(html, /How many holes\?<select id="holeRangeSelect">/);
  assert.match(html, /<option value="18">18 holes<\/option>/);
  assert.match(html, /<option value="front9">Front 9 \(holes 1–9\)<\/option>/);
  assert.match(html, /<option value="back9">Back 9 \(holes 10–18\)<\/option>/);
  assert.match(portalScript, /holeNumbersForRound\(holeRangeSelect\.value, selectedMatchSegments\(\)\)/);
  assert.match(html, /src="src\/portal\.js\?v=automatic-match-completion-1"/);
  assert.match(portalScript, /from '\.\/round-entry\.js\?v=round-holes-1'/);
});

test('round score embeds name the intended foreign key after integrity hardening adds a second relationship', () => {
  const embeds = [...supabaseScript.matchAll(/scores(?:![a-z0-9_]+)?\(\*\)/g)].map(match => match[0]);
  assert.equal(embeds.length, 4);
  assert.deepEqual(new Set(embeds), new Set(['scores!scores_round_id_fkey(*)']));
});

test('score entry loads owned rounds and scores, excludes final matches, and binds course to assignment', () => {
  assert.match(supabaseScript, /from\('rounds'\)[\s\S]*scores!scores_round_id_fkey\(\*\)/);
  assert.match(portalScript, /match\.status === 'final'/);
  assert.match(portalScript, /courseSelect\.disabled = Boolean\(match\)/);
  assert.match(portalScript, /teeSelect\.disabled = !course \|\| Boolean\(existingRound\)/);
  assert.match(portalScript, /if \(matchSelect\.value\) teeSelect\.disabled = true/);
  assert.match(portalScript, /unsavedScoreRows/);
  assert.match(portalScript, /Submitted holes are locked\. Continue with the remaining holes\./);
});

test('member commentary distinguishes untouched AI copy from administrator edits', () => {
  assert.doesNotMatch(html, /id="commentaryCard"/);
  assert.match(portalScript, /commentaryForMatch\(playerData\.commentaries, match\.id\)/);
  assert.match(portalScript, /result-commentary/);
  assert.match(homeCss, /\.result-commentary/);
  assert.match(portalScript, /commentary\.ai_generated\s*\?/);
  assert.match(portalScript, /['"]AI-generated['"]/);
  assert.match(portalScript, /['"]Administrator edited['"]/);
  assert.doesNotMatch(portalScript, /Administrator approved/);
  assert.doesNotMatch(supabaseScript, /from\('match_commentaries'\)[\s\S]*?\.limit\(5\)/);
});

test('Cup loads tournament-wide matches while Home stays member-assignment scoped', () => {
  assert.match(supabaseScript, /from\('matches'\)[\s\S]*eq\('tournament_id', tournament\.id\)/);
  assert.match(supabaseScript, /matches: tournamentMatchesResult\.data/);
  assert.match(portalScript, /const matches = playerData\.matches/);
  assert.match(portalScript, /nextUpcomingAssignment\(playerData\.assignments\)/);
  assert.match(portalScript, /match_segment_players/);
});

test('member dashboard isolates one active 2027 tournament and a future non-final match', () => {
  const memberships = [
    { status: 'active', tournaments: { id: '2026', edition_year: 2026, status: 'complete' } },
    { status: 'active', tournaments: { id: '2027', edition_year: 2027, status: 'open' } },
  ];
  assert.equal(selectActiveTournament(memberships).id, '2027');

  assert.throws(() => selectActiveTournament([
    { status: 'active', tournaments: { id: 'a', edition_year: 2027, status: 'open' } },
    { status: 'active', tournaments: { id: 'b', edition_year: 2027, status: 'open' } },
  ]), /Multiple active 2027 tournaments/i);

  const next = nextUpcomingAssignment([
    { matches: { id: 'past', starts_at: '2027-03-01T12:00:00Z', status: 'scheduled' } },
    { matches: { id: 'final', starts_at: '2027-03-20T12:00:00Z', status: 'final' } },
    { matches: { id: 'next', starts_at: '2027-03-19T12:00:00Z', status: 'scheduled' } },
  ], new Date('2027-03-18T12:00:00Z'));
  assert.equal(next.matches.id, 'next');
});

test('next assignment retains a live match after its start time', () => {
  const next = nextUpcomingAssignment([
    { matches: { id: 'future', starts_at: '2027-03-19T12:00:00Z', status: 'scheduled' } },
    { matches: { id: 'live', starts_at: '2027-03-18T10:00:00Z', status: 'live' } },
    { matches: { id: 'past', starts_at: '2027-03-18T09:00:00Z', status: 'scheduled' } },
  ], new Date('2027-03-18T12:00:00Z'));
  assert.equal(next.matches.id, 'live');
});

test('member preview includes only assigned segments and labels partners and opponents', () => {
  const segment = {
    id: 'assigned',
    match_segment_players: [
      { user_id: 'me', side: 'cardinal', profiles: { display_name: 'Me' } },
      { user_id: 'partner', side: 'cardinal', profiles: { display_name: 'Partner' } },
      { user_id: 'opponent-1', side: 'silver', profiles: { display_name: 'Opponent One' } },
      { user_id: 'opponent-2', side: 'silver', profiles: { display_name: 'Opponent Two' } },
    ],
  };
  assert.deepEqual(assignedSegmentsForPlayer([segment, { id: 'other', match_segment_players: [] }], 'me'), [segment]);
  assert.deepEqual(segmentRelationships(segment, 'me'), {
    partners: ['Partner'],
    opponents: ['Opponent One', 'Opponent Two'],
  });
});
test('league statistics aggregate only the official rows supplied by the finalized-round view', () => {
  const summary = summarizeLeagueStats([
    { user_id: 'a', holes_played: 18, gross_total: 78, par_total: 72, to_par: 6 },
    { user_id: 'b', holes_played: 9, gross_total: 39, par_total: 36, to_par: 3 },
  ]);
  assert.deepEqual(summary, {
    rounds: 2,
    players: 2,
    holes: 27,
    averageToPar: 4.5,
    bestToPar: 3,
  });
});

test('player statistics isolate the signed-in player', () => {
  const rows = [
    { user_id: 'a', holes_played: 18, gross_total: 78, par_total: 72, to_par: 6 },
    { user_id: 'a', holes_played: 18, gross_total: 74, par_total: 72, to_par: 2 },
    { user_id: 'b', holes_played: 18, gross_total: 80, par_total: 72, to_par: 8 },
  ];
  assert.deepEqual(summarizePlayerStats(rows, 'a'), {
    rounds: 2,
    holes: 36,
    averageGross: 76,
    averageToPar: 4,
    bestToPar: 2,
  });
});
