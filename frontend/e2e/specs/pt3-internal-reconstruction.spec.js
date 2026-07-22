const path = require('path');
const { test, expect } = require('@playwright/test');
const { mockInspectionWorkbenchRoutes } = require('../fixtures/inspectionWorkbenchMocks');

const compositeScreenshotPath = path.resolve(
  __dirname,
  '../../artifacts/pt3-internal-composite.png',
);
const windowBoundaryScreenshotPath = path.resolve(
  __dirname,
  '../../artifacts/pt3-internal-window-boundary.png',
);

function createInternalFeatureDataset(depth = 28) {
  const volumeShape = { axial: depth, coronal: 72, sagittal: 72 };
  const sourceImages = [{
    filename: 'internal-feature-phantom.npy',
    image_id: 'internal-feature-volume',
    load_mode: 'volume',
    volume_shape: volumeShape,
  }];
  const images = [{
    id: 'internal-feature-volume',
    filename: 'internal-feature-phantom.npy',
    size: 72 * 72 * depth,
    metadata: { load_mode: 'volume', volume_shape: volumeShape },
  }];
  const part = {
    id: 'part-adv-001',
    batch_id: 'batch-adv-a',
    serial_number: 'CT-INTERNAL-001',
    display_name: 'Internal feature phantom',
    review_state: 'in_review',
    metadata: {
      modalities: ['ct'],
      volume_shape: volumeShape,
      spacing: [0.1, 0.1, 0.14],
      scalar_range: [0, 255],
      source_images: sourceImages,
    },
  };
  return { images, part };
}

function createInternalFeatureSliceSvg(sliceIndex, depth) {
  const z = depth <= 1 ? 0 : (sliceIndex / (depth - 1)) * 2 - 1;
  const sphereRadius = Math.sqrt(Math.max(0, 1 - z * z)) * 11;
  const sphereCenterX = 36 + Math.sin(sliceIndex * 0.42) * 3;
  const channelOpacity = Math.abs(z) < 0.78 ? 1 : 0;
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72">
      <rect width="72" height="72" fill="#000000"/>
      <circle cx="36" cy="36" r="29" fill="#ececec"/>
      <circle cx="36" cy="36" r="23" fill="#080808"/>
      <circle cx="${sphereCenterX.toFixed(2)}" cy="35" r="${sphereRadius.toFixed(2)}" fill="#777777"/>
      <rect x="17" y="31" width="38" height="7" rx="3.5" fill="#868686" opacity="${channelOpacity}"/>
      <circle cx="28" cy="28" r="3.5" fill="#666666" opacity="${channelOpacity}"/>
      <circle cx="45" cy="43" r="4.5" fill="#8a8a8a" opacity="${channelOpacity}"/>
    </svg>
  `;
}

async function waitForRenderedFrames(page, frameCount = 3) {
  await page.evaluate((count) => new Promise((resolve) => {
    const next = (remaining) => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      window.requestAnimationFrame(() => next(remaining - 1));
    };
    next(count);
  }), frameCount);
}

async function captureWebglSignature(page, canvas) {
  const screenshot = await canvas.screenshot({ animations: 'disabled', omitBackground: true });
  return page.evaluate(async (base64) => {
    const response = await fetch(`data:image/png;base64,${base64}`);
    const bitmap = await createImageBitmap(await response.blob());
    const scratch = document.createElement('canvas');
    scratch.width = bitmap.width;
    scratch.height = bitmap.height;
    const context = scratch.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const width = scratch.width;
    const height = scratch.height;
    const pixels = context.getImageData(0, 0, width, height).data;
    const columns = 64;
    const rows = 40;
    const rgba = [];
    let occupied = 0;
    for (let row = 0; row < rows; row += 1) {
      const y = Math.min(height - 1, Math.floor((row + 0.5) * height / rows));
      for (let column = 0; column < columns; column += 1) {
        const x = Math.min(width - 1, Math.floor((column + 0.5) * width / columns));
        const offset = (y * width + x) * 4;
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        const alpha = pixels[offset + 3];
        rgba.push(red, green, blue, alpha);
        if (Math.max(red, green, blue) > 4) occupied += 1;
      }
    }
    return {
      width,
      height,
      columns,
      rows,
      rgba,
      occupiedFraction: occupied / (columns * rows),
    };
  }, screenshot.toString('base64'));
}

function getSignatureRegionStats(signature, predicate) {
  let samples = 0;
  let occupied = 0;
  let alphaTotal = 0;
  let luminanceTotal = 0;
  const minimumDimension = Math.min(signature.width, signature.height);
  for (let row = 0; row < signature.rows; row += 1) {
    const y = (row + 0.5) / signature.rows;
    for (let column = 0; column < signature.columns; column += 1) {
      const x = (column + 0.5) / signature.columns;
      const radius = Math.hypot(
        (x - 0.47) * signature.width / minimumDimension,
        (y - 0.5) * signature.height / minimumDimension,
      );
      if (!predicate({ x, y, radius })) continue;
      const offset = (row * signature.columns + column) * 4;
      const red = signature.rgba[offset];
      const green = signature.rgba[offset + 1];
      const blue = signature.rgba[offset + 2];
      const alpha = signature.rgba[offset + 3];
      samples += 1;
      if (Math.max(red, green, blue) > 4) occupied += 1;
      alphaTotal += alpha / 255;
      luminanceTotal += (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
    }
  }
  return {
    occupiedFraction: samples > 0 ? occupied / samples : 0,
    meanAlpha: samples > 0 ? alphaTotal / samples : 0,
    meanLuminance: samples > 0 ? luminanceTotal / samples : 0,
  };
}

function getSignatureDifference(left, right) {
  if (left.rgba.length !== right.rgba.length || left.rgba.length === 0) {
    throw new Error('WebGL signatures must contain the same non-empty sample grid');
  }
  let absoluteDelta = 0;
  let materiallyChanged = 0;
  for (let offset = 0; offset < left.rgba.length; offset += 4) {
    let pixelDelta = 0;
    for (let channel = 0; channel < 4; channel += 1) {
      const channelDelta = Math.abs(left.rgba[offset + channel] - right.rgba[offset + channel]);
      absoluteDelta += channelDelta;
      pixelDelta = Math.max(pixelDelta, channelDelta);
    }
    if (pixelDelta >= 8) materiallyChanged += 1;
  }
  return {
    meanChannelDelta: absoluteDelta / left.rgba.length / 255,
    changedFraction: materiallyChanged / (left.rgba.length / 4),
  };
}

function expectVisiblyDistinct(left, right, label, {
  minimumMeanDelta = 0.002,
  minimumChangedFraction = 0.01,
} = {}) {
  const difference = getSignatureDifference(left, right);
  expect(
    difference.meanChannelDelta,
    `${label} mean normalized pixel delta`,
  ).toBeGreaterThan(minimumMeanDelta);
  expect(
    difference.changedFraction,
    `${label} materially changed pixel fraction`,
  ).toBeGreaterThan(minimumChangedFraction);
}

async function resetViewerAncestorsAfterRangeInput(page, viewer) {
  await viewer.evaluate((element) => {
    document.activeElement?.blur();
    element.querySelectorAll('.pt3-ray-march-controls').forEach((controls) => {
      controls.scrollTop = 0;
      controls.scrollLeft = 0;
    });
    let ancestor = element.parentElement;
    while (ancestor) {
      ancestor.scrollTop = 0;
      ancestor.scrollLeft = 0;
      ancestor = ancestor.parentElement;
    }
  });
  await page.evaluate(() => window.scrollTo(0, 0));
}

test.describe('PT3 internal-detail reconstruction', () => {
  test('renders all direct-volume styles and exposes gradient boundary controls', async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 1000 });

    const depth = 28;
    const { images, part } = createInternalFeatureDataset(depth);
    const pageErrors = [];
    const webglConsoleErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && /webgl|shader|glsl|three\.webglprogram/i.test(message.text())) {
        webglConsoleErrors.push(message.text());
      }
    });

    const { projectId } = await mockInspectionWorkbenchRoutes(page, {
      type: 'PT3',
      scenario: 'advanced',
      mockParts: [part],
      mockBatches: [{ id: 'batch-adv-a', name: 'Internal CT phantoms' }],
      images,
    });

    await page.route(/\/api\/images\/internal-feature-volume\/volume-slice\?/, async (route) => {
      const requestUrl = new URL(route.request().url());
      const sliceIndex = Number(requestUrl.searchParams.get('index') || 0);
      await route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        body: createInternalFeatureSliceSvg(sliceIndex, depth),
      });
    });

    await page.goto(`/project/${projectId}`, { waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: 'Inspection' }).click();
    await expect(page.getByTestId('mpr-panel')).toBeVisible();

    await page.getByLabel('3D view').selectOption('volume3d');
    const viewer = page.getByTestId('pt3-gaussian-splat-viewer');
    await expect(viewer).toBeVisible();
    await expect(viewer.locator('.pt3-gaussian-splat-status')).toContainText('three-webgl-raymarch');
    await expect(viewer.locator('.pt3-gaussian-splat-status')).toContainText('slices 12');
    await expect(viewer.getByLabel('Three.js mechanical volume renderer')).toBeVisible();

    await page.getByRole('button', { name: 'Open 3D part view fullscreen' }).click();
    const fullscreen3d = page.getByRole('dialog', { name: '3D reconstruction' });
    const controls = page.getByRole('group', { name: 'Ray-march controls' });
    const styleSelector = page.getByLabel('Ray-march reconstruction style');
    const boundaryToggle = page.getByLabel('Ray-march boundary enhancement');
    const webglCanvas = viewer.getByLabel('Three.js mechanical volume renderer');
    await expect(fullscreen3d).toBeVisible();
    await expect(controls).toBeVisible();
    await page.getByLabel('Ray-march quality profile').selectOption('performance');

    await expect(styleSelector).toHaveValue('composite');
    await expect(page.getByTestId('ray-march-transfer-summary')).toHaveAttribute(
      'data-reconstruction-style',
      'composite',
    );
    await expect(boundaryToggle).toBeEnabled();
    await page.getByLabel('Show slice guides').uncheck();
    await waitForRenderedFrames(page);
    const signatures = {
      composite: await captureWebglSignature(page, webglCanvas),
    };
    await resetViewerAncestorsAfterRangeInput(page, viewer);
    await viewer.screenshot({ path: compositeScreenshotPath });

    for (const style of ['mip', 'xray']) {
      await styleSelector.selectOption(style);
      await expect(page.getByTestId('ray-march-transfer-summary')).toHaveAttribute(
        'data-reconstruction-style',
        style,
      );
      await expect(boundaryToggle).toBeDisabled();
      await expect(viewer.locator('.pt3-gaussian-splat-status')).toContainText('three-webgl-raymarch');
      await waitForRenderedFrames(page, 2);
      signatures[style] = await captureWebglSignature(page, webglCanvas);
    }

    await styleSelector.selectOption('iso');
    await expect(page.getByTestId('ray-march-iso-controls')).toBeVisible();
    await page.getByLabel('Ray-march iso threshold').fill('0.47');
    await page.getByLabel('Ray-march iso width').fill('0.03');
    await expect(boundaryToggle).toBeEnabled();
    await waitForRenderedFrames(page, 2);
    signatures.iso = await captureWebglSignature(page, webglCanvas);

    await styleSelector.selectOption('window');
    await expect(page.getByTestId('ray-march-window-controls')).toBeVisible();
    await page.getByLabel('Ray-march window center').fill('0.46');
    await page.getByLabel('Ray-march window width').fill('0.2');
    await waitForRenderedFrames(page, 3);
    signatures.window = await captureWebglSignature(page, webglCanvas);
    await boundaryToggle.check();
    await page.getByLabel('Ray-march boundary strength').fill('1.2');
    await expect(page.getByLabel('Ray-march boundary strength')).toBeEnabled();
    await expect(page.getByTestId('ray-march-transfer-summary')).toContainText(
      'Boundary enhancement is enabled',
    );
    await waitForRenderedFrames(page, 5);
    signatures.windowBoundary = await captureWebglSignature(page, webglCanvas);

    for (const style of ['composite', 'mip', 'xray', 'iso', 'window', 'windowBoundary']) {
      expect(signatures[style].occupiedFraction, `${style} should draw visible volume pixels`)
        .toBeGreaterThan(0.005);
    }
    expectVisiblyDistinct(signatures.composite, signatures.mip, 'composite versus MIP');
    expectVisiblyDistinct(signatures.mip, signatures.xray, 'MIP versus X-ray');
    expectVisiblyDistinct(signatures.xray, signatures.iso, 'X-ray versus iso');
    expectVisiblyDistinct(signatures.iso, signatures.window, 'iso versus window');
    expectVisiblyDistinct(
      signatures.window,
      signatures.windowBoundary,
      'window boundary enhancement',
      { minimumMeanDelta: 0.0005, minimumChangedFraction: 0.003 },
    );
    const compositeShell = getSignatureRegionStats(
      signatures.composite,
      ({ radius }) => radius >= 0.28 && radius <= 0.43,
    );
    const windowShell = getSignatureRegionStats(
      signatures.window,
      ({ radius }) => radius >= 0.28 && radius <= 0.43,
    );
    const windowInterior = getSignatureRegionStats(
      signatures.window,
      ({ radius }) => radius <= 0.16,
    );
    expect(
      windowShell.meanLuminance,
      'Window should suppress the phantom dense-shell annulus',
    ).toBeLessThan(compositeShell.meanLuminance * 0.8);
    expect(
      windowInterior.occupiedFraction,
      'Window should retain the known central interior features',
    ).toBeGreaterThan(0.2);
    expect(windowInterior.meanLuminance).toBeGreaterThan(0.03);
    expect(windowInterior.meanLuminance).toBeGreaterThan(windowShell.meanLuminance * 1.5);
    await page.getByRole('button', { name: 'Close fullscreen 3D view' }).click();
    await expect(fullscreen3d).not.toBeVisible();
    await page.getByRole('button', { name: 'Open 3D part view fullscreen' }).click();
    await expect(styleSelector).toHaveValue('window');
    await expect(boundaryToggle).toBeChecked();
    await resetViewerAncestorsAfterRangeInput(page, viewer);
    await viewer.screenshot({ path: windowBoundaryScreenshotPath });

    expect(pageErrors).toEqual([]);
    expect(webglConsoleErrors).toEqual([]);
  });
});
