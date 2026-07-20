import { getPhysicalBounds, normalizeVolumeMetadata, pointInsideCropBox } from './pt3VolumeGeometry';

export const MECHANICAL_TRANSFER_PRESETS = {
  machinedMetal: { label: 'Machined metal', window: 220, level: 150, opacity: 0.76, colorStops: [[0, [15, 23, 42]], [0.35, [100, 116, 139]], [0.72, [203, 213, 225]], [1, [255, 255, 255]]] },
  composite: { label: 'Composite / plastic', window: 180, level: 110, opacity: 0.56, colorStops: [[0, [17, 24, 39]], [0.45, [45, 212, 191]], [1, [236, 253, 245]]] },
  defect: { label: 'Void / defect contrast', window: 140, level: 95, opacity: 0.64, colorStops: [[0, [2, 6, 23]], [0.38, [251, 146, 60]], [0.72, [239, 68, 68]], [1, [254, 242, 242]]] },
};

export function getMechanicalVolumeMetadata(part) {
  const shape = part?.metadata?.volume_shape || part?.metadata?.mpr?.volume_shape;
  return normalizeVolumeMetadata({
    dimensions: [shape?.sagittal || 128, shape?.coronal || 96, shape?.axial || 64],
    spacing: part?.metadata?.spacing || part?.metadata?.voxel_spacing || [0.08, 0.08, 0.12],
    origin: part?.metadata?.origin || [0, 0, 0],
    direction: part?.metadata?.direction,
    scalarRange: part?.metadata?.scalar_range || part?.metadata?.intensity_range || [0, 255],
    modality: part?.metadata?.modality || 'industrial_ct',
    sourceId: part?.id || 'mechanical-local-preview',
  });
}

export function makeMechanicalFallbackSplats(metadata) {
  const meta = normalizeVolumeMetadata(metadata);
  const count = 720;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 4);
  const bounds = getPhysicalBounds(meta);
  const maxSize = Math.max(...bounds.size, 1);
  const center = bounds.min.map((value, axis) => value + bounds.size[axis] / 2);
  for (let i = 0; i < count; i += 1) {
    const t = i / count;
    const ring = i % 5;
    const angle = t * Math.PI * 22;
    const gearTooth = 1 + (ring === 0 ? 0.18 * Math.sign(Math.sin(angle * 8)) : 0);
    const radius = (0.18 + ring * 0.055) * maxSize * gearTooth;
    const zBand = (Math.floor(i / 45) % 2 === 0 ? -0.42 : 0.42) * bounds.size[2] * 0.5;
    const z = center[2] + zBand + Math.sin(angle * 3) * bounds.size[2] * 0.035;
    positions.set([center[0] + Math.cos(angle) * radius, center[1] + Math.sin(angle) * radius, z], i * 3);
    const palette = ring === 0 ? [0.93, 0.95, 0.98, 0.88] : ring === 1 ? [0.45, 0.55, 0.68, 0.64] : ring === 2 ? [0.12, 0.72, 0.68, 0.5] : ring === 3 ? [0.98, 0.62, 0.23, 0.42] : [0.94, 0.18, 0.18, 0.5];
    colors.set(palette, i * 4);
  }
  return {
    positions,
    colors,
    layers: [
      { id: 'surface', label: 'Machined surface', count: 144, visible: true, opacity: 1 },
      { id: 'core', label: 'Part core', count: 288, visible: true, opacity: 0.78 },
      { id: 'defect-candidates', label: 'Void / defect candidates', count: 288, visible: true, opacity: 0.62 },
    ],
  };
}

export function getMechanicalCropBox(metadata, enabled) {
  const bounds = getPhysicalBounds(metadata);
  return {
    enabled: Boolean(enabled),
    min: bounds.min,
    max: bounds.max.map((value, axis) => (enabled && axis === 0 ? value - bounds.size[axis] * 0.35 : value)),
  };
}

export function countVisibleSplats(splats, cropBox) {
  if (!splats?.positions) return 0;
  let visible = 0;
  for (let i = 0; i < splats.positions.length; i += 3) {
    if (pointInsideCropBox([splats.positions[i], splats.positions[i + 1], splats.positions[i + 2]], cropBox)) visible += 1;
  }
  return visible;
}
