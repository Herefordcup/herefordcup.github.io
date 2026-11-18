import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { summarizeLeagueStats, summarizePlayerStats } from '../src/stats.js';
import {
  assignedSegmentsForPlayer,
  nextUpcomingAssignment,
  playerDirectoryEntries,
  segmentRelationships,
  selectActiveTournament,
} from '../src/member.js';

const html = await readFile(new URL('../portal.html', import.meta.url), 'utf8');
const portalScript = await readFile(new URL('../src/portal.js', import.meta.url), 'utf8');
const supabaseScript = await readFile(new URL('../src/supabase.js', import.meta.url), 'utf8');
const formatsScript = await readFile(new URL('../src/formats.js', import.meta.url), 'utf8');

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
});

test('More includes a tournament player directory without private contact data', () => {
  assert.match(html, /id="playersList"/);
  assert.match(html, />Players</);
  assert.match(supabaseScript, /profiles!tournament_memberships_user_id_fkey\(display_name, handicap_index, profile_photo_path\)/);
  assert.match(portalScript, /from '\.\/supabase\.js\?v=member-directory-1'/);
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

test('member data loader requests itinerary, segments, rules, official stats, and commentary', () => {
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
  assert.doesNotMatch(html, /CUP COMMENTATOR · AI-GENERATED/);
  assert.match(portalScript, /latest\.ai_generated\s*\?/);
  assert.match(portalScript, /AI-generated · Administrator approved/);
  assert.match(portalScript, /Administrator edited · Administrator approved/);
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
