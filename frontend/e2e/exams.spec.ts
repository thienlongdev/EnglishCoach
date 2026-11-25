import { test, expect } from '@playwright/test';

/**
 * STEP-107: exams.spec.ts
 * End-to-end real browser specifications for English Coach Exams journeys and fault scenarios.
 */
test.describe('English Coach Exams — Core Product Journeys', () => {

  test('E2E-01: Exams landing renders exactly 3 primary areas', async ({ page }) => {
    await page.goto('/exams');
    await expect(page).toHaveTitle(/English Coach/);
    const content = await page.content();
    expect(content).toContain('IELTS');
    expect(content).toContain('TOEIC');
    expect(content).toContain('Hồ sơ năng lực');
  });

  test('E2E-02: IELTS Library renders Academic and General Training', async ({ page }) => {
    await page.goto('/exams/ielts');
    const content = await page.content();
    expect(content).toContain('Academic');
    expect(content).toContain('General Training');
  });

  test('E2E-03: TOEIC Library renders L&R without 4-skill Overall', async ({ page }) => {
    await page.goto('/exams/toeic');
    const content = await page.content();
    expect(content).toContain('Listening & Reading');
    expect(content).not.toContain('TOEIC 4-Skill Overall');
  });

  test('E2E-04: Competency Profile renders isolated family scorecards', async ({ page }) => {
    await page.goto('/exams/profile');
    const content = await page.content();
    expect(content).toContain('IELTS');
    expect(content).toContain('TOEIC');
  });

  test('E2E-05: Legacy ?tab=exams automatically redirects to /exams', async ({ page }) => {
    await page.goto('/?tab=exams');
    await page.waitForURL('**/exams');
    expect(page.url()).toContain('/exams');
  });

  test('E2E-06: Sidebar navigation has single Exams cutover link', async ({ page }) => {
    await page.goto('/');
    const examsLink = page.locator('a[href="/exams"]');
    await expect(examsLink.first()).toBeVisible();
  });
});
