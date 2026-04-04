const path = require('path');
const { test, expect } = require('@playwright/test');
const { mockInspectionWorkbenchRoutes } = require('../fixtures/inspectionWorkbenchMocks');

const screenshotPath = path.resolve(__dirname, '../../artifacts/pr04-mpr-workbench.png');
const pr08ScreenshotPath = path.resolve(__dirname, '../../artifacts/pr08-project-type-visibility.png');
const pr09ScreenshotPath = path.resolve(__dirname, '../../artifacts/pr09-inspector-modalities-measurements.png');
const pr11ScreenshotPath = path.resolve(__dirname, '../../artifacts/pr11-project-configuration.png');
const pr14ScreenshotPath = path.resolve(__dirname, '../../artifacts/pr14-report-normalization-advanced.png');
const simulatedUsers = ['basic', 'intermediate', 'advanced'];

for (const projectType of ['PT1', 'PT2', 'PT3']) {
  for (const simulatedUser of simulatedUsers) {
    test.describe(`Inspection Workbench E2E (${projectType}) ${simulatedUser}`, () => {
      test(`renders project data workflow for ${projectType} ${simulatedUser}`, async ({ page }) => {
        const { projectId, getWorkspaceStates, getExportBundleArchiveRequests, getIngestValidationRequests } = await mockInspectionWorkbenchRoutes(page, { type: projectType, scenario: simulatedUser });

        await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
        await page.getByRole('tab', { name: 'Project Data' }).click();

        await expect(page.getByRole('heading', { name: 'Project Data' })).toBeVisible();
        await expect(page.getByText(`Inspection workbench for ${projectType} projects.`)).toBeVisible();
        await expect(page.getByTestId('inspector-common-controls')).toBeVisible();
        await page.getByTestId('request-export-bundle-archive').click();
        await expect(page.getByTestId('export-bundle-archive-result')).toContainText('Export archive ready');
        await page.getByTestId('project-data-export-mode').selectOption('report_json');
        await page.getByTestId('run-project-data-export-action').click();
        await expect(page.getByTestId('project-report-result')).toContainText('Report ready');
        if (simulatedUser === 'basic') {
          await expect(page.getByTestId('project-report-normalization-summary')).toHaveCount(0);
        } else {
          await expect(page.getByTestId('project-report-normalization-summary')).toContainText('Metadata normalization');
          await page.getByTestId('normalization-triage-segmentation_runs').click();
          await expect(page.getByTestId('normalization-triage-active')).toContainText(
            'Filtering parts with mixed segmentation_runs values',
          );
          const triageRows = page.locator('[data-testid=\"part-review-state\"]');
          if (await triageRows.count()) {
            await expect(triageRows.first()).toBeVisible();
          } else {
            await expect(page.getByText('No parts found for the current filters.')).toBeVisible();
          }
          await page.getByTestId('normalization-triage-clear').click();
          await expect(page.getByTestId('normalization-triage-active')).toHaveCount(0);
        }
        await page.getByTestId('request-ingest-validation').click();
        await expect(page.getByTestId('ingest-validation-result')).toContainText('Ingest validation complete');
        const measurementCapture = page.locator('.measurement-capture');
        await measurementCapture.getByPlaceholder('label', { exact: true }).fill(`${simulatedUser}-distance`);
        await measurementCapture.getByPlaceholder('value', { exact: true }).fill('12.5');
        await page.getByRole('button', { name: 'Save measurement' }).click();
        await expect(page.getByTestId('manual-measurement-list')).toContainText(`${simulatedUser}-distance: 12.5mm`);
        await page.getByTestId('toggle-image-visibility').click();
        await expect(page.getByTestId('toggle-image-visibility')).toContainText(/Show image|Hide image/);
        const inspectorNavControls = page.getByTestId('inspector-nav-controls');
        await expect(inspectorNavControls).toBeVisible();
        await inspectorNavControls.getByRole('button', { name: 'Zoom +' }).click();
        await inspectorNavControls.getByRole('button', { name: 'Pan →' }).click();
        await expect(page.getByTestId('inspector-viewport-state')).toContainText(/Zoom 1\.10x|Zoom 1\.35x|Zoom 1\.40x/);
        await expect(page.getByTestId('inspector-viewport-state')).toContainText(/Pan \(10, 0\)|Pan \(16, -12\)|Pan \(21, -14\)/);

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
          await page.getByLabel('3D orientation pane').getByRole('button', { name: 'Zoom +' }).click();
          await expect(page.getByText(/Zoom [0-9.]+x/).first()).toBeVisible();
        }

        await expect.poll(() => getWorkspaceStates().length).toBeGreaterThan(0);
        await expect.poll(() => {
          const states = getWorkspaceStates();
          return states[states.length - 1]?.state?.inspector?.viewport_transform || null;
        }).toEqual(expect.objectContaining({
          zoom: expect.any(Number),
          panX: expect.any(Number),
          panY: expect.any(Number),
        }));
        await expect.poll(() => getExportBundleArchiveRequests().length).toBeGreaterThan(0);
        await expect.poll(() => getIngestValidationRequests().length).toBeGreaterThan(0);
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
    await page.getByLabel('3D orientation pane').getByRole('button', { name: 'Zoom +' }).click();

    const panel = page.locator('section[aria-label="Inspection Workbench"]');
    await expect(panel).toBeVisible();
    await panel.screenshot({ path: screenshotPath });
  });
});

test.describe('PR-09 inspector controls screenshot artifact', () => {
  test('captures PT1 modalities + measurements controls screenshot', async ({ page }) => {
    const { projectId } = await mockInspectionWorkbenchRoutes(page, { type: 'PT1', scenario: 'advanced' });
    await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Project Data' }).click();
    await expect(page.getByTestId('inspector-common-controls')).toBeVisible();
    const measurementCapture = page.locator('.measurement-capture');
    await measurementCapture.getByPlaceholder('label', { exact: true }).fill('qa-length');
    await measurementCapture.getByPlaceholder('value', { exact: true }).fill('18.25');
    await page.getByRole('button', { name: 'Save measurement' }).click();
    const panel = page.locator('section[aria-label="Inspection Workbench"]');
    await expect(panel).toBeVisible();
    await panel.screenshot({ path: pr09ScreenshotPath });
  });
});

test.describe('PR-08 project type UI exposure smoke', () => {
  for (const projectType of ['PT1', 'PT2', 'PT3']) {
    test(`dashboard and project detail surfaces show ${projectType}`, async ({ page }) => {
      const projectId = `proj-${projectType.toLowerCase()}-smoke`;

      await page.route('**/api/**', async (route) => {
        const url = route.request().url();
        const method = route.request().method();

        if (url.endsWith('/api/users/me')) {
          await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ detail: 'Unauthorized' }) });
          return;
        }
        if (url.endsWith('/api/projects/') && method === 'GET') {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify([{
              id: projectId,
              name: `${projectType} smoke`,
              description: 'Synthetic smoke project',
              meta_group_id: 'qa-team',
              project_type: projectType,
            }]),
          });
          return;
        }
        if (url.endsWith(`/api/projects/${projectId}`)) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              id: projectId,
              name: `${projectType} smoke`,
              description: 'Synthetic smoke project',
              meta_group_id: 'qa-team',
              project_type: projectType,
            }),
          });
          return;
        }
        if (url.endsWith(`/api/projects/${projectId}/metadata-dict`)) {
          await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
          return;
        }
        if (url.endsWith(`/api/projects/${projectId}/classes`)) {
          await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
          return;
        }
        if (url.endsWith(`/api/projects/${projectId}/has-groups`)) {
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ has_groups: false }) });
          return;
        }
        if (url.includes(`/api/projects/${projectId}/images`)) {
          await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
          return;
        }
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });

      await page.goto('/', { waitUntil: 'networkidle' });
      await expect(page.getByText(`Type: ${projectType}`)).toBeVisible();
      if (projectType === 'PT2') {
        await page.screenshot({ path: pr08ScreenshotPath, fullPage: true });
      }

      await page.getByRole('link', { name: `${projectType} smoke` }).click();
      await expect(page.getByText(`Type: ${projectType}`)).toBeVisible();
    });
  }
});

for (const projectType of ['PT1', 'PT2', 'PT3']) {
  for (const simulatedUser of simulatedUsers) {
    test.describe(`PR-11 project configuration E2E (${projectType}) ${simulatedUser}`, () => {
      test(`saves, edits, and copies configuration for ${projectType} ${simulatedUser}`, async ({ page }) => {
        const { projectId, getSavedConfigurations } = await mockInspectionWorkbenchRoutes(page, {
          type: projectType,
          scenario: simulatedUser,
        });
        const defectLabel = `Escalated ${projectType} ${simulatedUser}`;

        await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
        await page.getByRole('tab', { name: 'Project Configuration' }).click();

        await expect(page.getByRole('heading', { name: 'Project Configuration' })).toBeVisible();
        await expect(page.getByTestId('project-configuration-summary')).toBeVisible();

        await page.getByRole('button', { name: 'Add Defect Type' }).click();
        const newDefectIndex = 2;
        await page.getByLabel(`Defect type name ${newDefectIndex}`).fill(defectLabel);
        await page.getByLabel(`Defect type color ${newDefectIndex}`).fill('#0ea5e9');
        await page.getByLabel(`Defect type definition ${newDefectIndex}`).fill('Synthetic E2E defect type update');

        await page.getByLabel('Default colormap').selectOption(simulatedUser === 'basic' ? 'magma' : 'viridis');
        await page.getByRole('button', { name: 'Save Configuration' }).click();
        await expect(page.getByText('Configuration saved.')).toBeVisible();

        await page.getByLabel('Source project').selectOption('proj-copy');
        await page.getByRole('button', { name: 'Copy from Project' }).click();
        await expect(page.getByText('Configuration copied from existing project.')).toBeVisible();
        await expect(page.getByLabel('Defect type name 1')).toHaveValue(`${simulatedUser}-copied-defect`);

        await expect.poll(() => getSavedConfigurations().length).toBeGreaterThanOrEqual(2);
        await expect.poll(() => getSavedConfigurations().some(
          ({ payload }) => JSON.stringify(payload).includes(defectLabel),
        )).toBeTruthy();
      });
    });
  }
}

test.describe('PR-11 project configuration screenshot artifact', () => {
  test('captures PT3 advanced project configuration screenshot', async ({ page }) => {
    const { projectId } = await mockInspectionWorkbenchRoutes(page, { type: 'PT3', scenario: 'advanced' });
    await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Project Configuration' }).click();
    await expect(page.getByRole('heading', { name: 'Project Configuration' })).toBeVisible();
    await page.getByRole('button', { name: 'Add Defect Type' }).click();
    await page.getByLabel('Defect type name 2').fill('Screenshot Defect');
    const panel = page.locator('section[aria-label="Project Configuration"]');
    await expect(panel).toBeVisible();
    await panel.screenshot({ path: pr11ScreenshotPath });
  });
});

test.describe('PR-14 report normalization screenshot artifact', () => {
  test('captures PT3 advanced report normalization telemetry screenshot', async ({ page }) => {
    const { projectId } = await mockInspectionWorkbenchRoutes(page, { type: 'PT3', scenario: 'advanced' });
    await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Project Data' }).click();
    await page.getByTestId('project-data-export-mode').selectOption('report_json');
    await page.getByTestId('run-project-data-export-action').click();
    await expect(page.getByTestId('project-report-normalization-summary')).toContainText('Metadata normalization');
    const panel = page.locator('section[aria-label="Inspection Workbench"]');
    await expect(panel).toBeVisible();
    await panel.screenshot({ path: pr14ScreenshotPath });
  });
});
