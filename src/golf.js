export function calculateCourseHandicap(handicapIndex, slope, rating, par) {
  const values = [handicapIndex, slope, rating, par].map(Number);
  if (values.some(value => !Number.isFinite(value))) throw new TypeError('Course handicap inputs must be numbers');
  return Math.round(values[0] * (values[1] / 113) + (values[2] - values[3]));
}

export function handicapStrokesForHole(courseHandicap, strokeIndex) {
  const handicap = Math.max(0, Math.round(Number(courseHandicap)));
  const index = Number(strokeIndex);
  if (!Number.isInteger(index) || index < 1 || index > 18) throw new RangeError('Stroke index must be 1 through 18');
  return Math.floor(handicap / 18) + (index <= handicap % 18 ? 1 : 0);
}

export function netScore(grossScore, courseHandicap, strokeIndex) {
  const gross = Number(grossScore);
  if (!Number.isFinite(gross) || gross < 1) throw new RangeError('Gross score must be positive');
  return gross - handicapStrokesForHole(courseHandicap, strokeIndex);
}

export function scoreMatchHole({ format, scoringMode, strokeIndex, players }) {
  if (!['singles', 'fourball', 'foursomes'].includes(format)) throw new Error('Unsupported match format');
  if (!['gross', 'net'].includes(scoringMode)) throw new Error('Unsupported scoring mode');
  if (!Array.isArray(players) || players.length < 2) throw new Error('At least two scores are required');

  const baseline = scoringMode === 'net'
    ? Math.min(...players.map(player => Number(player.courseHandicap) || 0))
    : 0;

  const teamScores = { cardinal: [], silver: [] };
  for (const player of players) {
    if (!teamScores[player.team]) throw new Error('Every score requires a valid team');
    const adjustedHandicap = scoringMode === 'net'
      ? Math.max(0, (Number(player.courseHandicap) || 0) - baseline)
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
