import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCourseHandicap,
  handicapStrokesForHole,
  netScore,
  scoreMatchHole,
} from '../src/golf.js';

test('calculateCourseHandicap uses rating, slope, par, and handicap index', () => {
  assert.equal(calculateCourseHandicap(12.4, 131, 71.2, 72), 14);
  assert.equal(calculateCourseHandicap(0, 113, 72, 72), 0);
});

test('handicapStrokesForHole allocates full rotations and the remainder by stroke index', () => {
  assert.equal(handicapStrokesForHole(20, 1), 2);
  assert.equal(handicapStrokesForHole(20, 2), 2);
  assert.equal(handicapStrokesForHole(20, 3), 1);
  assert.equal(handicapStrokesForHole(7, 8), 0);
});

test('netScore subtracts allocated handicap strokes in net play', () => {
  assert.equal(netScore(6, 20, 2), 4);
  assert.equal(netScore(5, 7, 8), 5);
});

test('scoreMatchHole scores singles using gross scores when selected', () => {
  const result = scoreMatchHole({
    format: 'singles',
    scoringMode: 'gross',
    strokeIndex: 4,
    players: [
      { team: 'cardinal', gross: 4, courseHandicap: 12 },
      { team: 'silver', gross: 5, courseHandicap: 20 },
    ],
  });
  assert.deepEqual(result, { winner: 'cardinal', cardinal: 4, silver: 5 });
});

test('scoreMatchHole applies handicaps in net match play', () => {
  const result = scoreMatchHole({
    format: 'singles',
    scoringMode: 'net',
    strokeIndex: 4,
    players: [
      { team: 'cardinal', gross: 4, courseHandicap: 12 },
      { team: 'silver', gross: 5, courseHandicap: 20 },
    ],
  });
  assert.deepEqual(result, { winner: 'halve', cardinal: 4, silver: 4 });
});

test('scoreMatchHole uses each team best ball for four-ball', () => {
  const result = scoreMatchHole({
    format: 'fourball',
    scoringMode: 'gross',
    strokeIndex: 8,
    players: [
      { team: 'cardinal', gross: 5, courseHandicap: 0 },
      { team: 'cardinal', gross: 4, courseHandicap: 0 },
      { team: 'silver', gross: 6, courseHandicap: 0 },
      { team: 'silver', gross: 5, courseHandicap: 0 },
    ],
  });
  assert.deepEqual(result, { winner: 'cardinal', cardinal: 4, silver: 5 });
});

test('scoreMatchHole accepts one alternate-shot score per team for foursomes', () => {
  const result = scoreMatchHole({
    format: 'foursomes',
    scoringMode: 'gross',
    strokeIndex: 12,
    players: [
      { team: 'cardinal', gross: 5, courseHandicap: 0 },
      { team: 'silver', gross: 4, courseHandicap: 0 },
    ],
  });
  assert.deepEqual(result, { winner: 'silver', cardinal: 5, silver: 4 });
});
