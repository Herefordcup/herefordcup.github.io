export function calculateCourseHandicap(handicapIndex, slope, rating, par) {
  const inputs = [handicapIndex, slope, rating, par];
  if (inputs.some(value => value === null || value === undefined || value === '')) {
    throw new TypeError('Course handicap inputs must be numbers');
  }
  const values = inputs.map(Number);
  if (values.some(value => !Number.isFinite(value))) throw new TypeError('Course handicap inputs must be numbers');
  return Math.round(values[0] * (values[1] / 113) + (values[2] - values[3]));
}

export function courseHandicapForTee(handicapIndex, tee, scoringMode = 'net') {
  if (scoringMode === 'gross') return 0;
  if (!tee || tee.rating === null || tee.rating === undefined || tee.slope === null || tee.slope === undefined) return null;
  const ratingPar = tee.rating_par ?? tee.ratingPar ?? tee.par;
  return calculateCourseHandicap(handicapIndex, tee.slope, tee.rating, ratingPar);
}

export function handicapStrokesForHole(courseHandicap, strokeIndex) {
  const handicap = Math.round(Number(courseHandicap));
  const index = Number(strokeIndex);
  if (!Number.isInteger(index) || index < 1 || index > 18) throw new RangeError('Stroke index must be 1 through 18');
  if (handicap >= 0) return Math.floor(handicap / 18) + (index <= handicap % 18 ? 1 : 0);
  const plusHandicap = Math.abs(handicap);
  const strokesGiven = Math.floor(plusHandicap / 18) + (index > 18 - (plusHandicap % 18) ? 1 : 0);
  return strokesGiven ? -strokesGiven : 0;
}

export function netScore(grossScore, courseHandicap, strokeIndex) {
  const gross = Number(grossScore);
  if (!Number.isFinite(gross) || gross < 1) throw new RangeError('Gross score must be positive');
  return gross - handicapStrokesForHole(courseHandicap, strokeIndex);
}

export function scoreIndividualHoleForSegment({ grossScore, strokeIndex, courseHandicap, segment }) {
  if (segment?.scoring_mode === 'gross') return Number(grossScore);
  if (segment?.scoring_mode !== 'net') throw new Error('Segment must use gross or net scoring');
  const allowance = Number(segment.handicap_allowance);
  if (!Number.isFinite(allowance) || allowance < 0 || allowance > 100) {
    throw new Error('Net segment requires a handicap allowance from 0 through 100 percent');
  }
  const allowedHandicap = Math.round(Number(courseHandicap) * allowance / 100);
  return netScore(grossScore, allowedHandicap, strokeIndex);
}

export function scoreMatchHole({ format, scoringMode, strokeIndex, players, handicapAllowance = 100 }) {
  if (!['singles', 'fourball', 'foursomes', 'scramble', 'shamble', 'chapman'].includes(format)) throw new Error('Unsupported match format');
  if (!['gross', 'net'].includes(scoringMode)) throw new Error('Unsupported scoring mode');
  if (!Array.isArray(players) || players.length < 2) throw new Error('At least two scores are required');
  const allowance = Number(handicapAllowance);
  if (!Number.isFinite(allowance) || allowance < 0 || allowance > 100) throw new Error('Handicap allowance must be 0 through 100 percent');
  const allowedHandicap = player => Math.round((Number(player.courseHandicap) || 0) * allowance / 100);

  const baseline = scoringMode === 'net'
    ? Math.min(...players.map(allowedHandicap))
    : 0;

  const teamScores = { cardinal: [], silver: [] };
  for (const player of players) {
    if (!teamScores[player.team]) throw new Error('Every score requires a valid team');
    const adjustedHandicap = scoringMode === 'net'
      ? Math.max(0, allowedHandicap(player) - baseline)
      : 0;
    const score = scoringMode === 'net'
      ? netScore(player.gross, adjustedHandicap, strokeIndex)
      : Number(player.gross);
    teamScores[player.team].push(score);
  }

  if (!teamScores.cardinal.length || !teamScores.silver.length) throw new Error('Both teams require a score');
  const cardinal = Math.min(...teamScores.cardinal);
  const silver = Math.min(...teamScores.silver);
  const winner = cardinal === silver ? 'halve' : cardinal < silver ? 'cardinal' : 'silver';
  return { winner, cardinal, silver };
}
