export function formatHomeDate(value, options = {}) {
  if (!value) return '';
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    ...options,
  }).format(new Date(normalized));
}

export function formatMatchupPlayers(matchPlayers = []) {
  const named = matchPlayers.filter(item => item.profiles?.display_name);
  const sides = new Map();
  for (const player of named) {
    if (!player.team) continue;
    if (!sides.has(player.team)) sides.set(player.team, []);
    sides.get(player.team).push(player.profiles.display_name);
  }
  if (sides.size >= 2) {
    const preferredOrder = ['cardinal', 'silver'];
    const orderedSides = [...sides.entries()].sort(([left], [right]) => {
      const leftIndex = preferredOrder.indexOf(left);
      const rightIndex = preferredOrder.indexOf(right);
      if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex);
      return left.localeCompare(right);
    });
    return orderedSides.map(([, names]) => names.join(' & ')).join(' vs ');
  }
  return named.map(item => item.profiles.display_name).join(' vs ');
}

export function orderHomeMatches(matches = []) {
  const statusRank = { live: 0, scheduled: 1, final: 2 };
  return [...matches].sort((a, b) => {
    const rank = (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3);
    if (rank) return rank;
    const direction = a.status === 'final' ? -1 : 1;
    return direction * (new Date(a.starts_at ?? 0) - new Date(b.starts_at ?? 0));
  });
}
