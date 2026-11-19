import test from 'node:test';
import assert from 'node:assert/strict';
import { commentaryForMatch, formatHomeDate, formatMatchupPlayers, orderHomeMatches } from '../src/home.js';

test('team matchup labels group teammates on the same side', () => {
  const players = [
    { team: 'cardinal', profiles: { display_name: 'Alex' } },
    { team: 'silver', profiles: { display_name: 'Jordan' } },
    { team: 'cardinal', profiles: { display_name: 'Casey' } },
    { team: 'silver', profiles: { display_name: 'Morgan' } },
  ];
  assert.equal(formatMatchupPlayers(players), 'Alex & Casey vs Jordan & Morgan');
});

test('singles matchup labels retain opponent separation when teams are unavailable', () => {
  const players = [
    { profiles: { display_name: 'Alex' } },
    { profiles: { display_name: 'Jordan' } },
  ];
  assert.equal(formatMatchupPlayers(players), 'Alex vs Jordan');
});

test('home match ordering shows live, then nearest scheduled, then latest finals', () => {
  const matches = [
    { id: 'old-final', status: 'final', starts_at: '2027-03-18T12:00:00Z' },
    { id: 'later', status: 'scheduled', starts_at: '2027-03-21T12:00:00Z' },
    { id: 'live', status: 'live', starts_at: '2027-03-19T12:00:00Z' },
    { id: 'new-final', status: 'final', starts_at: '2027-03-20T12:00:00Z' },
    { id: 'sooner', status: 'scheduled', starts_at: '2027-03-20T08:00:00Z' },
  ];
  assert.deepEqual(orderHomeMatches(matches).map(match => match.id), [
    'live', 'sooner', 'later', 'new-final', 'old-final',
  ]);
});

test('match results select only approved commentary for their exact match', () => {
  const commentaries = [
    { id: 'draft', match_id: 'match-1', status: 'draft', commentary: 'Not public' },
    { id: 'other', match_id: 'match-2', status: 'approved', commentary: 'Wrong match' },
    { id: 'approved', match_id: 'match-1', status: 'approved', commentary: 'The scorecard kept the receipts.' },
  ];
  assert.deepEqual(commentaryForMatch(commentaries, 'match-1'), commentaries[2]);
  assert.equal(commentaryForMatch(commentaries, 'missing'), null);
});

test('date-only tournament values stay on their published Eastern calendar date', () => {
  assert.match(formatHomeDate('2027-03-18', { year: 'numeric' }), /Mar 18, 2027/);
});
