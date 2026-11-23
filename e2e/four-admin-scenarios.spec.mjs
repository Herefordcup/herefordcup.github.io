import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';

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

async function scoreFromPortal(page, code, fixture, playerIndex) {
  await page.locator('[data-member-view="score"]').click();
  await page.locator('#matchSelect').selectOption(fixture.match);
  await expect(page.locator('#scorecard')).toBeVisible();
  const expectedScores = fixture.expectedScores[String(playerIndex)];
  expect(expectedScores).toHaveLength(18);
  for (let holeNumber = 1; holeNumber <= 18; holeNumber += 1) {
    await page.getByLabel(`Hole ${holeNumber} gross score`).fill(String(expectedScores[holeNumber - 1]));
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
}

async function selectMatch(page, code) {
  await page.locator('#resultMatch').selectOption(manifest.fixtures[code].match);
  await expect(page.locator('#resultSegmentRows [data-segment-id]')).toHaveCount(manifest.fixtures[code].segments.length);
}

async function finalizeSelectedMatch(page, { manual = [] } = {}) {
  for (const result of manual) {
    const card = page.locator(`#resultSegmentRows [data-segment-id="${result.segmentId}"]`);
    await card.locator('[name="differential"]').fill(String(result.differential));
    await card.locator('[name="holesPlayed"]').fill(String(result.holesPlayed));
  }
  const submit = page.locator('#resultFinalizationForm button[type="submit"]');
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
  await expect(page.locator('#membershipManagement')).toBeVisible();

  await expect(page.locator('#legacyEditionPanel')).toBeVisible();
  await expect(page.locator('#legacyResultsPanel')).toBeHidden();
  await page.locator('#legacyResultsTab').click();
  await expect(page.locator('#legacyResultsPanel')).toBeVisible();
  await expect(page.locator('#legacyEditionPanel')).toBeHidden();
  await page.locator('#legacyPhotosTab').click();
  await expect(page.locator('#legacyPhotosPanel')).toBeVisible();
  await page.locator('#legacyEditionTab').click();
  await expect(page.locator('#legacyEditionPanel')).toBeVisible();

  await selectMatch(page, 'R1');
  await expect(page.locator('#resultSegmentRows')).toContainText('Waiting for completed scorecards');
  await expect(page.locator('#resultFinalizationForm button[type="submit"]')).toBeHidden();

  await selectMatch(page, 'R2');
  await expect(page.locator('#resultSegmentRows')).toContainText('matching hole stroke indexes');
  await expect(page.locator('#resultFinalizationForm button[type="submit"]')).toBeHidden();

  await page.locator('#matchTournament').selectOption(manifest.tournaments.rejection);
  const noTeamOption = page.locator(`#segmentRows [data-player-select] option[value="${manifest.admins[3].id}"]`).first();
  await expect(noTeamOption).toBeDisabled();
  await expect(noTeamOption).toContainText('No team');

  await selectMatch(page, 'C1');
  await expect(page.locator('#resultAuditHistory')).toContainText('Result finalized');
  await expect(page.locator('#resultAuditHistory')).toContainText('Completed automatically from verified scorecards.');
  await page.locator('#openScoreCorrection').click();
  await expect(page.locator('#scoreCorrectionDialog')).toBeVisible();
  await page.locator('#correctionRound').selectOption(manifest.fixtures.C1.rounds['0']);
  await page.locator('#correctionHole').fill('18');
  await page.locator('#correctionScore').fill('4');
  await page.locator('#correctionReason').fill('[C1] deterministic QA correction');
  await page.locator('#scoreCorrectionForm button[type="submit"]').click();
  await expect(page.locator('#resultMessage')).toContainText('Score corrected and result recalculated');
  await expect(page.locator('#resultAuditHistory')).toContainText('Result recalculated');
  await expect(page.locator('#resultAuditHistory')).toContainText('[C1] deterministic QA correction');

  const expectedResults = {
    S1: 'Blue wins 1 Up',
    S2: 'White wins 2 & 1',
    F1: 'Match Halved',
    F2: 'White wins 3 & 2',
    C1: 'Blue wins 1 Up',
  };
  for (const code of ['S1', 'S2', 'F1', 'F2', 'C1']) {
    await selectMatch(page, code);
    await expect(page.locator('#resultSegmentRows')).toContainText(expectedResults[code]);
    await expect(page.locator('#resultSegmentRows')).toContainText('Calculated automatically from submitted hole-by-hole scores.');
    await expect(page.locator('#resultFinalizationForm button[type="submit"]')).toBeHidden();
  }

  await selectMatch(page, 'M1');
  await expect(page.locator('#resultSegmentRows')).toContainText('Blue wins 1 Up');
  await expect(page.locator('#resultSegmentRows')).toContainText('requires an administrator-entered match-play result');
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
