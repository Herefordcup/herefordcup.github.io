import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { assertDisposableSupabaseUrl } from '../scripts/e2e/safety.mjs';
import { openChangeHistory, openSavedHole, saveHoleEdit, selectAdminTool, showCardTarget } from './helpers/organizer-score-checks.mjs';

const password = process.env.E2E_USER_PASSWORD;
const fixtureFile = process.env.E2E_FIXTURE_FILE;
if (!password || !fixtureFile) throw new Error('Disposable matrix credentials and fixture path are required.');
const manifest = JSON.parse(await readFile(fixtureFile, 'utf8'));

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

async function signIn(browser, adminIndex) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const admin = manifest.admins[adminIndex];
  await page.goto('/portal.html');
  await page.locator('#emailAddress').fill(admin.email);
  await page.locator('#emailPassword').fill(password);
  await page.locator('#emailAuthSubmit').click();
  await expect(page.locator('#dashboardView')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#playerIdentity')).toContainText(admin.name);
  return { context, page, admin };
}

// Independent fixture readback: the key stays in Node; every correction is a real browser click.
async function fixtureRows(table, params) {
  const origin = assertDisposableSupabaseUrl(process.env.E2E_SUPABASE_URL);
  const key = process.env.E2E_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Disposable fixture readback key required.');
  const response = await fetch(`${origin}/rest/v1/${table}?${new URLSearchParams(params)}`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(18_000),
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  expect(response.ok, `${table} fixture readback: HTTP ${response.status}`).toBe(true);
  return response.json();
}

async function correctIndividual(page, fixture, { hole, before, after, reason, play = false }) {
  const roundId = fixture.rounds['0'];
  const actor = manifest.admins[0].id;
  const readScore = () => fixtureRows('scores', { round_id: `eq.${roundId}`, hole_number: `eq.${hole}`, select: 'id,round_id,user_id,hole_number,gross_score' });
  const [rows, matches] = await Promise.all([readScore(), fixtureRows('matches', { id: `eq.${fixture.match}`, tournament_id: `eq.${manifest.tournaments.main}`, select: 'status' })]);
  expect(matches).toEqual([{ status: play ? expect.stringMatching(/^(scheduled|live)$/) : 'final' }]);
  expect(rows).toEqual([{ id: expect.any(String), round_id: roundId, user_id: actor, hole_number: hole, gross_score: before }]);
  const [row] = rows;
  const matchPicker = page.locator(play ? '#matchSelect' : '#resultMatch');
  await expect(matchPicker).toHaveValue(fixture.match);
  const dialog = await openSavedHole(page, row, play ? page.locator('#scorecard') : page);
  const gross = dialog.locator('#holeEditGross');
  await expect(gross).toHaveValue(String(before));
  await gross.fill(String(after));
  await dialog.locator('#holeEditReason').fill(reason);
  await saveHoleEdit(page, row, 'correct_hole_score', play ? '#saveMessage' : '#resultMessage', { round_id: roundId, gross_score: after });
  await expect(matchPicker).toHaveValue(fixture.match);
  const [saved, audit] = await Promise.all([readScore(), fixtureRows('score_correction_audit', { round_id: `eq.${roundId}`,
    select: 'score_id,round_id,user_id,hole_number,action,old_gross_score,new_gross_score,correction_reason,corrected_by' })]);
  expect(saved).toEqual([{ ...row, gross_score: after }]);
  expect(audit).toEqual([{ score_id: row.id, round_id: roundId, user_id: actor, hole_number: hole, action: 'update',
    old_gross_score: before, new_gross_score: after, correction_reason: reason, corrected_by: actor }]);
}

async function scoreFromPortal(page, code, fixture, playerIndex) {
  await page.locator('[data-member-view="score"]').click();
  await page.locator('#matchSelect').selectOption(fixture.match);
  await expect(page.locator('#scorecard')).toBeVisible();
  const expectedScores = fixture.expectedScores[String(playerIndex)];
  expect(expectedScores).toHaveLength(18);
  // Post a real one-stroke error on S1, then correct it before the opponent plays.
  // C1 remains a separate, finalized correction with its original exact audit count.
  const correctInPlay = code === 'S1' && playerIndex === 0;
  const submitted = [...expectedScores];
  if (correctInPlay) submitted[0] += 1;
  for (let holeNumber = 1; holeNumber <= 18; holeNumber += 1) {
    await page.getByLabel(`Hole ${holeNumber} gross score`).fill(String(submitted[holeNumber - 1]));
  }
  await expect(page.locator('#saveRound')).toBeEnabled();
  await page.locator('#saveRound').click();
  const lastAssignedPlayer = Math.max(...Object.keys(fixture.expectedScores).map(Number));
  const completesAutomatically = ['S1', 'S2', 'F1', 'F2', 'C1'].includes(code)
    && playerIndex === lastAssignedPlayer;
  if (completesAutomatically) {
    await expect(page.locator('#saveMessage')).toContainText('Scores saved. Match complete.');
  } else {
    await expect(page.locator('#saveMessage')).toHaveText('Scores saved. Submitted holes are now locked; continue with any remaining holes.');
  }
  await expect(page.locator('#scorecard input[readonly]')).toHaveCount(18);
  if (correctInPlay) {
    await correctIndividual(page, fixture, { hole: 1, before: submitted[0], after: expectedScores[0], reason: '[S1] Signed card verified in Play', play: true });
    await expect(page.getByLabel('Hole 1 gross score', { exact: true })).toHaveValue(String(expectedScores[0]));
    await expect(page.locator('#grossTotal')).toHaveText(String(expectedScores.reduce((total, score) => total + score, 0)));
    await expect(page.locator('#scorecard input[readonly]')).toHaveCount(18);
  } else if (playerIndex !== 0) {
    await expect(page.locator('button[data-edit-hole]')).toHaveCount(0);
  }
}

async function selectMatch(page, code, { inspectFallbacks = true } = {}) {
  const fixture = manifest.fixtures[code];
  await page.locator('#resultMatch').selectOption(fixture.match);
  await expect(page.locator('#resultMatch')).toHaveValue(fixture.match);
  await expect(page.locator(`#resultSegmentRows [data-segment-id="${fixture.segments[0]}"]`)).toHaveCount(1);
  await expect(page.locator('#resultSegmentRows [data-segment-id]')).toHaveCount(fixture.segments.length);
  if (!inspectFallbacks) return;
  const more = page.locator('#scorecardMore');
  // Open the actual disclosure before asserting a Foursomes action is absent;
  // a closed disclosure alone must not make an automatic-only match pass.
  const roundId = Object.values(fixture.rounds)[0];
  const savedHole = page.locator(`button[data-edit-hole][data-round-id="${roundId}"]`).first();
  const controls = more.or(savedHole).filter({ visible: true }).first();
  await showCardTarget(page, controls, `round:${roundId}`);
  if (await more.isVisible() && await more.evaluate(el => el.matches('details:not([open])'))) {
    await more.locator(':scope > summary').click();
    await expect(more).toHaveJSProperty('open', true);
  }
  await expect(page.locator('#resultSegmentRows')).toBeVisible();
}

async function finalizeSelectedMatch(page, { manual = [] } = {}) {
  for (const result of manual) {
    const card = page.locator(`#resultSegmentRows [data-segment-id="${result.segmentId}"]`);
    await card.locator('[name="differential"]').fill(String(result.differential));
    await card.locator('[name="holesPlayed"]').fill(String(result.holesPlayed));
  }
  const submit = page.getByRole('button', { name: 'Record Foursomes result', exact: true });
  await expect(submit).toHaveText('Record Foursomes result');
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.locator('#resultMessage')).toHaveText('Match finalized. Cup points and official statistics are now available.');
}

test('[A1][A2][R1][R2][R3][C1][S1][S2][F1][F2][M1] pre-completion browser matrix', async ({ browser }) => {
  const browserScoredFixtures = Object.entries(manifest.fixtures)
    .filter(([, fixture]) => fixture.browserScored);
  for (let index = 0; index < manifest.admins.length; index += 1) {
    const { context, page, admin } = await signIn(browser, index);
    await expect(page.locator('#homeTeam')).toHaveText(admin.team === 'cardinal' ? 'Blue' : 'White');
    if (index === 0) await expect(page.locator('#adminLink')).toBeVisible();
    else await expect(page.locator('#adminLink')).toBeHidden();

    for (const [code, fixture] of browserScoredFixtures) {
      if (fixture.expectedScores[String(index)]) await scoreFromPortal(page, code, fixture, index);
    }

    if (index === 0) {
      await page.locator('#matchSelect').selectOption(manifest.fixtures.M1.match);
      await expect(page.locator('#emptyScorecard')).toContainText('require a team-score scorecard');
    }
    await context.close();
  }

  const { context, page } = await signIn(browser, 0);
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto('/admin.html');
  await expect(page.locator('#adminContent')).toBeVisible({ timeout: 20_000 });
  await selectAdminTool(page, 'members');
  await expect(page.locator('#membershipManagement')).toBeVisible();

  await selectAdminTool(page, 'legacy');
  await expect(page.locator('#legacyEditionPanel')).toBeVisible();
  await expect(page.locator('#legacyResultsPanel')).toBeHidden();
  await page.locator('#legacyResultsTab').click();
  await expect(page.locator('#legacyResultsPanel')).toBeVisible();
  await expect(page.locator('#legacyEditionPanel')).toBeHidden();
  await page.locator('#legacyPhotosTab').click();
  await expect(page.locator('#legacyPhotosPanel')).toBeVisible();
  await page.locator('#legacyEditionTab').click();
  await expect(page.locator('#legacyEditionPanel')).toBeVisible();

  await selectAdminTool(page, 'scorecards');
  await selectMatch(page, 'R1');
  await expect(page.locator('#resultSegmentRows')).toContainText('Waiting for completed scorecards', { useInnerText: true });
  await expect(page.locator('#resultFinalizationForm button[type="submit"]')).toBeHidden();
  // The missing eighteenth score has no row to edit; the manual fallback is
  // still reachable without filling the hole or weakening R1's later rejection.
  await page.locator('#scorecardMore #openScoreCorrection').click();
  const manual = page.locator('#scoreCorrectionDialog');
  await expect(manual).toBeVisible();
  await manual.locator('#correctionRound').selectOption(manifest.fixtures.R1.rounds['2']);
  await manual.locator('#correctionHole').fill('18');
  await manual.locator('#closeScoreCorrection').click();
  await expect(manual).toBeHidden();

  await selectMatch(page, 'R2');
  await expect(page.locator('#resultSegmentRows')).toContainText('matching hole stroke indexes', { useInnerText: true });
  await expect(page.locator('#resultFinalizationForm button[type="submit"]')).toBeHidden();

  await selectAdminTool(page, 'matches');
  await page.locator('#matchTournament').selectOption(manifest.tournaments.rejection);
  const noTeamOption = page.locator(`#segmentRows [data-player-select] option[value="${manifest.admins[3].id}"]`).first();
  await expect(noTeamOption).toBeDisabled();
  await expect(noTeamOption).toContainText('No team');

  await selectAdminTool(page, 'scorecards');
  await selectMatch(page, 'C1', { inspectFallbacks: false });
  const log = (await openChangeHistory(page, `round:${manifest.fixtures.C1.rounds['0']}`)).locator('#resultAuditHistory');
  await expect(log).toBeVisible();
  await expect(log).toContainText('Result finalized', { useInnerText: true });
  await expect(log).toContainText('Completed automatically from verified scorecards.', { useInnerText: true });
  const reason = '[C1] deterministic QA correction';
  await correctIndividual(page, manifest.fixtures.C1, { hole: 18, before: 5, after: 4, reason });
  await openChangeHistory(page);
  await expect(log).toBeVisible();
  await expect(log).toContainText('Result recalculated', { useInnerText: true });
  await expect(log).toContainText(reason, { useInnerText: true });

  const expectedResults = {
    S1: 'Blue wins 1 Up',
    S2: 'White wins 2 & 1',
    F1: 'Match Halved',
    F2: 'White wins 3 & 2',
    C1: 'Blue wins 1 Up',
  };
  for (const code of ['S1', 'S2', 'F1', 'F2', 'C1']) {
    await selectMatch(page, code);
    await expect(page.locator('#resultSegmentRows')).toContainText(expectedResults[code], { useInnerText: true });
    await expect(page.locator('#resultSegmentRows')).toContainText('Calculated automatically from submitted hole-by-hole scores.', { useInnerText: true });
    await expect(page.locator('#resultFinalizationForm button[type="submit"]')).toBeHidden();
  }

  await selectMatch(page, 'M1');
  await expect(page.locator('#resultSegmentRows')).toContainText('Blue wins 1 Up', { useInnerText: true });
  await expect(page.locator('#resultSegmentRows')).toContainText('requires an administrator-entered match-play result', { useInnerText: true });
  await finalizeSelectedMatch(page, {
    manual: [{
      segmentId: manifest.fixtures.M1.segments[1],
      differential: -3,
      holesPlayed: 7,
    }],
  });

  expect(browserErrors).toEqual([]);
  await context.close();
});

test('[T3][T5] post-completion browser replay and Past Trips rendering', async ({ browser }) => {
  const { context, page } = await signIn(browser, 0);
  await page.goto('/admin.html');
  await expect(page.locator('#adminContent')).toBeVisible({ timeout: 20_000 });
  await selectAdminTool(page, 'completion');
  await page.locator('#completionTournament').selectOption(manifest.tournaments.main);
  await expect(page.locator('#completionReadiness')).toContainText('This tournament is complete.');
  await page.locator('#completionConfirmation').fill('COMPLETE 2027 HEREFORD CUP');
  const completionButton = page.locator('#tournamentCompletionForm button[type="submit"]');
  await expect(completionButton).toBeEnabled();
  await completionButton.click();
  await expect(page.locator('#completionMessage')).toHaveText('Completed tournament archive verified without changes.');

  await page.goto('/past-trips.html');
  await page.locator('#legacy-tab-2027').click();
  await expect(page.locator('#legacyDetails')).toContainText('Round');
  await expect(page.locator('#legacyDetails')).toContainText('1v1');
  await expect(page.locator('#legacyDetails')).toContainText('2v2 Best Ball');
  await expect(page.locator('#legacyDetails')).toContainText('2v2 Foursomes');
  await expect(page.locator('#legacyDetails')).toContainText('Blue 3.5 - White 3.5');
  await context.close();
});
