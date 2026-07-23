import {
  buildPt3SegmentMask,
  buildPt3VectorAnnotationFaces,
  forEachPt3VectorFaceVoxelPolygon,
  getInclusiveVectorSliceRange,
  mapVectorPlanePointToVoxel,
  MAX_VECTOR_AREAS,
  MAX_VECTOR_FACES,
  MAX_VECTOR_MASK_RUNS,
  MAX_VECTOR_PRIMITIVES,
  pt3SegmentMaskContainsPoint,
  pt3SegmentMaskToSvgPath,
  renderPt3VectorAnnotations,
} from '../pt3VectorAnnotations';

const metadata = {
  dimensions: [11, 9, 7],
  spacing: [0.5, 0.75, 2],
  origin: [10, -2, 4],
};

function rectangleAnnotation(overrides = {}) {
  return {
    id: 'segment-a',
    label: 'Segment A',
    color: '#22d3ee',
    visible: true,
    axis: 'axial',
    minSlice: 2,
    maxSlice: 4,
    imageWidth: 11,
    imageHeight: 9,
    areas: [{ tool: 'rectangle', operation: 'add', start: { x: 2, y: 1 }, end: { x: 7, y: 6 } }],
    ...overrides,
  };
}

function makeContext() {
  return {
    canvas: { width: 640, height: 480 },
    beginPath: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    closePath: jest.fn(),
    fill: jest.fn(),
    stroke: jest.fn(),
    setLineDash: jest.fn(),
    save: jest.fn(),
    restore: jest.fn(),
  };
}

function collectFaceVoxelPolygons(face) {
  const polygons = [];
  forEachPt3VectorFaceVoxelPolygon(face, (polygon) => polygons.push(polygon));
  return polygons;
}

function collectSurfaceVoxelPolygons(faces, surface) {
  return faces
    .filter((face) => face.surface === surface)
    .flatMap(collectFaceVoxelPolygons);
}

describe('PT3 vector annotation registration', () => {
  test('maps continuous source-image boundaries onto canonical voxel faces for every MPR plane', () => {
    expect(mapVectorPlanePointToVoxel({
      axis: 'axial',
      point: { x: 0, y: 0 },
      sliceIndex: 3,
      imageWidth: 3,
      imageHeight: 5,
      dimensions: metadata.dimensions,
    })).toEqual([-0.5, -0.5, 3]);
    expect(mapVectorPlanePointToVoxel({
      axis: 'axial',
      point: { x: 3, y: 5 },
      sliceIndex: 3,
      imageWidth: 3,
      imageHeight: 5,
      dimensions: metadata.dimensions,
    })).toEqual([10.5, 8.5, 3]);

    expect(mapVectorPlanePointToVoxel({
      axis: 'coronal',
      point: { x: 0, y: 0 },
      sliceIndex: 2,
      imageWidth: 3,
      imageHeight: 4,
      dimensions: metadata.dimensions,
    })).toEqual([-0.5, 2, 6.5]);
    expect(mapVectorPlanePointToVoxel({
      axis: 'coronal',
      point: { x: 3, y: 4 },
      sliceIndex: 2,
      imageWidth: 3,
      imageHeight: 4,
      dimensions: metadata.dimensions,
    })).toEqual([10.5, 2, -0.5]);

    expect(mapVectorPlanePointToVoxel({
      axis: 'sagittal',
      point: { x: 0, y: 0 },
      sliceIndex: 6,
      imageWidth: 5,
      imageHeight: 4,
      dimensions: metadata.dimensions,
    })).toEqual([6, -0.5, 6.5]);
    expect(mapVectorPlanePointToVoxel({
      axis: 'sagittal',
      point: { x: 5, y: 4 },
      sliceIndex: 6,
      imageWidth: 5,
      imageHeight: 4,
      dimensions: metadata.dimensions,
    })).toEqual([6, 8.5, -0.5]);
  });

  test('keeps geometry in the final source-pixel column nondegenerate', () => {
    const { faces } = buildPt3VectorAnnotationFaces([
      rectangleAnnotation({
        areas: [{
          tool: 'rectangle',
          operation: 'add',
          start: { x: 10, y: 1 },
          end: { x: 11, y: 2 },
        }],
      }),
    ], metadata);
    const lowerFace = faces.find((face) => face.surface === 'lower');
    const lowerPoints = collectFaceVoxelPolygons(lowerFace).flat();
    expect([...new Set(lowerPoints.map((point) => point[0]))].sort((a, b) => a - b))
      .toEqual([9.5, 10.5]);
  });

  test('treats min and max slices as inclusive voxel ranges', () => {
    expect(getInclusiveVectorSliceRange({
      axis: 'axial',
      minSlice: 4,
      maxSlice: 2,
      dimensions: metadata.dimensions,
    })).toEqual({ minSlice: 2, maxSlice: 4, lowerFace: 1.5, upperFace: 4.5 });
    expect(getInclusiveVectorSliceRange({
      axis: 'coronal',
      minSlice: 3,
      maxSlice: 3,
      dimensions: metadata.dimensions,
    })).toEqual({ minSlice: 3, maxSlice: 3, lowerFace: 2.5, upperFace: 3.5 });

    const { faces } = buildPt3VectorAnnotationFaces([rectangleAnnotation()], metadata);
    expect(collectSurfaceVoxelPolygons(faces, 'lower').flat().every((point) => point[2] === 1.5)).toBe(true);
    expect(collectSurfaceVoxelPolygons(faces, 'upper').flat().every((point) => point[2] === 4.5)).toBe(true);
  });

  test.each([
    ['axial', 11, 9, 2, 1.5, 4.5],
    ['coronal', 11, 7, 1, 0.5, 3.5],
    ['sagittal', 9, 7, 0, -0.5, 2.5],
  ])('keeps a composited hole registered through the %s slice range', (
    axis,
    imageWidth,
    imageHeight,
    constantCoordinate,
    expectedLower,
    expectedUpper,
  ) => {
    const built = buildPt3VectorAnnotationFaces([
      rectangleAnnotation({
        axis,
        minSlice: expectedLower + 0.5,
        maxSlice: expectedUpper - 0.5,
        imageWidth,
        imageHeight,
        areas: [
          { tool: 'rectangle', operation: 'add', start: { x: 1, y: 1 }, end: { x: imageWidth - 1, y: imageHeight - 1 } },
          { tool: 'circle', operation: 'subtract', center: { x: imageWidth / 2, y: imageHeight / 2 }, radius: 1.5 },
        ],
      }),
    ], metadata);
    const lowerFaces = built.faces.filter((face) => face.surface === 'lower');
    const upperFaces = built.faces.filter((face) => face.surface === 'upper');

    expect(built.stats.subtractAreasApplied).toBe(1);
    expect(lowerFaces.length).toBeGreaterThan(0);
    expect(upperFaces.length).toBe(lowerFaces.length);
    expect(lowerFaces.flatMap(collectFaceVoxelPolygons).flat().every((point) => point[constantCoordinate] === expectedLower)).toBe(true);
    expect(upperFaces.flatMap(collectFaceVoxelPolygons).flat().every((point) => point[constantCoordinate] === expectedUpper)).toBe(true);
  });

  test('supports bounded rectangle, circle, polygon, brush, connected-run, and bbox geometry', () => {
    const annotation = rectangleAnnotation({
      minSlice: 1,
      maxSlice: 1,
      areas: [
        { tool: 'rectangle', start: { x: 1, y: 1 }, end: { x: 3, y: 3 } },
        { tool: 'circle', center: { x: 5, y: 4 }, radius: 2 },
        { tool: 'polygon', points: [{ x: 1, y: 5 }, { x: 3, y: 7 }, { x: 4, y: 5 }] },
        { tool: 'brush', brushSize: 2, points: [{ x: 5, y: 1 }, { x: 7, y: 2 }, { x: 8, y: 4 }] },
        { tool: 'connected', maskRuns: [[2, 1, 4], [3, 2, 5]] },
        { tool: 'connected', bbox: [6, 5, 9, 8] },
      ],
    });
    const original = JSON.parse(JSON.stringify(annotation));
    const built = buildPt3VectorAnnotationFaces([annotation], metadata);

    expect(built.stats.areasRead).toBe(6);
    expect(built.stats.primitivesBuilt).toBeGreaterThan(0);
    expect(built.stats.primitivesBuilt).toBeLessThanOrEqual(MAX_VECTOR_PRIMITIVES);
    expect(built.stats.maskRunsRead).toBe(2);
    expect(built.faces.length).toBeGreaterThan(0);
    expect(annotation).toEqual(original);
  });

  test('applies the area limit per segment so a later valid segment is retained', () => {
    const firstAreas = Array.from({ length: MAX_VECTOR_AREAS }, () => ({
      tool: 'rectangle',
      operation: 'add',
      start: { x: 1, y: 1 },
      end: { x: 3, y: 3 },
    }));
    const built = buildPt3VectorAnnotationFaces([
      rectangleAnnotation({ id: 'segment-at-area-limit', areas: firstAreas }),
      rectangleAnnotation({
        id: 'segment-after-area-limit',
        areas: [{
          tool: 'connected',
          operation: 'add',
          maskRuns: [[7, 8, 10]],
        }],
      }),
    ], metadata);

    expect(built.stats.annotationsRead).toBe(2);
    expect(built.stats.areasRead).toBe(MAX_VECTOR_AREAS + 1);
    expect(built.stats.maskRunsRead).toBe(1);
    expect(built.stats.truncated).toBe(false);
    expect(built.faces.some((face) => face.annotationId === 'segment-after-area-limit')).toBe(true);
    const laterLowerPolygons = built.faces
      .filter((face) => face.annotationId === 'segment-after-area-limit' && face.surface === 'lower')
      .flatMap(collectFaceVoxelPolygons);
    expect(laterLowerPolygons).toHaveLength(1);
    expect(laterLowerPolygons[0].map((point) => point[0]))
      .toEqual(expect.arrayContaining([7.5, 9.5]));
  });

  test('applies the mask-run limit per segment without approximating the next segment', () => {
    const boundaryRuns = Array.from(
      { length: MAX_VECTOR_MASK_RUNS },
      (_unused, row) => [row, 0, 1],
    );
    const built = buildPt3VectorAnnotationFaces([
      rectangleAnnotation({
        id: 'segment-at-mask-limit',
        imageWidth: 2,
        imageHeight: MAX_VECTOR_MASK_RUNS,
        areas: [{ tool: 'connected', operation: 'add', maskRuns: boundaryRuns }],
      }),
      rectangleAnnotation({
        id: 'segment-after-mask-limit',
        areas: [{ tool: 'connected', operation: 'add', maskRuns: [[7, 8, 10]] }],
      }),
    ], metadata);

    expect(built.stats.annotationsRead).toBe(2);
    expect(built.stats.maskRunsRead).toBe(MAX_VECTOR_MASK_RUNS + 1);
    expect(built.stats.maskApproximated).toBe(0);
    expect(built.stats.truncated).toBe(false);
    const laterLowerPolygons = built.faces
      .filter((face) => face.annotationId === 'segment-after-mask-limit' && face.surface === 'lower')
      .flatMap(collectFaceVoxelPolygons);
    expect(laterLowerPolygons).toHaveLength(1);
    expect(laterLowerPolygons[0].map((point) => point[0]))
      .toEqual(expect.arrayContaining([7.5, 9.5]));
  });

  test('does no work when globally hidden and skips individually hidden annotations', () => {
    expect(buildPt3VectorAnnotationFaces(
      [rectangleAnnotation()],
      metadata,
      { showAnnotations: false },
    ).faces).toEqual([]);
    expect(buildPt3VectorAnnotationFaces([
      rectangleAnnotation({ visible: false }),
      rectangleAnnotation({ id: 'segment-hidden', hidden: true }),
    ], metadata).faces).toEqual([]);

    const context = makeContext();
    const result = renderPt3VectorAnnotations(context, {
      vectorAnnotations: [rectangleAnnotation()],
      showAnnotations: false,
      metadata,
    });
    expect(result.renderedFaces).toBe(0);
    expect(context.beginPath).not.toHaveBeenCalled();
  });

  test('multiplies authored vector face alpha without changing annotation geometry', () => {
    const context = makeContext();
    const fillStyles = [];
    const strokeStyles = [];
    context.fill = jest.fn(() => fillStyles.push(context.fillStyle));
    context.stroke = jest.fn(() => strokeStyles.push(context.strokeStyle));

    const result = renderPt3VectorAnnotations(context, {
      vectorAnnotations: [rectangleAnnotation({ opacity: 0.4 })],
      metadata,
      rotation: { x: -18, y: 32 },
      zoom: 1,
      opacityMultiplier: 0.25,
    });

    expect(result.renderedFaces).toBe(3);
    expect(fillStyles).toEqual(expect.arrayContaining([
      'rgba(34,211,238,0.07800000000000001)',
      'rgba(34,211,238,0.05500000000000001)',
    ]));
    expect(strokeStyles.every((style) => style === 'rgba(34,211,238,0.205)')).toBe(true);
  });

  test('caps adversarial connected masks and total face work', () => {
    const maskRuns = Array.from({ length: MAX_VECTOR_MASK_RUNS + 100 }, (_unused, index) => [index, 0, 1]);
    const built = buildPt3VectorAnnotationFaces([
      rectangleAnnotation({
        imageHeight: MAX_VECTOR_MASK_RUNS + 100,
        areas: [{ tool: 'connected', maskRuns }],
      }),
    ], metadata);

    expect(built.stats.maskRunsRead).toBe(MAX_VECTOR_MASK_RUNS);
    expect(built.stats.primitivesBuilt).toBeLessThanOrEqual(MAX_VECTOR_PRIMITIVES);
    expect(built.stats.primitivesBuilt).toBeGreaterThan(0);
    expect(built.stats.facesBuilt).toBeLessThanOrEqual(MAX_VECTOR_FACES);
    expect(built.stats.maskApproximated).toBe(1);
    expect(built.stats.truncated).toBe(true);
  });

  test('keeps connected masks above the old primitive budget exact in both 2D and 3D', () => {
    const maskRuns = Array.from({ length: MAX_VECTOR_PRIMITIVES + 188 }, (_unused, index) => [index * 2, 1, 3]);
    const annotation = rectangleAnnotation({
      imageWidth: 11,
      imageHeight: maskRuns.length * 2,
      areas: [{
        tool: 'connected',
        operation: 'add',
        maskRuns,
        bbox: [1, 0, 3, maskRuns.length * 2 - 1],
      }],
    });
    const mask = buildPt3SegmentMask(annotation);
    const path = pt3SegmentMaskToSvgPath(mask);

    expect(mask.stats.maskRunsRead).toBe(maskRuns.length);
    expect(mask.stats.truncated).toBe(false);
    expect(mask.stats.approximated).toBe(false);
    expect(mask.rectangles).toHaveLength(maskRuns.length);
    expect((path.match(/M /g) || [])).toHaveLength(maskRuns.length);
    expect(pt3SegmentMaskContainsPoint(mask, 2, maskRuns.length * 2 - 1.5)).toBe(true);

    const built = buildPt3VectorAnnotationFaces([annotation], metadata);
    const maximumDisplayedY = Math.max(...built.faces.flatMap(collectFaceVoxelPolygons).flat().map((point) => point[1]));
    expect(built.stats.maskRectanglesRead).toBe(maskRuns.length);
    expect(built.stats.maskApproximated).toBe(0);
    expect(built.stats.primitivesBuilt).toBeLessThanOrEqual(MAX_VECTOR_PRIMITIVES);
    expect(built.stats.truncated).toBe(false);
    expect(maximumDisplayedY).toBeCloseTo(((maskRuns.length * 2 - 1) / (maskRuns.length * 2)) * 9 - 0.5, 10);
    expect(maximumDisplayedY).toBeLessThan(8.5);
  });

  test('preserves an enclosed narrow RLE hole and exact voxel coordinates beyond 512 runs', () => {
    const imageWidth = 802;
    const imageHeight = 700;
    const maskRuns = [[0, 0, 800]];
    for (let row = 1; row < imageHeight - 1; row += 1) {
      const narrowRow = row % 2 === 1;
      maskRuns.push([row, 0, narrowRow ? 400 : 399]);
      maskRuns.push([row, narrowRow ? 401 : 402, 800]);
    }
    maskRuns.push([imageHeight - 1, 0, 800]);
    expect(maskRuns.length).toBeGreaterThan(MAX_VECTOR_PRIMITIVES);

    const annotation = rectangleAnnotation({
      imageWidth,
      imageHeight,
      minSlice: 1,
      maxSlice: 2,
      areas: [{ tool: 'connected', operation: 'add', maskRuns }],
    });
    const largeMetadata = {
      dimensions: [imageWidth, imageHeight, 4],
      spacing: [1, 1, 1],
    };
    const mask = buildPt3SegmentMask(annotation);
    const built = buildPt3VectorAnnotationFaces([annotation], largeMetadata);
    const lowerPolygons = collectSurfaceVoxelPolygons(built.faces, 'lower');
    const containsVoxelPoint = (x, y) => lowerPolygons.some((polygon) => {
      const xs = polygon.map((point) => point[0]);
      const ys = polygon.map((point) => point[1]);
      return x >= Math.min(...xs) && x < Math.max(...xs)
        && y >= Math.min(...ys) && y < Math.max(...ys);
    });

    expect(mask.stats.approximated).toBe(false);
    expect(mask.stats.truncated).toBe(false);
    expect(built.stats.maskRectanglesRead).toBe(mask.rectangles.length);
    expect(built.stats.maskApproximated).toBe(0);
    expect(built.stats.truncated).toBe(false);
    expect(built.stats.facesBuilt).toBe(3);
    expect(built.stats.primitivesBuilt).toBe(3);
    expect(lowerPolygons).toHaveLength(mask.rectangles.length);

    // Source row 351 maps to voxel y=351. Its one-pixel source gap
    // [400, 401] maps exactly to voxel boundaries [399.5, 400.5].
    expect(containsVoxelPoint(399, 351)).toBe(true);
    expect(containsVoxelPoint(400, 351)).toBe(false);
    expect(containsVoxelPoint(401, 351)).toBe(true);
    const row351Boundaries = lowerPolygons
      .filter((polygon) => polygon.some((point) => point[1] === 350.5))
      .flatMap((polygon) => polygon.map((point) => point[0]));
    expect(row351Boundaries).toEqual(expect.arrayContaining([399.5, 400.5]));

    // Full top and bottom rows close the gap into a hole rather than an open
    // split; the hole remains empty hundreds of runs past the old cutoff.
    expect(containsVoxelPoint(400, -0.25)).toBe(true);
    expect(containsVoxelPoint(400, imageHeight - 1)).toBe(true);

    const context = makeContext();
    const rendered = renderPt3VectorAnnotations(context, {
      vectorAnnotations: [annotation],
      metadata: largeMetadata,
      rotation: { x: -18, y: 32 },
      zoom: 1,
    });
    expect(rendered.renderedFaces).toBe(3);
    expect(context.fill).toHaveBeenCalledTimes(3);
    expect(context.moveTo.mock.calls.length).toBeGreaterThan(MAX_VECTOR_PRIMITIVES);
  });

  test('exactly erases a plausible large connected mask without Cartesian boolean work', () => {
    const maskRuns = Array.from({ length: 2048 }, (_unused, index) => [index * 2, 1, 3]);
    const segment = rectangleAnnotation({
      imageWidth: 4,
      imageHeight: 4096,
      areas: [
        { tool: 'connected', operation: 'add', maskRuns },
        { tool: 'connected', operation: 'subtract', maskRuns },
      ],
    });
    const mask = buildPt3SegmentMask(segment);

    expect(mask.stats.maskRunsRead).toBe(4096);
    expect(mask.stats.subtractAreasApplied).toBe(1);
    expect(mask.stats.booleanOperations).toBeGreaterThan(0);
    expect(mask.stats.approximated).toBe(false);
    expect(mask.stats.truncated).toBe(false);
    expect(mask.rectangles).toEqual([]);
    expect(pt3SegmentMaskContainsPoint(mask, 2, 4094.5)).toBe(false);
  });

  test('keeps the conservative fallback explicit when the scanline budget is exhausted', () => {
    const maskRuns = Array.from({ length: 32 }, (_unused, index) => [index * 2, 1, 3]);
    const segment = rectangleAnnotation({
      imageWidth: 4,
      imageHeight: 64,
      areas: [
        { tool: 'connected', operation: 'add', maskRuns },
        { tool: 'connected', operation: 'subtract', maskRuns },
      ],
    });
    const mask = buildPt3SegmentMask(segment, { maxBooleanOperations: 10 });

    expect(mask.stats.maskRunsRead).toBe(64);
    expect(mask.stats.subtractAreasApplied).toBe(1);
    expect(mask.stats.approximated).toBe(true);
    expect(mask.stats.truncated).toBe(true);
    expect(pt3SegmentMaskContainsPoint(mask, 2, 62.5)).toBe(true);
  });

  test('composites ordered add, subtract, and refill operations into the shared 2D/3D mask', () => {
    const annotation = rectangleAnnotation({
      areas: [
        {
          tool: 'rectangle',
          operation: 'add',
          start: { x: 1, y: 1 },
          end: { x: 8, y: 7 },
        },
        {
          tool: 'rectangle',
          operation: 'subtract',
          start: { x: 2, y: 2 },
          end: { x: 4, y: 4 },
        },
        {
          tool: 'rectangle',
          operation: 'add',
          start: { x: 2.5, y: 2.5 },
          end: { x: 3.5, y: 3.5 },
        },
      ],
    });
    const mask = buildPt3SegmentMask(annotation);
    expect(pt3SegmentMaskContainsPoint(mask, 1.5, 1.5)).toBe(true);
    expect(pt3SegmentMaskContainsPoint(mask, 2.25, 2.25)).toBe(false);
    expect(pt3SegmentMaskContainsPoint(mask, 3, 3)).toBe(true);
    expect(pt3SegmentMaskContainsPoint(mask, 7.5, 6.5)).toBe(true);
    expect(pt3SegmentMaskToSvgPath(mask)).not.toContain('undefined');

    const built = buildPt3VectorAnnotationFaces([annotation], metadata);
    expect(built.stats.areasRead).toBe(3);
    expect(built.stats.subtractAreasApplied).toBe(1);
    expect(built.stats.subtractAreasOmitted).toBe(0);
    expect(built.stats.primitivesBuilt).toBe(built.stats.facesBuilt);
    expect(built.faces.every((face) => face.operation === 'add')).toBe(true);
    const sidePolygons = collectSurfaceVoxelPolygons(built.faces, 'side');
    expect(built.faces.filter((face) => face.surface === 'side')).toHaveLength(1);
    expect(sidePolygons.length).toBeGreaterThanOrEqual(8);

    const context = makeContext();
    const result = renderPt3VectorAnnotations(context, {
      vectorAnnotations: [annotation],
      metadata,
      rotation: { x: -22, y: 32 },
      zoom: 1.4,
      mirrorScale: { x: -1, y: 1, z: 1 },
    });

    expect(result.renderedFaces).toBeGreaterThan(0);
    expect(result.subtractAreasApplied).toBe(1);
    expect(result.subtractAreasOmitted).toBe(0);
    expect(context.fill).toHaveBeenCalled();
    expect(context.stroke).toHaveBeenCalled();
    expect(context.setLineDash).not.toHaveBeenCalledWith([6, 4]);

    const subtractOnly = buildPt3VectorAnnotationFaces([
      rectangleAnnotation({ areas: [{ tool: 'eraser', points: [{ x: 1, y: 1 }] }] }),
    ], metadata);
    expect(subtractOnly.faces).toEqual([]);
    expect(subtractOnly.stats.subtractAreasApplied).toBe(1);
    expect(subtractOnly.stats.subtractAreasOmitted).toBe(0);
  });

  test('preserves connected mask-run extents exactly while subtracting from them', () => {
    const segment = rectangleAnnotation({
      imageWidth: 10,
      imageHeight: 8,
      areas: [
        {
          tool: 'connected',
          operation: 'add',
          canvasHeight: 4,
          maskRuns: [[2, 1, 5], [4, 2, 6, 1]],
          bbox: [1, 2, 6, 5],
        },
        {
          tool: 'rectangle',
          operation: 'subtract',
          start: { x: 2, y: 2.5 },
          end: { x: 3, y: 3.5 },
        },
      ],
    });
    const mask = buildPt3SegmentMask(segment);

    expect(mask.stats.maskRunsRead).toBe(2);
    expect(pt3SegmentMaskContainsPoint(mask, 1.5, 2.25)).toBe(true);
    expect(pt3SegmentMaskContainsPoint(mask, 2.5, 3)).toBe(false);
    expect(pt3SegmentMaskContainsPoint(mask, 4.5, 3.75)).toBe(true);
    expect(pt3SegmentMaskContainsPoint(mask, 2.5, 4.5)).toBe(true);
    expect(pt3SegmentMaskContainsPoint(mask, 5.5, 5.5)).toBe(false);
  });

  test.each([
    ['rectangle', { start: { x: 2, y: 2 }, end: { x: 8, y: 7 } }, [3, 3], [1, 1]],
    ['circle', { center: { x: 5, y: 4 }, radius: 2 }, [5, 4], [1, 1]],
    ['polygon', { points: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 5, y: 7 }] }, [5, 4], [1, 1]],
    ['brush', { points: [{ x: 2, y: 2 }, { x: 8, y: 6 }], brushSize: 2 }, [5, 4], [1, 7]],
  ])('creates bounded occupied masks for %s geometry', (tool, area, inside, outside) => {
    const mask = buildPt3SegmentMask(rectangleAnnotation({
      imageWidth: 10,
      imageHeight: 8,
      areas: [{ tool, operation: 'add', ...area }],
    }));
    expect(pt3SegmentMaskContainsPoint(mask, inside[0], inside[1])).toBe(true);
    expect(pt3SegmentMaskContainsPoint(mask, outside[0], outside[1])).toBe(false);
    expect(mask.rectangles.length).toBeGreaterThan(0);
    expect(mask.rectangles.length).toBeLessThanOrEqual(MAX_VECTOR_PRIMITIVES);
  });
});
