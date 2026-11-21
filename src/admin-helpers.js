export function createMutationGate(target) {
  let count = 0;
  const idleCallbacks = [];
  return {
    begin() {
      count += 1;
      target.inert = true;
    },
    end() {
      count = Math.max(0, count - 1);
      target.inert = count > 0;
      if (count === 0) {
        for (const callback of idleCallbacks.splice(0)) callback();
      }
    },
    whenIdle(callback) {
      if (count === 0) callback();
      else idleCallbacks.push(callback);
    },
    get active() {
      return count > 0;
    },
  };
}

export function filterActiveMemberships(memberships, { search = '', team = '', role = '' } = {}) {
  const normalizedSearch = String(search).trim().toLocaleLowerCase();
  return memberships
    .filter(membership => membership.status === 'active')
    .filter(membership => !normalizedSearch
      || (membership.profiles?.display_name || 'Player').toLocaleLowerCase().includes(normalizedSearch))
    .filter(membership => !team
      || (team === 'unassigned' ? !membership.team : membership.team === team))
    .filter(membership => !role || membership.role === role)
    .sort((left, right) => (left.profiles?.display_name || 'Player')
      .localeCompare(right.profiles?.display_name || 'Player', undefined, { sensitivity: 'base' }));
}

export function applyMemberCardVisibility(cards, visibleIds) {
  for (const card of cards) card.hidden = !visibleIds.has(card.dataset.memberId);
}

export function moveFocusFromFilteredCard(card, fallback) {
  if (!card.hidden) return false;
  fallback.focus({ preventScroll: true });
  return true;
}

export function tournamentTeamLabel(team) {
  if (team === 'cardinal') return 'Blue';
  if (team === 'silver') return 'White';
  return 'No team';
}

export function segmentPlayerOptions(memberships, selectedUserId = '') {
  const options = [
    { value: '', label: 'Unassigned', disabled: false },
    ...memberships.map(membership => ({
      value: membership.user_id,
      label: `${membership.profiles?.display_name || 'Player'} · ${tournamentTeamLabel(membership.team)}`,
      disabled: membership.status !== 'active' || !['cardinal', 'silver'].includes(membership.team),
    })),
  ];
  const selectedOption = options.find(option => option.value === selectedUserId && !option.disabled);
  return { options, selectedUserId: selectedOption?.value ?? '' };
}

export function segmentPlayerFromMembership(membership, playingOrder) {
  if (!membership || membership.status !== 'active' || !['cardinal', 'silver'].includes(membership.team)) return null;
  return {
    userId: membership.user_id,
    team: membership.team,
    side: membership.team,
    playingOrder,
  };
}

export function optionalNumber(value) {
  const normalized = String(value ?? '').trim();
  return normalized === '' ? null : Number(normalized);
}

export function tournamentCompletionReadiness({ tournament, matches = [], editions = [] }) {
  if (!tournament) return { ready: false, text: 'Select a tournament to review completion readiness.' };
  const tournamentMatches = matches.filter(match => match.tournament_id === tournament.id);
  const edition = editions.find(item => item.edition_year === tournament.edition_year);
  if (tournament.status === 'complete') {
    const verified = edition?.source_tournament_id === tournament.id && edition.status === 'completed';
    return verified
      ? { ready: true, text: 'This tournament is complete. The server will verify the generated archive without changing it.' }
      : { ready: false, text: 'This completed tournament does not have a matching generated Past Trips archive. Database review is required.' };
  }
  if (!tournamentMatches.length) return { ready: false, text: 'At least one planned match is required before completion.' };
  const unfinished = tournamentMatches.filter(match => match.status !== 'final');
  if (unfinished.length) return { ready: false, text: `${unfinished.length} of ${tournamentMatches.length} matches still need final results.` };
  if (edition) {
    const conflictingArchive = edition.source_tournament_id
      || edition.status !== 'planned'
      || edition.legacy_results?.length
      || edition.winner_name
      || edition.final_score
      || edition.expected_points !== null
      || edition.cardinal_total !== null
      || edition.silver_total !== null
      || edition.score_confidence !== 'unresolved';
    if (conflictingArchive) return { ready: false, text: 'The matching Past Trips edition already contains scoring data or conflicting completion state.' };
  }
  return {
    ready: true,
    text: `All ${tournamentMatches.length} matches are final. The server will verify the planned Past Trips edition before publishing.`,
  };
}

const easternFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function easternParts(date) {
  return Object.fromEntries(easternFormatter.formatToParts(date)
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
}

export function easternDateTimeToIso(value) {
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) throw new Error('Enter a valid match start time.');
  const [, year, month, day, hour, minute] = match.map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = easternParts(new Date(instant));
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    instant += target - represented;
  }
  const verified = easternParts(new Date(instant));
  if (verified.year !== year || verified.month !== month || verified.day !== day
      || verified.hour !== hour || verified.minute !== minute) {
    throw new Error('That local Eastern time does not exist because of daylight saving time.');
  }
  return new Date(instant).toISOString();
}
