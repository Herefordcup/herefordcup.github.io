export function holeNumbersForRound(selection = '18', segments = []) {
  if (segments.length) {
    return [...new Set(segments.flatMap(segment => Array.from(
      { length: Number(segment.end_hole) - Number(segment.start_hole) + 1 },
      (_, index) => Number(segment.start_hole) + index,
    )))].filter(hole => hole >= 1 && hole <= 18).sort((a, b) => a - b);
  }
  const start = selection === 'back9' ? 10 : 1;
  const count = selection === '18' ? 18 : 9;
  return Array.from({ length: count }, (_, index) => start + index);
}

export function mergePersistedScores(blankScores, persistedScores = []) {
  const persistedByHole = new Map(persistedScores.map(score => [Number(score.hole_number), score]));
  return blankScores.map(score => {
    const persisted = persistedByHole.get(Number(score.hole_number));
    return persisted
      ? { ...score, ...persisted, gross_score: Number(persisted.gross_score), locked: true }
      : { ...score, locked: false };
  });
}

export function unsavedScoreRows(scores = []) {
  return scores
    .filter(score => !score.locked && Number(score.gross_score) > 0)
    .map(score => ({ hole_number: Number(score.hole_number), gross_score: Number(score.gross_score) }));
}

export function assertRoundAssignment(existingRound, { matchId, courseId, teeId }) {
  if (!existingRound) return;
  if (existingRound.match_id !== matchId
    || existingRound.course_id !== courseId
    || existingRound.tee_id !== teeId) {
    throw new Error('This round must keep its persisted course and tee. Reload the assigned match and try again.');
  }
}
