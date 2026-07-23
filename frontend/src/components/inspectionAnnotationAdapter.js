const VALID_ANNOTATION_KINDS = new Set(['annotation', 'measurement', 'vista_segment']);

const finiteNumber = (value, fallback = 0) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const optionalFiniteNumber = (value) => {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  try {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  } catch (_) {
    return null;
  }
};

const sanitizeSourcePoint = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const x = optionalFiniteNumber(value.x);
  const y = optionalFiniteNumber(value.y);
  return x === null || y === null ? null : { x, y };
};

const sanitizeFiniteTuple = (value, length) => {
  if (!Array.isArray(value) || value.length < length) return null;
  const tuple = value.slice(0, length).map(optionalFiniteNumber);
  return tuple.some((entry) => entry === null) ? null : tuple;
};

const sanitizeIntegerTuple = (value, length, { positive = false } = {}) => {
  const tuple = sanitizeFiniteTuple(value, length);
  if (!tuple) return null;
  const integers = tuple.map((entry) => Math.floor(entry));
  if (integers.some((entry) => (positive ? entry <= 0 : entry < 0))) return null;
  return integers;
};

const sanitizeMaskRun = (value) => {
  if (Array.isArray(value)) return sanitizeFiniteTuple(value, 3);
  if (!value || typeof value !== 'object') return null;
  const y = optionalFiniteNumber(value.y ?? value.row);
  const start = optionalFiniteNumber(value.start ?? value.x1 ?? value.x);
  const end = optionalFiniteNumber(value.end ?? value.x2);
  return [y, start, end].some((entry) => entry === null) ? null : [y, start, end];
};

const sanitizeVolumeRun = (value) => {
  const tuple = sanitizeIntegerTuple(value, 4);
  if (!tuple) return null;
  const [z, y, xStart, xEnd] = tuple;
  return xEnd > xStart ? [z, y, xStart, xEnd] : null;
};

const copyStringField = (target, source, outputName, ...inputNames) => {
  const inputName = inputNames.find((name) => typeof source[name] === 'string');
  if (inputName !== undefined) target[outputName] = source[inputName];
};

const copyFiniteField = (target, source, outputName, ...inputNames) => {
  const inputName = inputNames.find((name) => optionalFiniteNumber(source[name]) !== null);
  if (inputName !== undefined) target[outputName] = optionalFiniteNumber(source[inputName]);
};

function sanitizeSegmentArea(area) {
  if (!area || typeof area !== 'object' || Array.isArray(area)) return null;
  const result = {};

  copyStringField(result, area, 'id', 'id');
  copyStringField(result, area, 'tool', 'tool', 'type', 'shape');
  copyStringField(result, area, 'operation', 'operation');
  copyStringField(result, area, 'axis', 'axis');
  const mode = String(area.mode ?? area.areaMode ?? area.dimensionality ?? '').trim().toLowerCase();
  if (['2d', '3d'].includes(mode)) result.mode = mode;

  copyFiniteField(result, area, 'sliceIndex', 'sliceIndex', 'slice_index');
  copyFiniteField(result, area, 'imageWidth', 'imageWidth', 'image_width');
  copyFiniteField(result, area, 'imageHeight', 'imageHeight', 'image_height');
  copyFiniteField(result, area, 'brushSize', 'brushSize', 'brush_size', 'width');
  copyFiniteField(result, area, 'sensitivity', 'sensitivity');
  copyFiniteField(result, area, 'radius', 'radius');
  if (typeof area.closed === 'boolean') result.closed = area.closed;

  if (Array.isArray(area.points)) {
    result.points = area.points.map(sanitizeSourcePoint).filter(Boolean);
  }
  ['start', 'end', 'center', 'edge', 'seed'].forEach((field) => {
    const point = sanitizeSourcePoint(area[field]);
    if (point) result[field] = point;
  });

  const bbox = sanitizeFiniteTuple(area.bbox, 4);
  if (bbox) result.bbox = bbox;
  copyStringField(result, area, 'maskPath', 'maskPath', 'mask_path');
  const maskRuns = Array.isArray(area.maskRuns)
    ? area.maskRuns
    : (Array.isArray(area.mask_runs) ? area.mask_runs : null);
  if (maskRuns) result.maskRuns = maskRuns.map(sanitizeMaskRun).filter(Boolean);
  copyFiniteField(result, area, 'canvasWidth', 'canvasWidth', 'canvas_width');
  copyFiniteField(result, area, 'canvasHeight', 'canvasHeight', 'canvas_height');

  // Keep the small, stable provenance fields emitted by connected-area and ML
  // helpers. Cached model responses, decoded pixels, and display geometry are
  // intentionally not copied into persisted annotations.
  copyFiniteField(result, area, 'areaPx', 'areaPx', 'area_px');
  copyFiniteField(result, area, 'confidence', 'confidence');
  copyStringField(result, area, 'className', 'className', 'class_name');
  copyStringField(result, area, 'methodId', 'methodId', 'method_id');
  copyStringField(result, area, 'methodLabel', 'methodLabel', 'method_label');
  copyStringField(result, area, 'error', 'error');
  if (['string', 'number'].includes(typeof area.label)) {
    const label = typeof area.label === 'number' ? optionalFiniteNumber(area.label) : area.label;
    if (label !== null) result.label = label;
  }
  const seedColor = sanitizeFiniteTuple(area.seedColor ?? area.seed_color, 4);
  if (seedColor) result.seedColor = seedColor;
  const volumeDimensions = sanitizeIntegerTuple(
    area.volumeDimensions ?? area.volume_dimensions,
    3,
    { positive: true },
  );
  if (volumeDimensions) result.volumeDimensions = volumeDimensions;
  const seedVoxel = sanitizeIntegerTuple(area.seedVoxel ?? area.seed_voxel, 3);
  if (seedVoxel) result.seedVoxel = seedVoxel;
  const spacing = sanitizeFiniteTuple(area.spacing, 3);
  if (spacing?.every((entry) => entry > 0)) result.spacing = spacing;
  const volumeRunCandidates = [area.volumeRuns, area.volume_runs].filter(Array.isArray);
  const volumeRuns = volumeRunCandidates.find((candidate) => candidate.length > 0)
    ?? volumeRunCandidates[0]
    ?? null;
  if (volumeRuns) result.volumeRuns = volumeRuns.map(sanitizeVolumeRun).filter(Boolean);
  copyFiniteField(result, area, 'voxelCount', 'voxelCount', 'voxel_count');
  copyFiniteField(result, area, 'connectivity', 'connectivity');
  if (typeof area.truncated === 'boolean') result.truncated = area.truncated;
  copyStringField(result, area, 'truncationReason', 'truncationReason', 'truncation_reason');

  return result;
}

const sanitizeSegmentAreas = (areas) => (
  Array.isArray(areas) ? areas.map(sanitizeSegmentArea).filter(Boolean) : []
);

export function getInspectionAnnotationKind(annotation) {
  const explicit = String(annotation?.annotation_kind || '').trim().toLowerCase();
  if (VALID_ANNOTATION_KINDS.has(explicit)) return explicit;
  if (annotation?.geometry?.segment) return 'vista_segment';
  if (annotation?.geometry?.line || String(annotation?.defect_class || '').trim().toLowerCase() === 'measurement') {
    return 'measurement';
  }
  return 'annotation';
}

export function isVistaSegmentAnnotation(annotation) {
  return getInspectionAnnotationKind(annotation) === 'vista_segment';
}

export function annotationToVectorSegment(annotation) {
  if (!isVistaSegmentAnnotation(annotation)) return null;
  const geometry = annotation?.geometry?.segment || {};
  const axis = String(geometry.axis || '').trim().toLowerCase();
  if (!['axial', 'coronal', 'sagittal'].includes(axis)) return null;
  const minSlice = Math.max(0, Math.floor(finiteNumber(
    geometry.min_slice ?? geometry.minSlice ?? geometry.slice_index ?? geometry.sliceIndex,
    0,
  )));
  const maxSlice = Math.max(minSlice, Math.floor(finiteNumber(
    geometry.max_slice ?? geometry.maxSlice ?? geometry.slice_index ?? geometry.sliceIndex,
    minSlice,
  )));
  const imageWidth = Math.max(1, finiteNumber(geometry.image_width ?? geometry.imageWidth, 1));
  const imageHeight = Math.max(1, finiteNumber(geometry.image_height ?? geometry.imageHeight, 1));
  const volumeDimensions = sanitizeIntegerTuple(
    geometry.volume_dimensions ?? geometry.volumeDimensions,
    3,
    { positive: true },
  );
  return {
    id: String(annotation.id || ''),
    annotationId: String(annotation.id || ''),
    label: String(annotation.defect_class || annotation.comment || 'Segment'),
    color: String(annotation?.metadata?.annotation_color || annotation.color || '#22d3ee'),
    opacity: Math.min(1, Math.max(0, finiteNumber(annotation?.metadata?.annotation_fill_opacity, 0.24))),
    visible: annotation.hidden !== true,
    axis,
    minSlice,
    maxSlice,
    imageWidth,
    imageHeight,
    version: Number(geometry.version) === 2 ? 2 : 1,
    volumeDimensions,
    areas: Array.isArray(geometry.areas) ? geometry.areas : [],
    annotation,
  };
}

export function annotationToInspectionItem(annotation) {
  const kind = getInspectionAnnotationKind(annotation);
  const id = String(annotation?.id || '');
  return {
    key: `annotation:${id}`,
    id,
    kind,
    label: kind === 'vista_segment'
      ? String(annotation?.defect_class || annotation?.comment || 'Segment')
      : String(annotation?.comment || annotation?.defect_class || 'Annotation'),
    visible: annotation?.hidden !== true,
    color: String(annotation?.metadata?.annotation_color || annotation?.metadata?.measurement_color || '#ef4444'),
    source: { resource: 'annotation', resourceId: id },
    annotation,
  };
}

export function overlayRefToInspectionItem(entry) {
  const resourceId = String(entry?.imageId || entry?.imageRef || entry?.filename || '').trim();
  if (!entry?.overlay || !resourceId) return null;
  return {
    key: `overlay:${resourceId}`,
    id: `overlay:${resourceId}`,
    kind: 'external_overlay',
    label: String(entry.label || entry.filename || entry.imageRef || 'Assigned overlay'),
    visible: entry.hidden !== true,
    color: String(entry.color || '#a78bfa'),
    source: { resource: 'source_image', resourceId },
    overlay: entry,
  };
}

export function buildInspectionAnnotationItems(annotations = [], imageRefs = []) {
  const items = (Array.isArray(annotations) ? annotations : []).map(annotationToInspectionItem);
  const seenOverlayKeys = new Set();
  (Array.isArray(imageRefs) ? imageRefs : []).forEach((entry) => {
    const item = overlayRefToInspectionItem(entry);
    if (!item || seenOverlayKeys.has(item.key)) return;
    seenOverlayKeys.add(item.key);
    items.push(item);
  });
  return items;
}

export function makeVistaSegmentAnnotationPayload(segment, existingAnnotation = null) {
  const axis = ['axial', 'coronal', 'sagittal'].includes(segment?.axis) ? segment.axis : 'axial';
  const minSlice = Math.max(0, Math.floor(finiteNumber(segment?.minSlice, 0)));
  const maxSlice = Math.max(minSlice, Math.floor(finiteNumber(segment?.maxSlice, minSlice)));
  const areas = sanitizeSegmentAreas(segment?.areas);
  const volumeDimensions = sanitizeIntegerTuple(
    segment?.volumeDimensions ?? segment?.volume_dimensions,
    3,
    { positive: true },
  ) || areas.map((area) => area.volumeDimensions).find(Boolean) || null;
  const hasVolumeAreas = areas.some((area) => (
    Array.isArray(area.volumeRuns) && area.volumeRuns.length > 0
  ));
  const usesVolumeSchema = hasVolumeAreas
    || Number(segment?.version) === 2
    || areas.some((area) => (
      Array.isArray(area.seedVoxel)
      || Array.isArray(area.spacing)
      || Array.isArray(area.volumeRuns)
    ));
  return {
    annotation_kind: 'vista_segment',
    image_id: null,
    defect_class: String(segment?.label || segment?.name || existingAnnotation?.defect_class || 'Segment').trim() || 'Segment',
    modality: 'volume',
    comment: existingAnnotation?.comment || 'Created with VISTA Segmentation Helpers.',
    disposition: existingAnnotation?.disposition || 'open',
    measurements: existingAnnotation?.measurements || {},
    geometry: {
      ...(existingAnnotation?.geometry || {}),
      segment: {
        version: usesVolumeSchema ? 2 : 1,
        axis,
        min_slice: minSlice,
        max_slice: maxSlice,
        image_width: Math.max(1, finiteNumber(segment?.imageWidth, 1)),
        image_height: Math.max(1, finiteNumber(segment?.imageHeight, 1)),
        ...(usesVolumeSchema && volumeDimensions ? { volume_dimensions: volumeDimensions } : {}),
        areas,
      },
    },
    metadata: {
      ...(existingAnnotation?.metadata || {}),
      annotation_color: String(segment?.color || existingAnnotation?.metadata?.annotation_color || '#22d3ee'),
      annotation_fill_opacity: Math.min(1, Math.max(0, finiteNumber(
        segment?.opacity,
        existingAnnotation?.metadata?.annotation_fill_opacity ?? 0.24,
      ))),
    },
    bbox: existingAnnotation?.bbox || null,
    hidden: segment?.visible === false,
  };
}
