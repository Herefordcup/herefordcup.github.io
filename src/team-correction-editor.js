const SCRAMBLE = 'texas_scramble_hole';
const OUTCOME = 'match_hole_outcome';
const winnerLabels = { cardinal: 'Blue', halved: 'Halved', silver: 'White' };

export function isSharedSegment(segment) {
  return segment.format === 'scramble' || segment.entry_mode === 'hole_outcomes';
}

export function submittedEntries(match) {
  const entries = [];
  for (const squad of match.correctionSquads ?? []) {
    if (squad.match_id !== match.id) continue;
    const players = (squad.texas_scramble_squad_players ?? []).filter(player => player.squad_id === squad.id)
      .sort((a, b) => a.playing_order - b.playing_order);
    for (const row of squad.texas_scramble_hole_scores ?? []) {
      if (row.id && row.squad_id === squad.id) entries.push({ type: SCRAMBLE, row, players, label: `${squad.label} · Hole ${row.hole_number}`,
        cardId: `squad:${squad.id}`, cardLabel: squad.label });
    }
  }
  for (const segment of match.match_segments ?? []) {
    if (segment.match_id !== match.id || segment.entry_mode !== 'hole_outcomes') continue;
    for (const row of segment.match_hole_outcomes ?? []) {
      if (row.id && row.segment_id === segment.id) entries.push({ type: OUTCOME, row, label: `Hole ${row.hole_number} · Holes ${segment.start_hole}–${segment.end_hole}`,
        cardId: `segment:${segment.id}`, cardLabel: `Hole winners · Holes ${segment.start_hole}–${segment.end_hole}` });
    }
  }
  return entries.sort((a, b) => a.row.hole_number - b.row.hole_number || a.label.localeCompare(b.label));
}

function showField(control, visible) {
  control.closest('label').hidden = !visible;
  control.disabled = !visible;
}

export function teamValue(type, row, players = []) {
  if (type === OUTCOME) return winnerLabels[row.winner] ?? 'Winner unavailable';
  const player = players.find(item => item.user_id === row.tee_shot_player_id);
  const name = player?.profiles?.display_name || (player ? `Player ${player.playing_order}` : 'Name unavailable');
  return `Gross ${row.gross_score} · tee shot: ${name}`;
}

export function renderTeamCorrectionAudits(container, audits, squads) {
  container.replaceChildren();
  if (!audits.length) container.textContent = 'No shared score corrections have been logged for this match.';
  for (const audit of audits) {
    const squad = squads.find(item => item.id === audit.after_value.squad_id);
    const describe = row => teamValue(audit.target_type, row, squad?.texas_scramble_squad_players);
    const card = document.createElement('article');
    card.className = 'result-audit-entry';
    const heading = document.createElement('strong');
    heading.textContent = `${audit.target_type === OUTCOME ? 'Hole winner' : squad?.label || 'Texas Scramble'} · Hole ${audit.after_value.hole_number}`;
    const transition = document.createElement('p');
    transition.className = 'result-audit-transition';
    transition.textContent = `${describe(audit.before_value)} → ${describe(audit.after_value)}`;
    const reason = document.createElement('p');
    reason.textContent = `Reason: ${audit.reason}`;
    const byline = document.createElement('small');
    byline.textContent = `Changed by ${audit.profiles?.display_name || 'an administrator'} · ${new Date(audit.corrected_at).toLocaleString()}`;
    card.append(heading, transition, reason, byline);
    container.append(card);
  }
}

export function createCorrectionEditor(form) {
  const field = id => form.querySelector(`#${id}`);
  const mode = field('correctionMode');
  const individualFields = field('individualCorrectionFields');
  const teamFields = field('teamCorrectionFields');
  const entrySelect = field('teamCorrectionEntry');
  const gross = field('teamCorrectionGross');
  const driver = field('teamCorrectionDriver');
  const winner = field('teamCorrectionWinner');
  const remove = field('correctionDelete');
  const score = field('correctionScore');
  const submit = form.querySelector('button[type="submit"]');
  let entries = [], match, roundCount, readError;
  const selectedEntry = () => entries.find(entry => entry.row.id === entrySelect.value);

  function render() {
    const team = mode.value === 'team';
    individualFields.hidden = individualFields.disabled = team;
    teamFields.hidden = teamFields.disabled = !team;
    const entry = team && selectedEntry();
    showField(gross, entry?.type === SCRAMBLE);
    showField(driver, entry?.type === SCRAMBLE);
    showField(winner, entry?.type === OUTCOME);
    if (entry?.type === SCRAMBLE) {
      gross.value = entry.row.gross_score;
      driver.replaceChildren(...entry.players.map(player => new Option(player.profiles?.display_name || `Player ${player.playing_order}`, player.user_id)));
      driver.value = entry.row.tee_shot_player_id;
    } else if (entry) winner.value = entry.row.winner;
    remove.disabled = team || match.status === 'final';
    if (remove.disabled) remove.checked = false;
    score.disabled = remove.checked;
    score.required = !remove.checked;
    const emptyMessage = team ? 'No shared holes have been submitted for this match.' : 'No player rounds have been submitted for this match.';
    submit.disabled = team ? !entry : !roundCount;
    entrySelect.disabled = !team || !entries.length;
    field('correctionReason').disabled = submit.disabled;
    field('correctionMessage').textContent = readError || (submit.disabled ? emptyMessage : '');
  }
  mode.addEventListener('change', render);
  entrySelect.addEventListener('change', render);

  return {
    prepare(selectedMatch, rounds, error = '') {
      const previousId = entrySelect.value;
      const sameMatch = match?.id === selectedMatch.id;
      if (!sameMatch) form.reset();
      match = selectedMatch;
      roundCount = rounds;
      readError = error;
      entries = readError ? [] : submittedEntries(match);
      entrySelect.replaceChildren(...entries.map(({ row, type, label }) => new Option(
        `${label} · ${type === OUTCOME ? winnerLabels[row.winner] : `Gross ${row.gross_score}`}`, row.id,
      )));
      if (entries.some(({ row }) => row.id === previousId)) entrySelect.value = previousId;
      const shared = match.match_segments?.some(isSharedSegment);
      showField(mode, Boolean(shared && rounds));
      const preferTeam = (sameMatch && mode.value === 'team') || match.match_segments?.every(isSharedSegment);
      mode.value = shared && (!rounds || (entries.length && preferTeam)) ? 'team' : 'individual';
      render();
    },
    focus() {
      if (mode.value === 'individual') field('correctionRound').focus();
      else if (entries.length) entrySelect.focus();
      else document.querySelector('#closeScoreCorrection').focus();
    },
    get matchId() { return match?.id; },
    get team() { return mode.value === 'team'; },
    get entry() { return selectedEntry(); },
    payload() {
      const entry = selectedEntry();
      if (!entry) throw new Error('Select a submitted entry from this match.');
      const reason = field('correctionReason').value.trim();
      if (!reason) throw new Error('A correction reason is required.');
      const target = { targetType: entry.type, targetId: entry.row.id, reason };
      if (entry.type === OUTCOME) {
        if (!Object.hasOwn(winnerLabels, winner.value)) throw new Error('Choose Blue, Halved, or White.');
        return { ...target, winner: winner.value };
      }
      const grossScore = Number(gross.value);
      if (!Number.isInteger(grossScore) || grossScore < 1 || grossScore > 30) throw new Error('Enter a team gross score from 1 to 30.');
      if (!entry.players.some(player => player.user_id === driver.value)) throw new Error('Choose a tee-shot player from this squad.');
      return { ...target, grossScore, teeShotPlayerId: driver.value };
    },
  };
}
