import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateCourseHandicap,
  handicapStrokesForHole,
  netScore,
  scoreIndividualHoleForSegment,
  scoreMatchHole,
} from '../src/golf.js';

test('calculateCourseHandicap uses rating, slope, par, and handicap index', () => {
  assert.equal(calculateCourseHandicap(12.4, 131, 71.2, 72), 14);
  assert.equal(calculateCourseHandicap(0, 113, 72, 72), 0);
});

test('calculateCourseHandicap rejects missing rating data instead of coercing null to zero', () => {
  assert.throws(() => calculateCourseHandicap(12.4, 139, null, 72), /must be numbers/);
  assert.throws(() => calculateCourseHandicap(12.4, '', 71.8, 72), /must be numbers/);
});

test('courseHandicapForTee permits gross play but blocks net play on an unrated tee', async () => {
  const { courseHandicapForTee } = await import('../src/golf.js');
  const unrated = { slope: null, rating: null, par: 72 };
  assert.equal(courseHandicapForTee(12.4, unrated, 'gross'), 0);
  assert.equal(courseHandicapForTee(12.4, unrated, 'net'), null);
  assert.equal(courseHandicapForTee(12.4, { slope: 139, rating: 71.8, par: 72 }, 'net'), 15);
});

test('courseHandicapForTee uses the rating-category par when it differs from scorecard par', async () => {
  const { courseHandicapForTee } = await import('../src/golf.js');
  assert.equal(courseHandicapForTee(0, { slope: 149, rating: 77.9, par: 70, rating_par: 72 }, 'net'), 6);
  assert.equal(courseHandicapForTee(0, { slope: 140, rating: 76.9, par: 72, rating_par: 73 }, 'net'), 4);
});

test('handicapStrokesForHole allocates full rotations and the remainder by stroke index', () => {
  assert.equal(handicapStrokesForHole(20, 1), 2);
  assert.equal(handicapStrokesForHole(20, 2), 2);
  assert.equal(handicapStrokesForHole(20, 3), 1);
  assert.equal(handicapStrokesForHole(7, 8), 0);
});

test('plus course handicaps add strokes back on the highest stroke-index holes', () => {
  assert.equal(handicapStrokesForHole(-2, 16), 0);
  assert.equal(handicapStrokesForHole(-2, 17), -1);
  assert.equal(handicapStrokesForHole(-2, 18), -1);
  assert.equal(handicapStrokesForHole(-20, 16), -1);
  assert.equal(handicapStrokesForHole(-20, 17), -2);
  assert.equal(handicapStrokesForHole(-20, 18), -2);
  assert.equal(netScore(4, -2, 18), 5);
});

test('netScore subtracts allocated handicap strokes in net play', () => {
  assert.equal(netScore(6, 20, 2), 4);
  assert.equal(netScore(5, 7, 8), 5);
});

test('mixed-segment display applies allowance only on net holes', () => {
  assert.equal(scoreIndividualHoleForSegment({
    grossScore: 5,
    strokeIndex: 1,
    courseHandicap: 20,
    segment: { scoring_mode: 'gross', handicap_allowance: null },
  }), 5);
  assert.equal(scoreIndividualHoleForSegment({
    grossScore: 5,
    strokeIndex: 1,
    courseHandicap: 20,
    segment: { scoring_mode: 'net', handicap_allowance: 50 },
  }), 4);
  assert.equal(scoreIndividualHoleForSegment({
    grossScore: 5,
    strokeIndex: 11,
    courseHandicap: 20,
    segment: { scoring_mode: 'net', handicap_allowance: 50 },
  }), 5);
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

test('scoreMatchHole supports scramble team scores with an explicit handicap allowance', () => {
  const result = scoreMatchHole({
    format: 'scramble',
    scoringMode: 'net',
    handicapAllowance: 50,
    strokeIndex: 1,
    players: [
      { team: 'cardinal', gross: 5, courseHandicap: 20 },
      { team: 'silver', gross: 5, courseHandicap: 10 },
    ],
  });
  assert.deepEqual(result, { winner: 'cardinal', cardinal: 4, silver: 5 });
});
