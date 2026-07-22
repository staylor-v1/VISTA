import {
  drawMprOverlaySlice,
  drawServerMprSliceImage,
  getMprOverlayCompositeAlpha,
  getMprSliceCanvasCacheStats,
  getServerVolumePrefetchSources,
  getVolumeOverlayStacks,
  getVolumeSourceImages,
  rememberSliceCanvas,
  resetMprSliceCanvasCacheForTests,
} from '../InspectionWorkbenchPanel';

describe('PT3 volume overlay stack mapping', () => {
  afterEach(() => resetMprSliceCanvasCacheForTests());

  test('does not treat legacy NumPy volumes as regular images before metadata probing', () => {
    const part = {
      id: 'part-1',
      metadata: {
        source_images: [
          { filename: 'scan.npy', image_id: 'stack-base-id', overlay: false, slice_index: 0 },
          {
            filename: 'scan.npy',
            image_id: 'stack-overlay-id',
            overlay: true,
            overlay_base_filename: 'scan.npy',
            overlay_base_image_id: 'stack-base-id',
            slice_index: 0,
          },
        ],
      },
    };
    const projectImageLookup = {
      'stack-base-id': { id: 'stack-base-id', filename: 'scan.npy' },
      'stack-overlay-id': { id: 'stack-overlay-id', filename: 'scan.npy' },
    };

    const baseStack = getVolumeSourceImages(part, projectImageLookup);
    const overlayStacks = getVolumeOverlayStacks(part, projectImageLookup);

    expect(baseStack).toEqual([]);
    expect(overlayStacks).toEqual([]);
  });

  test('represents large npy base and overlay volumes as bounded server-backed descriptors', () => {
    const dimensions = { axial: 749, coronal: 1010, sagittal: 984 };
    const part = {
      id: 'part-large-volume',
      metadata: {
        source_images: [
          {
            filename: 'part.npy',
            image_id: 'large-base-id',
            overlay: false,
            metadata: { load_mode: 'volume', volume_shape: dimensions, channel_count: 1, color_mode: 'scalar' },
          },
          {
            filename: 'part-segments.npy',
            image_id: 'large-overlay-id',
            overlay: true,
            overlay_base_image_id: 'large-base-id',
            metadata: { load_mode: 'volume', volume_shape: dimensions, channel_count: 4, color_mode: 'rgba' },
          },
        ],
      },
    };
    const projectImageLookup = {
      'large-base-id': { id: 'large-base-id', filename: 'part.npy', metadata: { volume_shape: dimensions, channel_count: 1, color_mode: 'scalar' } },
      'large-overlay-id': { id: 'large-overlay-id', filename: 'part-segments.npy', metadata: { volume_shape: dimensions, channel_count: 4, color_mode: 'rgba' } },
    };

    const baseVolume = getVolumeSourceImages(part, projectImageLookup);
    const [overlayVolume] = getVolumeOverlayStacks(part, projectImageLookup);

    expect(Array.isArray(baseVolume)).toBe(false);
    expect(baseVolume).toEqual(expect.objectContaining({
      kind: 'server-volume',
      imageId: 'large-base-id',
      dimensions,
      url: '/api/images/large-base-id/volume-slice?axis=axial&index=374',
    }));
    expect(overlayVolume).toEqual(expect.objectContaining({
      kind: 'server-volume',
      imageId: 'large-overlay-id',
      overlayBaseImageId: 'large-base-id',
      dimensions,
    }));

    const baseSources = getServerVolumePrefetchSources(baseVolume, 'coronal', 505);
    const overlaySources = getServerVolumePrefetchSources(overlayVolume, 'coronal', 505);
    expect(baseSources).toHaveLength(5);
    expect(baseSources.map((source) => source.index)).toEqual([505, 504, 506, 503, 507]);
    expect(overlaySources.map((source) => `${source.axis}:${source.index}`)).toEqual(
      baseSources.map((source) => `${source.axis}:${source.index}`),
    );
    expect(baseSources.every((source) => source.url.startsWith('/api/images/large-base-id/volume-slice?'))).toBe(true);
    expect(overlaySources.every((source) => source.url.startsWith('/api/images/large-overlay-id/volume-slice?'))).toBe(true);
  });

  test.each([
    ['npy', 'application/octet-stream'],
    ['npz', 'application/octet-stream'],
    ['inspiro', 'application/zip'],
    ['tiff', 'image/tiff'],
  ])('uses lazy volume-slice descriptors for %s source and RGBA overlay volumes', (extension, contentType) => {
    const dimensions = { axial: 7, coronal: 5, sagittal: 3 };
    const baseId = `base-${extension}`;
    const overlayId = `overlay-${extension}`;
    const baseFilename = `source.${extension}`;
    const overlayFilename = `segments.${extension}`;
    const part = {
      metadata: {
        source_images: [
          {
            filename: baseFilename,
            image_id: baseId,
            overlay: false,
            content_type: contentType,
            metadata: {
              load_mode: 'volume',
              volume_shape: dimensions,
              channel_count: 1,
              color_mode: 'scalar',
            },
          },
          {
            filename: overlayFilename,
            image_id: overlayId,
            overlay: true,
            overlay_base_image_id: baseId,
            content_type: contentType,
            metadata: {
              load_mode: 'volume',
              volume_shape: dimensions,
              channel_count: 4,
              color_mode: 'rgba',
            },
          },
        ],
      },
    };

    const baseVolume = getVolumeSourceImages(part);
    const [overlayVolume] = getVolumeOverlayStacks(part);

    expect(baseVolume).toEqual(expect.objectContaining({
      kind: 'server-volume',
      imageId: baseId,
      dimensions,
      channelCount: 1,
      colorMode: 'scalar',
    }));
    expect(overlayVolume).toEqual(expect.objectContaining({
      kind: 'server-volume',
      imageId: overlayId,
      dimensions,
      channelCount: 4,
      colorMode: 'rgba',
      overlayBaseImageId: baseId,
    }));
    expect(baseVolume.url).toBe(`/api/images/${baseId}/volume-slice?axis=axial&index=3`);
    expect(overlayVolume.url).toBe(`/api/images/${overlayId}/volume-slice?axis=axial&index=3`);
    expect(baseVolume.url).not.toContain('/content');
    expect(overlayVolume.url).not.toContain('/content');
  });

  test('enforces one global 192 MiB canvas budget across volume caches', () => {
    const firstCache = { key: 'base-volume', sliceCanvases: new Map() };
    const secondCache = { key: 'overlay-volume', sliceCanvases: new Map() };
    const canvasBytes = 1000 * 1000 * 4;

    for (let index = 0; index < 60; index += 1) {
      const cache = index % 2 === 0 ? firstCache : secondCache;
      rememberSliceCanvas(cache, `axial:${index}`, { width: 1000, height: 1000 });
    }

    const stats = getMprSliceCanvasCacheStats();
    expect(stats.maxBytes).toBe(192 * 1024 * 1024);
    expect(stats.bytes).toBeLessThanOrEqual(stats.maxBytes);
    expect(stats.items * canvasBytes).toBe(stats.bytes);
    expect(stats.items).toBe(50);
    expect(firstCache.sliceCanvases.has('axial:0')).toBe(false);
    expect(secondCache.sliceCanvases.has('axial:59')).toBe(true);
  });

  test.each([
    ['axial', false],
    ['coronal', true],
    ['sagittal', true],
  ])('matches legacy vertical orientation for %s server slices', (axis, shouldFlipVertically) => {
    const context = {
      save: jest.fn(),
      translate: jest.fn(),
      scale: jest.fn(),
      drawImage: jest.fn(),
      restore: jest.fn(),
    };
    const image = { marker: 'z-zero-at-source-top' };

    drawServerMprSliceImage(context, image, axis, 120, 80);

    expect(context.save).toHaveBeenCalledTimes(1);
    expect(context.drawImage).toHaveBeenCalledWith(image, 0, 0, 120, 80);
    expect(context.restore).toHaveBeenCalledTimes(1);
    if (shouldFlipVertically) {
      expect(context.translate).toHaveBeenCalledWith(0, 80);
      expect(context.scale).toHaveBeenCalledWith(1, -1);
    } else {
      expect(context.translate).not.toHaveBeenCalled();
      expect(context.scale).not.toHaveBeenCalled();
    }
  });

  test.each([
    ['rgba', 1],
    ['rgb', 0.45],
    ['scalar', 0.45],
    [undefined, 0.45],
  ])('uses %s overlay layout alpha %s without windowing color data', (colorMode, expectedAlpha) => {
    expect(getMprOverlayCompositeAlpha({ colorMode })).toBe(expectedAlpha);
    const observed = {};
    const context = {
      globalAlpha: 0,
      globalCompositeOperation: 'copy',
      save: jest.fn(),
      drawImage: jest.fn(() => {
        observed.alpha = context.globalAlpha;
        observed.operation = context.globalCompositeOperation;
      }),
      restore: jest.fn(),
    };
    const overlayCanvas = { width: 4, height: 3 };

    drawMprOverlaySlice(context, overlayCanvas, { colorMode }, 8, 6);

    expect(context.save).toHaveBeenCalledTimes(1);
    expect(context.drawImage).toHaveBeenCalledWith(overlayCanvas, 0, 0, 8, 6);
    expect(observed).toEqual({ alpha: expectedAlpha, operation: 'source-over' });
    expect(context.restore).toHaveBeenCalledTimes(1);
  });
});
