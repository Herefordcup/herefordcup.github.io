// All editor factories in this page share the hold; a page refresh reads the scorecard anew.
const rowsNeedingRefresh = new Set();
const uncertainWrite = 'This correction might have saved. Refresh the page and check this hole before trying again.';
// A business-rule RAISE, invalid parameter/input, or integrity constraint rejects the transaction.
const refusalCodes = new Set(['P0001', '22023', '22P02', '23502', '23503', '23505', '23514']);

// The caller resolves the row from its authorized scorecard. No match, player,
// hole, or row ID is ever taken from the form on submit.
export function createHoleEditor({ canEdit, correctHoleScore, correctTeamScoreEntry, onSaved, notify }) {
  let active = null;

  function open(source, trigger) {
    if (active || document.getElementById('holeEditDialog') || !source?.matchId || !source.row?.id || canEdit(source) !== true) return false;
    const hole = Number(source.row.hole_number);
    if (!Number.isInteger(hole) || hole < 1 || hole > 18) return false;
    const individual = source.kind === 'individual', scramble = source.kind === 'texas_scramble_hole', outcome = source.kind === 'match_hole_outcome';
    if (!individual && !scramble && !outcome) return false;
    if (individual && (!source.roundId || (source.row.round_id && source.row.round_id !== source.roundId))) return false;
    const target = { ...source, row: { ...source.row }, players: (source.players ?? []).map(({id,name}) => ({id,name})) };
    const rowKey = `${target.kind}:${target.row.id}`;
    const winners = { cardinal: 'Blue', halved: 'Halved', silver: 'White' };
    const isWinner = value => Object.prototype.hasOwnProperty.call(winners, value);
    if (scramble && !target.players.some(p => p.id === target.row.tee_shot_player_id)) return false;
    if (outcome && !isWinner(target.row.winner)) return false;
    const dialog = document.createElement('dialog');
    dialog.id = 'holeEditDialog';
    dialog.className = 'hole-edit-dialog';
    dialog.setAttribute('aria-labelledby', 'holeEditTitle');
    dialog.setAttribute('aria-describedby', 'holeEditContext');
    dialog.dataset.entryId = target.row.id;
    // Static markup only; all names, IDs, and saved values are set as DOM properties.
    dialog.innerHTML = `<form novalidate>
      <header><h2 id="holeEditTitle"></h2><p id="holeEditContext"></p></header>
      <div class="hole-edit-fields"><label>Gross score<input id="holeEditGross" type="number" min="1" step="1" inputmode="numeric" required></label>
      <label>Tee shot used<select id="holeEditDriver"></select></label><label>Hole winner<select id="holeEditWinner"></select></label>
      <label>Reason for change<textarea id="holeEditReason" rows="2" maxlength="500" required></textarea></label>
      <p id="holeEditFeedback" role="status" aria-live="polite"></p></div>
      <footer><button type="button" id="holeEditCancel">Cancel</button><button type="submit" id="holeEditSave">Save correction</button></footer></form>`;
    const el = id => dialog.querySelector(`#${id}`);
    const gross = el('holeEditGross'), reason = el('holeEditReason'), feedback = el('holeEditFeedback');
    const form = dialog.querySelector('form');
    const cancel = el('holeEditCancel');
    const showRefreshRequired = () => {
      for (const control of form.elements) control.disabled = control !== cancel;
      feedback.textContent = uncertainWrite;
      cancel.focus();
    };
    el('holeEditTitle').textContent = `Edit hole ${hole}`;
    el('holeEditContext').textContent = target.label;
    const driver = el('holeEditDriver'), winner = el('holeEditWinner');
    const setFields = () => {
      for (const [control,visible] of [[gross,!outcome],[driver,scramble],[winner,outcome]]) {
        control.closest('label').hidden = !visible;
        control.disabled = !visible;
        control.required = visible;
      }
    };
    setFields();
    const max = scramble ? 30 : 15;
    gross.max = String(max);
    gross.value = target.row.gross_score ?? '';
    if (scramble) {
      driver.replaceChildren(...target.players.map(p => new Option(p.name || 'Player',p.id)));
      driver.value = target.row.tee_shot_player_id;
    }
    if (outcome) {
      winner.replaceChildren(...Object.entries(winners).map(([value,text]) => new Option(text,value)));
      winner.value = target.row.winner;
    }
    let busy = false;
    let backdrop, containFocus;
    const background = [];
    active = dialog;
    const close = () => {
      if (busy || active !== dialog) return;
      if (dialog.open && !backdrop && typeof dialog.close === 'function') dialog.close();
      if (containFocus) document.removeEventListener('focusin', containFocus, true);
      for (const element of background) element.inert = false;
      backdrop?.remove();
      dialog.remove(); active = null;
      const restored = trigger?.isConnected ? trigger : [...document.querySelectorAll('button[data-edit-hole]')].find(b => b.dataset.entryId === target.row.id);
      (restored ?? document.querySelector('#resultMatch, #matchSelect'))?.focus({ preventScroll: true });
    };
    cancel.addEventListener('click', close);
    dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (busy || active !== dialog || rowsNeedingRefresh.has(rowKey)) return;
      const why = reason.value.trim(), strokes = gross.valueAsNumber;
      if (canEdit(target) !== true) { feedback.textContent = 'This score is no longer editable. Close this editor and refresh the card.'; return; }
      if (!outcome && (!Number.isInteger(strokes) || strokes < 1 || strokes > max)) { feedback.textContent = `Enter a whole score from 1 to ${max}.`; gross.focus(); return; }
      if (scramble && !target.players.some(p => p.id === driver.value)) { feedback.textContent = 'Choose the player whose tee shot was used.'; driver.focus(); return; }
      if (outcome && !isWinner(winner.value)) { feedback.textContent = 'Choose Blue, Halved or White.'; winner.focus(); return; }
      if (!why || why.length > 500) { feedback.textContent = 'Enter a reason of 1–500 characters.'; reason.focus(); return; }
      const changed = outcome ? winner.value !== target.row.winner
        : strokes !== Number(target.row.gross_score) || (scramble && driver.value !== target.row.tee_shot_player_id);
      if (!changed) { feedback.textContent = 'Change the score, driver or winner before saving.'; return; }
      busy = true;
      form.setAttribute('aria-busy','true');
      for (const control of form.elements) control.disabled = true;
      feedback.textContent = 'Saving…';
      if (backdrop) feedback.focus(); // Keep keyboard focus inside while every form control is disabled.
      let result;
      try {
        if (individual) {
          result = await correctHoleScore({ roundId: target.roundId, holeNumber: hole, expectedScoreId:target.row.id, grossScore: strokes, reason: why, deleteScore: false });
        } else {
          result = await correctTeamScoreEntry({ targetType: target.kind, targetId: target.row.id, reason: why,
            ...(scramble ? {grossScore:strokes,teeShotPlayerId:driver.value} : {winner:winner.value}) });
        }
      } catch (error) {
        busy = false; form.removeAttribute('aria-busy');
        if (refusalCodes.has(error?.code) && typeof error.message === 'string' && error.message.trim()) {
          for (const control of form.elements) control.disabled = false;
          setFields();
          feedback.textContent = error.message;
        } else {
          rowsNeedingRefresh.add(rowKey);
          showRefreshRequired();
        }
        return;
      }
      // A follow-up read failing is not a failed write. Do not invite a duplicate save.
      const saved = individual ? result?.score : result;
      const sameRow = saved?.id === target.row.id && Number(saved.hole_number) === hole
        && (!individual || saved.round_id === target.roundId)
        && (!target.row.squad_id || saved.squad_id === target.row.squad_id)
        && (!target.row.segment_id || saved.segment_id === target.row.segment_id);
      if (!sameRow) {
        rowsNeedingRefresh.add(rowKey);
        busy = false; close();
        notify?.(`Could not confirm the saved hole. ${uncertainWrite}`, true, target);
        return;
      }
      let warning = result?.auditWarning || (result?.completion_warning ? `Individual scorecards need review: ${result.completion_warning}` : '');
      try { const extra = await onSaved?.(target, result); if (extra) warning = [warning,extra].filter(Boolean).join(' '); }
      catch (error) { warning = [warning,`Refresh the scorecard: ${error?.message || 'Readback unavailable.'}`].filter(Boolean).join(' '); }
      busy = false; close();
      notify?.(`Hole ${hole} corrected.${warning ? ` ${warning}` : ''}`, Boolean(warning), target);
    });
    document.body.append(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else {
      backdrop = document.createElement('div'); backdrop.className = 'hole-edit-backdrop';
      backdrop.addEventListener('click', close); dialog.before(backdrop);
      dialog.setAttribute('open',''); dialog.setAttribute('role','dialog'); dialog.setAttribute('aria-modal','true');
      for (const sibling of document.body.children) {
        if (sibling !== dialog && sibling !== backdrop && 'inert' in sibling && !sibling.inert) { background.push(sibling); sibling.inert = true; }
      }
      const enabledControls = () => [...form.elements].filter(c => !c.disabled && c.getClientRects().length);
      feedback.tabIndex = -1;
      containFocus = event => {
        if (!dialog.contains(event.target)) (enabledControls()[0] || feedback).focus();
      };
      document.addEventListener('focusin', containFocus, true);
      dialog.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key !== 'Tab') return;
        const focusable = enabledControls();
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      });
    }
    if (rowsNeedingRefresh.has(rowKey)) showRefreshRequired();
    else (outcome ? winner : gross).focus();
    return true;
  }
  return { open };
}
