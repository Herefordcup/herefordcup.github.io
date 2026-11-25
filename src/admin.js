import { validateSegments } from './formats.js';
import { scrambleLocalStart, scrambleLockReason } from './texas-scramble-planner.js?v=organizer-scoring-2';
import { applyMemberCardVisibility, createMutationGate, easternDateTimeToIso, filterActiveMemberships, moveFocusFromFilteredCard, optionalNumber, segmentPlayerFromMembership, segmentPlayerOptions, tournamentCompletionReadiness } from './admin-helpers.js?v=tournament-completion-1';
import { summarizeLegacyLedger } from './legacy-ledger.js?v=legacy-ledger-2';
import { deriveSegmentResult } from './match-results.js?v=organizer-scoring-2';
import { formatMatchStatus } from './scoring.js';
import { createCorrectionEditor, isSharedSegment, renderTeamCorrectionAudits, teamValue } from './team-correction-editor.js?v=organizer-scoring-2';
import {
  completeTournamentArchive,
  correctHoleScore,
  correctTeamScoreEntry,
  denyTournamentMembership,
  deleteTournamentMembership,
  deleteLegacyPhoto,
  deleteLegacyResult,
  getCurrentSession,
  generateMatchCommentary,
  finalizeMatchResults,
  loadAdminData,
  loadCorrectionMatch,
  loadMatchResultAudits,
  loadTeamCorrectionAudits,
  loadMembershipRosterData,
  loadPlayerData,
  saveCommentarySettings,
  saveCourseWithTee,
  saveLegacyEdition,
  saveLegacyResult,
  saveMatchPlan,
  saveTexasScramblePlan,
  saveTournamentRule,
  setTournamentMemberHandicap,
  setTournamentMemberRole,
  setTournamentMemberTeam,
  setTournamentMembershipStatus,
  uploadLegacyPhoto,
  updateCommentaryStatus,
  updateCommentaryText,
} from './supabase.js?v=organizer-scoring-2';

const courseForm = document.querySelector('#courseForm');
const holesContainer = document.querySelector('#adminHoles');
const courseMessage = document.querySelector('#adminMessage');
const matchPlanForm = document.querySelector('#matchPlanForm');
const matchPlanMessage = document.querySelector('#matchPlanMessage');
const segmentRows = document.querySelector('#segmentRows');
const segmentTemplate = document.querySelector('#segmentTemplate');
const texasScrambleForm = document.querySelector('#texasScrambleForm');
const texasScrambleTournament = document.querySelector('#texasScrambleTournament');
const texasScrambleSavedSession = document.querySelector('#texasScrambleSavedSession');
const texasScrambleCourse = document.querySelector('#texasScrambleCourse');
const texasScrambleTee = document.querySelector('#texasScrambleTee');
const texasScrambleSquads = document.querySelector('#texasScrambleSquads');
const texasScrambleMessage = document.querySelector('#texasScrambleMessage');
const ruleForm = document.querySelector('#ruleForm');
const ruleExisting = document.querySelector('#ruleExisting');
const ruleSortOrder = document.querySelector('#ruleSortOrder');
const rulePublishedList = document.querySelector('#rulePublishedList');
const commentarySettingsForm = document.querySelector('#commentarySettingsForm');
const commentaryTournament = document.querySelector('#commentaryTournament');
const scoreCorrectionForm = document.querySelector('#scoreCorrectionForm');
const correctionEditor = createCorrectionEditor(scoreCorrectionForm);
const correctionRound = document.querySelector('#correctionRound');
const scoreCorrectionDialog = document.querySelector('#scoreCorrectionDialog');
const openScoreCorrection = document.querySelector('#openScoreCorrection');
const resultFinalizationForm = document.querySelector('#resultFinalizationForm');
const resultMatch = document.querySelector('#resultMatch');
const resultSegmentRows = document.querySelector('#resultSegmentRows');
const resultAuditHistory = document.querySelector('#resultTransitions');
const teamCorrectionHistory = document.querySelector('#teamCorrectionHistory');
const tournamentCompletionForm = document.querySelector('#tournamentCompletionForm');
const completionTournament = document.querySelector('#completionTournament');
const completionReadiness = document.querySelector('#completionReadiness');
const completionConfirmation = document.querySelector('#completionConfirmation');
const adminContent = document.querySelector('#adminContent');
const membershipMessage = document.querySelector('#membershipMessage');
const membershipManagement = document.querySelector('#membershipManagement');
const refreshMembershipsButton = document.querySelector('#refreshMemberships');
const activeMemberCount = document.querySelector('#activeMemberCount');
const activeMemberSearch = document.querySelector('#activeMemberSearch');
const activeMemberTeamFilter = document.querySelector('#activeMemberTeamFilter');
const activeMemberRoleFilter = document.querySelector('#activeMemberRoleFilter');
const activeMemberFilterEmpty = document.querySelector('#activeMemberFilterEmpty');
const legacyEditionForm = document.querySelector('#legacyEditionForm');
const legacyEditionSelect = document.querySelector('#legacyEditionSelect');
const legacyResultForm = document.querySelector('#legacyResultForm');
const legacyPhotoForm = document.querySelector('#legacyPhotoForm');
const legacyTabs = [...document.querySelectorAll('[data-legacy-tab]')];
const legacyPanels = [...document.querySelectorAll('[data-legacy-panel]')];
const membershipMutationGate = createMutationGate(membershipManagement);
const defaultPars = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4];

let session;
let adminData;
let membershipRosterRefreshPromise;
let correctionDialogTrigger;
let correctionOpenRequest = 0;
let teamHistoryRequest = 0;
let savingCorrection = false;
let globalAdministrator = false;

function setMessage(target, text, isError = false) {
  target.textContent = text;
  target.style.color = isError ? '#9b1730' : '';
}

for (let hole = 1; hole <= 18; hole += 1) {
  const row = document.createElement('div');
  row.className = 'admin-hole';
  row.innerHTML = `<strong>${hole}</strong><label>Par<input name="hole-${hole}-par" type="number" min="3" max="6" value="${defaultPars[hole - 1]}" required></label><label>SI<input name="hole-${hole}-si" type="number" min="1" max="18" value="${hole}" required></label><label>Yards<input name="hole-${hole}-yards" type="number" min="50" max="750"></label>`;
  holesContainer.append(row);
}

function activeTournamentId() {
  return document.querySelector('#matchTournament').value;
}

function membersForTournament(tournamentId) {
  return adminData.memberships.filter(membership => membership.tournament_id === tournamentId && membership.status === 'active');
}

function populateSegmentPlayerSelect(playerSelect, selectedUserId = playerSelect.value) {
  const state = segmentPlayerOptions(membersForTournament(activeTournamentId()), selectedUserId);
  playerSelect.replaceChildren(...state.options.map(({ value, label, disabled }) => {
    const option = new Option(label, value);
    option.disabled = disabled;
    return option;
  }));
  playerSelect.value = state.selectedUserId;
}

function refreshSegmentPlayerOptions() {
  for (const playerSelect of segmentRows.querySelectorAll('[data-player-select]')) {
    populateSegmentPlayerSelect(playerSelect);
  }
}

function createPlayerSlot(slotNumber) {
  const wrapper = document.createElement('div');
  wrapper.className = 'player-slot';
  const playerLabel = document.createElement('label');
  playerLabel.textContent = `Player ${slotNumber}`;
  const playerSelect = document.createElement('select');
  playerSelect.dataset.playerSelect = 'true';
  populateSegmentPlayerSelect(playerSelect, '');
  playerLabel.append(playerSelect);
  wrapper.append(playerLabel);
  return wrapper;
}

function renumberSegments() {
  [...segmentRows.querySelectorAll('.segment-card')].forEach((card, index) => {
    card.querySelector('.segment-head strong').textContent = `Segment ${index + 1}`;
  });
}

function addSegment({ startHole = 1, endHole = 18, format = 'fourball', scoringMode = 'net', entryMode = 'individual_scores', pointValue = 1 } = {}) {
  const card = segmentTemplate.content.firstElementChild.cloneNode(true);
  card.querySelector('[name="startHole"]').value = startHole;
  card.querySelector('[name="endHole"]').value = endHole;
  card.querySelector('[name="format"]').value = format;
  card.querySelector('[name="scoringMode"]').value = scoringMode;
  card.querySelector('[name="entryMode"]').value = entryMode;
  card.querySelector('[name="pointValue"]').value = pointValue;
  const playerGrid = card.querySelector('.segment-player-grid');
  for (let slot = 1; slot <= 4; slot += 1) playerGrid.append(createPlayerSlot(slot));
  card.querySelector('.remove-segment').addEventListener('click', () => {
    card.remove();
    renumberSegments();
  });
  segmentRows.append(card);
  renumberSegments();
}

function collectSegments() {
  return [...segmentRows.querySelectorAll('.segment-card')].map((card, index) => {
    const players = [...card.querySelectorAll('.player-slot')].flatMap((slot, playingIndex) => {
      const userId = slot.querySelector('[data-player-select]').value;
      if (!userId) return [];
      const membership = adminData.memberships.find(item => item.user_id === userId && item.tournament_id === activeTournamentId());
      const player = segmentPlayerFromMembership(membership, playingIndex + 1);
      return player ? [player] : [];
    });
    return {
      segmentNumber: index + 1,
      startHole: Number(card.querySelector('[name="startHole"]').value),
      endHole: Number(card.querySelector('[name="endHole"]').value),
      format: card.querySelector('[name="format"]').value,
      scoringMode: card.querySelector('[name="scoringMode"]').value,
      entryMode: card.querySelector('[name="entryMode"]').value,
      handicapAllowance: card.querySelector('[name="scoringMode"]').value === 'net' ? Number(card.querySelector('[name="handicapAllowance"]').value) : null,
      pointValue: Number(card.querySelector('[name="pointValue"]').value),
      players,
    };
  });
}

function rpcSegments(segments) {
  // save_match_plan persists each independent lineup to match_segment_players atomically.
  return segments.map(segment => ({
    segment_number: segment.segmentNumber,
    start_hole: segment.startHole,
    end_hole: segment.endHole,
    format: segment.format,
    scoring_mode: segment.scoringMode,
    entry_mode: segment.entryMode,
    handicap_allowance: segment.handicapAllowance,
    point_value: segment.pointValue,
    players: segment.players.map(player => ({ user_id: player.userId, team: player.team, side: player.side, playing_order: player.playingOrder })),
  }));
}

const texasScramblePreset = [
  { label: 'Blue A', side: 'cardinal', squad_number: 1, squad_size: 4 },
  { label: 'Blue B', side: 'cardinal', squad_number: 2, squad_size: 4 },
  { label: 'White A', side: 'silver', squad_number: 1, squad_size: 4 },
  { label: 'White B', side: 'silver', squad_number: 2, squad_size: 4 },
];
let savingTexasScramble = false;
let scrambleDraftDirty = false;
let scrambleDraftVersion;
const unverifiedScrambleIds = new Set();

function holdUnverifiedScramble(id) {
  unverifiedScrambleIds.add(id);
  if (![...texasScrambleSavedSession.options].some(o => o.value === id)) {
    texasScrambleSavedSession.add(new Option(texasScrambleForm.elements.name.value, id));
  }
  texasScrambleSavedSession.value = id;
}

function texasScrambleLock() {
  if (unverifiedScrambleIds.has(texasScrambleSavedSession.value)) return 'Lineup is read-only until verified. Reload the page before editing.';
  return scrambleLockReason(adminData, texasScrambleTournament.value, texasScrambleSavedSession.value);
}

function syncTexasScrambleControls() {
  const reason = texasScrambleLock();
  const courseAvailable = adminData.courses.some(course => course.id === texasScrambleCourse.value);
  texasScrambleForm.setAttribute('aria-busy', String(savingTexasScramble));
  texasScrambleForm.querySelector('button[type="submit"]').textContent = texasScrambleSavedSession.value ? 'Update saved lineup' : 'Save Texas Scramble plan';
  for (const control of texasScrambleForm.querySelectorAll('input, select, button')) {
    const selector = control === texasScrambleTournament || control === texasScrambleSavedSession;
    control.disabled = savingTexasScramble || (!selector && Boolean(reason)) || (control === texasScrambleTee && !courseAvailable);
  }
  return reason;
}

function restoreScrambleChoice(select, value, unavailableLabel) {
  select.value = value ?? '';
  if (value && select.value !== value) {
    const option = new Option(unavailableLabel, value);
    option.disabled = true;
    select.add(option);
    select.value = value;
  }
}

function refreshTexasScramblePlayerChoices() {
  const selects = [...texasScrambleSquads.querySelectorAll('[data-scramble-player]')];
  const chosen = new Set(selects.map(select => select.value).filter(Boolean));
  for (const select of selects) {
    const selected = select.value;
    const previous = select.selectedOptions[0];
    const side = select.closest('[data-squad-side]').dataset.squadSide;
    const options = membersForTournament(texasScrambleTournament.value)
      .filter(membership => membership.team === side)
      .map(membership => {
        const option = new Option(membership.profiles?.display_name || 'Player', membership.user_id);
        option.disabled = chosen.has(membership.user_id) && membership.user_id !== selected;
        return option;
      });
    select.replaceChildren(new Option('Select player', ''), ...options);
    restoreScrambleChoice(select, selected, previous?.disabled ? previous.text : `${previous?.text || 'Saved player'} · unavailable on this side`);
  }
}

function renderTexasScrambleSquads(session) {
  texasScrambleSquads.replaceChildren();
  const squads = texasScrambleSavedSession.value
    ? [...(session?.texas_scramble_squads ?? [])].sort((a, b) => a.side.localeCompare(b.side) || a.squad_number - b.squad_number)
    : texasScramblePreset;
  for (const squad of squads) {
    const players = [...(squad.texas_scramble_squad_players ?? [])].sort((a, b) => a.playing_order - b.playing_order);
    const card = document.createElement('fieldset');
    card.className = 'segment-card scramble-squad-card';
    if (squad.id) card.dataset.squadId = squad.id;
    card.dataset.squadSide = squad.side;
    card.dataset.squadNumber = String(squad.squad_number);
    const legend = document.createElement('legend');
    legend.textContent = squad.label;
    const grid = document.createElement('div');
    grid.className = 'segment-player-grid';
    for (let slot = 1; slot <= squad.squad_size; slot += 1) {
      const label = document.createElement('label');
      label.textContent = `Player ${slot}`;
      const select = document.createElement('select');
      select.required = true;
      select.dataset.scramblePlayer = 'true';
      select.dataset.playingOrder = String(slot);
      const player = players[slot - 1];
      if (player) select.add(new Option(player.profiles?.display_name || 'Player', player.user_id));
      select.addEventListener('change', refreshTexasScramblePlayerChoices);
      label.append(select);
      grid.append(label);
    }
    card.append(legend, grid);
    texasScrambleSquads.append(card);
  }
  refreshTexasScramblePlayerChoices();
}

function collectTexasScramblePlan(tournamentId, session) {
  const data = new FormData(texasScrambleForm);
  const squads = [...texasScrambleSquads.querySelectorAll('[data-squad-side]')].map(card => ({
    label: card.querySelector('legend').textContent,
    side: card.dataset.squadSide,
    squad_number: Number(card.dataset.squadNumber),
    player_ids: [...card.querySelectorAll('[data-scramble-player]')].map(select => select.value),
  }));
  const ids = squads.flatMap(s => s.player_ids);
  if (!squads.length || ids.some(id => !id)) throw new Error('Select a player for every Texas Scramble slot.');
  if (new Set(ids).size !== ids.length) throw new Error('A player can appear in only one Texas Scramble squad.');
  if (squads.some(s => ![2, 4].includes(s.player_ids.length))) throw new Error('Each squad must have two or four players.');
  const members = membersForTournament(tournamentId);
  if (squads.some(s => s.player_ids.some(id => !members.some(m => m.user_id === id && m.team === s.side)))) {
    throw new Error('Replace unavailable players with active members of the matching Cup side.');
  }
  const courseId = texasScrambleCourse.value || null;
  const teeId = texasScrambleTee.value || null;
  if (Boolean(courseId) !== Boolean(teeId)) throw new Error('Choose both course and tee or leave both for the players.');
  if (courseId && !adminData.courses.find(c => c.id === courseId)?.tees.some(t => t.id === teeId && ['M', 'U'].includes(t.rating_category))) {
    throw new Error('The saved course or tee is unavailable. Choose an available pair or leave both open.');
  }
  const localStart = data.get('startsAt');
  // An unchanged wall clock must retain seconds and the correct instant on a DST overlap.
  const startsAt = session && localStart === scrambleLocalStart(session.starts_at) ? session.starts_at : easternDateTimeToIso(localStart);
  return {
    session: {
      ...(session ? { id: session.id } : {}), tournament_id: tournamentId,
      name: data.get('name'), session_label: data.get('sessionLabel'), starts_at: startsAt,
      start_hole: session?.start_hole ?? 1, end_hole: session?.end_hole ?? 18,
      required_tee_shots: Number(data.get('requiredTeeShots')), course_id: courseId, tee_id: teeId,
    },
    squads,
  };
}

function populateTexasScrambleTees(teeId = '') {
  const course = adminData.courses.find(item => item.id === texasScrambleCourse.value);
  const tees = (course?.tees ?? []).filter(tee => ['M', 'U'].includes(tee.rating_category));
  texasScrambleTee.replaceChildren(new Option('Players select tee', ''), ...tees.map(tee => new Option(`${tee.name}${tee.rating === null || tee.slope === null ? ' · Rating pending' : ''}`, tee.id)));
  restoreScrambleChoice(texasScrambleTee, teeId, 'Saved tee (not in active catalog)');
  texasScrambleTee.disabled = !course;
}

function selectedScrambleSession() {
  return adminData.scrambleSessions.find(row => row.tournament_id === texasScrambleTournament.value && row.id === texasScrambleSavedSession.value);
}

function populateScrambleCourseChoices(courseId, teeId) {
  texasScrambleCourse.replaceChildren(new Option('Players select course', ''), ...adminData.courses.map(course => new Option(course.name, course.id)));
  restoreScrambleChoice(texasScrambleCourse, courseId, 'Saved course (not in active catalog)');
  populateTexasScrambleTees(teeId);
}

function hydrateTexasScramblePlanner() {
  const session = selectedScrambleSession();
  scrambleDraftDirty = false;
  scrambleDraftVersion = session?.updated_at;
  const fields = texasScrambleForm.elements;
  const isNew = !texasScrambleSavedSession.value;
  fields.name.value = session?.name ?? (isNew ? fields.name.defaultValue : '');
  fields.sessionLabel.value = session?.session_label ?? '';
  fields.startsAt.value = session ? scrambleLocalStart(session.starts_at) : '';
  const start = session?.start_hole ?? 1;
  const end = session?.end_hole ?? 18;
  const largestSquad = session ? Math.max(2, ...(session.texas_scramble_squads ?? []).map(s => s.squad_size)) : 4;
  fields.requiredTeeShots.max = Math.floor((end - start + 1) / largestSquad);
  fields.requiredTeeShots.value = session?.required_tee_shots ?? (isNew ? fields.requiredTeeShots.defaultValue : '');
  document.querySelector('#texasScrambleHoleRange').textContent = session || isNew ? `Holes ${start}–${end}.` : 'Hole range unavailable.';
  populateScrambleCourseChoices(session?.course_id, session?.tee_id);
  renderTexasScrambleSquads(session);
  const reason = syncTexasScrambleControls();
  setMessage(texasScrambleMessage, reason);
}

function populateTexasScramblePlanner({ tournamentId = texasScrambleTournament.value, sessionId = texasScrambleSavedSession.value, preserveDraft = false } = {}) {
  texasScrambleTournament.replaceChildren(...adminData.tournaments.map(t => new Option(`${t.name} · ${t.edition_year}`, t.id)));
  if (tournamentId) texasScrambleTournament.value = tournamentId;
  const sessions = adminData.scrambleSessions.filter(row => row.tournament_id === texasScrambleTournament.value);
  texasScrambleSavedSession.replaceChildren(new Option('New lineup', ''), ...sessions.map(row => new Option(`${row.name} · ${row.session_label}`, row.id)));
  if (sessionId && !sessions.some(row => row.id === sessionId)) texasScrambleSavedSession.add(new Option('Saved lineup unavailable', sessionId));
  texasScrambleSavedSession.value = sessionId;
  if (preserveDraft && scrambleDraftDirty && !texasScrambleLock()) {
    if (scrambleDraftVersion === selectedScrambleSession()?.updated_at) {
      populateScrambleCourseChoices(texasScrambleCourse.value, texasScrambleTee.value);
      refreshTexasScramblePlayerChoices();
      syncTexasScrambleControls();
    } else {
      hydrateTexasScramblePlanner();
      setMessage(texasScrambleMessage, 'This lineup changed elsewhere. The latest saved lineup is shown.');
    }
    return;
  }
  hydrateTexasScramblePlanner();
}

async function reloadTexasScrambleData() {
  const latest = await loadAdminData();
  // Mounted roster controls close over membership objects. Refresh the planner and
  // its lock evidence, but leave other editors, their records and audit caches intact.
  for (const key of ['scrambleSessions', 'matches', 'tournaments', 'rounds', 'legacyEditions', 'courses']) {
    adminData[key] = latest[key];
  }
  unverifiedScrambleIds.clear();
}

function activateLegacyTab(tabName, { focus = false } = {}) {
  const activeIndex = legacyTabs.findIndex(tab => tab.dataset.legacyTab === tabName);
  if (activeIndex < 0) return;
  for (const tab of legacyTabs) {
    const selected = tab.dataset.legacyTab === tabName;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    tab.classList.toggle('is-active', selected);
  }
  for (const panel of legacyPanels) panel.hidden = panel.dataset.legacyPanel !== tabName;
  if (focus) legacyTabs[activeIndex].focus();
}

function populateLegacyChoices() {
  const editions = adminData.legacyEditions;
  const options = editions.map(edition => new Option(`${edition.edition_year} · ${edition.venue}`, edition.id));
  const selectedEdition = legacyEditionSelect.value;
  legacyEditionSelect.replaceChildren(new Option('Add a new edition', ''), ...options.map(option => option.cloneNode(true)));
  legacyEditionSelect.value = editions.some(edition => edition.id === selectedEdition) ? selectedEdition : '';
  for (const select of [document.querySelector('#legacyResultEdition'), document.querySelector('#legacyPhotoEdition')]) {
    const selected = select.value;
    select.replaceChildren(...options.map(option => option.cloneNode(true)));
    if (editions.some(edition => edition.id === selected)) select.value = selected;
  }
  renderLegacyResultList();
  renderLegacyPhotoList();
}

function pointText(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
}

function renderLegacyReconciliation(edition = adminData.legacyEditions.find(item => item.id === legacyEditionSelect.value)) {
  const container = document.querySelector('#legacyReconciliation');
  container.replaceChildren();
  if (!edition) {
    container.textContent = 'Enter edition totals to preview reconciliation.';
    return;
  }
  const summary = summarizeLegacyLedger(edition);
  container.className = `legacy-reconciliation ${summary.reconciled ? 'is-reconciled' : 'is-unresolved'}`;
  const heading = document.createElement('strong');
  heading.textContent = summary.reconciled ? 'Final score reconciled' : 'Needs reconciliation';
  const metrics = document.createElement('dl');
  for (const [label, value] of [
    ['Expected', pointText(summary.expectedPoints)],
    ['Blue', pointText(summary.blueTotal)],
    ['White', pointText(summary.whiteTotal)],
    ['Recorded row awards', pointText(summary.rowAwardedPoints)],
    ['Unresolved', `${pointText(summary.unresolvedPoints)} points · ${summary.unresolvedRows} rows`],
    ['Overallocated', `${summary.overAllocatedRows.length} rows`],
  ]) {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    metrics.append(term, description);
  }
  container.append(heading, metrics);
  if (!summary.rowTotalsMatchEdition && summary.rowAwardedPoints !== null) {
    const note = document.createElement('p');
    note.textContent = `Row sums: Blue ${pointText(summary.rowBlueTotal)}, White ${pointText(summary.rowWhiteTotal)}. Edition totals are reported separately.`;
    container.append(note);
  }
}

function legacyEditionDraft() {
  const existing = adminData.legacyEditions.find(item => item.id === legacyEditionForm.elements.editionId.value);
  return {
    ...existing,
    expected_points: optionalNumber(legacyEditionForm.elements.expectedPoints.value),
    cardinal_total: optionalNumber(legacyEditionForm.elements.cardinalTotal.value),
    silver_total: optionalNumber(legacyEditionForm.elements.silverTotal.value),
    score_confidence: legacyEditionForm.elements.scoreConfidence.value,
    legacy_results: existing?.legacy_results ?? [],
  };
}

function renderLegacyResultList() {
  const container = document.querySelector('#legacyResultList');
  container.replaceChildren();
  const editionId = document.querySelector('#legacyResultEdition').value;
  const edition = adminData.legacyEditions.find(item => item.id === editionId);
  for (const result of [...(edition?.legacy_results ?? [])].sort((a, b) => a.sort_order - b.sort_order)) {
    const card = document.createElement('article');
    card.className = 'approval-card';
    const label = document.createElement('span');
    label.textContent = `${result.label}: ${result.result}`;
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'button';
    edit.textContent = 'Edit result';
    edit.addEventListener('click', () => {
      legacyResultForm.elements.resultId.value = result.id;
      legacyResultForm.elements.editionId.value = result.edition_id;
      legacyResultForm.elements.label.value = result.label;
      legacyResultForm.elements.cardinalEntry.value = result.cardinal_entry ?? '';
      legacyResultForm.elements.silverEntry.value = result.silver_entry ?? '';
      legacyResultForm.elements.result.value = result.result;
      legacyResultForm.elements.sortOrder.value = result.sort_order;
      legacyResultForm.elements.eventGroup.value = result.event_group ?? '';
      legacyResultForm.elements.formatLabel.value = result.format_label ?? '';
      legacyResultForm.elements.handicapAllowance.value = result.handicap_allowance ?? '';
      legacyResultForm.elements.pointsAvailable.value = result.points_available ?? '';
      legacyResultForm.elements.cardinalPoints.value = result.cardinal_points ?? '';
      legacyResultForm.elements.silverPoints.value = result.silver_points ?? '';
      legacyResultForm.elements.confidence.value = result.confidence ?? 'unresolved';
      legacyResultForm.elements.sourceNote.value = result.source_note ?? '';
      legacyResultForm.querySelector('button[type="submit"]').textContent = 'Update result';
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button';
    remove.textContent = 'Delete result';
    remove.addEventListener('click', async () => {
      if (!window.confirm('Delete this Legacy result?')) return;
      try {
        await deleteLegacyResult(result.id);
        edition.legacy_results = edition.legacy_results.filter(item => item.id !== result.id);
        renderLegacyResultList();
        renderLegacyReconciliation();
      } catch (error) {
        setMessage(document.querySelector('#legacyResultMessage'), error.message, true);
      }
    });
    card.append(label, edit, remove);
    container.append(card);
  }
}

function hydrateLegacyEdition() {
  const edition = adminData.legacyEditions.find(item => item.id === legacyEditionSelect.value);
  legacyEditionForm.reset();
  legacyEditionForm.elements.editionId.value = edition?.id ?? '';
  legacyEditionForm.elements.year.value = edition?.edition_year ?? '';
  legacyEditionForm.elements.venue.value = edition?.venue ?? '';
  legacyEditionForm.elements.destination.value = edition?.destination ?? '';
  legacyEditionForm.elements.status.value = edition?.status ?? 'completed';
  legacyEditionForm.elements.winnerName.value = edition?.winner_name ?? '';
  legacyEditionForm.elements.runnerUpName.value = edition?.runner_up_name ?? '';
  legacyEditionForm.elements.finalScore.value = edition?.final_score ?? '';
  legacyEditionForm.elements.story.value = edition?.story ?? '';
  legacyEditionForm.elements.expectedPoints.value = edition?.expected_points ?? '';
  legacyEditionForm.elements.cardinalTotal.value = edition?.cardinal_total ?? '';
  legacyEditionForm.elements.silverTotal.value = edition?.silver_total ?? '';
  legacyEditionForm.elements.scoreConfidence.value = edition?.score_confidence ?? 'unresolved';
  legacyEditionForm.elements.sourceNotes.value = edition?.source_notes ?? '';
  legacyEditionForm.elements.published.checked = edition?.published ?? false;
  renderLegacyReconciliation(edition);
}

function renderLegacyPhotoList() {
  const container = document.querySelector('#legacyPhotoList');
  container.replaceChildren();
  const editionId = document.querySelector('#legacyPhotoEdition').value;
  const edition = adminData.legacyEditions.find(item => item.id === editionId);
  for (const photo of edition?.legacy_photos ?? []) {
    const card = document.createElement('article');
    card.className = 'approval-card';
    const label = document.createElement('span');
    label.textContent = photo.caption || 'Legacy photo';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'button';
    remove.textContent = 'Delete photo';
    remove.addEventListener('click', async () => {
      if (!window.confirm('Delete this Legacy photo?')) return;
      try {
        await deleteLegacyPhoto(photo);
        edition.legacy_photos = edition.legacy_photos.filter(item => item.id !== photo.id);
        renderLegacyPhotoList();
      } catch (error) {
        setMessage(document.querySelector('#legacyPhotoMessage'), error.message, true);
      }
    });
    card.append(label, remove);
    container.append(card);
  }
}

function membershipTournamentId() {
  for (const status of ['live', 'open', 'setup']) {
    const tournament = adminData.tournaments.find(item => item.status === status);
    if (tournament) return tournament.id;
  }
  return '';
}

function applyActiveMemberFilters() {
  if (!adminData) return;
  const tournamentId = membershipTournamentId();
  if (!tournamentId) {
    activeMemberCount.textContent = '0 members';
    activeMemberFilterEmpty.hidden = true;
    return;
  }
  const activeMemberships = filterActiveMemberships(
    adminData.memberships.filter(membership => membership.tournament_id === tournamentId),
    {
      search: activeMemberSearch.value,
      team: activeMemberTeamFilter.value,
      role: activeMemberRoleFilter.value,
    },
  );
  const activeTotal = adminData.memberships.filter(membership =>
    membership.tournament_id === tournamentId && membership.status === 'active').length;
  const visibleIds = new Set(activeMemberships.map(membership => membership.user_id));
  applyMemberCardVisibility(document.querySelectorAll('#activeMembers [data-member-id]'), visibleIds);
  activeMemberCount.textContent = activeMemberships.length === activeTotal
    ? `${activeTotal} ${activeTotal === 1 ? 'member' : 'members'}`
    : `${activeMemberships.length} of ${activeTotal} members`;
  activeMemberFilterEmpty.hidden = activeTotal === 0 || activeMemberships.length > 0;
}

function renderMemberships() {
  const tournamentId = membershipTournamentId();
  const groups = {
    pending: document.querySelector('#pendingMembers'),
    active: document.querySelector('#activeMembers'),
  };
  if (!tournamentId) {
    for (const container of Object.values(groups)) container.replaceChildren();
    activeMemberCount.textContent = '0 members';
    activeMemberFilterEmpty.hidden = true;
    setMessage(membershipMessage, 'No current tournament is available for membership management.', true);
    refreshSegmentPlayerOptions();
    return;
  }
  const tournamentMemberships = adminData.memberships
    .filter(membership => membership.tournament_id === tournamentId);
  const activeMemberships = filterActiveMemberships(tournamentMemberships);

  for (const [status, container] of Object.entries(groups)) {
    container.replaceChildren();
    const memberships = status === 'active'
      ? activeMemberships
      : tournamentMemberships
        .filter(membership => membership.status === status)
        .sort((left, right) => (left.profiles?.display_name || '')
          .localeCompare(right.profiles?.display_name || '', undefined, { sensitivity: 'base' }));
    if (!memberships.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-panel';
      empty.textContent = status === 'pending' ? 'No approval requests.' : 'No active members.';
      container.append(empty);
      continue;
    }
    for (const membership of memberships) {
      const card = document.createElement('article');
      card.className = 'membership-card';
      if (status === 'active') card.dataset.memberId = membership.user_id;
      const name = document.createElement('strong');
      name.textContent = membership.profiles?.display_name || 'Player';
      const details = document.createElement('p');
      const teamLabel = membership.team === 'cardinal' ? 'Blue' : membership.team === 'silver' ? 'White' : 'Team unassigned';
      details.textContent = `${membership.role} · ${teamLabel}`;
      const actions = document.createElement('div');
      if (status === 'active') {
        const roleControls = document.createElement('div');
        roleControls.className = 'membership-team';
        const roleSelectLabel = document.createElement('label');
        roleSelectLabel.textContent = 'Tournament role';
        const roleSelect = document.createElement('select');
        if (membership.role === 'captain') roleSelect.append(new Option('Captain', 'captain'));
        roleSelect.append(
          new Option('Player', 'player'),
          new Option('Admin', 'admin'),
        );
        roleSelect.value = membership.role;
        const roleDemotionProtected = membership.role === 'admin'
          && (membership.user_id === session.user.id || membership.profiles?.role === 'admin');
        if (roleDemotionProtected) {
          roleSelect.disabled = true;
          roleSelect.title = membership.user_id === session.user.id
            ? 'You cannot demote your own administrator membership.'
            : 'Global administrators cannot be demoted from tournament administration.';
        } else {
          roleSelect.addEventListener('change', async () => {
            const previousRole = membership.role;
            const requestedRole = roleSelect.value;
            if (requestedRole === previousRole) return;
            roleSelect.dataset.dirty = 'true';
            membershipMutationGate.begin();
            try {
              roleSelect.disabled = true;
              setMessage(membershipMessage, `Saving ${name.textContent}'s role…`);
              const saved = await setTournamentMemberRole({
                tournamentId,
                userId: membership.user_id,
                role: requestedRole,
              });
              membership.role = saved.role;
              roleSelect.value = saved.role;
              renderMemberships();
              setMessage(membershipMessage, `${name.textContent}'s tournament role is now ${saved.role === 'admin' ? 'Admin' : 'Player'}.`);
            } catch (error) {
              roleSelect.value = previousRole;
              setMessage(membershipMessage, error.message, true);
            } finally {
              roleSelect.dataset.dirty = 'false';
              membershipMutationGate.end();
              roleSelect.disabled = false;
            }
          });
        }
        roleSelectLabel.append(roleSelect);
        roleControls.append(roleSelectLabel);
        actions.append(roleControls);

        const teamControls = document.createElement('div');
        teamControls.className = 'membership-team';
        const teamSelectLabel = document.createElement('label');
        teamSelectLabel.textContent = 'Tournament team';
        const teamSelect = document.createElement('select');
        teamSelect.append(
          new Option('Unassigned', ''),
          new Option('Blue', 'cardinal'),
          new Option('White', 'silver'),
        );
        teamSelect.value = membership.team ?? '';
        teamSelect.addEventListener('change', async () => {
          const previousTeam = membership.team ?? '';
          const requestedTeam = teamSelect.value;
          if (requestedTeam === previousTeam) return;
          teamSelect.dataset.dirty = 'true';
          membershipMutationGate.begin();
          try {
            teamSelect.disabled = true;
            setMessage(membershipMessage, `Saving ${name.textContent}'s team…`);
            const saved = await setTournamentMemberTeam({
              tournamentId,
              userId: membership.user_id,
              team: requestedTeam,
            });
            membership.team = saved.team;
            refreshSegmentPlayerOptions();
            teamSelect.value = saved.team ?? '';
            const savedTeamLabel = saved.team === 'cardinal' ? 'Blue' : saved.team === 'silver' ? 'White' : 'Team unassigned';
            details.textContent = `${membership.role} · ${savedTeamLabel}`;
            applyActiveMemberFilters();
            if (card.hidden) membershipMutationGate.whenIdle(() => moveFocusFromFilteredCard(card, activeMemberSearch));
            setMessage(membershipMessage, `${name.textContent}'s team is now ${savedTeamLabel}.`);
          } catch (error) {
            teamSelect.value = previousTeam;
            setMessage(membershipMessage, error.message, true);
          } finally {
            teamSelect.dataset.dirty = 'false';
            membershipMutationGate.end();
            teamSelect.disabled = false;
          }
        });
        teamSelectLabel.append(teamSelect);
        teamControls.append(teamSelectLabel);
        actions.append(teamControls);

        const handicapLabel = document.createElement('label');
        handicapLabel.className = 'membership-handicap';
        handicapLabel.textContent = 'Handicap index';
        const handicapInput = document.createElement('input');
        handicapInput.type = 'number';
        handicapInput.min = '-10';
        handicapInput.max = '54';
        handicapInput.step = '0.1';
        handicapInput.required = true;
        handicapInput.value = membership.profiles?.handicap_index ?? '';
        handicapInput.addEventListener('input', () => {
          handicapInput.dataset.dirty = 'true';
        });
        handicapLabel.append(handicapInput);
        const saveHandicap = document.createElement('button');
        saveHandicap.type = 'button';
        saveHandicap.className = 'button';
        saveHandicap.textContent = 'Save handicap';
        saveHandicap.addEventListener('click', async () => {
          if (!handicapInput.reportValidity()) return;
          const handicapIndex = Number(handicapInput.value);
          if (!Number.isFinite(handicapIndex) || Math.round(handicapIndex * 10) !== handicapIndex * 10) {
            setMessage(membershipMessage, 'Enter a handicap index with one decimal place between -10.0 and 54.0.', true);
            return;
          }
          membershipMutationGate.begin();
          try {
            saveHandicap.disabled = true;
            handicapInput.disabled = true;
            setMessage(membershipMessage, `Saving ${name.textContent}'s handicap…`);
            const saved = await setTournamentMemberHandicap({
              tournamentId,
              userId: membership.user_id,
              handicapIndex,
            });
            membership.profiles = {
              ...membership.profiles,
              handicap_index: Number(saved.handicap_index),
            };
            handicapInput.value = membership.profiles.handicap_index.toFixed(1);
            handicapInput.dataset.dirty = 'false';
            setMessage(membershipMessage, `${name.textContent}'s handicap is now ${handicapInput.value}.`);
          } catch (error) {
            setMessage(membershipMessage, error.message, true);
          } finally {
            membershipMutationGate.end();
            saveHandicap.disabled = false;
            handicapInput.disabled = false;
          }
        });
        actions.append(handicapLabel, saveHandicap);
      }
      const action = document.createElement('button');
      action.type = 'button';
      action.className = status === 'pending' ? 'button button-primary' : 'button';
      action.textContent = status === 'pending' ? 'Approve' : 'Delete';
      if (status === 'active' && membership.user_id === session.user.id) {
        action.disabled = true;
        action.title = 'You cannot delete your own administrator membership.';
      } else if (status === 'active' && membership.profiles?.role === 'admin') {
        action.disabled = true;
        action.title = 'Global administrators cannot be deleted from tournament access.';
      }
      action.addEventListener('click', async () => {
        const deleting = status === 'active';
        const reason = deleting
          ? window.prompt(`Why are you deleting ${name.textContent}'s tournament membership? Their login and profile will remain, and a future request will require approval again.`)
          : 'Approved by administrator';
        if (!reason?.trim()) return;
        membershipMutationGate.begin();
        try {
          for (const button of actions.querySelectorAll('button')) button.disabled = true;
          setMessage(membershipMessage, `${action.textContent} in progress…`);
          if (deleting) {
            await deleteTournamentMembership({
              tournamentId,
              userId: membership.user_id,
              reason: reason.trim(),
            });
            adminData.memberships = adminData.memberships.filter(item =>
              item.tournament_id !== tournamentId || item.user_id !== membership.user_id);
          } else {
            const saved = await setTournamentMembershipStatus({
              tournamentId,
              userId: membership.user_id,
              status: 'active',
              reason: reason.trim(),
            });
            adminData.memberships = adminData.memberships.map(item =>
              item.tournament_id === tournamentId && item.user_id === membership.user_id
                ? { ...item, ...saved }
                : item);
          }
          renderMemberships();
          setMessage(membershipMessage, deleting
            ? `${name.textContent}'s tournament membership was deleted.`
            : `${name.textContent} is now active.`);
        } catch (error) {
          for (const button of actions.querySelectorAll('button')) button.disabled = false;
          setMessage(membershipMessage, error.message, true);
        } finally {
          membershipMutationGate.end();
        }
      });
      actions.append(action);
      if (status === 'pending') {
        const deny = document.createElement('button');
        deny.type = 'button';
        deny.className = 'button';
        deny.textContent = 'Deny';
        deny.addEventListener('click', async () => {
          if (!window.confirm(`Deny this membership request from ${name.textContent}? Their login and profile will remain.`)) return;
          membershipMutationGate.begin();
          try {
            for (const button of actions.querySelectorAll('button')) button.disabled = true;
            setMessage(membershipMessage, 'Deny in progress…');
            await denyTournamentMembership({
              tournamentId,
              userId: membership.user_id,
              reason: 'Denied by administrator',
            });
            adminData.memberships = adminData.memberships.filter(item =>
              item.tournament_id !== tournamentId || item.user_id !== membership.user_id);
            renderMemberships();
            setMessage(membershipMessage, `${name.textContent}'s request was denied. Their login and profile remain, and a future request can be reviewed again.`);
          } catch (error) {
            for (const button of actions.querySelectorAll('button')) button.disabled = false;
            setMessage(membershipMessage, error.message, true);
          } finally {
            membershipMutationGate.end();
          }
        });
        actions.append(deny);
      }
      card.append(name, details, actions);
      container.append(card);
    }
  }
  applyActiveMemberFilters();
  refreshSegmentPlayerOptions();
}

activeMemberSearch.addEventListener('input', applyActiveMemberFilters);
activeMemberTeamFilter.addEventListener('change', applyActiveMemberFilters);
activeMemberRoleFilter.addEventListener('change', applyActiveMemberFilters);

async function refreshMembershipRoster() {
  if (!adminData) return;
  if (membershipRosterRefreshPromise) return membershipRosterRefreshPromise;
  if (membershipMutationGate.active) {
    setMessage(membershipMessage, 'Wait for the current membership change to finish before refreshing.');
    return;
  }
  if (membershipManagement.querySelector('[data-dirty="true"]')) {
    setMessage(membershipMessage, 'Save the team or handicap edit before refreshing membership requests.', true);
    return;
  }
  refreshMembershipsButton.disabled = true;
  membershipManagement.inert = true;
  setMessage(membershipMessage, 'Refreshing membership requests…');
  membershipRosterRefreshPromise = (async () => {
    const freshData = await loadMembershipRosterData();
    adminData.tournaments = freshData.tournaments;
    adminData.memberships = freshData.memberships;
    refreshSegmentPlayerOptions();
    renderMemberships();
    setMessage(membershipMessage, 'Membership requests refreshed.');
  })();
  try {
    return await membershipRosterRefreshPromise;
  } catch (error) {
    setMessage(membershipMessage, error.message, true);
  } finally {
    membershipRosterRefreshPromise = null;
    membershipManagement.inert = false;
    refreshMembershipsButton.disabled = false;
  }
}

refreshMembershipsButton.addEventListener('click', refreshMembershipRoster);
window.addEventListener('focus', () => {
  if (!document.hidden && !document.activeElement?.closest('#membershipManagement')) refreshMembershipRoster();
});

function renderRuleEditor(selectedRuleId = '') {
  const tournamentId = document.querySelector('#ruleTournament').value;
  const rules = adminData.rules
    .filter(rule => rule.tournament_id === tournamentId && rule.active)
    .sort((a, b) => Number(a.sort_order) - Number(b.sort_order)
      || a.created_at.localeCompare(b.created_at)
      || a.id.localeCompare(b.id));
  const selectedRule = rules.find(rule => rule.id === selectedRuleId) ?? null;

  rulePublishedList.replaceChildren();
  if (!rules.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-panel';
    empty.textContent = 'No rules are currently published.';
    rulePublishedList.append(empty);
  } else {
    rules.forEach((rule, index) => {
      const card = document.createElement('article');
      card.className = 'approval-card';
      const title = document.createElement('strong');
      title.textContent = `${index + 1}. ${rule.title}`;
      const body = document.createElement('span');
      body.textContent = rule.body;
      card.append(title, body);
      rulePublishedList.append(card);
    });
  }

  ruleExisting.replaceChildren(
    new Option('Add a new rule', ''),
    ...rules.map((rule, index) => new Option(`${index + 1}. ${rule.title}`, rule.id)),
  );
  ruleExisting.value = selectedRule?.id ?? '';

  const remainingRules = rules.filter(rule => rule.id !== selectedRule?.id);
  const positions = Array.from({ length: remainingRules.length + 1 }, (_, index) => {
    const position = index + 1;
    const label = position === 1
      ? '1 — First'
      : `${position} — After “${remainingRules[position - 2].title}”`;
    return new Option(label, String(position));
  });
  ruleSortOrder.replaceChildren(...positions);

  ruleForm.elements.ruleId.value = selectedRule?.id ?? '';
  ruleForm.elements.title.value = selectedRule?.title ?? '';
  ruleForm.elements.body.value = selectedRule?.body ?? '';
  const currentPosition = selectedRule ? rules.findIndex(rule => rule.id === selectedRule.id) + 1 : positions.length;
  ruleSortOrder.value = String(currentPosition);
  ruleForm.querySelector('button[type="submit"]').textContent = selectedRule ? 'Update rule' : 'Publish rule';
}

function completionPhrase(tournament) {
  return `COMPLETE ${tournament.edition_year} HEREFORD CUP`;
}

function renderTournamentCompletion() {
  const selectedId = completionTournament.value;
  const tournaments = adminData.tournaments.filter(tournament => ['open', 'live', 'complete'].includes(tournament.status));
  completionTournament.replaceChildren(
    new Option('Select a tournament', ''),
    ...tournaments.map(tournament => new Option(`${tournament.name} · ${tournament.edition_year} · ${tournament.status}`, tournament.id)),
  );
  completionTournament.value = tournaments.some(tournament => tournament.id === selectedId)
    ? selectedId
    : (tournaments.find(tournament => tournament.status !== 'complete')?.id ?? tournaments[0]?.id ?? '');
  const tournament = tournaments.find(item => item.id === completionTournament.value);
  const readiness = tournamentCompletionReadiness({
    tournament,
    matches: adminData.matches,
    editions: adminData.legacyEditions,
  });
  completionReadiness.textContent = readiness.ready && tournament
    ? `${readiness.text} Type ${completionPhrase(tournament)} exactly to continue.`
    : readiness.text;
  completionConfirmation.placeholder = tournament ? completionPhrase(tournament) : '';
  const submitButton = tournamentCompletionForm.querySelector('button[type="submit"]');
  submitButton.textContent = tournament?.status === 'complete' ? 'Verify completed archive' : 'Complete tournament and publish Past Trips';
  submitButton.disabled = !readiness.ready || completionConfirmation.value.trim() !== (tournament ? completionPhrase(tournament) : '');
}

function populateAdminChoices() {
  const selectedResultMatchId = resultMatch.value;
  const tournamentSelects = ['#matchTournament', '#ruleTournament', '#commentaryTournament'].map(selector => document.querySelector(selector));
  for (const select of tournamentSelects) select.replaceChildren(...adminData.tournaments.map(tournament => new Option(`${tournament.name} · ${tournament.edition_year}`, tournament.id)));
  renderRuleEditor();
  const courseSelect = document.querySelector('#matchCourse');
  courseSelect.replaceChildren(new Option('Course TBA', ''), ...adminData.courses.map(course => new Option(course.name, course.id)));
  populateTexasScramblePlanner({ preserveDraft: true });
  const commentaryMatch = document.querySelector('#commentaryMatch');
  commentaryMatch.replaceChildren(
    new Option('Select a finalized match', ''),
    ...adminData.matches.filter(match => match.status === 'final').map(match => new Option(match.name, match.id)),
  );
  resultMatch.replaceChildren(
    new Option('Select a match', ''),
    ...adminData.matches.filter(match => ['scheduled', 'live', 'final'].includes(match.status)).map(match => new Option(match.name, match.id)),
  );
  if ([...resultMatch.options].some(option => option.value === selectedResultMatchId)) {
    resultMatch.value = selectedResultMatchId;
  }
  updateCorrectionAccess(adminData.matches.find(match => match.id === resultMatch.value));
  populateLegacyChoices();
  renderTournamentCompletion();
}

function canAdministerMatch(match) {
  return match && (globalAdministrator || adminData.memberships.some(member => member.tournament_id === match.tournament_id
    && member.user_id === session.user.id && member.status === 'active' && member.role === 'admin'));
}

function correctionRestriction(match) {
  if (!match) return '';
  if (!canAdministerMatch(match)) return 'Only an administrator of this tournament can correct its scores.';
  if (!match.tournament_id) return ''; // A global administrator can still correct a pre-edition match.
  const status = match.tournaments?.status ?? adminData.tournaments.find(item => item.id === match.tournament_id)?.status;
  if (!['setup', 'open', 'live'].includes(status)
    || adminData.legacyEditions.some(edition => edition.source_tournament_id === match.tournament_id)) {
    return 'This tournament is closed to corrections. Submitted scores are read-only.';
  }
  return '';
}

function updateCorrectionAccess(match) {
  const reason = correctionRestriction(match);
  openScoreCorrection.disabled = Boolean(reason);
  setMessage(document.querySelector('#resultMessage'), reason);
  return reason;
}

function populateCorrectionRounds(matchId) {
  const rounds = adminData.rounds.filter(round => round.match_id === matchId);
  correctionRound.replaceChildren(
    new Option('Select a player round', ''),
    ...rounds.map(round => new Option(
      `${round.profiles?.display_name || 'Player'} · ${round.courses?.name || 'Course'} · ${round.tees?.name || 'Tee'}`,
      round.id,
    )),
  );
  return rounds.length;
}

function hydrateCommentarySettings() {
  const settings = adminData.settings.find(item => item.tournament_id === commentaryTournament.value);
  commentarySettingsForm.elements.enabled.checked = settings?.enabled ?? false;
  commentarySettingsForm.elements.tone.value = settings?.tone ?? 'savage';
  commentarySettingsForm.elements.timing.value = settings?.timing ?? 'post_match';
  commentarySettingsForm.elements.maxCharacters.value = settings?.max_characters ?? 600;
}

function requiresManualTeamResult(match) {
  return match?.match_segments?.some(segment => segment.format === 'foursomes' && !isSharedSegment(segment)) ?? false;
}

function resultSnapshotLabel(audit, prefix, segment) {
  const status = audit[`${prefix}_status`];
  if (!status) return 'Not previously logged';
  if (status !== 'final') return status.charAt(0).toUpperCase() + status.slice(1);
  const differential = Number(audit[`${prefix}_differential`] ?? 0);
  const holesPlayed = Number(audit[`${prefix}_holes_played`] ?? 0);
  const totalHoles = segment ? Number(segment.end_hole) - Number(segment.start_hole) + 1 : 18;
  return formatMatchStatus({ differential, holesPlayed }, totalHoles);
}

function renderResultAuditHistory() {
  resultAuditHistory.replaceChildren();
  const match = adminData.matches.find(item => item.id === resultMatch.value);
  if (!match) {
    const empty = document.createElement('p');
    empty.className = 'empty-panel';
    empty.textContent = 'Select a match to view its authoritative result history.';
    resultAuditHistory.append(empty);
    return;
  }

  const audits = (adminData.resultAudits ?? []).filter(audit => audit.match_id === match.id);
  if (!audits.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-panel';
    empty.textContent = 'No authoritative result changes have been logged for this match.';
    resultAuditHistory.append(empty);
    return;
  }

  const actionLabels = {
    baseline: 'Audit baseline',
    finalized: 'Result finalized',
    recalculated: 'Result recalculated',
  };
  for (const audit of audits) {
    const segment = match.match_segments?.find(item => item.id === audit.segment_id);
    const card = document.createElement('article');
    card.className = 'result-audit-entry';

    const heading = document.createElement('div');
    heading.className = 'result-audit-entry-head';
    const title = document.createElement('strong');
    const segmentLabel = segment
      ? `Holes ${segment.start_hole}–${segment.end_hole} · ${segment.format.replaceAll('_', ' ')}`
      : 'Archived segment';
    title.textContent = `${actionLabels[audit.action] ?? 'Result updated'} · ${segmentLabel}`;
    const timestamp = document.createElement('time');
    timestamp.dateTime = audit.changed_at;
    timestamp.textContent = new Date(audit.changed_at).toLocaleString();
    heading.append(title, timestamp);

    const transition = document.createElement('p');
    transition.className = 'result-audit-transition';
    const before = resultSnapshotLabel(audit, 'old', segment);
    const after = resultSnapshotLabel(audit, 'new', segment);
    transition.textContent = audit.action === 'baseline' ? after : `${before} → ${after}`;

    const reason = document.createElement('p');
    reason.textContent = audit.change_reason;
    const actor = document.createElement('small');
    actor.textContent = audit.actor_display_name
      ? `Changed by ${audit.actor_display_name}`
      : audit.changed_by
        ? 'Changed by an administrator (name unavailable)'
        : audit.action === 'baseline' ? 'System baseline' : 'System-authorized update';

    card.append(heading, transition, reason, actor);
    resultAuditHistory.append(card);
  }
}

async function refreshResultAuditHistory(matchId) {
  const latest = await loadMatchResultAudits(matchId);
  if (resultMatch.value !== matchId) return;
  adminData.resultAudits = [
    ...(adminData.resultAudits ?? []).filter(audit => audit.match_id !== matchId),
    ...latest,
  ];
  renderResultAuditHistory();
}

async function refreshTeamCorrectionHistory(match) {
  const request = ++teamHistoryRequest;
  const panel = document.querySelector('#teamCorrectionLog');
  panel.hidden = !match?.match_segments?.some(isSharedSegment) || !canAdministerMatch(match);
  teamCorrectionHistory.replaceChildren();
  if (panel.hidden) return '';
  teamCorrectionHistory.textContent = 'Loading shared score corrections…';
  try {
    const audits = await loadTeamCorrectionAudits(match.id);
    if (request !== teamHistoryRequest || resultMatch.value !== match.id) return '';
    const squads = match.correctionSquads ?? adminData.scrambleSessions.flatMap(session => session.texas_scramble_squads);
    renderTeamCorrectionAudits(teamCorrectionHistory, audits.filter(row => row.match_id === match.id), squads.filter(squad => squad.match_id === match.id));
    return '';
  } catch (error) {
    if (request !== teamHistoryRequest || resultMatch.value !== match.id) return '';
    const warning = `Team correction history refresh failed: ${error.message}`;
    teamCorrectionHistory.textContent = warning;
    return warning;
  }
}

function renderResultSegments() {
  resultSegmentRows.replaceChildren();
  const match = adminData.matches.find(item => item.id === resultMatch.value);
  renderResultAuditHistory();
  let canFinalize = Boolean(match?.match_segments?.length);
  for (const segment of match?.match_segments ?? []) {
    const card = document.createElement('fieldset');
    card.className = 'segment-card';
    card.dataset.segmentId = segment.id;
    const derived = deriveSegmentResult({ segment, rounds: adminData.rounds });
    const legend = `<legend>Holes ${segment.start_hole}–${segment.end_hole} · ${segment.format} · ${segment.scoring_mode} · ${segment.point_value} pts</legend>`;
    if (derived.mode === 'automatic') {
      card.dataset.resultReady = 'true';
      card.innerHTML = `${legend}
        <p><strong>${derived.label}</strong></p>
        <p>${isSharedSegment(segment) ? 'Official result from the submitted shared scorecard.' : 'Calculated automatically from submitted hole-by-hole scores.'}</p>
        <input name="differential" type="hidden" value="${derived.differential}">
        <input name="holesPlayed" type="hidden" value="${derived.holes_played}">`;
    } else if (derived.mode === 'waiting') {
      card.dataset.resultReady = 'false';
      canFinalize = false;
      card.innerHTML = `${legend}<p><strong>${isSharedSegment(segment) ? 'Waiting for shared entries' : 'Waiting for completed scorecards'}</strong></p><p>${derived.reason}</p>`;
    } else {
      card.dataset.resultReady = 'true';
      card.innerHTML = `${legend}
        <div class="segment-fields">
          <label>Match-play differential (Blue + / White −)<input name="differential" type="number" min="-${segment.end_hole - segment.start_hole + 1}" max="${segment.end_hole - segment.start_hole + 1}" value="${segment.differential ?? 0}" required></label>
          <label>Holes played<input name="holesPlayed" type="number" min="1" max="${segment.end_hole - segment.start_hole + 1}" value="${segment.holes_played || segment.end_hole - segment.start_hole + 1}" required></label>
          <label>Result status<input value="Final" disabled></label>
        </div><p>${derived.reason} Positive means Blue is up; negative means White; zero means halved.</p>`;
    }
    resultSegmentRows.append(card);
  }
  const submitButton = resultFinalizationForm.querySelector('button[type="submit"]');
  const manualTeamResult = requiresManualTeamResult(match) && match?.status !== 'final' && !correctionRestriction(match);
  submitButton.hidden = !manualTeamResult;
  submitButton.disabled = !manualTeamResult || !canFinalize;
}

function renderCommentaryApprovals() {
  const container = document.querySelector('#commentaryApprovalList');
  container.replaceChildren();
  const manageable = adminData.commentaries.filter(commentary => ['draft', 'approved'].includes(commentary.status));
  if (!manageable.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-panel';
    empty.textContent = 'No commentary is waiting for review.';
    container.append(empty);
    return;
  }
  for (const commentary of manageable) {
    const card = document.createElement('article');
    card.className = 'approval-card';
    const title = document.createElement('strong');
    title.textContent = `${commentary.matches?.name || 'Match commentary'} · ${commentary.status}`;
    const copy = document.createElement('textarea');
    copy.value = commentary.commentary;
    copy.maxLength = 2000;
    copy.rows = 4;
    copy.readOnly = true;
    copy.setAttribute('aria-label', `Edit commentary for ${commentary.matches?.name || 'match'}`);
    const actions = document.createElement('div');
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'button';
    edit.textContent = 'Edit';
    edit.addEventListener('click', async () => {
      if (copy.readOnly) {
        copy.readOnly = false;
        copy.focus();
        edit.textContent = 'Save edit';
        return;
      }
      const saved = await updateCommentaryText({ commentaryId: commentary.id, commentary: copy.value });
      adminData.commentaries = adminData.commentaries.map(item => item.id === commentary.id ? { ...item, ...saved } : item);
      renderCommentaryApprovals();
    });
    actions.append(edit);
    const statuses = commentary.status === 'draft' ? [['Approve', 'approved'], ['Hide', 'hidden']] : [['Hide', 'hidden']];
    for (const [label, status] of statuses) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = status === 'approved' ? 'button button-primary' : 'button';
      button.textContent = label;
      button.addEventListener('click', async () => {
        const saved = await updateCommentaryStatus({ commentaryId: commentary.id, status });
        adminData.commentaries = adminData.commentaries.map(item => item.id === commentary.id ? { ...item, ...saved } : item);
        renderCommentaryApprovals();
      });
      actions.append(button);
    }
    card.append(title, copy, actions);
    container.append(card);
  }
}

function upsertCommentaryById(commentaries, commentary) {
  return [commentary, ...commentaries.filter(item => item.id !== commentary.id)];
}

for (const tab of legacyTabs) {
  tab.addEventListener('click', () => activateLegacyTab(tab.dataset.legacyTab));
  tab.addEventListener('keydown', event => {
    const currentIndex = legacyTabs.indexOf(tab);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % legacyTabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + legacyTabs.length) % legacyTabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = legacyTabs.length - 1;
    else return;
    event.preventDefault();
    activateLegacyTab(legacyTabs[nextIndex].dataset.legacyTab, { focus: true });
  });
}
activateLegacyTab('edition');

courseForm.addEventListener('submit', async event => {
  event.preventDefault();
  setMessage(courseMessage, 'Saving…');
  try {
    const data = new FormData(courseForm);
    const holes = Array.from({ length: 18 }, (_, index) => ({ hole_number: index + 1, par: data.get(`hole-${index + 1}-par`), stroke_index: data.get(`hole-${index + 1}-si`), yardage: data.get(`hole-${index + 1}-yards`) }));
    if (new Set(holes.map(hole => Number(hole.stroke_index))).size !== 18) throw new Error('Each stroke index from 1 through 18 must be used once.');
    await saveCourseWithTee({ userId: session.user.id, course: { name: data.get('courseName'), location: data.get('location') }, tee: { name: data.get('teeName'), rating: optionalNumber(data.get('rating')), slope: optionalNumber(data.get('slope')), par: data.get('par'), yardage: data.get('yardage') }, holes });
    setMessage(courseMessage, 'Course and tee saved.');
    courseForm.reset();
  } catch (error) { setMessage(courseMessage, error.message, true); }
});

document.querySelector('#addSegment').addEventListener('click', () => addSegment());
document.querySelector('#matchTournament').addEventListener('change', () => {
  segmentRows.replaceChildren();
  addSegment({ startHole: 1, endHole: 9, format: 'fourball', pointValue: 0.5 });
  addSegment({ startHole: 10, endHole: 18, format: 'foursomes', pointValue: 0.5 });
});

matchPlanForm.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const data = new FormData(matchPlanForm);
    const segments = collectSegments();
    const errors = validateSegments(segments);
    if (errors.length) throw new Error(errors[0]);
    if (segments.some(segment => segment.players.some(player => !player.team))) throw new Error('Every assigned player must belong to Blue or White.');
    setMessage(matchPlanMessage, 'Saving…');
    await saveMatchPlan({ match: { name: data.get('matchName'), session: data.get('session'), starts_at: easternDateTimeToIso(data.get('startsAt')), course_id: data.get('courseId') || null, tournament_id: data.get('tournamentId'), status: 'scheduled' }, segments: rpcSegments(segments) });
    setMessage(matchPlanMessage, 'Match plan saved.');
  } catch (error) { setMessage(matchPlanMessage, error.message, true); }
});

texasScrambleCourse.addEventListener('change', () => populateTexasScrambleTees());
texasScrambleForm.addEventListener('input', ({ target }) => {
  if (target !== texasScrambleTournament && target !== texasScrambleSavedSession) scrambleDraftDirty = true;
});
texasScrambleTournament.addEventListener('change', () => populateTexasScramblePlanner({ sessionId: '' }));
texasScrambleSavedSession.addEventListener('change', hydrateTexasScramblePlanner);
texasScrambleForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (savingTexasScramble) return;
  const tournamentId = texasScrambleTournament.value;
  const session = selectedScrambleSession();
  let savedId;
  try {
    const reason = texasScrambleLock();
    if (reason) throw new Error(reason);
    const plan = collectTexasScramblePlan(tournamentId, session);
    savingTexasScramble = true;
    syncTexasScrambleControls();
    setMessage(texasScrambleMessage, 'Saving…');
    savedId = await saveTexasScramblePlan(plan);
    await reloadTexasScrambleData();
    populateTexasScramblePlanner({ tournamentId, sessionId: savedId });
    setMessage(texasScrambleMessage, `Texas Scramble plan saved. ${texasScrambleLock() || 'Players will see their assigned squad in Play.'}`);
  } catch (error) {
    if (savedId) {
      holdUnverifiedScramble(savedId);
      setMessage(texasScrambleMessage, `Texas Scramble plan saved, but readback failed. Reload the page before editing: ${error.message}`, true);
      return;
    }
    if (savingTexasScramble && session) {
      // Play can start between opening the editor and acquiring the RPC's lock.
      try {
        await reloadTexasScrambleData();
        if (texasScrambleLock()) {
          populateTexasScramblePlanner({ tournamentId, sessionId: session.id });
          return;
        }
      } catch (refreshError) {
        holdUnverifiedScramble(session.id);
        setMessage(texasScrambleMessage, `${error.message}. Reload to verify the lineup: ${refreshError.message}`, true);
        return;
      }
    }
    setMessage(texasScrambleMessage, error.message, true);
  } finally {
    savingTexasScramble = false;
    syncTexasScrambleControls();
  }
});

resultMatch.addEventListener('change', async () => {
  correctionOpenRequest++;
  renderResultSegments();
  const matchId = resultMatch.value;
  const match = adminData.matches.find(item => item.id === matchId);
  updateCorrectionAccess(match);
  void refreshTeamCorrectionHistory(match);
  if (!canAdministerMatch(match)) return;
  const loading = document.createElement('p');
  loading.className = 'empty-panel';
  loading.textContent = 'Loading authoritative result history…';
  resultAuditHistory.replaceChildren(loading);
  try {
    await refreshResultAuditHistory(matchId);
  } catch (error) {
    if (resultMatch.value !== matchId) return;
    const failure = document.createElement('p');
    failure.className = 'empty-panel';
    failure.textContent = `History refresh failed: ${error.message}`;
    resultAuditHistory.replaceChildren(failure);
  }
});
resultFinalizationForm.addEventListener('submit', async event => {
  event.preventDefault();
  const message = document.querySelector('#resultMessage');
  try {
    const restriction = correctionRestriction(adminData.matches.find(item => item.id === resultMatch.value));
    if (restriction) throw new Error(restriction);
    const resultCards = [...resultSegmentRows.querySelectorAll('[data-segment-id]')];
    if (resultCards.some(card => card.dataset.resultReady !== 'true')) {
      throw new Error('All assigned players must submit every score before this match can be finalized.');
    }
    const segmentResults = resultCards.map(card => ({
      segment_id: card.dataset.segmentId,
      differential: Number(card.querySelector('[name="differential"]').value),
      holes_played: Number(card.querySelector('[name="holesPlayed"]').value),
      status: 'final',
    }));
    const matchId = resultMatch.value;
    if (!matchId || !segmentResults.length) throw new Error('Select a planned match with segments.');
    setMessage(message, 'Validating rounds and finalizing…');
    await finalizeMatchResults({ matchId, segmentResults });
    const finalized = adminData.matches.find(match => match.id === matchId);
    finalized.status = 'final';
    for (const savedResult of segmentResults) {
      const segment = finalized.match_segments?.find(item => item.id === savedResult.segment_id);
      if (segment) Object.assign(segment, savedResult);
    }
    populateAdminChoices();
    renderResultSegments();
    let historyWarning = '';
    try {
      await refreshResultAuditHistory(matchId);
    } catch (historyError) {
      historyWarning = ` History refresh failed: ${historyError.message}`;
    }
    const finalizationMessage = text => `${text}${historyWarning}`;

    const commentarySettings = adminData.settings.find(item => item.tournament_id === finalized.tournament_id);
    if (commentarySettings?.enabled) {
      try {
        setMessage(message, 'Match finalized. Generating commentary…');
        const commentary = await generateMatchCommentary(matchId);
        adminData.commentaries = upsertCommentaryById(adminData.commentaries, commentary);
        renderCommentaryApprovals();
        setMessage(message, finalizationMessage(commentary.status === 'approved'
          ? 'Match finalized. Commentary generated and published.'
          : 'Match finalized. Commentary generated and awaiting approval.'), Boolean(historyWarning));
      } catch (commentaryError) {
        setMessage(message, finalizationMessage(`Match finalized, but automatic commentary failed: ${commentaryError.message}. Use Generate match recap to retry.`), true);
      }
      return;
    }

    setMessage(message, finalizationMessage('Match finalized. Cup points and official statistics are now available.'), Boolean(historyWarning));
  } catch (error) { setMessage(message, error.message, true); }
});

completionTournament.addEventListener('change', () => {
  completionConfirmation.value = '';
  renderTournamentCompletion();
});
completionConfirmation.addEventListener('input', renderTournamentCompletion);
tournamentCompletionForm.addEventListener('submit', async event => {
  event.preventDefault();
  const message = document.querySelector('#completionMessage');
  const submitButton = tournamentCompletionForm.querySelector('button[type="submit"]');
  const tournament = adminData.tournaments.find(item => item.id === completionTournament.value);
  try {
    if (!tournament) throw new Error('Select a tournament first.');
    const readiness = tournamentCompletionReadiness({
      tournament,
      matches: adminData.matches,
      editions: adminData.legacyEditions,
    });
    if (!readiness.ready) throw new Error(readiness.text);
    const confirmation = completionConfirmation.value.trim();
    if (confirmation !== completionPhrase(tournament)) throw new Error('Type the confirmation phrase exactly.');
    submitButton.disabled = true;
    setMessage(message, tournament.status === 'complete' ? 'Verifying the completed archive…' : 'Completing tournament and publishing Past Trips…');
    await completeTournamentArchive(tournament.id);
    adminData = await loadAdminData();
    completionConfirmation.value = '';
    populateAdminChoices();
    hydrateLegacyEdition();
    setMessage(message, tournament.status === 'complete'
      ? 'Completed tournament archive verified without changes.'
      : 'Tournament completed and Past Trips published.');
  } catch (error) {
    setMessage(message, error.message, true);
  } finally {
    submitButton.disabled = false;
    renderTournamentCompletion();
  }
});

document.querySelector('#ruleTournament').addEventListener('change', () => renderRuleEditor());
ruleExisting.addEventListener('change', () => renderRuleEditor(ruleExisting.value));

ruleForm.addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(ruleForm);
  const message = document.querySelector('#ruleMessage');
  const submitButton = ruleForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const tournamentId = data.get('tournamentId');
    const ruleId = data.get('ruleId');
    const savedRules = await saveTournamentRule({
      ruleId,
      tournamentId,
      title: data.get('title'),
      body: data.get('body'),
      sortOrder: data.get('sortOrder'),
    });
    adminData.rules = [
      ...adminData.rules.filter(rule => rule.tournament_id !== tournamentId),
      ...savedRules,
    ];
    renderRuleEditor(ruleId);
    setMessage(message, 'Rule saved in the selected display position.');
  } catch (error) {
    setMessage(message, error.message, true);
  } finally {
    submitButton.disabled = false;
  }
});

legacyEditionSelect.addEventListener('change', hydrateLegacyEdition);
legacyEditionForm.addEventListener('input', () => renderLegacyReconciliation(legacyEditionDraft()));
document.querySelector('#legacyResultEdition').addEventListener('change', renderLegacyResultList);
document.querySelector('#legacyPhotoEdition').addEventListener('change', renderLegacyPhotoList);

legacyEditionForm.addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(legacyEditionForm);
  const message = document.querySelector('#legacyEditionMessage');
  try {
    setMessage(message, 'Saving…');
    const existing = adminData.legacyEditions.find(item => item.id === data.get('editionId'));
    const scoreConfidence = data.get('scoreConfidence');
    const published = data.get('published') === 'on';
    const expectedPoints = optionalNumber(data.get('expectedPoints'));
    const cardinalTotal = optionalNumber(data.get('cardinalTotal'));
    const silverTotal = optionalNumber(data.get('silverTotal'));
    const summary = summarizeLegacyLedger({
      expected_points: expectedPoints,
      cardinal_total: cardinalTotal,
      silver_total: silverTotal,
      score_confidence: scoreConfidence,
      legacy_results: existing?.legacy_results ?? [],
    });
    if (scoreConfidence === 'confirmed' && published && !summary.reconciled) {
      throw new Error('A confirmed edition cannot be published until expected, Blue, and White totals reconcile without overallocated rows.');
    }
    const saved = await saveLegacyEdition({
      id: data.get('editionId') || null,
      year: data.get('year'),
      venue: data.get('venue'),
      destination: data.get('destination'),
      status: data.get('status'),
      winnerName: data.get('winnerName'),
      runnerUpName: data.get('runnerUpName'),
      finalScore: data.get('finalScore'),
      story: data.get('story'),
      published,
      expectedPoints,
      cardinalTotal,
      silverTotal,
      scoreConfidence,
      sourceNotes: data.get('sourceNotes'),
    });
    const edition = {
      ...saved,
      legacy_results: existing?.legacy_results ?? [],
      legacy_photos: existing?.legacy_photos ?? [],
    };
    adminData.legacyEditions = [...adminData.legacyEditions.filter(item => item.id !== saved.id), edition]
      .sort((left, right) => left.edition_year - right.edition_year);
    populateLegacyChoices();
    legacyEditionSelect.value = saved.id;
    hydrateLegacyEdition();
    setMessage(message, saved.published ? 'Legacy edition saved and published.' : 'Legacy edition saved as hidden.');
  } catch (error) { setMessage(message, error.message, true); }
});

legacyResultForm.addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(legacyResultForm);
  const message = document.querySelector('#legacyResultMessage');
  try {
    const saved = await saveLegacyResult({
      id: data.get('resultId') || null,
      editionId: data.get('editionId'),
      label: data.get('label'),
      cardinalEntry: data.get('cardinalEntry'),
      silverEntry: data.get('silverEntry'),
      result: data.get('result'),
      sortOrder: data.get('sortOrder'),
      eventGroup: data.get('eventGroup'),
      formatLabel: data.get('formatLabel'),
      handicapAllowance: data.get('handicapAllowance'),
      pointsAvailable: optionalNumber(data.get('pointsAvailable')),
      cardinalPoints: optionalNumber(data.get('cardinalPoints')),
      silverPoints: optionalNumber(data.get('silverPoints')),
      confidence: data.get('confidence'),
      sourceNote: data.get('sourceNote'),
    });
    const edition = adminData.legacyEditions.find(item => item.id === saved.edition_id);
    edition.legacy_results = [...edition.legacy_results.filter(item => item.id !== saved.id), saved];
    legacyResultForm.reset();
    legacyResultForm.elements.resultId.value = '';
    document.querySelector('#legacyResultEdition').value = saved.edition_id;
    legacyResultForm.querySelector('button[type="submit"]').textContent = 'Save result';
    renderLegacyResultList();
    renderLegacyReconciliation();
    setMessage(message, data.get('resultId') ? 'Legacy result updated.' : 'Legacy result added.');
  } catch (error) { setMessage(message, error.message, true); }
});

legacyPhotoForm.addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(legacyPhotoForm);
  const message = document.querySelector('#legacyPhotoMessage');
  try {
    setMessage(message, 'Uploading…');
    const saved = await uploadLegacyPhoto({
      editionId: data.get('editionId'),
      file: document.querySelector('#legacyPhotoFile').files[0],
      caption: data.get('caption'),
      sortOrder: data.get('sortOrder'),
    });
    const edition = adminData.legacyEditions.find(item => item.id === saved.edition_id);
    edition.legacy_photos.push(saved);
    legacyPhotoForm.reset();
    document.querySelector('#legacyPhotoEdition').value = saved.edition_id;
    renderLegacyPhotoList();
    setMessage(message, 'Legacy photo uploaded.');
  } catch (error) { setMessage(message, error.message, true); }
});

function restoreCorrectionDialogFocus() {
  document.removeEventListener('keydown', handleCorrectionDialogKeydown);
  correctionDialogTrigger?.focus();
  correctionDialogTrigger = null;
}

function closeScoreCorrectionDialog() {
  if (savingCorrection) return;
  if (typeof scoreCorrectionDialog.close === 'function' && scoreCorrectionDialog.open) {
    scoreCorrectionDialog.close();
    return;
  }
  scoreCorrectionDialog.removeAttribute('open');
  scoreCorrectionDialog.removeAttribute('role');
  scoreCorrectionDialog.removeAttribute('aria-modal');
  restoreCorrectionDialogFocus();
}

function handleCorrectionDialogKeydown(event) {
  if (!scoreCorrectionDialog.hasAttribute('open')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeScoreCorrectionDialog();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusable = [...scoreCorrectionDialog.querySelectorAll('button, select, input, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter(control => !control.matches(':disabled') && !control.closest('[hidden]'));
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

openScoreCorrection.addEventListener('click', async event => {
  if (savingCorrection || scoreCorrectionDialog.hasAttribute('open')) return;
  const request = ++correctionOpenRequest;
  const trigger = event.currentTarget;
  const matchId = resultMatch.value;
  if (!matchId) {
    setMessage(document.querySelector('#resultMessage'), 'Select a match before editing a submitted score.', true);
    resultMatch.focus();
    return;
  }
  const match = adminData.matches.find(item => item.id === matchId);
  if (!match || updateCorrectionAccess(match)) return;
  let readError = '';
  if (match.match_segments?.some(isSharedSegment)) {
    setMessage(document.querySelector('#resultMessage'), 'Loading submitted team entries…');
    try {
      const latest = await loadCorrectionMatch(matchId);
      if (request !== correctionOpenRequest || resultMatch.value !== matchId) return;
      Object.assign(match, latest);
      if (match.match_segments.every(isSharedSegment)) renderResultSegments();
    } catch (error) {
      if (request !== correctionOpenRequest || resultMatch.value !== matchId) return;
      readError = `Could not load submitted team entries: ${error.message}. Close and reopen to retry.`;
    }
    if (updateCorrectionAccess(match)) return;
  }
  correctionEditor.prepare(match, populateCorrectionRounds(matchId), readError);
  document.querySelector('#correctionMatchLabel').textContent = match.name;
  correctionDialogTrigger = trigger;
  if (typeof scoreCorrectionDialog.showModal === 'function') scoreCorrectionDialog.showModal();
  else {
    scoreCorrectionDialog.setAttribute('open', '');
    scoreCorrectionDialog.setAttribute('role', 'dialog');
    scoreCorrectionDialog.setAttribute('aria-modal', 'true');
    document.addEventListener('keydown', handleCorrectionDialogKeydown);
  }
  correctionEditor.focus();
});

scoreCorrectionDialog.addEventListener('close', restoreCorrectionDialogFocus);
scoreCorrectionDialog.addEventListener('cancel', event => { if (savingCorrection) event.preventDefault(); });

document.querySelector('#closeScoreCorrection').addEventListener('click', closeScoreCorrectionDialog);

document.querySelector('#correctionDelete').addEventListener('change', event => {
  const scoreInput = document.querySelector('#correctionScore');
  scoreInput.disabled = event.target.checked;
  scoreInput.required = !event.target.checked;
});

function setCorrectionBusy(busy) {
  savingCorrection = busy;
  scoreCorrectionForm.inert = busy;
  resultMatch.disabled = busy;
  document.querySelector('#closeScoreCorrection').disabled = busy;
  scoreCorrectionForm.querySelector('button[type="submit"]').disabled = busy;
}

scoreCorrectionForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (savingCorrection || !scoreCorrectionDialog.hasAttribute('open')) return;
  const message = document.querySelector('#correctionMessage');
  const matchId = resultMatch.value;
  const match = adminData.matches.find(item => item.id === matchId);
  if (!match || correctionEditor.matchId !== matchId) {
    setMessage(message, 'Close this dialog and select the match again.', true);
    return;
  }
  const restriction = correctionRestriction(match);
  if (restriction) {
    setMessage(message, restriction, true);
    return;
  }
  const team = correctionEditor.team;
  const warnings = [];
  let status = '';
  setCorrectionBusy(true);
  setMessage(message, 'Saving audited correction…');
  try {
    if (team) {
      let entry = correctionEditor.entry;
      const { completion_warning: completionWarning, ...saved } = await correctTeamScoreEntry(correctionEditor.payload());
      status = 'Team correction saved and audited.';
      if (completionWarning) warnings.push(`Individual scorecards need review: ${completionWarning}`);
      Object.assign(entry.row, saved);
      try {
        const latest = await loadCorrectionMatch(matchId);
        Object.assign(match, latest);
        updateCorrectionAccess(match);
        correctionEditor.prepare(match, populateCorrectionRounds(matchId));
        if (correctionEditor.entry?.row.id !== saved.id) throw new Error('The submitted entry is no longer available.');
        entry = correctionEditor.entry;
      } catch (refreshError) {
        warnings.push(`Score/result refresh failed: ${refreshError.message}. Reopen the correction to retry.`);
      }
      status += ` ${entry.label}: ${teamValue(entry.type, entry.row, entry.players)}.`;
      renderResultSegments();
    } else {
      const round = adminData.rounds.find(item => item.id === correctionRound.value && item.match_id === matchId);
      if (!round) throw new Error('Select a player round from the chosen match.');
      const holeNumber = Number(document.querySelector('#correctionHole').value);
      const deleteScore = match.status !== 'final' && document.querySelector('#correctionDelete').checked;
      const result = await correctHoleScore({
        roundId: round.id, holeNumber, deleteScore,
        grossScore: deleteScore ? null : document.querySelector('#correctionScore').value,
        reason: document.querySelector('#correctionReason').value,
      });
      status = result.audit?.action ? `Correction saved and audited (${result.audit.action}).` : 'Correction saved and audited.';
      if (result.auditWarning) warnings.push(result.auditWarning);
      round.scores = round.scores.filter(score => score.hole_number !== holeNumber);
      if (!deleteScore) round.scores.push(result.score);
      if (match.status === 'final') {
        status = 'Score corrected and result recalculated.';
        renderResultSegments();
      }
    }
    if (match.status === 'final' && adminData.settings.find(item => item.tournament_id === match.tournament_id)?.enabled) {
      try {
        const commentary = await generateMatchCommentary(matchId, { regenerate: true });
        adminData.commentaries = upsertCommentaryById(adminData.commentaries, commentary);
        renderCommentaryApprovals();
        status = team ? `${status} Commentary regenerated.` : 'Score corrected, result recalculated, and commentary regenerated.';
      } catch (commentaryError) {
        warnings.push(`Commentary regeneration failed: ${commentaryError.message}`);
      }
    }
    if (team || match.status === 'final') {
      const teamHistory = team ? refreshTeamCorrectionHistory(match) : '';
      try {
        await refreshResultAuditHistory(matchId);
      } catch (historyError) {
        warnings.push(`History refresh failed: ${historyError.message}`);
      }
      const teamWarning = await teamHistory;
      if (teamWarning) warnings.push(teamWarning);
    }
  } catch (error) {
    // The mutation and its audit commit together; a later display/read failure is not a failed save.
    if (!status) {
      setMessage(message, error.message, true);
      return;
    }
    warnings.push(`Refresh failed: ${error.message}`);
  } finally {
    setCorrectionBusy(false);
  }
  const summary = [status, ...warnings].join(' ');
  setMessage(message, summary, Boolean(warnings.length));
  setMessage(document.querySelector('#resultMessage'), summary, Boolean(warnings.length));
  if (team) document.querySelector('#correctionReason').value = '';
  else scoreCorrectionForm.reset();
  closeScoreCorrectionDialog();
});

commentaryTournament.addEventListener('change', hydrateCommentarySettings);

commentarySettingsForm.addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(commentarySettingsForm);
  try {
    const saved = await saveCommentarySettings({ tournamentId: data.get('tournamentId'), enabled: data.get('enabled') === 'on', tone: data.get('tone'), timing: data.get('timing'), maxCharacters: data.get('maxCharacters'), userId: session.user.id });
    adminData.settings = [...adminData.settings.filter(item => item.tournament_id !== saved.tournament_id), saved];
    setMessage(document.querySelector('#commentaryMessage'), 'Commentary settings saved.');
  } catch (error) { setMessage(document.querySelector('#commentaryMessage'), error.message, true); }
});

document.querySelector('#generateCommentary').addEventListener('click', async () => {
  const matchId = document.querySelector('#commentaryMatch').value;
  const message = document.querySelector('#commentaryMessage');
  if (!matchId) {
    setMessage(message, 'Select a finalized match first.', true);
    return;
  }
  try {
    setMessage(message, 'Generating and validating recap…');
    const commentary = await generateMatchCommentary(matchId, { regenerate: true });
    adminData.commentaries = upsertCommentaryById(adminData.commentaries, commentary);
    renderCommentaryApprovals();
    setMessage(message, commentary.status === 'approved' ? 'Commentary generated and published.' : 'Commentary generated and awaiting approval.');
  } catch (error) { setMessage(message, error.message, true); }
});

async function start() {
  try {
    session = await getCurrentSession();
    if (!session) throw new Error('Sign in through the player portal first.');
    const playerData = await loadPlayerData(session.user.id);
    globalAdministrator = playerData.profile.role === 'admin';
    const tournamentAdmin = playerData.memberships.some(membership => membership.status === 'active' && membership.role === 'admin');
    if (playerData.profile.role !== 'admin' && !tournamentAdmin) throw new Error('This page is limited to the tournament administrator.');
    adminData = await loadAdminData();
    populateAdminChoices();
    renderMemberships();
    hydrateLegacyEdition();
    hydrateCommentarySettings();
    addSegment({ startHole: 1, endHole: 9, format: 'fourball', pointValue: 0.5 });
    addSegment({ startHole: 10, endHole: 18, format: 'foursomes', pointValue: 0.5 });
    renderCommentaryApprovals();
    adminContent.hidden = false;
  } catch (error) {
    document.querySelector('.admin-main').querySelectorAll('form').forEach(form => { form.hidden = true; });
    setMessage(document.querySelector('#adminStatus'), error.message, true);
  }
}

start();
