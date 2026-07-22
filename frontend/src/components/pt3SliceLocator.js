import {
  createPt3PerspectiveProjector,
  normalizeAxisMirrorScale,
  normalizeVolumeMetadata,
  voxelToPhysical,
} from './pt3VolumeGeometry';

const LOCATOR_AXES = Object.freeze({
  axial: Object.freeze({ coordinate: 2, color: '#3b82f6', plane: 'XY', slice: 'Z' }),
  coronal: Object.freeze({ coordinate: 1, color: '#f59e0b', plane: 'XZ', slice: 'Y' }),
  sagittal: Object.freeze({ coordinate: 0, color: '#10b981', plane: 'YZ', slice: 'X' }),
});

const AXIS_ORDER = ['axial', 'coronal', 'sagittal'];
const LABEL_PADDING = 4;
const LABEL_HEIGHT = 18;
const LABEL_GAP = 4;

function clamp(value, minimum, maximum, fallback = minimum) {
  const numeric = Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(numeric) ? numeric : fallback));
}

function projectVoxel(project, metadata, voxel) {
  const projected = project(voxelToPhysical(voxel, metadata));
  return {
    x: Number.isFinite(projected[0]) ? projected[0] : 0,
    y: Number.isFinite(projected[1]) ? projected[1] : 0,
    depth: Number.isFinite(projected[2]) ? projected[2] : 0,
  };
}

function normalizeRotation(rotation) {
  const finiteDegrees = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric % 360 : 0;
  };
  return { x: finiteDegrees(rotation?.x), y: finiteDegrees(rotation?.y) };
}

function makeReadout(axis, index, dimensions) {
  const config = LOCATOR_AXES[axis];
  return `${config.slice} ${index} / ${Math.max(0, dimensions[config.coordinate] - 1)}`;
}

export function buildPt3SliceLocatorGeometry({
  metadata,
  width,
  height,
  rotation,
  zoom,
  mirrorScale,
  slicePosition,
  activeSliceAxis = 'axial',
} = {}) {
  const normalizedMetadata = normalizeVolumeMetadata(
    metadata && typeof metadata === 'object' ? metadata : {},
  );
  const dimensions = normalizedMetadata.dimensions;
  const safeWidth = clamp(width, 1, 32768, 1);
  const safeHeight = clamp(height, 1, 32768, 1);
  const activeAxis = LOCATOR_AXES[activeSliceAxis] ? activeSliceAxis : 'axial';
  const positions = {
    sagittal: Math.round(clamp(slicePosition?.sagittal, 0, dimensions[0] - 1, 0)),
    coronal: Math.round(clamp(slicePosition?.coronal, 0, dimensions[1] - 1, 0)),
    axial: Math.round(clamp(slicePosition?.axial, 0, dimensions[2] - 1, 0)),
  };
  const [dimensionX, dimensionY, dimensionZ] = dimensions;
  const x0 = -0.5; const x1 = dimensionX - 0.5;
  const y0 = -0.5; const y1 = dimensionY - 0.5;
  const z0 = -0.5; const z1 = dimensionZ - 0.5;
  const x = positions.sagittal;
  const y = positions.coronal;
  const z = positions.axial;
  const project = createPt3PerspectiveProjector({
    metadata: normalizedMetadata,
    width: safeWidth,
    height: safeHeight,
    rotation: normalizeRotation(rotation),
    zoom,
    mirrorScale: normalizeAxisMirrorScale(mirrorScale),
  });
  const projected = (voxel) => projectVoxel(project, normalizedMetadata, voxel);
  const planeVoxels = {
    axial: [[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]],
    coronal: [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]],
    sagittal: [[x, y0, z0], [x, y1, z0], [x, y1, z1], [x, y0, z1]],
  };
  const lineVoxels = {
    sagittal: [[x0, y, z], [x1, y, z]],
    coronal: [[x, y0, z], [x, y1, z]],
    axial: [[x, y, z0], [x, y, z1]],
  };
  const readouts = AXIS_ORDER.reduce((result, axis) => ({
    ...result,
    [axis]: makeReadout(axis, positions[axis], dimensions),
  }), {});

  return {
    width: safeWidth,
    height: safeHeight,
    metadata: normalizedMetadata,
    activeAxis,
    positions,
    planes: AXIS_ORDER.map((axis) => ({
      axis,
      color: LOCATOR_AXES[axis].color,
      active: axis === activeAxis,
      points: planeVoxels[axis].map(projected),
    })),
    intersectionLines: ['sagittal', 'coronal', 'axial'].map((axis) => ({
      axis,
      color: LOCATOR_AXES[axis].color,
      label: readouts[axis],
      points: lineVoxels[axis].map(projected),
    })),
    center: projected([x, y, z]),
    readouts,
    activePlaneLabel: `${LOCATOR_AXES[activeAxis].plane} • ${readouts[activeAxis]}`,
  };
}

function boxesOverlap(left, right, gap) {
  return left.left < right.left + right.width + gap
    && left.left + left.width + gap > right.left
    && left.top < right.top + right.height + gap
    && left.top + left.height + gap > right.top;
}

function closestPointOnBox(anchor, box) {
  return {
    x: Math.max(box.left, Math.min(anchor.x, box.left + box.width)),
    y: Math.max(box.top, Math.min(anchor.y, box.top + box.height)),
  };
}

function clampLabelBox(candidate, width, height, canvasWidth, canvasHeight, padding) {
  return {
    left: Math.max(padding, Math.min(candidate.left, Math.max(padding, canvasWidth - width - padding))),
    top: Math.max(padding, Math.min(candidate.top, Math.max(padding, canvasHeight - height - padding))),
    width,
    height,
  };
}

export function layoutPt3SliceLocatorLabels(geometry, {
  displayScale = 1,
  measureText = (text) => text.length * 6.4 * displayScale,
} = {}) {
  const scale = clamp(displayScale, 0.5, 4, 1);
  const canvasWidth = Math.max(1, geometry.width);
  const canvasHeight = Math.max(1, geometry.height);
  const cssWidth = canvasWidth / scale;
  const cssHeight = canvasHeight / scale;
  const compact = cssWidth <= 320 || cssHeight <= 220;
  const veryCompact = cssWidth <= 210;
  const padding = Math.min(
    LABEL_PADDING * scale,
    Math.max(0, (canvasWidth - 1) / 2),
    Math.max(0, (canvasHeight - 1) / 2),
  );
  const gap = LABEL_GAP * scale;
  const labelHeight = Math.min(
    LABEL_HEIGHT * scale,
    Math.max(1, canvasHeight - padding * 2),
  );
  // The viewer status pill occupies the lower edge in every layout. Keep
  // locator readouts above it so their text remains readable end to end.
  const reservedBottom = Math.min(
    34 * scale,
    Math.max(0, canvasHeight - labelHeight - padding * 2),
  );
  const labelCanvasHeight = Math.min(
    canvasHeight,
    Math.max(labelHeight + padding * 2, canvasHeight - reservedBottom),
  );
  const occupied = [];

  const makeBox = ({ kind, axis, text, color, anchor }, candidate, minimumWidth) => {
    const width = Math.min(
      Math.max(minimumWidth * scale, measureText(text) + 12 * scale),
      Math.max(1, canvasWidth - padding * 2),
    );
    return {
      kind,
      axis,
      text,
      color,
      anchor,
      ...clampLabelBox(candidate, width, labelHeight, canvasWidth, labelCanvasHeight, padding),
    };
  };

  const activeConfig = LOCATOR_AXES[geometry.activeAxis];
  const activeText = compact
    ? `${activeConfig.plane} • ${activeConfig.slice} ${geometry.positions[geometry.activeAxis]}`
    : geometry.activePlaneLabel;
  const activePlane = geometry.planes.find((plane) => plane.active);
  const header = makeBox({
    kind: 'active',
    axis: geometry.activeAxis,
    text: activeText,
    color: activePlane?.color || '#ffffff',
    anchor: null,
  }, { left: padding, top: padding }, compact ? 54 : 66);
  occupied.push(header);

  const labels = geometry.intersectionLines.reduce((result, line) => {
    const endpoint = line.points.reduce((farthest, point) => {
      const distance = Math.hypot(point.x - geometry.center.x, point.y - geometry.center.y);
      return distance > farthest.distance ? { point, distance } : farthest;
    }, { point: line.points[0], distance: -1 }).point;
    const text = compact
      ? `${LOCATOR_AXES[line.axis].slice} ${geometry.positions[line.axis]}`
      : line.label;
    const labelDefinition = {
      kind: 'axis', axis: line.axis, text, color: line.color, anchor: endpoint,
    };
    const provisional = makeBox(labelDefinition, { left: 0, top: 0 }, veryCompact ? 30 : compact ? 38 : 66);
    const offset = 7 * scale;
    const directCandidates = [
      { left: endpoint.x + offset, top: endpoint.y + offset },
      { left: endpoint.x + offset, top: endpoint.y - provisional.height - offset },
      { left: endpoint.x - provisional.width - offset, top: endpoint.y + offset },
      { left: endpoint.x - provisional.width - offset, top: endpoint.y - provisional.height - offset },
    ];
    const slotCandidates = [];
    const slotStep = provisional.height + gap;
    for (let top = padding; top <= labelCanvasHeight - provisional.height - padding; top += slotStep) {
      slotCandidates.push({ left: canvasWidth - provisional.width - padding, top });
      slotCandidates.push({ left: padding, top });
    }
    const candidates = [...directCandidates, ...slotCandidates]
      .map((candidate) => makeBox(labelDefinition, candidate, veryCompact ? 30 : compact ? 38 : 66))
      .filter((candidate) => !occupied.some((box) => boxesOverlap(candidate, box, gap)))
      .sort((left, right) => {
        const leftDistance = Math.hypot(left.left + left.width / 2 - endpoint.x, left.top + left.height / 2 - endpoint.y);
        const rightDistance = Math.hypot(right.left + right.width / 2 - endpoint.x, right.top + right.height / 2 - endpoint.y);
        return leftDistance - rightDistance;
      });
    const label = candidates[0];
    if (!label) return result;
    occupied.push(label);
    result.push(label);
    return result;
  }, []);

  return { compact, reservedBottom, boxes: [header, ...labels] };
}

export function getPt3SliceLocatorDescription(geometry) {
  return `Active plane ${geometry.activePlaneLabel}. `
    + `X ${geometry.positions.sagittal} / ${Math.max(0, geometry.metadata.dimensions[0] - 1)}; `
    + `Y ${geometry.positions.coronal} / ${Math.max(0, geometry.metadata.dimensions[1] - 1)}; `
    + `Z ${geometry.positions.axial} / ${Math.max(0, geometry.metadata.dimensions[2] - 1)}.`;
}

function tracePoints(ctx, points, close = false) {
  if (!points.length) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
  if (close) ctx.closePath();
}

function drawOutlinedPath(ctx, points, color, width, close = false, displayScale = 1) {
  tracePoints(ctx, points, close);
  ctx.strokeStyle = 'rgba(2, 6, 23, 0.94)';
  ctx.lineWidth = (width + 3) * displayScale;
  ctx.stroke();
  tracePoints(ctx, points, close);
  ctx.strokeStyle = color;
  ctx.lineWidth = width * displayScale;
  ctx.stroke();
}

function drawLabel(ctx, label, displayScale = 1) {
  const { left, top, width, height, text, color } = label;
  ctx.fillStyle = 'rgba(2, 6, 23, 0.88)';
  ctx.fillRect(left, top, width, height);
  ctx.fillStyle = color;
  ctx.font = `600 ${11 * displayScale}px system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + 6 * displayScale, top + height / 2);
}

function drawLabelCallout(ctx, label, displayScale = 1) {
  if (!label.anchor) return;
  const destination = closestPointOnBox(label.anchor, label);
  if (Math.hypot(destination.x - label.anchor.x, destination.y - label.anchor.y) <= 3 * displayScale) return;
  drawOutlinedPath(ctx, [label.anchor, destination], label.color, 1, false, displayScale);
}

export function drawPt3SliceLocator(ctx, options = {}) {
  if (!ctx) return null;
  const geometry = buildPt3SliceLocatorGeometry(options);
  const cssWidth = Number(ctx.canvas?.clientWidth);
  const displayScale = clamp(
    options.displayScale,
    0.5,
    4,
    Number.isFinite(cssWidth) && cssWidth > 0 ? geometry.width / cssWidth : 1,
  );
  ctx.save?.();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const activePlane = geometry.planes.find((plane) => plane.active);
  if (activePlane) {
    tracePoints(ctx, activePlane.points, true);
    ctx.fillStyle = `${activePlane.color}30`;
    ctx.fill();
  }
  geometry.planes.forEach((plane) => {
    drawOutlinedPath(ctx, plane.points, plane.color, plane.active ? 2.5 : 1.25, true, displayScale);
  });
  geometry.intersectionLines.forEach((line) => {
    drawOutlinedPath(ctx, line.points, line.color, 2.5, false, displayScale);
  });

  ctx.beginPath();
  ctx.arc(geometry.center.x, geometry.center.y, 6 * displayScale, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(2, 6, 23, 0.96)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(geometry.center.x, geometry.center.y, 3.25 * displayScale, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();

  const labelLayout = layoutPt3SliceLocatorLabels(geometry, {
    displayScale,
    measureText: (text) => {
      ctx.font = `600 ${11 * displayScale}px system-ui, sans-serif`;
      return typeof ctx.measureText === 'function'
        ? ctx.measureText(text).width
        : text.length * 6.4 * displayScale;
    },
  });
  labelLayout.boxes.forEach((label) => drawLabelCallout(ctx, label, displayScale));
  labelLayout.boxes.forEach((label) => drawLabel(ctx, label, displayScale));
  ctx.restore?.();
  return { ...geometry, labelLayout };
}

export { LOCATOR_AXES as PT3_SLICE_LOCATOR_AXES };
