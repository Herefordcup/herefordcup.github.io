import { expect, test } from '@playwright/test';

// This helper drives real app controls. The fixture separately reads committed
// rows from the disposable runner; UI toast text alone never counts as a pass.
const admin = () => ({ name: 'Disposable E2E Admin', email: process.env.E2E_USER_EMAIL });
export async function selectAdminTool(page, tool) {
  const chooser = page.locator('#adminTool');
  await chooser.selectOption(tool);
  await expect(chooser).toHaveValue(tool);
}
async function goAdmin(page, tool) {
  await page.goto('/admin.html');
  await expect(page.locator('#adminContent')).toBeVisible({ timeout: 20_000 });
  if (tool) await selectAdminTool(page, tool);
}
async function submitRpc(page, name, click) {
  const [reply] = await Promise.all([
    page.waitForResponse(r => {
      const url = new URL(r.url());
      return r.request().method() === 'POST' && url.protocol === 'http:' && ['127.0.0.1','localhost'].includes(url.hostname)
        && url.port === '54321' && url.pathname === `/rest/v1/rpc/${name}`;
    }),
    click(),
  ]);
  expect(reply.ok(), `${name} returned HTTP ${reply.status()}`).toBe(true);
  return reply;
}

const squadCard = (page, squad) => page.locator(`#texasScrambleSquads [data-squad-side="${squad.side}"][data-squad-number="${squad.number}"]`);
const lineupSlot = (card, order) => card.locator(`select[data-playing-order="${order}"]`);
async function expectLineupSlots(page, squads, expected) {
  for (const [i, squad] of squads.entries()) {
    const card = squadCard(page, squad);
    await expect(card.locator('select[data-playing-order]')).toHaveCount(4);
    for (const [slot, id] of expected[i].entries()) await expect(lineupSlot(card, slot + 1)).toHaveValue(id);
  }
}

export async function editUnplayedLineup({ browser, baseURL, signIn, fixture: f }) {
  const o = f.organizer;
  const ctx = await browser.newContext({ baseURL });
  try {
    const page = await ctx.newPage();
    await signIn(page, admin());
    await goAdmin(page, 'scramble');
    await page.locator('#texasScrambleTournament').selectOption(o.tournamentId);
    const saved = page.locator('#texasScrambleSavedSession');
    await saved.selectOption(o.sessionId);
    const expected = f.squads.map(s => s.players.map(p => p.id));
    await expectLineupSlots(page, f.squads, expected);
    const card = squadCard(page, f.squads[0]);
    [expected[0][0], expected[0][1]] = [expected[0][1], expected[0][0]];
    await lineupSlot(card, 1).selectOption('');
    await lineupSlot(card, 2).selectOption(expected[0][1]);
    await lineupSlot(card, 1).selectOption(expected[0][0]);
    const name = 'Texas Scramble — amended lineup';
    await page.locator('#texasScrambleForm [name="name"]').fill(name);
    await submitRpc(page, 'save_texas_scramble_plan', () => page.locator('#texasScrambleForm button[type="submit"]').click());
    await expect(saved).toHaveValue(o.sessionId);
    const db = await o.lineup();
    expect(db.tournament).toMatchObject({ id: o.tournamentId, edition_year: 2098, status: 'setup' });
    expect(db.sessions).toHaveLength(1);
    expect(db.sessions[0]).toMatchObject({ id: o.sessionId, tournament_id: o.tournamentId, name, status: 'scheduled' });
    expect(db.roster).toHaveLength(4);
    expect(db.matches).toHaveLength(4);
    for (const [i, s] of f.squads.entries()) {
      const actual = db.roster.find(g => g.label === s.label && g.side === s.side && g.squad_number === s.number);
      expect(actual).toMatchObject({ session_id: o.sessionId, squad_size: 4, status: 'scheduled', texas_scramble_hole_scores: [] });
      expect(actual.texas_scramble_squad_players).toEqual(expected[i].map((user_id, j) => ({
        session_id: o.sessionId, squad_id: actual.id, user_id, playing_order: j + 1,
      })));
      const match = db.matches.find(m => m.id === actual.match_id);
      expect(match).toMatchObject({ name: s.label, tournament_id: o.tournamentId, status: 'scheduled' });
      expect(match.match_players).toEqual(expected[i].toSorted().map(user_id => ({ user_id, team: s.side })));
      expect(match.match_segments).toHaveLength(1);
      expect(match.match_segments[0]).toMatchObject({ id: actual.segment_id, match_id: actual.match_id, status: 'scheduled', point_value: 0 });
      expect(match.match_segments[0].match_segment_players).toEqual(expected[i].map((user_id, j) => ({
        user_id, team: s.side, side: s.side, playing_order: j + 1,
      })));
    }
    await goAdmin(page, 'scramble');
    await page.locator('#texasScrambleTournament').selectOption(o.tournamentId);
    await saved.selectOption(o.sessionId);
    await expect(page.locator('#texasScrambleForm [name="name"]')).toHaveValue(name);
    await expectLineupSlots(page, f.squads, expected);
    console.log('Verified unplayed lineup edit: same session, four matches, all 16 assignments, no scores, no duplicates.');
  } finally { await ctx.close(); }
}

export async function showCardTarget(page, target, card) {
  const picker = page.locator('#scorecardCard').filter({ has: page.locator(`option[value="${card}"]`) });
  // A single/already displayed card need not provide a second picker.
  await expect(target.or(picker).filter({ visible: true }).first()).toBeVisible();
  if (!(await target.isVisible()) && (await picker.inputValue()) !== card) await picker.selectOption(card);
  await expect(target).toBeVisible();
}

export async function openSavedHole(page, row, scope = page) {
  const edit = scope.locator(`button[data-edit-hole][data-entry-id="${row.id}"]:not(#scorecardMore *)`);
  const card = row.round_id ? `round:${row.round_id}` : row.squad_id ? `squad:${row.squad_id}` : `segment:${row.segment_id}`;
  await showCardTarget(page, edit, card);
  await expect(edit).toHaveAccessibleName(/edit|correct/i);
  if (row.round_id) {
    await expect(edit).toHaveAttribute('data-round-id', row.round_id);
    await expect(edit).toHaveAttribute('data-hole', String(row.hole_number));
  }
  const dialog = page.locator('#holeEditDialog');
  await expect(dialog).toBeHidden();
  await edit.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('data-entry-id', row.id);
  await expect(dialog.locator('select:enabled:visible:not(#holeEditDriver, #holeEditWinner), input[type="number"]:enabled:visible:not([readonly], #holeEditGross)')).toHaveCount(0);
  await expect(dialog.locator('#holeEditReason')).toHaveValue('');
  await expect(dialog.locator('#holeEditCancel')).toBeVisible();
  return dialog;
}

export async function saveHoleEdit(page, row, rpc, message, expected) {
  const dialog = page.locator('#holeEditDialog');
  await expect(dialog).toHaveAttribute('data-entry-id', row.id);
  const reply = await submitRpc(page, rpc, () => dialog.locator('#holeEditSave').click());
  const saved = await reply.json();
  expect(Array.isArray(saved) ? saved : [saved]).toMatchObject([{ id: row.id, hole_number: row.hole_number, ...expected }]);
  await expect(dialog).toBeHidden();
  await expect(page.locator(message)).toHaveText(new RegExp(`^Hole ${row.hole_number} corrected\\.`));
}

export async function openChangeHistory(page, card) {
  const history = page.locator('details#scorecardHistory');
  const summary = history.locator(':scope > summary');
  if (card) await showCardTarget(page, summary, card);
  await expect(summary).toBeVisible();
  await expect(summary).toContainText('View change history');
  if (!await history.evaluate(details => details.open)) await summary.click();
  await expect(history).toHaveJSProperty('open', true);
  return history;
}

async function prepareCorrection(page, { matchId, row, reason, gross, driver, winner }) {
  await goAdmin(page, 'scorecards');
  const match = page.locator('#resultMatch');
  await match.selectOption(matchId);
  await expect(match).toHaveValue(matchId);
  const dialog = await openSavedHole(page, row);
  if (winner) {
    const field = dialog.locator('#holeEditWinner');
    await expect(field).toHaveValue(row.winner);
    await field.selectOption(winner);
  } else {
    await expect(dialog.locator('#holeEditGross')).toHaveValue(String(row.gross_score));
    await expect(dialog.locator('#holeEditDriver')).toHaveValue(row.tee_shot_player_id);
    await dialog.locator('#holeEditGross').fill(String(gross));
    await dialog.locator('#holeEditDriver').selectOption(driver);
  }
  await dialog.locator('#holeEditReason').fill(reason);
}
async function expectVisibleHistory(page, reason, card) {
  const history = (await openChangeHistory(page, card)).locator('#teamCorrectionHistory');
  await expect(history).toBeVisible();
  await expect(history).toContainText(reason, { useInnerText: true });
}
async function saveCorrection(page, { matchId, row, gross, driver, winner, reason }) {
  await saveHoleEdit(page, row, 'correct_team_score_entry', '#resultMessage', winner
    ? { segment_id: row.segment_id, winner } : { squad_id: row.squad_id, gross_score: gross, tee_shot_player_id: driver });
  await expect(page.locator('#resultMatch')).toHaveValue(matchId);
  await expectVisibleHistory(page, reason);
}
async function openPlanner(page, tournamentId, match) {
  await goAdmin(page, 'matches');
  await page.locator('#matchTournament').selectOption(tournamentId);
  await page.locator('#matchPlanExisting').selectOption(match.id);
  const form = page.locator('#matchPlanForm');
  const name = form.locator('[name="matchName"]');
  const points = form.locator('#segmentRows [name="pointValue"]');
  await expect(name).toHaveValue(match.name);
  await expect(points).toHaveCount(1);
  await expect(points).toHaveValue(/^1(?:\.0+)?$/);
  return { name, points, save: form.locator('button[type="submit"]'), message: page.locator('#matchPlanMessage') };
}

// A generic HTTP/permission/required-field error is not evidence of a state guard.
async function expectRefusal(message, state, denied) {
  await expect(message).toBeVisible();
  await expect(message).toContainText(state);
  await expect(message).toContainText(denied);
}
async function openOutcome(page, id) {
  await page.locator('#memberNav [data-member-view="score"]').click();
  await page.locator('#matchSelect').selectOption(id);
  await expect(page.locator('#holeOutcomeScorecard')).toBeVisible();
}
async function enterOutcome(page, hole, winner) {
  const row = page.locator('#holeOutcomeRows .outcome-hole-row').nth(hole-1);
  await expect(row.locator('.hole-id')).toHaveText(String(hole));
  await row.getByRole('combobox').selectOption(winner);
  await row.getByRole('button',{name:'Save hole'}).click();
  await expect(row.getByRole('button',{name:'Locked'})).toBeDisabled();
  await expect(row.locator('button[data-edit-hole]')).toHaveCount(0);
}

async function expectCompactScorecards(page, squad) {
  await goAdmin(page); // Check the default without selecting a tool or scrolling first.
  const chooser = page.locator('#adminTool');
  const picker = page.locator('#resultMatch');
  await expect(chooser).toBeVisible();
  await expect(chooser).toHaveValue('scorecards');
  await expect(picker.locator(`option[value="${squad.matchId}"]`)).toHaveCount(1);
  await expect(picker).toHaveValue('');
  await expect(picker).toBeVisible();
  await expect(picker).toBeInViewport({ ratio: 1 });
  for (const selector of ['#membershipManagement', '#matchPlanForm', '#texasScrambleForm', '#tournamentCompletionForm',
    '#ruleForm', '#commentarySettingsForm', '#legacyEditionPanel', '#courseForm', '#resultAuditHistory', '#teamCorrectionHistory',
    '#scorecardMore', '#openScoreCorrection', '#holeEditDialog']) await expect(page.locator(selector)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Record Foursomes result' })).toHaveCount(0);
  await expect(page.locator('button[data-edit-hole]:visible')).toHaveCount(0);
  await selectAdminTool(page, 'members');
  await expect(page.locator('#membershipManagement')).toBeVisible();
  await expect(picker).toBeHidden();
  await selectAdminTool(page, 'scorecards');
  await picker.selectOption(squad.matchId);
  const history = page.locator('details#scorecardHistory');
  await showCardTarget(page, history.locator(':scope > summary'), `squad:${squad.id}`);
  await expect(history).toHaveJSProperty('open', false);
  await expect(page.locator('#resultAuditHistory')).toBeHidden();
  await expect(page.locator('#holeEditDialog')).toBeHidden();
}

function expectArchiveSources(archive, f, outcomeMatchId, outcomeSegmentId) {
  expect(archive.edition).toMatchObject({ source_tournament_id: f.organizer.tournamentId, status: 'completed', published: true, cardinal_total: 5, silver_total: 7 });
  const allocation = (source_match_id, source_segment_id, cardinal_points, silver_points) => ({ source_match_id, source_segment_id, cardinal_points, silver_points });
  const expected = [
    ['Blue A', 3, 0], ['Blue B', 2, 0], ['White A', 0, 6], ['White B', 0, 0],
  ].map(([label, blue, white]) => {
    const squad = f.squads.find(s => s.label === label);
    return allocation(squad.matchId, squad.segmentId, blue, white);
  });
  expected.push(allocation(outcomeMatchId, outcomeSegmentId, 0, 1));
  // Compare the complete row list, not a set or edition sum: duplicates and extra rows must fail.
  const actual = archive.results.map(r => allocation(r.source_match_id, r.source_segment_id, r.cardinal_points, r.silver_points));
  expect(actual).toEqual(expected.sort((a, b) => a.source_segment_id.localeCompare(b.source_segment_id)));
}

export async function verifyOrganizerCorrections({ browser, baseURL, signIn, fixture: f }) {
  const o = f.organizer;
  const adminCtx = await browser.newContext({baseURL, viewport:{width:1280,height:800}});
  const playerCtx = await browser.newContext({baseURL, viewport:{width:390,height:844}});
  try {
    const panel = await adminCtx.newPage();
    const playerPage = await playerCtx.newPage();
    const squad=f.squads[0]; const member=squad.players[0];
    const m=await o.newOutcomeMatch();
    const unplayed = await m.snapshot();
    expect(unplayed.match).toMatchObject({ id: m.id, tournament_id: o.tournamentId, status: 'scheduled' });
    expect(unplayed.segment).toMatchObject({ match_id: m.id, entry_mode: 'hole_outcomes', point_value: 1 });
    expect(unplayed.outcomes).toEqual([]);
    await Promise.all([signIn(panel, admin()), signIn(playerPage,member)]);
    await test.step('Admin opens on just the compact scorecard picker on phone and desktop', async () => {
      for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
        const fresh = await adminCtx.newPage();
        await fresh.setViewportSize(viewport);
        await expectCompactScorecards(fresh, squad);
        await fresh.close();
      }
    });
    const staleTab = await adminCtx.newPage();
    const stale = await openPlanner(staleTab, o.tournamentId, unplayed.match);
    await stale.points.fill('2');
    await expect(stale.points).toHaveValue('2');
    await expect(stale.save).toBeEnabled();
    await openOutcome(playerPage,m.id);
    await enterOutcome(playerPage,1,'cardinal');
    await test.step('Admin corrects the posted live outcome, with an attributable audit', async () => {
      const posted = await m.snapshot();
      expect(posted.outcomes).toHaveLength(1);
      const first = posted.outcomes[0];
      expect(first).toMatchObject({ segment_id: unplayed.segment.id, hole_number: 1, winner: 'cardinal', submitted_by: member.id });
      const reason='Organizer verified the opening hole was halved';
      const change = { matchId: m.id, row: first, reason, winner: 'halved' };
      await prepareCorrection(panel, change);
      await saveCorrection(panel, change);
      const db=await m.snapshot();
      expect(['scheduled','live']).toContain(db.segment.status);
      expect(db.match.status).not.toBe('final');
      expect(db.outcomes).toMatchObject([{ id: first.id, segment_id: unplayed.segment.id, winner: 'halved', submitted_by: member.id, submitted_at: first.submitted_at }]);
      expect(db.history.corrections).toMatchObject([{target_id:first.id,target_type:'match_hole_outcome',corrected_by:o.adminId,reason,before_value:{winner:'cardinal'},after_value:{winner:'halved'}}]);
    });
    await test.step('The stale planner refuses a point change; a name-only save preserves the posted row and its history', async () => {
      const before = await m.snapshot();
      expect(before.history.corrections).toHaveLength(1);
      const current = await openPlanner(panel, o.tournamentId, before.match);
      await expect(staleTab.locator('#matchPlanExisting')).toHaveValue(m.id);
      // A live refresh may explicitly lock the previously editable form instead of accepting a click.
      if (await stale.points.isEnabled() && await stale.save.isEnabled()) {
        await expect(stale.points).toHaveValue('2');
        const priorMessage = await stale.message.innerText();
        await stale.save.click();
        await expect(stale.message).not.toHaveText(priorMessage);
      }
      await expectRefusal(stale.message,
        /submitted|posted|recorded|scored|scoring|play (?:has )?(?:started|begun)|structur|point values?|stale|changed since/i,
        /only (?:the )?(?:match )?name|name.only|cannot (?:change|edit|replace)|locked|immutable|read.only|stale|reload|refresh/i);
      expect(await m.snapshot()).toEqual(before);
      await staleTab.close();

      const name = 'Organizer QA singles (renamed)';
      await current.name.fill(name);
      await current.save.click();
      await expect(current.message).toContainText(/saved|updated/i);
      await expect.poll(async () => (await m.snapshot()).match.name).toBe(name);
      const after = await m.snapshot();
      // A successful match-name update may advance its own modification time only.
      expect(after).toEqual({ ...before, match: { ...before.match, name, updated_at: after.match.updated_at } });
    });
    await test.step('The player resumes the corrected hole and Admin corrects the finalized outcome', async () => {
      await playerPage.reload();
      await openOutcome(playerPage,m.id);
      await expect(playerPage.locator('#holeOutcomeRows select').first()).toHaveValue('halved');
      await expect(playerPage.locator('#holeOutcomeRows button[data-edit-hole]')).toHaveCount(0);
      for(let n=2;n<=18;n++) await enterOutcome(playerPage,n,'halved');
      let db=await m.snapshot();
      expect(db.segment).toMatchObject({status:'final',holes_played:18,differential:0});
      expect(db.match.status).toBe('final');
      const last=db.outcomes[17];
      const finalReason='Organizer verified White won the last hole';
      const change = { matchId: m.id, row: last, reason: finalReason, winner: 'silver' };
      await prepareCorrection(panel, change);
      await saveCorrection(panel, change);
      db=await m.snapshot();
      expect(db.outcomes).toHaveLength(18);
      expect(db.outcomes[17]).toMatchObject({id:last.id,winner:'silver',submitted_by:member.id});
      expect(db.segment).toMatchObject({status:'final',holes_played:18,differential:-1,point_value:1});
      const audit=db.history.corrections;
      expect(audit).toHaveLength(2);
      expect(audit[1]).toMatchObject({target_id:last.id,target_type:'match_hole_outcome',corrected_by:o.adminId,reason:finalReason,before_value:{winner:'halved'},after_value:{winner:'silver'}});
    });
    await test.step('Two organizer tabs correct different holes of one final squad without losing either change',async()=>{
      const sibling=await adminCtx.newPage();
      const before=await o.holes(squad.id); expect(before).toHaveLength(18);
      // Exchange the actual contributors: both gross and driver must change on each hole.
      expect(before[0].tee_shot_player_id).not.toBe(before[1].tee_shot_player_id);
      const changes=[0,1].map((i)=>({matchId:squad.matchId,row:before[i],gross:before[i].gross_score+1,driver:before[1-i].tee_shot_player_id,reason:`Signed card check: hole ${i+1}`}));
      await Promise.all([prepareCorrection(panel,changes[0]),prepareCorrection(sibling,changes[1])]);
      await Promise.all([saveCorrection(panel, changes[0]), saveCorrection(sibling, changes[1])]);
      const rows=await o.holes(squad.id);
      expect(rows).toEqual(before.map((row,i)=>i<2 ? {...row,gross_score:changes[i].gross,tee_shot_player_id:changes[i].driver,updated_at:rows[i].updated_at} : row));
      expect((await f.readSquads()).find(s=>s.id===squad.id)).toMatchObject({status:'final',gross_total:72,net_score:69,points:3});
      expect((await f.readSegments()).find(s=>s.id===squad.segmentId)).toMatchObject({status:'final',point_value:3});
      const { corrections: audit }=await o.history([squad.matchId]); expect(audit).toHaveLength(2);
      for(const c of changes) expect(audit.find(a=>a.target_id===c.row.id)).toMatchObject({target_type:'texas_scramble_hole',reason:c.reason,corrected_by:o.adminId,before_value:{gross_score:c.row.gross_score,tee_shot_player_id:c.row.tee_shot_player_id},after_value:{gross_score:c.gross,tee_shot_player_id:c.driver}});
      // A fresh organizer view must show both concurrent edits under the selected match.
      await goAdmin(panel, 'scorecards');
      await panel.locator('#resultMatch').selectOption(squad.matchId);
      for (const change of changes) await expectVisibleHistory(panel, change.reason, `squad:${squad.id}`);
      await sibling.close();
    });
    await playerPage.reload();
    await expect(playerPage.locator('#cupScorePreview strong')).toHaveText(['5','7']);
    expect(await f.readRounds()).toEqual([]);
    await test.step('Publish and replay the disposable archive; a stale organizer form cannot change it',async()=>{
      const staleDialog = await adminCtx.newPage();
      const [row] = await o.holes(squad.id);
      const gross = row.gross_score + 1;
      const reason = 'Signed card check held over completion';
      await prepareCorrection(staleDialog, { matchId: squad.matchId, row, gross, driver: row.tee_shot_player_id, reason });
      const editor = staleDialog.locator('#holeEditDialog');
      const expectHeldDraft = async () => {
        await expect(editor).toBeVisible();
        await expect(editor).toHaveAttribute('data-entry-id', row.id);
        await expect(editor.locator('#holeEditGross')).toHaveValue(String(gross));
        await expect(editor.locator('#holeEditDriver')).toHaveValue(row.tee_shot_player_id);
        await expect(editor.locator('#holeEditReason')).toHaveValue(reason);
      };
      await expectHeldDraft();
      await expect(editor.locator('#holeEditSave')).toBeEnabled();

      await goAdmin(panel, 'completion');
      const complete=async()=>{
        await panel.locator('#completionTournament').selectOption(o.tournamentId);
        await panel.locator('#completionConfirmation').fill('COMPLETE 2027 HEREFORD CUP');
        await submitRpc(panel,'complete_tournament_archive',()=>panel.locator('#tournamentCompletionForm button[type="submit"]').click());
      };
      await complete();
      const publishedState = async () => {
        const [archive, scramble, outcome, squadHistory] = await Promise.all([
          o.archive(), o.lineup(), m.snapshot(), o.history(f.squads.map(s => s.matchId)),
        ]);
        expectArchiveSources(archive, f, m.id, unplayed.segment.id);
        return { archive, scramble, outcome, squadHistory };
      };
      const before = await publishedState();

      // No reload or second preparation: submit the valid draft held in the other tab.
      await expectHeldDraft();
      const refusal = editor.locator('#holeEditFeedback');
      const priorMessage = await refusal.innerText();
      await editor.locator('#holeEditSave').click();
      await expect(refusal).not.toHaveText(priorMessage);
      await expectRefusal(refusal,
        /complet(?:e|ed|ion)|archiv(?:e|ed)|publish(?:ed)?|publication|closed/i,
        /cannot (?:correct|edit|change)|not (?:allowed|permitted)|locked|closed|immutable|read.only/i);
      await expectHeldDraft();
      expect(await publishedState()).toEqual(before);
      await editor.locator('#holeEditCancel').click();
      await expect(editor).toBeHidden();
      await staleDialog.close();
      await expect(panel.locator('#tournamentCompletionForm button[type="submit"]')).toHaveText('Verify completed archive');
      await complete();
      await expect(panel.locator('#completionMessage')).toHaveText('Completed tournament archive verified without changes.');
      expect(await publishedState()).toEqual(before);
    });
    console.log('Organizer QA passed: rename preserved posted holes; live/final corrections through Admin; two simultaneous edits reconciled; published archive replayed unchanged (Blue 5, White 7).');
  } finally { await Promise.all([playerCtx.close(),adminCtx.close()]); }
}
