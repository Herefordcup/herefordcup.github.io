const TOTAL_HOLES = 18;

export function isMatchComplete({ differential, holesPlayed }, totalHoles = TOTAL_HOLES) {
  const holesRemaining = totalHoles - holesPlayed;
  return holesPlayed >= totalHoles || Math.abs(differential) > holesRemaining;
}

export function applyHoleResult(match, result, totalHoles = TOTAL_HOLES) {
  const movement = result === 'cardinal' ? 1 : result === 'silver' ? -1 : 0;
  return {
    differential: match.differential + movement,
    holesPlayed: Math.min(totalHoles, match.holesPlayed + 1),
  };
}

export function formatMatchStatus({ differential, holesPlayed }, totalHoles = TOTAL_HOLES) {
  if (differential === 0) {
    return holesPlayed >= totalHoles ? 'Match Halved' : 'All Square';
  }

  const team = differential > 0 ? 'Cardinal' : 'Silver';
  const lead = Math.abs(differential);
  const holesRemaining = totalHoles - holesPlayed;

  if (isMatchComplete({ differential, holesPlayed }, totalHoles)) {
    if (holesPlayed >= totalHoles) return `${team} wins ${lead} Up`;
    return `${team} wins ${lead} & ${holesRemaining}`;
  }

  return `${team} ${lead} Up`;
}

export function matchPoints(match, totalHoles = TOTAL_HOLES, pointValue = 1) {
  if (!isMatchComplete(match, totalHoles)) return { cardinal: 0, silver: 0 };
  if (match.differential === 0) return { cardinal: pointValue / 2, silver: pointValue / 2 };
  return match.differential > 0
    ? { cardinal: pointValue, silver: 0 }
    : { cardinal: 0, silver: pointValue };
}

export function calculateTeamTotals(matches) {
  return matches.reduce(
    (totals, match) => {
      const points = matchPoints(match);
      totals.cardinal += points.cardinal;
      totals.silver += points.silver;
      return totals;
    },
    { cardinal: 0, silver: 0 },
  );
}
