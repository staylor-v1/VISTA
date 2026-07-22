import {
  buildPt3SliceLocatorGeometry,
  drawPt3SliceLocator,
  layoutPt3SliceLocatorLabels,
  PT3_SLICE_LOCATOR_AXES,
} from '../pt3SliceLocator';

const metadata = {
  dimensions: [300, 550, 200],
  spacing: [0.2, 0.1, 0.4],
  origin: [4, -2, 10],
};

test('builds three colored planes, three intersection axes, and zero-based MPR readouts', () => {
  const geometry = buildPt3SliceLocatorGeometry({
    metadata,
    width: 800,
    height: 600,
    rotation: { x: -22, y: 32 },
    zoom: 1.4,
    mirrorScale: { x: -1, y: 1, z: -1 },
    slicePosition: { axial: 99, coronal: 274, sagittal: 149 },
    activeSliceAxis: 'axial',
  });

  expect(geometry.positions).toEqual({ axial: 99, coronal: 274, sagittal: 149 });
  expect(geometry.readouts).toEqual({
    axial: 'Z 99 / 199',
    coronal: 'Y 274 / 549',
    sagittal: 'X 149 / 299',
  });
  expect(geometry.activePlaneLabel).toBe('XY • Z 99 / 199');
  expect(geometry.planes).toHaveLength(3);
  expect(geometry.planes.find(({ active }) => active)).toMatchObject({
    axis: 'axial',
    color: PT3_SLICE_LOCATOR_AXES.axial.color,
  });
  expect(geometry.intersectionLines.map(({ axis, color }) => [axis, color])).toEqual([
    ['sagittal', '#10b981'],
    ['coronal', '#f59e0b'],
    ['axial', '#3b82f6'],
  ]);
  [...geometry.planes.flatMap(({ points }) => points),
    ...geometry.intersectionLines.flatMap(({ points }) => points),
    geometry.center].forEach((point) => {
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
    expect(Number.isFinite(point.depth)).toBe(true);
  });
});

test('clamps malformed slice and volume inputs to finite degenerate geometry', () => {
  const geometry = buildPt3SliceLocatorGeometry({
    metadata: {
      dimensions: [0, Number.NaN, -20],
      spacing: [0, Number.POSITIVE_INFINITY, -4],
      direction: [Number.NaN],
    },
    width: Number.NaN,
    height: Number.POSITIVE_INFINITY,
    rotation: { x: Number.POSITIVE_INFINITY, y: Number.NEGATIVE_INFINITY },
    zoom: -100,
    mirrorScale: { x: Number.NaN, y: 0, z: -10 },
    slicePosition: { axial: 9000, coronal: -50, sagittal: 'invalid' },
    activeSliceAxis: 'unknown',
  });

  expect(geometry.width).toBe(1);
  expect(geometry.height).toBe(1);
  expect(geometry.metadata.dimensions).toEqual([1, 1, 1]);
  expect(geometry.positions).toEqual({ axial: 0, coronal: 0, sagittal: 0 });
  expect(geometry.activeAxis).toBe('axial');
  expect(geometry.activePlaneLabel).toBe('XY • Z 0 / 0');
  geometry.planes.flatMap(({ points }) => points).forEach((point) => {
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
  });

  expect(buildPt3SliceLocatorGeometry({ metadata: null }).activePlaneLabel).toBe('XY • Z 0 / 0');
});

function expectCollisionFree(labelLayout, width, height) {
  labelLayout.boxes.forEach((box) => {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.left + box.width).toBeLessThanOrEqual(width);
    expect(box.top + box.height).toBeLessThanOrEqual(height);
  });
  labelLayout.boxes.forEach((left, leftIndex) => {
    labelLayout.boxes.slice(leftIndex + 1).forEach((right) => {
      const overlaps = left.left < right.left + right.width
        && left.left + left.width > right.left
        && left.top < right.top + right.height
        && left.top + left.height > right.top;
      expect(overlaps).toBe(false);
    });
  });
}

test.each([
  [280, 180],
  [180, 180],
])('lays out compact %sx%s labels without collisions or excessive scene coverage', (width, height) => {
  const geometry = buildPt3SliceLocatorGeometry({
    metadata,
    width,
    height,
    rotation: { x: -55, y: 122 },
    slicePosition: { axial: 99, coronal: 274, sagittal: 149 },
    activeSliceAxis: 'axial',
  });
  const layout = layoutPt3SliceLocatorLabels(geometry);

  expect(layout.compact).toBe(true);
  expect(layout.boxes.map(({ text }) => text)).toEqual([
    'XY • Z 99',
    'X 149',
    'Y 274',
    'Z 99',
  ]);
  expectCollisionFree(layout, width, height);
  expect(layout.reservedBottom).toBe(34);
  layout.boxes.forEach((box) => {
    expect(box.top + box.height).toBeLessThanOrEqual(height - layout.reservedBottom);
  });
  const coveredArea = layout.boxes.reduce((total, box) => total + box.width * box.height, 0);
  expect(coveredArea / (width * height)).toBeLessThan(0.16);
});

test.each([
  [180, 96],
  [100, 72],
])('omits labels rather than overlapping them in an ultra-short %sx%s canvas', (width, height) => {
  const geometry = buildPt3SliceLocatorGeometry({
    metadata,
    width,
    height,
    rotation: { x: -55, y: 122 },
    slicePosition: { axial: 99, coronal: 274, sagittal: 149 },
    activeSliceAxis: 'coronal',
  });
  const layout = layoutPt3SliceLocatorLabels(geometry);

  expect(layout.boxes[0]).toMatchObject({ kind: 'active', axis: 'coronal' });
  expect(layout.boxes.length).toBeLessThanOrEqual(4);
  expectCollisionFree(layout, width, height);
});

test.each([
  [{ x: 90, y: 90 }, { x: 1, y: 1, z: 1 }],
  [{ x: -90, y: 180 }, { x: -1, y: -1, z: -1 }],
  [{ x: Number.POSITIVE_INFINITY, y: Number.NEGATIVE_INFINITY }, { x: -1, y: 1, z: -1 }],
])('keeps edge-on, mirrored, and non-finite rotations finite and labelable', (rotation, mirrorScale) => {
  const geometry = buildPt3SliceLocatorGeometry({
    metadata,
    width: 640,
    height: 360,
    rotation,
    mirrorScale,
    slicePosition: { axial: 199, coronal: 0, sagittal: 299 },
  });
  const points = [
    ...geometry.planes.flatMap(({ points: planePoints }) => planePoints),
    ...geometry.intersectionLines.flatMap(({ points: linePoints }) => linePoints),
    geometry.center,
  ];
  points.forEach((point) => {
    expect(Number.isFinite(point.x)).toBe(true);
    expect(Number.isFinite(point.y)).toBe(true);
    expect(Number.isFinite(point.depth)).toBe(true);
  });
  expectCollisionFree(layoutPt3SliceLocatorLabels(geometry), 640, 360);
});

test('draws high-contrast outlines, active fill, center marker, and compact labels', () => {
  const ctx = {
    canvas: { width: 800, height: 600 },
    save: jest.fn(),
    restore: jest.fn(),
    beginPath: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    closePath: jest.fn(),
    stroke: jest.fn(),
    fill: jest.fn(),
    arc: jest.fn(),
    fillRect: jest.fn(),
    fillText: jest.fn(),
  };

  const geometry = drawPt3SliceLocator(ctx, {
    metadata,
    width: 800,
    height: 600,
    slicePosition: { axial: 99, coronal: 274, sagittal: 149 },
    activeSliceAxis: 'coronal',
  });

  expect(geometry.activePlaneLabel).toBe('XZ • Y 274 / 549');
  expect(ctx.stroke.mock.calls.length).toBeGreaterThanOrEqual(12);
  expect(ctx.stroke.mock.calls.length % 2).toBe(0);
  expect(ctx.fill).toHaveBeenCalledTimes(3);
  expect(ctx.arc).toHaveBeenCalledTimes(2);
  expect(ctx.fillText.mock.calls.map(([text]) => text)).toEqual([
    'XZ • Y 274 / 549',
    'X 149 / 299',
    'Y 274 / 549',
    'Z 99 / 199',
  ]);
  expect(ctx.save).toHaveBeenCalledTimes(1);
  expect(ctx.restore).toHaveBeenCalledTimes(1);
});
