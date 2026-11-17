export function optionalNumber(value) {
  const normalized = String(value ?? '').trim();
  return normalized === '' ? null : Number(normalized);
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
