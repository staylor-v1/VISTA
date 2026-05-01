import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Actions, Layout, Model } from 'flexlayout-react';
import 'flexlayout-react/style/light.css';
import CalibrationManager from './CalibrationManager';
import { DEFAULT_INTERFACE_HIERARCHY } from '../utils/interfaceHierarchy';

const VIEW_ORDER = ['front', 'back', 'left', 'right', 'top', 'bottom'];
const MPR_AXES = ['axial', 'coronal', 'sagittal'];
const MPR_AXIS_LABELS = { axial: 'XY', coronal: 'XZ', sagittal: 'YZ' };
const MPR_AXIS_CONFIG = {
  axial: {
    label: 'XY',
    sliceLabel: 'Z',
    color: '#3b82f6',
  },
  coronal: {
    label: 'XZ',
    sliceLabel: 'Y',
    color: '#f59e0b',
  },
  sagittal: {
    label: 'YZ',
    sliceLabel: 'X',
    color: '#10b981',
  },
};
const MPR_CROSSHAIR_AXES_BY_VIEW = {
  axial: { horizontal: 'coronal', vertical: 'sagittal' },
  coronal: { horizontal: 'axial', vertical: 'sagittal' },
  sagittal: { horizontal: 'axial', vertical: 'coronal' },
};
const MPR_DISPLAY_AXES_BY_VIEW = {
  axial: { x: 'sagittal', y: 'coronal' },
  coronal: { x: 'sagittal', y: 'axial' },
  sagittal: { x: 'coronal', y: 'axial' },
};
const MPR_RECONSTRUCTION_MODES = {
  orientation: 'orientation',
  stack: 'stack',
  shell: 'shell',
};
const DEFAULT_MPR_PROJECTION_MIRROR = { axial: false, coronal: false, sagittal: false };
const MPR_VOLUME_CACHE_LIMIT = 4;
const MPR_SLICE_CANVAS_CACHE_LIMIT = 96;
const mprVolumeCacheStore = new Map();
const DEFAULT_OVERLAY_LAYERS = [
  { id: 'segmentation', label: 'Segmentation', color: '#ef4444' },
  { id: 'heatmap', label: 'Heatmap', color: '#8b5cf6' },
  { id: 'voids', label: 'Voids', color: '#f59e0b' },
];
const DEFAULT_MODALITIES = ['visual', 'infrared', 'uv'];
const DEFAULT_INSPECTOR_HOTKEYS = {
  accept_classification: 'a',
  reject_classification: 'r',
  toggle_shortcut_help: 'h',
};
const DEFAULT_INSPECTION_COLUMN_WIDTHS = { leftPx: null, rightPx: null };
const MEASUREMENT_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4'];
const RESIZABLE_COLUMN_MIN_PX = 220;
const RESIZE_HANDLE_WIDTH_PX = 10;
const FLEX_LAYOUT_CENTER_WEIGHT_PX = 760;
const INSPECTION_FLEX_TABSET_IDS = {
  left: 'inspection-left-tabset',
  center: 'inspection-center-tabset',
  right: 'inspection-right-tabset',
};
const DEFAULT_PANEL_LAYOUT = {
  part_list: { is_open: true, width_px: 320, height_px: 420, orientation: 'vertical' },
  inspector: { is_open: true, width_px: 360, height_px: 420, orientation: 'vertical' },
  mpr_controls: { is_open: true, width_px: 360, height_px: 360, orientation: 'vertical' },
};
const PANEL_LAYOUT_KEYS = ['part_list', 'inspector', 'mpr_controls'];
const REVIEW_LABELS = {
  unreviewed: 'Unreviewed',
  in_review: 'In Review',
  pass: 'Pass',
  reject_pending: 'Reject Pending',
  reject_confirmed: 'Reject Confirmed',
};
function hasDroppedMetadataField(part, field) {
  const metadata = part?.metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  const value = metadata[field];
  if (!Array.isArray(value)) return false;
  return value.some((item) => !item || typeof item !== 'object' || Array.isArray(item));
}

function normalizeSavedMeasurements(measurements) {
  if (!Array.isArray(measurements)) return [];
  return measurements
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => {
      const label = typeof entry.label === 'string' ? entry.label.trim() : '';
      const value = typeof entry.value === 'string'
        ? entry.value.trim()
        : Number.isFinite(entry.value)
          ? String(entry.value)
          : '';
      if (!label || !value) return null;
      return {
        id: entry.id ? String(entry.id) : '',
        label,
        value,
      };
    })
    .filter(Boolean);
}

function getDefectCount(part) {
  const defects = part?.metadata?.defects;
  if (Array.isArray(defects)) return defects.length;
  const explicitCount = part?.metadata?.defect_count;
  return Number.isFinite(explicitCount) ? explicitCount : 0;
}

function getMeasurementLinesByImageId(annotations) {
  if (!Array.isArray(annotations)) return {};
  return annotations.reduce((acc, annotation) => {
    const imageId = annotation?.image_id;
    const line = annotation?.geometry?.line;
    if (!imageId || !line) return acc;
    const x1 = Number(line.x1);
    const y1 = Number(line.y1);
    const x2 = Number(line.x2);
    const y2 = Number(line.y2);
    const imageWidth = Number(line.imageWidth);
    const imageHeight = Number(line.imageHeight);
    if (![x1, y1, x2, y2, imageWidth, imageHeight].every(Number.isFinite)) return acc;
    const lengthMm = Number(annotation?.measurements?.length_mm);
    const providedLengthPx = Number(annotation?.measurements?.length_px);
    const distancePx = Number.isFinite(providedLengthPx)
      ? providedLengthPx
      : Math.hypot(x2 - x1, y2 - y1);
    const color = annotation?.metadata?.measurement_color || MEASUREMENT_COLORS[Object.keys(acc).length % MEASUREMENT_COLORS.length];
    const entry = { id: String(annotation.id || `${imageId}-${x1}-${y1}`), x1, y1, x2, y2, imageWidth, imageHeight, color, distanceMm: Number.isFinite(lengthMm) ? lengthMm : null, distancePx };
    const key = String(imageId);
    acc[key] = [...(acc[key] || []), entry];
    return acc;
  }, {});
}

function isFiniteMeasurementLine(line) {
  if (!line || typeof line !== 'object') return false;
  const values = [line.x1, line.y1, line.x2, line.y2, line.imageWidth, line.imageHeight];
  return values.every((value) => Number.isFinite(Number(value)));
}

function isValidCalibration(calibration) {
  return Number(calibration?.pixels_per_mm) > 0;
}

function getImageMetadata(image) {
  return (image?.metadata && typeof image.metadata === 'object')
    ? image.metadata
    : (image?.metadata_ && typeof image.metadata_ === 'object')
      ? image.metadata_
      : {};
}

function resolveMeasurementCalibration(projectMetadata, image, projectConfiguration, sessionCalibration) {
  if (isValidCalibration(sessionCalibration)) return sessionCalibration;
  const imageMetadata = getImageMetadata(image);
  if (isValidCalibration(imageMetadata?.calibration_override)) return imageMetadata.calibration_override;
  const rules = Array.isArray(projectMetadata?.calibration_rules) ? projectMetadata.calibration_rules : [];
  const matchingRule = rules.find((rule) => (
    rule?.metadata_key
    && rule?.metadata_value !== undefined
    && isValidCalibration(rule?.calibration)
    && imageMetadata[rule.metadata_key] !== undefined
    && String(imageMetadata[rule.metadata_key]) === String(rule.metadata_value)
  ));
  if (matchingRule) return matchingRule.calibration;
  if (isValidCalibration(projectMetadata?.calibration_default)) return projectMetadata.calibration_default;
  if (isValidCalibration(projectConfiguration?.calibration)) return projectConfiguration.calibration;
  return null;
}

function getMeasurementLineLabel(line) {
  if (Number.isFinite(Number(line?.distanceMm))) {
    return `${Number(line.distanceMm).toFixed(2)} mm`;
  }
  const distancePx = Number.isFinite(Number(line?.distancePx))
    ? Number(line.distancePx)
    : isFiniteMeasurementLine(line)
      ? Math.hypot(Number(line.x2) - Number(line.x1), Number(line.y2) - Number(line.y1))
      : null;
  return Number.isFinite(distancePx) ? `${distancePx.toFixed(1)} px` : '';
}

function getMeasurementLabelViewBoxPosition(line, fontSize = 20) {
  const x = ((Number(line.x1) + Number(line.x2)) / (2 * Number(line.imageWidth))) * 1000;
  const y = ((Number(line.y1) + Number(line.y2)) / (2 * Number(line.imageHeight))) * 1000 - 6;
  const inset = Math.max(12, fontSize + 4);
  return {
    x: Math.min(980, Math.max(20, x)),
    y: Math.min(980, Math.max(inset, y)),
  };
}

function getPartViews(part) {
  const configuredViews = part?.metadata?.configured_views;
  if (Array.isArray(configuredViews) && configuredViews.length > 0) {
    return configuredViews.map((value) => String(value).toLowerCase());
  }
  return VIEW_ORDER;
}

function getModalities(part) {
  const modalities = part?.metadata?.modalities;
  if (Array.isArray(modalities) && modalities.length > 0) {
    return modalities.map((value) => String(value));
  }
  return DEFAULT_MODALITIES;
}

function getMprDimensions(part) {
  const raw = part?.metadata?.volume_shape || part?.metadata?.mpr?.volume_shape || {};
  const dimensions = MPR_AXES.reduce((acc, axis) => {
    const value = Number(raw?.[axis]);
    acc[axis] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 128;
    return acc;
  }, {});
  return dimensions;
}

function getVolumeSourceImages(part, projectImageLookup = {}) {
  const sourceImages = part?.metadata?.source_images;
  if (!Array.isArray(sourceImages)) return [];
  return sourceImages
    .map((entry, index) => {
      const filename = String(entry?.filename || '');
      const imageId = entry?.image_id || projectImageLookup[filename]?.id;
      if (!imageId) return null;
      const sliceIndex = Number(entry?.metadata?.slice_index ?? entry?.slice_index ?? index);
      return {
        id: String(imageId),
        filename,
        sliceIndex: Number.isFinite(sliceIndex) ? sliceIndex : index,
        url: `/api/images/${encodeURIComponent(String(imageId))}/content`,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.sliceIndex - right.sliceIndex || left.filename.localeCompare(right.filename));
}

function getShellImageLayers(part, projectImageLookup = {}) {
  const imagesByView = part?.metadata?.view_images;
  if (!imagesByView || typeof imagesByView !== 'object') return [];
  return Object.entries(imagesByView)
    .map(([viewName, imageRef]) => {
      const filename = String(imageRef || '');
      const imageId = projectImageLookup[filename]?.id;
      if (!imageId) return null;
      return {
        viewName: String(viewName || '').toLowerCase(),
        filename,
        id: String(imageId),
        url: `/api/images/${encodeURIComponent(String(imageId))}/content`,
      };
    })
    .filter(Boolean);
}

function getPartImageRefs(part) {
  const refs = [];
  const seen = new Set();
  const imagesByView = part?.metadata?.view_images;
  if (imagesByView && typeof imagesByView === 'object') {
    Object.entries(imagesByView).forEach(([viewName, imageRef]) => {
      const ref = String(imageRef || '');
      if (!ref || seen.has(ref)) return;
      seen.add(ref);
      refs.push({
        id: `${part.id}-view-${viewName}`,
        viewName: String(viewName || '').toLowerCase(),
        label: String(viewName || 'image').toUpperCase(),
        imageRef: ref,
        overlay: false,
      });
    });
  }
  const hasViewRefs = refs.length > 0;
  const isAnalyzeOutputRecord = (record) => {
    const modality = String(record?.modality || '').toLowerCase();
    return Boolean(
      record?.analysis_output
      || record?.analysis_source_image_id
      || record?.overlay_base_image_id
      || modality === 'analyze-overlay'
    );
  };
  const pushRecord = (record, index, forceOverlay = false) => {
    if (!record || typeof record !== 'object') return;
    if (record.overlay_delete_candidate || record.delete_candidate) return;
    const overlay = forceOverlay || record.overlay === true || record.analysis_output === true;
    if (!overlay && hasViewRefs) return;
    const imageRef = String(record.image_id || record.filename || '');
    if (!imageRef || seen.has(imageRef)) return;
    seen.add(imageRef);
    const label = overlay
      ? String(record.label || record.analysis_label || 'Analyze Overlay')
      : String(record.side || record.modality || `IMAGE ${index + 1}`).toUpperCase();
    refs.push({
      id: `${part.id}-${overlay ? 'analysis' : 'source'}-${index}`,
      viewName: String(record.side || record.modality || (overlay ? 'overlay' : 'image')).toLowerCase(),
      label,
      imageRef,
      filename: String(record.filename || ''),
      imageId: record.image_id ? String(record.image_id) : '',
      overlay,
      overlayBaseImageId: record.overlay_base_image_id ? String(record.overlay_base_image_id) : '',
      overlayBaseFilename: record.overlay_base_filename ? String(record.overlay_base_filename) : '',
    });
  };
  const sourceImages = part?.metadata?.source_images;
  if (Array.isArray(sourceImages)) {
    sourceImages.forEach((record, index) => {
      pushRecord(record, index, isAnalyzeOutputRecord(record));
    });
  }
  const analysisOutputs = part?.metadata?.analysis_outputs;
  if (Array.isArray(analysisOutputs)) {
    analysisOutputs.forEach((record, index) => {
      pushRecord(record, index, true);
    });
  }
  return refs;
}

function getFallbackProjectionImage(axis, shellImageLayers) {
  const preferredViews = {
    axial: ['top', 'bottom', 'front', 'back', 'left', 'right'],
    coronal: ['front', 'back', 'top', 'bottom', 'left', 'right'],
    sagittal: ['left', 'right', 'front', 'back', 'top', 'bottom'],
  };
  const preferences = preferredViews[axis] || [];
  return preferences.map((viewName) => shellImageLayers.find((entry) => entry.viewName === viewName)).find(Boolean)
    || shellImageLayers[0]
    || null;
}

function getFraction(value, maxValue) {
  const upper = Math.max(1, Number(maxValue) || 1);
  return Math.min(1, Math.max(0, (Number(value) || 0) / upper));
}

function normalizeMprProjectionMirror(candidate) {
  return MPR_AXES.reduce((acc, axis) => {
    acc[axis] = candidate?.[axis] === true;
    return acc;
  }, { ...DEFAULT_MPR_PROJECTION_MIRROR });
}

function getScaledIndex(value, sourceMaxValue, targetLength) {
  const upper = Math.max(0, (Number(targetLength) || 1) - 1);
  return clampRange(Math.round(getFraction(value, sourceMaxValue) * upper), 0, upper, 0);
}

function getMprVolumeCacheKey(imageStack) {
  if (!Array.isArray(imageStack) || imageStack.length === 0) return '';
  return imageStack
    .map((entry) => `${entry.id}:${entry.sliceIndex}:${entry.url}`)
    .join('|');
}

function rememberMprVolumeCache(key, cache) {
  if (!key || !cache) return;
  mprVolumeCacheStore.delete(key);
  mprVolumeCacheStore.set(key, cache);
  while (mprVolumeCacheStore.size > MPR_VOLUME_CACHE_LIMIT) {
    const oldestKey = mprVolumeCacheStore.keys().next().value;
    mprVolumeCacheStore.delete(oldestKey);
  }
}

function rememberSliceCanvas(volumeCache, key, canvas) {
  if (!volumeCache?.sliceCanvases || !key || !canvas) return;
  volumeCache.sliceCanvases.delete(key);
  volumeCache.sliceCanvases.set(key, canvas);
  while (volumeCache.sliceCanvases.size > MPR_SLICE_CANVAS_CACHE_LIMIT) {
    const oldestKey = volumeCache.sliceCanvases.keys().next().value;
    volumeCache.sliceCanvases.delete(oldestKey);
  }
}

function loadMprImage(source) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = source.url;
  });
}

async function buildMprVolumeCache(cacheKey, imageStack, dimensions) {
  const images = await Promise.all(imageStack.map(loadMprImage));
  const validImages = images.filter(Boolean);
  if (validImages.length === 0) return null;

  const first = validImages[0];
  const width = first.naturalWidth || first.width || Math.max(1, dimensions.sagittal || 1);
  const height = first.naturalHeight || first.height || Math.max(1, dimensions.coronal || 1);
  const scratch = document.createElement('canvas');
  const scratchContext = scratch.getContext?.('2d');
  if (!scratchContext) return null;

  scratch.width = width;
  scratch.height = height;

  const slices = validImages.map((image) => {
    scratchContext.clearRect(0, 0, width, height);
    scratchContext.drawImage(image, 0, 0, width, height);
    return {
      image,
      imageData: scratchContext.getImageData(0, 0, width, height),
    };
  });

  return {
    key: cacheKey,
    width,
    height,
    depth: slices.length,
    slices,
    sliceCanvases: new Map(),
  };
}

function getCachedMprSliceCanvas(axis, slicePosition, dimensions, volumeCache) {
  if (!volumeCache || typeof document === 'undefined') return null;
  const sourceMaxByAxis = {
    axial: Math.max(0, (dimensions.axial || 1) - 1),
    coronal: Math.max(0, (dimensions.coronal || 1) - 1),
    sagittal: Math.max(0, (dimensions.sagittal || 1) - 1),
  };
  const cacheIndexByAxis = {
    axial: getScaledIndex(slicePosition.axial, sourceMaxByAxis.axial, volumeCache.depth),
    coronal: getScaledIndex(slicePosition.coronal, sourceMaxByAxis.coronal, volumeCache.height),
    sagittal: getScaledIndex(slicePosition.sagittal, sourceMaxByAxis.sagittal, volumeCache.width),
  };
  const sliceKey = `${axis}:${cacheIndexByAxis[axis]}`;
  const cachedCanvas = volumeCache.sliceCanvases.get(sliceKey);
  if (cachedCanvas) return cachedCanvas;

  const output = document.createElement('canvas');
  const outputContext = output.getContext?.('2d');
  if (!outputContext) return null;

  if (axis === 'axial') {
    const slice = volumeCache.slices[cacheIndexByAxis.axial] || volumeCache.slices[0];
    output.width = volumeCache.width;
    output.height = volumeCache.height;
    outputContext.drawImage(slice.image, 0, 0, output.width, output.height);
    rememberSliceCanvas(volumeCache, sliceKey, output);
    return output;
  }

  if (axis === 'coronal') {
    output.width = volumeCache.width;
    output.height = volumeCache.depth;
    const y = cacheIndexByAxis.coronal;
    const outData = outputContext.createImageData(output.width, output.height);
    volumeCache.slices.forEach((slice, zIndex) => {
      const sourceOffset = y * volumeCache.width * 4;
      const targetOffset = (volumeCache.depth - 1 - zIndex) * volumeCache.width * 4;
      outData.data.set(
        slice.imageData.data.subarray(sourceOffset, sourceOffset + volumeCache.width * 4),
        targetOffset,
      );
    });
    outputContext.putImageData(outData, 0, 0);
    rememberSliceCanvas(volumeCache, sliceKey, output);
    return output;
  }

  output.width = volumeCache.height;
  output.height = volumeCache.depth;
  const x = cacheIndexByAxis.sagittal;
  const outData = outputContext.createImageData(output.width, output.height);
  volumeCache.slices.forEach((slice, zIndex) => {
    const targetRowOffset = (volumeCache.depth - 1 - zIndex) * volumeCache.height * 4;
    for (let y = 0; y < volumeCache.height; y += 1) {
      const sourceOffset = (y * volumeCache.width + x) * 4;
      const targetOffset = targetRowOffset + y * 4;
      outData.data[targetOffset] = slice.imageData.data[sourceOffset];
      outData.data[targetOffset + 1] = slice.imageData.data[sourceOffset + 1];
      outData.data[targetOffset + 2] = slice.imageData.data[sourceOffset + 2];
      outData.data[targetOffset + 3] = slice.imageData.data[sourceOffset + 3];
    }
  });
  outputContext.putImageData(outData, 0, 0);
  rememberSliceCanvas(volumeCache, sliceKey, output);
  return output;
}

function getMprCrosshairStyle(axis, slicePosition, dimensions, mirroredAxes = DEFAULT_MPR_PROJECTION_MIRROR) {
  const x = getFraction(slicePosition.sagittal, (dimensions.sagittal || 1) - 1) * 100;
  const y = getFraction(slicePosition.coronal, (dimensions.coronal || 1) - 1) * 100;
  const z = (1 - getFraction(slicePosition.axial, (dimensions.axial || 1) - 1)) * 100;
  const representedAxes = MPR_CROSSHAIR_AXES_BY_VIEW[axis] || MPR_CROSSHAIR_AXES_BY_VIEW.axial;
  const displayAxes = MPR_DISPLAY_AXES_BY_VIEW[axis] || MPR_DISPLAY_AXES_BY_VIEW.axial;
  const mirrorX = mirroredAxes?.[displayAxes.x] === true;
  const mirrorY = mirroredAxes?.[displayAxes.y] === true;
  const representedStyle = {
    '--crosshair-h-color': MPR_AXIS_CONFIG[representedAxes.horizontal]?.color || '#ffffff',
    '--crosshair-v-color': MPR_AXIS_CONFIG[representedAxes.vertical]?.color || '#ffffff',
    '--projection-scale-x': mirrorX ? -1 : 1,
    '--projection-scale-y': mirrorY ? -1 : 1,
  };
  const displayX = (value) => `${mirrorX ? 100 - value : value}%`;
  const displayY = (value) => `${mirrorY ? 100 - value : value}%`;
  if (axis === 'axial') {
    return { '--crosshair-x': displayX(x), '--crosshair-y': displayY(y), ...representedStyle };
  }
  if (axis === 'coronal') {
    return { '--crosshair-x': displayX(x), '--crosshair-y': displayY(z), ...representedStyle };
  }
  return { '--crosshair-x': displayX(y), '--crosshair-y': displayY(z), ...representedStyle };
}

function useMprVolumeCache(imageStack, dimensions) {
  const cacheKey = useMemo(() => getMprVolumeCacheKey(imageStack), [imageStack]);
  const [cacheState, setCacheState] = useState({ key: '', status: 'idle', cache: null });

  useEffect(() => {
    if (!cacheKey || imageStack.length === 0) {
      setCacheState({ key: '', status: 'idle', cache: null });
      return undefined;
    }
    if (typeof window !== 'undefined' && /jsdom/i.test(window.navigator?.userAgent || '')) {
      setCacheState({ key: cacheKey, status: 'idle', cache: null });
      return undefined;
    }

    const cached = mprVolumeCacheStore.get(cacheKey);
    if (cached) {
      setCacheState({ key: cacheKey, status: 'ready', cache: cached });
      return undefined;
    }

    let cancelled = false;
    setCacheState({ key: cacheKey, status: 'loading', cache: null });
    buildMprVolumeCache(cacheKey, imageStack, dimensions).then((cache) => {
      if (cancelled) return;
      if (!cache) {
        setCacheState({ key: cacheKey, status: 'error', cache: null });
        return;
      }
      rememberMprVolumeCache(cacheKey, cache);
      setCacheState({ key: cacheKey, status: 'ready', cache });
    });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, dimensions, imageStack]);

  return cacheState;
}

function MprSliceCanvas({ axis, volumeCache, volumeCacheStatus, slicePosition, dimensions }) {
  const canvasRef = useRef(null);
  const relevantSlicePosition = slicePosition[axis];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !volumeCache) return undefined;
    if (typeof window !== 'undefined' && /jsdom/i.test(window.navigator?.userAgent || '')) {
      return undefined;
    }
    const safeGetContext = () => {
      try {
        return typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
      } catch (_) {
        return null;
      }
    };
    const ctx = safeGetContext();
    if (!ctx) return undefined;

    const sliceCanvas = getCachedMprSliceCanvas(axis, slicePosition, dimensions, volumeCache);
    if (!sliceCanvas) return undefined;
    canvas.width = sliceCanvas.width || 1;
    canvas.height = sliceCanvas.height || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sliceCanvas, 0, 0, canvas.width, canvas.height);
    return undefined;
  }, [axis, dimensions, relevantSlicePosition, slicePosition, volumeCache]);

  return (
    <canvas
      ref={canvasRef}
      className="mpr-slice-canvas"
      aria-hidden="true"
      data-volume-cache-status={volumeCacheStatus}
    />
  );
}

function safeDecodeFilename(value) {
  const raw = String(value || '');
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

function getLatestRunFromMetadata(part, key) {
  const runs = part?.metadata?.[key];
  if (!Array.isArray(runs) || runs.length === 0) return null;
  return runs[runs.length - 1];
}

function getOverlayLayers(part) {
  const overlays = part?.metadata?.overlay_layers;
  if (Array.isArray(overlays) && overlays.length > 0) {
    return overlays
      .filter((overlay) => overlay && overlay.id && !overlay.overlay_delete_candidate && !overlay.delete_candidate)
      .map((overlay) => ({
        id: String(overlay.id),
        label: overlay.label || String(overlay.id),
        color: overlay.color || '#64748b',
      }));
  }
  return DEFAULT_OVERLAY_LAYERS;
}

function clampRange(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function normalizeInspectorHotkeys(candidate) {
  const normalized = { ...DEFAULT_INSPECTOR_HOTKEYS };
  if (!candidate || typeof candidate !== 'object') return normalized;
  Object.entries(DEFAULT_INSPECTOR_HOTKEYS).forEach(([binding, fallback]) => {
    const raw = typeof candidate[binding] === 'string' ? candidate[binding].trim().toLowerCase() : fallback;
    normalized[binding] = /^[a-z0-9]$/.test(raw) ? raw : fallback;
  });
  return normalized;
}

function normalizePanelDimension(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

function normalizePanelLayout(candidate) {
  const safeCandidate = candidate && typeof candidate === 'object' ? candidate : {};
  return PANEL_LAYOUT_KEYS.reduce((acc, key) => {
    const defaults = DEFAULT_PANEL_LAYOUT[key];
    const current = safeCandidate[key] && typeof safeCandidate[key] === 'object' ? safeCandidate[key] : {};
    const orientation = String(current.orientation || defaults.orientation).toLowerCase();
    acc[key] = {
      is_open: current.is_open !== false,
      width_px: normalizePanelDimension(current.width_px, 220, 1200, defaults.width_px),
      height_px: normalizePanelDimension(current.height_px, 220, 1400, defaults.height_px),
      orientation: orientation === 'horizontal' ? 'horizontal' : 'vertical',
    };
    return acc;
  }, {});
}

function normalizeLayoutNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : fallback;
}

function normalizeInspectionRegion(regionKey, candidate = {}) {
  const defaults = DEFAULT_INTERFACE_HIERARCHY.inspection.regions[regionKey] || {};
  return {
    ...defaults,
    ...candidate,
    label: String(candidate.label || defaults.label || regionKey),
    order: normalizeLayoutNumber(candidate.order, defaults.order || 1),
    isOpen: candidate.isOpen !== false,
    widthPx: candidate.widthPx == null ? defaults.widthPx : normalizeLayoutNumber(candidate.widthPx, defaults.widthPx),
    minWidthPx: candidate.minWidthPx == null ? defaults.minWidthPx : normalizeLayoutNumber(candidate.minWidthPx, defaults.minWidthPx),
    maxWidthPx: candidate.maxWidthPx == null ? defaults.maxWidthPx : normalizeLayoutNumber(candidate.maxWidthPx, defaults.maxWidthPx),
    heightPx: candidate.heightPx == null ? defaults.heightPx : normalizeLayoutNumber(candidate.heightPx, defaults.heightPx),
    minHeightPx: candidate.minHeightPx == null ? defaults.minHeightPx : normalizeLayoutNumber(candidate.minHeightPx, defaults.minHeightPx),
    maxHeightPx: candidate.maxHeightPx == null ? defaults.maxHeightPx : normalizeLayoutNumber(candidate.maxHeightPx, defaults.maxHeightPx),
  };
}

function normalizeInspectionHierarchy(hierarchy) {
  const safeHierarchy = hierarchy && typeof hierarchy === 'object' ? hierarchy : {};
  const defaultInspection = DEFAULT_INTERFACE_HIERARCHY.inspection;
  const mergedRegions = {
    ...defaultInspection.regions,
    ...(safeHierarchy.regions || {}),
  };
  const regions = Object.entries(mergedRegions).reduce((acc, [regionKey, region]) => {
    acc[regionKey] = normalizeInspectionRegion(regionKey, region);
    return acc;
  }, {});
  const centerTabs = Array.isArray(safeHierarchy.centerTabs) && safeHierarchy.centerTabs.length > 0
    ? safeHierarchy.centerTabs
    : defaultInspection.centerTabs;
  const layout = {
    ...defaultInspection.layout,
    ...(safeHierarchy.layout || {}),
  };

  return {
    leftColumn: safeHierarchy.leftColumn || defaultInspection.leftColumn,
    centerTabs: centerTabs
      .filter((tabKey) => regions[tabKey]?.isOpen !== false)
      .sort((left, right) => (regions[left]?.order || 1) - (regions[right]?.order || 1)),
    rightColumn: safeHierarchy.rightColumn || defaultInspection.rightColumn,
    layout: {
      ...layout,
      gapPx: normalizeLayoutNumber(layout.gapPx, defaultInspection.layout.gapPx),
      minHeightPx: normalizeLayoutNumber(layout.minHeightPx, defaultInspection.layout.minHeightPx),
      collapseBreakpointPx: normalizeLayoutNumber(
        layout.collapseBreakpointPx,
        defaultInspection.layout.collapseBreakpointPx,
      ),
    },
    regions,
  };
}

function getInspectionPaneWeight(region, fallback) {
  return normalizeLayoutNumber(region?.widthPx ?? region?.minWidthPx, fallback);
}

function createInspectionTab(tabKey, region, fallbackLabel) {
  return {
    type: 'tab',
    id: `inspection-tab-${tabKey}`,
    name: region?.label || fallbackLabel || tabKey,
    component: tabKey,
    enableClose: false,
    enableRename: false,
  };
}

function createInspectionFlexLayoutModel({
  inspectionHierarchy,
  leftRegion,
  inspectorRegion,
  rightRegion,
  inspectionLayoutCollapsed,
}) {
  const leftWeight = getInspectionPaneWeight(leftRegion, 320);
  const centerWeight = getInspectionPaneWeight(inspectorRegion, FLEX_LAYOUT_CENTER_WEIGHT_PX);
  const rightWeight = getInspectionPaneWeight(rightRegion, 360);

  return Model.fromJson({
    global: {
      rootOrientationVertical: inspectionLayoutCollapsed,
      splitterSize: RESIZE_HANDLE_WIDTH_PX,
      splitterExtra: 4,
      tabEnableClose: false,
      tabEnableRename: false,
      tabEnablePopout: false,
      tabSetEnableClose: false,
      tabSetEnableDeleteWhenEmpty: false,
      tabSetEnableMaximize: false,
      tabSetEnableTabStrip: true,
      tabSetTabLocation: 'top',
    },
    borders: [],
    layout: {
      type: 'row',
      id: 'inspection-root-layout',
      weight: 100,
      children: [
        {
          type: 'tabset',
          id: INSPECTION_FLEX_TABSET_IDS.left,
          weight: leftWeight,
          minWidth: normalizeLayoutNumber(leftRegion?.minWidthPx, RESIZABLE_COLUMN_MIN_PX),
          maxWidth: normalizeLayoutNumber(leftRegion?.maxWidthPx, 1200),
          minHeight: normalizeLayoutNumber(leftRegion?.minHeightPx, 220),
          children: [
            createInspectionTab(inspectionHierarchy.leftColumn, leftRegion, 'Part Summary'),
          ],
        },
        {
          type: 'tabset',
          id: INSPECTION_FLEX_TABSET_IDS.center,
          weight: centerWeight,
          minWidth: normalizeLayoutNumber(inspectorRegion?.minWidthPx, 560),
          minHeight: normalizeLayoutNumber(inspectorRegion?.minHeightPx, 320),
          children: inspectionHierarchy.centerTabs.map((tabKey) => (
            createInspectionTab(tabKey, inspectionHierarchy.regions[tabKey], tabKey)
          )),
        },
        {
          type: 'tabset',
          id: INSPECTION_FLEX_TABSET_IDS.right,
          weight: rightWeight,
          minWidth: normalizeLayoutNumber(rightRegion?.minWidthPx, RESIZABLE_COLUMN_MIN_PX),
          maxWidth: normalizeLayoutNumber(rightRegion?.maxWidthPx, 1200),
          minHeight: normalizeLayoutNumber(rightRegion?.minHeightPx, 220),
          children: [
            createInspectionTab(inspectionHierarchy.rightColumn, rightRegion, 'Annotations'),
          ],
        },
      ],
    },
  });
}

function normalizeInspectionColumnWidths(candidate = {}) {
  const leftRaw = Number(candidate.left_px ?? candidate.leftPx);
  const rightRaw = Number(candidate.right_px ?? candidate.rightPx);
  return {
    leftPx: Number.isFinite(leftRaw) && leftRaw > 0 ? Math.round(leftRaw) : null,
    rightPx: Number.isFinite(rightRaw) && rightRaw > 0 ? Math.round(rightRaw) : null,
  };
}

function InspectionWorkbenchPanel({ projectId, projectType, hierarchy, launchFilters }) {
  const [batches, setBatches] = useState([]);
  const [parts, setParts] = useState([]);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [selectedPartId, setSelectedPartId] = useState('');
  const [reviewFilter, setReviewFilter] = useState('all');
  const [partFilter, setPartFilter] = useState('');
  const [sortMode, setSortMode] = useState('part_asc');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [savingPartId, setSavingPartId] = useState(null);
  const [slicePosition, setSlicePosition] = useState({ axial: 0, coronal: 0, sagittal: 0 });
  const [viewportTransform, setViewportTransform] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [activeMprPane, setActiveMprPane] = useState('axial');
  const [mprRotation, setMprRotation] = useState({ x: -22, y: 32 });
  const [mprReconstructionMode, setMprReconstructionMode] = useState(MPR_RECONSTRUCTION_MODES.orientation);
  const [mprProjectionMirror, setMprProjectionMirror] = useState(DEFAULT_MPR_PROJECTION_MIRROR);
  const [activeWorkbenchModal, setActiveWorkbenchModal] = useState(null);
  const [contrastPercent, setContrastPercent] = useState(100);
  const [activeOverlayIds, setActiveOverlayIds] = useState([]);
  const [cursorProbe, setCursorProbe] = useState({ x: 50, y: 50 });
  const [segmentationRun, setSegmentationRun] = useState(null);
  const [measurementRun, setMeasurementRun] = useState(null);
  const [mlActionLoading, setMlActionLoading] = useState({ segmentation: false, measurement: false });
  const [workspaceStateLoaded, setWorkspaceStateLoaded] = useState(false);
  const [workspaceHydration, setWorkspaceHydration] = useState({});
  const [enabledModalities, setEnabledModalities] = useState([]);
  const [selectedViewName, setSelectedViewName] = useState('');
  const [imageEnabled, setImageEnabled] = useState(true);
  const [measurementEntries, setMeasurementEntries] = useState([]);
  const [inspectorViewport, setInspectorViewport] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [annotations, setAnnotations] = useState([]);
  const [annotationsLoading, setAnnotationsLoading] = useState(false);
  const [editingAnnotationId, setEditingAnnotationId] = useState(null);
  const [annotationEditDraft, setAnnotationEditDraft] = useState({
    defect_class: '',
    modality: '',
    comment: '',
    disposition: 'open',
  });
  const [annotationDraft, setAnnotationDraft] = useState({
    defect_class: '',
    modality: '',
    comment: '',
    disposition: 'open',
    measurement_name: '',
    measurement_value: '',
    bbox: { x: '', y: '', width: '', height: '' },
  });
  const [inspectorHotkeys, setInspectorHotkeys] = useState(DEFAULT_INSPECTOR_HOTKEYS);
  const [projectConfiguration, setProjectConfiguration] = useState(null);
  const [projectMetadata, setProjectMetadata] = useState({});
  const [inspectionColumnWidths, setInspectionColumnWidths] = useState(DEFAULT_INSPECTION_COLUMN_WIDTHS);
  const [shortcutHelpVisible, setShortcutHelpVisible] = useState(false);
  const [panelLayout, setPanelLayout] = useState(DEFAULT_PANEL_LAYOUT);
  const [normalizationTriageField, setNormalizationTriageField] = useState('');
  const [selectedImageRef, setSelectedImageRef] = useState('');
  const [projectImageLookup, setProjectImageLookup] = useState({});
  const [deletingOverlayId, setDeletingOverlayId] = useState('');
  const [fullscreenImageModal, setFullscreenImageModal] = useState(null);
  const [fullscreenMeasureActive, setFullscreenMeasureActive] = useState(false);
  const [fullscreenMeasurements, setFullscreenMeasurements] = useState([]);
  const [fullscreenCalibrationPromptVisible, setFullscreenCalibrationPromptVisible] = useState(false);
  const [sessionCalibrationByImageId, setSessionCalibrationByImageId] = useState({});
  const measurementLinesByImageId = useMemo(() => getMeasurementLinesByImageId(annotations), [annotations]);
  const [pendingMeasurePoint, setPendingMeasurePoint] = useState(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState(null);
  const [viewportWidth, setViewportWidth] = useState(() => (
    typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth
  ));
  const [workbenchWidth, setWorkbenchWidth] = useState(0);
  const [manualFilterNotice, setManualFilterNotice] = useState('');
  const workbenchDetailsRef = useRef(null);
  const inspectionResizeSaveTimerRef = useRef(null);
  const mprDragRef = useRef(null);
  const pendingMeasurePointRef = useRef(null);

  const inspectionHierarchy = useMemo(() => {
    const normalized = normalizeInspectionHierarchy(hierarchy || {});
    if (projectType !== 'PT3' || normalized.centerTabs.includes('mpr')) {
      return normalized;
    }
    return {
      ...normalized,
      centerTabs: ['mpr', ...normalized.centerTabs],
      regions: {
        ...normalized.regions,
        mpr: normalizeInspectionRegion('mpr', DEFAULT_INTERFACE_HIERARCHY.inspection.regions.mpr),
      },
    };
  }, [hierarchy, projectType]);
  const leftRegion = inspectionHierarchy.regions[inspectionHierarchy.leftColumn];
  const rightRegion = inspectionHierarchy.regions[inspectionHierarchy.rightColumn];
  const inspectorRegion = inspectionHierarchy.regions.inspector;
  const availableLayoutWidth = workbenchWidth > 0 ? workbenchWidth : viewportWidth;
  const inspectionLayoutCollapsed = availableLayoutWidth <= inspectionHierarchy.layout.collapseBreakpointPx;
  const minSideColumnWidthPx = Math.max(120, Math.round(availableLayoutWidth * 0.05));
  const defaultLeftColumnWidthPx = Math.max(220, Math.round(normalizeLayoutNumber(leftRegion?.widthPx ?? leftRegion?.minWidthPx, 220) * 0.5));
  const defaultRightColumnWidthPx = Math.max(220, Math.round(normalizeLayoutNumber(rightRegion?.widthPx ?? rightRegion?.minWidthPx, 220) * 0.5));
  const configuredLeftColumnWidthPx = inspectionColumnWidths.leftPx ?? defaultLeftColumnWidthPx;
  const configuredRightColumnWidthPx = inspectionColumnWidths.rightPx ?? defaultRightColumnWidthPx;
  const inspectionFlexLayoutModel = useMemo(() => createInspectionFlexLayoutModel({
    inspectionHierarchy: {
      ...inspectionHierarchy,
      regions: {
        ...inspectionHierarchy.regions,
        [inspectionHierarchy.leftColumn]: {
          ...leftRegion,
          widthPx: configuredLeftColumnWidthPx,
          minWidthPx: minSideColumnWidthPx,
        },
        [inspectionHierarchy.rightColumn]: {
          ...rightRegion,
          widthPx: configuredRightColumnWidthPx,
          minWidthPx: minSideColumnWidthPx,
        },
      },
    },
    leftRegion: {
      ...leftRegion,
      widthPx: configuredLeftColumnWidthPx,
      minWidthPx: minSideColumnWidthPx,
    },
    inspectorRegion,
    rightRegion: {
      ...rightRegion,
      widthPx: configuredRightColumnWidthPx,
      minWidthPx: minSideColumnWidthPx,
    },
    inspectionLayoutCollapsed,
  }), [
    configuredLeftColumnWidthPx,
    configuredRightColumnWidthPx,
    inspectionHierarchy,
    inspectionLayoutCollapsed,
    inspectorRegion,
    leftRegion,
    minSideColumnWidthPx,
    rightRegion,
  ]);
  const workbenchFlexLayoutStyle = {
    '--inspection-grid-template-columns': inspectionLayoutCollapsed
      ? '1fr'
      : `${configuredLeftColumnWidthPx}px minmax(0, 1fr) ${configuredRightColumnWidthPx}px`,
    '--inspection-layout-gap': `${inspectionHierarchy.layout.gapPx}px`,
    '--inspection-layout-min-height': inspectionLayoutCollapsed ? '520px' : `${inspectionHierarchy.layout.minHeightPx}px`,
  };

  useEffect(() => {
    const loadWorkbenchData = async () => {
      try {
        setLoading(true);
        setError(null);

        const [batchResp, partResp, workspaceResp, configResp, metadataResp, imageResp] = await Promise.all([
          fetch(`/api/projects/${projectId}/batches`),
          fetch(`/api/projects/${projectId}/parts`),
          fetch(`/api/projects/${projectId}/workspace-state`),
          fetch(`/api/projects/${projectId}/configuration`),
          fetch(`/api/projects/${projectId}/metadata-dict`),
          fetch(`/api/projects/${projectId}/images?include_deleted=true&limit=5000`),
        ]);
        if (!batchResp.ok) {
          throw new Error(`Failed to load batches (${batchResp.status})`);
        }
        if (!partResp.ok) {
          throw new Error(`Failed to load parts (${partResp.status})`);
        }

        const [batchData, partData, workspaceData, configData, metadataData, imageData] = await Promise.all([
          batchResp.json(),
          partResp.json(),
          workspaceResp.ok ? workspaceResp.json() : Promise.resolve({ state: {} }),
          configResp.ok ? configResp.json() : Promise.resolve({}),
          metadataResp.ok ? metadataResp.json() : Promise.resolve({}),
          imageResp.ok ? imageResp.json() : Promise.resolve([]),
        ]);
        const safeBatches = Array.isArray(batchData) ? batchData : [];
        const safeParts = Array.isArray(partData) ? partData : [];
        const savedState = workspaceData?.state && typeof workspaceData.state === 'object' ? workspaceData.state : {};
        setPanelLayout(normalizePanelLayout(savedState.panel_layout));
        const resolvedConfig = configData?.config && typeof configData.config === 'object' ? configData.config : {};
        setProjectConfiguration(resolvedConfig);
        setProjectMetadata(metadataData && typeof metadataData === 'object' ? metadataData : {});
        setInspectionColumnWidths(normalizeInspectionColumnWidths(resolvedConfig?.inspection_layout?.column_widths));
        const savedHotkeys = normalizeInspectorHotkeys(
          resolvedConfig?.process_settings?.configurable_hotkeys,
        );
        setInspectorHotkeys(savedHotkeys);
        setWorkspaceHydration(savedState);
        setBatches(safeBatches);
        setParts(safeParts);
        const imageLookup = (Array.isArray(imageData) ? imageData : []).reduce((acc, image) => {
          const filename = String(image?.filename || '');
          const id = image?.id ? String(image.id) : '';
          if (filename) acc[filename] = image;
          if (id) acc[id] = image;
          return acc;
        }, {});
        setProjectImageLookup(imageLookup);
        const savedBatchId = String(savedState.selected_batch_id || '');
        setSelectedBatchId(savedBatchId);
        const savedReviewFilter = String(savedState.review_filter || 'all');
        setReviewFilter(['all', 'pass', 'reject_pending', 'reject_confirmed', 'none', 'manual'].includes(savedReviewFilter) ? savedReviewFilter : 'all');
        setPartFilter(String(savedState.part_filter || ''));
        const savedSortMode = String(savedState.sort_mode || 'part_asc');
        setSortMode(['part_asc', 'batch_asc', 'status_asc', 'defect_desc'].includes(savedSortMode) ? savedSortMode : 'part_asc');
        const savedPartId = String(savedState.selected_part_id || '');
        const selectedFromSaved = safeParts.find((part) => part.id === savedPartId);
        if (selectedFromSaved) {
          setSelectedPartId(selectedFromSaved.id);
        } else if (safeParts.length > 0) {
          setSelectedPartId(safeParts[0].id);
        }
      } catch (err) {
        setError(err.message || 'Failed to load inspection workbench data');
      } finally {
        setWorkspaceStateLoaded(true);
        setLoading(false);
      }
    };

    loadWorkbenchData();
  }, [projectId]);

  useEffect(() => {
    if (!launchFilters || typeof launchFilters !== 'object') return;
    if (String(launchFilters.selected_batch_id || '').trim()) {
      setSelectedBatchId(String(launchFilters.selected_batch_id));
    }
    if (String(launchFilters.review_filter || '').trim()) {
      setReviewFilter(String(launchFilters.review_filter));
    }
    if (launchFilters.review_filter === 'manual') {
      const batchName = String(launchFilters.source_batch_name || '').trim();
      setManualFilterNotice(
        batchName
          ? `Manual filter applied from Batches tab for ${batchName}.`
          : 'Manual filter applied from Batches tab.',
      );
    }
  }, [launchFilters]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const handleResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const container = workbenchDetailsRef.current;
    if (!container) return undefined;

    const updateWorkbenchWidth = () => {
      const measuredWidth = Math.floor(container.getBoundingClientRect().width);
      setWorkbenchWidth(Number.isFinite(measuredWidth) && measuredWidth > 0 ? measuredWidth : 0);
    };
    updateWorkbenchWidth();

    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(updateWorkbenchWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (inspectionResizeSaveTimerRef.current) {
      window.clearTimeout(inspectionResizeSaveTimerRef.current);
    }
  }, []);

  const getCalibrationForImage = useCallback((imageId) => {
    const key = String(imageId || '');
    return resolveMeasurementCalibration(
      projectMetadata,
      projectImageLookup[key],
      projectConfiguration,
      sessionCalibrationByImageId[key],
    );
  }, [projectConfiguration, projectImageLookup, projectMetadata, sessionCalibrationByImageId]);

  const handleFullscreenCalibrationChange = useCallback((calibration) => {
    if (!fullscreenImageModal?.imageId || !isValidCalibration(calibration)) return;
    const imageId = String(fullscreenImageModal.imageId);
    setSessionCalibrationByImageId((prev) => ({ ...prev, [imageId]: calibration }));
    setProjectMetadata((prev) => ({
      ...(prev && typeof prev === 'object' ? prev : {}),
      calibration_default: prev?.calibration_default || calibration,
    }));
    setFullscreenCalibrationPromptVisible(false);
    setFullscreenMeasureActive(true);
  }, [fullscreenImageModal?.imageId]);


  async function saveInspectionColumnWidths(columnWidths) {
    const nextConfig = {
      ...(projectConfiguration && typeof projectConfiguration === 'object' ? projectConfiguration : {}),
      inspection_layout: {
        ...((projectConfiguration && projectConfiguration.inspection_layout) || {}),
        column_widths: {
          left_px: Number.isFinite(columnWidths.leftPx) ? Math.round(columnWidths.leftPx) : null,
          right_px: Number.isFinite(columnWidths.rightPx) ? Math.round(columnWidths.rightPx) : null,
        },
      },
    };

    try {
      const resp = await fetch(`/api/projects/${projectId}/configuration`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: nextConfig }),
      });
      if (!resp.ok) throw new Error(`Failed to save inspection column widths (${resp.status})`);
      const payload = await resp.json();
      const persistedConfig = payload?.config && typeof payload.config === 'object' ? payload.config : nextConfig;
      setProjectConfiguration(persistedConfig);
    } catch (_) {
      // Best-effort persistence: keep interactive resize fluid even if save fails.
    }
  }


  const filteredParts = useMemo(() => {
    let output = [...parts];

    if (selectedBatchId) {
      output = output.filter((part) => part.batch_id === selectedBatchId);
    }
    if (reviewFilter !== 'all') {
      if (reviewFilter === 'manual') {
        output = output.filter((part) => part?.metadata?.manual_flagged === true);
      } else if (reviewFilter === 'none') {
        output = output.filter((part) => !part.review_state || part.review_state === 'unreviewed');
      } else {
        output = output.filter((part) => String(part.review_state || '').toLowerCase() === reviewFilter);
      }
    }
    if (partFilter.trim()) {
      const query = partFilter.trim().toLowerCase();
      output = output.filter((part) => {
        const candidate = `${part.display_name || ''} ${part.serial_number || ''} ${part.batch_id || ''}`.toLowerCase();
        return candidate.includes(query);
      });
    }
    if (normalizationTriageField) {
      output = output.filter((part) => hasDroppedMetadataField(part, normalizationTriageField));
    }

    if (sortMode === 'defect_desc') {
      output.sort((a, b) => getDefectCount(b) - getDefectCount(a));
    } else if (sortMode === 'batch_asc') {
      output.sort((a, b) => String(a.batch_id || '').localeCompare(String(b.batch_id || '')));
    } else if (sortMode === 'status_asc') {
      output.sort((a, b) => String(a.review_state || 'unreviewed').localeCompare(String(b.review_state || 'unreviewed')));
    } else {
      output.sort((a, b) => String(a.serial_number).localeCompare(String(b.serial_number)));
    }

    return output;
  }, [parts, selectedBatchId, reviewFilter, partFilter, normalizationTriageField, sortMode]);
  const normalizationTriageMatchCount = useMemo(() => {
    if (!normalizationTriageField) return 0;
    return parts.filter((part) => hasDroppedMetadataField(part, normalizationTriageField)).length;
  }, [parts, normalizationTriageField]);

  const selectedPart = useMemo(
    () => filteredParts.find((part) => part.id === selectedPartId) || filteredParts[0] || null,
    [filteredParts, selectedPartId],
  );
  const mprDimensions = useMemo(() => getMprDimensions(selectedPart), [selectedPart]);
  const overlayLayers = useMemo(() => getOverlayLayers(selectedPart), [selectedPart]);
  const modalityOptions = useMemo(() => getModalities(selectedPart), [selectedPart]);
  const activeViewName = useMemo(() => {
    if (!selectedPart) return '';
    const configuredViews = getPartViews(selectedPart);
    if (selectedViewName && configuredViews.includes(selectedViewName)) {
      return selectedViewName;
    }
    return configuredViews[0] || '';
  }, [selectedPart, selectedViewName]);
  const selectedPartImageRefs = useMemo(() => {
    if (!selectedPart?.metadata || typeof selectedPart.metadata !== 'object') return [];
    return getPartImageRefs(selectedPart);
  }, [selectedPart]);
  const selectedImageRecord = useMemo(() => {
    if (!selectedImageRef) return null;
    return projectImageLookup[selectedImageRef] || null;
  }, [projectImageLookup, selectedImageRef]);
  const volumeImageStack = useMemo(
    () => getVolumeSourceImages(selectedPart, projectImageLookup),
    [projectImageLookup, selectedPart],
  );
  const volumeCacheState = useMprVolumeCache(volumeImageStack, mprDimensions);
  const shellImageLayers = useMemo(
    () => getShellImageLayers(selectedPart, projectImageLookup),
    [projectImageLookup, selectedPart],
  );
  const volumePreviewLayers = useMemo(() => {
    if (volumeImageStack.length === 0) return [];
    const maxLayers = 12;
    const step = Math.max(1, Math.floor(volumeImageStack.length / maxLayers));
    return volumeImageStack
      .filter((_, index) => index % step === 0)
      .slice(0, maxLayers)
      .map((entry, index, entries) => ({
        ...entry,
        depth: entries.length <= 1 ? 0 : -48 + (index / (entries.length - 1)) * 96,
        opacity: entries.length <= 1 ? 0.86 : 0.18 + (index / (entries.length - 1)) * 0.26,
      }));
  }, [volumeImageStack]);
  const canShowStackReconstruction = volumePreviewLayers.length > 0;
  const canShowShellReconstruction = shellImageLayers.length > 0;
  const effectiveMprReconstructionMode = (
    mprReconstructionMode === MPR_RECONSTRUCTION_MODES.stack && canShowStackReconstruction
  )
    ? MPR_RECONSTRUCTION_MODES.stack
    : (
      mprReconstructionMode === MPR_RECONSTRUCTION_MODES.shell && canShowShellReconstruction
    )
      ? MPR_RECONSTRUCTION_MODES.shell
      : MPR_RECONSTRUCTION_MODES.orientation;

  useEffect(() => {
    if (mprReconstructionMode !== effectiveMprReconstructionMode) {
      setMprReconstructionMode(effectiveMprReconstructionMode);
    }
  }, [effectiveMprReconstructionMode, mprReconstructionMode]);

  const tooltipValues = useMemo(() => {
    const axisSeed = slicePosition.axial + slicePosition.coronal + slicePosition.sagittal;
    const base = Math.min(
      255,
      Math.max(0, Math.round(((cursorProbe.x * 0.35 + cursorProbe.y * 0.65 + axisSeed) * contrastPercent) / 100)),
    );
    const overlays = activeOverlayIds.map((overlayId, index) => {
      const value = Number((((base + (index + 1) * 17) / 255) * 100).toFixed(1));
      return { overlayId, value };
    });
    return { base, overlays };
  }, [activeOverlayIds, contrastPercent, cursorProbe.x, cursorProbe.y, slicePosition]);

  useEffect(() => {
    if (selectedPart && selectedPart.id !== selectedPartId) {
      setSelectedPartId(selectedPart.id);
    }
  }, [selectedPart, selectedPartId]);

  useEffect(() => {
    if (selectedPartImageRefs.length === 0) {
      setSelectedImageRef('');
      return;
    }
    const hasCurrentImage = selectedPartImageRefs.some((entry) => entry.imageRef === selectedImageRef);
    if (!hasCurrentImage) {
      setSelectedImageRef(selectedPartImageRefs[0].imageRef);
    }
  }, [selectedPartImageRefs, selectedImageRef]);

  useEffect(() => {
    if (!selectedPart || !['PT2', 'PT3'].includes(projectType)) return;
    const savedMpr = workspaceHydration?.mpr || {};
    const savedSlice = savedMpr?.slice_position || {};
    const savedViewport = savedMpr?.viewport_transform || {};
    const savedProbe = savedMpr?.cursor_probe || {};
    setSlicePosition({
      axial: clampRange(savedSlice.axial, 0, Math.max(0, mprDimensions.axial - 1), Math.floor((mprDimensions.axial - 1) / 2)),
      coronal: clampRange(savedSlice.coronal, 0, Math.max(0, mprDimensions.coronal - 1), Math.floor((mprDimensions.coronal - 1) / 2)),
      sagittal: clampRange(savedSlice.sagittal, 0, Math.max(0, mprDimensions.sagittal - 1), Math.floor((mprDimensions.sagittal - 1) / 2)),
    });
    setViewportTransform({
      zoom: clampRange(savedViewport.zoom, 0.5, 4, 1),
      panX: clampRange(savedViewport.panX, -200, 200, 0),
      panY: clampRange(savedViewport.panY, -200, 200, 0),
    });
    setMprReconstructionMode(
      Object.values(MPR_RECONSTRUCTION_MODES).includes(savedMpr.reconstruction_mode)
        ? savedMpr.reconstruction_mode
        : MPR_RECONSTRUCTION_MODES.orientation,
    );
    setMprProjectionMirror(normalizeMprProjectionMirror(savedMpr.projection_mirror));
    setContrastPercent(clampRange(savedMpr.contrast_percent, 50, 150, 100));
    const defaultActive = getOverlayLayers(selectedPart)
      .slice(0, 2)
      .map((overlay) => overlay.id);
    const savedOverlayIds = Array.isArray(savedMpr.active_overlay_ids) ? savedMpr.active_overlay_ids.map((entry) => String(entry)) : [];
    setActiveOverlayIds(savedOverlayIds.length > 0 ? savedOverlayIds : defaultActive);
    setCursorProbe({
      x: clampRange(savedProbe.x, 0, 100, 50),
      y: clampRange(savedProbe.y, 0, 100, 50),
    });
    setSegmentationRun(getLatestRunFromMetadata(selectedPart, 'segmentation_runs'));
    setMeasurementRun(getLatestRunFromMetadata(selectedPart, 'measurement_runs'));
    setMlActionLoading({ segmentation: false, measurement: false });
  }, [selectedPart, projectType, mprDimensions, workspaceHydration]);

  useEffect(() => {
    const savedInspector = workspaceHydration?.inspector || {};
    setNormalizationTriageField(
      typeof savedInspector.normalization_triage_field === 'string'
        ? savedInspector.normalization_triage_field
        : '',
    );
    if (!selectedPart) return;
    const savedModalities = Array.isArray(savedInspector.modalities)
      ? savedInspector.modalities.map((value) => String(value))
      : [];
    setEnabledModalities(savedModalities.length > 0 ? savedModalities : getModalities(selectedPart).slice(0, 1));
    setSelectedViewName(savedInspector.view_name ? String(savedInspector.view_name) : '');
    setImageEnabled(typeof savedInspector.image_enabled === 'boolean' ? savedInspector.image_enabled : true);
    setShortcutHelpVisible(savedInspector.shortcut_help_visible === true);
    setMeasurementEntries(normalizeSavedMeasurements(savedInspector.measurements));
    const savedInspectorViewport = savedInspector.viewport_transform || {};
    setInspectorViewport({
      zoom: clampRange(savedInspectorViewport.zoom, 0.5, 4, 1),
      panX: clampRange(savedInspectorViewport.panX, -200, 200, 0),
      panY: clampRange(savedInspectorViewport.panY, -200, 200, 0),
    });
    setAnnotationDraft({
      defect_class: '',
      modality: getModalities(selectedPart)[0] || 'visual',
      comment: '',
      disposition: 'open',
      measurement_name: '',
      measurement_value: '',
      bbox: { x: '', y: '', width: '', height: '' },
    });
  }, [selectedPart, workspaceHydration]);

  useEffect(() => {
    const loadAnnotations = async () => {
      if (!selectedPart?.id) {
        setAnnotations([]);
        return;
      }
      setAnnotationsLoading(true);
      try {
        const resp = await fetch(`/api/projects/${projectId}/parts/${selectedPart.id}/annotations`);
        if (!resp.ok) {
          throw new Error(`Failed to load annotations (${resp.status})`);
        }
        const payload = await resp.json();
        const annotationItems = Array.isArray(payload?.annotations) ? payload.annotations : [];
        setAnnotations(annotationItems);
      } catch (_err) {
        setAnnotations([]);
      } finally {
        setAnnotationsLoading(false);
      }
    };

    loadAnnotations();
  }, [projectId, selectedPart?.id]);

  useEffect(() => {
    if (!annotations.length) {
      setSelectedAnnotationId(null);
      return;
    }
    if (!annotations.some((annotation) => annotation.id === selectedAnnotationId)) {
      setSelectedAnnotationId(annotations[0].id);
    }
  }, [annotations, selectedAnnotationId]);

  useEffect(() => {
    if (loading || !workspaceStateLoaded) return;
    const saveHandle = setTimeout(async () => {
      try {
        await fetch(`/api/projects/${projectId}/workspace-state`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            state: {
              selected_batch_id: selectedBatchId || '',
              review_filter: reviewFilter,
              part_filter: partFilter,
              sort_mode: sortMode,
              selected_part_id: selectedPart?.id || '',
              mpr: ['PT2', 'PT3'].includes(projectType)
                ? {
                  slice_position: slicePosition,
                  viewport_transform: viewportTransform,
                  reconstruction_mode: mprReconstructionMode,
                  projection_mirror: mprProjectionMirror,
                  contrast_percent: contrastPercent,
                  active_overlay_ids: activeOverlayIds,
                  cursor_probe: cursorProbe,
                }
                : undefined,
              inspector: {
                modalities: enabledModalities,
                view_name: activeViewName || '',
                image_enabled: imageEnabled,
                shortcut_help_visible: shortcutHelpVisible,
                normalization_triage_field: normalizationTriageField || '',
                measurements: measurementEntries,
                viewport_transform: inspectorViewport,
              },
              panel_layout: panelLayout,
            },
          }),
        });
      } catch (_err) {
        // Workspace persistence is non-blocking for main workbench interactions.
      }
    }, 350);
    return () => clearTimeout(saveHandle);
  }, [
    activeOverlayIds,
    activeViewName,
    contrastPercent,
    cursorProbe,
    reviewFilter,
    partFilter,
    enabledModalities,
    imageEnabled,
    shortcutHelpVisible,
    loading,
    measurementEntries,
    normalizationTriageField,
    inspectorViewport,
    panelLayout,
    projectId,
    projectType,
    mprReconstructionMode,
    mprProjectionMirror,
    selectedBatchId,
    selectedPart,
    slicePosition,
    sortMode,
    viewportTransform,
    workspaceStateLoaded,
  ]);

  const updatePartReviewState = useCallback(async (part, nextState) => {
    try {
      setSavingPartId(part.id);
      const resp = await fetch(`/api/projects/${projectId}/parts/${part.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ review_state: nextState }),
      });
      if (!resp.ok) {
        throw new Error(`Failed to update review state (${resp.status})`);
      }
      const updatedPart = await resp.json();
      setParts((prev) => prev.map((item) => (item.id === updatedPart.id ? updatedPart : item)));
    } catch (err) {
      setError(err.message || 'Failed to update part review state');
    } finally {
      setSavingPartId(null);
    }
  }, [projectId]);

  useEffect(() => {
    if (!selectedPart?.id) return undefined;
    const handleInspectorHotkeys = (event) => {
      const focusedTag = event.target?.tagName?.toLowerCase();
      if (focusedTag === 'input' || focusedTag === 'textarea' || focusedTag === 'select' || event.defaultPrevented) {
        return;
      }
      const key = (event.key || '').toLowerCase();
      if (key === inspectorHotkeys.toggle_shortcut_help) {
        event.preventDefault();
        setShortcutHelpVisible((prev) => !prev);
        return;
      }
      if (savingPartId === selectedPart.id) return;
      if (key === inspectorHotkeys.accept_classification) {
        event.preventDefault();
        updatePartReviewState(selectedPart, 'pass');
      } else if (key === inspectorHotkeys.reject_classification) {
        event.preventDefault();
        updatePartReviewState(selectedPart, 'reject_pending');
      }
    };
    document.addEventListener('keydown', handleInspectorHotkeys);
    return () => document.removeEventListener('keydown', handleInspectorHotkeys);
  }, [inspectorHotkeys, savingPartId, selectedPart, updatePartReviewState]);

  const reviewSummary = useMemo(() => {
    return parts.reduce(
      (acc, part) => {
        const state = part.review_state || 'unreviewed';
        acc[state] = (acc[state] || 0) + 1;
        return acc;
      },
      { unreviewed: 0, in_review: 0, pass: 0, reject_pending: 0, reject_confirmed: 0 },
    );
  }, [parts]);

  const updateSlicePosition = (axis, value, dimensions) => {
    const upper = Math.max(0, (dimensions?.[axis] || 1) - 1);
    const nextValue = Math.min(upper, Math.max(0, Number(value) || 0));
    setSlicePosition((prev) => ({ ...prev, [axis]: nextValue }));
  };

  const stepSlicePosition = (axis, delta) => {
    const upper = Math.max(0, (mprDimensions?.[axis] || 1) - 1);
    setSlicePosition((prev) => ({
      ...prev,
      [axis]: Math.min(upper, Math.max(0, Number(prev[axis] || 0) + delta)),
    }));
  };

  const handleMprPaneWheel = (axis, event) => {
    event.preventDefault();
    setActiveMprPane(axis);
    stepSlicePosition(axis, event.deltaY > 0 ? 1 : -1);
  };

  const handleMprVolumeWheel = (event) => {
    event.preventDefault();
    setActiveMprPane('volume');
    adjustZoom(event.deltaY < 0 ? 0.12 : -0.12);
  };

  const handleMprVolumePointerDown = (event) => {
    event.preventDefault();
    if (event.button !== undefined && event.button !== 0) return;
    setActiveMprPane('volume');
    mprDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rotation: mprRotation,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleMprVolumePointerMove = (event) => {
    const drag = mprDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    setMprRotation({
      x: Math.min(72, Math.max(-72, drag.rotation.x - dy * 0.35)),
      y: drag.rotation.y + dx * 0.35,
    });
  };

  const handleMprVolumePointerUp = (event) => {
    const drag = mprDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      event.preventDefault();
      mprDragRef.current = null;
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
  };

  const preventMprNativeDrag = (event) => {
    event.preventDefault();
  };

  const adjustZoom = (delta) => {
    setViewportTransform((prev) => {
      const nextZoom = Math.min(4, Math.max(0.5, Number((prev.zoom + delta).toFixed(2))));
      return { ...prev, zoom: nextZoom };
    });
  };

  const resetViewport = () => {
    setViewportTransform({ zoom: 1, panX: 0, panY: 0 });
    setMprRotation({ x: -22, y: 32 });
  };

  const toggleOverlay = (overlayId) => {
    setActiveOverlayIds((prev) => {
      if (prev.includes(overlayId)) return prev.filter((id) => id !== overlayId);
      return [...prev, overlayId];
    });
  };

  const toggleMprProjectionMirror = (axis) => {
    setMprProjectionMirror((prev) => ({
      ...prev,
      [axis]: !prev[axis],
    }));
  };


  const deleteAnalyzeOverlay = useCallback(async (entry) => {
    const overlayId = entry?.imageId || entry?.imageRef;
    if (!overlayId) return;
    try {
      setDeletingOverlayId(String(overlayId));
      const resp = await fetch(`/api/projects/${projectId}/analyze/overlays/${encodeURIComponent(String(overlayId))}`, {
        method: 'DELETE',
      });
      if (!resp.ok) throw new Error(`Failed to delete Analyze overlay (${resp.status})`);
      const updatedPart = await resp.json();
      setParts((prev) => prev.map((part) => (part.id === updatedPart.id ? updatedPart : part)));
      setSelectedImageRef((current) => (String(current) === String(entry.imageRef) ? '' : current));
    } catch (err) {
      setError(err.message || 'Failed to delete Analyze overlay');
    } finally {
      setDeletingOverlayId('');
    }
  }, [projectId]);


  const runSegmentation = async () => {
    if (!selectedPart) return;
    try {
      setMlActionLoading((prev) => ({ ...prev, segmentation: true }));
      const resp = await fetch(`/api/projects/${projectId}/parts/${selectedPart.id}/segmentation-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ axis: 'axial', slice_index: slicePosition.axial }),
      });
      if (!resp.ok) {
        throw new Error(`Failed to run segmentation (${resp.status})`);
      }
      const result = await resp.json();
      setSegmentationRun(result);
      if (result.overlay_id) {
        setActiveOverlayIds((prev) => (prev.includes(result.overlay_id) ? prev : [...prev, result.overlay_id]));
      }
    } catch (err) {
      setError(err.message || 'Failed to run segmentation');
    } finally {
      setMlActionLoading((prev) => ({ ...prev, segmentation: false }));
    }
  };

  const runMeasurements = async () => {
    if (!selectedPart) return;
    try {
      setMlActionLoading((prev) => ({ ...prev, measurement: true }));
      const resp = await fetch(`/api/projects/${projectId}/parts/${selectedPart.id}/measurement-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          measurement_profile: 'workbench-default',
          include_overlays: activeOverlayIds,
        }),
      });
      if (!resp.ok) {
        throw new Error(`Failed to run AI measurements (${resp.status})`);
      }
      const result = await resp.json();
      setMeasurementRun(result);
    } catch (err) {
      setError(err.message || 'Failed to run AI measurements');
    } finally {
      setMlActionLoading((prev) => ({ ...prev, measurement: false }));
    }
  };

  const resetAnnotationDraft = () => {
    setAnnotationDraft({
      defect_class: '',
      modality: enabledModalities[0] || modalityOptions[0] || 'visual',
      comment: '',
      disposition: 'open',
      measurement_name: '',
      measurement_value: '',
      bbox: { x: '', y: '', width: '', height: '' },
    });
  };

  const createAnnotation = async () => {
    if (!selectedPart?.id || !annotationDraft.defect_class.trim()) return;
    const measurementName = annotationDraft.measurement_name.trim();
    const measurementValue = Number(annotationDraft.measurement_value);
    const measurements = measurementName && Number.isFinite(measurementValue)
      ? { [measurementName]: Number(measurementValue.toFixed(2)) }
      : {};
    const bboxPayload = ['x', 'y', 'width', 'height'].reduce((acc, key) => {
      const value = Number(annotationDraft.bbox[key]);
      if (Number.isFinite(value)) {
        acc[key] = value;
      }
      return acc;
    }, {});

    const payload = {
      defect_class: annotationDraft.defect_class.trim(),
      modality: (annotationDraft.modality || enabledModalities[0] || modalityOptions[0] || 'visual').trim(),
      comment: annotationDraft.comment.trim() || null,
      disposition: annotationDraft.disposition,
      measurements,
      bbox: Object.keys(bboxPayload).length === 4 ? bboxPayload : null,
      hidden: false,
    };

    try {
      const resp = await fetch(`/api/projects/${projectId}/parts/${selectedPart.id}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        throw new Error(`Failed to create annotation (${resp.status})`);
      }
      const created = await resp.json();
      setAnnotations((prev) => [created, ...prev]);
      resetAnnotationDraft();
    } catch (err) {
      setError(err.message || 'Failed to create annotation');
    }
  };

  const createMeasurementAnnotation = async ({ imageId, line, name, color, distanceMm }) => {
    if (!selectedPart?.id || !line || !line.imageWidth || !line.imageHeight) return;
    const width = Math.abs(line.x2 - line.x1);
    const height = Math.abs(line.y2 - line.y1);
    const distancePixels = Math.sqrt((width ** 2) + (height ** 2));
    const payload = {
      image_id: imageId ? String(imageId) : null,
      defect_class: 'Measurement',
      modality: activeViewName || enabledModalities[0] || modalityOptions[0] || 'visual',
      comment: name || 'Captured from measurement tool.',
      disposition: 'open',
      measurements: { length_px: Number(distancePixels.toFixed(2)), ...(Number.isFinite(distanceMm) ? { length_mm: Number(distanceMm.toFixed(2)) } : {}) },
      geometry: { line },
      metadata: { measurement_color: color },
      bbox: {
        x: Number(Math.min(line.x1, line.x2).toFixed(2)),
        y: Number(Math.min(line.y1, line.y2).toFixed(2)),
        width: Number(width.toFixed(2)),
        height: Number(height.toFixed(2)),
      },
      hidden: false,
    };
    try {
      const resp = await fetch(`/api/projects/${projectId}/parts/${selectedPart.id}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`Failed to create measurement annotation (${resp.status})`);
      const created = await resp.json();
      setAnnotations((prev) => [created, ...prev]);
      setSelectedAnnotationId(created.id);
      return created;
    } catch (err) {
      setError(err.message || 'Failed to create measurement annotation');
      return null;
    }
  };

  const updateAnnotationVisibility = async (annotationId, hidden) => {
    if (!selectedPart?.id) return;
    try {
      const resp = await fetch(`/api/projects/${projectId}/parts/${selectedPart.id}/annotations/${annotationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden }),
      });
      if (!resp.ok) {
        throw new Error(`Failed to update annotation (${resp.status})`);
      }
      const updated = await resp.json();
      setAnnotations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setError(err.message || 'Failed to update annotation');
    }
  };

  const startAnnotationEdit = (annotation) => {
    setEditingAnnotationId(annotation.id);
    setAnnotationEditDraft({
      defect_class: annotation.defect_class || '',
      modality: annotation.modality || '',
      comment: annotation.comment || '',
      disposition: annotation.disposition || 'open',
    });
  };

  const cancelAnnotationEdit = () => {
    setEditingAnnotationId(null);
    setAnnotationEditDraft({
      defect_class: '',
      modality: '',
      comment: '',
      disposition: 'open',
    });
  };

  const updateAnnotationDetails = async (annotationId) => {
    if (!selectedPart?.id || !annotationEditDraft.defect_class.trim()) return;
    try {
      const resp = await fetch(`/api/projects/${projectId}/parts/${selectedPart.id}/annotations/${annotationId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defect_class: annotationEditDraft.defect_class.trim(),
          modality: (annotationEditDraft.modality || enabledModalities[0] || modalityOptions[0] || 'visual').trim(),
          comment: annotationEditDraft.comment.trim() || null,
          disposition: annotationEditDraft.disposition,
        }),
      });
      if (!resp.ok) {
        throw new Error(`Failed to update annotation (${resp.status})`);
      }
      const updated = await resp.json();
      setAnnotations((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      cancelAnnotationEdit();
    } catch (err) {
      setError(err.message || 'Failed to update annotation');
    }
  };

  const renderPartSummaryPane = () => (
    <section
      className="workbench-tabbed-panel"
      data-layout-region={inspectionHierarchy.leftColumn}
    >
      <div className="workspace-panel-layout">
        <div className="workbench-controls workbench-controls-compact">
          <label htmlFor="batchFilter" className="form-label">Batch</label>
          <select
            id="batchFilter"
            className="form-control"
            value={selectedBatchId}
            onChange={(e) => setSelectedBatchId(e.target.value)}
          >
            <option value="">All batches</option>
            {batches.map((batch) => (
              <option key={batch.id} value={batch.id}>{batch.name}</option>
            ))}
          </select>

          <label htmlFor="reviewFilter" className="form-label">Status</label>
          <select
            id="reviewFilter"
            className="form-control"
            value={reviewFilter}
            onChange={(e) => setReviewFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="pass">Pass</option>
            <option value="reject_pending">Fail</option>
            <option value="reject_confirmed">Fail (confirmed)</option>
            <option value="manual">Manual</option>
            <option value="none">None</option>
          </select>
          {manualFilterNotice && reviewFilter === 'manual' && (
            <p className="muted">{manualFilterNotice}</p>
          )}

          <label htmlFor="partFilter" className="form-label">Filter</label>
          <input
            id="partFilter"
            className="form-control"
            type="text"
            value={partFilter}
            onChange={(e) => setPartFilter(e.target.value)}
            placeholder="Filter by batch # or part #"
          />

          <label htmlFor="sortMode" className="form-label">Sort</label>
          <select
            id="sortMode"
            className="form-control"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value)}
          >
            <option value="part_asc">Part # (A -> Z)</option>
            <option value="batch_asc">Batch # (A -> Z)</option>
            <option value="status_asc">Inspection status</option>
            <option value="defect_desc">Defect count (high -> low)</option>
          </select>
        </div>
        <div className="workbench-list">
          {filteredParts.length === 0 ? (
            <div>
              <p className="muted">No parts found for the current filters.</p>
              {normalizationTriageField && (
                <p className="muted" data-testid="normalization-triage-empty-guidance">
                  {normalizationTriageMatchCount > 0
                    ? `Triage matches exist for ${normalizationTriageField}, but they are hidden by the active filters.`
                    : `No parts in this project contain mixed ${normalizationTriageField} metadata values.`}
                </p>
              )}
            </div>
          ) : (
            (() => {
              const partsByBatch = filteredParts.reduce((acc, part) => {
                const key = String(part.batch_id || 'No Batch');
                if (!acc.has(key)) acc.set(key, []);
                acc.get(key).push(part);
                return acc;
              }, new Map());
              return Array.from(partsByBatch.entries()).map(([batchKey, batchParts]) => (
                <div key={batchKey} className="part-summary-batch">
                  {batchParts.map((part) => {
                    const state = part.review_state || 'unreviewed';
                    const defectCount = getDefectCount(part);
                    const annotationCount = Array.isArray(part?.metadata?.annotations) ? part.metadata.annotations.length : 0;
                    const isSelected = part.id === selectedPart?.id;
                    const viewImages = part?.metadata?.view_images || {};
                    const imageEntries = Object.entries(viewImages);
                    return (
                      <article
                        key={part.id}
                        className={`workbench-part-row ${isSelected ? 'selected' : ''}`}
                        onClick={() => setSelectedPartId(part.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            setSelectedPartId(part.id);
                          }
                        }}
                      >
                        <div>
                          <div className="group-row-name">{part.display_name || part.serial_number}</div>
                          <div className="workbench-defect-count">
                            Defects: {defectCount} • Annotations: {annotationCount}
                          </div>
                          {imageEntries.length > 0 && (
                            <div className="part-summary-images">
                              {imageEntries.map(([viewName, imageRef]) => (
                                <button
                                  type="button"
                                  key={`${part.id}-${viewName}`}
                                  className={`btn btn-secondary btn-sm ${isSelected && activeViewName === viewName ? 'active' : ''}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setSelectedPartId(part.id);
                                    setSelectedViewName(viewName);
                                    setSelectedImageRef(String(imageRef || ''));
                                  }}
                                >
                                  {viewName.toUpperCase()}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <span className={`group-status-badge group-status-${state}`} data-testid="part-review-state">
                          {REVIEW_LABELS[state] || REVIEW_LABELS.unreviewed}
                        </span>
                      </article>
                    );
                  })}
                </div>
              ));
            })()
          )}
        </div>
      </div>
    </section>
  );

  const renderMprPane = () => (
    <section className="mpr-shell" data-testid="mpr-panel" aria-label="Multi-Planar Reconstruction">
      {!selectedPart ? (
        <p className="muted">No part selected. Select a part to inspect the volume.</p>
      ) : (
        <>
          <div className="mpr-control-strip">
            <label htmlFor="mpr-contrast">
              Contrast
              <input
                id="mpr-contrast"
                type="range"
                min="50"
                max="150"
                value={contrastPercent}
                onChange={(event) => setContrastPercent(Number(event.target.value))}
              />
            </label>
            <span className="group-badge">{contrastPercent}%</span>
            <label className="mpr-reconstruction-selector" htmlFor="mpr-reconstruction-mode">
              3D view
              <select
                id="mpr-reconstruction-mode"
                value={mprReconstructionMode}
                onChange={(event) => setMprReconstructionMode(event.target.value)}
              >
                <option value={MPR_RECONSTRUCTION_MODES.orientation}>Orientation only</option>
                <option value={MPR_RECONSTRUCTION_MODES.stack} disabled={!canShowStackReconstruction}>
                  Stack reconstruction
                </option>
                <option value={MPR_RECONSTRUCTION_MODES.shell} disabled={!canShowShellReconstruction}>
                  Reference shell
                </option>
              </select>
            </label>
            <div className="overlay-toggles">
              {overlayLayers.map((overlay) => (
                <label key={overlay.id} className="overlay-toggle">
                  <input
                    type="checkbox"
                    checked={activeOverlayIds.includes(overlay.id)}
                    onChange={() => toggleOverlay(overlay.id)}
                  />
                  <span className="overlay-swatch" style={{ backgroundColor: overlay.color }} />
                  {overlay.label}
                </label>
              ))}
            </div>
            <span className="mpr-probe-readout">Probe {tooltipValues.base}</span>
            <div className="mpr-ml-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!selectedPart || mlActionLoading.segmentation}
                onClick={runSegmentation}
              >
                {mlActionLoading.segmentation ? 'Running Segmentation...' : 'Run Segmentation'}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={!selectedPart || mlActionLoading.measurement}
                onClick={runMeasurements}
              >
                {mlActionLoading.measurement ? 'Running Measurements...' : 'Run Measurements'}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={resetViewport}>Reset 3D</button>
            </div>
          </div>
          <div className="mpr-grid mpr-grid-four">
            {MPR_AXES.map((axis) => {
              const upper = Math.max(0, (mprDimensions[axis] || 1) - 1);
              const config = MPR_AXIS_CONFIG[axis];
              const label = config?.label || MPR_AXIS_LABELS[axis] || axis.toUpperCase();
              const isMirrored = mprProjectionMirror[axis] === true;
              const crosshairStyle = getMprCrosshairStyle(axis, slicePosition, mprDimensions, mprProjectionMirror);
              const fallbackImage = getFallbackProjectionImage(axis, shellImageLayers);
              return (
                <article
                  key={axis}
                  className={`mpr-pane mpr-pane-${axis} ${activeMprPane === axis ? 'active-pane' : ''}`}
                  style={{ '--mpr-axis-color': config?.color, ...crosshairStyle }}
                  data-testid={`mpr-pane-${axis}`}
                  onClick={() => setActiveMprPane(axis)}
                  onWheel={(event) => handleMprPaneWheel(axis, event)}
                >
                  <header className="mpr-pane-header">
                    <strong>{label}</strong>
                    <div className="mpr-pane-header-controls">
                      <span>{config?.sliceLabel || axis.toUpperCase()} {slicePosition[axis]} / {upper}</span>
                      <label className="mpr-mirror-toggle" htmlFor={`mpr-mirror-${axis}`} onClick={(event) => event.stopPropagation()}>
                        <input
                          id={`mpr-mirror-${axis}`}
                          type="checkbox"
                          checked={isMirrored}
                          onChange={() => toggleMprProjectionMirror(axis)}
                        />
                        Mirror
                      </label>
                    </div>
                  </header>
                  <div
                    className="mpr-crosshair-preview"
                    aria-label={`${label} slice preview`}
                    data-testid={`mpr-preview-${axis}`}
                    style={crosshairStyle}
                  >
                    {volumeImageStack.length > 0 ? (
                      <MprSliceCanvas
                        axis={axis}
                        volumeCache={volumeCacheState.cache}
                        volumeCacheStatus={volumeCacheState.status}
                        slicePosition={slicePosition}
                        dimensions={mprDimensions}
                      />
                    ) : fallbackImage ? (
                      <img
                        className="mpr-fallback-projection"
                        src={fallbackImage.url}
                        alt={`${label} fallback projection from ${fallbackImage.viewName} view`}
                        loading="lazy"
                      />
                    ) : (
                      <span className="mpr-empty-volume">No volume stack images</span>
                    )}
                    <span className="mpr-crosshair-h" />
                    <span className="mpr-crosshair-v" />
                    <span className="mpr-crosshair-center" />
                  </div>
                  <label className="mpr-slice-control" htmlFor={`mpr-slice-${axis}`}>
                    Slice
                    <input
                      id={`mpr-slice-${axis}`}
                      type="range"
                      min="0"
                      max={upper}
                      value={slicePosition[axis]}
                      onChange={(event) => updateSlicePosition(axis, event.target.value, mprDimensions)}
                    />
                  </label>
                </article>
              );
            })}
            <article
              className={`mpr-pane mpr-pane-volume ${activeMprPane === 'volume' ? 'active-pane' : ''}`}
              data-testid="mpr-pane-3d"
              onClick={() => setActiveMprPane('volume')}
              onWheel={handleMprVolumeWheel}
            >
              <header className="mpr-pane-header">
                <strong>3D</strong>
                <span>Zoom {viewportTransform.zoom.toFixed(2)}x</span>
              </header>
              <div
                className="mpr-volume-scene"
                role="img"
                aria-label="3D part view with colored slicing plane reticle"
                onPointerDown={handleMprVolumePointerDown}
                onPointerMove={handleMprVolumePointerMove}
                onPointerUp={handleMprVolumePointerUp}
                onPointerCancel={handleMprVolumePointerUp}
                onDragStart={preventMprNativeDrag}
              >
                <div
                  className={`mpr-volume-model reconstruction-${effectiveMprReconstructionMode}`}
                  style={{
                    '--volume-rotate-x': `${mprRotation.x}deg`,
                    '--volume-rotate-y': `${mprRotation.y}deg`,
                    '--volume-zoom': viewportTransform.zoom,
                    '--slice-axial-depth': `${(getFraction(slicePosition.axial, mprDimensions.axial - 1) - 0.5) * 108}px`,
                    '--slice-coronal-y': `${(getFraction(slicePosition.coronal, mprDimensions.coronal - 1) - 0.5) * 138}px`,
                    '--slice-sagittal-x': `${(getFraction(slicePosition.sagittal, mprDimensions.sagittal - 1) - 0.5) * 190}px`,
                  }}
                >
                  {effectiveMprReconstructionMode === MPR_RECONSTRUCTION_MODES.stack ? (
                    volumePreviewLayers.map((layer) => (
                      <img
                        key={`${layer.id}-${layer.sliceIndex}`}
                        className="volume-slice-layer"
                        src={layer.url}
                        alt={`Volume reconstruction slice ${layer.sliceIndex}`}
                        draggable={false}
                        onDragStart={preventMprNativeDrag}
                        style={{
                          '--slice-depth': `${layer.depth}px`,
                          '--slice-opacity': layer.opacity,
                        }}
                        loading="lazy"
                      />
                    ))
                  ) : effectiveMprReconstructionMode === MPR_RECONSTRUCTION_MODES.shell ? (
                    shellImageLayers.map((layer) => (
                      <img
                        key={`${layer.id}-${layer.viewName}`}
                        className={`volume-shell-image shell-view-${layer.viewName}`}
                        src={layer.url}
                        alt={`Fallback visual hull shell ${layer.viewName} view`}
                        draggable={false}
                        onDragStart={preventMprNativeDrag}
                        loading="lazy"
                      />
                    ))
                  ) : !canShowStackReconstruction && !canShowShellReconstruction ? (
                    <span className="volume-reconstruction-empty">No 3D reference</span>
                  ) : null}
                  {volumeCacheState.status === 'loading' && volumeImageStack.length > 0 && (
                    <span className="volume-cache-status">Caching slices</span>
                  )}
                  <span className="volume-box volume-face-front" />
                  <span className="volume-box volume-face-back" />
                  <span className="volume-box volume-face-left" />
                  <span className="volume-box volume-face-right" />
                  <span className="volume-box volume-face-top" />
                  <span className="volume-box volume-face-bottom" />
                  <span className="volume-plane plane-axial" />
                  <span className="volume-plane plane-coronal" />
                  <span className="volume-plane plane-sagittal" />
                  <span className="volume-reticle reticle-x" />
                  <span className="volume-reticle reticle-y" />
                  <span className="volume-reticle reticle-z" />
                </div>
              </div>
              <div className="mpr-volume-legend" aria-label="MPR axis legend">
                {MPR_AXES.map((axis) => (
                  <span key={axis} className={`chip chip-${axis}`}>
                    <span className="overlay-swatch" style={{ backgroundColor: MPR_AXIS_CONFIG[axis].color }} />
                    {MPR_AXIS_CONFIG[axis].label}
                  </span>
                ))}
              </div>
            </article>
          </div>
          {(segmentationRun || measurementRun) && (
            <div className="workbench-notice">
              {segmentationRun && <p>Segmentation: {segmentationRun.status || 'complete'}</p>}
              {measurementRun && <p>Measurements: {measurementRun.status || 'complete'}</p>}
            </div>
          )}
        </>
      )}
    </section>
  );

  const renderCenterPane = (tabKey) => (
    <section
      className="workbench-tabbed-panel"
      data-layout-region="center"
    >
      <div className="workspace-panel-layout" data-testid={tabKey === 'mpr' ? 'mpr-center-panel' : 'selected-image-panel'}>
        {tabKey === 'mpr' ? (
          renderMprPane()
        ) : tabKey === 'image_metadata' ? (
          !selectedPart ? (
            <p className="muted">No part selected. Select a part to review image metadata.</p>
          ) : selectedPartImageRefs.length === 0 ? (
            <p className="muted">No mapped images for this part.</p>
          ) : !selectedImageRef ? (
            <p className="muted">Select an image in Part Summary to review metadata.</p>
          ) : (
            <div className="workbench-notice" data-testid="selected-image-metadata-panel">
              <p><strong>Selected image:</strong> {safeDecodeFilename(selectedImageRef)}</p>
              <p className="muted">
                Image ID: {selectedImageRecord?.id ? String(selectedImageRecord.id) : 'Unavailable'}
              </p>
              <pre>{JSON.stringify(selectedImageRecord?.metadata || {}, null, 2)}</pre>
            </div>
          )
        ) : (
          !selectedPart ? (
            <p className="muted">No part selected. Select a part to inspect mapped images.</p>
          ) : selectedPartImageRefs.length === 0 ? (
            <p className="muted">No mapped images for this part.</p>
          ) : (
            <div className="view-board" data-layout-region="visual_workspace">
              {selectedPartImageRefs.map((entry) => {
                const viewName = entry.viewName || 'image';
                const imageRef = String(entry.imageRef || '');
                const imageRecord = projectImageLookup[entry.imageId] || projectImageLookup[imageRef];
                const imageId = imageRecord?.id || entry.imageId || '';
                const baseRecord = entry.overlay
                  ? (projectImageLookup[entry.overlayBaseImageId] || projectImageLookup[entry.overlayBaseFilename])
                  : null;
                const baseImageId = baseRecord?.id || entry.overlayBaseImageId || '';
                return (
                  <div
                    key={entry.id}
                    className={`view-cell ${activeViewName === viewName ? 'selected' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setSelectedViewName(viewName);
                      setSelectedImageRef(imageRef);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelectedViewName(viewName);
                        setSelectedImageRef(imageRef);
                      }
                    }}
                  >
                    <div className="view-cell-title">
                      <span>{entry.label || viewName.toUpperCase()}</span>
                      {entry.overlay && entry.imageId && (
                        <button
                          type="button"
                          className="inspection-overlay-delete"
                          aria-label={`Delete overlay ${entry.label || viewName}`}
                          disabled={deletingOverlayId === String(entry.imageId)}
                          onClick={(event) => {
                            event.stopPropagation();
                            deleteAnalyzeOverlay(entry);
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                    <div className="view-cell-body">
                      {!imageEnabled ? (
                        <span className="view-cell-empty">Image hidden</span>
                      ) : entry.overlay && imageId && baseImageId ? (
                        <div
                          className="inspection-overlay-composite"
                          data-testid="inspection-overlay-composite"
                          onClick={(event) => {
                            event.stopPropagation();
                            setFullscreenImageModal({ imageId: String(imageId), label: entry.label || viewName.toUpperCase() });
                          }}
                        >
                          <img
                            className="inspection-view-image"
                            src={`/api/images/${encodeURIComponent(String(baseImageId))}/content`}
                            alt={`${viewName} source`}
                            loading="lazy"
                          />
                          <img
                            className="inspection-view-image analysis-overlay-image"
                            src={`/api/images/${encodeURIComponent(String(imageId))}/content`}
                            alt={`${viewName} overlay`}
                            loading="lazy"
                          />
                        </div>
                      ) : imageId ? (
                        <>
                          <img
                            className="inspection-view-image"
                            src={`/api/images/${encodeURIComponent(String(imageId))}/content`}
                            alt={`${viewName} view`}
                            loading="lazy"
                            onClick={(event) => {
                              event.stopPropagation();
                              setFullscreenImageModal({ imageId: String(imageId), label: entry.label || viewName.toUpperCase() });
                            }}
                          />
                          <svg className="inspection-fullscreen-measurement-overlay" viewBox={`0 0 1000 1000`} preserveAspectRatio="none" aria-label="tile measurement overlay">
                            {(measurementLinesByImageId[String(imageId)] || []).filter(isFiniteMeasurementLine).map((line) => {
                              const labelPosition = getMeasurementLabelViewBoxPosition(line, 30);
                              return (
                                <g key={line.id}>
                                  <line x1={(line.x1 / line.imageWidth) * 1000} y1={(line.y1 / line.imageHeight) * 1000} x2={(line.x2 / line.imageWidth) * 1000} y2={(line.y2 / line.imageHeight) * 1000} stroke={line.color} strokeWidth="3" />
                                  <text x={labelPosition.x} y={labelPosition.y} fill={line.color} fontSize="30">
                                    {getMeasurementLineLabel(line)}
                                  </text>
                                </g>
                              );
                            })}
                          </svg>
                        </>
                      ) : imageRef ? (
                        <span className="view-cell-empty">Image not found: {safeDecodeFilename(imageRef)}</span>
                      ) : (
                        <span className="view-cell-empty">No image mapped</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>
    </section>
  );

  const renderAnnotationsPane = () => (
    <section
      className="workbench-tabbed-panel"
      data-layout-region={inspectionHierarchy.rightColumn}
    >
      <div className="annotation-controls" data-testid="annotation-controls">
        <p className="muted">For selected part: {selectedPart?.serial_number || 'No part selected'}</p>
        <div className="measurement-fields">
          <select
            aria-label="Annotation defect type"
            value={annotationDraft.defect_class}
            onChange={(event) => setAnnotationDraft((prev) => ({ ...prev, defect_class: event.target.value }))}
          >
            <option value="">Defect type</option>
            <option value="Crack">Crack</option>
            <option value="Dent">Dent</option>
            <option value="Scratch">Scratch</option>
            <option value="Other">Other</option>
          </select>
          <input
            type="text"
            placeholder="annotation modality"
            value={annotationDraft.modality}
            onChange={(event) => setAnnotationDraft((prev) => ({ ...prev, modality: event.target.value }))}
          />
          <select
            aria-label="Annotation disposition"
            value={annotationDraft.disposition}
            onChange={(event) => setAnnotationDraft((prev) => ({ ...prev, disposition: event.target.value }))}
          >
            <option value="open">Open</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
            <option value="needs_info">Needs Info</option>
          </select>
        </div>
        <div className="measurement-fields">
          <input
            type="text"
            placeholder="measurement name"
            value={annotationDraft.measurement_name}
            onChange={(event) => setAnnotationDraft((prev) => ({ ...prev, measurement_name: event.target.value }))}
          />
          <input
            type="number"
            placeholder="measurement value"
            value={annotationDraft.measurement_value}
            onChange={(event) => setAnnotationDraft((prev) => ({ ...prev, measurement_value: event.target.value }))}
          />
          <input
            type="text"
            placeholder="annotation comment"
            value={annotationDraft.comment}
            onChange={(event) => setAnnotationDraft((prev) => ({ ...prev, comment: event.target.value }))}
          />
        </div>
        <div className="measurement-fields">
          {['x', 'y', 'width', 'height'].map((key) => (
            <input
              key={key}
              type="number"
              placeholder={`bbox ${key}`}
              value={annotationDraft.bbox[key]}
              onChange={(event) => setAnnotationDraft((prev) => ({
                ...prev,
                bbox: { ...prev.bbox, [key]: event.target.value },
              }))}
            />
          ))}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={createAnnotation}
            disabled={!selectedPart}
          >
            Add annotation
          </button>
        </div>
        <ul className="measurement-list" data-testid="annotation-list">
          {annotationsLoading ? (
            <li className="muted">Loading annotations…</li>
          ) : annotations.length === 0 ? (
            <li className="muted">No annotations captured.</li>
          ) : (
            annotations.map((annotation) => (
              <li
                key={annotation.id}
                className={`annotation-entry ${selectedAnnotationId === annotation.id ? 'selected' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedAnnotationId(annotation.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    setSelectedAnnotationId(annotation.id);
                  }
                }}
              >
                {editingAnnotationId === annotation.id ? (
                  <div className="measurement-fields">
                    <input
                      type="text"
                      aria-label="Edit annotation defect class"
                      value={annotationEditDraft.defect_class}
                      onChange={(event) => setAnnotationEditDraft((prev) => ({ ...prev, defect_class: event.target.value }))}
                    />
                    <input
                      type="text"
                      aria-label="Edit annotation modality"
                      value={annotationEditDraft.modality}
                      onChange={(event) => setAnnotationEditDraft((prev) => ({ ...prev, modality: event.target.value }))}
                    />
                    <select
                      aria-label="Edit annotation disposition"
                      value={annotationEditDraft.disposition}
                      onChange={(event) => setAnnotationEditDraft((prev) => ({ ...prev, disposition: event.target.value }))}
                    >
                      <option value="open">Open</option>
                      <option value="accepted">Accepted</option>
                      <option value="rejected">Rejected</option>
                      <option value="needs_info">Needs Info</option>
                    </select>
                    <input
                      type="text"
                      aria-label="Edit annotation comment"
                      value={annotationEditDraft.comment}
                      onChange={(event) => setAnnotationEditDraft((prev) => ({ ...prev, comment: event.target.value }))}
                    />
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => updateAnnotationDetails(annotation.id)}>
                      Save
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={cancelAnnotationEdit}>
                      Cancel
                    </button>
                  </div>
                ) : selectedAnnotationId === annotation.id ? (
                  <>
                    <span>
                      {annotation.defect_class} • {annotation.modality} • {annotation.disposition}
                      {annotation.hidden ? ' • Hidden' : ' • Visible'}
                      {' • '}
                      {annotation.updated_by || annotation.created_by || 'unknown'}
                      {' @ '}
                      {(annotation.updated_at || annotation.created_at || '').slice(0, 19).replace('T', ' ')}
                    </span>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => startAnnotationEdit(annotation)}>
                      Edit
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => updateAnnotationVisibility(annotation.id, !annotation.hidden)}>
                      {annotation.hidden ? 'Show' : 'Hide'}
                    </button>
                  </>
                ) : (
                  <span>
                    {annotation.defect_class || 'Untitled annotation'}
                    {(annotation.updated_at || annotation.created_at) ? (
                      <>
                        {' • '}
                        {annotation.updated_by || annotation.created_by || 'unknown'}
                        {' @ '}
                        {(annotation.updated_at || annotation.created_at || '').slice(0, 19).replace('T', ' ')}
                      </>
                    ) : null}
                  </span>
                )}
              </li>
            ))
          )}
        </ul>
      </div>
    </section>
  );

  const inspectionFlexLayoutFactory = (node) => {
    const component = node.getComponent();
    if (component === inspectionHierarchy.leftColumn) return renderPartSummaryPane();
    if (component === inspectionHierarchy.rightColumn) return renderAnnotationsPane();
    if (inspectionHierarchy.centerTabs.includes(component)) return renderCenterPane(component);
    return null;
  };

  const handleInspectionFlexLayoutChange = (model, action) => {
    if (action?.type !== Actions.ADJUST_WEIGHTS || availableLayoutWidth <= 0) return;
    const json = model.toJson();
    const children = json?.layout?.children || [];
    const left = children.find((child) => child.id === INSPECTION_FLEX_TABSET_IDS.left);
    const right = children.find((child) => child.id === INSPECTION_FLEX_TABSET_IDS.right);
    const totalWeight = children.reduce((sum, child) => sum + Number(child.weight || 0), 0);
    if (!left || !right || totalWeight <= 0) return;
    const availableWidth = Math.max(0, availableLayoutWidth - (children.length - 1) * RESIZE_HANDLE_WIDTH_PX);
    const nextWidths = {
      leftPx: Math.round((Number(left.weight || 0) / totalWeight) * availableWidth),
      rightPx: Math.round((Number(right.weight || 0) / totalWeight) * availableWidth),
    };
    if (inspectionResizeSaveTimerRef.current) {
      window.clearTimeout(inspectionResizeSaveTimerRef.current);
    }
    inspectionResizeSaveTimerRef.current = window.setTimeout(() => {
      saveInspectionColumnWidths(nextWidths);
    }, 250);
  };

  const renderWorkbenchModal = () => {
    if (!activeWorkbenchModal) return null;
    const modalTitle = activeWorkbenchModal === 'parts' ? 'Part Selection' : 'Annotations';
    return (
      <div className="modal" style={{ display: 'flex' }} onClick={() => setActiveWorkbenchModal(null)}>
        <div className="modal-content workbench-utility-modal" onClick={(event) => event.stopPropagation()}>
          <div className="modal-header">
            <h3>{modalTitle}</h3>
            <button
              type="button"
              className="modal-close-btn"
              aria-label={`Close ${modalTitle}`}
              onClick={() => setActiveWorkbenchModal(null)}
            >
              &times;
            </button>
          </div>
          <div className="modal-body">
            {activeWorkbenchModal === 'parts' ? renderPartSummaryPane() : renderAnnotationsPane()}
          </div>
        </div>
      </div>
    );
  };

  const renderPt3FocusedWorkbench = () => (
    <div className="workbench-details workbench-details-pt3" ref={workbenchDetailsRef}>
      <div className="pt3-mpr-topbar">
        <div className="pt3-mpr-context">
          <strong>{selectedPart?.display_name || selectedPart?.serial_number || 'No part selected'}</strong>
          <span>Batches: {batches.length}</span>
          <span>Parts: {parts.length}</span>
          <span>Passed: {reviewSummary.pass}</span>
          <span>Rejected: {reviewSummary.reject_confirmed + reviewSummary.reject_pending}</span>
          <span className="pt3-hotkey-hints" data-testid="inspector-hotkey-hints">
            Hotkeys: pass ({inspectorHotkeys.accept_classification.toUpperCase()}), reject (
            {inspectorHotkeys.reject_classification.toUpperCase()}), shortcuts help (
            {inspectorHotkeys.toggle_shortcut_help.toUpperCase()}).
          </span>
        </div>
        <div className="workbench-detail-actions">
          <button type="button" className="btn btn-secondary" onClick={() => setActiveWorkbenchModal('parts')}>
            Part Selection
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setActiveWorkbenchModal('annotations')}>
            Annotations
          </button>
          {selectedPart && (
            <>
              <button
                className="btn btn-secondary"
                disabled={savingPartId === selectedPart.id}
                onClick={() => updatePartReviewState(selectedPart, 'in_review')}
              >
                In Review
              </button>
              <button
                className="btn btn-success"
                disabled={savingPartId === selectedPart.id}
                onClick={() => updatePartReviewState(selectedPart, 'pass')}
              >
                Mark Pass
              </button>
              <button
                className="btn btn-danger"
                disabled={savingPartId === selectedPart.id}
                onClick={() => updatePartReviewState(selectedPart, 'reject_pending')}
              >
                Flag Reject
              </button>
            </>
          )}
        </div>
      </div>
      {shortcutHelpVisible && (
        <div className="workbench-notice" data-testid="shortcut-help-panel">
          <strong>Shortcut help</strong>
          <ul>
            <li>Mark Pass: {inspectorHotkeys.accept_classification.toUpperCase()}</li>
            <li>Flag Reject: {inspectorHotkeys.reject_classification.toUpperCase()}</li>
            <li>Toggle this help: {inspectorHotkeys.toggle_shortcut_help.toUpperCase()}</li>
          </ul>
        </div>
      )}
      {renderMprPane()}
      {renderWorkbenchModal()}
    </div>
  );



  const classifyMeasurementLine = (line) => {
    const dx = Math.abs(line.x2 - line.x1);
    const dy = Math.abs(line.y2 - line.y1);
    const horizontal = dy <= Math.max(dx, 1) * 0.1;
    const vertical = dx <= Math.max(dy, 1) * 0.1;
    if (horizontal) return 'Horizontal';
    if (vertical) return 'Vertical';
    return 'Diagonal';
  };

  const nextMeasurementName = (kind) => {
    const count = fullscreenMeasurements.filter((item) => item.kind === kind).length + 1;
    return `${kind} line ${count}`;
  };

  const getLineDistanceMm = (line, imageId) => {
    const pixelsPerMm = Number(getCalibrationForImage(imageId)?.pixels_per_mm || 0);
    const distancePx = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
    return pixelsPerMm > 0 ? distancePx / pixelsPerMm : null;
  };

  const toggleFullscreenMeasure = () => {
    if (fullscreenMeasureActive) {
      setFullscreenMeasureActive(false);
      setPendingMeasurePoint(null);
      pendingMeasurePointRef.current = null;
      return;
    }
    if (!getCalibrationForImage(fullscreenImageModal?.imageId)) {
      setFullscreenCalibrationPromptVisible(true);
      return;
    }
    setFullscreenCalibrationPromptVisible(false);
    setFullscreenMeasureActive(true);
  };

  const commitFullscreenMeasureLine = async (line) => {
    if (!line) return;
    if (!getCalibrationForImage(fullscreenImageModal?.imageId)) {
      setPendingMeasurePoint(null);
      pendingMeasurePointRef.current = null;
      setFullscreenMeasureActive(false);
      setFullscreenCalibrationPromptVisible(true);
      return;
    }
    const kind = classifyMeasurementLine(line);
    const name = nextMeasurementName(kind);
    const color = MEASUREMENT_COLORS[fullscreenMeasurements.length % MEASUREMENT_COLORS.length];
    const distancePx = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
    const distanceMm = getLineDistanceMm(line, fullscreenImageModal?.imageId);
    const created = await createMeasurementAnnotation({ imageId: fullscreenImageModal?.imageId, line, name, color, distanceMm });
    if (created && (!created.image_id || !created.geometry?.line)) {
      setFullscreenMeasurements((prev) => [...prev, { ...line, id: created.id, imageId: String(fullscreenImageModal?.imageId || ''), name, kind, color, distanceMm, distancePx }]);
    }
    setPendingMeasurePoint(null);
    pendingMeasurePointRef.current = null;
  };

  const handleFullscreenMeasurePointerDown = async (event) => {
    if (!fullscreenMeasureActive) return;
    if (!getCalibrationForImage(fullscreenImageModal?.imageId)) {
      setFullscreenMeasureActive(false);
      setFullscreenCalibrationPromptVisible(true);
      setPendingMeasurePoint(null);
      pendingMeasurePointRef.current = null;
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height || !event.currentTarget.naturalWidth || !event.currentTarget.naturalHeight) return;
    const x = ((event.clientX - rect.left) / rect.width) * event.currentTarget.naturalWidth;
    const y = ((event.clientY - rect.top) / rect.height) * event.currentTarget.naturalHeight;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const firstPoint = pendingMeasurePointRef.current || pendingMeasurePoint;
    if (!firstPoint) {
      const nextPoint = { x, y, imageWidth: event.currentTarget.naturalWidth, imageHeight: event.currentTarget.naturalHeight };
      pendingMeasurePointRef.current = nextPoint;
      setPendingMeasurePoint(nextPoint);
      return;
    }
    const line = { x1: firstPoint.x, y1: firstPoint.y, x2: x, y2: y, imageWidth: event.currentTarget.naturalWidth, imageHeight: event.currentTarget.naturalHeight };
    if (!isFiniteMeasurementLine(line)) return;
    await commitFullscreenMeasureLine(line);
  };

  const closeFullscreenImageModal = () => {
    setFullscreenImageModal(null);
    setFullscreenMeasureActive(false);
    setPendingMeasurePoint(null);
    pendingMeasurePointRef.current = null;
    setFullscreenCalibrationPromptVisible(false);
  };

  const renderFullscreenImageModal = () => {
    if (!fullscreenImageModal?.imageId) return null;
    const fullscreenImageId = String(fullscreenImageModal.imageId);
    const fullscreenImageRecord = projectImageLookup[fullscreenImageId] || {};
    const fullscreenMeasurementLines = [
      ...(measurementLinesByImageId[fullscreenImageId] || []),
      ...fullscreenMeasurements.filter((line) => String(line.imageId || '') === fullscreenImageId),
    ].filter(isFiniteMeasurementLine);
    return (
      <div className="modal inspection-fullscreen-modal" style={{ display: 'flex' }} onClick={closeFullscreenImageModal}>
        <div className="modal-content inspection-fullscreen-modal-content" onClick={(event) => event.stopPropagation()}>
          <div className="modal-header">
            <h3>{fullscreenImageModal.label}</h3>
            <div className="workbench-detail-actions">
              <button type="button" className={`btn btn-secondary ${fullscreenMeasureActive ? 'active' : ''}`} onClick={toggleFullscreenMeasure}>
                Measure
              </button>
              <button type="button" className="modal-close-btn" aria-label="Close fullscreen image" onClick={closeFullscreenImageModal}>&times;</button>
            </div>
          </div>
          {fullscreenCalibrationPromptVisible && (
            <div className="inspection-fullscreen-calibration-panel" role="dialog" aria-label="Measurement calibration required">
              <div className="workbench-notice">
                <strong>No Calibration Set</strong>
                <p>Set calibration before placing a measurement line.</p>
              </div>
              <CalibrationManager
                projectId={projectId}
                imageId={fullscreenImageId}
                image={fullscreenImageRecord}
                onCalibrationChange={handleFullscreenCalibrationChange}
              />
            </div>
          )}
          <div className="inspection-fullscreen-stage">
            {fullscreenMeasureActive && <div className="workbench-notice">Click to set first point, click again to set second point.</div>}
            <div className="inspection-fullscreen-image-frame">
              <img
                src={`/api/images/${encodeURIComponent(fullscreenImageModal.imageId)}/content`}
                alt={`${fullscreenImageModal.label} fullscreen`}
                className={`inspection-fullscreen-image ${fullscreenMeasureActive ? 'measurement-active' : ''}`}
                onClick={handleFullscreenMeasurePointerDown}
              />
              <svg className="inspection-fullscreen-measurement-overlay" viewBox={`0 0 1000 1000`} preserveAspectRatio="none" aria-label="fullscreen measurement overlay">
                {fullscreenMeasurementLines.map((line) => {
                  const labelPosition = getMeasurementLabelViewBoxPosition(line, 20);
                  return (
                    <g key={line.id}>
                      <line x1={(line.x1 / line.imageWidth) * 1000} y1={(line.y1 / line.imageHeight) * 1000} x2={(line.x2 / line.imageWidth) * 1000} y2={(line.y2 / line.imageHeight) * 1000} stroke={line.color} strokeWidth="3" />
                      <text x={labelPosition.x} y={labelPosition.y} fill={line.color} fontSize="20">{getMeasurementLineLabel(line)}</text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <section className="workbench-panel" aria-label="Inspection Workbench">
      {loading && <div className="loading-text">Loading inspection workbench…</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {!loading && !error && (
        <>
          {projectType !== 'PT3' && (
            <div className="workbench-stats">
              <span className="group-badge">Batches: {batches.length}</span>
              <span className="group-badge">Parts: {parts.length}</span>
              <span className="group-badge">Passed: {reviewSummary.pass}</span>
              <span className="group-badge">Rejected: {reviewSummary.reject_confirmed + reviewSummary.reject_pending}</span>
            </div>
          )}

          <div className="workbench-layout">
            {projectType === 'PT3' ? (
              renderPt3FocusedWorkbench()
            ) : (
            <div className="workbench-details" ref={workbenchDetailsRef}>
              {selectedPart ? (
                <>
                  <div className="workbench-detail-header">
                    <h3>{selectedPart.display_name || selectedPart.serial_number}</h3>
                    <div className="workbench-detail-actions">
                      <button
                        className="btn btn-secondary"
                        disabled={savingPartId === selectedPart.id}
                        onClick={() => updatePartReviewState(selectedPart, 'in_review')}
                      >
                        Set In Review
                      </button>
                      <button
                        className="btn btn-success"
                        disabled={savingPartId === selectedPart.id}
                        onClick={() => updatePartReviewState(selectedPart, 'pass')}
                      >
                        Mark Pass ✓
                      </button>
                      <button
                        className="btn btn-danger"
                        disabled={savingPartId === selectedPart.id}
                        onClick={() => updatePartReviewState(selectedPart, 'reject_pending')}
                      >
                        Flag Reject
                      </button>
                    </div>
                  </div>
                  <p className="muted" data-testid="inspector-hotkey-hints">
                    Hotkeys: pass ({inspectorHotkeys.accept_classification.toUpperCase()}), reject (
                    {inspectorHotkeys.reject_classification.toUpperCase()}), shortcuts help (
                    {inspectorHotkeys.toggle_shortcut_help.toUpperCase()}).
                  </p>
                  {shortcutHelpVisible && (
                    <div className="workbench-notice" data-testid="shortcut-help-panel">
                      <strong>Shortcut help</strong>
                      <ul>
                        <li>Mark Pass: {inspectorHotkeys.accept_classification.toUpperCase()}</li>
                        <li>Flag Reject: {inspectorHotkeys.reject_classification.toUpperCase()}</li>
                        <li>Toggle this help: {inspectorHotkeys.toggle_shortcut_help.toUpperCase()}</li>
                      </ul>
                    </div>
                  )}
                </>
              ) : (
                <div className="workbench-notice" data-testid="inspection-empty-state">
                  <strong>No part selected</strong>
                  <p className="muted">
                    {filteredParts.length === 0
                      ? 'No parts found for the current filters. The configured inspection workspace is ready for incoming parts.'
                      : 'Select a part from the summary panel to begin inspection.'}
                  </p>
                  {normalizationTriageField && (
                    <p className="muted" data-testid="normalization-triage-empty-guidance">
                      {normalizationTriageMatchCount > 0
                        ? `Triage matches exist for ${normalizationTriageField}, but they are hidden by the active filters.`
                        : `No parts in this project contain mixed ${normalizationTriageField} metadata values.`}
                    </p>
                  )}
                </div>
              )}

                  <div
                    className="workbench-flexlayout-shell"
                    style={workbenchFlexLayoutStyle}
                    data-testid="inspection-layout-grid"
                  >
                    <Layout
                      model={inspectionFlexLayoutModel}
                      factory={inspectionFlexLayoutFactory}
                      onModelChange={handleInspectionFlexLayoutChange}
                    />
                  </div>

            </div>
            )}
          </div>
        </>
      )}
      {renderFullscreenImageModal()}
    </section>
  );
}

export default InspectionWorkbenchPanel;
