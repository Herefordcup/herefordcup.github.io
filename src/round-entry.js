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
