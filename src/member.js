export function selectActiveTournament(memberships = [], editionYear = 2027) {
  const statusPriority = { live: 0, open: 1, setup: 2 };
  const candidates = memberships
    .filter(membership => membership.status === 'active')
    .map(membership => membership.tournaments)
    .filter(tournament => tournament
      && Number(tournament.edition_year) === editionYear
      && Object.hasOwn(statusPriority, tournament.status));
  const sorted = candidates.sort((a, b) => statusPriority[a.status] - statusPriority[b.status]);
  if (sorted.length > 1 && statusPriority[sorted[0].status] === statusPriority[sorted[1].status]) {
    throw new Error(`Multiple active ${editionYear} tournaments have the same priority. Ask an administrator to resolve the duplicate configuration.`);
  }
  return sorted[0] ?? null;
}

export function nextUpcomingAssignment(assignments = [], now = new Date()) {
  const threshold = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return assignments
    .filter(assignment => assignment.matches
      && assignment.matches.status !== 'final'
      && (assignment.matches.status === 'live'
        || new Date(assignment.matches.starts_at).getTime() >= threshold))
    .sort((a, b) => {
      if (a.matches.status === 'live' && b.matches.status !== 'live') return -1;
      if (b.matches.status === 'live' && a.matches.status !== 'live') return 1;
      return new Date(a.matches.starts_at) - new Date(b.matches.starts_at);
    })[0] ?? null;
}

export function assignedSegmentsForPlayer(segments = [], userId) {
  return segments.filter(segment => (segment.match_segment_players ?? [])
    .some(player => player.user_id === userId));
}

export function segmentRelationships(segment, userId) {
  const players = segment?.match_segment_players ?? [];
  const mine = players.find(player => player.user_id === userId);
  if (!mine) return { partners: [], opponents: [] };
  const name = player => player.profiles?.display_name || 'Player';
  return {
    partners: players.filter(player => player.user_id !== userId && player.side === mine.side).map(name),
    opponents: players.filter(player => player.side !== mine.side).map(name),
  };
}
