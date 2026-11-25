import { scoreMatchHole } from './golf.js';
import { formatMatchStatus, isMatchComplete } from './scoring.js';

const AUTOMATIC_FORMATS = new Set(['singles', 'fourball']);
const WAITING_REASON = 'All assigned players must submit every score for this segment.';

function roundForPlayer(rounds, matchId, userId) {
  const matches = rounds.filter(round => round.match_id === matchId && round.user_id === userId);
  return matches.length === 1 ? matches[0] : null;
}

function scoreForHole(round, holeNumber) {
  return round.scores?.find(score => Number(score.hole_number) === holeNumber) ?? null;
}

function strokeIndexForHole(round, holeNumber) {
  const hole = round.tees?.holes?.find(item => Number(item.hole_number) === holeNumber);
  return hole?.stroke_index;
}

export function deriveSegmentResult({ segment, rounds }) {
  if (segment.format === 'scramble') {
    if (segment.status !== 'final') {
      return {
        mode: 'waiting',
        reason: 'Waiting for the shared Texas Scramble scorecard and tee-shot requirements.',
      };
    }
    const points = Number(segment.point_value);
    return {
      mode: 'automatic',
      differential: Number(segment.differential),
      holes_played: Number(segment.holes_played),
      label: `${Number(segment.differential) > 0 ? 'Blue' : 'White'} earns ${points} Cup point${points === 1 ? '' : 's'}`,
    };
  }

  if (segment.entry_mode === 'hole_outcomes') {
    if (segment.status !== 'final') {
      return {
        mode: 'waiting',
        reason: 'Waiting for the assigned players to record the required hole outcomes.',
      };
    }
    const differential = Number(segment.differential);
    const holesPlayed = Number(segment.holes_played);
    const totalHoles = Number(segment.end_hole) - Number(segment.start_hole) + 1;
    return {
      mode: 'automatic',
      differential,
      holes_played: holesPlayed,
      label: formatMatchStatus({ differential, holesPlayed }, totalHoles),
    };
  }

  if (!AUTOMATIC_FORMATS.has(segment.format)) {
    return {
      mode: 'manual',
      reason: 'This team-score format still requires an administrator-entered match-play result.',
    };
  }

  const assignments = segment.match_segment_players ?? [];
  const expectedPerTeam = segment.format === 'singles' ? 1 : 2;
  const assignedRounds = assignments.map(assignment => ({
    assignment,
    round: roundForPlayer(rounds, segment.match_id, assignment.user_id),
  }));
  if (assignedRounds.length !== expectedPerTeam * 2
      || assignedRounds.filter(item => item.assignment.side === 'cardinal').length !== expectedPerTeam
      || assignedRounds.filter(item => item.assignment.side === 'silver').length !== expectedPerTeam
      || assignedRounds.some(item => !item.round)) {
    return { mode: 'waiting', reason: WAITING_REASON };
  }
  if (segment.scoring_mode === 'net' && assignedRounds.some(({ round }) => (
    round.course_handicap === null
    || round.course_handicap === ''
    || !Number.isFinite(Number(round.course_handicap))
  ))) {
    return {
      mode: 'waiting',
      reason: 'Net results require a finite course handicap for every assigned round.',
    };
  }

  for (let holeNumber = Number(segment.start_hole); holeNumber <= Number(segment.end_hole); holeNumber += 1) {
    if (assignedRounds.some(item => !scoreForHole(item.round, holeNumber))) {
      return { mode: 'waiting', reason: WAITING_REASON };
    }
  }

  const totalHoles = Number(segment.end_hole) - Number(segment.start_hole) + 1;
  let differential = 0;
  let holesPlayed = 0;
  for (let holeNumber = Number(segment.start_hole); holeNumber <= Number(segment.end_hole); holeNumber += 1) {
    const rawStrokeIndexes = assignedRounds.map(item => strokeIndexForHole(item.round, holeNumber));
    if (segment.scoring_mode === 'net' && rawStrokeIndexes.some(index => (
      index === null
      || index === undefined
      || index === ''
      || !Number.isInteger(Number(index))
      || Number(index) < 1
      || Number(index) > 18
    ))) {
      return {
        mode: 'waiting',
        reason: 'Net results require a valid stroke index from 1 through 18 for every assigned round.',
      };
    }
    const strokeIndexes = rawStrokeIndexes.map(Number);
    if (segment.scoring_mode === 'net'
        && (strokeIndexes.some(index => !Number.isInteger(index)) || new Set(strokeIndexes).size !== 1)) {
      return {
        mode: 'waiting',
        reason: 'Net results require matching hole stroke indexes for every submitted round.',
      };
    }
    const result = scoreMatchHole({
      format: segment.format,
      scoringMode: segment.scoring_mode,
      strokeIndex: segment.scoring_mode === 'net' ? strokeIndexes[0] : holeNumber,
      handicapAllowance: segment.handicap_allowance ?? 100,
      players: assignedRounds.map(({ assignment, round }) => ({
        team: assignment.side,
        gross: Number(scoreForHole(round, holeNumber).gross_score),
        courseHandicap: Number(round.course_handicap),
      })),
    });
    differential += result.winner === 'cardinal' ? 1 : result.winner === 'silver' ? -1 : 0;
    holesPlayed += 1;
    if (isMatchComplete({ differential, holesPlayed }, totalHoles)) break;
  }

  return {
    mode: 'automatic',
    differential,
    holes_played: holesPlayed,
    label: formatMatchStatus({ differential, holesPlayed }, totalHoles),
  };
}
