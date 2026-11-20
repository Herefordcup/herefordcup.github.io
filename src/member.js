export function membershipAccessTransition(previousMemberships = [], currentMemberships = [], editionYear = 2027) {
  const statusPriority = { live: 0, open: 1, setup: 2 };
  const joinable = membership => Number(membership.tournaments?.edition_year) === editionYear
    && Object.hasOwn(statusPriority, membership.tournaments?.status);
  const selectPriorityMembership = memberships => memberships
    .filter(joinable)
    .sort((left, right) => statusPriority[left.tournaments.status] - statusPriority[right.tournaments.status])[0] ?? null;
  const identity = membership => membership?.tournament_id ?? membership?.tournaments?.id ?? null;
  const previousActiveTournament = selectActiveTournament(previousMemberships, editionYear);
  const previous = previousActiveTournament
    ? previousMemberships.find(membership => membership.status === 'active'
      && identity(membership) === (previousActiveTournament.id ?? null)) ?? null
    : selectPriorityMembership(previousMemberships.filter(membership => membership.status === 'pending'));
  if (!previous) return 'none';
  const previousTournamentId = identity(previous);
  const current = currentMemberships.find(membership => previousTournamentId === null
    ? membership.tournaments === previous.tournaments
    : identity(membership) === previousTournamentId) ?? null;

  if (previous.status === 'active') {
    if (!current) return 'request';
    if (!joinable(current)) return 'reload';
    const currentActiveTournament = selectActiveTournament(currentMemberships, editionYear);
    const selectedTournamentChanged = currentActiveTournament
      && (previousActiveTournament?.id || currentActiveTournament.id
        ? previousActiveTournament?.id !== currentActiveTournament.id
        : previousActiveTournament !== currentActiveTournament);
    if (selectedTournamentChanged) return 'reload';
    if (current.status === 'active') return 'none';
    return 'reload';
  }
  if (previous.status === 'pending') {
    if (selectActiveTournament(currentMemberships, editionYear)) return 'reload';
    if (!current) return 'denied';
    if (!joinable(current)) return 'reload';
    if (current.status === 'active') return 'reload';
    if (current.status === 'pending') return 'none';
    return 'denied';
  }
  return 'none';
}

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

export function playerDirectoryEntries(memberships = [], statistics = []) {
  const roundCounts = statistics.reduce((counts, round) => {
    counts.set(round.user_id, (counts.get(round.user_id) ?? 0) + 1);
    return counts;
  }, new Map());
  const teamNames = { cardinal: 'Blue', silver: 'White' };
  const teamOrder = { Blue: 0, White: 1, Unassigned: 2 };
  return memberships
    .filter(membership => membership.status === 'active')
    .map(membership => ({
      userId: membership.user_id,
      displayName: membership.profiles?.display_name || 'Player',
      team: teamNames[membership.team] || 'Unassigned',
      role: `${membership.role || 'player'}`.replace(/^./, character => character.toUpperCase()),
      handicapIndex: membership.profiles?.handicap_index ?? null,
      rounds: roundCounts.get(membership.user_id) ?? 0,
      photoPath: membership.profiles?.profile_photo_path ?? null,
    }))
    .sort((a, b) => teamOrder[a.team] - teamOrder[b.team]
      || a.displayName.localeCompare(b.displayName));
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
