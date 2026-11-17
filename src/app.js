import { applyHoleResult, calculateTeamTotals, formatMatchStatus, isMatchComplete } from './scoring.js';
import { loadLegacyArchive, legacyPhotoUrl } from './supabase.js';
import { knownLegacyTrips, renderLegacyArchive } from './legacy.js';

const STORAGE_KEY = 'hereford-cup-state-v1';
const sessions = {
  fourball: {
    title: 'Four-Ball',
    note: 'Each golfer plays his own ball. The lowest score for each side represents the team on every hole.',
    matches: [
      ['Blue Pair 1', 'White Pair 1'],
      ['Blue Pair 2', 'White Pair 2'],
      ['Blue Pair 3', 'White Pair 3'],
      ['Blue Pair 4', 'White Pair 4'],
    ],
  },
  foursomes: {
    title: 'Foursomes',
    note: 'Partners play one ball and alternate shots. The side winning the hole moves one point up in the match.',
    matches: [
      ['Blue Pair 1', 'White Pair 1'],
      ['Blue Pair 2', 'White Pair 2'],
      ['Blue Pair 3', 'White Pair 3'],
      ['Blue Pair 4', 'White Pair 4'],
    ],
  },
  singles: {
    title: 'Singles',
    note: 'One-on-one match play closes the trip. Each match is worth one full point, or a half point when tied.',
    matches: [
      ['Blue Player 1', 'White Player 1'],
      ['Blue Player 2', 'White Player 2'],
      ['Blue Player 3', 'White Player 3'],
      ['Blue Player 4', 'White Player 4'],
    ],
  },
};

const blankMatch = (session, index) => ({
  id: `${session}-${index}`,
  session,
  index,
  differential: 0,
  holesPlayed: 0,
  history: [],
});

function initialState() {
  return {
    activeSession: 'fourball',
    matches: Object.entries(sessions).flatMap(([key, session]) =>
      session.matches.map((_, index) => blankMatch(key, index)),
    ),
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved?.matches?.length === 12) return saved;
  } catch {
    localStorage.removeItem(STORAGE_KEY);
  }
  return initialState();
}

let state = loadState();
const matchList = document.querySelector('#matchList');
const formatNote = document.querySelector('#formatNote');

function formatPoints(value) {
  return Number.isInteger(value) ? String(value) : `${Math.floor(value)}½`;
}

function saveAndRender() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  render();
}

function renderTotals() {
  const totals = calculateTeamTotals(state.matches);
  const totalAvailable = state.matches.length;
  const target = Math.floor(totalAvailable / 2) + 0.5;
  document.querySelector('#cardinalTotal').textContent = formatPoints(totals.cardinal);
  document.querySelector('#silverTotal').textContent = formatPoints(totals.silver);
  document.querySelector('#targetPoints').textContent = formatPoints(target);
  const decided = totals.cardinal + totals.silver;
  const cardinalShare = decided ? (totals.cardinal / decided) * 100 : 50;
  document.querySelector('#scoreProgress').style.width = `${cardinalShare}%`;
}

function matchCard(match) {
  const [cardinalPlayers, silverPlayers] = sessions[match.session].matches[match.index];
  const complete = isMatchComplete(match);
  const card = document.createElement('article');
  card.className = 'match-card';
  card.innerHTML = `
    <div class="match-number">${String(match.index + 1).padStart(2, '0')}</div>
    <div class="pairing"><small>TEAM BLUE</small><strong>${cardinalPlayers}</strong></div>
    <div class="match-status">
      <strong>${formatMatchStatus(match)}</strong>
      <small>${complete ? 'FINAL' : `${match.holesPlayed} HOLES PLAYED`}</small>
      <div class="hole-controls">
        <button type="button" data-result="cardinal" title="Blue wins hole" aria-label="Blue wins next hole" ${complete ? 'disabled' : ''}>B</button>
        <button type="button" data-result="halve" title="Hole halved" aria-label="Halve next hole" ${complete ? 'disabled' : ''}>=</button>
        <button type="button" data-result="silver" title="White wins hole" aria-label="White wins next hole" ${complete ? 'disabled' : ''}>W</button>
        <button type="button" data-result="undo" title="Undo last hole" aria-label="Undo last hole" ${match.history.length ? '' : 'disabled'}>↶</button>
      </div>
    </div>
    <div class="pairing silver"><small>TEAM WHITE</small><strong>${silverPlayers}</strong></div>`;

  card.querySelector('.hole-controls').addEventListener('click', event => {
    const result = event.target.dataset.result;
    if (!result) return;
    const target = state.matches.find(item => item.id === match.id);
    if (result === 'undo') {
      const previous = target.history.pop();
      if (previous) Object.assign(target, previous);
    } else {
      target.history.push({ differential: target.differential, holesPlayed: target.holesPlayed });
      Object.assign(target, applyHoleResult(target, result));
    }
    saveAndRender();
  });
  return card;
}

function render() {
  document.querySelectorAll('[role="tab"]').forEach(tab => {
    tab.setAttribute('aria-selected', String(tab.dataset.session === state.activeSession));
  });
  formatNote.textContent = sessions[state.activeSession].note;
  matchList.replaceChildren(
    ...state.matches.filter(match => match.session === state.activeSession).map(matchCard),
  );
  renderTotals();
}

document.querySelectorAll('[role="tab"]').forEach(tab => {
  tab.addEventListener('click', () => {
    state.activeSession = tab.dataset.session;
    saveAndRender();
  });
});

document.querySelector('#resetScores').addEventListener('click', () => {
  if (!window.confirm('Reset every Hereford Cup match score on this device?')) return;
  state = initialState();
  saveAndRender();
});

render();

async function startLegacyArchive() {
  const target = {
    timeline: document.querySelector('#legacyTimeline'),
    details: document.querySelector('#legacyDetails'),
    gallery: document.querySelector('#legacyGallery'),
    photoUrl: legacyPhotoUrl,
  };
  try {
    renderLegacyArchive({ ...target, editions: await loadLegacyArchive() });
  } catch {
    renderLegacyArchive({ ...target, editions: knownLegacyTrips });
  }
}

startLegacyArchive();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    registrations.forEach(registration => registration.unregister());
  });
}
if ('caches' in window) {
  caches.keys().then(keys => keys.filter(key => key.startsWith('hereford-cup-')).forEach(key => caches.delete(key)));
}
