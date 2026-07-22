import {
  createPt3PerspectiveProjector,
  normalizeVolumeMetadata,
  voxelToPhysical,
} from './pt3VolumeGeometry';

export const MAX_VECTOR_ANNOTATIONS = 64;
export const MAX_VECTOR_AREAS = 64;
export const MAX_VECTOR_POINTS = 10_000;
export const MAX_VECTOR_MASK_RUNS = 50_000;
export const MAX_SEGMENT_MASK_RECTANGLES = 50_000;
export const MAX_VECTOR_PRIMITIVES = 512;
export const MAX_VECTOR_FACES = 8192;
export const MAX_VECTOR_RASTER_ROWS = 512;
export const MAX_SEGMENT_BOOLEAN_OPERATIONS = 4_000_000;

const DEFAULT_VECTOR_COLOR = '#22d3ee';
const DEFAULT_VECTOR_OPACITY = 0.24;
const CIRCLE_POINT_COUNT = 32;
const VALID_AXES = new Set(['axial', 'coronal', 'sagittal']);
const segmentMaskCache = new WeakMap();
const segmentMaskPathCache = new WeakMap();

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteNumber(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function finitePoint(value) {
  const x = finiteNumber(Array.isArray(value) ? value[0] : value?.x);
  const y = finiteNumber(Array.isArray(value) ? value[1] : value?.y);
  return x === null || y === null ? null : { x, y };
}

function normalizeColor(value) {
  const color = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(color)) return color;
  if (/^#[0-9a-f]{3}$/i.test(color)) {
    return `#${color.slice(1).split('').map((channel) => `${channel}${channel}`).join('')}`;
  }
  return DEFAULT_VECTOR_COLOR;
}

function colorToRgb(color) {
  const normalized = normalizeColor(color).slice(1);
  return [
    Number.parseInt(normalized.slice(0, 2), 16),
    Number.parseInt(normalized.slice(2, 4), 16),
    Number.parseInt(normalized.slice(4, 6), 16),
  ];
}

function scaleSourceCoordinate(value, sourceLength, targetLength) {
  const sourceExtent = Math.max(Number.EPSILON, Number(sourceLength) || 1);
  const targetExtent = Math.max(1, Number(targetLength) || 1);
  const fraction = clamp(Number(value) || 0, 0, sourceExtent) / sourceExtent;
  // Persisted SVG/source-pixel coordinates describe continuous image
  // boundaries in [0, imageLength]. Voxel faces use [-0.5, length - 0.5].
  return (fraction * targetExtent) - 0.5;
}

function getAxisDimension(axis, dimensions) {
  if (axis === 'sagittal') return dimensions[0];
  if (axis === 'coronal') return dimensions[1];
  return dimensions[2];
}

function mapPlanePointAtSlice({
  axis,
  point,
  sliceCoordinate,
  imageWidth,
  imageHeight,
  dimensions,
  allowBoundary = false,
}) {
  const normalizedPoint = finitePoint(point);
  if (!normalizedPoint || !VALID_AXES.has(axis)) return null;
  const sourceWidth = Math.max(1, finiteNumber(imageWidth, 1));
  const sourceHeight = Math.max(1, finiteNumber(imageHeight, 1));
  const constantDimension = getAxisDimension(axis, dimensions);
  const constantMinimum = allowBoundary ? -0.5 : 0;
  const constantMaximum = allowBoundary
    ? Math.max(0.5, constantDimension - 0.5)
    : Math.max(0, constantDimension - 1);
  const slice = clamp(
    finiteNumber(sliceCoordinate, 0),
    constantMinimum,
    constantMaximum,
  );

  if (axis === 'coronal') {
    const x = scaleSourceCoordinate(normalizedPoint.x, sourceWidth, dimensions[0]);
    const displayedZ = scaleSourceCoordinate(normalizedPoint.y, sourceHeight, dimensions[2]);
    return [x, slice, Math.max(0, dimensions[2] - 1) - displayedZ];
  }
  if (axis === 'sagittal') {
    const y = scaleSourceCoordinate(normalizedPoint.x, sourceWidth, dimensions[1]);
    const displayedZ = scaleSourceCoordinate(normalizedPoint.y, sourceHeight, dimensions[2]);
    return [slice, y, Math.max(0, dimensions[2] - 1) - displayedZ];
  }
  return [
    scaleSourceCoordinate(normalizedPoint.x, sourceWidth, dimensions[0]),
    scaleSourceCoordinate(normalizedPoint.y, sourceHeight, dimensions[1]),
    slice,
  ];
}

export function mapVectorPlanePointToVoxel({
  axis,
  point,
  sliceIndex,
  imageWidth,
  imageHeight,
  dimensions,
}) {
  const normalizedDimensions = normalizeVolumeMetadata({ dimensions }).dimensions;
  return mapPlanePointAtSlice({
    axis,
    point,
    sliceCoordinate: sliceIndex,
    imageWidth,
    imageHeight,
    dimensions: normalizedDimensions,
  });
}

export function getInclusiveVectorSliceRange({ axis, minSlice, maxSlice, dimensions }) {
  const normalizedDimensions = normalizeVolumeMetadata({ dimensions }).dimensions;
  if (!VALID_AXES.has(axis)) return null;
  const axisLength = getAxisDimension(axis, normalizedDimensions);
  const lowerCandidate = Math.round(finiteNumber(minSlice, 0));
  const upperCandidate = Math.round(finiteNumber(maxSlice, lowerCandidate));
  const minCenter = clamp(Math.min(lowerCandidate, upperCandidate), 0, axisLength - 1);
  const maxCenter = clamp(Math.max(lowerCandidate, upperCandidate), 0, axisLength - 1);
  return {
    minSlice: minCenter,
    maxSlice: maxCenter,
    lowerFace: minCenter - 0.5,
    upperFace: maxCenter + 0.5,
  };
}

function boundedPoints(points) {
  const source = Array.isArray(points) ? points : [];
  if (source.length <= MAX_VECTOR_POINTS) return source.map(finitePoint).filter(Boolean);
  const result = [];
  const lastIndex = source.length - 1;
  for (let index = 0; index < MAX_VECTOR_POINTS; index += 1) {
    const sourceIndex = Math.round((index / (MAX_VECTOR_POINTS - 1)) * lastIndex);
    const point = finitePoint(source[sourceIndex]);
    if (point) result.push(point);
  }
  return result;
}

function rectangleFromBounds(x1, y1, x2, y2) {
  const values = [x1, y1, x2, y2].map((value) => finiteNumber(value));
  if (values.some((value) => value === null)) return null;
  const left = Math.min(values[0], values[2]);
  const right = Math.max(values[0], values[2]);
  const top = Math.min(values[1], values[3]);
  const bottom = Math.max(values[1], values[3]);
  if (right <= left || bottom <= top) return null;
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

function polygonFromBbox(bbox) {
  if (Array.isArray(bbox) && bbox.length >= 4) {
    return rectangleFromBounds(bbox[0], bbox[1], bbox[2], bbox[3]);
  }
  if (!bbox || typeof bbox !== 'object') return null;
  const x = finiteNumber(bbox.x ?? bbox.left);
  const y = finiteNumber(bbox.y ?? bbox.top);
  const width = finiteNumber(bbox.width);
  const height = finiteNumber(bbox.height);
  if (x !== null && y !== null && width !== null && height !== null) {
    return rectangleFromBounds(x, y, x + width, y + height);
  }
  return rectangleFromBounds(
    bbox.left,
    bbox.top,
    bbox.right,
    bbox.bottom,
  );
}

function polygonFromRectangle(area) {
  const start = finitePoint(area?.start);
  const end = finitePoint(area?.end);
  if (start && end) return rectangleFromBounds(start.x, start.y, end.x, end.y);
  return polygonFromBbox(area?.bbox || area);
}

function polygonFromCircle(area) {
  const center = finitePoint(area?.center || area?.seed);
  if (!center) return null;
  const edge = finitePoint(area?.edge);
  const radius = finiteNumber(area?.radius, edge ? Math.hypot(edge.x - center.x, edge.y - center.y) : 0);
  if (!(radius > 0)) return null;
  return Array.from({ length: CIRCLE_POINT_COUNT }, (_unused, index) => {
    const angle = (index / CIRCLE_POINT_COUNT) * Math.PI * 2;
    return {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    };
  });
}

function polygonFromBrush(area) {
  const points = boundedPoints(area?.points);
  const radius = Math.max(0.25, finiteNumber(area?.brushSize ?? area?.brush_size ?? area?.width, 1) / 2);
  if (points.length === 0) return null;
  if (points.length === 1) return polygonFromCircle({ center: points[0], radius });
  const left = [];
  const right = [];
  points.forEach((point, index) => {
    const previous = points[Math.max(0, index - 1)];
    const next = points[Math.min(points.length - 1, index + 1)];
    const deltaX = next.x - previous.x;
    const deltaY = next.y - previous.y;
    const length = Math.hypot(deltaX, deltaY) || 1;
    const normalX = (-deltaY / length) * radius;
    const normalY = (deltaX / length) * radius;
    left.push({ x: point.x + normalX, y: point.y + normalY });
    right.push({ x: point.x - normalX, y: point.y - normalY });
  });
  return [...left, ...right.reverse()];
}

function normalizeMaskRun(run, area, imageHeight) {
  const y = finiteNumber(Array.isArray(run) ? run[0] : run?.y ?? run?.row);
  const start = finiteNumber(Array.isArray(run) ? run[1] : run?.start ?? run?.x1 ?? run?.x);
  const end = finiteNumber(Array.isArray(run) ? run[2] : run?.end ?? run?.x2, start === null ? null : start + 1);
  if (y === null || start === null || end === null || end <= start) return null;
  const explicitHeight = finiteNumber(
    Array.isArray(run) ? run[3] : run?.height ?? run?.rowHeight ?? run?.row_height,
  );
  const canvasHeight = finiteNumber(area?.canvasHeight ?? area?.canvas_height);
  const inferredHeight = canvasHeight > 0
    ? Math.max(Number.EPSILON, imageHeight / canvasHeight)
    : 1;
  return rectangleFromBounds(start, y, end, y + (explicitHeight > 0 ? explicitHeight : inferredHeight));
}

function makeMaskRectangle(x0, y0, x1, y1, imageWidth, imageHeight) {
  const values = [x0, y0, x1, y1].map((value) => finiteNumber(value));
  if (values.some((value) => value === null)) return null;
  const left = clamp(Math.min(values[0], values[2]), 0, imageWidth);
  const right = clamp(Math.max(values[0], values[2]), 0, imageWidth);
  const top = clamp(Math.min(values[1], values[3]), 0, imageHeight);
  const bottom = clamp(Math.max(values[1], values[3]), 0, imageHeight);
  if (right - left <= Number.EPSILON || bottom - top <= Number.EPSILON) return null;
  return { x0: left, y0: top, x1: right, y1: bottom };
}

function polygonBoundsToMaskRectangle(polygon, imageWidth, imageHeight) {
  if (!Array.isArray(polygon) || polygon.length !== 4) return null;
  const xs = [...new Set(polygon.map((point) => finiteNumber(point?.x)))];
  const ys = [...new Set(polygon.map((point) => finiteNumber(point?.y)))];
  if (xs.some((value) => value === null) || ys.some((value) => value === null)) return null;
  if (xs.length !== 2 || ys.length !== 2) return null;
  return makeMaskRectangle(xs[0], ys[0], xs[1], ys[1], imageWidth, imageHeight);
}

function mergeIntervals(intervals) {
  const sorted = intervals
    .filter((interval) => interval && interval[1] - interval[0] > Number.EPSILON)
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  sorted.forEach(([start, end]) => {
    const previous = merged[merged.length - 1];
    if (previous && start <= previous[1] + Number.EPSILON) {
      previous[1] = Math.max(previous[1], end);
    } else {
      merged.push([start, end]);
    }
  });
  return merged;
}

function polygonIntervalsAtY(polygon, y) {
  if (!Array.isArray(polygon) || polygon.length < 3) return [];
  const intersections = [];
  polygon.forEach((point, index) => {
    const next = polygon[(index + 1) % polygon.length];
    if (!point || !next || point.y === next.y) return;
    const crosses = (point.y <= y && next.y > y) || (next.y <= y && point.y > y);
    if (!crosses) return;
    const fraction = (y - point.y) / (next.y - point.y);
    intersections.push(point.x + ((next.x - point.x) * fraction));
  });
  intersections.sort((left, right) => left - right);
  const intervals = [];
  for (let index = 0; index + 1 < intersections.length; index += 2) {
    intervals.push([intersections[index], intersections[index + 1]]);
  }
  return intervals;
}

function mergeAdjacentMaskRectangles(rectangles) {
  let result = rectangles.filter(Boolean);
  for (let pass = 0; pass < 3; pass += 1) {
    const horizontal = [];
    const horizontalGroups = new Map();
    result.forEach((rectangle) => {
      const key = `${rectangle.y0}:${rectangle.y1}`;
      if (!horizontalGroups.has(key)) horizontalGroups.set(key, []);
      horizontalGroups.get(key).push(rectangle);
    });
    horizontalGroups.forEach((group) => {
      group.sort((left, right) => left.x0 - right.x0 || left.x1 - right.x1);
      group.forEach((rectangle) => {
        const previous = horizontal[horizontal.length - 1];
        if (
          previous
          && previous.y0 === rectangle.y0
          && previous.y1 === rectangle.y1
          && rectangle.x0 <= previous.x1 + Number.EPSILON
        ) {
          previous.x1 = Math.max(previous.x1, rectangle.x1);
        } else {
          horizontal.push({ ...rectangle });
        }
      });
    });

    const vertical = [];
    const verticalGroups = new Map();
    horizontal.forEach((rectangle) => {
      const key = `${rectangle.x0}:${rectangle.x1}`;
      if (!verticalGroups.has(key)) verticalGroups.set(key, []);
      verticalGroups.get(key).push(rectangle);
    });
    verticalGroups.forEach((group) => {
      group.sort((left, right) => left.y0 - right.y0 || left.y1 - right.y1);
      group.forEach((rectangle) => {
        const previous = vertical[vertical.length - 1];
        if (
          previous
          && previous.x0 === rectangle.x0
          && previous.x1 === rectangle.x1
          && rectangle.y0 <= previous.y1 + Number.EPSILON
        ) {
          previous.y1 = Math.max(previous.y1, rectangle.y1);
        } else {
          vertical.push({ ...rectangle });
        }
      });
    });
    if (vertical.length === result.length) return vertical;
    result = vertical;
  }
  return result;
}

function rasterizePolygons(polygons, imageWidth, imageHeight, maxRectangles) {
  const finitePolygons = polygons.filter((polygon) => Array.isArray(polygon) && polygon.length >= 3);
  if (finitePolygons.length === 0) return { rectangles: [], truncated: false };
  const yCoordinates = finitePolygons.flatMap((polygon) => polygon.map((point) => finiteNumber(point?.y)).filter((value) => value !== null));
  if (yCoordinates.length === 0) return { rectangles: [], truncated: false };
  const rowCount = Math.max(1, Math.min(MAX_VECTOR_RASTER_ROWS, Math.ceil(imageHeight)));
  const rowHeight = imageHeight / rowCount;
  const firstRow = clamp(Math.floor(Math.min(...yCoordinates) / rowHeight), 0, rowCount - 1);
  const lastRow = clamp(Math.ceil(Math.max(...yCoordinates) / rowHeight) - 1, 0, rowCount - 1);
  const rectangles = [];
  let truncated = false;
  for (let row = firstRow; row <= lastRow; row += 1) {
    const y0 = row * rowHeight;
    const y1 = Math.min(imageHeight, (row + 1) * rowHeight);
    const y = (y0 + y1) / 2;
    const intervals = mergeIntervals(finitePolygons.flatMap((polygon) => polygonIntervalsAtY(polygon, y)));
    for (const interval of intervals) {
      const rectangle = makeMaskRectangle(interval[0], y0, interval[1], y1, imageWidth, imageHeight);
      if (!rectangle) continue;
      if (rectangles.length >= maxRectangles) {
        truncated = true;
        break;
      }
      rectangles.push(rectangle);
    }
    if (truncated) break;
  }
  return { rectangles: mergeAdjacentMaskRectangles(rectangles), truncated };
}

function getAreaMaskRectangles(area, imageWidth, imageHeight, remainingMaskRuns, maxRectangles) {
  const tool = String(area?.tool || area?.type || area?.shape || '').trim().toLowerCase();
  const maskRuns = Array.isArray(area?.maskRuns)
    ? area.maskRuns
    : (Array.isArray(area?.mask_runs) ? area.mask_runs : []);
  if (maskRuns.length > 0) {
    if (maskRuns.length > remainingMaskRuns || maskRuns.length > maxRectangles) {
      const conservativeCoverage = polygonBoundsToMaskRectangle(
        polygonFromBbox(area?.bbox),
        imageWidth,
        imageHeight,
      ) || makeMaskRectangle(0, 0, imageWidth, imageHeight, imageWidth, imageHeight);
      return {
        rectangles: [conservativeCoverage].filter(Boolean),
        maskRunsRead: Math.min(maskRuns.length, remainingMaskRuns),
        approximated: true,
        truncated: true,
      };
    }
    return {
      rectangles: maskRuns.map((run) => {
        const polygon = normalizeMaskRun(run, area, imageHeight);
        return polygonBoundsToMaskRectangle(polygon, imageWidth, imageHeight);
      }).filter(Boolean),
      maskRunsRead: maskRuns.length,
      approximated: false,
      truncated: false,
    };
  }

  if (tool === 'rectangle' || tool === 'rect') {
    const rectangle = polygonBoundsToMaskRectangle(polygonFromRectangle(area), imageWidth, imageHeight);
    return { rectangles: [rectangle].filter(Boolean), maskRunsRead: 0, approximated: false, truncated: false };
  }
  if (tool === 'connected' || tool === 'ml-helper' || area?.bbox) {
    const rectangle = polygonBoundsToMaskRectangle(polygonFromBbox(area?.bbox), imageWidth, imageHeight);
    return { rectangles: [rectangle].filter(Boolean), maskRunsRead: 0, approximated: false, truncated: false };
  }

  let polygons = [];
  let inputTruncated = false;
  if (tool === 'circle') {
    polygons = [polygonFromCircle(area)].filter(Boolean);
  } else if (tool === 'polygon') {
    const sourcePoints = Array.isArray(area?.points) ? area.points : [];
    const polygon = boundedPoints(sourcePoints);
    polygons = polygon.length >= 3 ? [polygon] : [];
    inputTruncated = sourcePoints.length > MAX_VECTOR_POINTS;
  } else if (tool === 'brush' || tool === 'eraser' || tool === 'scissors') {
    const sourcePoints = Array.isArray(area?.points) ? area.points : [];
    const points = boundedPoints(sourcePoints);
    polygons = [polygonFromBrush({ ...area, points })].filter(Boolean);
    const radius = Math.max(0.25, finiteNumber(area?.brushSize ?? area?.brush_size ?? area?.width, 1) / 2);
    [points[0], points[points.length - 1]].filter(Boolean).forEach((point) => {
      const cap = polygonFromCircle({ center: point, radius });
      if (cap) polygons.push(cap);
    });
    inputTruncated = sourcePoints.length > MAX_VECTOR_POINTS;
  } else if (['threshold', 'level-trace'].includes(tool) && area?.seed) {
    const radius = Math.max(0.25, finiteNumber(area?.radius ?? area?.sensitivity, 20));
    polygons = [polygonFromCircle({ center: area.seed, radius })].filter(Boolean);
  }
  const rasterized = rasterizePolygons(polygons, imageWidth, imageHeight, maxRectangles);
  if (rasterized.truncated) {
    const points = polygons.flat();
    const xs = points.map((point) => finiteNumber(point?.x)).filter((value) => value !== null);
    const ys = points.map((point) => finiteNumber(point?.y)).filter((value) => value !== null);
    const conservativeCoverage = xs.length > 0 && ys.length > 0
      ? makeMaskRectangle(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), imageWidth, imageHeight)
      : makeMaskRectangle(0, 0, imageWidth, imageHeight, imageWidth, imageHeight);
    return {
      rectangles: [conservativeCoverage].filter(Boolean),
      maskRunsRead: 0,
      approximated: true,
      truncated: true,
    };
  }
  return {
    ...rasterized,
    maskRunsRead: 0,
    approximated: false,
    truncated: inputTruncated || rasterized.truncated,
  };
}

function getMaskRectanglesBounds(rectangles, imageWidth, imageHeight) {
  if (!Array.isArray(rectangles) || rectangles.length === 0) return null;
  let x0 = imageWidth;
  let y0 = imageHeight;
  let x1 = 0;
  let y1 = 0;
  rectangles.forEach((rectangle) => {
    x0 = Math.min(x0, rectangle.x0);
    y0 = Math.min(y0, rectangle.y0);
    x1 = Math.max(x1, rectangle.x1);
    y1 = Math.max(y1, rectangle.y1);
  });
  return makeMaskRectangle(x0, y0, x1, y1, imageWidth, imageHeight);
}

function subtractMergedIntervals(occupied, cutters) {
  const result = [];
  let firstRelevantCutter = 0;
  occupied.forEach(([occupiedStart, occupiedEnd]) => {
    let cursor = occupiedStart;
    while (
      firstRelevantCutter < cutters.length
      && cutters[firstRelevantCutter][1] <= cursor + Number.EPSILON
    ) {
      firstRelevantCutter += 1;
    }
    for (let index = firstRelevantCutter; index < cutters.length; index += 1) {
      const [cutterStart, cutterEnd] = cutters[index];
      if (cutterStart >= occupiedEnd - Number.EPSILON) break;
      if (cutterStart > cursor + Number.EPSILON) {
        result.push([cursor, Math.min(cutterStart, occupiedEnd)]);
      }
      cursor = Math.max(cursor, cutterEnd);
      if (cursor >= occupiedEnd - Number.EPSILON) break;
    }
    if (cursor < occupiedEnd - Number.EPSILON) result.push([cursor, occupiedEnd]);
  });
  return result;
}

function addMaskSweepEvent(events, y, field, value) {
  if (!events.has(y)) {
    events.set(y, {
      occupiedStarts: [],
      occupiedEnds: [],
      incomingStarts: [],
      incomingEnds: [],
    });
  }
  events.get(y)[field].push(value);
}

function addMaskRectangleSweepEvents(events, rectangles, prefix) {
  rectangles.forEach((rectangle, index) => {
    addMaskSweepEvent(events, rectangle.y0, `${prefix}Starts`, [index, rectangle.x0, rectangle.x1]);
    addMaskSweepEvent(events, rectangle.y1, `${prefix}Ends`, index);
  });
}

/**
 * Composites two rectangle/RLE masks with a vertical plane sweep.
 *
 * Connected-component masks commonly contain thousands of one-row runs. A
 * rectangle-by-rectangle Boolean creates a Cartesian N*M workload for those
 * masks even though each row only intersects a handful of runs. The sweep
 * instead merges active x intervals once per y band, so its work follows the
 * actual scanline complexity while preserving ordered add/subtract semantics.
 */
function compositeMaskRectangles({
  occupied,
  incoming,
  subtract,
  maxRectangles,
  operationBudget,
}) {
  const events = new Map();
  addMaskRectangleSweepEvents(events, occupied, 'occupied');
  addMaskRectangleSweepEvents(events, incoming, 'incoming');
  const yCoordinates = [...events.keys()].sort((left, right) => left - right);
  const activeOccupied = new Map();
  const activeIncoming = new Map();
  const rectangles = [];
  let previousBandRectangles = new Map();
  let booleanOperations = 0;

  const consumeWork = (amount) => {
    if (booleanOperations + amount > operationBudget) return false;
    booleanOperations += amount;
    return true;
  };

  for (let index = 0; index + 1 < yCoordinates.length; index += 1) {
    const y0 = yCoordinates[index];
    const y1 = yCoordinates[index + 1];
    const event = events.get(y0);
    event.occupiedEnds.forEach((rectangleIndex) => activeOccupied.delete(rectangleIndex));
    event.incomingEnds.forEach((rectangleIndex) => activeIncoming.delete(rectangleIndex));
    event.occupiedStarts.forEach(([rectangleIndex, x0, x1]) => {
      activeOccupied.set(rectangleIndex, [x0, x1]);
    });
    event.incomingStarts.forEach(([rectangleIndex, x0, x1]) => {
      activeIncoming.set(rectangleIndex, [x0, x1]);
    });
    if (y1 - y0 <= Number.EPSILON) continue;

    // Check before sorting so pathological sets of tall, heavily overlapping
    // rectangles cannot repeatedly consume unbounded CPU.
    if (!consumeWork(activeOccupied.size + activeIncoming.size)) {
      return { rectangles: occupied, booleanOperations, budgetExceeded: true, rectangleLimitExceeded: false };
    }
    const occupiedIntervals = mergeIntervals([...activeOccupied.values()]);
    const incomingIntervals = mergeIntervals([...activeIncoming.values()]);
    const resultIntervals = subtract
      ? subtractMergedIntervals(occupiedIntervals, incomingIntervals)
      : mergeIntervals([...occupiedIntervals, ...incomingIntervals]);
    if (!consumeWork(occupiedIntervals.length + incomingIntervals.length + resultIntervals.length)) {
      return { rectangles: occupied, booleanOperations, budgetExceeded: true, rectangleLimitExceeded: false };
    }

    const currentBandRectangles = new Map();
    for (const [x0, x1] of resultIntervals) {
      const intervalKey = `${x0}:${x1}`;
      const previous = previousBandRectangles.get(intervalKey);
      if (previous && Math.abs(previous.y1 - y0) <= Number.EPSILON) {
        previous.y1 = y1;
        currentBandRectangles.set(intervalKey, previous);
        continue;
      }
      if (rectangles.length >= maxRectangles) {
        return { rectangles: occupied, booleanOperations, budgetExceeded: false, rectangleLimitExceeded: true };
      }
      const rectangle = { x0, y0, x1, y1 };
      rectangles.push(rectangle);
      currentBandRectangles.set(intervalKey, rectangle);
    }
    previousBandRectangles = currentBandRectangles;
  }

  return {
    rectangles,
    booleanOperations,
    budgetExceeded: false,
    rectangleLimitExceeded: false,
  };
}

export function buildPt3SegmentMask(segment, options = {}) {
  const cacheable = segment && typeof segment === 'object' && Object.keys(options).length === 0;
  if (cacheable && segmentMaskCache.has(segment)) return segmentMaskCache.get(segment);
  const imageWidth = Math.max(1, finiteNumber(segment?.imageWidth ?? segment?.image_width, 1));
  const imageHeight = Math.max(1, finiteNumber(segment?.imageHeight ?? segment?.image_height, 1));
  const maxAreas = Math.max(0, Math.min(MAX_VECTOR_AREAS, Math.floor(finiteNumber(options.maxAreas, MAX_VECTOR_AREAS))));
  const maxMaskRuns = Math.max(0, Math.min(MAX_VECTOR_MASK_RUNS, Math.floor(finiteNumber(options.maxMaskRuns, MAX_VECTOR_MASK_RUNS))));
  const maxRectangles = Math.max(0, Math.min(
    MAX_SEGMENT_MASK_RECTANGLES,
    Math.floor(finiteNumber(options.maxRectangles, MAX_SEGMENT_MASK_RECTANGLES)),
  ));
  const maxBooleanOperations = Math.max(0, Math.min(
    MAX_SEGMENT_BOOLEAN_OPERATIONS,
    Math.floor(finiteNumber(options.maxBooleanOperations, MAX_SEGMENT_BOOLEAN_OPERATIONS)),
  ));
  const stats = {
    areasRead: 0,
    addAreasApplied: 0,
    subtractAreasApplied: 0,
    maskRunsRead: 0,
    rectanglesBuilt: 0,
    booleanOperations: 0,
    approximated: false,
    truncated: false,
  };
  if (segment?.visible === false || segment?.hidden === true || maxRectangles === 0) {
    const emptyResult = { imageWidth, imageHeight, rectangles: [], stats };
    if (cacheable) segmentMaskCache.set(segment, emptyResult);
    return emptyResult;
  }
  const areas = Array.isArray(segment?.areas) ? segment.areas : [];
  let occupied = [];
  let booleanOperations = 0;
  for (const area of areas) {
    if (stats.areasRead >= maxAreas) {
      stats.truncated = true;
      break;
    }
    stats.areasRead += 1;
    const remainingMaskRuns = Math.max(0, maxMaskRuns - stats.maskRunsRead);
    const areaMask = getAreaMaskRectangles(
      area,
      imageWidth,
      imageHeight,
      remainingMaskRuns,
      maxRectangles,
    );
    stats.maskRunsRead += areaMask.maskRunsRead;
    if (areaMask.approximated) stats.approximated = true;
    if (areaMask.truncated) stats.truncated = true;
    const subtract = area?.operation === 'subtract' || area?.tool === 'eraser';
    if (subtract) stats.subtractAreasApplied += 1;
    else stats.addAreasApplied += 1;
    if (!subtract && occupied.length === 0) {
      occupied = mergeAdjacentMaskRectangles(areaMask.rectangles);
      if (occupied.length > maxRectangles) {
        occupied = [makeMaskRectangle(0, 0, imageWidth, imageHeight, imageWidth, imageHeight)].filter(Boolean);
        stats.approximated = true;
        stats.truncated = true;
      }
    } else {
      const composited = compositeMaskRectangles({
        occupied,
        incoming: areaMask.rectangles,
        subtract,
        maxRectangles,
        operationBudget: Math.max(0, maxBooleanOperations - booleanOperations),
      });
      booleanOperations += composited.booleanOperations;
      if (composited.budgetExceeded || composited.rectangleLimitExceeded) {
        // Keep adversarial inputs bounded and surface the approximation in the
        // public stats. Adds conservatively cover both masks; subtracts retain
        // the prior mask rather than erasing unverified pixels.
        if (!subtract && areaMask.rectangles.length > 0) {
          const existingCoverage = getMaskRectanglesBounds(occupied, imageWidth, imageHeight);
          const addedCoverage = getMaskRectanglesBounds(areaMask.rectangles, imageWidth, imageHeight);
          if (existingCoverage && addedCoverage) {
            occupied = [makeMaskRectangle(
              Math.min(existingCoverage.x0, addedCoverage.x0),
              Math.min(existingCoverage.y0, addedCoverage.y0),
              Math.max(existingCoverage.x1, addedCoverage.x1),
              Math.max(existingCoverage.y1, addedCoverage.y1),
              imageWidth,
              imageHeight,
            )].filter(Boolean);
          }
        }
        stats.approximated = true;
        stats.truncated = true;
      } else {
        occupied = composited.rectangles;
      }
    }
    occupied = mergeAdjacentMaskRectangles(occupied).slice(0, maxRectangles);
  }
  stats.booleanOperations = booleanOperations;
  stats.rectanglesBuilt = occupied.length;
  const result = { imageWidth, imageHeight, rectangles: occupied, stats };
  if (cacheable) segmentMaskCache.set(segment, result);
  return result;
}

export function pt3SegmentMaskContainsPoint(mask, x, y) {
  const pointX = finiteNumber(x);
  const pointY = finiteNumber(y);
  if (pointX === null || pointY === null) return false;
  return (mask?.rectangles || []).some((rectangle) => (
    pointX >= rectangle.x0
    && pointX < rectangle.x1
    && pointY >= rectangle.y0
    && pointY < rectangle.y1
  ));
}

export function pt3SegmentMaskToSvgPath(mask) {
  if (mask && typeof mask === 'object' && segmentMaskPathCache.has(mask)) {
    return segmentMaskPathCache.get(mask);
  }
  const path = (mask?.rectangles || []).map((rectangle) => (
    `M ${rectangle.x0} ${rectangle.y0} H ${rectangle.x1} V ${rectangle.y1} H ${rectangle.x0} Z`
  )).join(' ');
  if (mask && typeof mask === 'object') segmentMaskPathCache.set(mask, path);
  return path;
}

function makeEmptyBuildResult() {
  return {
    faces: [],
    stats: {
      annotationsRead: 0,
      areasRead: 0,
      addAreasApplied: 0,
      subtractAreasApplied: 0,
      primitivesBuilt: 0,
      maskRunsRead: 0,
      maskRectanglesRead: 0,
      maskApproximated: 0,
      facesBuilt: 0,
      // Retained for callers that consumed the earlier diagnostic. Correct
      // compositing means no persisted subtract area is intentionally omitted.
      subtractAreasOmitted: 0,
      truncated: false,
    },
  };
}

function collectSignedBoundarySegments(groups, coordinate, start, end, sign) {
  const key = String(coordinate);
  if (!groups.has(key)) groups.set(key, { coordinate, intervals: [] });
  groups.get(key).intervals.push({ start, end, sign });
}

function resolveSignedBoundaryGroups(groups, orientation) {
  const segments = [];
  groups.forEach(({ coordinate, intervals }) => {
    const events = new Map();
    intervals.forEach(({ start, end, sign }) => {
      events.set(start, (events.get(start) || 0) + sign);
      events.set(end, (events.get(end) || 0) - sign);
    });
    const coordinates = [...events.keys()].sort((left, right) => left - right);
    let coverage = 0;
    coordinates.forEach((position, index) => {
      coverage += events.get(position) || 0;
      const next = coordinates[index + 1];
      if (!(next > position) || coverage === 0) return;
      const sign = coverage > 0 ? 1 : -1;
      const previous = segments[segments.length - 1];
      if (
        previous
        && previous.orientation === orientation
        && previous.coordinate === coordinate
        && previous.sign === sign
        && previous.end === position
      ) {
        previous.end = next;
      } else {
        segments.push({ orientation, coordinate, start: position, end: next, sign });
      }
    });
  });
  return segments;
}

function getMaskBoundarySegments(rectangles) {
  const horizontal = new Map();
  const vertical = new Map();
  rectangles.forEach((rectangle) => {
    collectSignedBoundarySegments(horizontal, rectangle.y0, rectangle.x0, rectangle.x1, -1);
    collectSignedBoundarySegments(horizontal, rectangle.y1, rectangle.x0, rectangle.x1, 1);
    collectSignedBoundarySegments(vertical, rectangle.x0, rectangle.y0, rectangle.y1, -1);
    collectSignedBoundarySegments(vertical, rectangle.x1, rectangle.y0, rectangle.y1, 1);
  });
  return [
    ...resolveSignedBoundaryGroups(horizontal, 'horizontal'),
    ...resolveSignedBoundaryGroups(vertical, 'vertical'),
  ];
}

/**
 * Visits every exact voxel-space polygon represented by a render face.
 *
 * Large RLE masks retain their source rectangles and boundaries in three
 * batched faces (lower, upper, and sides). This keeps render-object counts
 * bounded without merging occupied pixels across holes or narrow gaps.
 */
export function forEachPt3VectorFaceVoxelPolygon(face, callback) {
  if (!face || typeof callback !== 'function') return 0;
  const legacyPolygons = Array.isArray(face.voxelPolygons)
    ? face.voxelPolygons
    : (Array.isArray(face.voxelPoints) ? [face.voxelPoints] : []);
  if (legacyPolygons.length > 0) {
    let visited = 0;
    legacyPolygons.forEach((polygon) => {
      if (!Array.isArray(polygon) || polygon.length < 3) return;
      callback(polygon);
      visited += 1;
    });
    return visited;
  }

  const geometry = face.sourceGeometry;
  const mapping = face.sourceMapping;
  if (!geometry || !mapping) return 0;
  const mapPoint = (point, sliceCoordinate) => mapPlanePointAtSlice({
    axis: mapping.axis,
    point,
    sliceCoordinate,
    imageWidth: mapping.imageWidth,
    imageHeight: mapping.imageHeight,
    dimensions: mapping.dimensions,
    allowBoundary: true,
  });
  let visited = 0;

  if (geometry.kind === 'mask-surface') {
    geometry.rectangles.forEach((rectangle) => {
      const sourcePolygon = [
        { x: rectangle.x0, y: rectangle.y0 },
        { x: rectangle.x1, y: rectangle.y0 },
        { x: rectangle.x1, y: rectangle.y1 },
        { x: rectangle.x0, y: rectangle.y1 },
      ];
      const polygon = sourcePolygon.map((point) => mapPoint(point, geometry.sliceCoordinate));
      if (polygon.some((point) => !point)) return;
      callback(geometry.reverse ? [...polygon].reverse() : polygon);
      visited += 1;
    });
    return visited;
  }

  if (geometry.kind === 'mask-sides') {
    geometry.boundaries.forEach((boundary) => {
      const start = boundary.orientation === 'horizontal'
        ? { x: boundary.start, y: boundary.coordinate }
        : { x: boundary.coordinate, y: boundary.start };
      const end = boundary.orientation === 'horizontal'
        ? { x: boundary.end, y: boundary.coordinate }
        : { x: boundary.coordinate, y: boundary.end };
      const oriented = boundary.sign < 0 ? [end, start] : [start, end];
      const lower = oriented.map((point) => mapPoint(point, geometry.lowerFace));
      const upper = oriented.map((point) => mapPoint(point, geometry.upperFace));
      if (lower.some((point) => !point) || upper.some((point) => !point)) return;
      callback([lower[0], lower[1], upper[1], upper[0]]);
      visited += 1;
    });
  }
  return visited;
}

export function buildPt3VectorAnnotationFaces(vectorAnnotations, metadata, options = {}) {
  const showAnnotations = options.showAnnotations !== false;
  if (!showAnnotations || !Array.isArray(vectorAnnotations) || vectorAnnotations.length === 0) {
    return makeEmptyBuildResult();
  }
  const normalizedMetadata = normalizeVolumeMetadata(metadata);
  const result = makeEmptyBuildResult();
  const annotations = vectorAnnotations.slice(0, MAX_VECTOR_ANNOTATIONS);
  if (vectorAnnotations.length > annotations.length) result.stats.truncated = true;

  const addFace = (face) => {
    if (result.faces.length >= Math.min(MAX_VECTOR_FACES, MAX_VECTOR_PRIMITIVES)) {
      result.stats.truncated = true;
      return false;
    }
    result.faces.push(face);
    return true;
  };

  for (const annotation of annotations) {
    result.stats.annotationsRead += 1;
    if (!annotation || annotation.visible === false || annotation.hidden === true) continue;
    const axis = String(annotation.axis || '').trim().toLowerCase();
    const imageWidth = finiteNumber(annotation.imageWidth ?? annotation.image_width);
    const imageHeight = finiteNumber(annotation.imageHeight ?? annotation.image_height);
    const range = getInclusiveVectorSliceRange({
      axis,
      minSlice: annotation.minSlice ?? annotation.min_slice,
      maxSlice: annotation.maxSlice ?? annotation.max_slice,
      dimensions: normalizedMetadata.dimensions,
    });
    if (!range || !(imageWidth > 0) || !(imageHeight > 0)) continue;
    const color = normalizeColor(annotation.color);
    const opacity = clamp(finiteNumber(annotation.opacity, DEFAULT_VECTOR_OPACITY), 0, 1);
    // Area and mask-run caps are schema limits for one VISTA segment, not a
    // shared allowance across the annotation list. Aggregate totals below are
    // diagnostics only; every visible segment receives its own bounded mask.
    const mask = buildPt3SegmentMask(annotation);
    result.stats.areasRead += mask.stats.areasRead;
    result.stats.addAreasApplied += mask.stats.addAreasApplied;
    result.stats.subtractAreasApplied += mask.stats.subtractAreasApplied;
    result.stats.maskRunsRead += mask.stats.maskRunsRead;
    result.stats.maskRectanglesRead += mask.rectangles.length;
    if (mask.stats.approximated) result.stats.maskApproximated += 1;
    if (mask.stats.truncated) result.stats.truncated = true;
    if (mask.rectangles.length === 0) continue;

    const base = {
      annotationId: String(annotation.id || ''),
      label: String(annotation.label || ''),
      axis,
      operation: 'add',
      color,
      opacity,
      minSlice: range.minSlice,
      maxSlice: range.maxSlice,
    };
    const sourceMapping = {
      axis,
      imageWidth,
      imageHeight,
      dimensions: normalizedMetadata.dimensions,
    };
    if (!addFace({
      ...base,
      surface: 'lower',
      sourceMapping,
      sourceGeometry: {
        kind: 'mask-surface',
        rectangles: mask.rectangles,
        sliceCoordinate: range.lowerFace,
        reverse: false,
      },
    })) break;
    result.stats.primitivesBuilt += 1;
    if (!addFace({
      ...base,
      surface: 'upper',
      sourceMapping,
      sourceGeometry: {
        kind: 'mask-surface',
        rectangles: mask.rectangles,
        sliceCoordinate: range.upperFace,
        reverse: true,
      },
    })) break;
    result.stats.primitivesBuilt += 1;

    const boundaries = getMaskBoundarySegments(mask.rectangles);
    if (boundaries.length > 0) {
      if (!addFace({
        ...base,
        surface: 'side',
        sourceMapping,
        sourceGeometry: {
          kind: 'mask-sides',
          boundaries,
          lowerFace: range.lowerFace,
          upperFace: range.upperFace,
        },
      })) break;
      result.stats.primitivesBuilt += 1;
    }
  }
  result.stats.facesBuilt = result.faces.length;
  return result;
}

function drawProjectedFace(ctx, face, projectPolygon) {
  const [red, green, blue] = colorToRgb(face.color);
  const baseOpacity = clamp(face.opacity, 0, 1);
  const fillOpacity = baseOpacity * (face.surface === 'side' ? 0.55 : 0.78);
  ctx.beginPath();
  let polygonCount = 0;
  forEachPt3VectorFaceVoxelPolygon(face, (voxelPolygon) => {
    const projectedPoints = projectPolygon(voxelPolygon);
    if (!Array.isArray(projectedPoints) || projectedPoints.length < 3) return;
    if (!projectedPoints.every((point) => point.every(Number.isFinite))) return;
    ctx.moveTo(projectedPoints[0][0], projectedPoints[0][1]);
    projectedPoints.slice(1).forEach((point) => ctx.lineTo(point[0], point[1]));
    ctx.closePath();
    polygonCount += 1;
  });
  if (polygonCount === 0) return false;
  ctx.fillStyle = `rgba(${red},${green},${blue},${fillOpacity})`;
  ctx.strokeStyle = `rgba(${red},${green},${blue},0.82)`;
  ctx.lineWidth = 1.15;
  ctx.setLineDash?.([]);
  ctx.fill();
  ctx.stroke();
  return true;
}

export function renderPt3VectorAnnotations(ctx, {
  vectorAnnotations = [],
  showAnnotations = true,
  metadata,
  rotation,
  zoom,
  mirrorScale,
  width,
  height,
} = {}) {
  const build = buildPt3VectorAnnotationFaces(vectorAnnotations, metadata, { showAnnotations });
  const result = { ...build.stats, renderedFaces: 0 };
  if (!ctx || build.faces.length === 0) return result;
  const renderWidth = Math.max(1, finiteNumber(width, ctx.canvas?.width || 1));
  const renderHeight = Math.max(1, finiteNumber(height, ctx.canvas?.height || 1));
  const normalizedMetadata = normalizeVolumeMetadata(metadata);
  const project = createPt3PerspectiveProjector({
    metadata: normalizedMetadata,
    width: renderWidth,
    height: renderHeight,
    rotation,
    zoom,
    mirrorScale,
  });
  const projectPolygon = (voxelPolygon) => voxelPolygon.map((point) => (
    project(voxelToPhysical(point, normalizedMetadata))
  ));
  const projectedFaces = build.faces.map((face) => {
    let depthTotal = 0;
    let projectedPointCount = 0;
    forEachPt3VectorFaceVoxelPolygon(face, (voxelPolygon) => {
      projectPolygon(voxelPolygon).forEach((point) => {
        if (!point.every(Number.isFinite)) return;
        depthTotal += point[2];
        projectedPointCount += 1;
      });
    });
    return {
      face,
      depth: depthTotal / Math.max(1, projectedPointCount),
      projectedPointCount,
    };
  }).filter((entry) => entry.projectedPointCount > 0);
  projectedFaces.sort((left, right) => left.depth - right.depth);

  ctx.save?.();
  projectedFaces.forEach(({ face }) => {
    if (drawProjectedFace(ctx, face, projectPolygon)) result.renderedFaces += 1;
  });
  ctx.setLineDash?.([]);
  ctx.restore?.();
  return result;
}
