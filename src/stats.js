function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + Number(value), 0) / values.length;
}

function rounded(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}

export function summarizeLeagueStats(rows = []) {
  const toPar = rows.map(row => Number(row.to_par));
  return {
    rounds: rows.length,
    players: new Set(rows.map(row => row.user_id)).size,
    holes: rows.reduce((sum, row) => sum + Number(row.holes_played), 0),
    averageToPar: rounded(average(toPar)),
    bestToPar: toPar.length ? Math.min(...toPar) : null,
  };
}

export function summarizePlayerStats(rows = [], userId) {
  const playerRows = rows.filter(row => row.user_id === userId);
  const gross = playerRows.map(row => Number(row.gross_total));
  const toPar = playerRows.map(row => Number(row.to_par));
  return {
    rounds: playerRows.length,
    holes: playerRows.reduce((sum, row) => sum + Number(row.holes_played), 0),
    averageGross: rounded(average(gross)),
    averageToPar: rounded(average(toPar)),
    bestToPar: toPar.length ? Math.min(...toPar) : null,
  };
}
