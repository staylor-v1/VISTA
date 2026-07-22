const path = require('path');
const { test, expect } = require('@playwright/test');
const { mockInspectionWorkbenchRoutes } = require('../fixtures/inspectionWorkbenchMocks');

const screenshotPath = path.resolve(__dirname, '../../artifacts/pr04-mpr-workbench.png');
const pr08ScreenshotPath = path.resolve(__dirname, '../../artifacts/pr08-project-type-visibility.png');
const pr09ScreenshotPath = path.resolve(__dirname, '../../artifacts/pr09-inspector-modalities-measurements.png');
const pr11ScreenshotPath = path.resolve(__dirname, '../../artifacts/pr11-project-configuration.png');
const pr14ScreenshotPath = path.resolve(__dirname, '../../artifacts/pr14-report-normalization-advanced.png');
const projectDataLayoutScreenshotPath = path.resolve(__dirname, '../../artifacts/project-data-load-images-layout.png');
const highVolumeUploadScreenshotPath = path.resolve(__dirname, '../../artifacts/high-volume-image-upload-progress.png');
const pt3RealSplatScreenshotPath = path.resolve(__dirname, '../../artifacts/pt3-real-vs-simplified-3dgs.png');
const largeNpyLazyMprScreenshotPath = path.resolve(__dirname, '../../artifacts/large-npy-lazy-mpr.png');
const simulatedUsers = ['basic', 'intermediate', 'advanced'];

function readMultipartJsonFilePart(bodyBuffer, fieldName) {
  const multipartBody = bodyBuffer.toString('utf8');
  const fieldMarker = `name="${fieldName}"`;
  const fieldIndex = multipartBody.indexOf(fieldMarker);
  if (fieldIndex < 0) throw new Error(`Multipart field ${fieldName} was not found`);
  const headerStart = multipartBody.lastIndexOf('\r\n', fieldIndex) + 2;
  const headerEnd = multipartBody.indexOf('\r\n\r\n', fieldIndex);
  const headers = multipartBody.slice(headerStart, headerEnd);
  const valueStart = headerEnd + 4;
  const valueEnd = multipartBody.indexOf('\r\n--', valueStart);
  return {
    headers,
    value: JSON.parse(multipartBody.slice(valueStart, valueEnd)),
  };
}

test.describe('Project Data load images layout', () => {
  test('places Images to Parts before Batches and keeps upload left of compact export', async ({ page }) => {
    const { projectId } = await mockInspectionWorkbenchRoutes(page, { type: 'PT1', scenario: 'basic' });

    await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Project Data' }).click();

    await expect(page.getByRole('tab', { name: 'Load Images', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tab', { name: 'Images to Parts' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Batches' })).toBeVisible();

    const loadImagesTabBox = await page.getByRole('tab', { name: 'Load Images', exact: true }).boundingBox();
    const imagesToPartsTabBox = await page.getByRole('tab', { name: 'Images to Parts' }).boundingBox();
    const batchesTabBox = await page.getByRole('tab', { name: 'Batches' }).boundingBox();
    expect(
      loadImagesTabBox
        && imagesToPartsTabBox
        && batchesTabBox
        && loadImagesTabBox.x < imagesToPartsTabBox.x
        && imagesToPartsTabBox.x < batchesTabBox.x
    ).toBeTruthy();

    await expect(page.getByRole('heading', { name: 'Upload Images' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Filename Regex & Delimiter Decoder' })).toBeVisible();
    await expect(page.getByLabel('Advanced (Regex)')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Export Data' })).toBeVisible();
    const uploadCardBox = await page.locator('.project-data-upload-first .upload-section').boundingBox();
    const exportCardBox = await page.locator('.project-data-upload-first .export-section').boundingBox();
    expect(
      uploadCardBox
        && exportCardBox
        && uploadCardBox.x < exportCardBox.x
        && uploadCardBox.width > exportCardBox.width
    ).toBeTruthy();

    await page.locator('.project-data-tab-panel[aria-label="Load Images"]').screenshot({
      path: projectDataLayoutScreenshotPath,
    });
  });

  test('batches a large local selection with bounded concurrency and refreshes from successes once', async ({ page }) => {
    const { projectId } = await mockInspectionWorkbenchRoutes(page, { type: 'PT1', scenario: 'basic' });
    const batchRequests = [];
    const ingestPayloads = [];
    const imageListUrls = [];
    const summaryUrls = [];
    const legacyUploadRequests = [];
    const pageErrors = [];
    let activeBatchRequests = 0;
    let maximumActiveBatchRequests = 0;
    let releaseDelayedBatches;
    const delayedBatches = new Promise((resolve) => {
      releaseDelayedBatches = resolve;
    });

    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.route(`**/api/projects/${projectId}/data-summary`, async (route) => {
      summaryUrls.push(new URL(route.request().url()).pathname);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          project_id: projectId,
          active_image_count: 2,
          deleted_image_count: 0,
          total_image_bytes: 2,
          part_count: 1,
          image_metadata_fields: 0,
          annotation_count: 0,
          overlay_layer_count: 0,
        }),
      });
    });

    // Registered after the common fixture so this handler can measure the
    // high-volume path while the fixture continues to serve all other APIs.
    await page.route(`**/api/projects/${projectId}/images**`, async (route) => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      if (request.method() === 'GET') {
        imageListUrls.push(`${requestUrl.pathname}${requestUrl.search}`);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: [], total: 0, next_cursor: null, has_more: false }),
        });
        return;
      }
      if (!requestUrl.pathname.endsWith('/images/batch')) {
        legacyUploadRequests.push(requestUrl.pathname);
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'unexpected legacy upload' }) });
        return;
      }

      const manifestPart = readMultipartJsonFilePart(request.postDataBuffer(), 'manifest');
      expect(manifestPart.headers).toContain('filename="manifest.json"');
      expect(manifestPart.headers.toLowerCase()).toContain('content-type: application/json');
      const manifest = manifestPart.value;
      const requestNumber = batchRequests.length;
      batchRequests.push(manifest);
      activeBatchRequests += 1;
      maximumActiveBatchRequests = Math.max(maximumActiveBatchRequests, activeBatchRequests);

      if (requestNumber === 0) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      } else {
        await delayedBatches;
      }

      const failedClientIndex = 204;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          uploaded: manifest
            .filter((entry) => entry.client_index !== failedClientIndex)
            .map((entry) => ({
              client_index: entry.client_index,
              image: { id: `image-${entry.client_index}`, filename: entry.filename },
            })),
          failed: manifest
            .filter((entry) => entry.client_index === failedClientIndex)
            .map((entry) => ({
              client_index: entry.client_index,
              filename: entry.filename,
              code: 'validation_failed',
              detail: 'synthetic corrupt image',
            })),
        }),
      });
      activeBatchRequests -= 1;
    });
    await page.route(`**/api/projects/${projectId}/ingest`, async (route) => {
      ingestPayloads.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          project_id: projectId,
          counters: { parts_received: 204, parts_created: 204 },
          discrepancies: [],
        }),
      });
    });

    await page.goto(`/project/${projectId}?tab=project_data`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('tab', { name: 'Load Images', exact: true })).toHaveAttribute('aria-selected', 'true');
    const initialSummaryRequestCount = summaryUrls.length;
    expect(initialSummaryRequestCount).toBeGreaterThanOrEqual(1);
    expect(imageListUrls).toEqual([]);

    const files = Array.from({ length: 205 }, (_, index) => ({
      name: `D1001_LOT01_SET01_SN${String(index).padStart(4, '0')}_front_visual_false.jpg`,
      mimeType: 'image/jpeg',
      buffer: Buffer.from([index % 251]),
    }));
    await page.locator('#file-input').setInputFiles(files);
    await expect(page.getByText('205 files selected (205 B)')).toBeVisible();
    await expect(page.getByLabel('Delimiter')).toHaveValue('_');
    await expect(page.getByLabel('Keys (comma-separated)')).toHaveValue(
      'design_number, lot_number, set_number, serial_number, side, modality, overlay',
    );

    await page.getByRole('button', { name: 'Upload Images' }).click();
    await expect.poll(() => batchRequests.length).toBe(3);
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Image upload data progress' })).toHaveAttribute('aria-valuenow', '49', { timeout: 8_000 });
    await expect(page.getByText('100 B / 205 B uploaded')).toBeVisible();
    await page.locator('.project-data-upload-first .upload-section').screenshot({
      path: highVolumeUploadScreenshotPath,
    });

    releaseDelayedBatches();
    await expect(page.getByText('Upload complete: 204 succeeded, 1 failed out of 205.')).toBeVisible();
    await expect(page.getByText('1 file selected (1 B)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Upload Images' })).toBeEnabled();
    await expect(page.getByRole('progressbar', { name: 'Image upload data progress' })).toHaveCount(0);

    expect(batchRequests.map((manifest) => manifest.length).sort((left, right) => right - left)).toEqual([100, 100, 5]);
    expect(maximumActiveBatchRequests).toBeLessThanOrEqual(2);
    expect(legacyUploadRequests).toEqual([]);
    await expect.poll(() => ingestPayloads.length).toBe(1);
    const ingestedImageIds = [
      ...(ingestPayloads[0].batches || []).flatMap((batch) => batch.parts || []),
      ...(ingestPayloads[0].unassigned_parts || []),
    ].flatMap((part) => part.metadata?.source_images || []).map((image) => image.image_id);
    expect(ingestedImageIds).toHaveLength(204);
    expect(ingestedImageIds).not.toContain('image-204');

    await expect.poll(() => summaryUrls.length).toBe(initialSummaryRequestCount + 1);
    expect(imageListUrls).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

for (const projectType of ['PT1', 'PT2', 'PT3']) {
  for (const simulatedUser of simulatedUsers) {
    test.describe(`Inspection Workbench E2E (${projectType}) ${simulatedUser}`, () => {
      test(`renders project data workflow for ${projectType} ${simulatedUser}`, async ({ page }) => {
        const { projectId, getWorkspaceStates, getIngestValidationRequests } = await mockInspectionWorkbenchRoutes(page, { type: projectType, scenario: simulatedUser });

        await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
        await page.getByRole('tab', { name: 'Project Data' }).click();

        await expect(page.getByTestId('project-data-summary')).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Load Images', exact: true })).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('tab', { name: 'Batches' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Upload Images' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Data Validation' })).toBeVisible();
        await page.getByRole('tab', { name: 'Project Configuration' }).click();
        await expect(page.getByRole('heading', { name: 'Project Metadata' })).toBeVisible();
        await expect(page.getByTestId('project-metadata-tree')).toContainText('inspection_profile');
        await page.getByRole('tab', { name: 'Project Data' }).click();
        const summaryBox = await page.getByTestId('project-data-summary').boundingBox();
        const tabsBox = await page.getByRole('tab', { name: 'Load Images', exact: true }).boundingBox();
        expect(summaryBox && tabsBox && summaryBox.y < tabsBox.y).toBeTruthy();
        await page.getByTestId('request-ingest-validation').click();
        await expect(page.getByTestId('ingest-validation-result')).toContainText('Ingest validation complete');

        await page.getByRole('tab', { name: 'Inspection' }).click();
        const inspectionPanel = page.locator('section[aria-label="Inspection Workbench"]');
        await expect(inspectionPanel).toBeVisible();
        if (projectType === 'PT3') {
          await expect(page.getByTestId('inspection-layout-grid')).toHaveCount(0);
          await expect(page.getByTestId('mpr-panel')).toBeVisible();
          await expect(page.getByLabel('3D view')).toHaveValue('orientation');
          await expect(page.getByTestId('mpr-pane-3d')).toContainText('3D');
          await expect(page.locator('.mpr-mirror-toggle').first()).toBeVisible();
          await expect.poll(() => getWorkspaceStates().length).toBeGreaterThan(0);
          return;
        }
        await expect(page.getByTestId('inspection-layout-grid')).toBeVisible();
        await expect(inspectionPanel.locator('.flexlayout__tab_button', { hasText: 'Part Summary' }).first()).toBeVisible();
        await expect(inspectionPanel.locator('.flexlayout__tab_button', { hasText: 'Inspection' }).first()).toBeVisible();
        await expect(inspectionPanel.locator('.flexlayout__tab_button', { hasText: 'Image Metadata' }).first()).toBeVisible();
        await expect(inspectionPanel.locator('.flexlayout__tab_button', { hasText: 'Annotations' }).first()).toBeVisible();
        await expect(page.getByLabel('Batch', { exact: true })).toBeVisible();
        await expect(page.getByLabel('Status')).toBeVisible();
        await expect(page.getByLabel('Filter')).toBeVisible();
        await expect(page.getByLabel('Sort')).toBeVisible();

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

        if (simulatedUser !== 'basic') {
          const primaryBatch = simulatedUser === 'intermediate' ? 'batch-mid-a' : 'batch-adv-a';
          const primaryPart = simulatedUser === 'intermediate' ? 'Housing Mid 1' : 'Housing Adv 1';
          await page.getByLabel('Batch', { exact: true }).selectOption(primaryBatch);
          await expect(page.getByRole('heading', { name: primaryPart })).toBeVisible();
        }

        await page.getByRole('button', { name: 'Pass', exact: true }).click();
        const expectedPassedCount = simulatedUser === 'advanced' ? 'Passed: 2' : 'Passed: 1';
        await expect(page.getByText(expectedPassedCount)).toBeVisible();

        await expect(page.getByTestId('selected-image-panel')).toBeVisible();
        if (simulatedUser === 'advanced') {
          const topViewButton = inspectionPanel.getByRole('button', { name: /^TOP\b/ }).first();
          await topViewButton.click();
          await expect(topViewButton).toHaveClass(/selected/);
          const frontViewButton = inspectionPanel.getByRole('button', { name: /^FRONT\b/ }).first();
          await frontViewButton.click();
          await expect(frontViewButton).toHaveClass(/selected/);
        }
        await expect(page.getByTestId('annotation-controls')).toBeVisible();
        await page.getByRole('button', { name: 'Other', exact: true }).click();
        await page.getByLabel('Annotation defect type').selectOption('Other');
        await page.getByPlaceholder('annotation modality').fill('visual');
        await page.getByPlaceholder('annotation comment').fill(`${simulatedUser}-surface-note`);
        await page.getByRole('button', { name: 'Save annotation' }).click();
        await expect(page.getByTestId('annotation-list')).toContainText(`${simulatedUser}-surface-note`);

        await expect.poll(() => getWorkspaceStates().length).toBeGreaterThan(0);
        await expect.poll(() => {
          const states = getWorkspaceStates();
          return states[states.length - 1]?.state?.inspector?.viewport_transform || null;
        }).toEqual(expect.objectContaining({
          zoom: expect.any(Number),
          panX: expect.any(Number),
          panY: expect.any(Number),
        }));
        await expect.poll(() => getIngestValidationRequests().length).toBeGreaterThan(0);
      });
    });
  }
}

test.describe('Inspection Workbench screenshot artifact', () => {
  test('captures PT2 inspection workbench screenshot', async ({ page }) => {
    const { projectId } = await mockInspectionWorkbenchRoutes(page, { type: 'PT2' });

    await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Inspection' }).click();
    await expect(page.getByTestId('inspection-layout-grid')).toBeVisible();

    const panel = page.locator('section[aria-label="Inspection Workbench"]');
    await expect(panel).toBeVisible();
    await panel.screenshot({ path: screenshotPath });
  });
});

test.describe('PT3 Real 3DGS mode', () => {
  test('omits obsolete simplified controls and completes a voxel-native canonical Real 3DGS fit', async ({ page }) => {
    const segmentedPart = {
      id: 'part-adv-001',
      batch_id: 'batch-adv-a',
      serial_number: 'SN-ADV-001',
      display_name: 'Segmented housing',
      review_state: 'in_review',
      metadata: {
        defects: [],
        volume_shape: { axial: 128, coronal: 96, sagittal: 80 },
        spacing: [0.08, 0.08, 0.08],
        pt3_segmentation: {
          segments: [
            { id: 1, label: 'Shell', color: '#f97316' },
            { id: 2, label: 'Core', color: '#38bdf8' },
          ],
        },
      },
    };
    const { projectId, getRealSplatRequests } = await mockInspectionWorkbenchRoutes(page, {
      type: 'PT3',
      scenario: 'advanced',
      mockParts: [segmentedPart],
      realSplatSegmentIds: [1, 1, 2, 2],
    });

    await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Inspection' }).click();
    const viewSelector = page.getByLabel('3D view');
    await expect(viewSelector).toBeVisible();
    await expect(viewSelector.locator('option[value="splat"]')).toHaveCount(0);
    await expect(viewSelector.locator('option[value="real_splat"]')).toHaveText('Real 3DGS');

    await viewSelector.selectOption('real_splat');
    const viewer = page.getByTestId('pt3-gaussian-splat-viewer');
    await expect(viewer).toContainText('Real 3DGS missing');
    await expect(page.getByRole('group', { name: 'Real 3DGS fitting' })).toBeVisible();
    await expect(page.getByLabel('Real 3DGS fitting strategy')).toHaveValue('voxel_direct');
    await expect(page.getByLabel('Real 3DGS splat budget')).toHaveValue('50000');
    await expect(page.getByLabel('Real 3DGS splat budget')).toHaveAttribute('max', '100000');
    const computeButton = page.getByRole('button', { name: 'Fit voxel splats' });
    await expect(computeButton).toBeEnabled();
    await expect(page.getByTestId('splat-config-button')).toHaveCount(0);

    await computeButton.click();
    await expect(viewer).toContainText('37% complete');
    await expect.poll(() => getRealSplatRequests().length).toBe(1);
    expect(getRealSplatRequests()[0]).toEqual(expect.objectContaining({
      fit_mode: 'voxel_direct',
      cameras: [],
      parameters: expect.objectContaining({ max_splats: 50000, sh_degree: 0, optimize_camera_poses: false }),
    }));
    await expect(viewer).toContainText('Voxel splats ready • analytic fit • canonical v1');
    await expect(viewer).toContainText('splats 4');
    await expect(page.getByRole('button', { name: 'Recompute voxel splats' })).toBeEnabled();
    const segmentationControls = page.getByRole('group', { name: 'Segmentation display' });
    await expect(segmentationControls).toContainText('Shell');
    await expect(segmentationControls).toContainText('Core');

    const sceneBox = await page.getByTestId('mpr-pane-3d').locator('.mpr-volume-scene').boundingBox();
    const controlsBox = await page.getByRole('group', { name: 'Real 3DGS fitting' }).boundingBox();
    const segmentationBox = await segmentationControls.boundingBox();
    expect(sceneBox?.width).toBeGreaterThanOrEqual(380);
    expect(sceneBox?.width).toBeLessThanOrEqual(420);
    expect(sceneBox && controlsBox
      && controlsBox.x >= sceneBox.x
      && controlsBox.y >= sceneBox.y
      && controlsBox.x + controlsBox.width <= sceneBox.x + sceneBox.width
      && controlsBox.y + controlsBox.height <= sceneBox.y + sceneBox.height).toBeTruthy();
    expect(sceneBox && segmentationBox
      && segmentationBox.x >= sceneBox.x
      && segmentationBox.y >= sceneBox.y
      && segmentationBox.x + segmentationBox.width <= sceneBox.x + sceneBox.width
      && segmentationBox.y + segmentationBox.height <= sceneBox.y + sceneBox.height).toBeTruthy();
    expect(controlsBox && segmentationBox && (
      controlsBox.x < segmentationBox.x + segmentationBox.width
      && controlsBox.x + controlsBox.width > segmentationBox.x
      && controlsBox.y < segmentationBox.y + segmentationBox.height
      && controlsBox.y + controlsBox.height > segmentationBox.y
    )).toBeFalsy();
    await page.getByTestId('mpr-pane-3d').screenshot({ path: pt3RealSplatScreenshotPath });
  });
});

test.describe('PT3 large NPY lazy MPR loading', () => {
  test('bounds slice requests and keeps a segmented overlay aligned with the base volume', async ({ page }) => {
    const dimensions = { axial: 749, coronal: 1010, sagittal: 984 };
    const baseImageId = 'large-npy-base';
    const overlayImageId = 'large-npy-segments';
    const largeVolumePart = {
      id: 'part-adv-001',
      batch_id: 'batch-adv-a',
      serial_number: 'NIST-749',
      display_name: 'Large NPY segmented part',
      review_state: 'in_review',
      metadata: {
        volume_shape: dimensions,
        overlay_layers: [{ id: 'segments', label: 'Segments', color: '#fb315b' }],
        source_images: [
          {
            filename: 'nist_part.npy',
            image_id: baseImageId,
            overlay: false,
            metadata: { load_mode: 'volume', volume_shape: dimensions, voxel_dtype: 'uint16' },
          },
          {
            filename: 'nist_part_segments.npy',
            image_id: overlayImageId,
            overlay: true,
            overlay_base_image_id: baseImageId,
            overlay_base_filename: 'nist_part.npy',
            metadata: { load_mode: 'volume', volume_shape: dimensions, voxel_dtype: 'uint8' },
          },
        ],
      },
    };
    const images = [
      { id: baseImageId, filename: 'nist_part.npy', metadata: { load_mode: 'volume', volume_shape: dimensions, voxel_dtype: 'uint16' } },
      { id: overlayImageId, filename: 'nist_part_segments.npy', metadata: { load_mode: 'volume', volume_shape: dimensions, voxel_dtype: 'uint8' } },
    ];
    const sliceRequests = [];
    const pageErrors = [];
    const failedRequests = [];
    let inFlightSliceRequests = 0;
    let maxInFlightSliceRequests = 0;
    let sliceRequestDelayMs = 25;

    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('requestfailed', (request) => {
      // React may cancel superseded project-data reads while the inspection tab
      // initializes; those browser aborts are not failed slice loads.
      if (request.failure()?.errorText === 'net::ERR_ABORTED') return;
      failedRequests.push(`${request.method()} ${request.url()}`);
    });

    const { projectId } = await mockInspectionWorkbenchRoutes(page, {
      type: 'PT3',
      scenario: 'advanced',
      mockParts: [largeVolumePart],
      mockBatches: [{ id: 'batch-adv-a', name: 'Batch Adv A' }],
      images,
    });

    await page.route(/\/api\/images\/(large-npy-base|large-npy-segments)\/volume-slice\?/, async (route) => {
      const requestUrl = new URL(route.request().url());
      const imageId = requestUrl.pathname.split('/').at(-2);
      const axis = requestUrl.searchParams.get('axis');
      const index = Number(requestUrl.searchParams.get('index'));
      const imageDimensions = {
        axial: { width: dimensions.sagittal, height: dimensions.coronal },
        coronal: { width: dimensions.sagittal, height: dimensions.axial },
        sagittal: { width: dimensions.coronal, height: dimensions.axial },
      }[axis];
      sliceRequests.push({ imageId, axis, index });
      inFlightSliceRequests += 1;
      maxInFlightSliceRequests = Math.max(maxInFlightSliceRequests, inFlightSliceRequests);
      await new Promise((resolve) => setTimeout(resolve, sliceRequestDelayMs));
      const isOverlay = imageId === overlayImageId;
      const body = isOverlay
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="${imageDimensions.width}" height="${imageDimensions.height}" viewBox="0 0 100 100" preserveAspectRatio="none"><rect x="38" y="38" width="24" height="24" rx="5" fill="#ff1744"/><circle cx="50" cy="50" r="31" fill="none" stroke="#ff4f72" stroke-width="4"/><rect x="14" y="9" width="10" height="8" fill="#ff002f"/></svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="${imageDimensions.width}" height="${imageDimensions.height}" viewBox="0 0 100 100" preserveAspectRatio="none"><rect width="100" height="100" fill="#182332"/><circle cx="50" cy="50" r="31" fill="#aeb8c6"/><path d="M19 50h62M50 19v62" stroke="#566579" stroke-width="2"/><rect x="8" y="5" width="28" height="16" fill="#eef2f7"/><text x="4" y="96" fill="#d9e2ec" font-size="6">${axis} ${index}</text></svg>`;
      await route.fulfill({ status: 200, contentType: 'image/svg+xml', body });
      inFlightSliceRequests -= 1;
    });

    await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Inspection' }).click();

    const mprPanel = page.getByTestId('mpr-panel');
    await expect(mprPanel).toBeVisible();
    await expect(page.getByTestId('mpr-pane-axial')).toBeVisible();
    await expect(page.getByTestId('mpr-pane-coronal')).toBeVisible();
    await expect(page.getByTestId('mpr-pane-sagittal')).toBeVisible();
    await expect(page.getByTestId('mpr-pane-3d')).toContainText('3D');
    await expect(page.locator('#mpr-slice-axial')).toHaveAttribute('max', '748');
    await expect(page.locator('#mpr-slice-coronal')).toHaveAttribute('max', '1009');
    await expect(page.locator('#mpr-slice-sagittal')).toHaveAttribute('max', '983');
    await expect(page.locator('.mpr-slice-canvas[data-slice-load-status="ready"]')).toHaveCount(3);
    await expect.poll(() => inFlightSliceRequests).toBe(0);

    const baseRequestsAfterLoad = sliceRequests.filter((request) => request.imageId === baseImageId);
    const overlayRequests = sliceRequests.filter((request) => request.imageId === overlayImageId);
    expect(baseRequestsAfterLoad.length).toBeGreaterThanOrEqual(3);
    expect(baseRequestsAfterLoad.length).toBeLessThanOrEqual(24);
    expect(baseRequestsAfterLoad.length).toBeLessThan(dimensions.axial / 20);
    expect(overlayRequests.length).toBeGreaterThanOrEqual(3);
    expect(overlayRequests.length).toBeLessThanOrEqual(15);
    expect(maxInFlightSliceRequests).toBeLessThanOrEqual(4);
    for (const axis of ['axial', 'coronal', 'sagittal']) {
      const selectedIndex = Number(await page.locator(`#mpr-slice-${axis}`).inputValue());
      expect(baseRequestsAfterLoad.find((request) => request.axis === axis)?.index).toBe(selectedIndex);
    }

    const annotationList = page.getByTestId('annotation-list');
    await expect(annotationList).toContainText('External: overlay for nist_part.npy');
    await expect(annotationList.getByRole('button', {
      name: 'Hide external overlay overlay for nist_part.npy',
      exact: true,
    })).toBeVisible();
    for (const overlayRequest of overlayRequests) {
      expect(baseRequestsAfterLoad).toContainEqual(expect.objectContaining({
        axis: overlayRequest.axis,
        index: overlayRequest.index,
      }));
    }
    expect(maxInFlightSliceRequests).toBeLessThanOrEqual(4);

    await expect.poll(async () => page.evaluate(() => ['axial', 'coronal', 'sagittal'].every((axis) => {
      const canvas = document.querySelector(`[data-testid="mpr-preview-${axis}"] canvas`);
      const context = canvas?.getContext('2d');
      if (!canvas || !context) return false;
      const center = context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
      return center[0] > center[1] + 35 && center[0] > center[2] + 35;
    }))).toBe(true);

    const canvasEvidence = await page.evaluate(() => {
      const expectedDimensions = {
        axial: { width: 984, height: 1010 },
        coronal: { width: 984, height: 749 },
        sagittal: { width: 1010, height: 749 },
      };
      return Object.entries(expectedDimensions).map(([axis, expected]) => {
        const canvas = document.querySelector(`[data-testid="mpr-preview-${axis}"] canvas`);
        const context = canvas.getContext('2d');
        const center = Array.from(context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data);
        const background = Array.from(context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 10), 1, 1).data);
        return { axis, width: canvas.width, height: canvas.height, expected, center, background };
      });
    });
    for (const evidence of canvasEvidence) {
      expect({ width: evidence.width, height: evidence.height }).toEqual(evidence.expected);
      expect(evidence.center[0]).toBeGreaterThan(evidence.center[1] + 35);
      expect(evidence.center[0]).toBeGreaterThan(evidence.center[2] + 35);
      expect(evidence.background[3]).toBe(255);
      expect(Math.abs(evidence.background[0] - evidence.background[1])).toBeLessThan(20);
    }

    const orientationEvidence = await page.evaluate(() => (
      ['axial', 'coronal', 'sagittal'].map((axis) => {
        const canvas = document.querySelector(`[data-testid="mpr-preview-${axis}"] canvas`);
        const context = canvas.getContext('2d');
        const pixel = (xFraction, yFraction) => Array.from(context.getImageData(
          Math.floor(canvas.width * xFraction),
          Math.floor(canvas.height * yFraction),
          1,
          1,
        ).data);
        return {
          axis,
          sourceTopMarker: pixel(0.19, 0.13),
          legacyBottomMarker: pixel(0.19, 0.87),
          sourceTopBaseEdge: pixel(0.10, 0.10),
          legacyBottomBaseEdge: pixel(0.10, 0.90),
        };
      })
    ));
    const isRed = (pixel) => pixel[0] > pixel[1] + 55 && pixel[0] > pixel[2] + 55;
    const isBrightNeutral = (pixel) => (
      pixel[0] > 180
      && Math.abs(pixel[0] - pixel[1]) < 35
      && Math.abs(pixel[0] - pixel[2]) < 35
    );
    for (const evidence of orientationEvidence) {
      if (evidence.axis === 'axial') {
        expect(isRed(evidence.sourceTopMarker)).toBe(true);
        expect(isRed(evidence.legacyBottomMarker)).toBe(false);
        expect(isBrightNeutral(evidence.sourceTopBaseEdge)).toBe(true);
      } else {
        expect(isRed(evidence.sourceTopMarker)).toBe(false);
        expect(isRed(evidence.legacyBottomMarker)).toBe(true);
        expect(isBrightNeutral(evidence.legacyBottomBaseEdge)).toBe(true);
      }
    }

    const requestsBeforeRapidScrub = sliceRequests.length;
    // Model the slow cold-slice path that originally exposed the backlog:
    // only the latest queued generation should survive while four requests run.
    sliceRequestDelayMs = 1000;
    const axialSlider = page.locator('#mpr-slice-axial');
    await axialSlider.evaluate(async (slider) => {
      const setNativeValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      ).set;
      for (let offset = 0; offset < 100; offset += 1) {
        setNativeValue.call(slider, String(200 + offset));
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    // The rapid loop can outlive the original DOM node when React commits a
    // slice update. Finish through Playwright's current locator so the final
    // generation always targets the mounted slider.
    await axialSlider.fill('299');
    await expect(axialSlider).toHaveValue('299');
    await expect(page.getByTestId('mpr-pane-axial').locator('[data-slice-load-status="ready"]')).toHaveCount(1);
    await expect.poll(() => inFlightSliceRequests, { timeout: 20_000 }).toBe(0);
    const rapidScrubRequests = sliceRequests.slice(requestsBeforeRapidScrub);
    expect(rapidScrubRequests.length).toBeGreaterThanOrEqual(2);
    expect(rapidScrubRequests.length).toBeLessThanOrEqual(20);
    expect(rapidScrubRequests.some((request) => request.axis === 'axial' && request.index === 299)).toBe(true);
    expect(maxInFlightSliceRequests).toBeLessThanOrEqual(4);

    await mprPanel.screenshot({ path: largeNpyLazyMprScreenshotPath });
    expect(pageErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
    await expect(page.locator('.error-message:visible')).toHaveCount(0);
  });
});

test.describe('PR-09 annotation controls screenshot artifact', () => {
  test('captures PT1 annotation controls screenshot', async ({ page }) => {
    const { projectId } = await mockInspectionWorkbenchRoutes(page, { type: 'PT1', scenario: 'advanced' });
    await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Inspection' }).click();
    await expect(page.getByTestId('annotation-controls')).toBeVisible();
    await page.getByRole('button', { name: 'Other', exact: true }).click();
    await page.getByLabel('Annotation defect type').selectOption('Other');
    await page.getByPlaceholder('annotation comment').fill('qa-length review note');
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
        await expect(page.getByText(/Configuration copied from/)).toBeVisible();
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

test.describe('Project Data metadata hierarchy screenshot artifact', () => {
  test('captures PT3 advanced project metadata hierarchy screenshot', async ({ page }) => {
    const { projectId } = await mockInspectionWorkbenchRoutes(page, { type: 'PT3', scenario: 'advanced' });
    await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Project Configuration' }).click();
    await expect(page.getByTestId('project-metadata-tree')).toContainText('inspection_profile');
    const panel = page.locator('.metadata-section');
    await expect(panel).toBeVisible();
    await panel.screenshot({ path: pr14ScreenshotPath });
  });
});
