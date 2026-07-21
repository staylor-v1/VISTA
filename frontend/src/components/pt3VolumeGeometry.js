export const DEFAULT_VOLUME_METADATA = Object.freeze({
  dimensions: [1, 1, 1],
  spacing: [1, 1, 1],
  origin: [0, 0, 0],
  direction: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  scalarType: 'uint8',
  scalarRange: [0, 255],
  modality: 'CT',
  rescaleSlope: 1,
  rescaleIntercept: 0,
  sourceId: 'synthetic-local-preview',
});

export function normalizeAxisMirrorScale(candidate = {}) {
  return {
    x: Number(candidate?.x) < 0 ? -1 : 1,
    y: Number(candidate?.y) < 0 ? -1 : 1,
    z: Number(candidate?.z) < 0 ? -1 : 1,
  };
}

export function getMprAxisMirrorScale(projectionMirror = {}) {
  return {
    x: projectionMirror?.sagittal === true ? -1 : 1,
    y: projectionMirror?.coronal === true ? -1 : 1,
    z: projectionMirror?.axial === true ? -1 : 1,
  };
}

export function normalizeVolumeMetadata(candidate = {}) {
  const dimensions = normalizeVec3(candidate.dimensions || candidate.shape || DEFAULT_VOLUME_METADATA.dimensions, DEFAULT_VOLUME_METADATA.dimensions, true);
  const spacing = normalizeVec3(candidate.spacing || DEFAULT_VOLUME_METADATA.spacing, DEFAULT_VOLUME_METADATA.spacing);
  const origin = normalizeVec3(candidate.origin || DEFAULT_VOLUME_METADATA.origin, DEFAULT_VOLUME_METADATA.origin, false, true);
  const direction = Array.isArray(candidate.direction) && candidate.direction.length === 9
    ? candidate.direction.map((value, index) => Number.isFinite(Number(value)) ? Number(value) : DEFAULT_VOLUME_METADATA.direction[index])
    : DEFAULT_VOLUME_METADATA.direction.slice();
  const scalarRange = Array.isArray(candidate.scalarRange || candidate.scalar_range)
    ? [Number((candidate.scalarRange || candidate.scalar_range)[0]), Number((candidate.scalarRange || candidate.scalar_range)[1])]
    : DEFAULT_VOLUME_METADATA.scalarRange.slice();
  return {
    ...DEFAULT_VOLUME_METADATA,
    ...candidate,
    dimensions,
    spacing,
    origin,
    direction,
    scalarType: candidate.scalarType || candidate.scalar_type || DEFAULT_VOLUME_METADATA.scalarType,
    scalarRange: scalarRange.every(Number.isFinite) && scalarRange[1] > scalarRange[0] ? scalarRange : DEFAULT_VOLUME_METADATA.scalarRange.slice(),
    rescaleSlope: Number.isFinite(Number(candidate.rescaleSlope ?? candidate.rescale_slope)) ? Number(candidate.rescaleSlope ?? candidate.rescale_slope) : 1,
    rescaleIntercept: Number.isFinite(Number(candidate.rescaleIntercept ?? candidate.rescale_intercept)) ? Number(candidate.rescaleIntercept ?? candidate.rescale_intercept) : 0,
    sourceId: String(candidate.sourceId || candidate.source_id || DEFAULT_VOLUME_METADATA.sourceId),
  };
}

function normalizeVec3(values, fallback, integer = false, allowZeroOrNegative = false) {
  return [0, 1, 2].map((index) => {
    const value = Number(values?.[index]);
    const valid = Number.isFinite(value) && (allowZeroOrNegative || value > 0);
    const next = valid ? value : fallback[index];
    return integer ? Math.max(1, Math.round(next)) : next;
  });
}

export function voxelToPhysical(index, metadata) {
  const meta = normalizeVolumeMetadata(metadata);
  const scaled = [index[0] * meta.spacing[0], index[1] * meta.spacing[1], index[2] * meta.spacing[2]];
  const d = meta.direction;
  return [
    meta.origin[0] + d[0] * scaled[0] + d[1] * scaled[1] + d[2] * scaled[2],
    meta.origin[1] + d[3] * scaled[0] + d[4] * scaled[1] + d[5] * scaled[2],
    meta.origin[2] + d[6] * scaled[0] + d[7] * scaled[1] + d[8] * scaled[2],
  ];
}

export function physicalToVoxel(point, metadata) {
  const meta = normalizeVolumeMetadata(metadata);
  const d = meta.direction;
  const rel = [point[0] - meta.origin[0], point[1] - meta.origin[1], point[2] - meta.origin[2]];
  // Direction matrices are expected orthonormal; inverse is transpose.
  return [
    (d[0] * rel[0] + d[3] * rel[1] + d[6] * rel[2]) / meta.spacing[0],
    (d[1] * rel[0] + d[4] * rel[1] + d[7] * rel[2]) / meta.spacing[1],
    (d[2] * rel[0] + d[5] * rel[1] + d[8] * rel[2]) / meta.spacing[2],
  ];
}

export function getPhysicalBounds(metadata) {
  const meta = normalizeVolumeMetadata(metadata);
  const max = meta.dimensions.map((value) => Math.max(0, value - 1));
  const corners = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => voxelToPhysical([x * max[0], y * max[1], z * max[2]], meta))));
  const minPoint = [0, 1, 2].map((axis) => Math.min(...corners.map((corner) => corner[axis])));
  const maxPoint = [0, 1, 2].map((axis) => Math.max(...corners.map((corner) => corner[axis])));
  return { min: minPoint, max: maxPoint, size: maxPoint.map((value, axis) => value - minPoint[axis]), corners };
}

export function applyRescale(rawValue, metadata) {
  const meta = normalizeVolumeMetadata(metadata);
  return rawValue * meta.rescaleSlope + meta.rescaleIntercept;
}

export function windowLevelToRange(window, level) {
  const width = Math.max(1, Number(window) || 1);
  const center = Number(level) || 0;
  return [center - width / 2, center + width / 2];
}

export function mapWindowLevel(value, window, level) {
  const [min, max] = windowLevelToRange(window, level);
  return Math.max(0, Math.min(1, (value - min) / (max - min)));
}

export function opacityCorrection(alpha, sampleStep, referenceStep = 1) {
  const clamped = Math.max(0, Math.min(0.999, Number(alpha) || 0));
  return 1 - Math.pow(1 - clamped, Math.max(0.0001, sampleStep) / Math.max(0.0001, referenceStep));
}

export function pointInsideCropBox(point, cropBox) {
  if (!cropBox?.enabled) return true;
  return [0, 1, 2].every((axis) => point[axis] >= cropBox.min[axis] && point[axis] <= cropBox.max[axis]);
}
