const path = require('path');
const { test, expect } = require('@playwright/test');
const { mockInspectionWorkbenchRoutes } = require('../fixtures/inspectionWorkbenchMocks');

const stopModalScreenshotPath = path.resolve(__dirname, '../../artifacts/analyze-stop-confirmation.png');

const toolboxPayload = {
  methods: [
    {
      id: 'source.project_part_images',
      name: 'Project Part Image Source',
      category: 'Input',
      description: 'Source',
      input_types: ['any'],
      output_types: ['image'],
      parameters: [{ name: 'example_image_id', label: 'Choose Example', type: 'string', default: '' }],
    },
    {
      id: 'preprocess.window_level_normalization',
      name: 'Window / Level Normalization',
      category: 'Preprocessing',
      description: 'Normalize',
      input_types: ['image'],
      output_types: ['image'],
      parameters: [{ name: 'window', label: 'Window', type: 'float', default: 400 }],
    },
    {
      id: 'segmentation.watershed_seeds',
      name: 'Watershed From Seeds',
      category: 'Segmentation',
      description: 'Segment',
      input_types: ['image'],
      output_types: ['labels'],
      parameters: [{ name: 'seed_spacing_px', label: 'Seed Spacing (px)', type: 'integer', default: 18 }],
    },
    {
      id: 'output.versioned_image_artifact',
      name: 'Recipe / Artifact Output',
      category: 'Output',
      description: 'Output',
      input_types: ['image'],
      output_types: ['metadata'],
      parameters: [{ name: 'mode', label: 'Output Mode', type: 'select', default: 'overlay_artifact', options: ['overlay_artifact'] }],
    },
  ],
};

function analyzeInputPayload(projectId) {
  return {
    project_id: projectId,
    source: { kind: 'project_parts', image_count: 2, part_count: 1 },
    parts: [{ part_id: 'part-1', serial_number: 'SN-1', display_name: 'Part 1', image_count: 2 }],
    images: [
      { image_id: 'img-1', filename: 'slice-001.png', part_id: 'part-1', part_serial_number: 'SN-1' },
      { image_id: 'img-2', filename: 'slice-002.png', part_id: 'part-1', part_serial_number: 'SN-1' },
    ],
  };
}

test('Analyze stop confirmation halts the running request and documents the modal', async ({ page }) => {
  const { projectId } = await mockInspectionWorkbenchRoutes(page, { type: 'PT3', scenario: 'advanced' });
  const stopRequests = [];
  let executeRequestAborted = false;
  page.on('requestfailed', (request) => {
    if (request.url().endsWith(`/api/projects/${projectId}/analyze/workflows/execute`)) {
      executeRequestAborted = true;
    }
  });

  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (url.endsWith('/api/analyze/toolbox')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(toolboxPayload) });
      return;
    }
    if (url.endsWith(`/api/projects/${projectId}/analyze/input-source`)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(analyzeInputPayload(projectId)) });
      return;
    }
    if (url.endsWith(`/api/projects/${projectId}/metadata/vista.analyze.workflow`) && method === 'GET') {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'not found' }) });
      return;
    }
    if (url.endsWith(`/api/projects/${projectId}/metadata/vista.analyze.workflow`) && method === 'PUT') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }
    if (url.endsWith(`/api/projects/${projectId}/analyze/workflows/execute`) && method === 'POST') {
      return new Promise(() => {});
    }
    if (/\/api\/projects\/.*\/analyze\/workflows\/.*\/stop$/.test(url) && method === 'POST') {
      stopRequests.push(url);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ stopped: true }) });
      return;
    }

    await route.fallback();
  });

  await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Analyze' }).click();
  await expect(page.getByRole('heading', { name: 'Pipeline Studio' })).toBeVisible();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText(/Running 2 configured images/)).toBeVisible();

  await page.getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByRole('dialog', { name: /Stop the running process/ })).toBeVisible();
  await page.screenshot({ path: stopModalScreenshotPath, fullPage: true });
  await page.getByRole('button', { name: 'Stop and Ignore Results' }).click();

  await expect(page.getByText(/Analysis stopped/)).toBeVisible();
  await expect.poll(() => stopRequests.length).toBe(1);
  await expect.poll(() => executeRequestAborted).toBe(true);
});
