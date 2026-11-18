import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignedRoundScoringMode,
  formatSegmentLabel,
  segmentHoleCount,
  validateSegments,
} from '../src/formats.js';
import {
  formatMatchStatus,
  isMatchComplete,
  matchPoints,
} from '../src/scoring.js';

test('nine-hole segment completion uses its own hole count', () => {
  assert.equal(isMatchComplete({ differential: 2, holesPlayed: 8 }, 9), true);
  assert.equal(formatMatchStatus({ differential: 2, holesPlayed: 8 }, 9), 'Blue wins 2 & 1');
  assert.deepEqual(matchPoints({ differential: 0, holesPlayed: 9 }, 9, 0.5), {
    cardinal: 0.25,
    silver: 0.25,
  });
});

test('segment hole count supports front and back nine ranges', () => {
  assert.equal(segmentHoleCount({ startHole: 1, endHole: 9 }), 9);
  assert.equal(segmentHoleCount({ startHole: 10, endHole: 18 }), 9);
});

test('segment labels describe hole range, format, scoring, and points', () => {
  assert.equal(formatSegmentLabel({
    startHole: 10,
    endHole: 18,
    format: 'fourball',
    scoringMode: 'net',
    handicapAllowance: 90,
    pointValue: 0.5,
  }), 'Holes 10–18 · Four-Ball · Net · 90% allowance · 0.5 pts');
});

test('assigned segments determine whether a player round needs net scoring', () => {
  assert.equal(assignedRoundScoringMode({ scoring_mode: 'net' }, [{ scoring_mode: 'gross' }]), 'gross');
  assert.equal(assignedRoundScoringMode({ scoring_mode: 'gross' }, [{ scoring_mode: 'gross' }, { scoring_mode: 'net' }]), 'net');
  assert.equal(assignedRoundScoringMode({ scoring_mode: 'net' }, []), 'net');
});

test('segments may change formats and lineups at a boundary', () => {
  const segments = [
    {
      startHole: 1,
      endHole: 9,
      format: 'scramble',
      scoringMode: 'net',
      pointValue: 0.5,
      handicapAllowance: 35,
      players: [
        { userId: 'a', team: 'cardinal', side: 'cardinal', playingOrder: 1 },
        { userId: 'b', team: 'cardinal', side: 'cardinal', playingOrder: 2 },
        { userId: 'c', team: 'silver', side: 'silver', playingOrder: 3 },
        { userId: 'd', team: 'silver', side: 'silver', playingOrder: 4 },
      ],
    },
    {
      startHole: 10,
      endHole: 18,
      format: 'fourball',
      scoringMode: 'net',
      pointValue: 0.5,
      handicapAllowance: 90,
      players: [
        { userId: 'a', team: 'cardinal', side: 'cardinal', playingOrder: 1 },
        { userId: 'c', team: 'silver', side: 'cardinal', playingOrder: 2 },
        { userId: 'b', team: 'cardinal', side: 'silver', playingOrder: 3 },
        { userId: 'd', team: 'silver', side: 'silver', playingOrder: 4 },
      ],
    },
  ];

  assert.deepEqual(validateSegments(segments), []);
});

test('segment sides use the persisted Cardinal or Silver values', () => {
  const errors = validateSegments([{
    startHole: 1,
    endHole: 18,
    format: 'singles',
    scoringMode: 'gross',
    pointValue: 1,
    handicapAllowance: null,
    players: [{ userId: 'a', team: 'cardinal', side: 1 }],
  }]);
  assert.ok(errors.some(error => error.includes('invalid player team or side')));
});
test('segment lineups require format cardinality, both sides, and unique playing orders', () => {
  const singles = {
    startHole: 1,
    endHole: 18,
    format: 'singles',
    scoringMode: 'gross',
    pointValue: 1,
    handicapAllowance: null,
    players: [
      { userId: 'a', team: 'cardinal', side: 'cardinal', playingOrder: 1 },
      { userId: 'b', team: 'cardinal', side: 'cardinal', playingOrder: 1 },
    ],
  };
  const errors = validateSegments([singles]);
  assert.ok(errors.some(error => error.includes('exactly 1 player per side')));
  assert.ok(errors.some(error => error.includes('unique playing order')));
});

test('segment lineups reject the default unassigned state', () => {
  const errors = validateSegments([{
    startHole: 1,
    endHole: 18,
    format: 'singles',
    scoringMode: 'gross',
    handicapAllowance: null,
    pointValue: 1,
    players: [],
  }]);
  assert.match(errors.join(' '), /exactly 1 player per side/i);
});
test('individual score entry blocks team-score formats with a clear reason', async () => {
  const { individualEntryBlockReason } = await import('../src/formats.js');
  assert.match(individualEntryBlockReason([{ format: 'scramble' }]), /team-score scorecard/i);
  assert.match(individualEntryBlockReason([{ format: 'foursomes' }]), /team-score scorecard/i);
  assert.match(individualEntryBlockReason([{ format: 'chapman' }]), /team-score scorecard/i);
  assert.equal(individualEntryBlockReason([{ format: 'singles' }, { format: 'fourball' }]), null);
});

test('segments reject overlaps, gaps, and missing handicap allowances', () => {
  const errors = validateSegments([
    {
      startHole: 1,
      endHole: 10,
      format: 'scramble',
      scoringMode: 'net',
      pointValue: 0.5,
      handicapAllowance: null,
      players: [],
    },
    {
      startHole: 10,
      endHole: 18,
      format: 'fourball',
      scoringMode: 'gross',
      pointValue: 0.5,
      handicapAllowance: 100,
      players: [],
    },
  ]);

  assert.ok(errors.some(error => error.includes('overlap')));
  assert.ok(errors.some(error => error.includes('handicap allowance')));
});
