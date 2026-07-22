import {
  annotationToVectorSegment,
  buildInspectionAnnotationItems,
  getInspectionAnnotationKind,
  makeVistaSegmentAnnotationPayload,
} from '../inspectionAnnotationAdapter';

describe('inspectionAnnotationAdapter', () => {
  test('infers legacy annotation kinds without rewriting them', () => {
    expect(getInspectionAnnotationKind({ geometry: { line: {} } })).toBe('measurement');
    expect(getInspectionAnnotationKind({ geometry: { segment: {} } })).toBe('vista_segment');
    expect(getInspectionAnnotationKind({ geometry: { box: {} } })).toBe('annotation');
  });

  test('combines annotations and deduplicated assigned overlays', () => {
    const items = buildInspectionAnnotationItems(
      [{ id: 'a-1', annotation_kind: 'measurement', defect_class: 'Measurement', hidden: true }],
      [
        { overlay: true, imageId: 'overlay-1', label: 'Pore mask' },
        { overlay: true, imageId: 'overlay-1', label: 'Pore mask duplicate' },
        { overlay: false, imageId: 'source-1' },
      ],
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ key: 'annotation:a-1', kind: 'measurement', visible: false });
    expect(items[1]).toMatchObject({ key: 'overlay:overlay-1', kind: 'external_overlay', visible: true });
  });

  test('round-trips a persisted vector segment contract', () => {
    const payload = makeVistaSegmentAnnotationPayload({
      label: 'Internal pore',
      color: '#00ffaa',
      axis: 'coronal',
      minSlice: 3,
      maxSlice: 9,
      imageWidth: 80,
      imageHeight: 40,
      areas: [{ id: 'shape-1', tool: 'rectangle', operation: 'add' }],
      visible: false,
    });
    expect(payload).toMatchObject({
      annotation_kind: 'vista_segment',
      defect_class: 'Internal pore',
      hidden: true,
      geometry: { segment: { axis: 'coronal', min_slice: 3, max_slice: 9 } },
    });
    expect(annotationToVectorSegment({ id: 'segment-1', ...payload })).toMatchObject({
      id: 'segment-1',
      label: 'Internal pore',
      color: '#00ffaa',
      visible: false,
      axis: 'coronal',
      minSlice: 3,
      maxSlice: 9,
      imageWidth: 80,
      imageHeight: 40,
    });
  });

  test('clamps invalid segment ranges and opacity', () => {
    const payload = makeVistaSegmentAnnotationPayload({
      axis: 'invalid',
      minSlice: -4,
      maxSlice: -10,
      imageWidth: 0,
      imageHeight: Number.NaN,
      opacity: 5,
    });
    expect(payload.geometry.segment).toMatchObject({
      axis: 'axial',
      min_slice: 0,
      max_slice: 0,
      image_width: 1,
      image_height: 1,
    });
    expect(payload.metadata.annotation_fill_opacity).toBe(1);
  });

  test('persists only canonical source-space segment area geometry', () => {
    const transientPoint = (x, y) => ({
      x,
      y,
      displayX: x * 10,
      displayY: y * 10,
      stageWidth: 900,
      stageHeight: 600,
      imageWidth: 90,
      imageHeight: 60,
      cachedPixels: new Array(4).fill(255),
    });
    const payload = makeVistaSegmentAnnotationPayload({
      axis: 'axial',
      imageWidth: 90,
      imageHeight: 60,
      areas: [
        {
          id: 'brush-1',
          tool: 'brush',
          operation: 'subtract',
          axis: 'axial',
          sliceIndex: 8,
          imageWidth: 90,
          imageHeight: 60,
          brushSize: 7,
          points: [transientPoint(3, 4), transientPoint(8, 9), { x: Infinity, y: 2 }],
          displayX: 100,
          stageWidth: 900,
        },
        {
          id: 'rectangle-1',
          tool: 'rectangle',
          operation: 'add',
          start: transientPoint(5, 6),
          end: transientPoint(30, 28),
          points: [transientPoint(5, 6), transientPoint(30, 28)],
        },
        {
          id: 'circle-1',
          tool: 'circle',
          operation: 'add',
          center: transientPoint(20, 15),
          edge: transientPoint(25, 15),
          seed: transientPoint(20, 15),
          radius: 5,
          closed: true,
        },
        {
          id: 'connected-1',
          tool: 'connected',
          operation: 'add',
          seed: transientPoint(2, 3),
          maskPath: 'M 1 2 h 4 v 1 h -4 Z',
          mask_runs: [
            [2, 1, 5],
            { row: 3, x: 2, x2: 6, displayX: 20 },
            [Number.NaN, 0, 1],
          ],
          bbox: [1, 2, 6, 4],
          canvasWidth: 90,
          canvasHeight: 60,
          seedColor: [10, 20, 30, 255],
          areaPx: 8,
        },
        {
          id: 'ml-1',
          tool: 'ml-helper',
          operation: 'add',
          bbox: [10, 12, 30, 32],
          points: [transientPoint(15, 20)],
          label: 4,
          area_px: 400,
          class_name: 'void',
          confidence: 0.92,
          method_id: 'segmentation.sam.placeholder',
          method_label: 'SAM',
          imageWidth: 90,
          imageHeight: 60,
          decodedPixels: [1, 2, 3],
          mlCache: { result: 'transient' },
        },
      ],
    });

    expect(payload.geometry.segment.areas).toEqual([
      {
        id: 'brush-1',
        tool: 'brush',
        operation: 'subtract',
        axis: 'axial',
        sliceIndex: 8,
        brushSize: 7,
        points: [{ x: 3, y: 4 }, { x: 8, y: 9 }],
      },
      {
        id: 'rectangle-1',
        tool: 'rectangle',
        operation: 'add',
        points: [{ x: 5, y: 6 }, { x: 30, y: 28 }],
        start: { x: 5, y: 6 },
        end: { x: 30, y: 28 },
      },
      {
        id: 'circle-1',
        tool: 'circle',
        operation: 'add',
        radius: 5,
        closed: true,
        center: { x: 20, y: 15 },
        edge: { x: 25, y: 15 },
        seed: { x: 20, y: 15 },
      },
      {
        id: 'connected-1',
        tool: 'connected',
        operation: 'add',
        seed: { x: 2, y: 3 },
        bbox: [1, 2, 6, 4],
        maskPath: 'M 1 2 h 4 v 1 h -4 Z',
        maskRuns: [[2, 1, 5], [3, 2, 6]],
        canvasWidth: 90,
        canvasHeight: 60,
        areaPx: 8,
        seedColor: [10, 20, 30, 255],
      },
      {
        id: 'ml-1',
        tool: 'ml-helper',
        operation: 'add',
        points: [{ x: 15, y: 20 }],
        bbox: [10, 12, 30, 32],
        areaPx: 400,
        confidence: 0.92,
        className: 'void',
        methodId: 'segmentation.sam.placeholder',
        methodLabel: 'SAM',
        label: 4,
      },
    ]);

    const transientKeys = new Set([
      'displayX',
      'displayY',
      'stageWidth',
      'stageHeight',
      'imageWidth',
      'imageHeight',
      'cachedPixels',
      'decodedPixels',
      'mlCache',
    ]);
    const assertCanonical = (value) => {
      if (Array.isArray(value)) {
        value.forEach(assertCanonical);
        return;
      }
      if (!value || typeof value !== 'object') return;
      Object.entries(value).forEach(([key, child]) => {
        expect(transientKeys).not.toContain(key);
        assertCanonical(child);
      });
    };
    assertCanonical(payload.geometry.segment.areas);
    payload.geometry.segment.areas.flatMap((area) => (
      [area.start, area.end, area.center, area.edge, area.seed, ...(area.points || [])].filter(Boolean)
    )).forEach((point) => expect(Object.keys(point).sort()).toEqual(['x', 'y']));
  });
});
