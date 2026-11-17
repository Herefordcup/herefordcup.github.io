import { courseHandicapForTee, scoreIndividualHoleForSegment } from './golf.js';
import { matchPoints } from './scoring.js';
import { formatSegmentLabel, individualEntryBlockReason, segmentHoleCount } from './formats.js';
import { summarizeLeagueStats, summarizePlayerStats } from './stats.js';
import { assertRoundAssignment, mergePersistedScores, unsavedScoreRows } from './round-entry.js';
import {
  assignedSegmentsForPlayer,
  nextUpcomingAssignment,
  segmentRelationships,
} from './member.js';
import { hasSupabaseConfig } from './config.js';
import {
  canSetNewPassword,
  getCurrentSession,
  hasActiveTournamentMembership,
  loadPlayerData,
  requestPasswordReset,
  saveProfile,
  saveRound,
  setNewPassword,
  signInWithEmail,
  signInWithGoogle,
  signOut,
  signUpWithEmail,
  validateAuthInput,
  waitForPasswordRecovery,
} from './supabase.js';

const authView = document.querySelector('#authView');
const accessPendingView = document.querySelector('#accessPendingView');
const dashboardView = document.querySelector('#dashboardView');
const setupMessage = document.querySelector('#setupMessage');
const courseSelect = document.querySelector('#courseSelect');
const teeSelect = document.querySelector('#teeSelect');
const matchSelect = document.querySelector('#matchSelect');
const handicapInput = document.querySelector('#handicapIndex');
const scorecard = document.querySelector('#scorecard');
const emptyScorecard = document.querySelector('#emptyScorecard');
const saveButton = document.querySelector('#saveRound');
const authForm = document.querySelector('#emailAuthForm');
const authMessage = document.querySelector('#authMessage');
const displayNameField = document.querySelector('#displayNameField');
const displayNameInput = document.querySelector('#displayName');
const emailInput = document.querySelector('#emailAddress');
const passwordInput = document.querySelector('#emailPassword');
const forgotPasswordButton = document.querySelector('#forgotPassword');
const authSubmitButton = document.querySelector('#emailAuthSubmit');
const signInModeButton = document.querySelector('#authModeSignIn');
const signUpModeButton = document.querySelector('#authModeSignUp');
const authModeSelector = document.querySelector('#authModeSelector');
const emailAddressField = document.querySelector('#emailAddressField');
const authDivider = document.querySelector('#authDivider');
const providerAccess = document.querySelector('#providerAccess');
const authAccessNote = document.querySelector('#authAccessNote');
const authTitle = document.querySelector('#authTitle');
const authIntro = document.querySelector('#authIntro');

let session;
let playerData;
let selectedTee;
let existingRound;
let authMode = 'signin';
let recoveryVerified = false;
let scores = Array.from({ length: 18 }, (_, index) => ({ hole_number: index + 1, gross_score: null }));

function showAuthMessage(message, isError = false) {
  authMessage.textContent = message;
  authMessage.classList.toggle('is-error', isError);
}

function setAuthMode(mode) {
  authMode = mode;
  const isSignUp = mode === 'signup';
  const isRecovery = mode === 'recovery';
  if (!isRecovery) recoveryVerified = false;
  authSubmitButton.disabled = isRecovery && !recoveryVerified;
  displayNameField.hidden = !isSignUp;
  displayNameInput.required = isSignUp;
  emailAddressField.hidden = isRecovery;
  emailInput.required = !isRecovery;
  passwordInput.autocomplete = isSignUp || isRecovery ? 'new-password' : 'current-password';
  forgotPasswordButton.hidden = isSignUp || isRecovery;
  authSubmitButton.textContent = isRecovery ? 'Set new password' : isSignUp ? 'Create account' : 'Sign in';
  authModeSelector.hidden = isRecovery;
  authDivider.hidden = isRecovery;
  providerAccess.hidden = isRecovery;
  authAccessNote.hidden = isRecovery;
  authTitle.innerHTML = isRecovery ? 'Set a new<br><em>password.</em>' : 'Your round.<br><em>Your team.</em>';
  authIntro.textContent = isRecovery
    ? 'Choose a new password with at least 8 characters.'
    : 'Sign in or create an account to join your team, follow every match, and keep your scores in one place.';
  signInModeButton.classList.toggle('is-active', !isSignUp);
  signUpModeButton.classList.toggle('is-active', isSignUp);
  signInModeButton.setAttribute('aria-selected', String(!isSignUp));
  signUpModeButton.setAttribute('aria-selected', String(isSignUp));
  showAuthMessage('');
}

function setSyncStatus(message, busy = false) {
  const element = document.querySelector('#syncStatus');
  element.lastChild.textContent = ` ${message}`;
  element.querySelector('i').style.background = busy ? '#d99a2b' : '#46b96a';
}

function showMessage(message, isError = false) {
  const element = document.querySelector('#saveMessage');
  element.textContent = message;
  element.style.color = isError ? '#9b1730' : '';
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatName(value = '') {
  return value.replace('fourball', 'Four-Ball').replace('foursomes', 'Foursomes')
    .replace('singles', 'Singles').replace('scramble', 'Scramble')
    .replace('shamble', 'Shamble').replace('chapman', 'Chapman');
}

function showMemberView(viewName) {
  document.querySelectorAll('.member-view').forEach(view => {
    view.hidden = view.dataset.view !== viewName;
  });
  document.querySelectorAll('[data-member-view]').forEach(button => {
    const active = button.dataset.memberView === viewName;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
}

function formatHomeDate(value, options = {}) {
  if (!value) return '';
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    ...options,
  }).format(new Date(normalized));
}

function renderHomeSummary() {
  const tournament = playerData.tournament;
  const membership = playerData.memberships.find(item => item.tournaments?.id === tournament?.id)
    ?? playerData.memberships[0];
  document.querySelector('#homeSeason').textContent = tournament?.name
    ?? `${tournament?.edition_year ?? ''} Hereford Cup`.trim();
  document.querySelector('#homeTournamentStatus').textContent = (tournament?.status ?? 'season').toUpperCase();
  document.querySelector('#homeHandicap').textContent = playerData.profile.handicap_index ?? '—';
  document.querySelector('#homeTeam').textContent = membership?.team
    ? membership.team.charAt(0).toUpperCase() + membership.team.slice(1)
    : 'Unassigned';
  document.querySelector('#homeRounds').textContent = summarizePlayerStats(playerData.statistics, session.user.id).rounds;
  const start = formatHomeDate(tournament?.starts_on, { year: 'numeric' });
  document.querySelector('#homeTournamentMeta').textContent = start
    ? `${start} · Your schedule, matches, and Cup standing.`
    : 'Your schedule, matches, and Cup standing in one place.';
  document.querySelector('#homeScheduleTitle').textContent = start ? `${start} itinerary` : 'Tournament itinerary';
}

function renderSchedule() {
  const container = document.querySelector('#schedulePreview');
  container.replaceChildren();
  if (!playerData.events.length) {
    container.append(element('p', 'empty-panel', 'The itinerary has not been published yet.'));
    return;
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
  for (const event of playerData.events) {
    const row = element('article', 'schedule-item');
    row.append(element('time', '', formatter.format(new Date(event.starts_at))));
    const details = element('div');
    details.append(element('strong', '', event.title));
    if (event.notes) details.append(element('span', '', event.notes));
    row.append(details);
    row.append(element('em', '', event.is_competitive ? 'CUP' : event.event_type.toUpperCase()));
    container.append(row);
  }
}

function renderLiveMatch() {
  const preview = document.querySelector('#matchPreview');
  const live = playerData.assignments.find(item => item.matches?.status === 'live');
  const upcoming = live ?? nextUpcomingAssignment(playerData.assignments);
  const label = document.querySelector('#liveMatchLabel');
  preview.replaceChildren();
  label.textContent = live ? 'LIVE NOW' : 'NEXT MATCH';
  document.querySelector('#liveMatchPanel').classList.toggle('is-live', Boolean(live));
  if (!upcoming) {
    preview.classList.add('empty-panel');
    preview.textContent = 'No upcoming assigned match.';
    return;
  }
  preview.classList.remove('empty-panel');
  preview.append(element('strong', '', upcoming.matches.name));
  const course = upcoming.matches.courses?.name ?? 'Course to be announced';
  const date = formatHomeDate(upcoming.matches.starts_at, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  preview.append(element('span', '', [date, course, formatName(upcoming.matches.format), formatName(upcoming.matches.scoring_mode)].filter(Boolean).join(' · ')));
  const matchSegments = playerData.segments.filter(segment => segment.match_id === upcoming.matches.id);
  const segments = assignedSegmentsForPlayer(matchSegments, session.user.id);
  for (const segment of segments) {
    preview.append(element('span', '', formatSegmentLabel({
      startHole: segment.start_hole,
      endHole: segment.end_hole,
      format: segment.format,
      scoringMode: segment.scoring_mode,
      handicapAllowance: segment.handicap_allowance,
      pointValue: segment.point_value,
    })));
    const relationships = segmentRelationships(segment, session.user.id);
    if (relationships.partners.length) {
      preview.append(element('span', '', `Partner: ${relationships.partners.join(', ')}`));
    }
    preview.append(element('span', '', `Opponent${relationships.opponents.length === 1 ? '' : 's'}: ${relationships.opponents.join(', ') || 'TBA'}`));
  }
}

function renderRecentResults() {
  const container = document.querySelector('#recentResults');
  container.replaceChildren();
  const statusRank = { live: 0, scheduled: 1, final: 2 };
  const matches = [...playerData.matches].sort((a, b) => {
    const rank = (statusRank[a.status] ?? 3) - (statusRank[b.status] ?? 3);
    if (rank) return rank;
    const direction = a.status === 'final' ? -1 : 1;
    return direction * (new Date(a.starts_at ?? 0) - new Date(b.starts_at ?? 0));
  }).slice(0, 6);
  if (!matches.length) {
    container.append(element('p', 'empty-panel', 'Matches will appear when pairings are published.'));
    return;
  }
  for (const match of matches) {
    const row = element('article', 'home-result-item');
    const meta = element('div', 'result-meta');
    const status = match.status === 'live' ? 'LIVE' : match.status === 'final' ? 'FINAL' : 'UP NEXT';
    meta.append(element('strong', match.status === 'live' ? 'is-live' : '', status));
    meta.append(element('time', '', formatHomeDate(match.starts_at, { weekday: 'short' }).toUpperCase()));
    const details = element('div', 'result-details');
    details.append(element('strong', '', match.name));
    const names = (match.match_players ?? []).map(item => item.profiles?.display_name).filter(Boolean);
    const context = [names.join(' vs '), match.courses?.name, formatName(match.format)].filter(Boolean).join(' · ');
    details.append(element('span', '', context || 'Pairing details pending'));
    row.append(meta, details);
    container.append(row);
  }
}

function renderCup() {
  const matchList = document.querySelector('#cupMatchList');
  matchList.replaceChildren();
  const matches = playerData.matches;
  if (!matches.length) {
    matchList.append(element('p', 'empty-panel', 'Pairings will appear after the administrator publishes them.'));
  }
  for (const match of matches) {
    const row = element('article', 'match-list-item');
    const details = element('div');
    details.append(element('strong', '', match.name));
    details.append(element('small', '', `${match.courses?.name ?? 'Course TBA'} · ${formatName(match.format)}`));
    for (const segment of playerData.segments.filter(item => item.match_id === match.id)) {
      details.append(element('small', '', formatSegmentLabel({
        startHole: segment.start_hole,
        endHole: segment.end_hole,
        format: segment.format,
        scoringMode: segment.scoring_mode,
        handicapAllowance: segment.handicap_allowance,
        pointValue: segment.point_value,
      })));
      const names = (segment.match_segment_players ?? []).map(player => player.profiles?.display_name || 'Player');
      details.append(element('small', '', `Assignments: ${names.join(', ') || 'TBA'}`));
    }
    row.append(details, element('strong', '', match.status.toUpperCase()));
    matchList.append(row);
  }

  const totals = playerData.segments.reduce((sum, segment) => {
    const points = matchPoints(
      { differential: Number(segment.differential), holesPlayed: Number(segment.holes_played) },
      segmentHoleCount({ startHole: segment.start_hole, endHole: segment.end_hole }),
      Number(segment.point_value),
    );
    sum.cardinal += points.cardinal;
    sum.silver += points.silver;
    return sum;
  }, { cardinal: 0, silver: 0 });
  const score = document.querySelector('#cupScorePreview');
  score.querySelectorAll('strong')[0].textContent = totals.cardinal;
  score.querySelectorAll('strong')[1].textContent = totals.silver;
}

function appendStat(container, label, value) {
  const item = element('div', 'stat-item');
  item.append(element('small', '', label), element('strong', '', value ?? '—'));
  container.append(item);
}

function renderStats() {
  const league = summarizeLeagueStats(playerData.statistics);
  const mine = summarizePlayerStats(playerData.statistics, session.user.id);
  const leagueContainer = document.querySelector('#leagueStats');
  const playerContainer = document.querySelector('#playerStats');
  const homePlayerContainer = document.querySelector('#homePlayerStats');
  leagueContainer.replaceChildren();
  playerContainer.replaceChildren();
  homePlayerContainer.replaceChildren();
  appendStat(leagueContainer, 'ROUNDS', league.rounds);
  appendStat(leagueContainer, 'PLAYERS', league.players);
  appendStat(leagueContainer, 'HOLES', league.holes);
  appendStat(leagueContainer, 'AVG TO PAR', league.averageToPar);
  appendStat(playerContainer, 'ROUNDS', mine.rounds);
  appendStat(playerContainer, 'HOLES', mine.holes);
  appendStat(playerContainer, 'AVG GROSS', mine.averageGross);
  appendStat(playerContainer, 'BEST TO PAR', mine.bestToPar);
  appendStat(homePlayerContainer, 'OFFICIAL ROUNDS', mine.rounds);
  appendStat(homePlayerContainer, 'HOLES', mine.holes);
  appendStat(homePlayerContainer, 'BEST TO PAR', mine.bestToPar);
}

function renderRules() {
  const container = document.querySelector('#rulesList');
  container.replaceChildren();
  if (!playerData.rules.length) {
    container.append(element('p', 'empty-panel', 'Rules will appear after the administrator publishes them.'));
    return;
  }
  for (const rule of playerData.rules) {
    const article = element('article');
    article.append(element('h3', '', rule.title), element('p', '', rule.body));
    container.append(article);
  }
}

function renderCommentary() {
  const card = document.querySelector('#commentaryCard');
  const container = document.querySelector('#matchCommentary');
  const latest = playerData.commentaries[0];
  card.hidden = !latest;
  container.replaceChildren();
  if (!latest) return;
  container.append(element('p', 'commentary-quote', latest.commentary));
  const provenance = latest.ai_generated
    ? 'AI-generated · Administrator approved'
    : 'Administrator edited · Administrator approved';
  container.append(element('span', 'commentary-meta', `${latest.matches?.name ?? 'Hereford Cup'} · ${provenance}`));
}

function renderMemberHome() {
  renderHomeSummary();
  renderSchedule();
  renderLiveMatch();
  renderRecentResults();
  renderCup();
  renderStats();
  renderRules();
  renderCommentary();
  showMemberView('home');
}

function currentCourse() {
  return playerData?.courses.find(course => course.id === courseSelect.value);
}

function selectedMatch() {
  return playerData?.assignments.find(item => item.matches?.id === matchSelect.value)?.matches;
}

function selectedMatchSegments() {
  const match = selectedMatch();
  if (!match) return [];
  const matchSegments = playerData.segments.filter(segment => segment.match_id === match.id);
  return assignedSegmentsForPlayer(matchSegments, session.user.id);
}

function scoreEntryBlockReason() {
  return individualEntryBlockReason(selectedMatchSegments());
}

function selectedScoringMode() {
  const match = selectedMatch();
  if (!match) return 'gross';
  const segments = selectedMatchSegments();
  return segments.some(segment => segment.scoring_mode === 'net') || match.scoring_mode === 'net' ? 'net' : 'gross';
}

function updateCourseHandicap() {
  if (!selectedTee) {
    document.querySelector('#courseHandicap').textContent = '—';
    return null;
  }
  if (handicapInput.value === '' && selectedScoringMode() === 'net') {
    document.querySelector('#courseHandicap').textContent = '—';
    return null;
  }
  const handicap = courseHandicapForTee(handicapInput.value || 0, selectedTee, selectedScoringMode());
  document.querySelector('#courseHandicap').textContent = handicap ?? 'Rating pending';
  updateSummary();
  return handicap;
}

function updateSummary() {
  const completed = scores.filter(score => Number(score.gross_score) > 0);
  const gross = completed.reduce((total, score) => total + Number(score.gross_score), 0);
  const holes = selectedTee?.holes ?? [];
  const par = completed.reduce((total, score) => {
    const hole = holes.find(item => item.hole_number === score.hole_number);
    return total + Number(hole?.par ?? 0);
  }, 0);
  const scoringMode = selectedScoringMode();
  const courseHandicap = selectedTee && (handicapInput.value !== '' || scoringMode === 'gross')
    ? courseHandicapForTee(handicapInput.value || 0, selectedTee, scoringMode)
    : null;
  const segments = selectedMatchSegments();
  const adjusted = courseHandicap === null ? null : completed.reduce((total, score) => {
    const hole = holes.find(item => item.hole_number === score.hole_number);
    const segment = segments.find(item => score.hole_number >= item.start_hole && score.hole_number <= item.end_hole)
      ?? { scoring_mode: scoringMode, handicap_allowance: scoringMode === 'net' ? 100 : null };
    return total + scoreIndividualHoleForSegment({
      grossScore: score.gross_score,
      strokeIndex: hole?.stroke_index ?? score.hole_number,
      courseHandicap,
      segment,
    });
  }, 0);
  document.querySelector('#holesCompleted').textContent = completed.length;
  document.querySelector('#grossTotal').textContent = completed.length ? gross : '—';
  const adjustedLabel = document.querySelector('#adjustedLabel');
  adjustedLabel.textContent = segments.length ? 'SEGMENT TOTALS' : 'ADJUSTED';
  document.querySelector('#netTotal').textContent = segments.length
    ? (completed.length ? '↓' : '—')
    : (completed.length && adjusted !== null ? adjusted : '—');
  const segmentSummaries = document.querySelector('#segmentSummaries');
  segmentSummaries.replaceChildren();
  for (const segment of segments) {
    const segmentScores = completed.filter(score => score.hole_number >= segment.start_hole && score.hole_number <= segment.end_hole);
    const handicapAllowance = segment.scoring_mode === 'net' ? `${Number(segment.handicap_allowance)}% allowance` : 'No handicap allowance';
    const subtotal = courseHandicap === null ? null : segmentScores.reduce((total, score) => {
      const hole = holes.find(item => item.hole_number === score.hole_number);
      return total + scoreIndividualHoleForSegment({
        grossScore: score.gross_score,
        strokeIndex: hole?.stroke_index ?? score.hole_number,
        courseHandicap,
        segment,
      });
    }, 0);
    const summary = element('div', 'stat-item segment-adjusted-subtotal');
    summary.append(
      element('small', '', formatSegmentLabel({
        startHole: segment.start_hole,
        endHole: segment.end_hole,
        format: segment.format,
        scoringMode: segment.scoring_mode,
        handicapAllowance: segment.handicap_allowance,
        pointValue: segment.point_value,
      })),
      element('strong', '', `${handicapAllowance} · Adjusted ${segmentScores.length && subtotal !== null ? subtotal : '—'}`),
    );
    segmentSummaries.append(summary);
  }
  const relation = gross - par;
  document.querySelector('#toPar').textContent = !completed.length ? 'E' : relation === 0 ? 'E' : relation > 0 ? `+${relation}` : relation;
  const netNeedsRating = scoringMode === 'net' && courseHandicap === null;
  saveButton.disabled = !selectedTee || !unsavedScoreRows(scores).length || netNeedsRating || Boolean(scoreEntryBlockReason());
}

function renderScorecard() {
  const blockReason = scoreEntryBlockReason();
  if (blockReason) {
    scorecard.hidden = true;
    emptyScorecard.hidden = false;
    emptyScorecard.querySelector('p').textContent = blockReason;
    saveButton.disabled = true;
    return;
  }
  emptyScorecard.querySelector('p').textContent = 'Select a course and tee to open your scorecard.';
  const holes = [...(selectedTee?.holes ?? [])].sort((a, b) => a.hole_number - b.hole_number);
  if (!holes.length) {
    scorecard.hidden = true;
    emptyScorecard.hidden = false;
    return;
  }
  emptyScorecard.hidden = true;
  scorecard.hidden = false;
  scorecard.replaceChildren(...holes.map(hole => {
    const row = document.createElement('div');
    row.className = 'hole-row';
    const current = scores[hole.hole_number - 1];
    row.innerHTML = `
      <div class="hole-id">${hole.hole_number}</div>
      <div class="hole-meta"><strong>Par ${hole.par}</strong><span>${hole.yardage ? `${hole.yardage} YDS` : ''}</span><span>SI ${hole.stroke_index ?? '—'}</span></div>
      <div class="score-stepper">
        <button type="button" aria-label="Decrease hole ${hole.hole_number} score">−</button>
        <input type="number" inputmode="numeric" min="1" max="15" aria-label="Hole ${hole.hole_number} gross score" value="${current.gross_score ?? ''}">
        <button type="button" aria-label="Increase hole ${hole.hole_number} score">+</button>
      </div>`;
    const input = row.querySelector('input');
    input.readOnly = Boolean(current.locked);
    row.querySelectorAll('button').forEach(button => { button.disabled = Boolean(current.locked); });
    const commit = value => {
      if (current.locked) return;
      current.gross_score = value >= 1 ? Math.min(15, value) : null;
      input.value = current.gross_score ?? '';
      updateSummary();
    };
    row.querySelectorAll('button')[0].addEventListener('click', () => commit((Number(input.value) || hole.par) - 1));
    row.querySelectorAll('button')[1].addEventListener('click', () => commit((Number(input.value) || hole.par - 1) + 1));
    input.addEventListener('input', () => commit(Number(input.value)));
    return row;
  }));
  updateSummary();
}

function populateCourses() {
  for (const course of playerData.courses) {
    courseSelect.add(new Option(course.name, course.id));
  }
  for (const assignment of playerData.assignments) {
    const match = assignment.matches;
    if (!match || match.status === 'final') continue;
    const label = `${match.name} · ${match.format.replace('fourball', 'Four-Ball')} · ${assignment.team}`;
    matchSelect.add(new Option(label, match.id));
  }
}

function blankScores() {
  return Array.from({ length: 18 }, (_, index) => ({ hole_number: index + 1, gross_score: null, locked: false }));
}

function populateTees(course, teeId = '') {
  teeSelect.replaceChildren(new Option('Select tees', ''));
  for (const tee of course?.tees ?? []) {
    const category = tee.rating_category && tee.rating_category !== 'U' ? ` · ${tee.rating_category}` : '';
    const ratingState = tee.rating === null || tee.slope === null ? ' · Rating pending' : '';
    teeSelect.add(new Option(`${tee.name}${category} · ${tee.yardage || '—'} yards${ratingState}`, tee.id));
  }
  teeSelect.value = teeId;
  selectedTee = course?.tees.find(tee => tee.id === teeId);
  teeSelect.disabled = !course || Boolean(existingRound);
}

function applyMatchAssignment() {
  const match = selectedMatch();
  existingRound = match ? playerData.rounds.find(round => round.match_id === match.id) : undefined;
  courseSelect.disabled = Boolean(match);
  courseSelect.value = existingRound?.course_id ?? match?.course_id ?? '';
  populateTees(currentCourse(), existingRound?.tee_id ?? '');
  scores = mergePersistedScores(blankScores(), existingRound?.scores ?? []);
  if (existingRound) showMessage('Submitted holes are locked. Continue with the remaining holes.');
}

courseSelect.addEventListener('change', () => {
  const course = currentCourse();
  populateTees(course);
  scores = blankScores();
  renderScorecard();
  updateCourseHandicap();
});

teeSelect.addEventListener('change', () => {
  selectedTee = currentCourse()?.tees.find(tee => tee.id === teeSelect.value);
  const facts = document.querySelectorAll('#teeFacts b');
  facts[0].textContent = selectedTee?.rating ?? '—';
  facts[1].textContent = selectedTee?.slope ?? '—';
  facts[2].textContent = selectedTee?.par ?? '—';
  scores = blankScores();
  updateCourseHandicap();
  renderScorecard();
});

handicapInput.addEventListener('input', updateCourseHandicap);
matchSelect.addEventListener('change', () => {
  const match = selectedMatch();
  const segments = selectedMatchSegments();
  const formatNames = new Set(segments.map(segment => formatName(segment.format)));
  const scoringNames = new Set(segments.map(segment => formatName(segment.scoring_mode)));
  document.querySelector('#matchFormat').textContent = match
    ? (formatNames.size > 1 ? 'Mixed segments' : [...formatNames][0] ?? formatName(match.format))
    : 'Individual';
  document.querySelector('#scoringMode').textContent = match
    ? (scoringNames.size > 1 ? 'Mixed by segment' : [...scoringNames][0] ?? formatName(match.scoring_mode))
    : 'Gross';
  applyMatchAssignment();
  const blockReason = scoreEntryBlockReason();
  if (blockReason) showMessage(blockReason, true);
  updateCourseHandicap();
  renderScorecard();
});

document.querySelector('#memberNav').addEventListener('click', event => {
  const button = event.target.closest('[data-member-view]');
  if (button) showMemberView(button.dataset.memberView);
});
document.querySelectorAll('[data-open-view]').forEach(button => {
  button.addEventListener('click', () => showMemberView(button.dataset.openView));
});

saveButton.addEventListener('click', async () => {
  try {
    setSyncStatus('Saving…', true);
    showMessage('');
    const blockReason = scoreEntryBlockReason();
    if (blockReason) throw new Error(blockReason);
    const courseHandicap = updateCourseHandicap();
    if (selectedScoringMode() === 'net' && courseHandicap === null) {
      throw new Error('A course rating and slope are required for net scoring.');
    }
    await saveProfile(session.user.id, playerData.profile.display_name, handicapInput.value || 0);
    assertRoundAssignment(existingRound, {
      matchId: matchSelect.value || null,
      courseId: courseSelect.value,
      teeId: teeSelect.value,
    });
    const savedRound = await saveRound({
      userId: session.user.id,
      matchId: matchSelect.value || null,
      courseId: courseSelect.value,
      teeId: teeSelect.value,
      courseHandicap,
      scores: unsavedScoreRows(scores),
      existingRound,
    });
    existingRound = savedRound;
    if (matchSelect.value) teeSelect.disabled = true;
    const roundIndex = playerData.rounds.findIndex(round => round.id === savedRound.id);
    if (roundIndex >= 0) playerData.rounds[roundIndex] = savedRound;
    else playerData.rounds.push(savedRound);
    scores = mergePersistedScores(blankScores(), savedRound.scores ?? []);
    renderScorecard();
    setSyncStatus('Saved');
    showMessage('Scores saved. Submitted holes are now locked; continue with any remaining holes.');
  } catch (error) {
    setSyncStatus('Save failed', true);
    showMessage(error.message, true);
  }
});

signInModeButton.addEventListener('click', () => setAuthMode('signin'));
signUpModeButton.addEventListener('click', () => setAuthMode('signup'));

authForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (authMode === 'recovery' && !canSetNewPassword(authMode, recoveryVerified)) {
    showAuthMessage('Verify the password reset link before choosing a new password.', true);
    return;
  }
  const values = {
    mode: authMode,
    displayName: displayNameInput.value,
    email: emailInput.value,
    password: passwordInput.value,
  };
  const errors = validateAuthInput(values);
  if (Object.keys(errors).length) {
    showAuthMessage(Object.values(errors)[0], true);
    return;
  }
  try {
    authSubmitButton.disabled = true;
    showAuthMessage(authMode === 'recovery'
      ? 'Saving your new password…'
      : authMode === 'signup' ? 'Creating your account…' : 'Signing in…');
    if (authMode === 'recovery') {
      await setNewPassword(values.password);
      await signOut();
      window.history.replaceState({}, '', new URL('portal.html', window.location.href).href);
      passwordInput.value = '';
      setAuthMode('signin');
      showAuthMessage('Password updated. Sign in with your new password.');
      return;
    }
    if (authMode === 'signup') {
      const result = await signUpWithEmail(values);
      if (!result.session) {
        showAuthMessage('Check your email to verify your account, then return here to sign in.');
        return;
      }
    } else {
      await signInWithEmail(values.email, values.password);
    }
    window.location.reload();
  } catch (error) {
    showAuthMessage(error.message, true);
  } finally {
    authSubmitButton.disabled = false;
  }
});

forgotPasswordButton.addEventListener('click', async () => {
  const errors = validateAuthInput({ mode: 'signin', email: emailInput.value, password: 'recovery' });
  if (errors.email) {
    showAuthMessage(errors.email, true);
    return;
  }
  try {
    await requestPasswordReset(emailInput.value);
    showAuthMessage('Password reset instructions are on the way.');
  } catch (error) {
    showAuthMessage(error.message, true);
  }
});

async function beginProviderSignIn(action) {
  try {
    showAuthMessage('Opening secure sign-in…');
    await action();
  } catch (error) {
    showAuthMessage(error.message, true);
  }
}

document.querySelector('#googleSignIn').addEventListener('click', () => beginProviderSignIn(signInWithGoogle));
document.querySelector('#signOutButton').addEventListener('click', async () => { await signOut(); window.location.reload(); });

async function start() {
  if (!hasSupabaseConfig()) {
    setupMessage.hidden = false;
    return;
  }
  try {
    const isRecovery = new URL(window.location.href).searchParams.get('recovery') === '1';
    if (isRecovery) {
      authView.hidden = false;
      accessPendingView.hidden = true;
      dashboardView.hidden = true;
      setAuthMode('recovery');
      recoveryVerified = false;
      authSubmitButton.disabled = true;
      showAuthMessage('Verifying your password reset link…');
      session = await waitForPasswordRecovery();
      if (!session) {
        showAuthMessage('This password reset link is invalid or has expired. Request a new link.', true);
      } else {
        recoveryVerified = true;
        authSubmitButton.disabled = false;
        showAuthMessage('Reset link verified. Choose your new password.');
      }
      return;
    }
    session = await getCurrentSession();
    if (!session) return;
    authView.hidden = true;
    document.querySelector('#signOutButton').hidden = false;
    document.querySelector('#playerIdentity').textContent = session.user.email;
    playerData = await loadPlayerData(session.user.id);
    document.querySelector('#adminLink').hidden = playerData.profile.role !== 'admin';
    if (playerData.profile.role !== 'admin' && !hasActiveTournamentMembership(playerData.memberships)) {
      accessPendingView.hidden = false;
      dashboardView.hidden = true;
      return;
    }
    accessPendingView.hidden = true;
    dashboardView.hidden = false;
    setSyncStatus('Loading…', true);
    document.querySelector('#playerName').textContent = playerData.profile.display_name || session.user.user_metadata?.full_name || 'Golfer';
    handicapInput.value = playerData.profile.handicap_index ?? '';
    populateCourses();
    renderMemberHome();
    setSyncStatus('Synced');
  } catch (error) {
    authView.hidden = false;
    accessPendingView.hidden = true;
    dashboardView.hidden = true;
    setupMessage.hidden = false;
    setupMessage.querySelector('p').textContent = error.message;
  }
}

start();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    registrations.forEach(registration => registration.unregister());
  });
}
if ('caches' in window) {
  caches.keys().then(keys => keys.filter(key => key.startsWith('hereford-cup-')).forEach(key => caches.delete(key)));
}
