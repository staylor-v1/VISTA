import { voxelToPhysical } from './pt3VolumeGeometry';

export const DEFAULT_SPLAT_VIEW_SETTINGS = Object.freeze({
  opacity: 1.25,
  pointSize: 1.35,
  contrast: 1.2,
  showSliceGuides: true,
});

export const MAX_CANVAS_SPLATS = 30000;

function normalizeCoordinateSpace(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['voxel', 'voxels', 'voxel_index', 'voxel_indices', 'ijk', 'index'].includes(normalized)) return 'voxel';
  if (['physical', 'physical_space', 'world', 'world_space', 'millimeter', 'millimeters', 'mm'].includes(normalized)) return 'physical';
  return null;
}

function getDeclaredCoordinateSpace(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const direct = normalizeCoordinateSpace(candidate.coordinate_space ?? candidate.coordinateSpace);
  if (direct) return direct;
  if (candidate.metadata && candidate.metadata !== candidate) {
    return normalizeCoordinateSpace(candidate.metadata.coordinate_space ?? candidate.metadata.coordinateSpace);
  }
  return null;
}

function isInternalVolumeSplatAssetUrl(assetUrl, applicationOrigin) {
  if (typeof assetUrl !== 'string' || !assetUrl.trim()) return false;
  const rawUrl = assetUrl.trim();
  const fallbackOrigin = applicationOrigin
    || (typeof window !== 'undefined' && window.location?.origin)
    || 'http://vista.local';
  try {
    const parsed = new URL(rawUrl, fallbackOrigin);
    const isRelative = !/^[a-z][a-z\d+.-]*:\/\//i.test(rawUrl) && !rawUrl.startsWith('//');
    if (!isRelative && parsed.origin !== fallbackOrigin) return false;
    return /\/volume-splat-assets(?:\/|$)/.test(parsed.pathname);
  } catch {
    return false;
  }
}

/**
 * Resolve the coordinate contract without guessing from point ranges. Explicit
 * declarations always win; only VISTA's generated-asset routes and the legacy
 * ready metadata record retain the historical voxel-coordinate default.
 */
export function resolveSplatCoordinateSpace({
  parsedMetadata,
  sourceMetadata,
  assetRecord,
  assetUrl,
  legacyPt3SplatAsset,
  applicationOrigin,
} = {}) {
  for (const candidate of [parsedMetadata, sourceMetadata, assetRecord]) {
    const declared = getDeclaredCoordinateSpace(candidate);
    if (declared) return declared;
  }
  if (isInternalVolumeSplatAssetUrl(assetUrl, applicationOrigin)) return 'voxel';
  if (legacyPt3SplatAsset?.status === 'ready') return 'voxel';
  return 'physical';
}

export function getCanvasSplatStride(splatCount, maxSplats = MAX_CANVAS_SPLATS) {
  const safeCount = Math.max(0, Math.floor(Number(splatCount) || 0));
  const safeMaximum = Math.max(1, Math.floor(Number(maxSplats) || MAX_CANVAS_SPLATS));
  return Math.max(1, Math.ceil(safeCount / safeMaximum));
}

export function sortSplatRenderEntriesBackToFront(entries = []) {
  return entries.sort((left, right) => (
    left.viewZ - right.viewZ || left.splatIndex - right.splatIndex
  ));
}

/**
 * Convert declared/generated voxel points into the same physical space used by
 * the ray renderer while leaving physical/world point clouds untouched.
 * Per-point scales remain authored values; the view's point-size control is a
 * separate presentation multiplier.
 */
export function prepareSplatAssetForRendering(splats, metadata, context = {}) {
  if (!splats?.positions) return splats;
  const coordinateSpace = resolveSplatCoordinateSpace({
    ...context,
    parsedMetadata: context.parsedMetadata || splats.metadata,
  });
  if (coordinateSpace !== 'voxel') return splats;
  const positions = new Float32Array(splats.positions.length);
  for (let index = 0; index < splats.positions.length; index += 3) {
    positions.set(voxelToPhysical([
      splats.positions[index],
      splats.positions[index + 1],
      splats.positions[index + 2],
    ], metadata), index);
  }
  return { ...splats, positions };
}
