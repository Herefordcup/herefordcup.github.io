import { applyHoleResult, formatMatchStatus, isMatchComplete } from './scoring.js';

const SCRAMBLE_WEIGHTS = {
  2: [0.35, 0.15],
  4: [0.25, 0.20, 0.15, 0.10],
};

export function scramblePlayingHandicap(courseHandicaps = []) {
  const weights = SCRAMBLE_WEIGHTS[courseHandicaps.length];
  if (!weights) throw new Error('A Texas Scramble squad must have exactly two or four players.');
  const ordered = courseHandicaps.map(Number);
  if (ordered.some(value => !Number.isFinite(value))) throw new Error('Every Course Handicap must be finite.');
  ordered.sort((left, right) => left - right);
  const weighted = ordered.reduce((total, handicap, index) => total + handicap * weights[index], 0);
  return Math.round(weighted);
}

export function scrambleNetScore({ grossTotal, playingHandicap }) {
  const gross = Number(grossTotal);
  const handicap = Number(playingHandicap);
  if (!Number.isFinite(gross) || !Number.isFinite(handicap)) throw new Error('Gross total and playing handicap must be finite.');
  return gross - handicap;
}

export function scrambleCupPoints({ netScore, par }) {
  const net = Number(netScore);
  const coursePar = Number(par);
  if (!Number.isFinite(net) || !Number.isFinite(coursePar)) throw new Error('Net score and par must be finite.');
  return Math.max(0, coursePar - net);
}

export function teeShotContributionCounts(entries = [], playerIds = []) {
  const counts = Object.fromEntries(playerIds.map(playerId => [playerId, 0]));
  for (const entry of entries) {
    const playerId = entry.teeShotPlayerId ?? entry.tee_shot_player_id;
    if (Object.hasOwn(counts, playerId)) counts[playerId] += 1;
  }
  return counts;
}

export function validateRequiredTeeShots({ entries = [], playerIds = [], minimum = 0 }) {
  const required = Number(minimum);
  if (!Number.isInteger(required) || required < 0) throw new Error('The tee-shot minimum must be a nonnegative integer.');
  const counts = teeShotContributionCounts(entries, playerIds);
  const missing = playerIds
    .filter(playerId => counts[playerId] < required)
    .map(playerId => ({ playerId, required, used: counts[playerId] }));
  return { ready: missing.length === 0, counts, missing };
}

export function summarizeHoleOutcomes(entries = [], { startHole = 1, endHole = 18 } = {}) {
  const start = Number(startHole);
  const end = Number(endHole);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 18 || end < start) {
    throw new Error('Hole outcomes require a valid configured range.');
  }
  const allowedWinners = new Set(['cardinal', 'silver', 'halved']);
  const seen = new Set();
  const totalHoles = end - start + 1;
  let match = { differential: 0, holesPlayed: 0 };
  for (const entry of [...entries].sort((left, right) => Number(left.holeNumber ?? left.hole_number) - Number(right.holeNumber ?? right.hole_number))) {
    const holeNumber = Number(entry.holeNumber ?? entry.hole_number);
    const winner = entry.winner;
    if (!Number.isInteger(holeNumber) || holeNumber < start || holeNumber > end) {
      throw new Error('Every hole outcome must be inside the configured range.');
    }
    if (seen.has(holeNumber)) throw new Error(`Duplicate outcome for hole ${holeNumber}.`);
    if (!allowedWinners.has(winner)) throw new Error('Every hole outcome winner must be cardinal, silver, or halved.');
    seen.add(holeNumber);
    match = applyHoleResult(match, winner, totalHoles);
  }
  return {
    differential: match.differential,
    holesPlayed: match.holesPlayed,
    totalHoles,
    complete: isMatchComplete(match, totalHoles),
    status: formatMatchStatus(match, totalHoles),
  };
}
