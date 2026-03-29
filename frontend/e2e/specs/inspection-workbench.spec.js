const path = require('path');
const { test, expect } = require('@playwright/test');
const { mockInspectionWorkbenchRoutes } = require('../fixtures/inspectionWorkbenchMocks');

const screenshotPath = path.resolve(__dirname, '../../artifacts/pr04-mpr-workbench.png');

for (const projectType of ['PT1', 'PT2', 'PT3']) {
  test.describe(`Inspection Workbench E2E (${projectType})`, () => {
    test(`renders project data workflow for ${projectType}`, async ({ page }) => {
      const { projectId } = await mockInspectionWorkbenchRoutes(page, { type: projectType });

      await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
      await page.getByRole('tab', { name: 'Project Data' }).click();

      await expect(page.getByRole('heading', { name: 'Project Data' })).toBeVisible();
      await expect(page.getByText(`Inspection workbench for ${projectType} projects.`)).toBeVisible();
      await expect(page.getByText('Batches: 2')).toBeVisible();
      await expect(page.getByText('Parts: 3')).toBeVisible();

      await page.getByLabel('Defect filter').selectOption('critical_only');
      await expect(page.getByText('Housing Critical')).toBeVisible();

      await page.getByLabel('Batch').selectOption('batch-a');
      await expect(page.getByRole('heading', { name: 'Housing Front' })).toBeVisible();
      await expect(page.getByText('Housing Critical')).toHaveCount(0);

      await page.getByRole('button', { name: /mark pass/i }).click();
      await expect(page.getByText('Passed: 1')).toBeVisible();

      if (projectType === 'PT1') {
        await expect(page.getByText(/Mapped:|No image mapped/).first()).toBeVisible();
      } else {
        await expect(page.getByTestId('mpr-shell')).toBeVisible();
        await expect(page.getByText('3D Orientation')).toBeVisible();
        await expect(page.getByLabel(/Contrast/)).toBeVisible();
        await expect(page.getByTestId('mpr-tooltip-values')).toContainText('Cursor');
        await page.getByRole('button', { name: 'Zoom +' }).click();
        await expect(page.getByText(/Zoom 1.10x/).first()).toBeVisible();
      }
    });
  });
}

test.describe('Inspection Workbench screenshot artifact', () => {
  test('captures PT2 MPR workbench screenshot', async ({ page }) => {
    const { projectId } = await mockInspectionWorkbenchRoutes(page, { type: 'PT2' });

    await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Project Data' }).click();
    await expect(page.getByTestId('mpr-shell')).toBeVisible();
    await page.getByRole('button', { name: 'Zoom +' }).click();

    const panel = page.locator('section[aria-label="Inspection Workbench"]');
    await expect(panel).toBeVisible();
    await panel.screenshot({ path: screenshotPath });
  });
});
