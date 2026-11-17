import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyHoleResult,
  calculateTeamTotals,
  formatMatchStatus,
  matchPoints,
} from '../src/scoring.js';

test('applyHoleResult advances the winning team and records holes played', () => {
  const match = { differential: 0, holesPlayed: 0 };
  assert.deepEqual(applyHoleResult(match, 'cardinal'), {
    differential: 1,
    holesPlayed: 1,
  });
});

test('applyHoleResult leaves the differential unchanged for a halved hole', () => {
  const match = { differential: -2, holesPlayed: 7 };
  assert.deepEqual(applyHoleResult(match, 'halve'), {
    differential: -2,
    holesPlayed: 8,
  });
});

test('formatMatchStatus reports all square and Blue or White leads', () => {
  assert.equal(formatMatchStatus({ differential: 0, holesPlayed: 9 }), 'All Square');
  assert.equal(formatMatchStatus({ differential: 3, holesPlayed: 10 }), 'Blue 3 Up');
  assert.equal(formatMatchStatus({ differential: -1, holesPlayed: 17 }), 'White 1 Up');
});

test('formatMatchStatus closes a mathematically finished match', () => {
  assert.equal(formatMatchStatus({ differential: 3, holesPlayed: 16 }), 'Blue wins 3 & 2');
  assert.equal(formatMatchStatus({ differential: -2, holesPlayed: 17 }), 'White wins 2 & 1');
  assert.equal(formatMatchStatus({ differential: 2, holesPlayed: 18 }), 'Blue wins 2 Up');
});

test('matchPoints awards one point for a win and halves for a tie', () => {
  assert.deepEqual(matchPoints({ differential: 2, holesPlayed: 17 }), { cardinal: 1, silver: 0 });
  assert.deepEqual(matchPoints({ differential: 0, holesPlayed: 18 }), { cardinal: 0.5, silver: 0.5 });
  assert.deepEqual(matchPoints({ differential: -1, holesPlayed: 18 }), { cardinal: 0, silver: 1 });
  assert.deepEqual(matchPoints({ differential: 2, holesPlayed: 6 }), { cardinal: 0, silver: 0 });
});

test('calculateTeamTotals adds points from completed matches only', () => {
  const matches = [
    { differential: 3, holesPlayed: 16 },
    { differential: 0, holesPlayed: 18 },
    { differential: -1, holesPlayed: 18 },
    { differential: 2, holesPlayed: 8 },
  ];
  assert.deepEqual(calculateTeamTotals(matches), { cardinal: 1.5, silver: 1.5 });
});
