const path = require('path');
const { test, expect } = require('@playwright/test');
const { mockFullInspectionWorkflowRoutes } = require('../fixtures/fullInspectionWorkflowMocks');

const screenshotPath = path.resolve(__dirname, '../../artifacts/e2e-full-inspection-workflow.png');

async function expectRawImageCount(page, expectedCount) {
  const rawImagesCard = page.locator('article.summary-card').filter({ has: page.getByRole('heading', { name: 'Raw Images' }) });
  await expect(rawImagesCard.locator('p')).toHaveText(String(expectedCount));
}

test.describe('Full inspection workflow end-to-end', () => {
  test('creates project, uploads files, inspects parts, and validates report readiness', async ({ page }) => {
    const {
      projectId,
      getUploadedImages,
      getParts,
      getSavedWorkspaceStates,
      getReportRequests,
    } = await mockFullInspectionWorkflowRoutes(page);

    await page.goto('/', { waitUntil: 'networkidle' });

    await page.getByRole('button', { name: 'Create Your First Project' }).click();
    await page.getByLabel('Project Name *').fill('Workflow E2E Project');
    await page.getByLabel('Description').fill('Workflow coverage for upload, inspection, and reporting');
    await page.getByLabel('Access Group *').fill('qa-team');
    await page.getByLabel('Project Type *').selectOption('PT1');
    await page.getByRole('button', { name: 'Create Project' }).click();

    await expect(page.getByRole('heading', { name: 'Your Projects (1)' })).toBeVisible();
    await page.getByRole('link', { name: 'Workflow E2E Project' }).click();

    await expect(page).toHaveURL(new RegExp(`/project/${projectId}$`));

    await page.getByRole('button', { name: 'Project Data' }).click();
    await expect(page.getByRole('heading', { name: 'Project Data' })).toBeVisible();
    await expectRawImageCount(page, 0);

    const uploads = [
      { name: 'part-a-front.png', mimeType: 'image/png', buffer: Buffer.from('fake-image-a') },
      { name: 'part-a-back.png', mimeType: 'image/png', buffer: Buffer.from('fake-image-b') },
      { name: 'part-b-front.png', mimeType: 'image/png', buffer: Buffer.from('fake-image-c') },
    ];

    await page.locator('#file-input').setInputFiles(uploads);
    await expect(page.getByText('3 files selected')).toBeVisible();
    await page.getByRole('button', { name: 'Upload Images' }).click();

    await expect.poll(() => getUploadedImages().length).toBe(3);
    await expectRawImageCount(page, 3);

    await page.getByRole('button', { name: 'Inspection' }).click();
    await expect(page.getByRole('heading', { name: 'Inspection Workbench' })).toBeVisible();

    await expect(page.getByRole('tab', { name: 'Part Summary' })).toBeVisible();
    const frontImageButton = page.getByRole('button', { name: /^front: housing-e2e-a-front\.png$/ }).first();
    await expect(frontImageButton).toBeVisible();
    await frontImageButton.click();
    await expect(page.getByText('Currently viewing: housing-e2e-a-front.png')).toBeVisible();

    await page.getByRole('button', { name: 'Mark Pass ✓' }).click();
    await expect(page.getByText('Passed: 1')).toBeVisible();
    await expect(page.getByText('Rejected: 0')).toBeVisible();

    await page.locator('article.workbench-part-row', { hasText: 'Housing E2E B' }).click();
    await page.getByRole('button', { name: 'Flag Reject' }).click();

    await expect(page.getByText('Passed: 1')).toBeVisible();
    await expect(page.getByText('Rejected: 1')).toBeVisible();

    const reviewBadges = page.getByTestId('part-review-state');
    await expect(reviewBadges).toContainText(['Pass', 'Reject Pending']);

    await expect.poll(() => getParts().map((part) => part.review_state)).toEqual(['pass', 'reject_pending']);

    await page.getByRole('button', { name: 'Report' }).click();
    await expect(page.getByRole('heading', { name: 'Report' })).toBeVisible();
    await page.getByLabel('Export/report mode').selectOption('report_json');
    await page.getByRole('button', { name: 'Run Export/Report' }).click();

    await expect(page.getByText('Report generated successfully.')).toBeVisible();
    await expect.poll(() => getReportRequests().length).toBe(1);
    await expect.poll(() => getReportRequests()[0]?.summary).toEqual(expect.objectContaining({
      passed: 1,
      reject_pending: 1,
      total_images: 3,
    }));

    await expect.poll(() => getSavedWorkspaceStates().length).toBeGreaterThan(0);

    await page.screenshot({ path: screenshotPath, fullPage: true });
  });
});
