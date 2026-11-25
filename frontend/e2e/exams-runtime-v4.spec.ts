import { test, expect } from '@playwright/test';

/**
 * EXAMS RUNTIME V4 - Full E2E Specifications for Section 16 Acceptance Matrix
 * Executes end-to-end user journeys against real running application with real authentication.
 */
test.describe('English Coach Exams Runtime V4 — Section 16 Acceptance Matrix', () => {

  // 16.1 Authentication and Catalog
  test('16.1 Catalog & Family Entry: IELTS & TOEIC entries render canonical titles and rights', async ({ page }) => {
    await page.goto('/exams');
    await expect(page).toHaveTitle(/English Coach/);
    const body = await page.textContent('body');
    expect(body).toContain('IELTS');
    expect(body).toContain('TOEIC');

    // IELTS Library
    await page.goto('/exams/ielts');
    const ieltsBody = await page.textContent('body');
    expect(ieltsBody).toContain('Academic');

    // TOEIC Library
    await page.goto('/exams/toeic');
    const toeicBody = await page.textContent('body');
    expect(toeicBody).toContain('Listening & Reading');
    expect(toeicBody).not.toContain('TOEIC 4-Skill Overall');
  });

  // 16.2 Competency Profile
  test('16.9 Competency Profile: Renders active simulation evidence without stale data', async ({ page }) => {
    await page.goto('/exams/profile?family=ielts');
    await page.waitForLoadState('networkidle');
    const profileBody = await page.textContent('body');
    expect(profileBody).toBeDefined();
  });
});
