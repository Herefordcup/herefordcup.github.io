import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHomeDate,
  formatMatchupPlayers,
  formatTripDateRange,
  groupScheduleEventsByDay,
  orderHomeMatches,
} from '../src/home.js';

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

test('date-only tournament values stay on their published Eastern calendar date', () => {
  assert.match(formatHomeDate('2027-03-18', { year: 'numeric' }), /Mar 18, 2027/);
});

test('trip date range describes the complete tournament instead of one day', () => {
  assert.equal(formatTripDateRange('2027-03-18', '2027-03-21'), 'March 18–21, 2027');
});

test('itinerary events are grouped into clearly labeled Eastern-time days', () => {
  const groups = groupScheduleEventsByDay([
    { id: 'friday', starts_at: '2027-03-19T12:00:00Z' },
    { id: 'thursday-evening', starts_at: '2027-03-19T00:00:00Z' },
    { id: 'thursday-afternoon', starts_at: '2027-03-18T17:00:00Z' },
  ]);

  assert.deepEqual(groups.map(group => ({
    key: group.key,
    label: group.label,
    ids: group.events.map(event => event.id),
  })), [
    { key: '2027-03-18', label: 'Thursday · March 18', ids: ['thursday-afternoon', 'thursday-evening'] },
    { key: '2027-03-19', label: 'Friday · March 19', ids: ['friday'] },
  ]);
});
