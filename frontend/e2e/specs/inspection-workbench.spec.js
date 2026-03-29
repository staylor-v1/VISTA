const path = require('path');
const { test, expect } = require('@playwright/test');
const { mockInspectionWorkbenchRoutes } = require('../fixtures/inspectionWorkbenchMocks');

const screenshotPath = path.resolve(__dirname, '../../artifacts/pr04-mpr-workbench.png');
const simulatedUsers = ['basic', 'intermediate', 'advanced'];

for (const projectType of ['PT1', 'PT2', 'PT3']) {
  for (const simulatedUser of simulatedUsers) {
    test.describe(`Inspection Workbench E2E (${projectType}) ${simulatedUser}`, () => {
      test(`renders project data workflow for ${projectType} ${simulatedUser}`, async ({ page }) => {
        const { projectId } = await mockInspectionWorkbenchRoutes(page, { type: projectType, scenario: simulatedUser });

        await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
        await page.getByRole('tab', { name: 'Project Data' }).click();

        await expect(page.getByRole('heading', { name: 'Project Data' })).toBeVisible();
        await expect(page.getByText(`Inspection workbench for ${projectType} projects.`)).toBeVisible();

        if (simulatedUser === 'basic') {
          await expect(page.getByText('Batches: 1')).toBeVisible();
          await expect(page.getByText('Parts: 1')).toBeVisible();
        } else if (simulatedUser === 'intermediate') {
          await expect(page.getByText('Batches: 2')).toBeVisible();
          await expect(page.getByText('Parts: 2')).toBeVisible();
        } else {
          await expect(page.getByText('Batches: 2')).toBeVisible();
          await expect(page.getByText('Parts: 3')).toBeVisible();
        }

        await page.getByLabel('Defect filter').selectOption('critical_only');
        if (simulatedUser === 'basic') {
          await expect(page.getByText('No parts found for the current filters.')).toBeVisible();
        } else {
          const primaryPart = simulatedUser === 'intermediate' ? 'Housing Mid 1' : 'Housing Adv 1';
          await expect(page.getByRole('heading', { name: primaryPart })).toBeVisible();
        }

        await page.getByLabel('Defect filter').selectOption('all');
        if (simulatedUser !== 'basic') {
          const primaryBatch = simulatedUser === 'intermediate' ? 'batch-mid-a' : 'batch-adv-a';
          const primaryPart = simulatedUser === 'intermediate' ? 'Housing Mid 1' : 'Housing Adv 1';
          await page.getByLabel('Batch').selectOption(primaryBatch);
          await expect(page.getByRole('heading', { name: primaryPart })).toBeVisible();
        }

        await page.getByRole('button', { name: /mark pass/i }).click();
        const expectedPassedCount = simulatedUser === 'advanced' ? 'Passed: 2' : 'Passed: 1';
        await expect(page.getByText(expectedPassedCount)).toBeVisible();

        if (projectType === 'PT1') {
          await expect(page.getByText(/Mapped:|No image mapped/).first()).toBeVisible();
        } else {
          await expect(page.getByTestId('mpr-shell')).toBeVisible();
          await expect(page.getByText('3D Orientation')).toBeVisible();
          await expect(page.getByLabel(/Contrast/)).toBeVisible();
          await expect(page.getByTestId('mpr-tooltip-values')).toContainText('Cursor');

          if (simulatedUser !== 'basic') {
            await expect(page.getByTestId('segmentation-result')).toContainText('Segmentation completed');
            await expect(page.getByTestId('measurement-result')).toContainText('Measurements completed');
          }

          await page.getByTestId('run-segmentation').click();
          await expect(page.getByTestId('segmentation-result')).toContainText('Segmentation completed');
          await page.getByTestId('run-measurements').click();
          await expect(page.getByTestId('measurement-result')).toContainText('Measurements completed');
          await page.getByRole('button', { name: 'Zoom +' }).click();
          await expect(page.getByText(/Zoom 1.10x/).first()).toBeVisible();
        }
      });
    });
  }
}

test.describe('Inspection Workbench screenshot artifact', () => {
  test('captures PT2 MPR workbench screenshot', async ({ page }) => {
    const { projectId } = await mockInspectionWorkbenchRoutes(page, { type: 'PT2' });

    await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Project Data' }).click();
    await expect(page.getByTestId('mpr-shell')).toBeVisible();
    await page.getByTestId('run-segmentation').click();
    await expect(page.getByTestId('segmentation-result')).toContainText('Segmentation completed');
    await page.getByRole('button', { name: 'Zoom +' }).click();

    const panel = page.locator('section[aria-label="Inspection Workbench"]');
    await expect(panel).toBeVisible();
    await panel.screenshot({ path: screenshotPath });
  });
});
