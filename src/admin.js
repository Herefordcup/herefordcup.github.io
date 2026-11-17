import { validateSegments } from './formats.js';
import { easternDateTimeToIso, optionalNumber } from './admin-helpers.js';
import {
  correctHoleScore,
  deleteLegacyPhoto,
  getCurrentSession,
  generateMatchCommentary,
  finalizeMatchResults,
  loadAdminData,
  loadPlayerData,
  saveCommentarySettings,
  saveCourseWithTee,
  saveLegacyEdition,
  saveLegacyResult,
  saveMatchPlan,
  saveTournamentRule,
  uploadLegacyPhoto,
  updateCommentaryStatus,
  updateCommentaryText,
} from './supabase.js';

const courseForm = document.querySelector('#courseForm');
const holesContainer = document.querySelector('#adminHoles');
const courseMessage = document.querySelector('#adminMessage');
const matchPlanForm = document.querySelector('#matchPlanForm');
const matchPlanMessage = document.querySelector('#matchPlanMessage');
const segmentRows = document.querySelector('#segmentRows');
const segmentTemplate = document.querySelector('#segmentTemplate');
const ruleForm = document.querySelector('#ruleForm');
const commentarySettingsForm = document.querySelector('#commentarySettingsForm');
const commentaryTournament = document.querySelector('#commentaryTournament');
const scoreCorrectionForm = document.querySelector('#scoreCorrectionForm');
const correctionRound = document.querySelector('#correctionRound');
const resultFinalizationForm = document.querySelector('#resultFinalizationForm');
const resultMatch = document.querySelector('#resultMatch');
const resultSegmentRows = document.querySelector('#resultSegmentRows');
const adminContent = document.querySelector('#adminContent');
const legacyEditionForm = document.querySelector('#legacyEditionForm');
const legacyEditionSelect = document.querySelector('#legacyEditionSelect');
const legacyResultForm = document.querySelector('#legacyResultForm');
const legacyPhotoForm = document.querySelector('#legacyPhotoForm');
const defaultPars = [4, 4, 3, 5, 4, 4, 3, 5, 4, 4, 4, 3, 5, 4, 4, 3, 5, 4];

let session;
let adminData;

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
  return adminData.memberships.filter(membership => membership.tournament_id === tournamentId);
}

function createPlayerSlot(slotNumber) {
  const wrapper = document.createElement('div');
  wrapper.className = 'player-slot';
  const playerLabel = document.createElement('label');
  playerLabel.textContent = `Player ${slotNumber}`;
  const playerSelect = document.createElement('select');
  playerSelect.dataset.playerSelect = 'true';
  playerSelect.append(new Option('Unassigned', ''));
  for (const membership of membersForTournament(activeTournamentId())) {
    const name = membership.profiles?.display_name || 'Player';
    playerSelect.append(new Option(`${name} · ${membership.team || 'No team'}`, membership.user_id));
  }
  playerLabel.append(playerSelect);
  const sideLabel = document.createElement('label');
  sideLabel.textContent = 'Match side';
  const sideSelect = document.createElement('select');
  sideSelect.dataset.sideSelect = 'true';
  sideSelect.append(new Option('Cardinal side', 'cardinal'), new Option('Silver side', 'silver'));
  sideLabel.append(sideSelect);
  wrapper.append(playerLabel, sideLabel);
  return wrapper;
}

function renumberSegments() {
  [...segmentRows.querySelectorAll('.segment-card')].forEach((card, index) => {
    card.querySelector('.segment-head strong').textContent = `Segment ${index + 1}`;
  });
}

function addSegment({ startHole = 1, endHole = 18, format = 'fourball', scoringMode = 'net', pointValue = 1 } = {}) {
  const card = segmentTemplate.content.firstElementChild.cloneNode(true);
  card.querySelector('[name="startHole"]').value = startHole;
  card.querySelector('[name="endHole"]').value = endHole;
  card.querySelector('[name="format"]').value = format;
  card.querySelector('[name="scoringMode"]').value = scoringMode;
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
      return [{ userId, team: membership?.team, side: slot.querySelector('[data-side-select]').value, playingOrder: playingIndex + 1 }];
    });
    return {
      segmentNumber: index + 1,
      startHole: Number(card.querySelector('[name="startHole"]').value),
      endHole: Number(card.querySelector('[name="endHole"]').value),
      format: card.querySelector('[name="format"]').value,
      scoringMode: card.querySelector('[name="scoringMode"]').value,
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
    handicap_allowance: segment.handicapAllowance,
    point_value: segment.pointValue,
    players: segment.players.map(player => ({ user_id: player.userId, team: player.team, side: player.side, playing_order: player.playingOrder })),
  }));
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
  renderLegacyPhotoList();
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
  legacyEditionForm.elements.published.checked = edition?.published ?? true;
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

function populateAdminChoices() {
  const tournamentSelects = ['#matchTournament', '#ruleTournament', '#commentaryTournament'].map(selector => document.querySelector(selector));
  for (const select of tournamentSelects) select.replaceChildren(...adminData.tournaments.map(tournament => new Option(`${tournament.name} · ${tournament.edition_year}`, tournament.id)));
  const courseSelect = document.querySelector('#matchCourse');
  courseSelect.replaceChildren(new Option('Course TBA', ''), ...adminData.courses.map(course => new Option(course.name, course.id)));
  const commentaryMatch = document.querySelector('#commentaryMatch');
  commentaryMatch.replaceChildren(
    new Option('Select a finalized match', ''),
    ...adminData.matches.filter(match => match.status === 'final').map(match => new Option(match.name, match.id)),
  );
  resultMatch.replaceChildren(
    new Option('Select a match', ''),
    ...adminData.matches.filter(match => match.status !== 'final').map(match => new Option(match.name, match.id)),
  );
  correctionRound.replaceChildren(
    new Option('Select a player round', ''),
    ...adminData.rounds.map(round => new Option(
      `${round.profiles?.display_name || 'Player'} · ${round.courses?.name || 'Course'} · ${round.tees?.name || 'Tee'}`,
      round.id,
    )),
  );
  populateLegacyChoices();
}

function hydrateCommentarySettings() {
  const settings = adminData.settings.find(item => item.tournament_id === commentaryTournament.value);
  commentarySettingsForm.elements.enabled.checked = settings?.enabled ?? false;
  commentarySettingsForm.elements.tone.value = settings?.tone ?? 'playful';
  commentarySettingsForm.elements.timing.value = settings?.timing ?? 'post_match';
  commentarySettingsForm.elements.maxCharacters.value = settings?.max_characters ?? 600;
}

function renderResultSegments() {
  resultSegmentRows.replaceChildren();
  const match = adminData.matches.find(item => item.id === resultMatch.value);
  for (const segment of match?.match_segments ?? []) {
    const card = document.createElement('fieldset');
    card.className = 'segment-card';
    card.dataset.segmentId = segment.id;
    card.innerHTML = `<legend>Holes ${segment.start_hole}–${segment.end_hole} · ${segment.format} · ${segment.scoring_mode} · ${segment.point_value} pts</legend>
      <div class="segment-fields">
        <label>Official differential<input name="differential" type="number" min="-${segment.end_hole - segment.start_hole + 1}" max="${segment.end_hole - segment.start_hole + 1}" value="${segment.differential ?? 0}" required></label>
        <label>Holes played<input name="holesPlayed" type="number" min="1" max="${segment.end_hole - segment.start_hole + 1}" value="${segment.holes_played || segment.end_hole - segment.start_hole + 1}" required></label>
        <label>Result status<input value="Final" disabled></label>
      </div><p>Positive differential = Cardinal lead; negative = Silver; zero = halved.</p>`;
    resultSegmentRows.append(card);
  }
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
  addSegment({ startHole: 1, endHole: 9, format: 'scramble', pointValue: 0.5 });
  addSegment({ startHole: 10, endHole: 18, format: 'fourball', pointValue: 0.5 });
});

matchPlanForm.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const data = new FormData(matchPlanForm);
    const segments = collectSegments();
    const errors = validateSegments(segments);
    if (errors.length) throw new Error(errors[0]);
    if (segments.some(segment => segment.players.some(player => !player.team))) throw new Error('Every assigned player must belong to Cardinal or Silver.');
    setMessage(matchPlanMessage, 'Saving…');
    await saveMatchPlan({ match: { name: data.get('matchName'), session: data.get('session'), starts_at: easternDateTimeToIso(data.get('startsAt')), course_id: data.get('courseId') || null, tournament_id: data.get('tournamentId'), status: 'scheduled' }, segments: rpcSegments(segments) });
    setMessage(matchPlanMessage, 'Match plan saved.');
  } catch (error) { setMessage(matchPlanMessage, error.message, true); }
});

resultMatch.addEventListener('change', renderResultSegments);
resultFinalizationForm.addEventListener('submit', async event => {
  event.preventDefault();
  const message = document.querySelector('#resultMessage');
  try {
    const segmentResults = [...resultSegmentRows.querySelectorAll('[data-segment-id]')].map(card => ({
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
    populateAdminChoices();
    renderResultSegments();

    const commentarySettings = adminData.settings.find(item => item.tournament_id === finalized.tournament_id);
    if (commentarySettings?.enabled) {
      try {
        setMessage(message, 'Match finalized. Generating commentary…');
        const commentary = await generateMatchCommentary(matchId);
        adminData.commentaries.unshift(commentary);
        renderCommentaryApprovals();
        setMessage(message, commentary.status === 'approved'
          ? 'Match finalized. Commentary generated and published.'
          : 'Match finalized. Commentary generated and awaiting approval.');
      } catch (commentaryError) {
        setMessage(message, `Match finalized, but automatic commentary failed: ${commentaryError.message}. Use Generate match recap to retry.`, true);
      }
      return;
    }

    setMessage(message, 'Match finalized. Cup points and official statistics are now available.');
  } catch (error) { setMessage(message, error.message, true); }
});

ruleForm.addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(ruleForm);
  try {
    await saveTournamentRule({ tournamentId: data.get('tournamentId'), title: data.get('title'), body: data.get('body'), sortOrder: data.get('sortOrder') });
    setMessage(document.querySelector('#ruleMessage'), 'Rule published.');
  } catch (error) { setMessage(document.querySelector('#ruleMessage'), error.message, true); }
});

legacyEditionSelect.addEventListener('change', hydrateLegacyEdition);
document.querySelector('#legacyPhotoEdition').addEventListener('change', renderLegacyPhotoList);

legacyEditionForm.addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(legacyEditionForm);
  const message = document.querySelector('#legacyEditionMessage');
  try {
    setMessage(message, 'Saving…');
    const existing = adminData.legacyEditions.find(item => item.id === data.get('editionId'));
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
      published: data.get('published') === 'on',
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
      editionId: data.get('editionId'),
      label: data.get('label'),
      cardinalEntry: data.get('cardinalEntry'),
      silverEntry: data.get('silverEntry'),
      result: data.get('result'),
      sortOrder: data.get('sortOrder'),
    });
    const edition = adminData.legacyEditions.find(item => item.id === saved.edition_id);
    edition.legacy_results.push(saved);
    legacyResultForm.reset();
    document.querySelector('#legacyResultEdition').value = saved.edition_id;
    setMessage(message, 'Legacy result added.');
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

document.querySelector('#correctionDelete').addEventListener('change', event => {
  const scoreInput = document.querySelector('#correctionScore');
  scoreInput.disabled = event.target.checked;
  scoreInput.required = !event.target.checked;
});

scoreCorrectionForm.addEventListener('submit', async event => {
  event.preventDefault();
  const message = document.querySelector('#correctionMessage');
  const deleteScore = document.querySelector('#correctionDelete').checked;
  const roundId = correctionRound.value;
  const holeNumber = Number(document.querySelector('#correctionHole').value);
  try {
    setMessage(message, 'Saving audited correction…');
    const result = await correctHoleScore({
      roundId,
      holeNumber,
      grossScore: deleteScore ? null : document.querySelector('#correctionScore').value,
      deleteScore,
      reason: document.querySelector('#correctionReason').value,
    });
    const round = adminData.rounds.find(item => item.id === roundId);
    if (round) {
      round.scores = deleteScore
        ? round.scores.filter(score => score.hole_number !== holeNumber)
        : [...round.scores.filter(score => score.hole_number !== holeNumber), result.score];
    }
    setMessage(message, `Correction saved and audited (${result.audit?.action || (deleteScore ? 'delete' : 'update')}).`);
    scoreCorrectionForm.reset();
    document.querySelector('#correctionScore').disabled = false;
  } catch (error) { setMessage(message, error.message, true); }
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
    const commentary = await generateMatchCommentary(matchId);
    adminData.commentaries.unshift(commentary);
    renderCommentaryApprovals();
    setMessage(message, commentary.status === 'approved' ? 'Commentary generated and published.' : 'Commentary generated and awaiting approval.');
  } catch (error) { setMessage(message, error.message, true); }
});

async function start() {
  try {
    session = await getCurrentSession();
    if (!session) throw new Error('Sign in through the player portal first.');
    const playerData = await loadPlayerData(session.user.id);
    if (playerData.profile.role !== 'admin') throw new Error('This page is limited to the tournament administrator.');
    adminData = await loadAdminData();
    populateAdminChoices();
    hydrateLegacyEdition();
    hydrateCommentarySettings();
    addSegment({ startHole: 1, endHole: 9, format: 'scramble', pointValue: 0.5 });
    addSegment({ startHole: 10, endHole: 18, format: 'fourball', pointValue: 0.5 });
    renderCommentaryApprovals();
    adminContent.hidden = false;
  } catch (error) {
    document.querySelector('.admin-main').querySelectorAll('form').forEach(form => { form.hidden = true; });
    setMessage(document.querySelector('#adminStatus'), error.message, true);
  }
}

start();
