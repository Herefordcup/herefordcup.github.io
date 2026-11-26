import { submittedEntries, teamValue } from './team-correction-editor.js?v=compact-scorecard-1';

// Refresh just this match's rounds; do not reload the dashboard and discard other editors' drafts.
export async function readScorecardRounds(client, matchId) {
  const { data, error } = await client.from('rounds')
    .select('*, profiles(display_name), courses(name), tees(name, holes(hole_number, stroke_index)), scores!scores_round_id_fkey(*)')
    .eq('match_id', matchId);
  if (error) throw error;
  return data.filter(round => round.match_id === matchId);
}

// Keep one authoritative identity per submitted hole; never turn a missing score into an edit target.
export function scorecardGroups(match, rounds) {
  const groups = new Map();
  function add(key, label, target, value) {
    if (!target.row.id || !Number.isInteger(target.row.hole_number) || target.row.hole_number < 1 || target.row.hole_number > 18) return;
    if (!groups.has(key)) groups.set(key, { label, entries: [] });
    groups.get(key).entries.push({ target, value });
  }
  for (const round of rounds) {
    if (!round.id || round.match_id !== match.id) continue;
    const name = round.profiles?.display_name || 'Player';
    for (const row of round.scores ?? []) {
      if (row.round_id && row.round_id !== round.id) continue;
      add(`round:${round.id}`, name, { kind: 'individual', matchId: match.id, roundId: round.id, row,
        label: `${name} · Hole ${row.hole_number}` }, `Gross ${row.gross_score}`);
    }
  }
  for (const { type, row, players, label, cardId, cardLabel } of submittedEntries(match)) {
    const target = { kind: type, matchId: match.id, row, label };
    if (players) target.players = players.map(p => ({ id: p.user_id, name: p.profiles?.display_name || `Player ${p.playing_order}` }));
    add(cardId, cardLabel, target, teamValue(type, row, players));
  }
  for (const group of groups.values()) group.entries.sort((a, b) => a.target.row.hole_number - b.target.row.hole_number);
  return groups;
}

export function sameSubmittedHole(a, b) {
  return Boolean(a && b && a.kind === b.kind && a.matchId === b.matchId && a.roundId === b.roundId
    && a.row.id === b.row.id && a.row.hole_number === b.row.hole_number && a.row.gross_score === b.row.gross_score
    && a.row.tee_shot_player_id === b.row.tee_shot_player_id && a.row.winner === b.row.winner);
}

export function createScorecardList(picker, caption, container, edit) {
  let groups = new Map(), buttons = new Map(), editable = false, message = '';
  const chosen = () => groups.get(picker.value);
  function draw() {
    const group = chosen();
    const next = new Map();
    const rows = (group?.entries ?? []).map(({ target, value }) => {
      const key = `${target.matchId}:${target.kind}:${target.row.id}`;
      const line = document.createElement('div');
      line.className = 'scorecard-hole';
      const hole = document.createElement('strong');
      hole.textContent = `Hole ${target.row.hole_number}`;
      const score = document.createElement('span');
      score.textContent = value;
      line.append(hole, score);
      if (editable) {
        // Reuse the trigger node so closing the shared sheet restores focus after a readback.
        const button = buttons.get(key) ?? document.createElement('button');
        button.type = 'button';
        button.textContent = 'Edit';
        button.dataset.editHole = target.kind;
        button.dataset.entryId = target.row.id;
        button.dataset.hole = target.row.hole_number;
        if (target.roundId) button.dataset.roundId = target.roundId;
        button.setAttribute('aria-label', `Edit ${target.label}`);
        button.onclick = () => edit(target, button);
        line.append(button);
        next.set(key, button);
      }
      return line;
    });
    buttons = next;
    container.replaceChildren(...rows);
    container.setAttribute('aria-label', group ? `Submitted holes: ${group.label}` : 'Submitted holes');
    if (!rows.length) container.textContent = message;
  }
  picker.addEventListener('change', draw);
  return {
    render(match, rounds, allowEdit, empty = 'No holes submitted yet.') {
      const previous = picker.value;
      groups = match ? scorecardGroups(match, rounds) : new Map();
      editable = allowEdit;
      message = empty;
      picker.replaceChildren(...Array.from(groups, ([id, group]) => new Option(group.label, id)));
      if (groups.has(previous)) picker.value = previous;
      picker.parentElement.hidden = groups.size < 2;
      caption.hidden = groups.size !== 1;
      caption.textContent = caption.hidden ? '' : chosen().label;
      draw();
    },
    has(target) { return chosen()?.entries.some(entry => sameSubmittedHole(target, entry.target)) ?? false; },
  };
}
