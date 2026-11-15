const TOTAL_HOLES = 18;

export function isMatchComplete({ differential, holesPlayed }) {
  const holesRemaining = TOTAL_HOLES - holesPlayed;
  return holesPlayed >= TOTAL_HOLES || Math.abs(differential) > holesRemaining;
}

export function applyHoleResult(match, result) {
  const movement = result === 'cardinal' ? 1 : result === 'silver' ? -1 : 0;
  return {
    differential: match.differential + movement,
    holesPlayed: Math.min(TOTAL_HOLES, match.holesPlayed + 1),
  };
}

export function formatMatchStatus({ differential, holesPlayed }) {
  if (differential === 0) {
    return holesPlayed >= TOTAL_HOLES ? 'Match Halved' : 'All Square';
  }

  const team = differential > 0 ? 'Cardinal' : 'Silver';
  const lead = Math.abs(differential);
  const holesRemaining = TOTAL_HOLES - holesPlayed;

  if (isMatchComplete({ differential, holesPlayed })) {
    if (holesPlayed >= TOTAL_HOLES) return `${team} wins ${lead} Up`;
    return `${team} wins ${lead} & ${holesRemaining}`;
  }

  return `${team} ${lead} Up`;
}

export function matchPoints(match) {
  if (!isMatchComplete(match)) return { cardinal: 0, silver: 0 };
  if (match.differential === 0) return { cardinal: 0.5, silver: 0.5 };
  return match.differential > 0
    ? { cardinal: 1, silver: 0 }
    : { cardinal: 0, silver: 1 };
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
