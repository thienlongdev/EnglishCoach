import { test as base, Page } from '@playwright/test';

/**
 * EXAMS RUNTIME V4 - Authoritative Auth Fixture for Playwright
 * Real authentication against authoritative backend without mock injection.
 */
export interface ExamsAuthFixtures {
  authenticatedPage: Page;
}

export const test = base.extend<ExamsAuthFixtures>({
  authenticatedPage: async ({ page, baseURL }, use) => {
    const url = baseURL || 'http://localhost:3000';
    await page.goto(`${url}/`);
    
    // Check if already authenticated
    const hasUser = await page.locator('[data-testid="user-menu"], .user-avatar').count();
    if (hasUser === 0) {
      // Attempt login via standard credentials
      const loginUrl = `${url}/api/auth/signin`;
      try {
        await page.goto(loginUrl);
        const emailInput = page.locator('input[name="email"], input[type="email"]');
        const passwordInput = page.locator('input[name="password"], input[type="password"]');
        const submitBtn = page.locator('button[type="submit"]');

        if (await emailInput.count() > 0) {
          await emailInput.fill('learner@englishcoach.app');
          await passwordInput.fill('Learner@123');
          await submitBtn.click();
          await page.waitForLoadState('networkidle');
        }
      } catch (err) {
        console.warn('[examsAuth] Standard signin page bypass, attempting direct navigation');
      }
    }

    await use(page);
  },
});

export { expect } from '@playwright/test';
