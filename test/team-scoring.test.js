import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scrambleCupPoints,
  scrambleNetScore,
  scramblePlayingHandicap,
  summarizeHoleOutcomes,
  teeShotContributionCounts,
  validateRequiredTeeShots,
} from '../src/team-scoring.js';

test('four-player scramble handicap uses WHS 25/20/15/10 weighting from lowest to highest', () => {
  assert.equal(scramblePlayingHandicap([16, 4, 12, 8]), 6);
  assert.equal(scramblePlayingHandicap([-4, 16, 12, 8]), 4);
});

test('two-player scramble handicap uses WHS 35/15 weighting and rounds only the final sum', () => {
  assert.equal(scramblePlayingHandicap([20, 10]), 7);
  assert.equal(scramblePlayingHandicap([3, 9]), 2);
});

test('scramble handicap rejects unsupported squad sizes and invalid handicaps', () => {
  assert.throws(() => scramblePlayingHandicap([4, 8, 12]), /two or four/i);
  assert.throws(() => scramblePlayingHandicap([4, Number.NaN]), /finite/i);
});

test('scramble net score and Cup points award one point per stroke under net par', () => {
  assert.equal(scrambleNetScore({ grossTotal: 70, playingHandicap: 6 }), 64);
  assert.equal(scrambleCupPoints({ netScore: 64, par: 68 }), 4);
  assert.equal(scrambleCupPoints({ netScore: 68, par: 68 }), 0);
  assert.equal(scrambleCupPoints({ netScore: 72, par: 68 }), 0);
});

test('tee-shot contributions count only exact squad members', () => {
  const entries = [
    { holeNumber: 1, teeShotPlayerId: 'p1' },
    { holeNumber: 2, teeShotPlayerId: 'p2' },
    { holeNumber: 3, teeShotPlayerId: 'p1' },
    { holeNumber: 4, teeShotPlayerId: 'outsider' },
  ];
  assert.deepEqual(teeShotContributionCounts(entries, ['p1', 'p2']), { p1: 2, p2: 1 });
});

test('required tee shots fail closed until every squad member reaches the minimum', () => {
  const entries = [
    { holeNumber: 1, teeShotPlayerId: 'p1' },
    { holeNumber: 2, teeShotPlayerId: 'p2' },
    { holeNumber: 3, teeShotPlayerId: 'p1' },
  ];
  assert.deepEqual(validateRequiredTeeShots({ entries, playerIds: ['p1', 'p2'], minimum: 2 }), {
    ready: false,
    counts: { p1: 2, p2: 1 },
    missing: [{ playerId: 'p2', required: 2, used: 1 }],
  });
  assert.equal(validateRequiredTeeShots({
    entries: [...entries, { holeNumber: 4, teeShotPlayerId: 'p2' }],
    playerIds: ['p1', 'p2'],
    minimum: 2,
  }).ready, true);
});

test('hole-outcome summary closes match play mathematically without player scores', () => {
  const entries = [
    ...Array.from({ length: 10 }, (_, index) => ({ holeNumber: index + 1, winner: 'cardinal' })),
    ...Array.from({ length: 3 }, (_, index) => ({ holeNumber: index + 11, winner: 'halved' })),
  ];
  assert.deepEqual(summarizeHoleOutcomes(entries, { startHole: 1, endHole: 18 }), {
    differential: 10,
    holesPlayed: 13,
    totalHoles: 18,
    complete: true,
    status: 'Blue wins 10 & 5',
  });
});

test('hole-outcome summary rejects duplicate, out-of-range, or invalid outcomes', () => {
  assert.throws(() => summarizeHoleOutcomes([
    { holeNumber: 1, winner: 'cardinal' },
    { holeNumber: 1, winner: 'silver' },
  ], { startHole: 1, endHole: 9 }), /duplicate/i);
  assert.throws(() => summarizeHoleOutcomes([
    { holeNumber: 10, winner: 'cardinal' },
  ], { startHole: 1, endHole: 9 }), /configured range/i);
  assert.throws(() => summarizeHoleOutcomes([
    { holeNumber: 1, winner: 'blue' },
  ], { startHole: 1, endHole: 9 }), /winner/i);
});
