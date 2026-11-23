export function formatPublicPoints(value) {
  if (value === null || value === undefined || value === '') return '—';
  const points = Number(value);
  if (!Number.isFinite(points)) return '—';
  if (Number.isInteger(points)) return String(points);
  if (Number.isInteger(points * 2)) return `${Math.floor(points)}½`;
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(points);
}

export function formatHomeDateRange(startValue, endValue) {
  if (!startValue) return '';
  const normalize = value => /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value;
  const parts = value => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  }).formatToParts(new Date(normalize(value))).map(part => [part.type, part.value]));
  const start = parts(startValue);
  if (!endValue) return `${start.month} ${start.day}, ${start.year}`;
  const end = parts(endValue);
  if (start.year === end.year && start.month === end.month) {
    return `${start.month} ${start.day}–${end.day}, ${start.year}`;
  }
  if (start.year === end.year) {
    return `${start.month} ${start.day}–${end.month} ${end.day}, ${start.year}`;
  }
  return `${start.month} ${start.day}, ${start.year}–${end.month} ${end.day}, ${end.year}`;
}

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

export function formatItineraryTime(start, end, precision = 'exact', includeDay = false) {
  const zone = { timeZone: 'America/New_York' };
  const clock = new Intl.DateTimeFormat('en-US', { ...zone, hour: 'numeric', minute: '2-digit' });
  const date = new Date(start);
  const day = includeDay ? `${new Intl.DateTimeFormat('en-US', { ...zone, weekday: 'short' }).format(date)} · ` : '';
  if (precision === 'tbd') return `${day}Time TBD`;
  if (precision === 'approximate') return `${day}Around ${clock.format(date)}`;
  const text = end && start !== end ? clock.formatRange(date, new Date(end)).replace(/\s*–\s*/u, '–') : clock.format(date);
  return `${day}${text.replace(/\s/gu, ' ')}`;
}

function easternDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function groupPublicSchedule({ events = [], matches = [] } = {}) {
  const items = [
    ...events.map(event => ({ kind: 'event', title: event.title, startsAt: event.startsAt, data: event })),
    ...matches
      .filter(match => Array.isArray(match.segments) && match.segments.length > 0)
      .map(match => ({ kind: 'match', title: match.name, startsAt: match.startsAt, data: match })),
  ].filter(item => easternDateKey(item.startsAt));
  items.sort((left, right) => new Date(left.startsAt) - new Date(right.startsAt)
    || left.kind.localeCompare(right.kind)
    || String(left.title).localeCompare(String(right.title)));

  const groups = new Map();
  for (const item of items) {
    const date = easternDateKey(item.startsAt);
    if (!groups.has(date)) groups.set(date, { date, items: [] });
    groups.get(date).items.push(item);
  }
  return [...groups.values()].sort((left, right) => left.date.localeCompare(right.date));
}

export function hasPublishedPublicPairings(matches = []) {
  return matches.some(match => (match.segments ?? [])
    .some(segment => (segment.pairings ?? []).some(pairing => pairing.displayName)));
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

export function commentaryForMatch(commentaries = [], matchId) {
  return commentaries.find(commentary => commentary.match_id === matchId
    && commentary.status === 'approved') ?? null;
}
