import { formatMatchStatus } from './scoring.js';
import { formatHomeDate, formatItineraryTime, formatPublicPoints, groupPublicSchedule, hasPublishedPublicPairings } from './home.js?v=itinerary-1';
import { loadLegacyArchive, loadPublicTournamentPreview } from './supabase.js?v=texas-scramble-1';
import { renderLegacyWinners } from './legacy.js?v=pimentel-correction-1';

const previewStatus = document.querySelector('#previewStatus');
const tournamentMeta = document.querySelector('#tournamentMeta');
const sessionTabs = document.querySelector('#sessionTabs');
const matchList = document.querySelector('#matchList');
const pairingNotice = document.querySelector('#pairingNotice');
let scheduleGroups = [];
let activeDate = null;

function element(tagName, className = '', text = '') {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

function formatName(value = '') {
  return value
    .replace(/_/g, ' ')
    .replace(/\bfourball\b/i, 'Four-Ball')
    .replace(/\bfoursomes\b/i, 'Foursomes')
    .replace(/\bsingles\b/i, 'Singles')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function formatTime(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

function pairingNames(pairings = [], team) {
  return pairings
    .filter(pairing => pairing.team === team && pairing.displayName)
    .map(pairing => pairing.displayName)
    .join(' & ') || 'Pairing pending';
}

function segmentResultLabel(segment) {
  if (segment.status !== 'final' || !segment.result) return formatName(segment.status);
  return formatMatchStatus({
    differential: Number(segment.result.differential),
    holesPlayed: Number(segment.result.holesPlayed),
  }, Number(segment.endHole) - Number(segment.startHole) + 1);
}

function pairingBlock(label, names, teamClass = '') {
  const block = element('div', `pairing ${teamClass}`.trim());
  block.append(element('small', '', label), element('strong', '', names));
  return block;
}

function matchCard(match, index) {
  const card = element('article', 'match-card');
  const matchNumber = element('div', 'match-number', String(index + 1).padStart(2, '0'));
  const segments = match.segments ?? [];
  const onlySegment = segments.length === 1 ? segments[0] : null;
  const pendingLabel = segments.length > 1 ? 'See segment lineups' : 'Pairing pending';
  const bluePairing = pairingBlock('TEAM BLUE', onlySegment ? pairingNames(onlySegment.pairings, 'cardinal') : pendingLabel);
  const whitePairing = pairingBlock('TEAM WHITE', onlySegment ? pairingNames(onlySegment.pairings, 'silver') : pendingLabel, 'silver');
  const status = element('div', 'match-status');
  status.append(element('strong', '', match.name));
  const context = [formatTime(match.startsAt), match.course, formatName(match.status)]
    .filter(Boolean)
    .join(' · ');
  status.append(element('small', '', context));
  const segmentResults = element('div', 'segment-results');
  for (const segment of segments) {
    const details = [
      segments.length > 1 ? `Segment ${segment.segmentNumber}` : '',
      formatName(segment.format),
      segments.length > 1 ? `Blue: ${pairingNames(segment.pairings, 'cardinal')}` : '',
      segments.length > 1 ? `White: ${pairingNames(segment.pairings, 'silver')}` : '',
      segmentResultLabel(segment),
    ].filter(Boolean).join(' · ');
    segmentResults.append(element('span', '', details));
  }
  status.append(segmentResults);
  card.append(matchNumber, bluePairing, status, whitePairing);
  return card;
}

function itineraryCard(event) {
  const card = element('article', 'itinerary-card');
  const time = element('div', 'itinerary-time', formatItineraryTime(event.startsAt, event.endsAt, event.timePrecision));
  const details = element('div', 'itinerary-details');
  details.append(element('strong', '', event.title));
  const context = [formatName(event.eventType), event.course].filter(Boolean).join(' · ');
  if (context) details.append(element('span', '', context));
  if (event.publicDetails) details.append(element('span', '', event.publicDetails));
  const badge = element('span', event.isCompetitive ? 'event-badge competitive' : 'event-badge',
    event.isCompetitive ? 'Cup event' : 'Itinerary');
  card.append(time, details, badge);
  return card;
}

function renderActiveDay() {
  const group = scheduleGroups.find(item => item.date === activeDate);
  sessionTabs.querySelectorAll('[role="tab"]').forEach(tab => {
    tab.setAttribute('aria-selected', String(tab.dataset.date === activeDate));
  });
  if (!group) {
    matchList.replaceChildren(element('p', 'preview-message', 'Tournament schedule has not been published yet.'));
    return;
  }
  let matchIndex = 0;
  matchList.replaceChildren(...group.items.map(item => {
    if (item.kind === 'event') return itineraryCard(item.data);
    const card = matchCard(item.data, matchIndex);
    matchIndex += 1;
    return card;
  }));
}

function renderTabs() {
  const tabs = scheduleGroups.map((group, index) => {
    const tab = element('button');
    tab.type = 'button';
    tab.role = 'tab';
    tab.dataset.date = group.date;
    tab.setAttribute('aria-selected', String(group.date === activeDate));
    tab.append(
      element('span', '', `DAY ${index + 1}`),
      document.createTextNode(formatHomeDate(group.date, { weekday: 'short' })),
    );
    tab.addEventListener('click', () => {
      activeDate = group.date;
      renderActiveDay();
    });
    return tab;
  });
  sessionTabs.replaceChildren(...tabs);
}

function renderTotals(totals = {}) {
  const blue = totals.blue == null ? null : Number(totals.blue);
  const white = totals.white == null ? null : Number(totals.white);
  const blueKnown = Number.isFinite(blue);
  const whiteKnown = Number.isFinite(white);
  document.querySelector('#cardinalTotal').textContent = formatPublicPoints(blueKnown ? blue : null);
  document.querySelector('#silverTotal').textContent = formatPublicPoints(whiteKnown ? white : null);
  const decided = blueKnown && whiteKnown ? blue + white : 0;
  document.querySelector('#scoreProgress').style.width = `${decided > 0 ? (blue / decided) * 100 : 50}%`;
}

function renderUnknownTotals() {
  document.querySelector('#cardinalTotal').textContent = '—';
  document.querySelector('#silverTotal').textContent = '—';
  document.querySelector('#scoreProgress').style.width = '50%';
}

function renderPreviewMessage(message, state) {
  previewStatus.textContent = message;
  previewStatus.dataset.state = state;
  tournamentMeta.textContent = '';
  sessionTabs.replaceChildren();
  matchList.replaceChildren(element('p', 'preview-message', message));
  pairingNotice.hidden = true;
  renderUnknownTotals();
}

async function startPublicPreview() {
  try {
    const preview = await loadPublicTournamentPreview();
    if (!preview?.tournament) {
      renderPreviewMessage('Tournament preview has not been published yet.', 'empty');
      return;
    }

    const tournament = preview.tournament;
    previewStatus.textContent = 'Official schedule and finalized results';
    previewStatus.dataset.state = 'ready';
    tournamentMeta.textContent = `${tournament.name} · ${formatHomeDate(tournament.startsOn, { year: 'numeric' })}–${formatHomeDate(tournament.endsOn, { year: 'numeric' })}`;
    renderTotals(preview.totals);
    scheduleGroups = groupPublicSchedule(preview);
    activeDate = scheduleGroups[0]?.date ?? null;
    renderTabs();
    renderActiveDay();
    pairingNotice.textContent = 'Pairings will appear after they are published.';
    pairingNotice.hidden = hasPublishedPublicPairings(preview.matches ?? []);
  } catch {
    renderPreviewMessage('Tournament preview is temporarily unavailable.', 'unavailable');
  }
}

async function startLegacyWinners() {
  const container = document.querySelector('#legacyWinners');
  try {
    renderLegacyWinners({ container, editions: await loadLegacyArchive() });
  } catch {
    renderLegacyWinners({ container, editions: [], emptyMessage: 'Champion history is temporarily unavailable.' });
  }
}

startPublicPreview();
startLegacyWinners();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    registrations.forEach(registration => registration.unregister());
  });
}
if ('caches' in window) {
  caches.keys().then(keys => keys.filter(key => key.startsWith('hereford-cup-')).forEach(key => caches.delete(key)));
}
