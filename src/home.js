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

function calendarDate(value) {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value ?? '') ? `${value}T12:00:00Z` : value);
}

function easternDateParts(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).formatToParts(calendarDate(value));
  return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

export function formatTripDateRange(startValue, endValue) {
  if (!startValue) return '';
  const start = easternDateParts(startValue);
  if (!endValue) return `${start.month} ${start.day}, ${start.year}`;
  const end = easternDateParts(endValue);
  if (start.year === end.year && start.month === end.month) {
    return start.day === end.day
      ? `${start.month} ${start.day}, ${start.year}`
      : `${start.month} ${start.day}–${end.day}, ${start.year}`;
  }
  if (start.year === end.year) return `${start.month} ${start.day}–${end.month} ${end.day}, ${start.year}`;
  return `${start.month} ${start.day}, ${start.year}–${end.month} ${end.day}, ${end.year}`;
}

export function groupScheduleEventsByDay(events = []) {
  const keyFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const weekdayFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' });
  const dateFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric' });
  const groups = new Map();
  for (const event of [...events].sort((left, right) => new Date(left.starts_at) - new Date(right.starts_at))) {
    const date = new Date(event.starts_at);
    const parts = Object.fromEntries(keyFormatter.formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]));
    const key = `${parts.year}-${parts.month}-${parts.day}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: `${weekdayFormatter.format(date)} · ${dateFormatter.format(date)}`,
        events: [],
      });
    }
    groups.get(key).events.push(event);
  }
  return [...groups.values()];
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
