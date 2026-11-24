import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveSegmentResult } from '../src/match-results.js';

const jose = 'jose';
const matthew = 'matthew';

function scores(values) {
  return values.map((gross_score, index) => ({ hole_number: index + 1, gross_score }));
}

function fixture(joseScores, matthewScores) {
  return {
    segment: {
      id: 'segment-1',
      match_id: 'match-1',
      start_hole: 1,
      end_hole: 18,
      format: 'singles',
      scoring_mode: 'gross',
      handicap_allowance: null,
      match_segment_players: [
        { user_id: jose, team: 'cardinal', side: 'cardinal' },
        { user_id: matthew, team: 'silver', side: 'silver' },
      ],
    },
    rounds: [
      { match_id: 'match-1', user_id: jose, course_handicap: 0, scores: scores(joseScores) },
      { match_id: 'match-1', user_id: matthew, course_handicap: 0, scores: scores(matthewScores) },
    ],
  };
}

function makeNet(data, strokeIndexesForRound) {
  data.segment.scoring_mode = 'net';
  data.segment.handicap_allowance = 100;
  data.rounds.forEach((round, roundIndex) => {
    round.tees = {
      holes: Array.from({ length: 18 }, (_, index) => ({
        hole_number: index + 1,
        stroke_index: strokeIndexesForRound(roundIndex, index),
      })),
    };
  });
  return data;
}

test('derives a White match-play win from completed submitted scores', () => {
  const data = fixture([4, ...Array(17).fill(5)], [...Array(9).fill(4), ...Array(9).fill(5)]);
  assert.deepEqual(deriveSegmentResult(data), {
    mode: 'automatic',
    differential: -8,
    holes_played: 11,
    label: 'White wins 8 & 7',
  });
});

test('derives a halved match from tied submitted scores', () => {
  const tied = [...Array(5).fill(4), ...Array(13).fill(5)];
  const data = fixture(tied, tied);
  assert.deepEqual(deriveSegmentResult(data), {
    mode: 'automatic',
    differential: 0,
    holes_played: 18,
    label: 'Match Halved',
  });
});

test('derives a Blue match-play win from completed submitted scores', () => {
  const data = fixture([...Array(7).fill(4), ...Array(11).fill(5)], Array(18).fill(5));
  assert.deepEqual(deriveSegmentResult(data), {
    mode: 'automatic',
    differential: 7,
    holes_played: 12,
    label: 'Blue wins 7 & 6',
  });
});

test('derives the match result from segment sides when tournament teams diverge', () => {
  const data = fixture([...Array(7).fill(4), ...Array(11).fill(5)], Array(18).fill(5));
  data.segment.match_segment_players[0].team = 'silver';
  data.segment.match_segment_players[1].team = 'cardinal';
  assert.deepEqual(deriveSegmentResult(data), {
    mode: 'automatic',
    differential: 7,
    holes_played: 12,
    label: 'Blue wins 7 & 6',
  });
});

test('waits instead of accepting a manual result when an individual score is missing', () => {
  const data = fixture(Array(18).fill(5), Array(17).fill(5));
  assert.deepEqual(deriveSegmentResult(data), {
    mode: 'waiting',
    reason: 'All assigned players must submit every score for this segment.',
  });
});

test('waits instead of treating a missing net course handicap as zero', () => {
  const data = fixture(Array(18).fill(5), Array(18).fill(5));
  data.segment.scoring_mode = 'net';
  data.rounds[0].course_handicap = null;
  for (const round of data.rounds) {
    round.tees = {
      holes: Array.from({ length: 18 }, (_, index) => ({
        hole_number: index + 1,
        stroke_index: index + 1,
      })),
    };
  }
  assert.deepEqual(deriveSegmentResult(data), {
    mode: 'waiting',
    reason: 'Net results require a finite course handicap for every assigned round.',
  });
});

test('waits without throwing when every net stroke index is null', () => {
  const data = makeNet(fixture(Array(18).fill(5), Array(18).fill(5)), () => null);
  assert.deepEqual(deriveSegmentResult(data), {
    mode: 'waiting',
    reason: 'Net results require a valid stroke index from 1 through 18 for every assigned round.',
  });
});

test('waits when any assigned round has a null net stroke index', () => {
  const data = makeNet(
    fixture(Array(18).fill(5), Array(18).fill(5)),
    (roundIndex, holeIndex) => (roundIndex === 0 && holeIndex === 0 ? null : holeIndex + 1),
  );
  assert.deepEqual(deriveSegmentResult(data), {
    mode: 'waiting',
    reason: 'Net results require a valid stroke index from 1 through 18 for every assigned round.',
  });
});

test('waits without throwing for out-of-range net stroke indexes', () => {
  for (const invalidIndex of [0, 19]) {
    const data = makeNet(
      fixture(Array(18).fill(5), Array(18).fill(5)),
      (_roundIndex, holeIndex) => (holeIndex === 0 ? invalidIndex : holeIndex + 1),
    );
    assert.deepEqual(deriveSegmentResult(data), {
      mode: 'waiting',
      reason: 'Net results require a valid stroke index from 1 through 18 for every assigned round.',
    });
  }
});

test('waits instead of offering manual finalization for mismatched net stroke indexes', () => {
  const data = makeNet(
    fixture(Array(18).fill(5), Array(18).fill(5)),
    (roundIndex, holeIndex) => (roundIndex === 1 && holeIndex === 0 ? 2 : holeIndex + 1),
  );
  assert.deepEqual(deriveSegmentResult(data), {
    mode: 'waiting',
    reason: 'Net results require matching hole stroke indexes for every submitted round.',
  });
});

test('waits for a complete four-ball lineup before deriving an automatic result', () => {
  const data = fixture(Array(18).fill(4), Array(18).fill(5));
  data.segment.format = 'fourball';
  assert.deepEqual(deriveSegmentResult(data), {
    mode: 'waiting',
    reason: 'All assigned players must submit every score for this segment.',
  });
});

test('keeps a manual authoritative result for team-score formats', () => {
  const data = fixture(Array(18).fill(5), Array(18).fill(5));
  data.segment.format = 'foursomes';
  assert.deepEqual(deriveSegmentResult(data), {
    mode: 'manual',
    reason: 'This team-score format still requires an administrator-entered match-play result.',
  });
});

test('renders the persisted authoritative Texas Scramble points instead of offering manual finalization', () => {
  const data = fixture([], []);
  Object.assign(data.segment, {
    format: 'scramble',
    status: 'final',
    differential: -1,
    holes_played: 18,
    point_value: 4,
  });
  assert.deepEqual(deriveSegmentResult(data), {
    mode: 'automatic',
    differential: -1,
    holes_played: 18,
    label: 'White earns 4 Cup points',
  });
});

test('waits for the shared Texas Scramble scorecard when the squad is not final', () => {
  const data = fixture([], []);
  Object.assign(data.segment, { format: 'scramble', status: 'live', point_value: 0 });
  assert.deepEqual(deriveSegmentResult(data), {
    mode: 'waiting',
    reason: 'Waiting for the shared Texas Scramble scorecard and tee-shot requirements.',
  });
});

test('renders a persisted outcome-only result without requiring individual rounds', () => {
  const data = fixture([], []);
  Object.assign(data.segment, {
    entry_mode: 'hole_outcomes',
    status: 'final',
    differential: 3,
    holes_played: 16,
  });
  assert.deepEqual(deriveSegmentResult(data), {
    mode: 'automatic',
    differential: 3,
    holes_played: 16,
    label: 'Blue wins 3 & 2',
  });
});

test('waits for outcome-only hole winners when the segment is not final', () => {
  const data = fixture([], []);
  Object.assign(data.segment, { entry_mode: 'hole_outcomes', status: 'live' });
  assert.deepEqual(deriveSegmentResult(data), {
    mode: 'waiting',
    reason: 'Waiting for the assigned players to record the required hole outcomes.',
  });
});
