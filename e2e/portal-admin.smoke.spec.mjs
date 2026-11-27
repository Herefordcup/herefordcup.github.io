import { test, expect } from '@playwright/test';
import { selectAdminTool } from './helpers/organizer-score-checks.mjs';

const email = process.env.E2E_USER_EMAIL;
const password = process.env.E2E_USER_PASSWORD;

if (!email?.endsWith('@local.test') || !password) {
  throw new Error('Disposable E2E credentials were not generated.');
}

test('controlled administrator can sign in, update disposable profile data, and open Admin', async ({ page }) => {
  const browserErrors = [];
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(message.text());
  });
  page.on('pageerror', error => browserErrors.push(error.message));

  await page.goto('/portal.html');
  await page.locator('#emailAddress').fill(email);
  await page.locator('#emailPassword').fill(password);
  await page.locator('#emailAuthSubmit').click();

  await expect(page.locator('#dashboardView')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#memberNav button')).toHaveCount(5);
  await expect(page.locator('#playerIdentity')).toContainText('Disposable E2E Admin');
  await expect(page.locator('#homeTeam')).toHaveText('Blue');

  await page.locator('#profileSetupButton').click();
  await expect(page.locator('#profileSetupDialog')).toBeVisible();
  await page.locator('#profileHandicap').fill('10.4');
  await page.locator('#profileSetupForm [type="submit"]').click();
  await expect(page.locator('#profileSetupMessage')).toHaveText('Profile saved.');
  await expect(page.locator('#homeHandicap')).toHaveText('10.4');

  await expect(page.locator('#adminLink')).toHaveAttribute('href', 'admin.html');
  await page.locator('#adminLink').click();
  await expect(page.locator('#adminContent')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('navigation', { name: 'Admin sections' }).getByRole('link')).toHaveCount(4);
  await selectAdminTool(page, 'completion');
  await expect(page.locator('#tournamentCompletionForm')).toBeVisible();
  const completionOption = page.locator('#completionTournament option').filter({ hasText: '2099' });
  await expect(completionOption).toHaveCount(1);
  const completionOptionText = await completionOption.textContent();
  const alreadyCompleted = completionOptionText?.includes('complete') ?? false;
  const tournamentId = await completionOption.getAttribute('value');
  await selectAdminTool(page, 'roster');
  await expect(page.locator('#membershipManagement')).toBeVisible();
  await expect(page.locator('#activeMemberSearch')).toBeVisible();
  if (!alreadyCompleted) {
    await expect(page.locator('#activeMemberCount')).toContainText('2 members');
    await expect(page.locator('#activeMembers [data-member-id]')).toHaveCount(2);
  }
  await selectAdminTool(page, 'completion');
  await page.locator('#completionTournament').selectOption(tournamentId);
  if (!alreadyCompleted) {
    await expect(page.locator('#completionReadiness')).toContainText('All 1 matches are final');
  } else {
    await expect(page.locator('#completionReadiness')).toContainText('already complete');
  }
  await page.locator('#completionConfirmation').fill('COMPLETE 2099 HEREFORD CUP');
  const completionButton = page.locator('#tournamentCompletionForm button[type="submit"]');
  await expect(completionButton).toBeEnabled();
  await completionButton.click();
  await expect(page.locator('#completionMessage')).toHaveText(alreadyCompleted
    ? 'Completed tournament archive verified without changes.'
    : 'Tournament completed and Past Trips published.');
  await expect(completionButton).toHaveText('Verify completed archive');

  await page.locator('#completionConfirmation').fill('COMPLETE 2099 HEREFORD CUP');
  await expect(completionButton).toBeEnabled();
  await completionButton.click();
  await expect(page.locator('#completionMessage')).toHaveText('Completed tournament archive verified without changes.');

  await page.goto('/past-trips.html');
  await page.locator('#legacy-tab-2099').click();
  await expect(page.locator('#legacyDetails')).toContainText('2099');
  await expect(page.locator('#legacyDetails')).toContainText('Round 1 - Singles');
  await expect(page.locator('#legacyDetails')).toContainText('Disposable E2E Admin vs Disposable E2E Opponent');
  await expect(page.locator('#legacyDetails')).toContainText('Blue 1 - White 0');

  expect(browserErrors).toEqual([]);
});
