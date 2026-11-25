import { courseHandicapForTee, scoreIndividualHoleForSegment } from './golf.js?v=handicap-scoring-1';
import { matchPoints } from './scoring.js';
import { assignedRoundScoringMode, formatSegmentLabel, individualEntryBlockReason, segmentHoleCount } from './formats.js?v=handicap-scoring-1';
import { summarizeLeagueStats, summarizePlayerStats } from './stats.js';
import { assertRoundAssignment, holeNumbersForRound, mergePersistedScores, unsavedScoreRows } from './round-entry.js?v=round-holes-1';
import { commentaryForMatch, formatHomeDate, formatHomeDateRange, formatItineraryTime, formatMatchupPlayers, orderHomeMatches } from './home.js?v=itinerary-1';
import { avatarInitials, normalizeProfileInput, playerDisplayName, profileAvatarUrl, validateProfilePhoto } from './profile.js?v=player-name-1';
import {
  assignedSegmentsForPlayer,
  membershipAccessTransition,
  nextUpcomingAssignment,
  playerDirectoryEntries,
  segmentRelationships,
  selectActiveTournament,
} from './member.js?v=member-role-1';
import { hasSupabaseConfig } from './config.js';
import {
  canSetNewPassword,
  completeMatchIfReady,
  generateMatchCommentary,
  getCurrentSession,
  hasActiveTournamentMembership,
  loadOwnTournamentMemberships,
  loadPlayerData,
  requestTournamentMembership,
  requestPasswordReset,
  removeProfilePhoto,
  saveNotificationPreferences,
  saveProfile,
  saveRound,
  selectTexasScrambleCourseTee,
  setNewPassword,
  signInWithEmail,
  signInWithGoogle,
  signOut,
  signUpWithEmail,
  submitMatchHoleOutcome,
  submitTexasScrambleHole,
  uploadProfilePhoto,
  validateAuthInput,
  waitForPasswordRecovery,
} from './supabase.js?v=organizer-scoring-2';

const authView = document.querySelector('#authView');
const accessPendingView = document.querySelector('#accessPendingView');
const dashboardView = document.querySelector('#dashboardView');
const setupMessage = document.querySelector('#setupMessage');
const courseSelect = document.querySelector('#courseSelect');
const teeSelect = document.querySelector('#teeSelect');
const matchSelect = document.querySelector('#matchSelect');
const holeRangeSelect = document.querySelector('#holeRangeSelect');
const handicapInput = document.querySelector('#handicapIndex');
const scorecard = document.querySelector('#scorecard');
const emptyScorecard = document.querySelector('#emptyScorecard');
const saveButton = document.querySelector('#saveRound');
const assignmentSummary = document.querySelector('#assignmentSummary');
const teamScorecard = document.querySelector('#teamScorecard');
const teamScorecardRows = document.querySelector('#teamScorecardRows');
const teeShotProgress = document.querySelector('#teeShotProgress');
const holeOutcomeScorecard = document.querySelector('#holeOutcomeScorecard');
const holeOutcomeRows = document.querySelector('#holeOutcomeRows');
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
const profileSetupDialog = document.querySelector('#profileSetupDialog');
const profileSetupForm = document.querySelector('#profileSetupForm');
const profileDisplayName = document.querySelector('#profileDisplayName');
const profileHandicap = document.querySelector('#profileHandicap');
const profilePhotoInput = document.querySelector('#profilePhotoInput');
const profilePhotoRemove = document.querySelector('#profilePhotoRemove');
const profileSetupMessage = document.querySelector('#profileSetupMessage');
const notificationPreferencesForm = document.querySelector('#notificationPreferencesForm');
const notificationPreferencesMessage = document.querySelector('#notificationPreferencesMessage');

let session;
let playerData;
let selectedTee;
let existingRound;
let authMode = 'signin';
let recoveryVerified = false;
let membershipRefreshPromise;
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

function renderProfileAvatar() {
  const name = playerData?.profile?.display_name || session?.user?.user_metadata?.full_name || 'Golfer';
  const uploadedPath = playerData?.profile?.profile_photo_path;
  const avatarUrl = playerData?.profilePhotoUrls?.[uploadedPath] || profileAvatarUrl(session?.user?.user_metadata);
  profilePhotoRemove.hidden = !uploadedPath;
  document.querySelectorAll('[data-profile-avatar]').forEach(avatar => {
    avatar.replaceChildren();
    if (avatarUrl) {
      const image = document.createElement('img');
      image.src = avatarUrl;
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      avatar.append(image);
    } else {
      avatar.textContent = avatarInitials(name);
    }
  });
}

function openProfileSetup() {
  profileDisplayName.value = playerData.profile.display_name || session.user.user_metadata?.full_name || '';
  profileHandicap.value = playerData.profile.handicap_index ?? '';
  profilePhotoInput.value = '';
  profileSetupMessage.textContent = '';
  profileSetupMessage.classList.remove('is-error');
  renderProfileAvatar();
  if (typeof profileSetupDialog.showModal === 'function') {
    if (!profileSetupDialog.open) profileSetupDialog.showModal();
  } else {
    profileSetupDialog.setAttribute('open', '');
  }
  profileDisplayName.focus();
}

function closeProfileSetup() {
  if (typeof profileSetupDialog.close === 'function' && profileSetupDialog.open) {
    profileSetupDialog.close();
  } else {
    profileSetupDialog.removeAttribute('open');
  }
}

function renderHomeSummary() {
  const tournament = playerData.tournament;
  const membership = playerData.memberships.find(item => item.tournaments?.id === tournament?.id)
    ?? playerData.memberships[0];
  document.querySelector('#homeSeason').textContent = tournament?.name
    ?? `${tournament?.edition_year ?? ''} Hereford Cup`.trim();
  const statusLabels = { setup: 'Preseason', open: 'Open', live: 'Live', complete: 'Complete', archived: 'Archived' };
  document.querySelector('#homeTournamentStatus').textContent = (statusLabels[tournament?.status] ?? 'Season').toUpperCase();
  renderProfileAvatar();
  document.querySelector('#homeHandicap').textContent = playerData.profile.handicap_index ?? '—';
  document.querySelector('#homeTeam').textContent = membership?.team === 'cardinal' ? 'Blue' : membership?.team === 'silver' ? 'White' : 'Unassigned';
  document.querySelector('#homeRounds').textContent = summarizePlayerStats(playerData.statistics, session.user.id).rounds;
  const start = formatHomeDate(tournament?.starts_on, { year: 'numeric' });
  document.querySelector('#homeTournamentMeta').textContent = start
    ? `${start} · Your schedule, matches, and Cup standing.`
    : 'Your schedule, matches, and Cup standing in one place.';
  const tripRange = formatHomeDateRange(tournament?.starts_on, tournament?.ends_on);
  document.querySelector('#homeScheduleTitle').textContent = tripRange ? `${tripRange} itinerary` : 'Tournament itinerary';
}

function renderSchedule() {
  const container = document.querySelector('#schedulePreview');
  container.replaceChildren();
  if (!playerData.events.length) {
    container.append(element('p', 'empty-panel', 'The itinerary has not been published yet.'));
    return;
  }
  for (const event of playerData.events) {
    const row = element('article', 'schedule-item');
    const time = element(event.time_precision === 'tbd' ? 'span' : 'time', '',
      formatItineraryTime(event.starts_at, event.ends_at, event.time_precision, true));
    if (time.tagName === 'TIME') time.dateTime = event.starts_at;
    row.append(time);
    const details = element('div');
    details.append(element('strong', '', event.title));
    if (event.public_details) details.append(element('span', '', event.public_details));
    if (event.notes && event.notes !== event.public_details) details.append(element('span', '', event.notes));
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
  const matches = orderHomeMatches(playerData.matches).slice(0, 6);
  if (!matches.length) {
    container.append(element('p', 'empty-panel', 'Matches will appear when pairings are published.'));
    return;
  }
  for (const match of matches) {
    const row = element('article', 'home-result-item');
    const meta = element('div', 'result-meta');
    const status = match.status === 'live' ? 'LIVE' : match.status === 'final' ? 'FINAL' : 'UP NEXT';
    meta.append(element('strong', match.status === 'live' ? 'is-live' : '', status));
    const time = element('time', '', formatHomeDate(match.starts_at, { weekday: 'short' }).toUpperCase());
    if (match.starts_at) time.dateTime = match.starts_at;
    meta.append(time);
    const details = element('div', 'result-details');
    details.append(element('strong', '', match.name));
    const matchup = formatMatchupPlayers(match.match_players);
    const context = [matchup, match.courses?.name, formatName(match.format)].filter(Boolean).join(' · ');
    details.append(element('span', '', context || 'Pairing details pending'));
    const commentary = commentaryForMatch(playerData.commentaries, match.id);
    if (commentary) {
      const commentaryBlock = element('div', 'result-commentary');
      const provenance = commentary.ai_generated
        ? 'AI-generated'
        : 'Administrator edited';
      commentaryBlock.append(
        element('small', 'result-commentary-label', provenance),
        element('p', '', commentary.commentary),
      );
      details.append(commentaryBlock);
    }
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

function renderPlayers() {
  const container = document.querySelector('#playersList');
  const players = playerDirectoryEntries(playerData.players, playerData.statistics);
  container.replaceChildren();
  if (!players.length) {
    container.append(element('p', 'empty-panel', 'Players will appear when the roster is published.'));
    return;
  }
  for (const player of players) {
    const card = element('article', `player-directory-card${player.userId === session.user.id ? ' is-you' : ''}`);
    const avatar = element('span', 'profile-avatar player-directory-avatar', avatarInitials(player.displayName));
    const photoUrl = playerData.profilePhotoUrls?.[player.photoPath];
    if (photoUrl) {
      const image = document.createElement('img');
      image.src = photoUrl;
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      avatar.replaceChildren(image);
    }
    avatar.setAttribute('aria-hidden', 'true');
    const identity = element('div', 'player-directory-identity');
    const nameRow = element('div', 'player-directory-name');
    nameRow.append(element('strong', '', player.displayName));
    if (player.userId === session.user.id) nameRow.append(element('span', 'player-you-badge', 'You'));
    identity.append(nameRow, element('small', '', `${player.team} · ${player.role}`));
    const metrics = element('div', 'player-directory-metrics');
    const handicap = element('span');
    handicap.append(element('small', '', 'HANDICAP'), element('strong', '', player.handicapIndex ?? '—'));
    const rounds = element('span');
    rounds.append(element('small', '', 'ROUNDS'), element('strong', '', player.rounds));
    metrics.append(handicap, rounds);
    card.append(avatar, identity, metrics);
    container.append(card);
  }
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

function renderNotificationPreferences() {
  const preferences = playerData.notificationPreferences ?? {
    reminders_enabled: true,
    schedule_updates_enabled: true,
    new_member_admin_enabled: true,
  };
  notificationPreferencesForm.elements.remindersEnabled.checked = preferences.reminders_enabled;
  notificationPreferencesForm.elements.scheduleUpdatesEnabled.checked = preferences.schedule_updates_enabled;
  notificationPreferencesForm.elements.newMemberAdminEnabled.checked = preferences.new_member_admin_enabled;
  const membership = playerData.memberships.find(item => item.tournaments?.id === playerData.tournament?.id);
  notificationPreferencesForm.querySelector('[data-admin-notification]').hidden = membership?.role !== 'admin';
  notificationPreferencesMessage.textContent = '';
}

function renderMemberHome() {
  renderHomeSummary();
  renderSchedule();
  renderLiveMatch();
  renderRecentResults();
  renderCup();
  renderStats();
  renderPlayers();
  renderRules();
  renderNotificationPreferences();
  showMemberView('home');
}

function currentCourse() {
  return playerData?.courses.find(course => course.id === courseSelect.value);
}

function selectedMatch() {
  return playerData?.assignments.find(item => item.matches?.id === matchSelect.value)?.matches;
}

function selectedScrambleSquad() {
  return playerData?.scrambleSquads?.find(squad => squad.match_id === matchSelect.value);
}

function selectedOutcomeSegments() {
  return selectedMatchSegments().filter(segment => segment.entry_mode === 'hole_outcomes');
}

function selectNextPlayableAssignment() {
  const playable = playerData.assignments
    .map(assignment => assignment.matches)
    .filter(match => match && match.status !== 'final')
    .sort((left, right) => new Date(left.starts_at || 0) - new Date(right.starts_at || 0));
  if (!playable.length) return;
  matchSelect.value = playable[0].id;
  matchSelect.dispatchEvent(new Event('change'));
}

function renderAssignmentSummary() {
  assignmentSummary.replaceChildren();
  const match = selectedMatch();
  if (!match) {
    assignmentSummary.append(element('p', '', 'Standalone gross scorecard. Select a course, tee, and hole range.'));
    return;
  }
  const squad = selectedScrambleSquad();
  const heading = element('strong', '', match.name);
  const details = document.createElement('ul');
  const add = text => details.append(element('li', '', text));
  if (squad) {
    const sessionRecord = squad.texas_scramble_sessions;
    const partners = (squad.texas_scramble_squad_players ?? []).map(player => player.profiles?.display_name || 'Player').join(', ');
    add(`Texas Scramble · ${squad.side === 'cardinal' ? 'Blue' : 'White'} · ${squad.label}`);
    add(`Squad: ${partners}`);
    add('Net stroke play · WHS team allowance · one Cup point per stroke under net par');
    add(`${sessionRecord.required_tee_shots} selected tee shots required from each player`);
    add(sessionRecord.course_id ? 'Course and tee are shared and locked for every squad.' : 'Select the course and tee; the first saved choice becomes shared for every squad.');
  } else {
    const segments = selectedMatchSegments();
    add(`${segments.map(segment => formatName(segment.format)).join(' / ')} · ${segments.some(segment => segment.entry_mode === 'hole_outcomes') ? 'Hole winner entry' : 'Full player scores'}`);
    add(`Holes ${playableHoleNumbers().join(', ')}`);
  }
  assignmentSummary.append(heading, details);
}

function selectedMatchSegments() {
  const match = selectedMatch();
  if (!match) return [];
  const matchSegments = playerData.segments.filter(segment => segment.match_id === match.id);
  return assignedSegmentsForPlayer(matchSegments, session.user.id);
}

function playableHoleNumbers() {
  return holeNumbersForRound(holeRangeSelect.value, selectedMatchSegments());
}

function syncHoleRangeControl() {
  holeRangeSelect.querySelector('option[data-assigned]')?.remove();
  const match = selectedMatch();
  holeRangeSelect.disabled = Boolean(match);
  if (!match) return;

  const holes = holeNumbersForRound('18', selectedMatchSegments());
  const key = holes.join(',');
  if (key === '1,2,3,4,5,6,7,8,9') holeRangeSelect.value = 'front9';
  else if (key === '10,11,12,13,14,15,16,17,18') holeRangeSelect.value = 'back9';
  else if (key === Array.from({ length: 18 }, (_, index) => index + 1).join(',')) holeRangeSelect.value = '18';
  else {
    const option = new Option(`${holes.length} assigned holes`, 'assigned');
    option.dataset.assigned = 'true';
    holeRangeSelect.add(option);
    holeRangeSelect.value = 'assigned';
  }
}

function scoreEntryBlockReason() {
  return individualEntryBlockReason(selectedMatchSegments());
}

function selectedScoringMode() {
  const match = selectedMatch();
  if (!match) return 'gross';
  return assignedRoundScoringMode(match, selectedMatchSegments());
}

function baseCourseHandicap() {
  if (!selectedTee || handicapInput.value === '') return null;
  return courseHandicapForTee(handicapInput.value, selectedTee, 'net');
}

function updateScoreModeHelp() {
  const help = document.querySelector('#scoreModeHelp');
  const courseMath = 'Course handicap is calculated from your index, tee rating, slope, and rating par.';
  const segmentMath = 'Gross holes ignore handicap strokes; net holes apply the segment allowance.';
  help.textContent = selectedMatch()
    ? `${courseMath} ${segmentMath}`
    : `No assigned match uses a standalone gross scorecard. ${courseMath} ${segmentMath}`;
}

function updateCourseHandicap() {
  if (!selectedTee) {
    document.querySelector('#courseHandicap').textContent = '—';
    return null;
  }
  if (handicapInput.value === '') {
    document.querySelector('#courseHandicap').textContent = '—';
    return null;
  }
  const handicap = courseHandicapForTee(handicapInput.value, selectedTee, 'net');
  document.querySelector('#courseHandicap').textContent = handicap ?? 'Rating pending';
  updateSummary();
  return handicap;
}

function updateSummary() {
  const playableHoles = new Set(playableHoleNumbers());
  const completed = scores.filter(score => playableHoles.has(score.hole_number) && Number(score.gross_score) > 0);
  const gross = completed.reduce((total, score) => total + Number(score.gross_score), 0);
  const holes = selectedTee?.holes ?? [];
  const par = completed.reduce((total, score) => {
    const hole = holes.find(item => item.hole_number === score.hole_number);
    return total + Number(hole?.par ?? 0);
  }, 0);
  const scoringMode = selectedScoringMode();
  const calculatedHandicap = baseCourseHandicap();
  const courseHandicap = calculatedHandicap ?? (scoringMode === 'gross' ? 0 : null);
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

function renderTexasScrambleScorecard() {
  const squad = selectedScrambleSquad();
  if (!squad) return false;
  scorecard.hidden = true;
  holeOutcomeScorecard.hidden = true;
  saveButton.hidden = true;
  const sessionRecord = squad.texas_scramble_sessions;
  const savedScores = squad.texas_scramble_hole_scores ?? [];
  const players = squad.texas_scramble_squad_players ?? [];
  const counts = new Map(players.map(player => [player.user_id, savedScores.filter(score => score.tee_shot_player_id === player.user_id).length]));
  teeShotProgress.replaceChildren(...players.map(player => {
    const name = player.profiles?.display_name || 'Player';
    const used = counts.get(player.user_id) ?? 0;
    return element('div', used >= sessionRecord.required_tee_shots ? 'is-complete' : '', `${name}: ${used} of ${sessionRecord.required_tee_shots} required drives used`);
  }));

  const holes = [...(selectedTee?.holes ?? [])]
    .filter(hole => hole.hole_number >= sessionRecord.start_hole && hole.hole_number <= sessionRecord.end_hole)
    .sort((left, right) => left.hole_number - right.hole_number);
  if (!holes.length) {
    teamScorecard.hidden = true;
    emptyScorecard.hidden = false;
    emptyScorecard.querySelector('p').textContent = 'Select the shared course and tee to open the Texas Scramble scorecard.';
    return true;
  }
  emptyScorecard.hidden = true;
  teamScorecard.hidden = false;
  teamScorecardRows.replaceChildren(...holes.map(hole => {
    const persisted = savedScores.find(score => Number(score.hole_number) === Number(hole.hole_number));
    const row = document.createElement('div');
    row.className = 'hole-row team-hole-row';
    row.append(element('div', 'hole-id', String(hole.hole_number)), element('div', 'hole-meta', `Par ${hole.par}`));
    const scoreLabel = document.createElement('label');
    scoreLabel.textContent = 'Team gross';
    const scoreInput = document.createElement('input');
    scoreInput.type = 'number';
    scoreInput.min = '1';
    scoreInput.max = '30';
    scoreInput.inputMode = 'numeric';
    scoreInput.value = persisted?.gross_score ?? '';
    scoreInput.disabled = Boolean(persisted);
    scoreLabel.append(scoreInput);
    const driveLabel = document.createElement('label');
    driveLabel.textContent = 'Tee shot used';
    const driveSelect = document.createElement('select');
    driveSelect.append(new Option('Select player', ''), ...players.map(player => new Option(player.profiles?.display_name || 'Player', player.user_id)));
    driveSelect.value = persisted?.tee_shot_player_id ?? '';
    driveSelect.disabled = Boolean(persisted);
    driveLabel.append(driveSelect);
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'button';
    submit.textContent = persisted ? 'Locked' : 'Save hole';
    submit.disabled = Boolean(persisted);
    submit.addEventListener('click', async () => {
      try {
        submit.disabled = true;
        if (!scoreInput.value || !driveSelect.value) throw new Error('Enter the team score and choose whose tee shot was used.');
        const result = await submitTexasScrambleHole({
          squadId: squad.id,
          holeNumber: hole.hole_number,
          grossScore: scoreInput.value,
          teeShotPlayerId: driveSelect.value,
        });
        squad.texas_scramble_hole_scores = [...savedScores, result.hole];
        Object.assign(squad, result.squad);
        if (result.finalized) selectedMatch().status = 'final';
        showMessage(result.finalized ? 'Texas Scramble scorecard complete. Cup points are final.' : 'Shared hole saved and locked.');
        renderTexasScrambleScorecard();
      } catch (error) {
        submit.disabled = false;
        showMessage(error.message, true);
      }
    });
    row.append(scoreLabel, driveLabel, submit);
    return row;
  }));
  const gross = savedScores.reduce((total, score) => total + Number(score.gross_score), 0);
  document.querySelector('#holesCompleted').textContent = savedScores.length;
  document.querySelector('#grossTotal').textContent = savedScores.length ? gross : '—';
  document.querySelector('#adjustedLabel').textContent = 'TEAM NET';
  document.querySelector('#netTotal').textContent = squad.net_score ?? '—';
  document.querySelector('#toPar').textContent = squad.status === 'final' ? `${Number(squad.points)} pts` : '—';
  return true;
}

function renderHoleOutcomeScorecard() {
  const segments = selectedOutcomeSegments();
  if (!segments.length) return false;
  scorecard.hidden = true;
  teamScorecard.hidden = true;
  emptyScorecard.hidden = true;
  saveButton.hidden = true;
  holeOutcomeScorecard.hidden = false;
  const outcomes = playerData.holeOutcomes ?? [];
  const holes = segments.flatMap(segment => Array.from({ length: segment.end_hole - segment.start_hole + 1 }, (_, index) => ({ segment, holeNumber: segment.start_hole + index })));
  holeOutcomeRows.replaceChildren(...holes.map(({ segment, holeNumber }) => {
    const persisted = outcomes.find(outcome => outcome.segment_id === segment.id && Number(outcome.hole_number) === holeNumber);
    const row = document.createElement('div');
    row.className = 'hole-row outcome-hole-row';
    row.append(element('div', 'hole-id', String(holeNumber)), element('div', 'hole-meta', `Holes ${segment.start_hole}–${segment.end_hole}`));
    const label = document.createElement('label');
    label.textContent = 'Hole result';
    const select = document.createElement('select');
    select.append(new Option('Choose result', ''), new Option('Blue', 'cardinal'), new Option('Halved', 'halved'), new Option('White', 'silver'));
    select.value = persisted?.winner ?? '';
    select.disabled = Boolean(persisted);
    label.append(select);
    const submit = document.createElement('button');
    submit.type = 'button';
    submit.className = 'button';
    submit.textContent = persisted ? 'Locked' : 'Save hole';
    submit.disabled = Boolean(persisted);
    submit.addEventListener('click', async () => {
      try {
        submit.disabled = true;
        if (!select.value) throw new Error('Choose Blue, Halved, or White.');
        const result = await submitMatchHoleOutcome({ segmentId: segment.id, holeNumber, winner: select.value });
        playerData.holeOutcomes.push(result.outcome);
        if (result.finalized) segment.status = 'final';
        showMessage(result.finalized ? 'Match-play segment complete.' : 'Hole outcome saved and locked.');
        renderHoleOutcomeScorecard();
      } catch (error) {
        submit.disabled = false;
        showMessage(error.message, true);
      }
    });
    row.append(label, submit);
    return row;
  }));
  document.querySelector('#holesCompleted').textContent = outcomes.filter(outcome => segments.some(segment => segment.id === outcome.segment_id)).length;
  document.querySelector('#grossTotal').textContent = '—';
  document.querySelector('#adjustedLabel').textContent = 'RESULT';
  document.querySelector('#netTotal').textContent = 'Match play';
  document.querySelector('#toPar').textContent = '—';
  return true;
}

function renderScorecard() {
  if (renderTexasScrambleScorecard()) return;
  if (renderHoleOutcomeScorecard()) return;
  teamScorecard.hidden = true;
  holeOutcomeScorecard.hidden = true;
  saveButton.hidden = false;
  const blockReason = scoreEntryBlockReason();
  if (blockReason) {
    scorecard.hidden = true;
    emptyScorecard.hidden = false;
    emptyScorecard.querySelector('p').textContent = blockReason;
    saveButton.disabled = true;
    return;
  }
  emptyScorecard.querySelector('p').textContent = 'Select a course and tee to open your scorecard.';
  const playableHoles = new Set(playableHoleNumbers());
  emptyScorecard.querySelector('span').textContent = playableHoles.size;
  const holes = [...(selectedTee?.holes ?? [])]
    .filter(hole => playableHoles.has(Number(hole.hole_number)))
    .sort((a, b) => a.hole_number - b.hole_number);
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
  for (const tee of (course?.tees ?? []).filter(tee => tee.rating_category !== 'F')) {
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
  const squad = selectedScrambleSquad();
  const scrambleSession = squad?.texas_scramble_sessions;
  existingRound = match && !squad ? playerData.rounds.find(round => round.match_id === match.id) : undefined;
  const sharedCourseId = scrambleSession?.course_id ?? '';
  const sharedTeeId = scrambleSession?.tee_id ?? '';
  courseSelect.disabled = Boolean(match && !squad) || Boolean(sharedCourseId);
  courseSelect.value = squad ? sharedCourseId : (existingRound?.course_id ?? match?.course_id ?? '');
  populateTees(currentCourse(), squad ? sharedTeeId : (existingRound?.tee_id ?? ''));
  teeSelect.disabled = Boolean(sharedTeeId) || (!currentCourse()) || Boolean(existingRound);
  scores = mergePersistedScores(blankScores(), existingRound?.scores ?? []);
  if (existingRound) showMessage('Submitted holes are locked. Continue with the remaining holes.');
  renderAssignmentSummary();
}

courseSelect.addEventListener('change', () => {
  const course = currentCourse();
  populateTees(course);
  scores = blankScores();
  renderScorecard();
  updateCourseHandicap();
});

teeSelect.addEventListener('change', async () => {
  selectedTee = currentCourse()?.tees.find(tee => tee.id === teeSelect.value);
  const facts = document.querySelectorAll('#teeFacts b');
  facts[0].textContent = selectedTee?.rating ?? '—';
  facts[1].textContent = selectedTee?.slope ?? '—';
  facts[2].textContent = selectedTee?.par ?? '—';
  const squad = selectedScrambleSquad();
  if (squad && selectedTee && !squad.texas_scramble_sessions.tee_id) {
    try {
      setSyncStatus('Locking shared tee…', true);
      const savedSession = await selectTexasScrambleCourseTee({
        sessionId: squad.session_id,
        courseId: courseSelect.value,
        teeId: teeSelect.value,
      });
      for (const item of playerData.scrambleSquads.filter(item => item.session_id === squad.session_id)) {
        item.texas_scramble_sessions = savedSession;
      }
      courseSelect.disabled = true;
      teeSelect.disabled = true;
      setSyncStatus('Shared tee locked');
      renderAssignmentSummary();
    } catch (error) {
      setSyncStatus('Not saved');
      showMessage(error.message, true);
      return;
    }
  }
  scores = blankScores();
  updateCourseHandicap();
  renderScorecard();
});

handicapInput.addEventListener('input', updateCourseHandicap);
holeRangeSelect.addEventListener('change', () => {
  if (holeRangeSelect.disabled) return;
  scores = blankScores();
  renderScorecard();
  updateCourseHandicap();
});
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
  updateScoreModeHelp();
  syncHoleRangeControl();
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

notificationPreferencesForm.addEventListener('submit', async event => {
  event.preventDefault();
  const submitButton = notificationPreferencesForm.querySelector('[type="submit"]');
  try {
    submitButton.disabled = true;
    notificationPreferencesMessage.textContent = 'Saving…';
    const saved = await saveNotificationPreferences({
      tournamentId: playerData.tournament.id,
      userId: session.user.id,
      remindersEnabled: notificationPreferencesForm.elements.remindersEnabled.checked,
      scheduleUpdatesEnabled: notificationPreferencesForm.elements.scheduleUpdatesEnabled.checked,
      newMemberAdminEnabled: notificationPreferencesForm.elements.newMemberAdminEnabled.checked,
    });
    playerData.notificationPreferences = saved;
    notificationPreferencesMessage.textContent = 'Email settings saved.';
    setSyncStatus('Synced');
  } catch (error) {
    notificationPreferencesMessage.textContent = error.message;
  } finally {
    submitButton.disabled = false;
  }
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
      courseHandicap: courseHandicap ?? 0,
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
    let savedMessage = 'Scores saved. Submitted holes are now locked; continue with any remaining holes.';
    if (matchSelect.value) {
      try {
        const completion = await completeMatchIfReady(matchSelect.value);
        if (completion?.finalized) {
          savedMessage = 'Scores saved. Match complete.';
          if (completion.commentary_eligible) {
            try {
              await generateMatchCommentary(matchSelect.value);
              savedMessage += ' The AI recap was generated.';
            } catch (commentaryError) {
              savedMessage += ` The recap could not be generated automatically: ${commentaryError.message}`;
            }
          }
        }
      } catch (completionError) {
        savedMessage += ` Automatic completion is waiting: ${completionError.message}`;
      }
    }
    showMessage(savedMessage);
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
        showAuthMessage('First, verify your email. Then return here and sign in. After you sign in, your membership request will be sent to an administrator for approval.');
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
document.querySelector('#profileSetupButton').addEventListener('click', openProfileSetup);
document.querySelector('#profileSetupClose').addEventListener('click', closeProfileSetup);
document.querySelector('#profileSetupCancel').addEventListener('click', closeProfileSetup);
profilePhotoInput.addEventListener('change', async () => {
  const file = profilePhotoInput.files?.[0];
  if (!file) return;
  try {
    validateProfilePhoto(file);
    profilePhotoInput.disabled = true;
    profilePhotoRemove.disabled = true;
    profileSetupMessage.textContent = 'Uploading picture…';
    profileSetupMessage.classList.remove('is-error');
    await uploadProfilePhoto(file);
    playerData = await loadPlayerData(session.user.id);
    renderMemberPage();
    profileSetupMessage.textContent = 'Picture uploaded.';
    setSyncStatus('Synced');
  } catch (error) {
    profileSetupMessage.textContent = error.message;
    profileSetupMessage.classList.add('is-error');
  } finally {
    profilePhotoInput.value = '';
    profilePhotoInput.disabled = false;
    profilePhotoRemove.disabled = false;
  }
});
profilePhotoRemove.addEventListener('click', async () => {
  try {
    profilePhotoInput.disabled = true;
    profilePhotoRemove.disabled = true;
    profileSetupMessage.textContent = 'Removing picture…';
    profileSetupMessage.classList.remove('is-error');
    await removeProfilePhoto();
    playerData = await loadPlayerData(session.user.id);
    renderMemberPage();
    profileSetupMessage.textContent = 'Uploaded picture removed.';
    setSyncStatus('Synced');
  } catch (error) {
    profileSetupMessage.textContent = error.message;
    profileSetupMessage.classList.add('is-error');
  } finally {
    profilePhotoInput.disabled = false;
    profilePhotoRemove.disabled = false;
  }
});
profileSetupDialog.addEventListener('click', event => {
  if (event.target === profileSetupDialog) closeProfileSetup();
});
profileSetupForm.addEventListener('submit', async event => {
  event.preventDefault();
  const submitButton = profileSetupForm.querySelector('[type="submit"]');
  try {
    submitButton.disabled = true;
    profileSetupMessage.textContent = 'Saving…';
    profileSetupMessage.classList.remove('is-error');
    const values = normalizeProfileInput(profileDisplayName.value, profileHandicap.value);
    await saveProfile(session.user.id, values.displayName, values.handicapIndex);
    playerData.profile.display_name = values.displayName;
    playerData.profile.handicap_index = values.handicapIndex;
    handicapInput.value = values.handicapIndex;
    document.querySelector('#playerIdentity').textContent = values.displayName;
    document.querySelector('#playerName').textContent = values.displayName;
    renderHomeSummary();
    updateCourseHandicap();
    profileSetupMessage.textContent = 'Profile saved.';
    setSyncStatus('Synced');
    window.setTimeout(closeProfileSetup, 350);
  } catch (error) {
    profileSetupMessage.textContent = error.message;
    profileSetupMessage.classList.add('is-error');
  } finally {
    submitButton.disabled = false;
  }
});

async function refreshMembershipAccess() {
  if (!session || !playerData || document.hidden) return;
  if (membershipRefreshPromise) return membershipRefreshPromise;
  membershipRefreshPromise = (async () => {
    const freshMemberships = await loadOwnTournamentMemberships(session.user.id);
    const transition = membershipAccessTransition(playerData.memberships, freshMemberships);
    if (transition === 'request') {
      await requestTournamentMembership(selectActiveTournament(playerData.memberships)?.id);
      window.location.reload();
      return;
    }
    if (transition === 'reload') {
      window.location.reload();
      return;
    }
    if (transition === 'denied') {
      playerData.memberships = freshMemberships;
      setupMessage.hidden = false;
      setupMessage.querySelector('p').textContent = 'This access request was denied. Reload the page when you are ready to submit a new request.';
    }
  })();
  try {
    return await membershipRefreshPromise;
  } finally {
    membershipRefreshPromise = null;
  }
}

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
    document.querySelector('#publicHomeLink').hidden = false;
    document.querySelector('#signOutButton').hidden = false;
    document.querySelector('#playerIdentity').textContent = playerDisplayName(null, session.user);
    await requestTournamentMembership();
    playerData = await loadPlayerData(session.user.id);
    document.querySelector('#playerIdentity').textContent = playerDisplayName(playerData.profile, session.user);
    const tournamentAdmin = playerData.memberships.some(membership => membership.status === 'active' && membership.role === 'admin');
    document.querySelector('#adminLink').hidden = playerData.profile.role !== 'admin' && !tournamentAdmin;
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
    selectNextPlayableAssignment();
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

function refreshMembershipAccessFromLifecycle() {
  refreshMembershipAccess().catch(error => {
    setupMessage.hidden = false;
    setupMessage.querySelector('p').textContent = error.message;
  });
}

window.addEventListener('focus', refreshMembershipAccessFromLifecycle);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshMembershipAccessFromLifecycle();
});
setInterval(refreshMembershipAccessFromLifecycle, 30000);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    registrations.forEach(registration => registration.unregister());
  });
}
if ('caches' in window) {
  caches.keys().then(keys => keys.filter(key => key.startsWith('hereford-cup-')).forEach(key => caches.delete(key)));
}
