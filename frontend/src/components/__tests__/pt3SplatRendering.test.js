import {
  DEFAULT_SPLAT_VIEW_SETTINGS,
  getCanvasSplatStride,
  prepareSplatAssetForRendering,
  resolveSplatCoordinateSpace,
  sortSplatRenderEntriesBackToFront,
} from '../pt3SplatRendering';
import { createPt3PerspectiveProjector } from '../pt3VolumeGeometry';

describe('PT3 splat rendering helpers', () => {
  test('uses visibility-forward 3DGS defaults', () => {
    expect(DEFAULT_SPLAT_VIEW_SETTINGS).toEqual({
      opacity: 1.25,
      pointSize: 1.35,
      contrast: 1.2,
      showSliceGuides: true,
    });
  });

  test('maps generated voxel-coordinate extrema into physical bounds without changing authored scales', () => {
    const scales = new Float32Array([1.5, 3]);
    const splats = {
      positions: new Float32Array([0, 0, 0, 4, 2, 1]),
      scales,
      colors: new Float32Array(8),
      metadata: { coordinate_space: 'voxel' },
    };
    const rendered = prepareSplatAssetForRendering(splats, {
      dimensions: [5, 3, 2],
      spacing: [2, 3, 4],
      origin: [10, 20, 30],
    });

    expect(Array.from(rendered.positions)).toEqual([10, 20, 30, 18, 26, 34]);
    expect(rendered.scales).toBe(scales);
    expect(rendered.metadata).toBe(splats.metadata);
    expect(Array.from(rendered.scales)).toEqual([1.5, 3]);
  });

  test('leaves externally authored physical coordinates and scales untouched', () => {
    const splats = {
      positions: new Float32Array([-42, 7, 3, 900, -2, 0.25]),
      scales: new Float32Array([0.125, 12]),
    };

    expect(prepareSplatAssetForRendering(splats, {
      dimensions: [5, 3, 2],
      spacing: [2, 3, 4],
      origin: [10, 20, 30],
    })).toBe(splats);
  });

  test('lets parsed physical metadata override generated-route and legacy voxel fallbacks', () => {
    expect(resolveSplatCoordinateSpace({
      parsedMetadata: { coordinateSpace: 'world' },
      sourceMetadata: { coordinate_space: 'voxel' },
      assetUrl: '/api/projects/p/parts/x/volume-splat-assets/generated.json',
      legacyPt3SplatAsset: { status: 'ready' },
    })).toBe('physical');
  });

  test('classifies direct internal generated-asset URLs as voxel coordinates', () => {
    expect(resolveSplatCoordinateSpace({
      assetUrl: '/api/projects/p/parts/x/volume-splat-assets/generated.json',
    })).toBe('voxel');
    expect(resolveSplatCoordinateSpace({
      assetUrl: 'https://assets.example/volume-splat-assets/generated.json',
      applicationOrigin: 'https://vista.example',
    })).toBe('physical');
  });

  test('retains the voxel fallback only for ready legacy PT3 splat records', () => {
    expect(resolveSplatCoordinateSpace({ legacyPt3SplatAsset: { status: 'ready' } })).toBe('voxel');
    expect(resolveSplatCoordinateSpace({ legacyPt3SplatAsset: { status: 'pending' } })).toBe('physical');
  });

  test('bounds Canvas2D work with a deterministic stride while preserving small stacks', () => {
    expect(getCanvasSplatStride(720)).toBe(1);
    expect(getCanvasSplatStride(30000)).toBe(1);
    expect(getCanvasSplatStride(30001)).toBe(2);
    expect(Math.ceil(100000 / getCanvasSplatStride(100000))).toBeLessThanOrEqual(30000);
  });

  test('orders translucent Canvas splats far-to-near with stable depth ties', () => {
    const entries = [
      { splatIndex: 3, viewZ: 2 },
      { splatIndex: 1, viewZ: -4 },
      { splatIndex: 2, viewZ: 2 },
    ];
    expect(sortSplatRenderEntriesBackToFront(entries).map(({ splatIndex }) => splatIndex))
      .toEqual([1, 2, 3]);
  });

  test('keeps far-to-near ordering after a mirrored 90-degree orbit', () => {
    const metadata = { dimensions: [5, 3, 2], spacing: [2, 3, 4] };
    const projector = createPt3PerspectiveProjector({
      metadata,
      width: 640,
      height: 480,
      rotation: { x: 0, y: 90 },
      mirrorScale: { x: -1, y: 1, z: 1 },
    });
    const entries = [
      { splatIndex: 0, viewZ: projector([0, 3, 2])[2] },
      { splatIndex: 1, viewZ: projector([8, 3, 2])[2] },
    ];

    sortSplatRenderEntriesBackToFront(entries);
    expect(entries[0].viewZ).toBeLessThan(entries[1].viewZ);
    expect(entries.map(({ splatIndex }) => splatIndex)).toEqual([0, 1]);
  });
});
