const FORMAT_LABELS = {
  singles: 'Singles',
  fourball: 'Four-Ball',
  foursomes: 'Foursomes',
  scramble: 'Scramble',
  shamble: 'Shamble',
  chapman: 'Chapman',
};

export function segmentHoleCount({ startHole, endHole }) {
  return Number(endHole) - Number(startHole) + 1;
}

export function formatSegmentLabel(segment) {
  const scoring = segment.scoringMode === 'net' ? 'Net' : 'Gross';
  const format = FORMAT_LABELS[segment.format] ?? segment.format;
  const allowance = segment.scoringMode === 'net' ? ` · ${Number(segment.handicapAllowance)}% allowance` : '';
  return `Holes ${segment.startHole}–${segment.endHole} · ${format} · ${scoring}${allowance} · ${Number(segment.pointValue)} pts`;
}

export function assignedRoundScoringMode(match, segments = []) {
  if (segments.length) return segments.some(segment => segment.scoring_mode === 'net') ? 'net' : 'gross';
  return match?.scoring_mode === 'net' ? 'net' : 'gross';
}

export function individualEntryBlockReason(segments = []) {
  const teamScoreFormats = new Set(['scramble', 'foursomes', 'chapman']);
  if (!segments.some(segment => teamScoreFormats.has(segment.format))) return null;
  return 'Scramble, Foursomes, and Chapman require a team-score scorecard and cannot be started in individual score entry.';
}

export function validateSegments(segments = []) {
  const errors = [];
  if (!segments.length) return ['Add at least one match segment.'];

  const ordered = [...segments].sort((a, b) => Number(a.startHole) - Number(b.startHole));
  let expectedStart = 1;

  for (const [index, segment] of ordered.entries()) {
    const label = `Segment ${index + 1}`;
    const start = Number(segment.startHole);
    const end = Number(segment.endHole);
    const allowance = Number(segment.handicapAllowance);

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 18 || end < start) {
      errors.push(`${label} must use a valid hole range from 1 through 18.`);
    }
    if (start < expectedStart) errors.push(`${label} overlaps the previous segment.`);
    if (start > expectedStart) errors.push(`${label} leaves a gap before hole ${start}.`);
    expectedStart = Math.max(expectedStart, end + 1);

    if (!Object.hasOwn(FORMAT_LABELS, segment.format)) errors.push(`${label} has an unsupported format.`);
    if (!['gross', 'net'].includes(segment.scoringMode)) errors.push(`${label} must use gross or net scoring.`);
    if (!(Number(segment.pointValue) > 0)) errors.push(`${label} must have a positive point value.`);
    if (segment.scoringMode === 'net' && (segment.handicapAllowance === null || segment.handicapAllowance === '' || !Number.isFinite(allowance) || allowance < 0 || allowance > 100)) {
      errors.push(`${label} requires a handicap allowance from 0 through 100 percent.`);
    }

    const players = segment.players ?? [];
    const ids = players.map(player => player.userId);
    const playingOrders = players.map(player => Number(player.playingOrder));
    const expectedPerSide = segment.format === 'singles' ? 1 : 2;
    const cardinalPlayers = players.filter(player => player.side === 'cardinal').length;
    const silverPlayers = players.filter(player => player.side === 'silver').length;
    if (new Set(ids).size !== ids.length) errors.push(`${label} cannot assign a player more than once.`);
    if (cardinalPlayers !== expectedPerSide || silverPlayers !== expectedPerSide) {
      errors.push(`${label} requires exactly ${expectedPerSide} player${expectedPerSide === 1 ? '' : 's'} per side.`);
    }
    if (players.length > 0 && (
      playingOrders.some(order => !Number.isInteger(order) || order < 1 || order > 4)
      || new Set(playingOrders).size !== playingOrders.length
    )) {
      errors.push(`${label} requires a unique playing order from 1 through 4 for every player.`);
    }
    for (const player of players) {
      const validSide = ['cardinal', 'silver'].includes(player.side);
      if (!['cardinal', 'silver'].includes(player.team) || !validSide) {
        errors.push(`${label} has an invalid player team or side.`);
        break;
      }
    }
  }

  if (expectedStart <= 18) errors.push(`Segments leave a gap from hole ${expectedStart} through 18.`);
  return [...new Set(errors)];
}
