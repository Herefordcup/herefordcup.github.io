import { test, expect } from '@playwright/test';

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

  await page.goto('/admin.html');
  await expect(page.locator('#adminContent')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#membershipManagement')).toBeVisible();
  await expect(page.locator('#activeMemberSearch')).toBeVisible();
  await expect(page.locator('#activeMemberCount')).toContainText('1 member');
  await expect(page.locator('#activeMembers [data-member-id]')).toHaveCount(1);

  expect(browserErrors).toEqual([]);
});
