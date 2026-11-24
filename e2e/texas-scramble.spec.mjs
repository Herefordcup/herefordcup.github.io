import { expect, test } from '@playwright/test';
import { seedScramble } from '../scripts/e2e/texas-browser-fixture.mjs';

test.describe.configure({ retries: 0 }); // Stateful; rerun in a fresh disposable database.
const play = '#memberNav [data-member-view="score"]';
const rows = '#teamScorecardRows .team-hole-row';
const blocks = [[1, 4], [5, 8], [9, 12], [13, 18]];

async function signIn(page, player) {
  await page.goto('/portal.html');
  await page.locator('#emailAddress').fill(player.email);
  await page.locator('#emailPassword').fill(process.env.E2E_USER_PASSWORD);
  await page.locator('#emailAuthSubmit').click();
  await expect(page.locator('#playerIdentity')).toHaveText(player.name, { timeout: 20000 });
  await expect(page.locator('#dashboardView')).toBeVisible();
}

async function locked(row, strokes, contributorId) {
  await expect(row.getByRole('button', { name: 'Locked' })).toBeDisabled();
  await expect(row.locator('input')).toBeDisabled();
  await expect(row.locator('input')).toHaveValue(String(strokes));
  await expect(row.locator('select')).toBeDisabled();
  await expect(row.locator('select')).toHaveValue(contributorId);
}

// The only source of hole scores is the ordinary player's Save hole button.
test('Texas Scramble: four shared cards, teammate resume and final Cup points', { tag: '@scramble' }, async ({ browser, baseURL }) => {
  test.setTimeout(300000);
  const f = await seedScramble();
  const pageErrors = [];
  const wrongModeControls = [];
  for (const [si, squad] of f.squads.entries()) {
    for (const [pi, player] of squad.players.entries()) {
      await test.step(`${player.name}: resume and score assigned holes`, async () => {
        const ctx = await browser.newContext({ baseURL, viewport: pi === 1 ? { width: 390, height: 844 } : { width: 1280, height: 800 } });
        try {
          const page = await ctx.newPage();
          page.on('pageerror', error => pageErrors.push(error.message));
          await signIn(page, player);
          await page.locator(play).click();
          await expect(page.locator('#matchSelect')).toHaveValue(squad.matchId);
          await expect(page.locator('#assignmentSummary')).toContainText(squad.label);
          await expect(page.locator('#assignmentSummary')).toContainText('3 selected tee shots');
          if (si === 0 && pi === 0) {
            await expect(page.locator('#courseSelect')).toBeEnabled();
            await page.locator('#courseSelect').selectOption(f.courseId);
            await page.locator('#teeSelect').selectOption(f.teeId);
          }
          await expect(page.locator('#courseSelect')).toHaveValue(f.courseId);
          await expect(page.locator('#teeSelect')).toHaveValue(f.teeId);
          await expect(page.locator('#courseSelect')).toBeDisabled();
          await expect(page.locator('#teeSelect')).toBeDisabled();
          await expect(page.locator('#teamScorecard')).toBeVisible();
          if (si === 0 && pi < 2) {
            for (const id of ['holeOutcomeScorecard', 'saveRound']) {
              if (await page.locator(`#${id}`).isVisible()) wrongModeControls.push(`${pi ? 'phone' : 'desktop'}: ${id}`);
            }
          }
          const card = page.locator(rows);
          await expect(card).toHaveCount(18);
          const [first, last] = blocks[pi];
          await expect(page.locator('#holesCompleted')).toHaveText(String(first - 1));
          if (pi > 0) {
            // New browser context, different player: read the previous submitter's actual persisted values.
            const prior = first - 1;
            await locked(card.nth(prior - 1), squad.scores[prior - 1], squad.players[(prior - 1) % 4].id);
          } else {
            await expect(card.first().locator('input')).toHaveValue('');
            await expect(card.getByRole('button', { name: 'Locked' })).toHaveCount(0);
          }
          const options = await card.nth(first - 1).locator('select option').evaluateAll(nodes => nodes.map(n => n.value).filter(Boolean).sort());
          expect(options).toEqual(squad.players.map(p => p.id).sort());
          for (let hole = first; hole <= last; hole++) {
            const row = card.nth(hole - 1);
            const driver = squad.players[(hole - 1) % 4];
            const strokes = squad.scores[hole - 1];
            await expect(row.locator('.hole-id')).toHaveText(String(hole));
            await row.getByRole('spinbutton').fill(String(strokes));
            await row.getByRole('combobox').selectOption(driver.id);
            await row.getByRole('button', { name: 'Save hole' }).click();
            await locked(row, strokes, driver.id);
            if (si === 0 && hole === 1) {
              expect(await f.readHoles()).toEqual([{ squad_id: squad.id, hole_number: 1, gross_score: strokes, tee_shot_player_id: driver.id, submitted_by: player.id }]);
            }
          }
          await expect(page.locator('#holesCompleted')).toHaveText(String(last));
          if (last === 18) {
            await expect(page.locator('#teeShotProgress .is-complete')).toHaveCount(4);
            await expect(page.locator('#grossTotal')).toHaveText(String(squad.gross));
            await expect(page.locator('#netTotal')).toHaveText(String(squad.net));
            await expect(page.locator('#toPar')).toHaveText(`${squad.points} pts`);
            expect((await f.readSession()).status).toBe(si === 3 ? 'final' : 'live');
          }
          if (si === 3 && last === 18) {
            await page.reload();
            await expect(page.locator('#dashboardView')).toBeVisible();
            await expect(page.locator('#cupScorePreview strong')).toHaveText(['7', '6']);
          }
        } finally { await ctx.close(); }
      });
    }
  }
  const [holes, savedSquads, segments, session, rounds] = await Promise.all([f.readHoles(), f.readSquads(), f.readSegments(), f.readSession(), f.readRounds()]);
  expect(holes).toHaveLength(72);
  expect(savedSquads).toHaveLength(4);
  expect(segments).toHaveLength(4);
  expect(session).toEqual({ status: 'final', course_id: f.courseId, tee_id: f.teeId });
  expect(rounds).toEqual([]); // A shared card must not create fictitious individual rounds.
  for (const squad of f.squads) {
    const actual = holes.filter(h => h.squad_id === squad.id);
    expect(actual).toEqual(squad.scores.map((gross_score, i) => ({ squad_id: squad.id, hole_number: i + 1, gross_score,
      tee_shot_player_id: squad.players[i % 4].id, submitted_by: squad.players[blocks.findIndex(([a,b]) => a <= i+1 && i+1 <= b)].id })));
    expect(savedSquads.find(s => s.id === squad.id)).toMatchObject({ status: 'final', side: squad.side,
      playing_handicap: 3, par_total: 72, gross_total: squad.gross, net_score: squad.net, points: squad.points });
    expect(segments.find(s => s.id === squad.segmentId)).toMatchObject({ status: 'final', holes_played: 18,
      differential: squad.side === 'cardinal' ? 1 : -1, point_value: squad.points });
  }
  expect(pageErrors).toEqual([]);
  console.log('Verified 16 player logins, 4 independent cards, 72 saved and locked holes, all tee shots and submitters; Blue 7, White 6; 0 individual rounds.');
  // Surface a presentation failure after (not instead of) verifying every persisted scoring result.
  expect(wrongModeControls, 'Only the Texas Scramble entry controls should be visible').toEqual([]);
});
