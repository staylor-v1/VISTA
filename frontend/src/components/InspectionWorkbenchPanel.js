import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Actions, Layout, Model } from 'flexlayout-react';
import 'flexlayout-react/style/light.css';
import CalibrationManager from './CalibrationManager';
import Pt3GaussianSplatViewer, {
  DEFAULT_RAY_MARCH_SETTINGS,
  DEFAULT_SPLAT_VIEW_SETTINGS,
  normalizeRayMarchSettings,
} from './Pt3GaussianSplatViewer';
import { getMprAxisMirrorScale } from './pt3VolumeGeometry';
import {
  buildPt3SegmentMask,
  buildPt3SegmentVolumeRuns,
  buildPt3SegmentVolumeSliceMask,
  buildPt3VectorAnnotationFaces,
  forEachPt3VectorFaceVoxelPolygon,
  mapVectorPlanePointToVoxel,
  pt3SegmentMaskToSvgPath,
} from './pt3VectorAnnotations';
import {
  floodFillVolume3dAsync,
  rasterizeSphereStroke,
} from './pt3SegmentationVolume';
import { getMechanicalVolumeMetadata } from './pt3MechanicalVisualization';
import {
  annotationToVectorSegment,
  buildInspectionAnnotationItems,
  isVistaSegmentAnnotation,
  makeVistaSegmentAnnotationPayload,
} from './inspectionAnnotationAdapter';
import {
  clientPointToSource,
  getContainedImageTransform,
  moveBoxCorner,
  moveLineEndpoint,
  safeReleasePointerCapture,
  safeSetPointerCapture,
  translateBox,
  translateLine,
} from '../utils/annotationGeometry';
import { DEFAULT_INTERFACE_HIERARCHY } from '../utils/interfaceHierarchy';
import { isUiSectionEnabled } from '../utils/uiSections';
import { fetchProjectImagePages } from '../utils/projectImages';
import {
  scheduleMprServerSliceTask,
} from './mprServerSliceScheduler';

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
const MPR_FALLBACK_MODEL_SIZE = Object.freeze({ width: 190, height: 138, depth: 108 });
const MPR_FALLBACK_PERSPECTIVE_PX = 760;
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
  realSplat: 'real_splat',
  volume3d: 'volume3d',
};
const MPR_RECONSTRUCTION_LABELS = {
  [MPR_RECONSTRUCTION_MODES.orientation]: 'Orientation only',
  [MPR_RECONSTRUCTION_MODES.stack]: 'Stack reconstruction',
  [MPR_RECONSTRUCTION_MODES.realSplat]: 'Real 3DGS',
  [MPR_RECONSTRUCTION_MODES.volume3d]: 'Ray marching',
};
const RAY_MARCH_RECONSTRUCTION_OPTIONS = Object.freeze([
  { value: 'composite', label: 'Composite' },
  { value: 'mip', label: 'MIP' },
  { value: 'xray', label: 'X-ray' },
  { value: 'iso', label: 'Iso' },
  { value: 'window', label: 'Window' },
]);
const RAY_MARCH_RECONSTRUCTION_IDS = new Set(
  RAY_MARCH_RECONSTRUCTION_OPTIONS.map(({ value }) => value),
);
const RAY_MARCH_SELECTOR_PREFIX = 'ray-march:';
const PT3_RENDERER_RECONSTRUCTION_MODES = [
  MPR_RECONSTRUCTION_MODES.volume3d,
  MPR_RECONSTRUCTION_MODES.realSplat,
];

function normalizeMprReconstructionMode(value) {
  if (value === 'shell' || value === 'splat') return MPR_RECONSTRUCTION_MODES.orientation;
  if (value === 'hybrid3d') return MPR_RECONSTRUCTION_MODES.volume3d;
  return Object.values(MPR_RECONSTRUCTION_MODES).includes(value)
    ? value
    : MPR_RECONSTRUCTION_MODES.orientation;
}
const DEFAULT_MPR_PROJECTION_MIRROR = { axial: false, coronal: false, sagittal: false };
const MPR_VOLUME_CACHE_LIMIT = 4;
const MPR_SLICE_CANVAS_CACHE_MAX_BYTES = 192 * 1024 * 1024;
const MPR_SERVER_VOLUME_KIND = 'server-volume';
const MPR_VOLUME_SLICE_RENDER_VERSION = 'rgba-segments-v2';
const MPR_VOLUME_RENDER_SUMMARY_VERSION = 1;
const MPR_VOLUME_RENDERER_MAX_SLICES = 12;
const MPR_SERVER_SLICE_PREFETCH_RADIUS = 2;
const MPR_SERVER_CURRENT_SLICE_DEBOUNCE_MS = 200;
const DEFAULT_DISPLAY_VALUE_DOMAIN = { min: 0, max: 255, step: 1, label: '8-bit image' };
const mprVolumeCacheStore = new Map();
const mprSliceCanvasCacheStore = new Map();
let mprSliceCanvasCacheBytes = 0;
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
const DEFAULT_ANNOTATION_COLOR = '#f97316';
const DEFAULT_ANNOTATION_FILL_OPACITY = 0.5;
const DEFAULT_ANNOTATION_TRANSPARENCY_PERCENT = 0;
const DEFAULT_SEGMENT_COLOR = '#22c55e';
const SEGMENT_COLORS = ['#22c55e', '#3b82f6', '#f97316', '#e11d48', '#a855f7', '#14b8a6', '#facc15'];
const SEGMENTATION_HELPER_TOOLS = [
  {
    id: 'brush',
    label: 'Brush',
    icon: 'brush',
    detail: 'Paint a circle on one slice or a swept sphere through the volume.',
    modes: ['2d', '3d'],
    modeLabels: { '2d': 'Circle', '3d': 'Sphere' },
  },
  {
    id: 'eraser',
    label: 'Eraser',
    icon: 'eraser',
    detail: 'Erase with a circle on one slice or a swept sphere through the volume.',
    modes: ['2d', '3d'],
    modeLabels: { '2d': 'Circle', '3d': 'Sphere' },
  },
  {
    id: 'connected',
    label: 'Connected',
    icon: 'target',
    detail: 'Grow from a seed through similar pixels on one slice or all three dimensions.',
    modes: ['2d', '3d'],
    modeLabels: { '2d': 'Slice', '3d': 'Volume' },
  },
  { id: 'polygon', label: 'Polygon', icon: 'polygon', detail: 'Click boundary vertices, double-click to close the perimeter.' },
  { id: 'circle', label: 'Circle', icon: 'circle', detail: 'Click the center, then drag to set the radius.' },
  { id: 'rectangle', label: 'Rectangle', icon: 'rectangle', detail: 'Drag from one corner to the opposite corner.' },
  { id: 'threshold', label: 'Threshold', icon: 'threshold', detail: 'Preview a local intensity band around a clicked point.' },
  { id: 'level-trace', label: 'Level Trace', icon: 'contour', detail: 'Trace an equal-intensity contour from the clicked point.' },
  { id: 'scissors', label: 'Scissors', icon: 'scissors', detail: 'Mark cut paths for trimming a selected segment.' },
  { id: 'ml-helper', label: 'ML Helper', icon: 'spark', detail: 'Run a toolbox segmentation method once per slice, then select regions by click.' },
];
const SEGMENTATION_HELPER_VIEWS = [
  { id: 'x', label: 'X', axis: 'sagittal', plane: 'YZ', detail: 'X axis · YZ plane' },
  { id: 'y', label: 'Y', axis: 'coronal', plane: 'XZ', detail: 'Y axis · XZ plane' },
  { id: 'z', label: 'Z', axis: 'axial', plane: 'XY', detail: 'Z axis · XY plane' },
  { id: 'mpr', label: 'MPR', detail: 'Linked orthogonal views' },
  { id: '3d', label: '3D', detail: '3D volume context and exact segment surface' },
];
const SEGMENTATION_VIEW_BY_AXIS = {
  sagittal: 'x',
  coronal: 'y',
  axial: 'z',
};
const DEFAULT_SEGMENTATION_TOOL_MODES = {
  brush: '2d',
  eraser: '2d',
  connected: '2d',
};
const SEGMENTATION_POINT_MARKER_TOOLS = new Set(['polygon', 'circle', 'rectangle']);
const SEGMENTATION_ML_METHOD_GROUPS = [
  {
    id: 'yolo',
    label: 'YOLO',
    methods: [
      { id: 'segmentation.yolo.placeholder', label: 'YOLO (placeholder)' },
    ],
  },
  {
    id: 'anomalib',
    label: 'Anomalib',
    methods: [
      { id: 'segmentation.anomalib.placeholder', label: 'Anomalib (placeholder)' },
    ],
  },
  {
    id: 'sam',
    label: 'SAM',
    methods: [
      { id: 'segmentation.sam.placeholder', label: 'SAM (placeholder)' },
    ],
  },
  {
    id: 'opencv',
    label: 'OpenCV',
    methods: [
      { id: 'segmentation.opencv.placeholder', label: 'OpenCV (placeholder)' },
    ],
  },
];
const DEFAULT_SEGMENTATION_ML_PARAMETERS = {
  'segmentation.yolo.placeholder': { integration_mode: 'placeholder', function_path: '', fastapi_url: '', mode: 'default', prompts: {}, options: {} },
  'segmentation.anomalib.placeholder': { integration_mode: 'placeholder', function_path: '', fastapi_url: '', mode: 'default', prompts: {}, options: {} },
  'segmentation.sam.placeholder': { integration_mode: 'placeholder', function_path: '', fastapi_url: '', mode: 'default', prompts: {}, options: {} },
  'segmentation.opencv.placeholder': { integration_mode: 'placeholder', function_path: '', fastapi_url: '', mode: 'default', prompts: {}, options: {} },
};

function SegmentationToolIcon({ icon }) {
  const commonProps = {
    className: 'segmentation-tool-icon',
    viewBox: '0 0 24 24',
    'aria-hidden': 'true',
    focusable: 'false',
  };
  if (icon === 'brush') {
    return (
      <svg {...commonProps}>
        <path d="M15.5 3.5l5 5-8.4 8.4-5-5 8.4-8.4z" />
        <path d="M7.1 11.9c-2.1 1-3.2 2.7-3.2 5.2 1.8-.1 3.5-.5 5.1-1.3" />
      </svg>
    );
  }
  if (icon === 'eraser') {
    return (
      <svg {...commonProps}>
        <path d="M4 15l8.6-8.6a2 2 0 0 1 2.8 0l4.2 4.2a2 2 0 0 1 0 2.8L13 20H8.8L4 15z" />
        <path d="M9.5 9.5l5 5" />
        <path d="M13 20h7" />
      </svg>
    );
  }
  if (icon === 'target') {
    return (
      <svg {...commonProps}>
        <circle cx="12" cy="12" r="7" />
        <circle cx="12" cy="12" r="2.4" />
        <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
      </svg>
    );
  }
  if (icon === 'polygon') {
    return (
      <svg {...commonProps}>
        <path d="M6 6l10-2 4 9-7 7-9-5 2-9z" />
        <circle cx="6" cy="6" r="1.4" />
        <circle cx="16" cy="4" r="1.4" />
        <circle cx="20" cy="13" r="1.4" />
        <circle cx="13" cy="20" r="1.4" />
      </svg>
    );
  }
  if (icon === 'circle') {
    return (
      <svg {...commonProps}>
        <circle cx="12" cy="12" r="7.5" />
        <circle cx="12" cy="12" r="1.4" />
        <path d="M12 12l5.3-5.3" />
      </svg>
    );
  }
  if (icon === 'rectangle') {
    return (
      <svg {...commonProps}>
        <rect x="5" y="6" width="14" height="12" rx="1" />
        <circle cx="5" cy="6" r="1.3" />
        <circle cx="19" cy="18" r="1.3" />
      </svg>
    );
  }
  if (icon === 'threshold') {
    return (
      <svg {...commonProps}>
        <path d="M5 18V6" />
        <path d="M19 18V6" />
        <path d="M5 15c3-5 6-5 9 0 1.4 2.3 3 2.7 5 0" />
        <path d="M8 9h8" />
      </svg>
    );
  }
  if (icon === 'contour') {
    return (
      <svg {...commonProps}>
        <path d="M4.5 13.5c1.5-6.2 8.4-8.8 13-4.6 3.7 3.4 1 9.7-4.5 9.6-4.2 0-5.4-4.2-2.8-6.1 2-1.5 4.5-.2 4.8 2.1" />
      </svg>
    );
  }
  if (icon === 'scissors') {
    return (
      <svg {...commonProps}>
        <circle cx="6.5" cy="6.5" r="2.3" />
        <circle cx="6.5" cy="17.5" r="2.3" />
        <path d="M8.4 8.4L20 20" />
        <path d="M8.4 15.6L20 4" />
      </svg>
    );
  }
  return (
    <svg {...commonProps}>
      <path d="M12 3l1.7 5.1L19 10l-5.3 1.9L12 17l-1.7-5.1L5 10l5.3-1.9L12 3z" />
      <path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15z" />
    </svg>
  );
}
const SEGMENTATION_ML_PARAMETER_FIELDS = {
  'segmentation.yolo.placeholder': [
    { name: 'integration_mode', label: 'Integration', type: 'select', options: ['placeholder', 'local_import', 'fastapi'] },
    { name: 'function_path', label: 'Function path', type: 'text' },
    { name: 'fastapi_url', label: 'FastAPI URL', type: 'text' },
    { name: 'mode', label: 'Mode', type: 'text' },
  ],
  'segmentation.anomalib.placeholder': [
    { name: 'integration_mode', label: 'Integration', type: 'select', options: ['placeholder', 'local_import', 'fastapi'] },
    { name: 'function_path', label: 'Function path', type: 'text' },
    { name: 'fastapi_url', label: 'FastAPI URL', type: 'text' },
    { name: 'mode', label: 'Mode', type: 'text' },
  ],
  'segmentation.sam.placeholder': [
    { name: 'integration_mode', label: 'Integration', type: 'select', options: ['placeholder', 'local_import', 'fastapi'] },
    { name: 'function_path', label: 'Function path', type: 'text' },
    { name: 'fastapi_url', label: 'FastAPI URL', type: 'text' },
    { name: 'mode', label: 'Mode', type: 'text' },
  ],
  'segmentation.opencv.placeholder': [
    { name: 'integration_mode', label: 'Integration', type: 'select', options: ['placeholder', 'local_import', 'fastapi'] },
    { name: 'function_path', label: 'Function path', type: 'text' },
    { name: 'fastapi_url', label: 'FastAPI URL', type: 'text' },
    { name: 'mode', label: 'Mode', type: 'text' },
  ],
};
const FULLSCREEN_IMAGE_ZOOM_MIN = 1;
const FULLSCREEN_IMAGE_ZOOM_MAX = 8;
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
  pass: 'Pass',
  reject_pending: 'Reject',
  reject_confirmed: 'Reject',
};
const NSIPRO_METADATA_PATTERN = /nsi[\s_-]*pro|\.nsipro/i;

function isPlainMetadataObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNsiproMetadataKey(key) {
  return NSIPRO_METADATA_PATTERN.test(String(key || ''));
}

function isNsiproMetadataString(value) {
  return typeof value === 'string' && NSIPRO_METADATA_PATTERN.test(value);
}

function formatMetadataPath(parentPath, key) {
  if (typeof key === 'number') return `${parentPath}[${key}]`;
  return parentPath ? `${parentPath}.${key}` : String(key);
}


function collectMetadataLeafEntries(value, path = 'metadata') {
  if (Array.isArray(value)) {
    if (!value.length) return [{ path, value }];
    return value.flatMap((entry, index) => collectMetadataLeafEntries(entry, formatMetadataPath(path, index)));
  }
  if (isPlainMetadataObject(value)) {
    const entries = Object.entries(value);
    if (!entries.length) return [{ path, value }];
    return entries.flatMap(([key, entryValue]) => collectMetadataLeafEntries(entryValue, formatMetadataPath(path, key)));
  }
  return [{ path, value }];
}

function collectNsiproMetadataEntries(value, path = 'metadata', inNsiproContext = false) {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectNsiproMetadataEntries(
      entry,
      formatMetadataPath(path, index),
      inNsiproContext
    ));
  }
  if (isPlainMetadataObject(value)) {
    return Object.entries(value).flatMap(([key, entryValue]) => {
      const nextPath = formatMetadataPath(path, key);
      const keyStartsNsiproContext = isNsiproMetadataKey(key);
      const valueIsNsiproReference = isNsiproMetadataString(entryValue);
      const shouldFlattenNsiproObject = keyStartsNsiproContext && (
        isPlainMetadataObject(entryValue) || Array.isArray(entryValue)
      );

      if (shouldFlattenNsiproObject) {
        return collectNsiproMetadataEntries(entryValue, nextPath, true);
      }

      return collectNsiproMetadataEntries(
        entryValue,
        nextPath,
        inNsiproContext || keyStartsNsiproContext || valueIsNsiproReference
      );
    });
  }
  if (inNsiproContext || isNsiproMetadataString(value)) {
    return [{ path, value }];
  }
  return [];
}

function omitNsiproMetadata(value, key = '') {
  if (isNsiproMetadataKey(key) || isNsiproMetadataString(value)) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((entry) => omitNsiproMetadata(entry))
      .filter((entry) => entry !== undefined);
  }
  if (isPlainMetadataObject(value)) {
    return Object.entries(value).reduce((acc, [entryKey, entryValue]) => {
      const nextValue = omitNsiproMetadata(entryValue, entryKey);
      if (nextValue !== undefined) acc[entryKey] = nextValue;
      return acc;
    }, {});
  }
  return value;
}

function getPartMetadataBreakout(part) {
  const metadata = isPlainMetadataObject(part?.metadata) ? part.metadata : {};
  return {
    nsiproEntries: collectNsiproMetadataEntries(metadata),
    otherMetadata: omitNsiproMetadata(metadata) || {},
  };
}

function formatMetadataValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    return String(value);
  }
}
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
    const key = String(imageId);
    const lineIndex = (acc[key] || []).length;
    const color = getAnnotationColor(annotation, MEASUREMENT_COLORS[lineIndex % MEASUREMENT_COLORS.length]);
    const entry = {
      id: String(annotation.id || `${imageId}-${x1}-${y1}`),
      imageId: key,
      name: annotation?.comment || `Measurement ${lineIndex + 1}`,
      kind: annotation?.defect_class || 'Measurement',
      x1,
      y1,
      x2,
      y2,
      imageWidth,
      imageHeight,
      color,
      axis: line.axis || annotation?.geometry?.axis || '',
      sliceIndex: Number.isFinite(Number(line.slice_index ?? line.sliceIndex ?? annotation?.geometry?.slice_index ?? annotation?.geometry?.sliceIndex))
        ? Number(line.slice_index ?? line.sliceIndex ?? annotation?.geometry?.slice_index ?? annotation?.geometry?.sliceIndex)
        : null,
      distanceMm: Number.isFinite(lengthMm) ? lengthMm : null,
      distancePx,
    };
    acc[key] = [...(acc[key] || []), entry];
    return acc;
  }, {});
}

function getBoxAnnotationsByImageId(annotations) {
  if (!Array.isArray(annotations)) return {};
  return annotations.reduce((acc, annotation) => {
    const imageId = annotation?.image_id;
    const bbox = annotation?.bbox;
    if (!imageId || !bbox) return acc;
    const x = Number(bbox.x);
    const y = Number(bbox.y);
    const width = Number(bbox.width);
    const height = Number(bbox.height);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return acc;
    const imageWidth = Number(annotation?.geometry?.imageWidth || annotation?.geometry?.box?.imageWidth || bbox.imageWidth);
    const imageHeight = Number(annotation?.geometry?.imageHeight || annotation?.geometry?.box?.imageHeight || bbox.imageHeight);
    if (![imageWidth, imageHeight].every(Number.isFinite) || imageWidth <= 0 || imageHeight <= 0) return acc;
	    const key = String(imageId);
	    const boxIndex = (acc[key] || []).length;
	    const color = getAnnotationColor(annotation, MEASUREMENT_COLORS[boxIndex % MEASUREMENT_COLORS.length]);
	    const widthMm = Number(annotation?.measurements?.width_mm);
	    const heightMm = Number(annotation?.measurements?.height_mm);
	    const entry = {
	      id: String(annotation.id || `${imageId}-${x}-${y}`),
	      imageId: key,
      name: annotation?.comment || annotation?.defect_class || `Box ${boxIndex + 1}`,
      x,
      y,
      width,
      height,
	      imageWidth,
	      imageHeight,
	      color,
	      fillOpacity: getAnnotationFillOpacity(annotation),
	      axis: annotation?.geometry?.box?.axis || annotation?.geometry?.axis || '',
	      sliceIndex: Number.isFinite(Number(annotation?.geometry?.box?.slice_index ?? annotation?.geometry?.box?.sliceIndex ?? annotation?.geometry?.slice_index ?? annotation?.geometry?.sliceIndex))
	        ? Number(annotation?.geometry?.box?.slice_index ?? annotation?.geometry?.box?.sliceIndex ?? annotation?.geometry?.slice_index ?? annotation?.geometry?.sliceIndex)
	        : null,
	      widthMm: Number.isFinite(widthMm) ? widthMm : null,
	      heightMm: Number.isFinite(heightMm) ? heightMm : null,
	    };
    acc[key] = [...(acc[key] || []), entry];
    return acc;
  }, {});
}

function getAnnotationColor(annotation, fallback = DEFAULT_ANNOTATION_COLOR) {
  const color = String(
    annotation?.metadata?.annotation_color
    || annotation?.metadata?.measurement_color
    || annotation?.color
    || fallback
  ).trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function getAnnotationFillOpacity(annotation, fallback = DEFAULT_ANNOTATION_FILL_OPACITY) {
  const value = Number(annotation?.metadata?.annotation_fill_opacity ?? annotation?.fillOpacity ?? annotation?.fill_opacity);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function normalizeAnnotationTransparencyPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_ANNOTATION_TRANSPARENCY_PERCENT;
  return Math.round(Math.min(100, Math.max(0, numeric)));
}

function getAnnotationOpacityMultiplier(transparencyPercent) {
  return 1 - (normalizeAnnotationTransparencyPercent(transparencyPercent) / 100);
}

function getMprSliceKey(axis, sliceIndex) {
  return `${axis}:${Number(sliceIndex) || 0}`;
}

function getMprMeasurementLinesBySlice(annotations) {
  if (!Array.isArray(annotations)) return {};
  return annotations.reduce((acc, annotation) => {
    const line = annotation?.geometry?.line;
    const axis = String(line?.axis || annotation?.geometry?.axis || '').trim();
    const sliceIndex = Number(line?.slice_index ?? line?.sliceIndex ?? annotation?.geometry?.slice_index ?? annotation?.geometry?.sliceIndex);
    if (!axis || !Number.isFinite(sliceIndex)) return acc;
    const parsed = getMeasurementLinesByImageId([{ ...annotation, image_id: annotation?.image_id || getMprSliceKey(axis, sliceIndex) }]);
    const entry = Object.values(parsed)[0]?.[0];
    if (!entry) return acc;
    const key = getMprSliceKey(axis, sliceIndex);
    acc[key] = [...(acc[key] || []), { ...entry, axis, sliceIndex }];
    return acc;
  }, {});
}

function getMprBoxAnnotationsBySlice(annotations) {
  if (!Array.isArray(annotations)) return {};
  return annotations.reduce((acc, annotation) => {
    const box = annotation?.geometry?.box;
    const axis = String(box?.axis || annotation?.geometry?.axis || '').trim();
    const sliceIndex = Number(box?.slice_index ?? box?.sliceIndex ?? annotation?.geometry?.slice_index ?? annotation?.geometry?.sliceIndex);
    if (!axis || !Number.isFinite(sliceIndex)) return acc;
    const bbox = annotation?.bbox || box;
    const imageWidth = Number(annotation?.geometry?.imageWidth || box?.imageWidth || bbox?.imageWidth);
    const imageHeight = Number(annotation?.geometry?.imageHeight || box?.imageHeight || bbox?.imageHeight);
    const x = Number(bbox?.x);
    const y = Number(bbox?.y);
    const width = Number(bbox?.width);
    const height = Number(bbox?.height);
    if (![x, y, width, height, imageWidth, imageHeight].every(Number.isFinite) || width <= 0 || height <= 0) return acc;
    const key = getMprSliceKey(axis, sliceIndex);
    const boxIndex = (acc[key] || []).length;
    acc[key] = [...(acc[key] || []), {
      id: String(annotation.id || `${key}-${x}-${y}`),
      imageId: key,
      name: annotation?.comment || annotation?.defect_class || `Box ${boxIndex + 1}`,
      x,
      y,
      width,
      height,
      imageWidth,
      imageHeight,
      color: getAnnotationColor(annotation, MEASUREMENT_COLORS[boxIndex % MEASUREMENT_COLORS.length]),
      fillOpacity: getAnnotationFillOpacity(annotation),
      axis,
      sliceIndex,
    }];
    return acc;
  }, {});
}

function getMprCubeAnnotations(annotations) {
  if (!Array.isArray(annotations)) return [];
  return annotations.map((annotation) => {
    const cube = annotation?.geometry?.cube;
    if (!cube || typeof cube !== 'object') return null;
    const axis = String(cube.axis || '').trim();
    const startSlice = Number(cube.startSlice ?? cube.start_slice);
    const endSlice = Number(cube.endSlice ?? cube.end_slice);
    const x = Number(cube.x);
    const y = Number(cube.y);
    const width = Number(cube.width);
    const height = Number(cube.height);
    const imageWidth = Number(cube.imageWidth || cube.image_width);
    const imageHeight = Number(cube.imageHeight || cube.image_height);
    if (!axis || ![startSlice, endSlice, x, y, width, height, imageWidth, imageHeight].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    return {
      id: String(annotation.id || `${axis}-${startSlice}-${endSlice}-${x}-${y}`),
      axis,
      startSlice: Math.min(startSlice, endSlice),
      endSlice: Math.max(startSlice, endSlice),
      x,
      y,
      width,
      height,
      imageWidth,
      imageHeight,
      color: getAnnotationColor(annotation),
      fillOpacity: getAnnotationFillOpacity(annotation),
      name: annotation?.comment || annotation?.defect_class || 'Cube',
    };
  }).filter(Boolean);
}

function getMprCubeBoxesForSlice(cubes, axis, sliceIndex) {
  return (Array.isArray(cubes) ? cubes : [])
    .filter((cube) => cube.axis === axis && Number(sliceIndex) >= cube.startSlice && Number(sliceIndex) <= cube.endSlice)
    .map((cube) => ({
      ...cube,
      id: `${cube.id}-${axis}-${sliceIndex}`,
      imageId: getMprSliceKey(axis, sliceIndex),
    }));
}

function makeMprCubeVertices(axis, firstBox, secondBox) {
  const lowerSlice = Math.min(Number(firstBox.sliceIndex), Number(secondBox.sliceIndex));
  const upperSlice = Math.max(Number(firstBox.sliceIndex), Number(secondBox.sliceIndex));
  const x = Math.min(Number(firstBox.x), Number(secondBox.x));
  const y = Math.min(Number(firstBox.y), Number(secondBox.y));
  const width = Math.max(Number(firstBox.x) + Number(firstBox.width), Number(secondBox.x) + Number(secondBox.width)) - x;
  const height = Math.max(Number(firstBox.y) + Number(firstBox.height), Number(secondBox.y) + Number(secondBox.height)) - y;
  const planeCorners = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
  const toVolumeVertex = (point, slice) => {
    if (axis === 'coronal') return { x: Number(point.x.toFixed(2)), y: slice, z: Number(point.y.toFixed(2)) };
    if (axis === 'sagittal') return { x: slice, y: Number(point.x.toFixed(2)), z: Number(point.y.toFixed(2)) };
    return { x: Number(point.x.toFixed(2)), y: Number(point.y.toFixed(2)), z: slice };
  };
  return [
    ...planeCorners.map((point) => toVolumeVertex(point, lowerSlice)),
    ...planeCorners.map((point) => toVolumeVertex(point, upperSlice)),
  ];
}

function isFiniteMeasurementLine(line) {
  if (!line || typeof line !== 'object') return false;
  const values = [line.x1, line.y1, line.x2, line.y2, line.imageWidth, line.imageHeight];
  return values.every((value) => Number.isFinite(Number(value)));
}

function isFiniteAnnotationBox(box) {
  if (!box || typeof box !== 'object') return false;
  const values = [box.x, box.y, box.width, box.height, box.imageWidth, box.imageHeight];
  return values.every((value) => Number.isFinite(Number(value))) && Number(box.width) > 0 && Number(box.height) > 0;
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

function getAnnotationBoxWidthLabel(box) {
  if (Number.isFinite(Number(box?.widthMm))) {
    return `Width ${Number(box.widthMm).toFixed(2)} mm`;
  }
  return `Width ${Number(box.width).toFixed(1)} px`;
}

function getAnnotationBoxHeightLabel(box) {
  if (Number.isFinite(Number(box?.heightMm))) {
    return `Height ${Number(box.heightMm).toFixed(2)} mm`;
  }
  return `Height ${Number(box.height).toFixed(1)} px`;
}

function getAnnotationListType(annotation) {
  const defectClass = String(annotation?.defect_class || '').trim();
  if (defectClass) return defectClass;
  if (annotation?.geometry?.line) return 'Measurement';
  if (annotation?.geometry?.box || annotation?.bbox) return 'Bounding Box';
  return 'Annotation';
}

function getAnnotationListValue(annotation) {
  const measurements = annotation?.measurements && typeof annotation.measurements === 'object'
    ? annotation.measurements
    : {};
  const lengthMm = Number(measurements.length_mm);
  if (Number.isFinite(lengthMm)) return `${lengthMm.toFixed(2)} mm`;
  const lengthPx = Number(measurements.length_px);
  if (Number.isFinite(lengthPx)) return `${lengthPx.toFixed(1)} px`;

  const widthMm = Number(measurements.width_mm);
  const heightMm = Number(measurements.height_mm);
  if (Number.isFinite(widthMm) && Number.isFinite(heightMm) && widthMm > 0 && heightMm > 0) {
    return `${widthMm.toFixed(2)} x ${heightMm.toFixed(2)} mm`;
  }
  const measurementWidthPx = Number(measurements.width_px);
  const measurementHeightPx = Number(measurements.height_px);
  if (
    Number.isFinite(measurementWidthPx)
    && Number.isFinite(measurementHeightPx)
    && measurementWidthPx > 0
    && measurementHeightPx > 0
  ) {
    return `${measurementWidthPx.toFixed(1)} x ${measurementHeightPx.toFixed(1)} px`;
  }

  const comment = String(annotation?.comment || '').trim();
  if (comment) return comment;

  const widthPx = Number(annotation?.bbox?.width);
  const heightPx = Number(annotation?.bbox?.height);
  if (Number.isFinite(widthPx) && Number.isFinite(heightPx) && widthPx > 0 && heightPx > 0) {
    return `${widthPx.toFixed(1)} x ${heightPx.toFixed(1)} px`;
  }

  const firstMeasurement = Object.entries(measurements).find(([, value]) => (
    typeof value === 'string' || Number.isFinite(Number(value))
  ));
  if (firstMeasurement) {
    const [label, value] = firstMeasurement;
    return `${label}: ${value}`;
  }
  return '-';
}


function isBoundingBoxAnnotation(annotation) {
  const bbox = annotation?.bbox || annotation?.geometry?.box || annotation;
  if (!bbox || typeof bbox !== 'object') return false;
  return ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(Number(bbox[key])))
    && Number(bbox.width) > 0
    && Number(bbox.height) > 0;
}

function getAnnotationCropBox(annotation) {
  const bbox = annotation?.bbox || annotation?.geometry?.box || annotation || {};
  const geometry = annotation?.geometry || {};
  const x = Number(bbox.x);
  const y = Number(bbox.y);
  const width = Number(bbox.width);
  const height = Number(bbox.height);
  const imageWidth = Number(geometry.imageWidth || bbox.imageWidth || geometry.box?.imageWidth || annotation?.imageWidth);
  const imageHeight = Number(geometry.imageHeight || bbox.imageHeight || geometry.box?.imageHeight || annotation?.imageHeight);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return {
    x,
    y,
    width,
    height,
    imageWidth: Number.isFinite(imageWidth) && imageWidth > 0 ? imageWidth : null,
    imageHeight: Number.isFinite(imageHeight) && imageHeight > 0 ? imageHeight : null,
  };
}

function formatCropCoordinate(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  return String(Math.round(numeric * 100) / 100).replace(/\.0+$/, '');
}

function sanitizeCropFilename(value) {
  return String(value || 'image')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'image';
}

function getCropImageTitle(_annotation, parentImageName) {
  return `Child of ${parentImageName || 'image'}`;
}

function getCropUploadFilename(annotation, parentImageName) {
  const box = getAnnotationCropBox(annotation);
  const title = `${formatCropCoordinate(box?.x)}_${formatCropCoordinate(box?.y)}_child of ${parentImageName || 'image'}`;
  return `${sanitizeCropFilename(title)}.png`;
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load source image for crop'));
    image.src = src;
  });
}

function canvasToBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('Failed to create cropped image'));
      }
    }, type);
  });
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

function getMeasurementEndpointViewBoxPosition(line) {
  return {
    start: {
      x: (Number(line.x1) / Number(line.imageWidth)) * 1000,
      y: (Number(line.y1) / Number(line.imageHeight)) * 1000,
    },
    end: {
      x: (Number(line.x2) / Number(line.imageWidth)) * 1000,
      y: (Number(line.y2) / Number(line.imageHeight)) * 1000,
    },
  };
}

function getAnnotationBoxCornerPoints(box) {
  const x = Number(box?.x);
  const y = Number(box?.y);
  const width = Number(box?.width);
  const height = Number(box?.height);
  return {
    topLeft: { x, y },
    topRight: { x: x + width, y },
    bottomLeft: { x, y: y + height },
    bottomRight: { x: x + width, y: y + height },
  };
}

function getAnnotationBoxCornerViewBoxPosition(box) {
  const imageWidth = Number(box?.imageWidth);
  const imageHeight = Number(box?.imageHeight);
  return Object.entries(getAnnotationBoxCornerPoints(box)).reduce((acc, [corner, point]) => {
    acc[corner] = {
      x: (point.x / imageWidth) * 1000,
      y: (point.y / imageHeight) * 1000,
    };
    return acc;
  }, {});
}

function getAnnotationBoxOppositeCornerName(corner) {
  return {
    topLeft: 'bottomRight',
    topRight: 'bottomLeft',
    bottomLeft: 'topRight',
    bottomRight: 'topLeft',
  }[corner];
}

function getMeasurementLineWithDerivedLength(line, imageId, calibration) {
  if (!isFiniteMeasurementLine(line)) return null;
  const distancePx = Math.hypot(Number(line.x2) - Number(line.x1), Number(line.y2) - Number(line.y1));
  const pixelsPerMm = Number(calibration?.pixels_per_mm || 0);
  return {
    ...line,
    imageId: String(imageId || line.imageId || ''),
    distancePx,
    distanceMm: pixelsPerMm > 0 ? distancePx / pixelsPerMm : null,
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

function getPartSummaryModalities(part, imageRefs = getPartImageRefs(part)) {
  const loadedModalities = new Set();
  imageRefs.forEach((entry) => {
    const modality = String(entry?.modality || '').trim().toLowerCase();
    if (!modality || modality === 'analyze-overlay' || modality === 'overlay') return;
    loadedModalities.add(modality);
  });
  const configuredModalities = getModalities(part);
  if (loadedModalities.size === 0) {
    return imageRefs.length > 0 && configuredModalities.length === 1
      ? [configuredModalities[0]]
      : [];
  }
  const orderedConfiguredModalities = configuredModalities.filter((modality) =>
    loadedModalities.has(String(modality || '').trim().toLowerCase()),
  );
  const orderedLoadedModalities = Array.from(loadedModalities).filter((modality) =>
    !orderedConfiguredModalities.some((configured) => String(configured || '').trim().toLowerCase() === modality),
  );
  return [...orderedConfiguredModalities, ...orderedLoadedModalities];
}

function getVolumeShapeFromEntry(entry, projectImageLookup = {}) {
  const isValidShape = (candidate) => MPR_AXES.every((axis) => {
    const value = Number(candidate?.[axis]);
    return Number.isFinite(value) && value > 0 && Math.floor(value) === value;
  });
  const direct = entry?.volume_shape || entry?.metadata?.volume_shape;
  if (isValidShape(direct)) return direct;
  const record = getProjectImageRecord(projectImageLookup, entry);
  const authoritative = record?.volume_shape || record?.metadata?.volume_shape;
  return isValidShape(authoritative) ? authoritative : null;
}

function isVolumeFileEntry(entry, projectImageLookup = {}) {
  const record = getProjectImageRecord(projectImageLookup, entry) || {};
  const filename = String(entry?.filename || record.filename || '').toLowerCase();
  const hasExplicitSliceIndex = [
    entry?.slice_index,
    entry?.metadata?.slice_index,
    record?.slice_index,
    record?.metadata?.slice_index,
  ].some((value) => value !== undefined && value !== null && Number.isFinite(Number(value)));
  const isTiffVolumeCandidate = (filename.endsWith('.tif') || filename.endsWith('.tiff'))
    && !hasExplicitSliceIndex;
  return Boolean(
    entry?.load_mode === 'volume'
      || entry?.metadata?.load_mode === 'volume'
      || entry?.tiff_dimensionality === '3d'
      || entry?.metadata?.tiff_dimensionality === '3d'
      || filename.endsWith('.npy')
      || filename.endsWith('.npz')
      || filename.endsWith('.inspiro')
      || isTiffVolumeCandidate,
  );
}

function getMprDimensions(part, projectImageLookup = {}) {
  const volumeSourceShape = (Array.isArray(part?.metadata?.source_images) ? part.metadata.source_images : [])
    .filter((entry) => entry && !entry.overlay)
    .map((entry) => getVolumeShapeFromEntry(entry, projectImageLookup))
    .find(Boolean);
  const raw = part?.metadata?.volume_shape || part?.metadata?.mpr?.volume_shape || volumeSourceShape || {};
  const dimensions = MPR_AXES.reduce((acc, axis) => {
    const value = Number(raw?.[axis]);
    acc[axis] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 128;
    return acc;
  }, {});
  return dimensions;
}

function getProjectImageRecord(projectImageLookup = {}, entry = {}) {
  const imageId = entry?.image_id ? String(entry.image_id) : '';
  const filename = String(entry?.filename || '');
  return (imageId && projectImageLookup[imageId]) || (filename && projectImageLookup[filename]) || null;
}

function getVolumeEntryImageId(entry, projectImageLookup = {}) {
  const imageId = entry?.image_id ? String(entry.image_id) : '';
  if (imageId) return imageId;
  return getProjectImageRecord(projectImageLookup, entry)?.id || '';
}

function normalizeServerVolumeDimensions(candidate = {}) {
  return MPR_AXES.reduce((acc, axis) => {
    const value = Number(candidate?.[axis]);
    acc[axis] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
    return acc;
  }, {});
}

function getServerVolumeColorLayout(entry, projectImageLookup = {}) {
  const record = getProjectImageRecord(projectImageLookup, entry) || {};
  const candidates = [entry, entry?.metadata, record, record?.metadata];
  for (const candidate of candidates) {
    const channelCount = Number(candidate?.channel_count);
    const colorMode = String(candidate?.color_mode || '').toLowerCase();
    if (channelCount === 1 && colorMode === 'scalar') return { channelCount: 1, colorMode: 'scalar' };
    if (channelCount === 3 && colorMode === 'rgb') return { channelCount: 3, colorMode: 'rgb' };
    if (channelCount === 4 && colorMode === 'rgba') return { channelCount: 4, colorMode: 'rgba' };
  }
  return null;
}

function getVolumeColorLayout(entry, projectImageLookup = {}) {
  const layout = getServerVolumeColorLayout(entry, projectImageLookup);
  if (layout) return layout;
  return { channelCount: 1, colorMode: 'scalar' };
}

function getVolumeMetadataProbeCandidates(part, projectImageLookup = {}) {
  const sourceImages = Array.isArray(part?.metadata?.source_images) ? part.metadata.source_images : [];
  return sourceImages
    .filter((entry) => entry && isVolumeFileEntry(entry, projectImageLookup))
    .filter((entry) => (
      !getVolumeShapeFromEntry(entry, projectImageLookup)
      || !getServerVolumeColorLayout(entry, projectImageLookup)
    ))
    .map((entry) => ({
      entry,
      imageId: String(getVolumeEntryImageId(entry, projectImageLookup) || ''),
      filename: String(entry?.filename || getProjectImageRecord(projectImageLookup, entry)?.filename || ''),
    }));
}

function normalizeProbedVolumeMetadata(payload) {
  const dimensions = getVolumeShapeFromEntry({ volume_shape: payload?.dimensions });
  const layout = getServerVolumeColorLayout({
    channel_count: payload?.channel_count,
    color_mode: payload?.color_mode,
  });
  if (!dimensions || !layout) {
    throw new Error('Volume metadata response did not include valid dimensions and color layout');
  }
  const metadata = {
    volume_shape: dimensions,
    channel_count: layout.channelCount,
    color_mode: layout.colorMode,
  };
  [
    'pixel_dtype',
    'voxel_dtype',
    'bit_depth',
    'metadata_bit_depth',
    'source_kind',
    'interpretation',
    'image_count',
    'height',
    'width',
  ].forEach((key) => {
    if (payload?.[key] !== undefined && payload?.[key] !== null) metadata[key] = payload[key];
  });
  return metadata;
}

function shouldApplyDisplayWindowToVolumeCache(volumeCache) {
  return volumeCache?.colorMode !== 'rgb' && volumeCache?.colorMode !== 'rgba';
}

function getMprOverlayCompositeAlpha(volumeCache) {
  return volumeCache?.colorMode === 'rgba' ? 1 : 0.45;
}

function drawMprOverlaySlice(context, overlaySliceCanvas, overlayCache, width, height, opacityMultiplier = 1) {
  if (!context || !overlaySliceCanvas) return;
  context.save();
  context.globalAlpha = getMprOverlayCompositeAlpha(overlayCache)
    * Math.min(1, Math.max(0, Number(opacityMultiplier) || 0));
  context.globalCompositeOperation = 'source-over';
  context.drawImage(overlaySliceCanvas, 0, 0, width, height);
  context.restore();
}

function getServerVolumeSliceUrl(volume, axis, index) {
  if (!volume?.imageId) return '';
  const safeAxis = MPR_AXES.includes(axis) ? axis : 'axial';
  const dimensions = normalizeServerVolumeDimensions(volume.dimensions);
  const upper = Math.max(0, dimensions[safeAxis] - 1);
  const safeIndex = clampRange(Math.round(Number(index) || 0), 0, upper, 0);
  return `/api/images/${encodeURIComponent(String(volume.imageId))}/volume-slice?axis=${safeAxis}&index=${safeIndex}&renderer=${MPR_VOLUME_SLICE_RENDER_VERSION}`;
}

function getVolumeRenderSummaryUrl(volume) {
  if (!volume?.imageId) return '';
  return `/api/images/${encodeURIComponent(String(volume.imageId))}/volume-render-summary?summary=${MPR_VOLUME_RENDER_SUMMARY_VERSION}`;
}

function createServerVolumeDescriptor(entry, projectImageLookup = {}, extra = {}) {
  const imageId = getVolumeEntryImageId(entry, projectImageLookup);
  const volumeShape = getVolumeShapeFromEntry(entry, projectImageLookup);
  const colorLayout = getServerVolumeColorLayout(entry, projectImageLookup);
  if (!imageId || !volumeShape || !colorLayout || !isVolumeFileEntry(entry, projectImageLookup)) return null;
  const dimensions = normalizeServerVolumeDimensions(volumeShape);
  const descriptor = {
    kind: MPR_SERVER_VOLUME_KIND,
    id: String(imageId),
    imageId: String(imageId),
    filename: String(entry?.filename || getProjectImageRecord(projectImageLookup, entry)?.filename || ''),
    dimensions,
    ...colorLayout,
    sliceIndex: Math.floor((dimensions.axial - 1) / 2),
    ...extra,
  };
  return {
    ...descriptor,
    url: getServerVolumeSliceUrl(descriptor, 'axial', descriptor.sliceIndex),
  };
}

function isServerVolumeDescriptor(candidate) {
  return candidate?.kind === MPR_SERVER_VOLUME_KIND && Boolean(candidate?.imageId);
}

function hasMprVolumeSource(source) {
  return isServerVolumeDescriptor(source) || (Array.isArray(source) && source.length > 0);
}

function getMprVolumeSourceEntries(source) {
  if (isServerVolumeDescriptor(source)) return [source];
  return Array.isArray(source) ? source : [];
}

function getVolumeSourceImages(part, projectImageLookup = {}) {
  const sourceImages = part?.metadata?.source_images;
  if (!Array.isArray(sourceImages)) return [];
  const serverVolume = sourceImages
    .filter((entry) => entry && !entry.overlay)
    .map((entry) => createServerVolumeDescriptor(entry, projectImageLookup))
    .find(Boolean);
  if (serverVolume) return serverVolume;
  return sourceImages
    .filter((entry) => entry && !entry.overlay)
    .map((entry, index) => {
      const filename = String(entry?.filename || '');
      const imageId = getVolumeEntryImageId(entry, projectImageLookup);
      if (!imageId) return null;
      const sliceIndex = Number(entry?.metadata?.slice_index ?? entry?.slice_index ?? index);
      const normalizedSliceIndex = Number.isFinite(sliceIndex) ? sliceIndex : index;
      if (isVolumeFileEntry(entry, projectImageLookup)) return null;
      return {
        id: String(imageId),
        filename,
        sliceIndex: normalizedSliceIndex,
        url: `/api/images/${encodeURIComponent(String(imageId))}/content`,
        ...getVolumeColorLayout(entry, projectImageLookup),
      };
    })
    .flat()
    .filter(Boolean)
    .sort((left, right) => left.sliceIndex - right.sliceIndex || left.filename.localeCompare(right.filename));
}

function getVolumeOverlayStacks(part, projectImageLookup = {}) {
  const sourceImages = part?.metadata?.source_images;
  if (!Array.isArray(sourceImages)) return [];
  const baseRecords = sourceImages.filter((entry) => entry && !entry.overlay);
  const baseIds = new Set(baseRecords.map((entry) => getVolumeEntryImageId(entry, projectImageLookup)).filter(Boolean));
  const baseFilenames = new Set(baseRecords.map((entry) => String(entry?.filename || '')).filter(Boolean));
  const overlays = sourceImages.filter((entry) => {
    if (!entry?.overlay) return false;
    const baseImageId = String(entry.overlay_base_image_id || '');
    const baseFilename = String(entry.overlay_base_filename || '');
    return (baseImageId && baseIds.has(baseImageId)) || (baseFilename && baseFilenames.has(baseFilename)) || (!baseImageId && !baseFilename && baseRecords.length === 1);
  });
  const stacksByOverlayImage = new Map();
  const serverVolumesByOverlayImage = new Map();
  overlays.forEach((entry, index) => {
    const imageId = getVolumeEntryImageId(entry, projectImageLookup);
    if (!imageId) return;
    const filename = String(entry?.filename || '');
    const sliceIndex = Number(entry?.metadata?.slice_index ?? entry?.slice_index ?? index);
    const key = imageId;
    const serverVolume = createServerVolumeDescriptor(entry, projectImageLookup, {
      overlayBaseImageId: String(entry.overlay_base_image_id || ''),
      overlayBaseFilename: String(entry.overlay_base_filename || ''),
      hidden: entry.hidden === true,
    });
    if (serverVolume) {
      serverVolumesByOverlayImage.set(key, serverVolume);
      return;
    }
    if (isVolumeFileEntry(entry, projectImageLookup)) return;
    if (!stacksByOverlayImage.has(key)) stacksByOverlayImage.set(key, []);
    stacksByOverlayImage.get(key).push({
      id: String(imageId),
      filename,
      sliceIndex: Number.isFinite(sliceIndex) ? sliceIndex : index,
      url: `/api/images/${encodeURIComponent(String(imageId))}/content`,
      ...getVolumeColorLayout(entry, projectImageLookup),
      overlayBaseImageId: String(entry.overlay_base_image_id || ''),
      overlayBaseFilename: String(entry.overlay_base_filename || ''),
      hidden: entry.hidden === true,
    });
  });
  return [
    ...Array.from(serverVolumesByOverlayImage.values()),
    ...Array.from(stacksByOverlayImage.entries()).map(([id, stack]) => ({
      id,
      hidden: stack.every((entry) => entry.hidden === true),
      stack: stack.sort((left, right) => left.sliceIndex - right.sliceIndex || left.filename.localeCompare(right.filename)),
    })),
  ];
}

function getAlignedVolumeOverlayRendererStacks(
  overlayStacks,
  volumeRendererImageStack,
  dimensions = {},
  summariesByImageId = {},
) {
  if (!Array.isArray(overlayStacks) || !Array.isArray(volumeRendererImageStack)
    || volumeRendererImageStack.length === 0) return [];
  const baseSliceIndices = volumeRendererImageStack.map((entry, index) => {
    const sliceIndex = Number(entry?.sliceIndex);
    return Number.isFinite(sliceIndex) ? Math.floor(sliceIndex) : index;
  });
  const axialCount = Math.max(1, Number(dimensions?.axial) || baseSliceIndices.length);

  return overlayStacks.map((overlayEntry) => {
    if (isServerVolumeDescriptor(overlayEntry)) {
      const overlayAxialCount = Math.max(1, Number(overlayEntry.dimensions?.axial) || axialCount);
      const assignments = baseSliceIndices.map((baseSliceIndex) => {
        const normalizedIndex = axialCount <= 1 ? 0 : baseSliceIndex / (axialCount - 1);
        const sourceSliceIndex = clampRange(
          Math.round(normalizedIndex * Math.max(0, overlayAxialCount - 1)),
          0,
          overlayAxialCount - 1,
          0,
        );
        return {
          sourceSliceIndex,
          voxelSliceIndex: baseSliceIndex,
        };
      });
      const summary = summariesByImageId?.[String(overlayEntry.imageId)];
      const representatives = getVolumeSummaryRepresentativeIndices(
        summary,
        overlayAxialCount,
      );
      const claimedSlots = new Set();
      representatives.forEach((sourceSliceIndex) => {
        const voxelSliceIndex = overlayAxialCount <= 1
          ? 0
          : (sourceSliceIndex / (overlayAxialCount - 1)) * Math.max(0, axialCount - 1);
        const nearestSlot = baseSliceIndices
          .map((baseSliceIndex, slotIndex) => ({
            slotIndex,
            distance: Math.abs(baseSliceIndex - voxelSliceIndex),
          }))
          .filter(({ slotIndex }) => !claimedSlots.has(slotIndex))
          .sort((left, right) => left.distance - right.distance || left.slotIndex - right.slotIndex)[0];
        if (!nearestSlot) return;
        claimedSlots.add(nearestSlot.slotIndex);
        assignments[nearestSlot.slotIndex] = { sourceSliceIndex, voxelSliceIndex };
      });
      return baseSliceIndices.map((baseSliceIndex, slotIndex) => {
        const { sourceSliceIndex, voxelSliceIndex } = assignments[slotIndex];
        return {
          ...overlayEntry,
          id: `${overlayEntry.imageId}:axial:${sourceSliceIndex}:slot:${slotIndex}`,
          // Keep the stack sort key aligned with the immutable base slots.
          sliceIndex: baseSliceIndex,
          sourceSliceIndex,
          voxelSliceIndex,
          url: getServerVolumeSliceUrl(overlayEntry, 'axial', sourceSliceIndex),
          depth: getMprFallbackModelCoordinate(
            voxelSliceIndex,
            axialCount,
            MPR_FALLBACK_MODEL_SIZE.depth,
          ),
          opacity: 1,
        };
      });
    }

    const sourceStack = Array.isArray(overlayEntry?.stack)
      ? overlayEntry.stack
      : (Array.isArray(overlayEntry) ? overlayEntry : []);
    if (sourceStack.length === 0) return [];
    const ordered = [...sourceStack].sort((left, right) => (
      Number(left?.sliceIndex || 0) - Number(right?.sliceIndex || 0)
    ));
    return baseSliceIndices.map((baseSliceIndex) => {
      const exact = ordered.find((entry, index) => (
        Number(entry?.sliceIndex ?? index) === baseSliceIndex
      ));
      const closest = exact || ordered.reduce((best, entry, index) => {
        const distance = Math.abs(Number(entry?.sliceIndex ?? index) - baseSliceIndex);
        return !best || distance < best.distance ? { entry, distance } : best;
      }, null)?.entry;
      if (!closest) return null;
      const sourceSliceIndex = Number(closest?.sourceSliceIndex ?? closest?.sliceIndex);
      return {
        ...closest,
        sliceIndex: baseSliceIndex,
        sourceSliceIndex: Number.isFinite(sourceSliceIndex) ? sourceSliceIndex : baseSliceIndex,
        voxelSliceIndex: baseSliceIndex,
        depth: getMprFallbackModelCoordinate(
          baseSliceIndex,
          axialCount,
          MPR_FALLBACK_MODEL_SIZE.depth,
        ),
        opacity: 1,
      };
    }).filter(Boolean);
  }).filter((stack) => stack.length === volumeRendererImageStack.length);
}

function getVolumeSummaryRepresentativeIndices(summary, axialCount) {
  if (Number(summary?.summary_version) !== MPR_VOLUME_RENDER_SUMMARY_VERSION) return [];
  const safeAxialCount = Math.max(1, Math.floor(Number(axialCount) || 1));
  const channelRepresentatives = Array.isArray(summary?.channel_representatives)
    ? summary.channel_representatives.slice(0, 4).map((entry) => entry?.axial_index)
    : [];
  const candidates = channelRepresentatives.length > 0
    ? channelRepresentatives
    : (Array.isArray(summary?.representative_axial_indices)
      ? summary.representative_axial_indices.slice(0, 4)
      : []);
  const representatives = [];
  candidates.forEach((candidate) => {
    const sourceSliceIndex = Math.round(Number(candidate));
    if (
      Number.isFinite(sourceSliceIndex)
      && sourceSliceIndex >= 0
      && sourceSliceIndex < safeAxialCount
      && !representatives.includes(sourceSliceIndex)
    ) representatives.push(sourceSliceIndex);
  });
  return representatives;
}

function isConfirmedRgbaVolumeOverlay(overlayEntry) {
  if (isServerVolumeDescriptor(overlayEntry)) {
    return overlayEntry.channelCount === 4 && overlayEntry.colorMode === 'rgba';
  }
  const stack = Array.isArray(overlayEntry?.stack)
    ? overlayEntry.stack
    : (Array.isArray(overlayEntry) ? overlayEntry : []);
  return stack.length > 0 && stack.every((entry) => (
    entry?.channelCount === 4 && entry?.colorMode === 'rgba'
  ));
}

function getSemantic3dVolumeOverlayStacks(overlayStacks, maxStacks = 4) {
  const safeLimit = Math.min(4, Math.max(0, Math.floor(Number(maxStacks) || 0)));
  return (Array.isArray(overlayStacks) ? overlayStacks : [])
    .filter(isConfirmedRgbaVolumeOverlay)
    .slice(0, safeLimit);
}

async function mapWithConcurrency(items, concurrency, task) {
  const source = Array.isArray(items) ? items : [];
  if (source.length === 0) return [];
  const results = new Array(source.length);
  let cursor = 0;
  const workerCount = Math.min(
    source.length,
    Math.max(1, Math.floor(Number(concurrency) || 1)),
  );
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < source.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(source[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function getVolumeRendererSliceIndices(
  axialCount,
  maxLayers = MPR_VOLUME_RENDERER_MAX_SLICES,
) {
  const safeAxialCount = Math.max(1, Math.floor(Number(axialCount) || 1));
  const safeMaxLayers = Math.min(
    MPR_VOLUME_RENDERER_MAX_SLICES,
    Math.max(1, Math.floor(Number(maxLayers) || MPR_VOLUME_RENDERER_MAX_SLICES)),
    safeAxialCount,
  );
  return safeMaxLayers <= 1
    ? [Math.floor((safeAxialCount - 1) / 2)]
    : Array.from({ length: safeMaxLayers }, (_unused, index) => Math.round(
      (index * (safeAxialCount - 1)) / (safeMaxLayers - 1),
    ));
}

function getNumericRangeFromCandidate(candidate) {
  if (!candidate) return null;
  if (Array.isArray(candidate) && candidate.length >= 2) {
    const min = Number(candidate[0]);
    const max = Number(candidate[1]);
    return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : null;
  }
  if (typeof candidate !== 'object') return null;
  const min = Number(candidate.min ?? candidate.minimum ?? candidate.low ?? candidate.lower ?? candidate.min_value ?? candidate.range_min);
  const max = Number(candidate.max ?? candidate.maximum ?? candidate.high ?? candidate.upper ?? candidate.max_value ?? candidate.range_max);
  return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : null;
}

function getDisplayDomainFromDtype(value) {
  const dtype = String(value || '').trim().toLowerCase();
  if (!dtype) return null;
  if (/uint8|\|u1|<u1|>u1|ubyte/.test(dtype)) return { min: 0, max: 255, step: 1, label: 'uint8' };
  if (/int8|\|i1|<i1|>i1/.test(dtype)) return { min: -128, max: 127, step: 1, label: 'int8' };
  if (/uint16|<u2|>u2|\|u2/.test(dtype)) return { min: 0, max: 65535, step: 1, label: 'uint16' };
  if (/uint32|<u4|>u4|\|u4/.test(dtype)) return { min: 0, max: 4294967295, step: 1, label: 'uint32' };
  if (/int16|<i2|>i2|\|i2/.test(dtype)) return { min: -32768, max: 32767, step: 1, label: 'int16' };
  if (/int32|<i4|>i4|\|i4/.test(dtype)) return { min: -2147483648, max: 2147483647, step: 1, label: 'int32' };
  if (/float|double|<f|>f|\|f/.test(dtype)) return { min: 0, max: 1, step: 0.001, label: dtype.includes('64') ? 'float64' : 'float' };
  return null;
}

function getDisplayDomainFromBitDepth(value, signed = false) {
  const bits = Number(value);
  if (!Number.isFinite(bits) || bits <= 0 || bits > 32) return null;
  if (signed) {
    const max = (2 ** (bits - 1)) - 1;
    return { min: -(2 ** (bits - 1)), max, step: 1, label: `int${bits}` };
  }
  return { min: 0, max: (2 ** bits) - 1, step: 1, label: `${bits}-bit` };
}

function getExplicitDisplayDomainFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const explicitRange = [
    metadata.data_value_range,
    metadata.voxel_value_range,
    metadata.pixel_value_range,
    metadata.scalar_range,
    metadata.value_range,
    metadata.intensity_range,
    metadata.display_range,
  ].map(getNumericRangeFromCandidate).find(Boolean);
  if (explicitRange) {
    const span = explicitRange.max - explicitRange.min;
    return {
      ...explicitRange,
      step: Number.isInteger(explicitRange.min) && Number.isInteger(explicitRange.max) ? 1 : Math.max(0.001, span / 1000),
      label: 'loaded image range',
    };
  }
  return null;
}

function getDisplayDomainFromMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  const explicitRangeDomain = getExplicitDisplayDomainFromMetadata(metadata);
  if (explicitRangeDomain) return explicitRangeDomain;
  const dtypeDomain = getDisplayDomainFromDtype(
    metadata.voxel_dtype
      ?? metadata.pixel_dtype
      ?? metadata.data_dtype
      ?? metadata.dtype
      ?? metadata.pixel_type
      ?? metadata.data_type,
  );
  if (dtypeDomain) return dtypeDomain;
  const bitDepthDomain = getDisplayDomainFromBitDepth(
    metadata.bit_depth ?? metadata.bits_allocated ?? metadata.bits_per_sample,
    metadata.signed === true || String(metadata.pixel_representation || '').toLowerCase() === 'signed',
  );
  if (bitDepthDomain) return bitDepthDomain;
  return null;
}

function combineDisplayDomains(domains) {
  const validDomains = domains.filter(Boolean);
  if (validDomains.length === 0) return null;
  const min = Math.min(...validDomains.map((domain) => Number(domain.min)));
  const max = Math.max(...validDomains.map((domain) => Number(domain.max)));
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  const integerSteps = validDomains.every((domain) => Number(domain.step) === 1);
  return {
    min,
    max,
    step: integerSteps && Number.isInteger(min) && Number.isInteger(max) ? 1 : Math.max(0.001, (max - min) / 1000),
    label: 'loaded image range',
  };
}

function getSourceImageDisplayDomain(source, projectImageLookup = {}, explicitOnly = false) {
  const metadataCandidates = [source?.metadata, source];
  const filename = String(source?.filename || '');
  const imageId = String(source?.image_id || '');
  const imageRecord = projectImageLookup[imageId] || projectImageLookup[filename];
  metadataCandidates.push(getImageMetadata(imageRecord));
  for (const metadata of metadataCandidates) {
    const domain = explicitOnly ? getExplicitDisplayDomainFromMetadata(metadata) : getDisplayDomainFromMetadata(metadata);
    if (domain) return domain;
  }
  return null;
}

function getPartDisplayValueDomain(part, projectImageLookup = {}) {
  const partExplicitDomain = getExplicitDisplayDomainFromMetadata(part?.metadata);
  if (partExplicitDomain) return partExplicitDomain;

  const sourceImages = Array.isArray(part?.metadata?.source_images) ? part.metadata.source_images : [];
  const sourceExplicitDomain = combineDisplayDomains(
    sourceImages.map((source) => getSourceImageDisplayDomain(source, projectImageLookup, true)),
  );
  if (sourceExplicitDomain) return sourceExplicitDomain;

  const partDomain = getDisplayDomainFromMetadata(part?.metadata);
  if (partDomain) return partDomain;

  for (const source of sourceImages) {
    const sourceDomain = getSourceImageDisplayDomain(source, projectImageLookup);
    if (sourceDomain) return sourceDomain;
  }

  return DEFAULT_DISPLAY_VALUE_DOMAIN;
}


function getNumericHistogramThreshold(metadata, domain) {
  const histogram = metadata?.histogram || metadata?.pixel_histogram || metadata?.intensity_histogram;
  const bins = Array.isArray(histogram?.bins) ? histogram.bins : Array.isArray(histogram?.bucket_edges) ? histogram.bucket_edges : null;
  const counts = Array.isArray(histogram?.counts) ? histogram.counts : Array.isArray(histogram?.buckets) ? histogram.buckets : null;
  if (!bins || !counts || counts.length === 0) return null;
  const numericCounts = counts.map(Number).filter((value) => Number.isFinite(value) && value >= 0);
  const total = numericCounts.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const target = total * 0.75;
  let cumulative = 0;
  for (let index = 0; index < numericCounts.length; index += 1) {
    cumulative += numericCounts[index];
    if (cumulative >= target) {
      const candidate = Number(bins[Math.min(index, bins.length - 1)]);
      if (Number.isFinite(candidate)) return clampRange(candidate, domain.min, domain.max, candidate);
    }
  }
  return null;
}

function getSplatDefaultThreshold(part, displayDomain) {
  const domain = getNormalizedDisplayDomain(displayDomain);
  const metadataCandidates = [part?.metadata];
  const sourceImages = Array.isArray(part?.metadata?.source_images) ? part.metadata.source_images : [];
  sourceImages.forEach((source) => metadataCandidates.push(source?.metadata, source));
  for (const metadata of metadataCandidates) {
    const threshold = getNumericHistogramThreshold(metadata, domain);
    if (threshold !== null) return threshold;
  }
  return domain.min + ((domain.max - domain.min) * 0.65);
}

function getDefaultSplatParameters(part, displayDomain) {
  const domain = getNormalizedDisplayDomain(displayDomain);
  const dimensions = getMprDimensions(part);
  const voxelCount = Math.max(1, Number(dimensions.axial || 1) * Number(dimensions.coronal || 1) * Number(dimensions.sagittal || 1));
  const targetMaxSplats = Math.min(100000, Math.max(50000, Math.round(voxelCount * 0.08)));
  return {
    threshold: Math.round(getSplatDefaultThreshold(part, domain) / domain.step) * domain.step,
    intensityMin: domain.min,
    intensityMax: domain.max,
    opacityMin: 0.08,
    opacityMax: 0.95,
    downsample: Math.max(1, Math.ceil(Math.cbrt(voxelCount / targetMaxSplats))),
    maxSplats: targetMaxSplats,
    outputFormat: 'ply',
  };
}

function getSplatParametersForPart(part, displayDomain, overridesByPart) {
  const defaults = getDefaultSplatParameters(part, displayDomain);
  const overrides = part?.id ? overridesByPart?.[part.id] : null;
  return { ...defaults, ...(overrides || {}) };
}

function getNormalizedDisplayDomain(domain) {
  const min = Number(domain?.min);
  const max = Number(domain?.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return DEFAULT_DISPLAY_VALUE_DOMAIN;
  const step = Number(domain?.step);
  return {
    min,
    max,
    step: Number.isFinite(step) && step > 0 ? step : 1,
    label: domain?.label || DEFAULT_DISPLAY_VALUE_DOMAIN.label,
  };
}

function formatWindowValue(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  if (Number.isInteger(numeric)) return String(numeric);
  return numeric.toFixed(3).replace(/\.?0+$/, '');
}

function normalizeDisplayWindow(candidate, domain, fallback) {
  const safeDomain = getNormalizedDisplayDomain(domain);
  const minimumGap = Math.min(safeDomain.step, safeDomain.max - safeDomain.min);
  const fallbackWindow = fallback && Number.isFinite(Number(fallback.min)) && Number.isFinite(Number(fallback.max))
    ? fallback
    : { min: safeDomain.min, max: safeDomain.max };
  const rawMin = Number(candidate?.min);
  const rawMax = Number(candidate?.max);
  let min = Number.isFinite(rawMin) ? rawMin : Number(fallbackWindow.min);
  let max = Number.isFinite(rawMax) ? rawMax : Number(fallbackWindow.max);
  min = clampRange(min, safeDomain.min, safeDomain.max - minimumGap, safeDomain.min);
  max = clampRange(max, min + minimumGap, safeDomain.max, safeDomain.max);
  return { min, max };
}

function remapDisplayWindow(candidate, previousDomain, nextDomain) {
  const previous = getNormalizedDisplayDomain(previousDomain);
  const next = getNormalizedDisplayDomain(nextDomain);
  const windowRange = normalizeDisplayWindow(candidate, previous);
  const previousSpan = previous.max - previous.min;
  const nextSpan = next.max - next.min;
  const mapValue = (value) => {
    const ratio = (value - previous.min) / previousSpan;
    const unrounded = next.min + (ratio * nextSpan);
    return next.min + (Math.round((unrounded - next.min) / next.step) * next.step);
  };
  return normalizeDisplayWindow(
    { min: mapValue(windowRange.min), max: mapValue(windowRange.max) },
    next,
  );
}

function getWindowPercent(value, domain) {
  const safeDomain = getNormalizedDisplayDomain(domain);
  return ((clampRange(value, safeDomain.min, safeDomain.max, safeDomain.min) - safeDomain.min) / (safeDomain.max - safeDomain.min)) * 100;
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

function getAssignedOverlayDisplayLabel(record) {
  if (record?.analysis_output || record?.analysis_source_image_id) return '';
  const baseName = String(record?.overlay_base_filename || record?.overlay_base_image_id || '').trim();
  if (!baseName) return '';
  return `overlay for ${safeDecodeFilename(baseName)}`;
}

function getAnalyzeOverlayDisplayLabel(label) {
  const parts = String(label || 'Analyze Overlay')
    .split('::')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 1) return parts[0] || 'Analyze Overlay';
  return [...parts].reverse().join(' :: ');
}

function getPartImageRefs(part) {
  const refs = [];
  const claimedImages = [];
  const sourceImages = Array.isArray(part?.metadata?.source_images) ? part.metadata.source_images : [];
  const sourceImageByFilename = sourceImages.reduce((acc, record) => {
    const filename = String(record?.filename || '');
    if (filename && !acc[filename]) acc[filename] = record;
    return acc;
  }, {});
  const getRecordModality = (record) => String(record?.modality || record?.metadata?.modality || '').toLowerCase();
  const claimImageIdentity = (record = {}) => {
    const imageId = String(record.image_id || '').trim();
    const filename = String(record.filename || '').trim();
    let existing = imageId
      ? claimedImages.find((candidate) => candidate.imageId === imageId)
      : null;
    if (!existing && filename) {
      existing = claimedImages.find((candidate) => (
        candidate.filename === filename
        && (!imageId || !candidate.imageId)
      ));
    }
    if (existing) {
      if (!existing.imageId && imageId) {
        existing.imageId = imageId;
        if (existing.ref && !existing.ref.imageId) existing.ref.imageId = imageId;
      }
      if (!existing.filename && filename) {
        existing.filename = filename;
        if (existing.ref && !existing.ref.filename) existing.ref.filename = filename;
      }
      return { claimed: false, entry: existing };
    }
    const entry = { imageId, filename, ref: null };
    claimedImages.push(entry);
    return { claimed: true, entry };
  };
  const imagesByView = part?.metadata?.view_images;
  if (imagesByView && typeof imagesByView === 'object') {
    Object.entries(imagesByView).forEach(([viewName, imageRef]) => {
      const ref = String(imageRef || '');
      if (!ref) return;
      const sourceRecord = sourceImageByFilename[ref] || {};
      const identity = claimImageIdentity({ ...sourceRecord, filename: ref });
      if (!identity.claimed) return;
      const imageReference = {
        id: `${part.id}-view-${viewName}`,
        viewName: String(viewName || '').toLowerCase(),
        modality: getRecordModality(sourceRecord),
        label: String(viewName || 'image').toUpperCase(),
        imageRef: ref,
        imageId: sourceRecord.image_id ? String(sourceRecord.image_id) : '',
        overlay: false,
        hidden: sourceRecord.hidden === true,
      };
      identity.entry.ref = imageReference;
      refs.push(imageReference);
    });
  }
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
    const cropChild = record.crop_child_image === true || record.cropChildImage === true;
    const cropSubtitle = String(record.crop_subtitle || record.cropSubtitle || '').trim();
    const imageRef = String(record.image_id || record.filename || '');
    if (!imageRef) return;
    const identity = claimImageIdentity(record);
    if (!identity.claimed) return;
    const modality = getRecordModality(record);
    const label = cropChild
      ? String(record.crop_title || record.filename || `CROP ${index + 1}`)
      : overlay
        ? (getAssignedOverlayDisplayLabel(record) || getAnalyzeOverlayDisplayLabel(record.label || record.analysis_label || modality || 'Analyze Overlay'))
        : String(record.side || record.modality || `IMAGE ${index + 1}`).toUpperCase();
    const imageReference = {
      id: `${part.id}-${overlay ? 'analysis' : 'source'}-${index}`,
      viewName: String(record.side || record.modality || (overlay ? 'overlay' : 'image')).toLowerCase(),
      modality,
      label,
      imageRef,
      filename: String(record.filename || ''),
      imageId: record.image_id ? String(record.image_id) : '',
      overlay,
      cropChild,
      cropSubtitle,
      parentImageId: record.parent_image_id ? String(record.parent_image_id) : '',
      parentImageFilename: record.parent_image_filename ? String(record.parent_image_filename) : '',
      overlayBaseImageId: record.overlay_base_image_id ? String(record.overlay_base_image_id) : '',
      overlayBaseFilename: record.overlay_base_filename ? String(record.overlay_base_filename) : '',
      hidden: record.hidden === true,
    };
    identity.entry.ref = imageReference;
    refs.push(imageReference);
  };
  sourceImages.forEach((record, index) => {
    pushRecord(record, index, isAnalyzeOutputRecord(record));
  });
  const analysisOutputs = part?.metadata?.analysis_outputs;
  if (Array.isArray(analysisOutputs)) {
    analysisOutputs.forEach((record, index) => {
      pushRecord(record, index, true);
    });
  }
  return refs;
}

function isDeletedProjectImageRecord(record) {
  return Boolean(record?.deleted_at || record?.deletedAt || record?.is_deleted || record?.deleted);
}

function isInspectionImageRefLoaded(entry, projectImageLookup = {}) {
  const candidates = [
    entry?.imageId,
    entry?.imageRef,
    entry?.filename,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const records = candidates.map((candidate) => projectImageLookup[candidate]).filter(Boolean);
  if (records.length === 0) return true;
  return records.some((record) => !isDeletedProjectImageRecord(record));
}

function resolveProjectImageId(projectImageLookup, ...candidates) {
  for (const candidate of candidates) {
    const key = String(candidate || '');
    if (!key) continue;
    const record = projectImageLookup[key];
    if (record?.id) return String(record.id);
    if (key) return key;
  }
  return '';
}

function getAnnotationSourceImageId(entry, projectImageLookup) {
  const imageId = resolveProjectImageId(projectImageLookup, entry?.imageId, entry?.imageRef);
  if (!imageId) return '';
  if (!entry?.overlay) return imageId;
  const imageRecord = projectImageLookup[entry.imageId] || projectImageLookup[entry.imageRef] || {};
  return resolveProjectImageId(
    projectImageLookup,
    entry.overlayBaseImageId,
    entry.overlayBaseFilename,
    imageRecord?.metadata?.overlay_base_image_id,
    imageRecord?.metadata?.analysis_source_image_id,
    imageRecord?.metadata?.overlay_base_filename,
    imageId,
  );
}

function getAnnotationSourceImageIdLookup(imageEntries, projectImageLookup) {
  return imageEntries.reduce((acc, entry) => {
    const imageId = resolveProjectImageId(projectImageLookup, entry?.imageId, entry?.imageRef);
    const sourceImageId = getAnnotationSourceImageId(entry, projectImageLookup);
    if (imageId && sourceImageId) acc[imageId] = sourceImageId;
    if (sourceImageId) acc[sourceImageId] = sourceImageId;
    return acc;
  }, {});
}

function renderAnnotationOverlay({
  measurementLines = [],
  boxes = [],
  fontSize = 24,
  selectedAnnotationId = '',
  opacityMultiplier = 1,
}) {
  const visualOpacity = Math.min(1, Math.max(0, Number(opacityMultiplier) || 0));
  return (
    <>
      {measurementLines.filter(isFiniteMeasurementLine).map((line) => {
        const labelPosition = getMeasurementLabelViewBoxPosition(line, fontSize);
        const isSelected = String(selectedAnnotationId || '') === String(line.id || '');
        return (
          <g key={`line-${line.id}`} className={isSelected ? 'inspection-annotation-selected' : ''} opacity={visualOpacity}>
            {isSelected && <line x1={(line.x1 / line.imageWidth) * 1000} y1={(line.y1 / line.imageHeight) * 1000} x2={(line.x2 / line.imageWidth) * 1000} y2={(line.y2 / line.imageHeight) * 1000} stroke="#ffffff" strokeWidth="10" />}
            <line x1={(line.x1 / line.imageWidth) * 1000} y1={(line.y1 / line.imageHeight) * 1000} x2={(line.x2 / line.imageWidth) * 1000} y2={(line.y2 / line.imageHeight) * 1000} stroke={line.color} strokeWidth={isSelected ? '6' : '3'} />
            <text x={labelPosition.x} y={labelPosition.y} fill={line.color} fontSize={fontSize} fontWeight={isSelected ? '800' : '400'}>
              {getMeasurementLineLabel(line)}
            </text>
          </g>
        );
      })}
      {boxes.filter(isFiniteAnnotationBox).map((box) => {
        const x = (box.x / box.imageWidth) * 1000;
        const y = (box.y / box.imageHeight) * 1000;
        const width = (box.width / box.imageWidth) * 1000;
        const height = (box.height / box.imageHeight) * 1000;
        const labelSize = Math.max(18, fontSize * 0.82);
        const isSelected = String(selectedAnnotationId || '') === String(box.id || '');
        const fillOpacity = Number.isFinite(Number(box.fillOpacity)) ? Math.min(1, Math.max(0, Number(box.fillOpacity))) : DEFAULT_ANNOTATION_FILL_OPACITY;
        return (
          <g key={`box-${box.id}`} className={isSelected ? 'inspection-annotation-selected' : ''} opacity={visualOpacity}>
            {isSelected && <rect x={x} y={y} width={width} height={height} fill={box.color} fillOpacity={Math.min(1, fillOpacity + 0.18)} stroke="#ffffff" strokeWidth="10" />}
            <rect x={x} y={y} width={width} height={height} fill={box.color} fillOpacity={fillOpacity} stroke={box.color} strokeWidth={isSelected ? '6' : '3'} />
            <text x={Math.min(980, Math.max(20, x + (width / 2)))} y={Math.max(24, y - 8)} fill={box.color} fontSize={labelSize} fontWeight={isSelected ? '800' : '400'} textAnchor="middle">
              {getAnnotationBoxWidthLabel(box)}
            </text>
            <text x={Math.min(980, x + width + 12)} y={Math.min(980, y + (height / 2))} fill={box.color} fontSize={labelSize} fontWeight={isSelected ? '800' : '400'} transform={`rotate(90 ${Math.min(980, x + width + 12)} ${Math.min(980, y + (height / 2))})`} textAnchor="middle">
              {getAnnotationBoxHeightLabel(box)}
            </text>
          </g>
        );
      })}
    </>
  );
}

function renderTileAnnotationEditingTargets({
  measurementLines = [],
  boxes = [],
  selectedAnnotationId = '',
  onStartDrag,
  onDragMove,
  onDragFinish,
  onDragCancel,
}) {
  const stopSyntheticClick = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <>
      {measurementLines.filter(isFiniteMeasurementLine).map((line) => {
        const selected = String(selectedAnnotationId || '') === String(line.id || '');
        const endpoints = getMeasurementEndpointViewBoxPosition(line);
        return (
          <g key={`tile-line-edit-${line.id}`}>
            <line
              className="inspection-annotation-drag-target"
              x1={(line.x1 / line.imageWidth) * 1000}
              y1={(line.y1 / line.imageHeight) * 1000}
              x2={(line.x2 / line.imageWidth) * 1000}
              y2={(line.y2 / line.imageHeight) * 1000}
              stroke="transparent"
              strokeWidth="24"
              pointerEvents="stroke"
              aria-label={`Move tile measurement ${line.name || line.id || ''}`.trim()}
              onPointerDown={(event) => onStartDrag(event, 'line', 'translate', line)}
              onPointerMove={onDragMove}
              onPointerUp={onDragFinish}
              onPointerCancel={onDragCancel}
              onClick={stopSyntheticClick}
            />
            {selected && ['start', 'end'].map((endpoint) => (
              <circle
                key={endpoint}
                className="inspection-measurement-endpoint-dot"
                cx={endpoints[endpoint].x}
                cy={endpoints[endpoint].y}
                r="11"
                fill="#ffffff"
                stroke={line.color}
                strokeWidth="5"
                role="button"
                aria-label={`Reposition tile ${endpoint} endpoint for ${line.name || 'measurement'}`}
                onPointerDown={(event) => onStartDrag(event, 'line', endpoint, line)}
                onPointerMove={onDragMove}
                onPointerUp={onDragFinish}
                onPointerCancel={onDragCancel}
                onClick={stopSyntheticClick}
              />
            ))}
          </g>
        );
      })}
      {boxes.filter(isFiniteAnnotationBox).map((box) => {
        const selected = String(selectedAnnotationId || '') === String(box.id || '');
        const corners = getAnnotationBoxCornerViewBoxPosition(box);
        return (
          <g key={`tile-box-edit-${box.id}`}>
            <rect
              className="inspection-annotation-drag-target"
              x={(box.x / box.imageWidth) * 1000}
              y={(box.y / box.imageHeight) * 1000}
              width={(box.width / box.imageWidth) * 1000}
              height={(box.height / box.imageHeight) * 1000}
              fill="transparent"
              pointerEvents="all"
              aria-label={`Move tile box ${box.name || box.id || ''}`.trim()}
              onPointerDown={(event) => onStartDrag(event, 'box', 'translate', box)}
              onPointerMove={onDragMove}
              onPointerUp={onDragFinish}
              onPointerCancel={onDragCancel}
              onClick={stopSyntheticClick}
            />
            {selected && Object.entries(corners).map(([corner, point]) => (
              <circle
                key={corner}
                className="inspection-box-corner-dot"
                cx={point.x}
                cy={point.y}
                r="11"
                fill="#ffffff"
                stroke={box.color}
                strokeWidth="5"
                role="button"
                aria-label={`Reposition tile ${corner} corner for ${box.name || 'bounding box'}`}
                onPointerDown={(event) => onStartDrag(event, 'box', corner, box)}
                onPointerMove={onDragMove}
                onPointerUp={onDragFinish}
                onPointerCancel={onDragCancel}
                onClick={stopSyntheticClick}
              />
            ))}
          </g>
        );
      })}
    </>
  );
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

function getCanonicalSegmentationSliceIndex(
  axis,
  uiSliceIndex,
  uiDimensions = {},
  volumeDimensions = [],
) {
  const safeAxis = MPR_AXES.includes(axis) ? axis : 'axial';
  const canonicalDimensions = Array.isArray(volumeDimensions)
    ? volumeDimensions
    : [
      volumeDimensions?.x ?? volumeDimensions?.width ?? volumeDimensions?.sagittal,
      volumeDimensions?.y ?? volumeDimensions?.height ?? volumeDimensions?.coronal,
      volumeDimensions?.z ?? volumeDimensions?.depth ?? volumeDimensions?.axial,
    ];
  const targetLength = safeAxis === 'sagittal'
    ? canonicalDimensions[0]
    : (safeAxis === 'coronal' ? canonicalDimensions[1] : canonicalDimensions[2]);
  return getScaledIndex(
    uiSliceIndex,
    Math.max(0, (Number(uiDimensions[safeAxis]) || 1) - 1),
    targetLength,
  );
}

function getMprVolumeCacheKey(imageStack, dimensions = {}) {
  if (!isServerVolumeDescriptor(imageStack) && (!Array.isArray(imageStack) || imageStack.length === 0)) return '';
  const resolvedDimensions = isServerVolumeDescriptor(imageStack) ? imageStack.dimensions : dimensions;
  const dimensionKey = MPR_AXES.map((axis) => `${axis}:${resolvedDimensions?.[axis] || 0}`).join(',');
  if (isServerVolumeDescriptor(imageStack)) {
    return `${dimensionKey}|${MPR_SERVER_VOLUME_KIND}:${imageStack.imageId}:${imageStack.channelCount || 1}:${imageStack.colorMode || 'scalar'}`;
  }
  return `${dimensionKey}|${imageStack
    .map((entry) => `${entry.id}:${entry.sliceIndex}:${entry.url}`)
    .join('|')}`;
}

function rememberMprVolumeCache(key, cache) {
  if (!key || !cache) return;
  const replaced = mprVolumeCacheStore.get(key);
  if (replaced && replaced !== cache) forgetMprVolumeCacheCanvases(replaced);
  mprVolumeCacheStore.delete(key);
  mprVolumeCacheStore.set(key, cache);
  while (mprVolumeCacheStore.size > MPR_VOLUME_CACHE_LIMIT) {
    const oldestKey = mprVolumeCacheStore.keys().next().value;
    const oldestCache = mprVolumeCacheStore.get(oldestKey);
    mprVolumeCacheStore.delete(oldestKey);
    forgetMprVolumeCacheCanvases(oldestCache);
  }
}

function getSliceCanvasByteSize(canvas) {
  const width = Math.max(0, Math.floor(Number(canvas?.width) || 0));
  const height = Math.max(0, Math.floor(Number(canvas?.height) || 0));
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) return 0;
  const bytes = width * height * 4;
  return Number.isSafeInteger(bytes) ? bytes : 0;
}

function getGlobalSliceCanvasKey(volumeCache, sliceKey) {
  return `${volumeCache?.key || 'anonymous'}\0${sliceKey}`;
}

function forgetMprVolumeCacheCanvases(volumeCache) {
  if (!volumeCache?.sliceCanvases) return;
  volumeCache.sliceCanvases.forEach((canvas, sliceKey) => {
    const globalKey = getGlobalSliceCanvasKey(volumeCache, sliceKey);
    const entry = mprSliceCanvasCacheStore.get(globalKey);
    if (entry?.canvas === canvas) {
      mprSliceCanvasCacheBytes = Math.max(0, mprSliceCanvasCacheBytes - entry.bytes);
      mprSliceCanvasCacheStore.delete(globalKey);
    }
  });
  volumeCache.sliceCanvases.clear();
}

function rememberSliceCanvas(volumeCache, key, canvas) {
  if (!volumeCache?.sliceCanvases || !key || !canvas) return;
  const globalKey = getGlobalSliceCanvasKey(volumeCache, key);
  const previous = mprSliceCanvasCacheStore.get(globalKey);
  if (previous) {
    mprSliceCanvasCacheBytes = Math.max(0, mprSliceCanvasCacheBytes - previous.bytes);
    mprSliceCanvasCacheStore.delete(globalKey);
  }
  volumeCache.sliceCanvases.delete(key);
  volumeCache.sliceCanvases.set(key, canvas);
  const bytes = getSliceCanvasByteSize(canvas);
  mprSliceCanvasCacheStore.set(globalKey, { volumeCache, sliceKey: key, canvas, bytes });
  mprSliceCanvasCacheBytes += bytes;
  while (mprSliceCanvasCacheBytes > MPR_SLICE_CANVAS_CACHE_MAX_BYTES) {
    const oldestGlobalKey = mprSliceCanvasCacheStore.keys().next().value;
    const oldest = mprSliceCanvasCacheStore.get(oldestGlobalKey);
    mprSliceCanvasCacheStore.delete(oldestGlobalKey);
    mprSliceCanvasCacheBytes = Math.max(0, mprSliceCanvasCacheBytes - (oldest?.bytes || 0));
    if (oldest?.volumeCache?.sliceCanvases?.get(oldest.sliceKey) === oldest.canvas) {
      oldest.volumeCache.sliceCanvases.delete(oldest.sliceKey);
    }
  }
}

function getMprSliceCanvasCacheStats() {
  return {
    bytes: mprSliceCanvasCacheBytes,
    items: mprSliceCanvasCacheStore.size,
    maxBytes: MPR_SLICE_CANVAS_CACHE_MAX_BYTES,
  };
}

function resetMprSliceCanvasCacheForTests() {
  [...mprVolumeCacheStore.values()].forEach(forgetMprVolumeCacheCanvases);
  mprVolumeCacheStore.clear();
  mprSliceCanvasCacheStore.clear();
  mprSliceCanvasCacheBytes = 0;
}

function loadMprImage(source, onSettled) {
  return new Promise((resolve) => {
    const image = new Image();
    const settle = (loadedImage) => {
      onSettled?.();
      resolve(loadedImage);
    };
    image.onload = () => settle(image);
    image.onerror = () => settle(null);
    image.src = source.url;
  });
}

function createServerMprVolumeCache(cacheKey, descriptor, dimensions = {}) {
  const resolvedDimensions = normalizeServerVolumeDimensions(descriptor?.dimensions || dimensions);
  return {
    ...descriptor,
    kind: MPR_SERVER_VOLUME_KIND,
    key: cacheKey,
    dimensions: resolvedDimensions,
    width: resolvedDimensions.sagittal,
    height: resolvedDimensions.coronal,
    depth: resolvedDimensions.axial,
    sliceCanvases: new Map(),
    pendingSliceRequests: new Map(),
    prefetchAnchorByAxis: {},
    prefetchGenerationByAxis: {},
    currentGenerationByAxis: {},
    currentDebounceByAxis: {},
  };
}

function beginServerMprSlicePrefetch(volumeCache, axis, index) {
  const previousAnchor = volumeCache.prefetchAnchorByAxis[axis];
  if (previousAnchor === index) return volumeCache.prefetchGenerationByAxis[axis] || 1;
  const generation = (volumeCache.prefetchGenerationByAxis[axis] || 0) + 1;
  volumeCache.prefetchAnchorByAxis[axis] = index;
  volumeCache.prefetchGenerationByAxis[axis] = generation;
  volumeCache.currentGenerationByAxis[axis] = generation;
  return generation;
}

function invalidateServerMprSliceGeneration(volumeCache, axis) {
  if (!volumeCache) return;
  const pendingDebounce = volumeCache.currentDebounceByAxis?.[axis];
  if (pendingDebounce) {
    clearTimeout(pendingDebounce.timer);
    delete volumeCache.currentDebounceByAxis[axis];
    pendingDebounce.resolve(null);
  }
  const generation = Math.max(
    volumeCache.prefetchGenerationByAxis?.[axis] || 0,
    volumeCache.currentGenerationByAxis?.[axis] || 0,
  ) + 1;
  volumeCache.prefetchGenerationByAxis[axis] = generation;
  volumeCache.currentGenerationByAxis[axis] = generation;
}

function getServerVolumePrefetchSources(volume, axis, index, radius = MPR_SERVER_SLICE_PREFETCH_RADIUS) {
  if (!isServerVolumeDescriptor(volume)) return [];
  const safeAxis = MPR_AXES.includes(axis) ? axis : 'axial';
  const dimensions = normalizeServerVolumeDimensions(volume.dimensions);
  const upper = Math.max(0, dimensions[safeAxis] - 1);
  const center = clampRange(Math.round(Number(index) || 0), 0, upper, 0);
  const offsets = [0];
  for (let distance = 1; distance <= Math.max(0, Number(radius) || 0); distance += 1) {
    offsets.push(-distance, distance);
  }
  const indexes = [];
  offsets.forEach((offset) => {
    const candidate = center + offset;
    if (candidate >= 0 && candidate <= upper && !indexes.includes(candidate)) indexes.push(candidate);
  });
  return indexes.map((sliceIndex) => ({
    axis: safeAxis,
    index: sliceIndex,
    url: getServerVolumeSliceUrl(volume, safeAxis, sliceIndex),
  }));
}

async function buildServerMprSliceCanvas(volumeCache, source) {
  const image = await loadMprImage(source);
  if (!image) throw new Error(`Failed to load ${source.axis} slice ${source.index}`);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext?.('2d');
  if (!context) throw new Error('Canvas rendering is unavailable');
  const fallbackDimensions = getMprAxisImageDimensions(source.axis, volumeCache.dimensions, volumeCache);
  canvas.width = image.naturalWidth || image.width || fallbackDimensions.width;
  canvas.height = image.naturalHeight || image.height || fallbackDimensions.height;
  context.clearRect(0, 0, canvas.width, canvas.height);
  drawServerMprSliceImage(context, image, source.axis, canvas.width, canvas.height);
  return canvas;
}

function drawServerMprSliceImage(context, image, axis, width, height) {
  context.save();
  if (axis === 'coronal' || axis === 'sagittal') {
    // The legacy reconstruction displays axial z=0 on the bottom row for
    // orthogonal views. Backend NumPy slices arrive with z=0 on the top row.
    context.translate(0, height);
    context.scale(1, -1);
  }
  context.drawImage(image, 0, 0, width, height);
  context.restore();
}

function requestServerMprSliceCanvas(
  volumeCache,
  source,
  { priority = false, prefetchGeneration = null, currentGeneration = null } = {},
) {
  if (!isServerVolumeDescriptor(volumeCache) || !source?.url) return Promise.resolve(null);
  const sliceKey = `${source.axis}:${source.index}`;
  const cachedCanvas = volumeCache.sliceCanvases.get(sliceKey);
  if (cachedCanvas) {
    rememberSliceCanvas(volumeCache, sliceKey, cachedCanvas);
    return Promise.resolve(cachedCanvas);
  }
  const pendingRequest = volumeCache.pendingSliceRequests.get(sliceKey);
  if (pendingRequest) {
    if (priority) {
      pendingRequest.isPrefetch = false;
      pendingRequest.currentGeneration = currentGeneration;
      return pendingRequest.promise.then((canvas) => (
        canvas || requestServerMprSliceCanvas(volumeCache, source, {
          priority: true,
          currentGeneration,
        })
      ));
    }
    if (pendingRequest.isPrefetch && prefetchGeneration !== null) {
      pendingRequest.prefetchGeneration = prefetchGeneration;
    }
    return pendingRequest.promise;
  }

  const requestState = {
    isPrefetch: !priority && prefetchGeneration !== null,
    prefetchGeneration,
    currentGeneration,
  };
  const shouldRun = () => (
    requestState.isPrefetch
      ? volumeCache.prefetchGenerationByAxis[source.axis] === requestState.prefetchGeneration
      : (
        requestState.currentGeneration === null
        || volumeCache.currentGenerationByAxis[source.axis] === requestState.currentGeneration
      )
  );
  const enqueue = () => scheduleMprServerSliceTask(
    () => buildServerMprSliceCanvas(volumeCache, source),
    { priority, shouldRun },
  );
  const scheduledRequest = priority && currentGeneration !== null
    ? new Promise((resolve, reject) => {
      const previous = volumeCache.currentDebounceByAxis[source.axis];
      if (previous) {
        clearTimeout(previous.timer);
        previous.resolve(null);
      }
      const state = { resolve, timer: null };
      state.timer = setTimeout(() => {
        if (volumeCache.currentDebounceByAxis[source.axis] === state) {
          delete volumeCache.currentDebounceByAxis[source.axis];
        }
        if (!shouldRun()) {
          resolve(null);
          return;
        }
        enqueue().then(resolve, reject);
      }, MPR_SERVER_CURRENT_SLICE_DEBOUNCE_MS);
      volumeCache.currentDebounceByAxis[source.axis] = state;
    })
    : enqueue();
  const request = scheduledRequest.then((canvas) => {
    if (canvas) rememberSliceCanvas(volumeCache, sliceKey, canvas);
    return canvas;
  }).finally(() => {
    volumeCache.pendingSliceRequests.delete(sliceKey);
  });
  requestState.promise = request;
  volumeCache.pendingSliceRequests.set(sliceKey, requestState);
  return request;
}

function getMprSliceCachingMessage(progress = {}) {
  const loaded = Math.max(0, Number(progress.loadedSlices) || 0);
  const total = Math.max(0, Number(progress.totalSlices) || 0);
  if (total > 0) return `Caching MPR slices ${Math.min(loaded, total)}/${total}`;
  return 'Caching MPR slices';
}

async function buildMprVolumeCache(cacheKey, imageStack, dimensions, onProgress) {
  const totalSlices = Array.isArray(imageStack) ? imageStack.length : 0;
  let loadedSlices = 0;
  const reportProgress = () => {
    loadedSlices += 1;
    onProgress?.({ loadedSlices, totalSlices });
  };
  const images = await Promise.all(imageStack.map((source) => loadMprImage(source, reportProgress)));
  const loadedEntries = images
    .map((image, index) => ({ image, source: imageStack[index], index }))
    .filter((entry) => entry.image);
  if (loadedEntries.length === 0) return null;

  const first = loadedEntries[0].image;
  const width = first.naturalWidth || first.width || Math.max(1, dimensions.sagittal || 1);
  const height = first.naturalHeight || first.height || Math.max(1, dimensions.coronal || 1);
  const scratch = document.createElement('canvas');
  const scratchContext = scratch.getContext?.('2d');
  if (!scratchContext) return null;

  scratch.width = width;
  scratch.height = height;

  const maxDeclaredSliceIndex = imageStack.reduce((max, source, index) => {
    const sliceIndex = Number(source?.sliceIndex);
    return Math.max(max, Number.isFinite(sliceIndex) ? Math.floor(sliceIndex) : index);
  }, 0);
  const depth = Math.max(
    1,
    Math.floor(Number(dimensions?.axial) || 0),
    maxDeclaredSliceIndex + 1,
    imageStack.length,
  );
  const slices = Array.from({ length: depth }, () => ({
    image: null,
    imageData: scratchContext.createImageData(width, height),
    valid: false,
  }));

  loadedEntries.forEach(({ image, source, index }) => {
    const declaredSliceIndex = Number(source?.sliceIndex);
    const sliceIndex = clampRange(
      Number.isFinite(declaredSliceIndex) ? Math.floor(declaredSliceIndex) : index,
      0,
      depth - 1,
      index,
    );
    scratchContext.clearRect(0, 0, width, height);
    scratchContext.drawImage(image, 0, 0, width, height);
    slices[sliceIndex] = {
      image,
      imageData: scratchContext.getImageData(0, 0, width, height),
      valid: true,
    };
  });
  const validSliceCount = slices.reduce((count, slice) => count + (slice.valid ? 1 : 0), 0);

  return {
    key: cacheKey,
    width,
    height,
    depth,
    channelCount: Number(imageStack[0]?.channelCount) || 1,
    colorMode: String(imageStack[0]?.colorMode || 'scalar'),
    slices,
    validSliceCount,
    complete: validSliceCount === depth,
    sliceCanvases: new Map(),
  };
}

function getCachedMprSliceCanvas(axis, slicePosition, dimensions, volumeCache) {
  if (!volumeCache || typeof document === 'undefined') return null;
  if (isServerVolumeDescriptor(volumeCache)) {
    const safeAxis = MPR_AXES.includes(axis) ? axis : 'axial';
    const sourceMax = Math.max(0, (Number(dimensions?.[safeAxis]) || 1) - 1);
    const targetLength = Number(volumeCache.dimensions?.[safeAxis]) || 1;
    const sliceIndex = getScaledIndex(slicePosition?.[safeAxis], sourceMax, targetLength);
    const sliceKey = `${safeAxis}:${sliceIndex}`;
    const cachedCanvas = volumeCache.sliceCanvases.get(sliceKey);
    if (cachedCanvas) rememberSliceCanvas(volumeCache, sliceKey, cachedCanvas);
    return cachedCanvas || null;
  }
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
    if (slice?.imageData) {
      outputContext.putImageData(slice.imageData, 0, 0);
    }
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

function createDefaultSegment(index = 0, context = {}) {
  const axis = MPR_AXES.includes(context.axis) ? context.axis : 'axial';
  const sliceIndex = Math.max(0, Math.floor(Number(context.sliceIndex) || 0));
  return {
    id: `segment-${Date.now()}-${index}`,
    annotationId: '',
    name: index === 0 ? 'Segment A' : `Segment ${String.fromCharCode(65 + (index % 26))}`,
    color: SEGMENT_COLORS[index % SEGMENT_COLORS.length] || DEFAULT_SEGMENT_COLOR,
    axis,
    minSlice: sliceIndex,
    maxSlice: sliceIndex,
    imageWidth: Math.max(1, Number(context.imageWidth) || 1),
    imageHeight: Math.max(1, Number(context.imageHeight) || 1),
    volumeDimensions: Array.isArray(context.volumeDimensions)
      ? context.volumeDimensions.slice(0, 3).map((value) => Math.max(1, Math.floor(Number(value) || 1)))
      : null,
    visible: true,
    areas: [],
  };
}

function annotationToSegmentationHelperSegment(annotation) {
  const vectorSegment = annotationToVectorSegment(annotation);
  if (!vectorSegment) return null;
  return {
    id: vectorSegment.id,
    annotationId: vectorSegment.annotationId,
    name: vectorSegment.label,
    color: vectorSegment.color,
    opacity: vectorSegment.opacity,
    visible: vectorSegment.visible,
    axis: vectorSegment.axis,
    minSlice: vectorSegment.minSlice,
    maxSlice: vectorSegment.maxSlice,
    imageWidth: vectorSegment.imageWidth,
    imageHeight: vectorSegment.imageHeight,
    version: vectorSegment.version,
    volumeDimensions: vectorSegment.volumeDimensions,
    areas: vectorSegment.areas,
    annotation,
  };
}

function segmentHasVolumeAreas(segment) {
  return (Array.isArray(segment?.areas) ? segment.areas : []).some((area) => (
    (Array.isArray(area?.volumeRuns) && area.volumeRuns.length > 0)
    || (Array.isArray(area?.volume_runs) && area.volume_runs.length > 0)
  ));
}

function segmentHasPlanarAreaOnSlice(segment, axis, sliceIndex) {
  const safeAxis = MPR_AXES.includes(axis) ? axis : 'axial';
  const selectedSlice = Math.round(Number(sliceIndex) || 0);
  const segmentAxis = MPR_AXES.includes(segment?.axis) ? segment.axis : 'axial';
  return (Array.isArray(segment?.areas) ? segment.areas : []).some((area) => {
    if (String(area?.mode || area?.areaMode || area?.dimensionality || '2d').toLowerCase() === '3d') {
      return false;
    }
    const areaAxis = MPR_AXES.includes(area?.axis) ? area.axis : segmentAxis;
    if (areaAxis !== safeAxis) return false;
    const areaSlice = Number(area?.sliceIndex ?? area?.slice_index);
    if (Number.isFinite(areaSlice)) return Math.round(areaSlice) === selectedSlice;
    return (
      selectedSlice >= Math.min(Number(segment?.minSlice) || 0, Number(segment?.maxSlice) || 0)
      && selectedSlice <= Math.max(Number(segment?.minSlice) || 0, Number(segment?.maxSlice) || 0)
    );
  });
}

function segmentVisibleOnSlice(segment, axis, sliceIndex) {
  return segment?.visible !== false && (
    segmentHasVolumeAreas(segment)
    || segmentHasPlanarAreaOnSlice(segment, axis, sliceIndex)
  );
}

function getMprAxisImageDimensions(axis, dimensions = {}, volumeCache = null) {
  const cacheDimensions = isServerVolumeDescriptor(volumeCache) ? volumeCache.dimensions : null;
  const resolvedDimensions = {
    axial: Number(cacheDimensions?.axial) || Number(volumeCache?.depth) || Number(dimensions.axial),
    coronal: Number(cacheDimensions?.coronal) || Number(volumeCache?.height) || Number(dimensions.coronal),
    sagittal: Number(cacheDimensions?.sagittal) || Number(volumeCache?.width) || Number(dimensions.sagittal),
  };
  if (axis === 'coronal') {
    return {
      width: Math.max(1, resolvedDimensions.sagittal || 1),
      height: Math.max(1, resolvedDimensions.axial || 1),
    };
  }
  if (axis === 'sagittal') {
    return {
      width: Math.max(1, resolvedDimensions.coronal || 1),
      height: Math.max(1, resolvedDimensions.axial || 1),
    };
  }
  return {
    width: Math.max(1, resolvedDimensions.sagittal || 1),
    height: Math.max(1, resolvedDimensions.coronal || 1),
  };
}

function renderSegmentationShape(shape, options = {}) {
  if (!shape) return null;
  const strokeColor = options.color || shape.color || DEFAULT_SEGMENT_COLOR;
  const fillColor = options.fillColor || strokeColor;
  const fillOpacity = Number.isFinite(Number(options.fillOpacity)) ? Number(options.fillOpacity) : 0.22;
  const strokeWidth = options.strokeWidth || 2.5;
  const points = Array.isArray(shape.points) ? shape.points : [];
  const className = [
    'segmentation-helper-shape',
    shape.operation === 'subtract' ? 'subtract' : 'add',
    options.preview ? 'preview' : '',
  ].filter(Boolean).join(' ');

  if (shape.tool === 'brush' || shape.tool === 'eraser' || shape.tool === 'scissors') {
    if (points.length === 0) return null;
    const path = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ');
    return (
      <path
        d={path}
        className={className}
        fill="none"
        stroke={strokeColor}
        strokeWidth={Math.max(2, Number(shape.brushSize) || 12)}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={shape.tool === 'eraser' || shape.operation === 'subtract' ? 0.72 : 0.88}
      />
    );
  }

  if (shape.tool === 'polygon' && points.length > 0) {
    const pointString = points.map((point) => `${point.x},${point.y}`).join(' ');
    return (
      <polyline
        points={pointString}
        className={className}
        fill={shape.closed && points.length > 2 ? fillColor : 'none'}
        fillOpacity={shape.closed && points.length > 2 ? fillOpacity : 0}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
      />
    );
  }

  if (shape.tool === 'circle' && shape.center) {
    const radius = Number(shape.radius) || (
      shape.edge ? Math.hypot(shape.edge.x - shape.center.x, shape.edge.y - shape.center.y) : 0
    );
    if (radius <= 0) return null;
    return (
      <circle
        cx={shape.center.x}
        cy={shape.center.y}
        r={radius}
        className={className}
        fill={fillColor}
        fillOpacity={fillOpacity}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
      />
    );
  }

  if (shape.tool === 'rectangle' && shape.start && shape.end) {
    const x = Math.min(shape.start.x, shape.end.x);
    const y = Math.min(shape.start.y, shape.end.y);
    const width = Math.abs(shape.end.x - shape.start.x);
    const height = Math.abs(shape.end.y - shape.start.y);
    if (width <= 0 || height <= 0) return null;
    return (
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        className={className}
        fill={fillColor}
        fillOpacity={fillOpacity}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
      />
    );
  }

  if (shape.tool === 'ml-helper' && Array.isArray(shape.bbox) && shape.bbox.length >= 4) {
    const [x1, y1, x2, y2] = shape.bbox.map(Number);
    const width = x2 - x1;
    const height = y2 - y1;
    if (![x1, y1, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    return (
      <rect
        x={x1}
        y={y1}
        width={width}
        height={height}
        className={className}
        fill={fillColor}
        fillOpacity={fillOpacity}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
      />
    );
  }

  if (shape.tool === 'connected') {
    if (!shape.maskPath) return null;
    return (
      <path
        d={shape.maskPath}
        className={className}
        fill={fillColor}
        fillOpacity={fillOpacity}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
      />
    );
  }

  if (['threshold', 'level-trace'].includes(shape.tool) && shape.seed) {
    const radius = Number(shape.radius) || Number(shape.sensitivity) || 20;
    return (
      <ellipse
        cx={shape.seed.x}
        cy={shape.seed.y}
        rx={radius * 1.25}
        ry={radius}
        className={className}
        fill={fillColor}
        fillOpacity={fillOpacity}
        stroke={strokeColor}
        strokeWidth={strokeWidth}
        strokeDasharray={shape.tool === 'level-trace' ? '7 5' : undefined}
      />
    );
  }

  return null;
}

function renderCompositedSegmentationSegment(segment, options = {}) {
  if (!segment || segment.visible === false) return null;
  const color = options.color || segment.color || DEFAULT_SEGMENT_COLOR;
  const fillOpacity = Number.isFinite(Number(options.fillOpacity))
    ? Number(options.fillOpacity)
    : (Number.isFinite(Number(segment.opacity)) ? Number(segment.opacity) : 0.24);
  const selectedSlice = Number(options.sliceIndex);
  const targetWidth = Math.max(1, Number(options.imageWidth) || Number(segment.imageWidth) || 1);
  const targetHeight = Math.max(1, Number(options.imageHeight) || Number(segment.imageHeight) || 1);
  const hasVolume = segmentHasVolumeAreas(segment);
  const planarVisible = !options.axis || segmentHasPlanarAreaOnSlice(
    segment,
    options.axis,
    selectedSlice,
  );
  const mask = planarVisible && !hasVolume
    ? buildPt3SegmentMask(segment, {
      axis: options.axis,
      sliceIndex: selectedSlice,
      imageWidth: targetWidth,
      imageHeight: targetHeight,
    })
    : null;
  const path = mask ? pt3SegmentMaskToSvgPath(mask) : '';
  const volumeMask = hasVolume && options.axis && options.volumeDimensions
    ? buildPt3SegmentVolumeSliceMask(segment, {
      axis: options.axis,
      sliceIndex: options.sliceIndex,
      dimensions: options.volumeDimensions,
    })
    : null;
  const volumePath = volumeMask ? pt3SegmentMaskToSvgPath(volumeMask) : '';
  if (!path && !volumePath) return null;
  return (
    <>
      {path && (
        <g transform={`scale(${targetWidth / mask.imageWidth} ${targetHeight / mask.imageHeight})`}>
          <path
            d={path}
            className="segmentation-helper-shape add composited-segment-mask"
            fill={color}
            fillOpacity={fillOpacity}
            stroke="none"
            data-mask-rectangles={mask.rectangles.length}
            data-mask-truncated={mask.stats.truncated ? 'true' : 'false'}
            data-mask-approximated={mask.stats.approximated ? 'true' : 'false'}
          />
        </g>
      )}
      {volumePath && (
        <g transform={`scale(${targetWidth / volumeMask.imageWidth} ${targetHeight / volumeMask.imageHeight})`}>
          <path
            d={volumePath}
            className="segmentation-helper-shape add composited-segment-mask volumetric-segment-mask"
            fill={color}
            fillOpacity={fillOpacity}
            stroke="none"
            data-volume-mask-rectangles={volumeMask.rectangles.length}
            data-volume-voxel-count={volumeMask.stats.voxelCount}
          />
        </g>
      )}
    </>
  );
}

function getSegmentationShapePoints(shape) {
  if (!shape) return [];
  if (!SEGMENTATION_POINT_MARKER_TOOLS.has(shape.tool)) return [];
  if (Array.isArray(shape.points)) return shape.points;
  if (shape.start && shape.end) return [shape.start, shape.end];
  if (shape.center && shape.edge) return [shape.center, shape.edge];
  return [];
}

function getSegmentationMlMethods(groupId) {
  return (SEGMENTATION_ML_METHOD_GROUPS.find((group) => group.id === groupId) || SEGMENTATION_ML_METHOD_GROUPS[0]).methods;
}

function getDefaultSegmentationMlMethod(groupId) {
  return getSegmentationMlMethods(groupId)[0]?.id || 'segmentation.opencv.placeholder';
}

function getDefaultSegmentationMlParameters(methodId) {
  return { ...(DEFAULT_SEGMENTATION_ML_PARAMETERS[methodId] || {}) };
}

function getPlaneFocusRange(position, dimension) {
  const normalizedDimension = Math.max(1, Number(dimension) || 1);
  const half = normalizedDimension / 10;
  const minimum = -0.5;
  const maximum = normalizedDimension - 0.5;
  let lo = position - half;
  let hi = position + half;
  if (lo < minimum) { hi += minimum - lo; lo = minimum; }
  if (hi > maximum) { lo -= (hi - maximum); hi = maximum; }
  return [Math.max(minimum, lo), Math.min(maximum, hi)];
}

function getMprFallbackModelZoom(zoom, fullscreen = false) {
  const normalizedZoom = Math.max(0.01, Number(zoom) || 1);
  return fullscreen
    ? Math.min(3.4, Math.max(3, normalizedZoom * 1.8))
    : normalizedZoom;
}

function getMprFallbackModelCoordinate(value, dimension, extent) {
  const normalizedDimension = Math.max(1, Number(dimension) || 1);
  return ((((Number(value) || 0) + 0.5) / normalizedDimension) - 0.5) * extent;
}

function projectMprPointToOverlay(vx, vy, vz, dims, rotation, zoom, width, height, mirrorScale) {
  const rx = (rotation.x * Math.PI) / 180;
  const ry = (rotation.y * Math.PI) / 180;
  const cosRx = Math.cos(rx), sinRx = Math.sin(rx);
  const cosRy = Math.cos(ry), sinRy = Math.sin(ry);
  let px = getMprFallbackModelCoordinate(vx, dims.sagittal, MPR_FALLBACK_MODEL_SIZE.width) * (mirrorScale?.x ?? 1);
  let py = getMprFallbackModelCoordinate(vy, dims.coronal, MPR_FALLBACK_MODEL_SIZE.height) * (mirrorScale?.y ?? 1);
  let pz = getMprFallbackModelCoordinate(vz, dims.axial, MPR_FALLBACK_MODEL_SIZE.depth) * (mirrorScale?.z ?? 1);
  let t = px * cosRy + pz * sinRy; pz = -px * sinRy + pz * cosRy; px = t;
  t = py * cosRx + pz * sinRx; pz = -py * sinRx + pz * cosRx; py = t;
  px *= zoom;
  py *= zoom;
  pz *= zoom;
  const perspectiveScale = MPR_FALLBACK_PERSPECTIVE_PX
    / Math.max(1, MPR_FALLBACK_PERSPECTIVE_PX - pz);
  return {
    x: (width / 2) + (px * perspectiveScale),
    y: (height / 2) + (py * perspectiveScale),
    z: pz,
  };
}

function useMprVolumeCache(imageStack, dimensions) {
  const cacheKey = useMemo(() => getMprVolumeCacheKey(imageStack, dimensions), [dimensions, imageStack]);
  const [cacheState, setCacheState] = useState({ key: '', status: 'idle', cache: null, progress: { loadedSlices: 0, totalSlices: 0 } });

  useEffect(() => {
    if (!cacheKey || !hasMprVolumeSource(imageStack)) {
      setCacheState({ key: '', status: 'idle', cache: null, progress: { loadedSlices: 0, totalSlices: 0 } });
      return undefined;
    }
    if (isServerVolumeDescriptor(imageStack)) {
      const cached = mprVolumeCacheStore.get(cacheKey);
      const cache = cached || createServerMprVolumeCache(cacheKey, imageStack, dimensions);
      if (!cached) rememberMprVolumeCache(cacheKey, cache);
      setCacheState({ key: cacheKey, status: 'ready', cache, progress: { loadedSlices: 0, totalSlices: 0 } });
      return undefined;
    }
    if (typeof window !== 'undefined' && /jsdom/i.test(window.navigator?.userAgent || '')) {
      setCacheState({ key: cacheKey, status: 'idle', cache: null, progress: { loadedSlices: 0, totalSlices: imageStack.length } });
      return undefined;
    }

    const cached = mprVolumeCacheStore.get(cacheKey);
    if (cached) {
      setCacheState({ key: cacheKey, status: 'ready', cache: cached, progress: { loadedSlices: imageStack.length, totalSlices: imageStack.length } });
      return undefined;
    }

    let cancelled = false;
    setCacheState({ key: cacheKey, status: 'loading', cache: null, progress: { loadedSlices: 0, totalSlices: imageStack.length } });
    buildMprVolumeCache(cacheKey, imageStack, dimensions, (progress) => {
      if (!cancelled) setCacheState((previous) => ({ ...previous, status: 'loading', progress }));
    }).then((cache) => {
      if (cancelled) return;
      if (!cache) {
        setCacheState({ key: cacheKey, status: 'error', cache: null, progress: { loadedSlices: 0, totalSlices: imageStack.length } });
        return;
      }
      rememberMprVolumeCache(cacheKey, cache);
      setCacheState({ key: cacheKey, status: 'ready', cache, progress: { loadedSlices: imageStack.length, totalSlices: imageStack.length } });
    });

    return () => {
      cancelled = true;
    };
  }, [cacheKey, dimensions, imageStack]);

  return cacheState;
}

function useMprVolumeCaches(imageStacks, dimensions) {
  const cacheKeys = useMemo(
    () => (Array.isArray(imageStacks) ? imageStacks : []).map((stack) => getMprVolumeCacheKey(stack.stack || stack, dimensions)),
    [dimensions, imageStacks],
  );
  const [cacheStates, setCacheStates] = useState([]);

  useEffect(() => {
    const stacks = Array.isArray(imageStacks) ? imageStacks : [];
    const sources = stacks.map((stack) => stack.stack || stack);
    if (stacks.length === 0) {
      setCacheStates([]);
      return undefined;
    }
    if (typeof window !== 'undefined' && /jsdom/i.test(window.navigator?.userAgent || '')) {
      setCacheStates(cacheKeys.map((key, index) => {
        const source = sources[index];
        if (!key || !isServerVolumeDescriptor(source)) return { key, status: 'idle', cache: null };
        const cached = mprVolumeCacheStore.get(key);
        const cache = cached || createServerMprVolumeCache(key, source, dimensions);
        if (!cached) rememberMprVolumeCache(key, cache);
        return { key, status: 'ready', cache };
      }));
      return undefined;
    }

    let cancelled = false;
    setCacheStates(cacheKeys.map((key) => ({ key, status: key ? 'loading' : 'idle', cache: key ? (mprVolumeCacheStore.get(key) || null) : null })));
    Promise.all(sources.map(async (stack, index) => {
      const key = cacheKeys[index];
      if (!key || !hasMprVolumeSource(stack)) return { key: '', status: 'idle', cache: null };
      const cached = mprVolumeCacheStore.get(key);
      if (cached) return { key, status: 'ready', cache: cached };
      if (isServerVolumeDescriptor(stack)) {
        const cache = createServerMprVolumeCache(key, stack, dimensions);
        rememberMprVolumeCache(key, cache);
        return { key, status: 'ready', cache };
      }
      const cache = await buildMprVolumeCache(key, stack, dimensions);
      if (!cache) return { key, status: 'error', cache: null };
      rememberMprVolumeCache(key, cache);
      return { key, status: 'ready', cache };
    })).then((states) => {
      if (!cancelled) setCacheStates(states);
    });

    return () => {
      cancelled = true;
    };
  }, [cacheKeys, dimensions, imageStacks]);

  return cacheStates;
}

function applyDisplayWindowToCanvasContext(ctx, width, height, displayWindow, displayDomain) {
  const domain = getNormalizedDisplayDomain(displayDomain);
  const windowRange = normalizeDisplayWindow(displayWindow, domain);
  const imageData = ctx.getImageData(0, 0, width, height);
  const { data } = imageData;
  const domainSpan = Math.max(Number.EPSILON, domain.max - domain.min);
  const displaySpan = Math.max(Number.EPSILON, windowRange.max - windowRange.min);

  for (let i = 0; i < data.length; i += 4) {
    const intensity = (data[i] * 0.2126) + (data[i + 1] * 0.7152) + (data[i + 2] * 0.0722);
    const sourceValue = domain.min + ((intensity / 255) * domainSpan);
    const clipped = Math.min(windowRange.max, Math.max(windowRange.min, sourceValue));
    const normalized = Math.round(((clipped - windowRange.min) / displaySpan) * 255);
    data[i] = normalized;
    data[i + 1] = normalized;
    data[i + 2] = normalized;
  }
  ctx.putImageData(imageData, 0, 0);
}

function MprWindowedImage({
  src,
  alt,
  className,
  draggable = false,
  onDragStart,
  style,
  displayWindow,
  displayDomain,
}) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !src) return undefined;
    if (typeof window !== 'undefined' && /jsdom/i.test(window.navigator?.userAgent || '')) {
      return undefined;
    }
    const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!ctx) return undefined;

    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      const width = image.naturalWidth || image.width || 1;
      const height = image.naturalHeight || image.height || 1;
      canvas.width = width;
      canvas.height = height;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);
      applyDisplayWindowToCanvasContext(ctx, width, height, displayWindow, displayDomain);
    };
    image.onerror = () => {
      if (cancelled) return;
      canvas.width = 1;
      canvas.height = 1;
      ctx.clearRect(0, 0, 1, 1);
    };
    image.src = src;
    return () => {
      cancelled = true;
    };
  }, [displayDomain, displayWindow, src]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      role="img"
      aria-label={alt}
      draggable={draggable}
      onDragStart={onDragStart}
      style={style}
      data-display-window={`${formatWindowValue(displayWindow?.min ?? 0)}-${formatWindowValue(displayWindow?.max ?? 255)}`}
      data-display-domain={`${formatWindowValue(displayDomain?.min ?? 0)}-${formatWindowValue(displayDomain?.max ?? 255)}`}
    />
  );
}

function DisplayWindowControl({ displayWindow, displayDomain, onChange }) {
  const domain = getNormalizedDisplayDomain(displayDomain);
  const normalizedWindow = normalizeDisplayWindow(displayWindow, domain);
  const [draftValues, setDraftValues] = useState({
    min: formatWindowValue(normalizedWindow.min),
    max: formatWindowValue(normalizedWindow.max),
  });

  useEffect(() => {
    setDraftValues({
      min: formatWindowValue(normalizedWindow.min),
      max: formatWindowValue(normalizedWindow.max),
    });
  }, [normalizedWindow.max, normalizedWindow.min]);

  const updateWindow = useCallback((patch) => {
    onChange((previous) => normalizeDisplayWindow({ ...previous, ...patch }, domain, normalizedWindow));
  }, [domain, normalizedWindow, onChange]);

  const handleTextChange = (edge, value) => {
    setDraftValues((previous) => ({ ...previous, [edge]: value }));
    if (value.trim() === '') return;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    updateWindow({ [edge]: numeric });
  };

  const handleTextBlur = () => {
    setDraftValues({
      min: formatWindowValue(normalizedWindow.min),
      max: formatWindowValue(normalizedWindow.max),
    });
  };

  const minPercent = getWindowPercent(normalizedWindow.min, domain);
  const maxPercent = getWindowPercent(normalizedWindow.max, domain);

  return (
    <fieldset
      className="pt3-window-control"
      style={{
        '--window-min-percent': `${minPercent}%`,
        '--window-max-percent': `${maxPercent}%`,
      }}
    >
      <legend>Display window</legend>
      <div className="pt3-window-range-control" data-testid="display-window-slider">
        <div className="pt3-window-range-track" aria-hidden="true">
          <span className="pt3-window-range-fill" />
        </div>
        <input
          type="range"
          aria-label="Display window minimum handle"
          min={domain.min}
          max={domain.max}
          step={domain.step}
          value={normalizedWindow.min}
          onChange={(event) => updateWindow({ min: Number(event.target.value) })}
        />
        <input
          type="range"
          aria-label="Display window maximum handle"
          min={domain.min}
          max={domain.max}
          step={domain.step}
          value={normalizedWindow.max}
          onChange={(event) => updateWindow({ max: Number(event.target.value) })}
        />
      </div>
      <div className="pt3-window-number-row">
        <label htmlFor="mpr-window-min">
          Min
          <input
            id="mpr-window-min"
            type="number"
            aria-label="Display window minimum"
            min={domain.min}
            max={domain.max}
            step={domain.step}
            value={draftValues.min}
            onChange={(event) => handleTextChange('min', event.target.value)}
            onBlur={handleTextBlur}
          />
        </label>
        <label htmlFor="mpr-window-max">
          Max
          <input
            id="mpr-window-max"
            type="number"
            aria-label="Display window maximum"
            min={domain.min}
            max={domain.max}
            step={domain.step}
            value={draftValues.max}
            onChange={(event) => handleTextChange('max', event.target.value)}
            onBlur={handleTextBlur}
          />
        </label>
      </div>
      <span className="pt3-window-domain">
        {formatWindowValue(domain.min)}-{formatWindowValue(domain.max)} {domain.label}
      </span>
    </fieldset>
  );
}

const MprSliceCanvas = React.forwardRef(function MprSliceCanvas({
  axis,
  volumeCache,
  overlayCaches = [],
  volumeCacheStatus,
  slicePosition,
  dimensions,
  displayWindow,
  displayDomain,
  overlayOpacityMultiplier = 1,
  className = '',
  ...canvasProps
}, externalRef) {
  const canvasRef = useRef(null);
  const serverSliceRequestVersionRef = useRef(0);
  const [serverSliceRevision, setServerSliceRevision] = useState(0);
  const [serverSliceStatus, setServerSliceStatus] = useState('idle');
  const relevantSlicePosition = slicePosition[axis];
  const relevantAxisLength = Number(dimensions?.[axis]) || 1;
  const fallbackDimensions = getMprAxisImageDimensions(axis, dimensions, volumeCache);
  const serverVolumeCaches = [volumeCache, ...overlayCaches].filter(isServerVolumeDescriptor);
  const serverVolumeCachesRef = useRef(serverVolumeCaches);
  serverVolumeCachesRef.current = serverVolumeCaches;
  const serverVolumeCacheKey = serverVolumeCaches.map((cache) => cache.key).join('|');
  const setCanvasRef = useCallback((node) => {
    canvasRef.current = node;
    if (typeof externalRef === 'function') externalRef(node);
    else if (externalRef) externalRef.current = node;
  }, [externalRef]);

  useEffect(() => {
    const serverCaches = serverVolumeCachesRef.current;
    if (serverCaches.length === 0) {
      setServerSliceStatus('idle');
      return undefined;
    }
    if (typeof window !== 'undefined' && /jsdom/i.test(window.navigator?.userAgent || '')) {
      return undefined;
    }

    const requestVersion = serverSliceRequestVersionRef.current + 1;
    serverSliceRequestVersionRef.current = requestVersion;
    let stale = false;
    const hasServerBase = isServerVolumeDescriptor(volumeCache);
    setServerSliceStatus(hasServerBase ? 'loading' : 'ready');
    const sourceMax = Math.max(0, relevantAxisLength - 1);
    const sourceGroups = serverCaches.map((cache) => {
      const cacheIndex = getScaledIndex(
        relevantSlicePosition,
        sourceMax,
        Number(cache.dimensions?.[axis]) || 1,
      );
      return {
        prefetchGeneration: beginServerMprSlicePrefetch(cache, axis, cacheIndex),
        sources: getServerVolumePrefetchSources(cache, axis, cacheIndex),
      };
    });
    const currentRequests = sourceGroups.map((group, index) => (
      requestServerMprSliceCanvas(serverCaches[index], group.sources[0], {
        priority: true,
        currentGeneration: group.prefetchGeneration,
      })
    ));
    Promise.allSettled(currentRequests).then(() => {
      if (stale || serverSliceRequestVersionRef.current !== requestVersion) return;
      sourceGroups.forEach((group, cacheIndex) => {
        group.sources.slice(1).forEach((source) => {
          requestServerMprSliceCanvas(serverCaches[cacheIndex], source, {
            prefetchGeneration: group.prefetchGeneration,
          }).catch(() => {});
        });
      });
    });

    currentRequests.forEach((request, index) => {
      request.then(() => {
        if (stale || serverSliceRequestVersionRef.current !== requestVersion) return;
        if (hasServerBase && index === 0) setServerSliceStatus('ready');
        setServerSliceRevision((previous) => previous + 1);
      }).catch(() => {
        if (stale || serverSliceRequestVersionRef.current !== requestVersion) return;
        if (hasServerBase && index === 0) setServerSliceStatus('error');
      });
    });

    return () => {
      stale = true;
      serverCaches.forEach((cache) => invalidateServerMprSliceGeneration(cache, axis));
    };
  }, [axis, relevantAxisLength, relevantSlicePosition, serverVolumeCacheKey, volumeCache]);

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
    if (!sliceCanvas) {
      canvas.width = fallbackDimensions.width;
      canvas.height = fallbackDimensions.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return undefined;
    }
    canvas.width = sliceCanvas.width || 1;
    canvas.height = sliceCanvas.height || 1;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(sliceCanvas, 0, 0, canvas.width, canvas.height);
    if (shouldApplyDisplayWindowToVolumeCache(volumeCache)) {
      applyDisplayWindowToCanvasContext(ctx, canvas.width, canvas.height, displayWindow, displayDomain);
    }
    overlayCaches.forEach((overlayCache) => {
      const overlaySliceCanvas = getCachedMprSliceCanvas(axis, slicePosition, dimensions, overlayCache);
      if (!overlaySliceCanvas) return;
      drawMprOverlaySlice(
        ctx,
        overlaySliceCanvas,
        overlayCache,
        canvas.width,
        canvas.height,
        overlayOpacityMultiplier,
      );
    });
    return undefined;
  }, [axis, dimensions, displayDomain, displayWindow, fallbackDimensions.height, fallbackDimensions.width, overlayCaches, overlayOpacityMultiplier, relevantSlicePosition, serverSliceRevision, slicePosition, volumeCache]);

  return (
    <canvas
      {...canvasProps}
      ref={setCanvasRef}
      className={`mpr-slice-canvas ${className}`.trim()}
      width={fallbackDimensions.width}
      height={fallbackDimensions.height}
      role={canvasProps.role || (canvasProps['aria-label'] ? 'img' : undefined)}
      aria-hidden={canvasProps['aria-label'] ? undefined : true}
      data-mpr-axis={axis}
      data-mpr-slice-index={relevantSlicePosition}
      data-volume-cache-status={volumeCacheStatus}
      data-slice-load-status={serverSliceStatus}
      data-volume-color-mode={volumeCache?.colorMode || ''}
      data-overlay-color-modes={overlayCaches.map((cache) => cache?.colorMode || '').filter(Boolean).join(',')}
      data-display-window={`${formatWindowValue(displayWindow?.min ?? 0)}-${formatWindowValue(displayWindow?.max ?? 255)}`}
      data-display-domain={`${formatWindowValue(displayDomain?.min ?? 0)}-${formatWindowValue(displayDomain?.max ?? 255)}`}
    />
  );
});

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


function getAnnotationTooltip(annotation) {
  if (!annotation || typeof annotation !== 'object') return '';
  const details = [];
  const type = getAnnotationListType(annotation);
  const value = getAnnotationListValue(annotation);
  if (type) details.push(type);
  if (value) details.push(value);
  const createdAt = formatAnnotationTimestamp(getAnnotationCreatedAt(annotation));
  if (createdAt) details.push(`Created: ${createdAt}`);
  details.push(`By: ${getAnnotationCreator(annotation)}`);
  return details.join(' • ');
}

function getAnnotationCreator(annotation) {
  const creator = String(annotation?.created_by || annotation?.createdBy || '').trim();
  if (creator) return creator;
  const updatedBy = String(annotation?.updated_by || annotation?.updatedBy || '').trim();
  return updatedBy || 'Unknown user';
}

function getAnnotationCreatedAt(annotation) {
  return annotation?.created_at || annotation?.createdAt || annotation?.updated_at || annotation?.updatedAt || '';
}

function formatAnnotationTimestamp(value) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

export function buildInspectionShareParams(state = {}) {
  const params = new URLSearchParams();
  if (state.selectedBatchId) params.set('batch', String(state.selectedBatchId));
  if (state.selectedPartId) params.set('part', String(state.selectedPartId));
  if (state.selectedImageRef) params.set('image', String(state.selectedImageRef));
  if (state.reviewFilter && state.reviewFilter !== 'all') params.set('review', String(state.reviewFilter));
  if (state.activeMetadataTab && state.activeMetadataTab !== 'nsipro') params.set('metadataTab', String(state.activeMetadataTab));
  if (state.activeMprPane && state.activeMprPane !== 'axial') params.set('mprPane', String(state.activeMprPane));
  if (Array.isArray(state.activeOverlayIds) && state.activeOverlayIds.length > 0) {
    params.set('overlays', state.activeOverlayIds.map((entry) => String(entry)).filter(Boolean).join(','));
  }
  return params;
}

function InspectionWorkbenchPanel({
  projectId,
  projectType,
  hierarchy,
  launchFilters,
  sessionMprSlicePosition,
  onMprSlicePositionChange,
  onInspectionShareStateChange,
}) {
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
  const sessionMprSlicePositionRef = useRef({ projectId, slicePosition: sessionMprSlicePosition });
  if (sessionMprSlicePositionRef.current.projectId !== projectId) {
    sessionMprSlicePositionRef.current = { projectId, slicePosition: sessionMprSlicePosition };
  }
  const slicePositionRef = useRef(slicePosition);
  const [viewportTransform, setViewportTransform] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [activeMprPane, setActiveMprPane] = useState('axial');
  const [lastActiveMprAxis, setLastActiveMprAxis] = useState('axial');
  const [mprRotation, setMprRotation] = useState({ x: -22, y: 32 });
  const [mprReconstructionMode, setMprReconstructionMode] = useState(MPR_RECONSTRUCTION_MODES.orientation);
  const [mprFullscreenOpen, setMprFullscreenOpen] = useState(false);
  const [mprFullscreenAnnotationListVisible, setMprFullscreenAnnotationListVisible] = useState(true);
  const [mprFullscreenReconstructionSettingsVisible, setMprFullscreenReconstructionSettingsVisible] = useState(true);
  const [rayMarchSettings, setRayMarchSettings] = useState(() => ({ ...DEFAULT_RAY_MARCH_SETTINGS }));
  const [splatViewSettings, setSplatViewSettings] = useState(() => ({ ...DEFAULT_SPLAT_VIEW_SETTINGS }));
  const [splatConfigModalOpen, setSplatConfigModalOpen] = useState(false);
  const [splatParameterOverridesByPart, setSplatParameterOverridesByPart] = useState({});
  const [mprProjectionMirror, setMprProjectionMirror] = useState(DEFAULT_MPR_PROJECTION_MIRROR);
  const [activeWorkbenchModal, setActiveWorkbenchModal] = useState(null);
  const [activeMetadataTab, setActiveMetadataTab] = useState('nsipro');
  const [segmentationHelperOpen, setSegmentationHelperOpen] = useState(false);
  const [segmentationHelperAxis, setSegmentationHelperAxis] = useState('axial');
  const [segmentationHelperView, setSegmentationHelperView] = useState('z');
  const [segmentationSegments, setSegmentationSegments] = useState([]);
  const [selectedSegmentationSegmentId, setSelectedSegmentationSegmentId] = useState('');
  const [editingSegmentationSegmentId, setEditingSegmentationSegmentId] = useState('');
  const [segmentationTool, setSegmentationTool] = useState('brush');
  const [segmentationToolModes, setSegmentationToolModes] = useState(DEFAULT_SEGMENTATION_TOOL_MODES);
  const [segmentationOperation, setSegmentationOperation] = useState('add');
  const [segmentationBrushSize, setSegmentationBrushSize] = useState(18);
  const [segmentationSensitivity, setSegmentationSensitivity] = useState(28);
  const [segmentationPendingSelection, setSegmentationPendingSelection] = useState(null);
  const [segmentationDraftShape, setSegmentationDraftShape] = useState(null);
  const [segmentationPointerPreview, setSegmentationPointerPreview] = useState(null);
  const [segmentationMlGroup, setSegmentationMlGroup] = useState('opencv');
  const [segmentationMlMethod, setSegmentationMlMethod] = useState('segmentation.opencv.placeholder');
  const [segmentationMlParameters, setSegmentationMlParameters] = useState(() => getDefaultSegmentationMlParameters('segmentation.opencv.placeholder'));
  const [segmentationMlStatus, setSegmentationMlStatus] = useState('');
  const [segmentationMlLoading, setSegmentationMlLoading] = useState(false);
  const [segmentationVolumeStatus, setSegmentationVolumeStatus] = useState('');
  const [segmentationVolumeLoading, setSegmentationVolumeLoading] = useState(false);
  const [displayWindow, setDisplayWindow] = useState({ min: 0, max: 255 });
  const displayWindowContextRef = useRef(null);
  const [activeOverlayIds, setActiveOverlayIds] = useState([]);
  const [cursorProbe, setCursorProbe] = useState({ x: 50, y: 50 });
  const [segmentationRun, setSegmentationRun] = useState(null);
  const [measurementRun, setMeasurementRun] = useState(null);
  const [workspaceStateLoaded, setWorkspaceStateLoaded] = useState(false);
  const [workspaceHydration, setWorkspaceHydration] = useState({});
  const [enabledModalities, setEnabledModalities] = useState([]);
  const [selectedViewName, setSelectedViewName] = useState('');
  const [hiddenViewNames, setHiddenViewNames] = useState([]);
  const [renderCategories, setRenderCategories] = useState(['source', 'annotation', 'crop']);
  const [tileColumnCount, setTileColumnCount] = useState(3);
  const [imageEnabled, setImageEnabled] = useState(true);
  const [measurementEntries, setMeasurementEntries] = useState([]);
  const [inspectorViewport, setInspectorViewport] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [annotations, setAnnotationsState] = useState([]);
  const annotationsMutationRevisionRef = useRef(0);
  const setAnnotations = useCallback((updater) => {
    annotationsMutationRevisionRef.current += 1;
    setAnnotationsState(updater);
  }, []);
  const [annotationsLoading, setAnnotationsLoading] = useState(false);
  const [annotationDraft, setAnnotationDraft] = useState({
    defect_class: '',
    modality: '',
    comment: '',
    disposition: 'open',
    measurement_name: '',
    measurement_value: '',
    bbox: { x: '', y: '', width: '', height: '' },
  });
  const [annotationToolMode, setAnnotationToolMode] = useState('');
  const [otherAnnotationModalVisible, setOtherAnnotationModalVisible] = useState(false);
  const [annotationEditModalVisible, setAnnotationEditModalVisible] = useState(false);
  const [annotationEditDraft, setAnnotationEditDraft] = useState(null);
  const customDefectTypeDraft = '';
  const [tileAnnotationDraft, setTileAnnotationDraft] = useState(null);
  const [tileAnnotationPreview, setTileAnnotationPreview] = useState(null);
  const [tileGeometryDragPreview, setTileGeometryDragPreview] = useState(null);
  const [inspectorHotkeys, setInspectorHotkeys] = useState(DEFAULT_INSPECTOR_HOTKEYS);
  const [projectConfiguration, setProjectConfiguration] = useState(null);
  const [projectMetadata, setProjectMetadata] = useState({});
  const [inspectionColumnWidths, setInspectionColumnWidths] = useState(DEFAULT_INSPECTION_COLUMN_WIDTHS);
  const [shortcutHelpVisible, setShortcutHelpVisible] = useState(false);
  const [panelLayout, setPanelLayout] = useState(DEFAULT_PANEL_LAYOUT);
  const [normalizationTriageField, setNormalizationTriageField] = useState('');
  const [selectedImageRef, setSelectedImageRef] = useState('');
  const [projectImageLookup, setProjectImageLookup] = useState({});
  const volumeMetadataProbeCacheRef = useRef(new Map());
  const volumeRenderSummaryCacheRef = useRef(new Map());
  const [volumeRenderSummariesByImageId, setVolumeRenderSummariesByImageId] = useState({});
  const [volumeMetadataProbeState, setVolumeMetadataProbeState] = useState({ pending: false, warning: '' });
  const [deletingOverlayId, setDeletingOverlayId] = useState('');
  const [fullscreenImageModal, setFullscreenImageModal] = useState(null);
  const [fullscreenMeasureActive, setFullscreenMeasureActive] = useState(false);
  const [fullscreenBoxActive, setFullscreenBoxActive] = useState(false);
  const [fullscreenCropActive, setFullscreenCropActive] = useState(false);
  const [fullscreenMeasurements, setFullscreenMeasurements] = useState([]);
  const [fullscreenCalibrationPromptVisible, setFullscreenCalibrationPromptVisible] = useState(false);
  const [tileCalibrationPromptImageId, setTileCalibrationPromptImageId] = useState(null);
  const [fullscreenEditingEndpoint, setFullscreenEditingEndpoint] = useState(null);
  const [fullscreenEditingBoxCorner, setFullscreenEditingBoxCorner] = useState(null);
  const [fullscreenGeometryDragPreview, setFullscreenGeometryDragPreview] = useState(null);
  const [fullscreenImageZoom, setFullscreenImageZoom] = useState({ scale: 1, originX: 50, originY: 50, panX: 0, panY: 0 });
  const [fullscreenImagePanning, setFullscreenImagePanning] = useState(false);
  const [annotationsVisible, setAnnotationsVisible] = useState(true);
  const [annotationTransparencyPercent, setAnnotationTransparencyPercent] = useState(
    DEFAULT_ANNOTATION_TRANSPARENCY_PERCENT,
  );
  const annotationOpacityMultiplier = getAnnotationOpacityMultiplier(annotationTransparencyPercent);
  const [sessionCalibrationByImageId, setSessionCalibrationByImageId] = useState({});
  const configuredDefectTypes = useMemo(() => (Array.isArray(projectConfiguration?.defect_types) ? projectConfiguration.defect_types
    .map((entry) => String(entry?.name || '').trim())
    .filter(Boolean) : []), [projectConfiguration]);
  const visibleAnnotations = useMemo(
    () => annotations.filter((annotation) => annotation?.hidden !== true),
    [annotations],
  );
  const vectorSegmentAnnotations = useMemo(
    () => annotations.map(annotationToVectorSegment).filter(Boolean),
    [annotations],
  );
  const storedMeasurementLinesByImageId = useMemo(() => getMeasurementLinesByImageId(visibleAnnotations), [visibleAnnotations]);
  const storedBoxAnnotationsByImageId = useMemo(() => getBoxAnnotationsByImageId(visibleAnnotations), [visibleAnnotations]);
  const storedMprMeasurementLinesBySlice = useMemo(() => getMprMeasurementLinesBySlice(visibleAnnotations), [visibleAnnotations]);
  const storedMprBoxAnnotationsBySlice = useMemo(() => getMprBoxAnnotationsBySlice(visibleAnnotations), [visibleAnnotations]);
  const storedMprCubeAnnotations = useMemo(() => getMprCubeAnnotations(visibleAnnotations), [visibleAnnotations]);
  const annotationLayerVisible = annotationsVisible
    && (projectType === 'PT3' || renderCategories.includes('annotation'));
  const measurementLinesByImageId = annotationLayerVisible ? storedMeasurementLinesByImageId : {};
  const boxAnnotationsByImageId = annotationLayerVisible ? storedBoxAnnotationsByImageId : {};
  const mprMeasurementLinesBySlice = annotationLayerVisible ? storedMprMeasurementLinesBySlice : {};
  const mprBoxAnnotationsBySlice = annotationLayerVisible ? storedMprBoxAnnotationsBySlice : {};
  const mprCubeAnnotations = annotationLayerVisible ? storedMprCubeAnnotations : [];
  const selectedSegmentationSegment = useMemo(() => (
    segmentationSegments.find((segment) => segment.id === selectedSegmentationSegmentId) || segmentationSegments[0] || null
  ), [selectedSegmentationSegmentId, segmentationSegments]);
  const [pendingMeasurePoint, setPendingMeasurePoint] = useState(null);
  const [pendingBoxPoint, setPendingBoxPoint] = useState(null);
  const [mprAnnotationDraft, setMprAnnotationDraft] = useState(null);
  const [mprAnnotationPreview, setMprAnnotationPreview] = useState(null);
  const [mprGeometryDragPreview, setMprGeometryDragPreview] = useState(null);
  const [fullscreenAnnotationPreview, setFullscreenAnnotationPreview] = useState(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState(null);
  const [fullscreenBoundsEditAnnotationId, setFullscreenBoundsEditAnnotationId] = useState(null);
  const [croppingAnnotationId, setCroppingAnnotationId] = useState(null);
  const [viewportWidth, setViewportWidth] = useState(() => (
    typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth
  ));
  const [workbenchWidth, setWorkbenchWidth] = useState(0);
  const [manualFilterNotice, setManualFilterNotice] = useState('');
  const workbenchDetailsRef = useRef(null);
  const inspectionResizeSaveTimerRef = useRef(null);
  const mprDragRef = useRef(null);
  const suppressNextMprSceneClickRef = useRef(false);
  const mprFullscreenCloseRef = useRef(null);
  const mprFullscreenSceneRef = useRef(null);
  const mprFullscreenOpenerRef = useRef(null);
  const segmentationHelperDialogRef = useRef(null);
  const segmentationHelperCloseRef = useRef(null);
  const segmentationHelperOpenerRef = useRef(null);
  const tileAnnotationDraftRef = useRef(null);
  const tileAnnotationGeometryDragRef = useRef(null);
  const tileGeometryDragPreviewRef = useRef(null);
  const mprAnnotationDraftRef = useRef(null);
  const mprAnnotationGeometryDragRef = useRef(null);
  const mprGeometryDragPreviewRef = useRef(null);
  const segmentationDraftRef = useRef(null);
  const segmentationPointerSessionRef = useRef(null);
  const segmentationVolumeRequestRef = useRef({ generation: 0, controller: null });
  const segmentationMutationQueuesRef = useRef(new Map());
  const segmentationServerIdsRef = useRef(new Map());
  const segmentationLocalDraftsRef = useRef(new Map());
  const activeSegmentationPersistenceScopeRef = useRef('');
  const activeAnnotationViewRef = useRef({ scope: '', generation: 0 });
  const segmentationMlCacheRef = useRef(new Map());
  const pendingMeasurePointRef = useRef(null);
  const pendingBoxPointRef = useRef(null);
  const fullscreenImageRef = useRef(null);
  const fullscreenPanDragRef = useRef(null);
  const fullscreenAnnotationDragRef = useRef(null);
  const fullscreenGeometryDragPreviewRef = useRef(null);
  const suppressNextTileClickRef = useRef(false);
  const mprOverlayCanvasRef = useRef(null);
  const [mprFallbackOverlaySize, setMprFallbackOverlaySize] = useState({ width: 0, height: 0 });
  const appliedLaunchFiltersSignatureRef = useRef('');

  useEffect(() => {
    if (MPR_AXES.includes(activeMprPane)) setLastActiveMprAxis(activeMprPane);
  }, [activeMprPane]);

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

  useEffect(() => {
    const persistedSegments = annotations.map(annotationToSegmentationHelperSegment).filter(Boolean);
    const scopePrefix = `${projectId}:${selectedPartId}:`;
    const localDrafts = [...segmentationLocalDraftsRef.current.entries()]
      .filter(([key]) => key.startsWith(scopePrefix))
      .map(([, draft]) => draft);
    const mergedSegments = [...persistedSegments];
    localDrafts.forEach((draft) => {
      const localId = String(draft.localId || draft.segment?.id || '');
      const serverId = String(draft.serverId || '');
      const existingIndex = mergedSegments.findIndex((segment) => (
        String(segment.id) === localId
        || (serverId && String(segment.id) === serverId)
      ));
      if (existingIndex >= 0) mergedSegments[existingIndex] = draft.segment;
      else mergedSegments.push(draft.segment);
    });
    setSegmentationSegments(mergedSegments);
    if (mergedSegments.length === 0) {
      setSelectedSegmentationSegmentId('');
      setEditingSegmentationSegmentId('');
      return;
    }
    setSelectedSegmentationSegmentId((current) => (
      current && mergedSegments.some((segment) => String(segment.id) === String(current))
        ? current
        : mergedSegments[0].id
    ));
  }, [annotations, projectId, selectedPartId]);
  const leftRegion = inspectionHierarchy.regions[inspectionHierarchy.leftColumn];
  const rightRegion = inspectionHierarchy.regions[inspectionHierarchy.rightColumn];
  const inspectorRegion = inspectionHierarchy.regions.inspector;
  const availableLayoutWidth = workbenchWidth > 0 ? workbenchWidth : viewportWidth;
  const inspectionLayoutCollapsed = projectType !== 'PT3'
    && availableLayoutWidth <= inspectionHierarchy.layout.collapseBreakpointPx;
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
    const controller = new AbortController();
    let active = true;

    const loadWorkbenchData = async () => {
      try {
        setLoading(true);
        setError(null);

        const [batchResp, partResp, workspaceResp, configResp, metadataResp, imagePageData] = await Promise.all([
          fetch(`/api/projects/${projectId}/batches`, { signal: controller.signal }),
          fetch(`/api/projects/${projectId}/parts`, { signal: controller.signal }),
          fetch(`/api/projects/${projectId}/workspace-state`, { signal: controller.signal }),
          fetch(`/api/projects/${projectId}/configuration`, { signal: controller.signal }),
          fetch(`/api/projects/${projectId}/metadata-dict`, { signal: controller.signal }),
          fetchProjectImagePages(projectId, { includeDeleted: true, signal: controller.signal }),
        ]);
        if (!active) return;
        if (!batchResp.ok) {
          throw new Error(`Failed to load batches (${batchResp.status})`);
        }
        if (!partResp.ok) {
          throw new Error(`Failed to load parts (${partResp.status})`);
        }

        const [batchData, partData, workspaceData, configData, metadataData] = await Promise.all([
          batchResp.json(),
          partResp.json(),
          workspaceResp.ok ? workspaceResp.json() : Promise.resolve({ state: {} }),
          configResp.ok ? configResp.json() : Promise.resolve({}),
          metadataResp.ok ? metadataResp.json() : Promise.resolve({}),
        ]);
        if (!active) return;
        const imageData = Array.isArray(imagePageData?.items) ? imagePageData.items : [];
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
        if (!active || err?.name === 'AbortError') return;
        setError(err.message || 'Failed to load inspection workbench data');
      } finally {
        if (active) {
          setWorkspaceStateLoaded(true);
          setLoading(false);
        }
      }
    };

    loadWorkbenchData();
    return () => {
      active = false;
      controller.abort();
    };
  }, [projectId]);

  useEffect(() => {
    if (!launchFilters || typeof launchFilters !== 'object') return;
    if (parts.length === 0 && batches.length === 0) return;

    const launchFiltersSignature = JSON.stringify({
      selected_batch_id: launchFilters.selected_batch_id || '',
      review_filter: launchFilters.review_filter || '',
      selected_part_id: launchFilters.selected_part_id || '',
      selected_image_ref: launchFilters.selected_image_ref || '',
      active_metadata_tab: launchFilters.active_metadata_tab || '',
      active_mpr_pane: launchFilters.active_mpr_pane || '',
      active_overlay_ids: Array.isArray(launchFilters.active_overlay_ids) ? launchFilters.active_overlay_ids : [],
      source: launchFilters.source || '',
      at: launchFilters.at || '',
    });
    if (appliedLaunchFiltersSignatureRef.current === launchFiltersSignature) return;

    const requestedBatchId = String(launchFilters.selected_batch_id || '').trim();
    if (requestedBatchId && batches.some((batch) => String(batch.id) === requestedBatchId)) {
      setSelectedBatchId(requestedBatchId);
    }
    const requestedReviewFilter = String(launchFilters.review_filter || '').trim();
    if (['all', 'pass', 'reject_pending', 'reject_confirmed', 'none', 'manual'].includes(requestedReviewFilter)) {
      setReviewFilter(requestedReviewFilter);
    }
    const requestedPartId = String(launchFilters.selected_part_id || '').trim();
    if (requestedPartId && parts.some((part) => String(part.id) === requestedPartId)) {
      setSelectedPartId(requestedPartId);
    }
    const targetPartId = requestedPartId || selectedPartId;
    const requestedImageRef = String(launchFilters.selected_image_ref || '').trim();
    if (requestedImageRef) {
      const targetPart = parts.find((part) => String(part.id) === targetPartId);
      const validImageRefs = getPartImageRefs(targetPart).map((entry) => String(entry.imageRef));
      if (validImageRefs.includes(requestedImageRef)) setSelectedImageRef(requestedImageRef);
    }
    const requestedMetadataTab = String(launchFilters.active_metadata_tab || '').trim();
    if (requestedMetadataTab) setActiveMetadataTab(requestedMetadataTab);
    const requestedMprPane = String(launchFilters.active_mpr_pane || '').trim();
    if (projectType === 'PT3' && ['axial', 'coronal', 'sagittal', 'volume'].includes(requestedMprPane)) {
      setActiveMprPane(requestedMprPane);
    }
    if (projectType === 'PT3' && Array.isArray(launchFilters.active_overlay_ids)) {
      const targetPart = parts.find((part) => String(part.id) === targetPartId);
      const stableOverlayIds = new Set(getOverlayLayers(targetPart).map((overlay) => String(overlay.id)));
      const nextOverlayIds = launchFilters.active_overlay_ids.map((entry) => String(entry)).filter((entry) => stableOverlayIds.has(entry));
      if (nextOverlayIds.length > 0) setActiveOverlayIds(nextOverlayIds);
    }
    if (launchFilters.review_filter === 'manual') {
      const batchName = String(launchFilters.source_batch_name || '').trim();
      setManualFilterNotice(
        batchName
          ? `Manual filter applied from Batches tab for ${batchName}.`
          : 'Manual filter applied from Batches tab.',
      );
    }
    appliedLaunchFiltersSignatureRef.current = launchFiltersSignature;
  }, [batches, launchFilters, parts, projectType, selectedPartId]);

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

  useEffect(() => {
    const candidates = getVolumeMetadataProbeCandidates(selectedPart, projectImageLookup);
    if (candidates.length === 0) {
      setVolumeMetadataProbeState((previous) => (
        previous.pending || previous.warning ? { pending: false, warning: '' } : previous
      ));
      return undefined;
    }

    const unresolved = candidates.filter((candidate) => !candidate.imageId);
    const probeableById = new Map();
    candidates.forEach((candidate) => {
      if (candidate.imageId && !probeableById.has(candidate.imageId)) {
        probeableById.set(candidate.imageId, candidate);
      }
    });
    const probeable = Array.from(probeableById.values());
    if (probeable.length === 0) {
      const labels = unresolved.map((candidate) => candidate.filename || 'unnamed volume').join(', ');
      setVolumeMetadataProbeState({
        pending: false,
        warning: `Unable to inspect volume metadata because the image record is unavailable: ${labels}`,
      });
      return undefined;
    }

    let cancelled = false;
    setVolumeMetadataProbeState({ pending: true, warning: '' });
    const probes = probeable.map((candidate) => {
      const cacheKey = `${String(projectId)}:${candidate.imageId}`;
      let probe = volumeMetadataProbeCacheRef.current.get(cacheKey);
      if (!probe) {
        probe = fetch(`/api/images/${encodeURIComponent(candidate.imageId)}/volume-metadata`)
          .then(async (response) => {
            if (!response.ok) throw new Error(`metadata request failed (${response.status})`);
            return normalizeProbedVolumeMetadata(await response.json());
          });
        volumeMetadataProbeCacheRef.current.set(cacheKey, probe);
        probe.catch(() => {
          if (volumeMetadataProbeCacheRef.current.get(cacheKey) === probe) {
            volumeMetadataProbeCacheRef.current.delete(cacheKey);
          }
        });
      }
      return probe.then((metadata) => ({ candidate, metadata }));
    });

    Promise.allSettled(probes).then((results) => {
      if (cancelled) return;
      const successful = results
        .filter((result) => result.status === 'fulfilled')
        .map((result) => result.value);
      if (successful.length > 0) {
        setProjectImageLookup((previous) => {
          const next = { ...previous };
          successful.forEach(({ candidate, metadata }) => {
            const existing = previous[candidate.imageId] || previous[candidate.filename] || {};
            const filename = String(existing.filename || candidate.filename || '');
            const updated = {
              ...existing,
              id: candidate.imageId,
              filename,
              ...metadata,
              metadata: {
                ...(existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}),
                ...metadata,
              },
            };
            next[candidate.imageId] = updated;
            if (filename) next[filename] = updated;
          });
          return next;
        });
      }
      const failedLabels = results
        .map((result, index) => (result.status === 'rejected'
          ? (probeable[index]?.filename || probeable[index]?.imageId || 'volume')
          : null))
        .filter(Boolean);
      const unresolvedLabels = unresolved.map((candidate) => candidate.filename || 'unnamed volume');
      const warningLabels = [...failedLabels, ...unresolvedLabels];
      setVolumeMetadataProbeState({
        pending: false,
        warning: warningLabels.length > 0
          ? `Unable to inspect volume metadata for ${warningLabels.join(', ')}. The volume was not rendered as a regular image.`
          : '',
      });
    });

    return () => {
      cancelled = true;
    };
  }, [projectId, projectImageLookup, selectedPart]);

  const activePartMutationScope = `${projectId}:${selectedPart?.id || ''}`;
  activeSegmentationPersistenceScopeRef.current = activePartMutationScope;
  if (activeAnnotationViewRef.current.scope !== activePartMutationScope) {
    activeAnnotationViewRef.current = {
      scope: activePartMutationScope,
      generation: activeAnnotationViewRef.current.generation + 1,
    };
  }
  const activePartMutationGeneration = activeAnnotationViewRef.current.generation;
  const isActivePartMutation = (scope, generation) => (
    activeSegmentationPersistenceScopeRef.current === scope
    && activeAnnotationViewRef.current.generation === generation
  );

  useEffect(() => {
    const drag = tileAnnotationGeometryDragRef.current;
    if (drag) safeReleasePointerCapture(drag.captureTarget, drag.pointerId);
    tileAnnotationGeometryDragRef.current = null;
    tileGeometryDragPreviewRef.current = null;
    setTileGeometryDragPreview(null);
  }, [projectId, selectedPart?.id]);

  const mprDimensions = useMemo(() => getMprDimensions(selectedPart, projectImageLookup), [projectImageLookup, selectedPart]);
  const displayValueDomain = useMemo(
    () => getPartDisplayValueDomain(selectedPart, projectImageLookup),
    [projectImageLookup, selectedPart],
  );
  const splatParameters = useMemo(
    () => getSplatParametersForPart(selectedPart, displayValueDomain, splatParameterOverridesByPart),
    [displayValueDomain, selectedPart, splatParameterOverridesByPart],
  );
  const mprAxisMirrorScale = useMemo(
    () => getMprAxisMirrorScale(mprProjectionMirror),
    [mprProjectionMirror],
  );
  const fallbackMprModelZoom = getMprFallbackModelZoom(viewportTransform.zoom, mprFullscreenOpen);

  useEffect(() => {
    const canvas = mprOverlayCanvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return undefined;
    const updateSize = () => {
      const bounds = parent.getBoundingClientRect?.();
      const width = Math.max(0, Math.round(parent.clientWidth || bounds?.width || 0));
      const height = Math.max(0, Math.round(parent.clientHeight || bounds?.height || 0));
      setMprFallbackOverlaySize((previous) => (
        previous.width === width && previous.height === height
          ? previous
          : { width, height }
      ));
    };
    updateSize();
    const ResizeObserverConstructor = window.ResizeObserver;
    const observer = typeof ResizeObserverConstructor === 'function'
      ? new ResizeObserverConstructor(updateSize)
      : null;
    observer?.observe(parent);
    window.addEventListener('resize', updateSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, [mprFullscreenOpen, mprReconstructionMode]);

  useEffect(() => {
    const canvas = mprOverlayCanvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    canvas.width = mprFallbackOverlaySize.width || parent.clientWidth;
    canvas.height = mprFallbackOverlaySize.height || parent.clientHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (activeMprPane !== 'volume' || PT3_RENDERER_RECONSTRUCTION_MODES.includes(mprReconstructionMode)) return;
    const dims = {
      sagittal: Math.max(1, mprDimensions.sagittal || 1),
      coronal: Math.max(1, mprDimensions.coronal || 1),
      axial: Math.max(1, mprDimensions.axial || 1),
    };
    const sx = slicePosition.sagittal;
    const sy = slicePosition.coronal;
    const sz = slicePosition.axial;
    const bounds = {
      x0: -0.5,
      x1: dims.sagittal - 0.5,
      y0: -0.5,
      y1: dims.coronal - 0.5,
      z0: -0.5,
      z1: dims.axial - 0.5,
    };
    const full = {
      axial: [[bounds.x0, bounds.y0, sz], [bounds.x1, bounds.y0, sz], [bounds.x1, bounds.y1, sz], [bounds.x0, bounds.y1, sz]],
      sagittal: [[sx, bounds.y0, bounds.z0], [sx, bounds.y1, bounds.z0], [sx, bounds.y1, bounds.z1], [sx, bounds.y0, bounds.z1]],
      coronal: [[bounds.x0, sy, bounds.z0], [bounds.x1, sy, bounds.z0], [bounds.x1, sy, bounds.z1], [bounds.x0, sy, bounds.z1]],
    };
    const [axX0, axX1] = getPlaneFocusRange(sx, dims.sagittal);
    const [axY0, axY1] = getPlaneFocusRange(sy, dims.coronal);
    const [sgY0, sgY1] = getPlaneFocusRange(sy, dims.coronal);
    const [sgZ0, sgZ1] = getPlaneFocusRange(sz, dims.axial);
    const [coX0, coX1] = getPlaneFocusRange(sx, dims.sagittal);
    const [coZ0, coZ1] = getPlaneFocusRange(sz, dims.axial);
    const focus = {
      axial: [[axX0, axY0, sz], [axX1, axY0, sz], [axX1, axY1, sz], [axX0, axY1, sz]],
      sagittal: [[sx, sgY0, sgZ0], [sx, sgY1, sgZ0], [sx, sgY1, sgZ1], [sx, sgY0, sgZ1]],
      coronal: [[coX0, sy, coZ0], [coX1, sy, coZ0], [coX1, sy, coZ1], [coX0, sy, coZ1]],
    };
    const drawOrder = MPR_AXES;
    drawOrder.forEach((axis) => {
      const color = MPR_AXIS_CONFIG[axis].color;
      const line = full[axis].map(([x, y, z]) => projectMprPointToOverlay(x, y, z, dims, mprRotation, fallbackMprModelZoom, canvas.width, canvas.height, mprAxisMirrorScale));
      ctx.beginPath();
      ctx.moveTo(line[0].x, line[0].y);
      line.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
      ctx.closePath();
      ctx.globalAlpha = 0.45;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.setLineDash([]);
      const active = activeMprPane === axis ? axis : null;
      if (active) {
        const quad = focus[axis].map(([x, y, z]) => projectMprPointToOverlay(x, y, z, dims, mprRotation, fallbackMprModelZoom, canvas.width, canvas.height, mprAxisMirrorScale));
        ctx.beginPath();
        ctx.moveTo(quad[0].x, quad[0].y);
        quad.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
        ctx.closePath();
        ctx.globalAlpha = 0.18;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 2;
        ctx.strokeStyle = color;
        ctx.stroke();
      }
    });
    if (annotationLayerVisible && vectorSegmentAnnotations.length > 0) {
      const vectorFaces = buildPt3VectorAnnotationFaces(vectorSegmentAnnotations, {
        dimensions: [dims.sagittal, dims.coronal, dims.axial],
      }).faces.map((face) => {
        let depthTotal = 0;
        let pointCount = 0;
        forEachPt3VectorFaceVoxelPolygon(face, (polygon) => {
          polygon.forEach(([x, y, z]) => {
            const point = projectMprPointToOverlay(x, y, z, dims, mprRotation, fallbackMprModelZoom, canvas.width, canvas.height, mprAxisMirrorScale);
            if (!Number.isFinite(point.z)) return;
            depthTotal += point.z;
            pointCount += 1;
          });
        });
        return {
          face,
          depth: depthTotal / Math.max(1, pointCount),
          pointCount,
        };
      }).filter((entry) => entry.pointCount > 0).sort((left, right) => left.depth - right.depth);
      vectorFaces.forEach(({ face }) => {
        ctx.beginPath();
        let polygonCount = 0;
        forEachPt3VectorFaceVoxelPolygon(face, (polygon) => {
          const points = polygon.map(([x, y, z]) => (
            projectMprPointToOverlay(x, y, z, dims, mprRotation, fallbackMprModelZoom, canvas.width, canvas.height, mprAxisMirrorScale)
          ));
          if (points.length < 3 || !points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) return;
          ctx.moveTo(points[0].x, points[0].y);
          points.slice(1).forEach((point) => ctx.lineTo(point.x, point.y));
          ctx.closePath();
          polygonCount += 1;
        });
        if (polygonCount === 0) return;
        ctx.globalAlpha = (face.surface === 'side' ? Math.min(0.3, face.opacity) : Math.min(0.48, face.opacity + 0.12))
          * annotationOpacityMultiplier;
        ctx.fillStyle = face.color;
        ctx.fill();
        ctx.globalAlpha = 0.88 * annotationOpacityMultiplier;
        ctx.lineWidth = face.surface === 'side' ? 1 : 1.5;
        ctx.strokeStyle = face.color;
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    }
  }, [activeMprPane, annotationLayerVisible, annotationOpacityMultiplier, fallbackMprModelZoom, mprAxisMirrorScale, mprDimensions, mprFallbackOverlaySize, mprFullscreenOpen, mprReconstructionMode, mprRotation, slicePosition, vectorSegmentAnnotations]);

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
    return getPartImageRefs(selectedPart).filter((entry) => isInspectionImageRefLoaded(entry, projectImageLookup));
  }, [projectImageLookup, selectedPart]);
  const visibleSelectedPartImageRefs = useMemo(() => {
    const hidden = new Set(hiddenViewNames.map((name) => String(name).toLowerCase()));
    const enabled = new Set(enabledModalities.map((name) => String(name).toLowerCase()));
    const categoryFiltered = selectedPartImageRefs.filter((entry) => {
      const category = entry.cropChild ? 'crop' : (entry.overlay ? 'overlay' : 'source');
      if (!(projectType === 'PT3' && category === 'overlay') && !renderCategories.includes(category)) return false;
      if (entry.hidden === true) return false;
      if (entry.overlay && !annotationsVisible) return false;
      if (hidden.has(String(entry.viewName || '').toLowerCase())) return false;
      const modality = String(entry.modality || '').toLowerCase();
      const modalityVisible = entry.cropChild || !modality || modality === 'analyze-overlay' || modality === 'overlay' || enabled.has(modality);
      if (!modalityVisible) return false;
      if (entry.overlay && (entry.overlayBaseImageId || entry.overlayBaseFilename)) return true;
      return true;
    });
    if (projectType !== 'PT3' && !renderCategories.includes('overlay')) return categoryFiltered;
    const overlayBaseIdentities = new Set();
    categoryFiltered.forEach((entry) => {
      if (!entry.overlay) return;
      [entry.overlayBaseImageId, entry.overlayBaseFilename]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .forEach((value) => overlayBaseIdentities.add(value));
    });
    if (overlayBaseIdentities.size === 0) return categoryFiltered;
    return categoryFiltered.filter((entry) => {
      if (entry.overlay) return true;
      return ![entry.imageId, entry.imageRef, entry.filename]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .some((value) => overlayBaseIdentities.has(value));
    });
  }, [annotationsVisible, enabledModalities, hiddenViewNames, projectType, renderCategories, selectedPartImageRefs]);
  const inspectionAnnotationItems = useMemo(
    () => buildInspectionAnnotationItems(annotations, selectedPartImageRefs),
    [annotations, selectedPartImageRefs],
  );
  const tileColumnMax = Math.max(1, visibleSelectedPartImageRefs.length || selectedPartImageRefs.length || 1);
  const normalizedTileColumnCount = Math.round(clampRange(
    tileColumnCount,
    1,
    tileColumnMax,
    Math.min(3, tileColumnMax),
  ));
  const annotationSourceImageIdLookup = useMemo(
    () => getAnnotationSourceImageIdLookup(selectedPartImageRefs, projectImageLookup),
    [projectImageLookup, selectedPartImageRefs],
  );
  const getAnnotationSourceImageIdForImage = useCallback((imageId) => {
    const key = String(imageId || '');
    return annotationSourceImageIdLookup[key] || key;
  }, [annotationSourceImageIdLookup]);
  const fullscreenBackingImageId = String(
    fullscreenImageModal?.backingImageId || fullscreenImageModal?.imageId || '',
  );
  const fullscreenMprSliceKey = fullscreenImageModal?.sourceKind === 'mpr'
    ? String(fullscreenImageModal.sliceKey || getMprSliceKey(fullscreenImageModal.axis, fullscreenImageModal.sliceIndex))
    : '';
  const applySessionCalibration = useCallback((imageId, calibration) => {
    if (!imageId || !isValidCalibration(calibration)) return false;
    const key = String(imageId);
    setSessionCalibrationByImageId((prev) => ({ ...prev, [key]: calibration }));
    setProjectMetadata((prev) => ({
      ...(prev && typeof prev === 'object' ? prev : {}),
      calibration_default: prev?.calibration_default || calibration,
    }));
    return true;
  }, []);

  const handleFullscreenCalibrationChange = useCallback((calibration) => {
    if (!applySessionCalibration(fullscreenBackingImageId, calibration)) return;
    setFullscreenCalibrationPromptVisible(false);
    setFullscreenMeasureActive(true);
  }, [applySessionCalibration, fullscreenBackingImageId]);

  const handleTileCalibrationChange = useCallback((calibration) => {
    if (!applySessionCalibration(tileCalibrationPromptImageId, calibration)) return;
    setTileCalibrationPromptImageId(null);
  }, [applySessionCalibration, tileCalibrationPromptImageId]);

  const requireCalibrationForAnnotation = useCallback((imageId, { surface = 'tile', toolMode = annotationToolMode } = {}) => {
    if (toolMode === 'crop') return true;
    const annotationImageId = getAnnotationSourceImageIdForImage(imageId);
    if (getCalibrationForImage(annotationImageId)) return true;
    if (surface === 'fullscreen') {
      setFullscreenCalibrationPromptVisible(true);
      setFullscreenMeasureActive(false);
      setFullscreenBoxActive(false);
    } else {
      setTileCalibrationPromptImageId(annotationImageId ? String(annotationImageId) : null);
    }
    return false;
  }, [annotationToolMode, getAnnotationSourceImageIdForImage, getCalibrationForImage]);

  const selectedImageRecord = useMemo(() => {
    if (!selectedImageRef) return null;
    return projectImageLookup[selectedImageRef] || null;
  }, [projectImageLookup, selectedImageRef]);
  const volumeImageStack = useMemo(
    () => getVolumeSourceImages(selectedPart, projectImageLookup),
    [projectImageLookup, selectedPart],
  );
  const volumeOverlayStacks = useMemo(
    () => getVolumeOverlayStacks(selectedPart, projectImageLookup),
    [projectImageLookup, selectedPart],
  );
  const visibleVolumeOverlayStacks = useMemo(
    () => (annotationsVisible ? volumeOverlayStacks.filter((entry) => entry?.hidden !== true) : []),
    [annotationsVisible, volumeOverlayStacks],
  );
  const visibleSemantic3dVolumeOverlayStacks = useMemo(
    () => getSemantic3dVolumeOverlayStacks(visibleVolumeOverlayStacks),
    [visibleVolumeOverlayStacks],
  );
  const volumeRenderSummaryCandidates = useMemo(() => {
    if (mprReconstructionMode === MPR_RECONSTRUCTION_MODES.orientation) return [];
    const byImageId = new Map();
    visibleSemantic3dVolumeOverlayStacks.forEach((volume) => {
      if (
        !isServerVolumeDescriptor(volume)
        || !String(volume.filename || '').toLowerCase().endsWith('.npy')
      ) return;
      byImageId.set(String(volume.imageId), volume);
    });
    return Array.from(byImageId.values()).slice(0, 4);
  }, [mprReconstructionMode, visibleSemantic3dVolumeOverlayStacks]);
  useEffect(() => {
    if (volumeRenderSummaryCandidates.length === 0) {
      setVolumeRenderSummariesByImageId((previous) => (
        Object.keys(previous).length > 0 ? {} : previous
      ));
      return undefined;
    }
    let cancelled = false;
    mapWithConcurrency(volumeRenderSummaryCandidates, 2, async (volume) => {
      const imageId = String(volume.imageId);
      const cacheKey = `${String(projectId)}:${imageId}:${MPR_VOLUME_RENDER_SUMMARY_VERSION}`;
      let request = volumeRenderSummaryCacheRef.current.get(cacheKey);
      if (!request) {
        request = fetch(getVolumeRenderSummaryUrl(volume)).then(async (response) => {
          if (!response.ok) throw new Error(`render summary request failed (${response.status})`);
          return response.json();
        });
        volumeRenderSummaryCacheRef.current.set(cacheKey, request);
        request.catch(() => {
          if (volumeRenderSummaryCacheRef.current.get(cacheKey) === request) {
            volumeRenderSummaryCacheRef.current.delete(cacheKey);
          }
        });
      }
      try {
        return [imageId, await request];
      } catch (_error) {
        return [imageId, null];
      }
    }).then((entries) => {
      if (cancelled) return;
      setVolumeRenderSummariesByImageId(Object.fromEntries(
        entries.filter(([, summary]) => summary && typeof summary === 'object'),
      ));
    });
    return () => { cancelled = true; };
  }, [projectId, volumeRenderSummaryCandidates]);
  const volumeCacheState = useMprVolumeCache(volumeImageStack, mprDimensions);
  const segmentationHelperVolumeDimensions = useMemo(() => ([
    Math.max(1, Number(volumeCacheState.cache?.width) || Number(mprDimensions.sagittal) || 1),
    Math.max(1, Number(volumeCacheState.cache?.height) || Number(mprDimensions.coronal) || 1),
    Math.max(1, Number(volumeCacheState.cache?.depth) || Number(mprDimensions.axial) || 1),
  ]), [
    mprDimensions.axial,
    mprDimensions.coronal,
    mprDimensions.sagittal,
    volumeCacheState.cache?.depth,
    volumeCacheState.cache?.height,
    volumeCacheState.cache?.width,
  ]);
  const segmentationHelper3dVolumeMetadata = useMemo(() => ({
    ...getMechanicalVolumeMetadata(selectedPart),
    dimensions: segmentationHelperVolumeDimensions,
  }), [segmentationHelperVolumeDimensions, selectedPart]);
  const segmentationHelperCanonicalSlicePosition = useMemo(
    () => Object.fromEntries(MPR_AXES.map((axis) => [
      axis,
      getCanonicalSegmentationSliceIndex(
        axis,
        slicePosition[axis],
        mprDimensions,
        segmentationHelperVolumeDimensions,
      ),
    ])),
    [mprDimensions, segmentationHelperVolumeDimensions, slicePosition],
  );
  const segmentationHelperPending3dPreviewSegment = useMemo(() => {
    if (segmentationPendingSelection?.mode !== '3d') return null;
    const axis = MPR_AXES.includes(segmentationHelperAxis) ? segmentationHelperAxis : 'axial';
    const axisDimensions = getMprAxisImageDimensions(
      axis,
      mprDimensions,
      volumeCacheState.cache,
    );
    return {
      ...(selectedSegmentationSegment || {}),
      id: 'pending-volume-selection',
      visible: true,
      color: '#fde047',
      opacity: 0.34,
      imageWidth: selectedSegmentationSegment?.imageWidth || axisDimensions.width,
      imageHeight: selectedSegmentationSegment?.imageHeight || axisDimensions.height,
      volumeDimensions: segmentationHelperVolumeDimensions,
      areas: [{ ...segmentationPendingSelection, operation: 'add' }],
    };
  }, [
    mprDimensions,
    segmentationHelperAxis,
    segmentationHelperVolumeDimensions,
    segmentationPendingSelection,
    selectedSegmentationSegment,
    volumeCacheState.cache,
  ]);
  const segmentationHelper3dAnnotations = useMemo(() => {
    const selectedId = String(selectedSegmentationSegment?.id || '');
    const selectedFirst = selectedId
      ? [
        selectedSegmentationSegment,
        ...segmentationSegments.filter((segment) => String(segment?.id || '') !== selectedId),
      ]
      : segmentationSegments;
    return segmentationHelperPending3dPreviewSegment
      ? [segmentationHelperPending3dPreviewSegment, ...selectedFirst]
      : selectedFirst;
  }, [
    segmentationHelperPending3dPreviewSegment,
    segmentationSegments,
    selectedSegmentationSegment,
  ]);
  const segmentation3dSurfacePreviewTruncated = useMemo(() => {
    if (!segmentationHelperOpen || segmentationHelperView !== '3d') return false;
    return buildPt3VectorAnnotationFaces(segmentationHelper3dAnnotations, {
      dimensions: segmentationHelperVolumeDimensions,
    }).stats.volumeSurfaceTruncated === true;
  }, [
    segmentationHelper3dAnnotations,
    segmentationHelperOpen,
    segmentationHelperView,
    segmentationHelperVolumeDimensions,
  ]);
  const volumeOverlayCacheStates = useMprVolumeCaches(visibleVolumeOverlayStacks, mprDimensions);
  const activeVolumeOverlayCaches = useMemo(
    () => ((projectType === 'PT3' || renderCategories.includes('overlay'))
      ? volumeOverlayCacheStates.map((state) => state.cache).filter(Boolean)
      : []),
    [projectType, renderCategories, volumeOverlayCacheStates],
  );
  const hasVolumeImageSource = hasMprVolumeSource(volumeImageStack);
  const shellImageLayers = useMemo(
    () => getShellImageLayers(selectedPart, projectImageLookup),
    [projectImageLookup, selectedPart],
  );
  const volumePreviewLayers = useMemo(() => {
    const maxLayers = MPR_VOLUME_RENDERER_MAX_SLICES;
    if (isServerVolumeDescriptor(volumeImageStack)) {
      const axialCount = Math.max(1, Number(volumeImageStack.dimensions?.axial) || 1);
      return getVolumeRendererSliceIndices(
        axialCount,
        maxLayers,
      )
        .map((sliceIndex, index, entries) => ({
          ...volumeImageStack,
          id: `${volumeImageStack.imageId}:axial:${sliceIndex}`,
          sliceIndex,
          url: getServerVolumeSliceUrl(volumeImageStack, 'axial', sliceIndex),
          depth: getMprFallbackModelCoordinate(sliceIndex, axialCount, MPR_FALLBACK_MODEL_SIZE.depth),
          opacity: entries.length <= 1 ? 0.86 : 0.18 + (index / (entries.length - 1)) * 0.26,
        }));
    }
    if (!Array.isArray(volumeImageStack) || volumeImageStack.length === 0) return [];
    return getVolumeRendererSliceIndices(volumeImageStack.length, maxLayers)
      .map((sourceIndex) => ({ entry: volumeImageStack[sourceIndex], sourceIndex }))
      .map(({ entry, sourceIndex }, index, entries) => ({
        ...entry,
        depth: getMprFallbackModelCoordinate(
          Number.isFinite(Number(entry.sliceIndex)) ? Number(entry.sliceIndex) : sourceIndex,
          Math.max(1, Number(mprDimensions.axial) || volumeImageStack.length),
          MPR_FALLBACK_MODEL_SIZE.depth,
        ),
        opacity: entries.length <= 1 ? 0.86 : 0.18 + (index / (entries.length - 1)) * 0.26,
      }));
  }, [mprDimensions.axial, volumeImageStack]);
  const volumeRendererImageStack = volumePreviewLayers;
  const volumeRendererOverlayImageStacks = useMemo(
    () => getAlignedVolumeOverlayRendererStacks(
      visibleSemantic3dVolumeOverlayStacks,
      volumeRendererImageStack,
      mprDimensions,
      volumeRenderSummariesByImageId,
    ),
    [mprDimensions, visibleSemantic3dVolumeOverlayStacks, volumeRendererImageStack, volumeRenderSummariesByImageId],
  );
  const getMprAnnotationImage = useCallback((axis) => {
    if (isServerVolumeDescriptor(volumeImageStack)) {
      return volumeImageStack.imageId || selectedImageRef || null;
    }
    if (axis === 'axial' && Array.isArray(volumeImageStack) && volumeImageStack.length > 0) {
      const target = slicePosition.axial;
      const match = volumeImageStack.find((entry) => Number(entry.sliceIndex) === Number(target)) || volumeImageStack[Math.min(target, volumeImageStack.length - 1)] || volumeImageStack[0];
      return match?.id || match?.imageId || selectedImageRef || null;
    }
    return getMprVolumeSourceEntries(volumeImageStack)[0]?.id || getMprVolumeSourceEntries(volumeImageStack)[0]?.imageId || selectedImageRef || null;
  }, [selectedImageRef, slicePosition.axial, volumeImageStack]);

  const getMprAnnotationSliceContext = useCallback((axis, explicitSliceIndex = slicePosition[axis]) => {
    const safeAxis = MPR_AXES.includes(axis) ? axis : 'axial';
    const sliceIndex = Number(explicitSliceIndex ?? slicePosition[safeAxis] ?? 0) || 0;
    const slicePositionForCanvas = { ...slicePosition, [safeAxis]: sliceIndex };
    const cachedCanvas = getCachedMprSliceCanvas(safeAxis, slicePositionForCanvas, mprDimensions, volumeCacheState.cache);
    const fallbackDimensions = getMprAxisImageDimensions(safeAxis, mprDimensions, volumeCacheState.cache);
    return {
      axis: safeAxis,
      sliceIndex,
      sliceKey: getMprSliceKey(safeAxis, sliceIndex),
      imageId: getMprAnnotationImage(safeAxis),
      canvas: cachedCanvas,
      imageWidth: Number(cachedCanvas?.width) || fallbackDimensions.width,
      imageHeight: Number(cachedCanvas?.height) || fallbackDimensions.height,
    };
  }, [getMprAnnotationImage, mprDimensions, slicePosition, volumeCacheState.cache]);

  const openMprAnnotationTool = useCallback((axis, mode) => {
    const sliceContext = getMprAnnotationSliceContext(axis);
    const hasVolumeStack = hasMprVolumeSource(volumeImageStack);
    const fallbackImage = !hasVolumeStack
      ? getFallbackProjectionImage(sliceContext.axis, shellImageLayers)
      : null;
    const imageId = fallbackImage?.id || sliceContext.imageId;
    if (!imageId) return;
    const sliceValue = sliceContext.sliceIndex;
    const axisLabel = (MPR_AXIS_CONFIG[axis]?.sliceLabel || axis).toUpperCase();
    const label = `${MPR_AXIS_CONFIG[axis]?.label || axis.toUpperCase()} slice ${sliceValue}`;
    setFullscreenImageModal(!hasVolumeStack ? {
      sourceKind: 'image',
      imageId: String(imageId),
      label,
    } : {
      sourceKind: 'mpr',
      axis: sliceContext.axis,
      sliceIndex: sliceContext.sliceIndex,
      sliceKey: sliceContext.sliceKey,
      backingImageId: String(imageId),
      imageId: String(imageId),
      label,
    });
    setFullscreenMeasureActive(mode === 'measure');
    setFullscreenBoxActive(mode === 'box');
    setFullscreenCalibrationPromptVisible(false);
    setAnnotationDraft((prev) => ({ ...prev, comment: `${mode === 'measure' ? 'Measurement' : 'Box'} on ${axisLabel} ${sliceValue}` }));
  }, [getMprAnnotationSliceContext, shellImageLayers, volumeImageStack]);

  const canShowStackReconstruction = volumePreviewLayers.length > 0;
  const canShowShellReconstruction = shellImageLayers.length > 0;
  const canShowGaussianSplatPreview = Boolean(selectedPart);
  const effectiveMprReconstructionMode = (
    PT3_RENDERER_RECONSTRUCTION_MODES.includes(mprReconstructionMode) && canShowGaussianSplatPreview
  )
    ? mprReconstructionMode
    : (
      mprReconstructionMode === MPR_RECONSTRUCTION_MODES.stack && canShowStackReconstruction
    )
      ? MPR_RECONSTRUCTION_MODES.stack
      : MPR_RECONSTRUCTION_MODES.orientation;

  const activeRayMarchReconstructionStyle = RAY_MARCH_RECONSTRUCTION_IDS.has(
    rayMarchSettings?.reconstructionStyle,
  )
    ? rayMarchSettings.reconstructionStyle
    : DEFAULT_RAY_MARCH_SETTINGS.reconstructionStyle;
  const mprReconstructionSelectorValue = mprReconstructionMode === MPR_RECONSTRUCTION_MODES.volume3d
    ? `${RAY_MARCH_SELECTOR_PREFIX}${activeRayMarchReconstructionStyle}`
    : mprReconstructionMode;
  const effectiveMprReconstructionLabel = effectiveMprReconstructionMode === MPR_RECONSTRUCTION_MODES.volume3d
    ? `Ray marching — ${RAY_MARCH_RECONSTRUCTION_OPTIONS.find(
      ({ value }) => value === activeRayMarchReconstructionStyle,
    )?.label || 'Composite'}`
    : MPR_RECONSTRUCTION_LABELS[effectiveMprReconstructionMode];

  const clearMprVolumeDrag = useCallback((suppressSceneClick = false) => {
    const drag = mprDragRef.current;
    mprDragRef.current = null;
    suppressNextMprSceneClickRef.current = Boolean(suppressSceneClick && drag?.moved);
    safeReleasePointerCapture(drag?.captureTarget, drag?.pointerId);
  }, []);

  useEffect(() => {
    if (!mprFullscreenOpen) {
      clearMprVolumeDrag(false);
      return undefined;
    }
    mprFullscreenCloseRef.current?.focus();
    const handleWindowBlur = () => clearMprVolumeDrag(false);
    const handleKeyDown = (event) => {
      if (event.key === 'Tab') {
        const dialog = mprFullscreenSceneRef.current?.closest('[role="dialog"]');
        const focusable = Array.from(dialog?.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])
          .filter((element) => element.getAttribute('aria-hidden') !== 'true' && element.tabIndex >= 0);
        if (focusable.length === 0) return;
        event.preventDefault();
        const activeIndex = focusable.indexOf(document.activeElement);
        const nextIndex = event.shiftKey
          ? (activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1)
          : (activeIndex < 0 || activeIndex === focusable.length - 1 ? 0 : activeIndex + 1);
        focusable[nextIndex].focus();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        clearMprVolumeDrag(false);
        setMprFullscreenOpen(false);
        window.requestAnimationFrame(() => mprFullscreenOpenerRef.current?.focus());
      }
    };
    window.addEventListener('blur', handleWindowBlur);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [clearMprVolumeDrag, mprFullscreenOpen]);

  const tooltipValues = useMemo(() => {
    const domain = getNormalizedDisplayDomain(displayValueDomain);
    const activeWindow = normalizeDisplayWindow(displayWindow, domain);
    const axisSeed = slicePosition.axial + slicePosition.coronal + slicePosition.sagittal;
    const unitValue = Math.min(
      255,
      Math.max(0, Math.round(cursorProbe.x * 0.35 + cursorProbe.y * 0.65 + axisSeed)),
    );
    const sourceValue = domain.min + ((unitValue / 255) * (domain.max - domain.min));
    const windowRange = Math.max(Number.EPSILON, activeWindow.max - activeWindow.min);
    const base = Math.round(((Math.min(activeWindow.max, Math.max(activeWindow.min, sourceValue)) - activeWindow.min) / windowRange) * 255);
    const overlays = activeOverlayIds.map((overlayId, index) => {
      const value = Number((((base + (index + 1) * 17) / 255) * 100).toFixed(1));
      return { overlayId, value };
    });
    return { base, overlays };
  }, [activeOverlayIds, cursorProbe.x, cursorProbe.y, displayValueDomain, displayWindow, slicePosition]);

  useEffect(() => {
    if (selectedPart && selectedPart.id !== selectedPartId) {
      setSelectedPartId(selectedPart.id);
    }
  }, [selectedPart, selectedPartId]);

  useEffect(() => {
    if (selectedPartImageRefs.length === 0) return;
    if (tileColumnCount !== normalizedTileColumnCount) {
      setTileColumnCount(normalizedTileColumnCount);
    }
  }, [normalizedTileColumnCount, selectedPartImageRefs.length, tileColumnCount]);

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
    if (!selectedPart || projectType !== 'PT3') return;
    const savedMpr = workspaceHydration?.mpr || {};
    const savedSlice = sessionMprSlicePositionRef.current.slicePosition || savedMpr?.slice_position || {};
    const savedViewport = savedMpr?.viewport_transform || {};
    const savedProbe = savedMpr?.cursor_probe || {};
    const hydratedSlicePosition = {
      axial: clampRange(savedSlice.axial, 0, Math.max(0, mprDimensions.axial - 1), Math.floor((mprDimensions.axial - 1) / 2)),
      coronal: clampRange(savedSlice.coronal, 0, Math.max(0, mprDimensions.coronal - 1), Math.floor((mprDimensions.coronal - 1) / 2)),
      sagittal: clampRange(savedSlice.sagittal, 0, Math.max(0, mprDimensions.sagittal - 1), Math.floor((mprDimensions.sagittal - 1) / 2)),
    };
    sessionMprSlicePositionRef.current.slicePosition = hydratedSlicePosition;
    slicePositionRef.current = hydratedSlicePosition;
    setSlicePosition(hydratedSlicePosition);
    setViewportTransform({
      zoom: clampRange(savedViewport.zoom, 0.5, 4, 1),
      panX: clampRange(savedViewport.panX, -200, 200, 0),
      panY: clampRange(savedViewport.panY, -200, 200, 0),
    });
    setMprProjectionMirror(normalizeMprProjectionMirror(savedMpr.projection_mirror));
    const displayDomain = getNormalizedDisplayDomain(displayValueDomain);
    const displayDomainKey = `${displayDomain.min}:${displayDomain.max}:${displayDomain.step}`;
    const previousDisplayContext = displayWindowContextRef.current;
    const isNewDisplayContext = !previousDisplayContext
      || previousDisplayContext.projectId !== String(projectId);
    const shouldHydrateSavedWindow = workspaceStateLoaded
      && (isNewDisplayContext || previousDisplayContext.workspaceHydrated !== true);
    if (shouldHydrateSavedWindow) {
      const savedDisplayWindow = savedMpr.display_window || {};
      const fallbackContrast = clampRange(savedMpr.contrast_percent, 50, 150, 100);
      const fallbackRange = displayDomain.max - displayDomain.min;
      const legacyFallback = fallbackContrast === 100
        ? { min: displayDomain.min, max: displayDomain.max }
        : {
          min: displayDomain.min + (Math.max(0, 100 - fallbackContrast) / 100) * (fallbackRange / 2),
          max: displayDomain.min + Math.min(1, fallbackContrast / 100) * fallbackRange,
      };
      setDisplayWindow(normalizeDisplayWindow(savedDisplayWindow, displayDomain, legacyFallback));
    } else if (isNewDisplayContext) {
      setDisplayWindow({ min: displayDomain.min, max: displayDomain.max });
    } else if (previousDisplayContext.domainKey !== displayDomainKey) {
      setDisplayWindow((current) => remapDisplayWindow(
        current,
        previousDisplayContext.domain,
        displayDomain,
      ));
    }
    displayWindowContextRef.current = {
      projectId: String(projectId),
      partId: String(selectedPart.id),
      domainKey: displayDomainKey,
      domain: displayDomain,
      workspaceHydrated: workspaceStateLoaded,
    };
    const stableOverlayIds = new Set(getOverlayLayers(selectedPart).map((overlay) => String(overlay.id)));
    const savedOverlayIds = Array.isArray(savedMpr.active_overlay_ids)
      ? savedMpr.active_overlay_ids
        .map((entry) => String(entry))
        .filter((entry) => stableOverlayIds.has(entry))
      : [];
    setActiveOverlayIds(savedOverlayIds);
    setCursorProbe({
      x: clampRange(savedProbe.x, 0, 100, 50),
      y: clampRange(savedProbe.y, 0, 100, 50),
    });
    setSegmentationRun(getLatestRunFromMetadata(selectedPart, 'segmentation_runs'));
    setMeasurementRun(getLatestRunFromMetadata(selectedPart, 'measurement_runs'));
  }, [selectedPart, projectType, projectId, mprDimensions, workspaceHydration, workspaceStateLoaded, displayValueDomain]);

  useEffect(() => {
    if (projectType !== 'PT3' || !workspaceStateLoaded) return;
    const savedMpr = workspaceHydration?.mpr || {};
    // Removed legacy scene modes normalize to a supported view instead of
    // leaving the controlled selector without a matching option.
    setMprReconstructionMode(normalizeMprReconstructionMode(savedMpr.reconstruction_mode));
    setRayMarchSettings(normalizeRayMarchSettings(
      savedMpr.reconstruction_mode === 'hybrid3d'
        ? DEFAULT_RAY_MARCH_SETTINGS
        : savedMpr.ray_march_settings,
    ));
  }, [projectId, projectType, workspaceHydration, workspaceStateLoaded]);

  useEffect(() => {
    const savedInspector = workspaceHydration?.inspector || {};
    setShortcutHelpVisible(savedInspector.shortcut_help_visible === true);
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
    });
  }, [selectedPart, workspaceHydration]);

  useEffect(() => {
    let isCurrent = true;
    const loadAnnotations = async () => {
      if (!selectedPart?.id) {
        setAnnotationsState([]);
        return;
      }
      const embeddedFallback = Array.isArray(selectedPart.metadata?.annotations)
        ? selectedPart.metadata.annotations
        : [];
      setAnnotationsState(embeddedFallback);
      const requestMutationRevision = annotationsMutationRevisionRef.current;
      setAnnotationsLoading(true);
      try {
        const resp = await fetch(`/api/projects/${projectId}/parts/${selectedPart.id}/annotations`);
        if (!resp.ok) {
          throw new Error(`Failed to load annotations (${resp.status})`);
        }
        const payload = await resp.json();
        const annotationItems = Array.isArray(payload?.annotations) ? payload.annotations : [];
        if (isCurrent && annotationsMutationRevisionRef.current === requestMutationRevision) {
          setAnnotationsState((previous) => (
            JSON.stringify(previous) === JSON.stringify(annotationItems) ? previous : annotationItems
          ));
        }
      } catch (_err) {
        if (isCurrent && annotationsMutationRevisionRef.current === requestMutationRevision) {
          setAnnotationsState(embeddedFallback);
        }
      } finally {
        if (isCurrent) {
          setAnnotationsLoading(false);
        }
      }
    };

    loadAnnotations();
    return () => {
      isCurrent = false;
    };
  }, [projectId, selectedPart?.id, selectedPart?.metadata?.annotations]);

  useEffect(() => {
    if (!annotations.length) {
      setSelectedAnnotationId(null);
      setFullscreenBoundsEditAnnotationId(null);
      return;
    }
    if (!annotations.some((annotation) => annotation.id === selectedAnnotationId)) {
      setSelectedAnnotationId(annotations[0].id);
    }
    if (fullscreenBoundsEditAnnotationId && !annotations.some((annotation) => String(annotation.id) === String(fullscreenBoundsEditAnnotationId))) {
      setFullscreenBoundsEditAnnotationId(null);
    }
  }, [annotations, selectedAnnotationId, fullscreenBoundsEditAnnotationId]);

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
              mpr: projectType === 'PT3'
                ? {
                  slice_position: slicePosition,
                  viewport_transform: viewportTransform,
                  reconstruction_mode: mprReconstructionMode,
                  ray_march_settings: rayMarchSettings,
                  projection_mirror: mprProjectionMirror,
                  display_window: displayWindow,
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
    displayWindow,
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
    rayMarchSettings,
    selectedBatchId,
    selectedPart,
    slicePosition,
    sortMode,
    viewportTransform,
    workspaceStateLoaded,
  ]);



  useEffect(() => {
    if (typeof onInspectionShareStateChange !== 'function' || loading || !workspaceStateLoaded) return;
    onInspectionShareStateChange({
      selectedBatchId,
      selectedPartId: selectedPart?.id || selectedPartId,
      selectedImageRef,
      reviewFilter,
      activeMetadataTab,
      activeMprPane: projectType === 'PT3' ? activeMprPane : '',
      activeOverlayIds: projectType === 'PT3' ? activeOverlayIds : [],
    }, { replace: true });
  }, [
    activeMetadataTab,
    activeMprPane,
    activeOverlayIds,
    loading,
    onInspectionShareStateChange,
    projectType,
    reviewFilter,
    selectedBatchId,
    selectedImageRef,
    selectedPart?.id,
    selectedPartId,
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
      if (mprFullscreenOpen) return;
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
        updatePartReviewState(selectedPart, 'reject_confirmed');
      }
    };
    document.addEventListener('keydown', handleInspectorHotkeys);
    return () => document.removeEventListener('keydown', handleInspectorHotkeys);
  }, [inspectorHotkeys, mprFullscreenOpen, savingPartId, selectedPart, updatePartReviewState]);

  const reviewSummary = useMemo(() => {
    return parts.reduce(
      (acc, part) => {
        const state = part.review_state || 'unreviewed';
        acc[state] = (acc[state] || 0) + 1;
        return acc;
      },
      { unreviewed: 0, pass: 0, reject_pending: 0, reject_confirmed: 0 },
    );
  }, [parts]);

  const updateSlicePosition = (axis, value, dimensions) => {
    const upper = Math.max(0, (dimensions?.[axis] || 1) - 1);
    const nextValue = Math.min(upper, Math.max(0, Number(value) || 0));
    const nextSlicePosition = { ...slicePositionRef.current, [axis]: nextValue };
    sessionMprSlicePositionRef.current.slicePosition = nextSlicePosition;
    slicePositionRef.current = nextSlicePosition;
    setSlicePosition(nextSlicePosition);
    onMprSlicePositionChange?.(nextSlicePosition);
  };

  const stepSlicePosition = (axis, delta) => {
    const upper = Math.max(0, (mprDimensions?.[axis] || 1) - 1);
    const nextSlicePosition = {
      ...slicePositionRef.current,
      [axis]: Math.min(upper, Math.max(0, Number(slicePositionRef.current[axis] || 0) + delta)),
    };
    sessionMprSlicePositionRef.current.slicePosition = nextSlicePosition;
    slicePositionRef.current = nextSlicePosition;
    setSlicePosition(nextSlicePosition);
    onMprSlicePositionChange?.(nextSlicePosition);
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
    if ((event.button !== undefined && event.button !== 0) || mprDragRef.current) return;
    setActiveMprPane('volume');
    mprDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      rotation: mprRotation,
      moved: false,
      captureTarget: event.currentTarget,
    };
    safeSetPointerCapture(event.currentTarget, event.pointerId);
  };

  const handleMprVolumePointerMove = (event) => {
    const drag = mprDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
    setMprRotation({
      x: Math.min(72, Math.max(-72, drag.rotation.x + dy * 0.35)),
      y: drag.rotation.y + dx * 0.35,
    });
  };

  const handleMprVolumePointerUp = (event) => {
    const drag = mprDragRef.current;
    if (drag?.pointerId === event.pointerId) {
      event.preventDefault();
      clearMprVolumeDrag(drag.moved);
    }
  };

  const handleMprVolumePointerCancel = (event) => {
    const drag = mprDragRef.current;
    if (drag?.pointerId !== event.pointerId) return;
    clearMprVolumeDrag(false);
  };

  const openMprFullscreen = (event) => {
    if (suppressNextMprSceneClickRef.current) {
      suppressNextMprSceneClickRef.current = false;
      return;
    }
    mprFullscreenOpenerRef.current = event.currentTarget.querySelector?.('[role="button"]') || event.currentTarget;
    setActiveMprPane('volume');
    setMprFullscreenOpen(true);
  };

  const closeMprFullscreen = () => {
    clearMprVolumeDrag(false);
    setMprFullscreenOpen(false);
    window.requestAnimationFrame(() => mprFullscreenOpenerRef.current?.focus());
  };

  const preventMprNativeDrag = (event) => {
    event.preventDefault();
  };

  const openSegmentationHelper = (event) => {
    segmentationHelperOpenerRef.current = event?.currentTarget || document.activeElement;
    const fallbackAxis = activeMprPane === 'volume' ? 'axial' : activeMprPane;
    const axis = MPR_AXES.includes(fallbackAxis) ? fallbackAxis : 'axial';
    setSegmentationHelperAxis(axis);
    setSegmentationHelperView(SEGMENTATION_VIEW_BY_AXIS[axis] || 'z');
    if (segmentationSegments.length === 0) {
      const dimensions = getMprAxisImageDimensions(axis, mprDimensions, volumeCacheState.cache);
      const firstSegment = createDefaultSegment(0, {
        axis,
        sliceIndex: getSegmentationCanonicalSliceIndex(axis),
        imageWidth: dimensions.width,
        imageHeight: dimensions.height,
        volumeDimensions: [
          mprDimensions.sagittal,
          mprDimensions.coronal,
          mprDimensions.axial,
        ],
      });
      if (selectedPart?.id) {
        segmentationLocalDraftsRef.current.set(
          `${projectId}:${selectedPart.id}:${firstSegment.id}`,
          {
            localId: String(firstSegment.id),
            serverId: '',
            version: 0,
            segment: firstSegment,
          },
        );
      }
      setSegmentationSegments([firstSegment]);
      setSelectedSegmentationSegmentId(firstSegment.id);
      setEditingSegmentationSegmentId('');
    }
    setSegmentationPendingSelection(null);
    setSegmentationDraftShape(null);
    setSegmentationVolumeStatus('');
    segmentationDraftRef.current = null;
    setSegmentationHelperOpen(true);
  };

  const closeSegmentationHelper = useCallback(() => {
    const pointerSession = segmentationPointerSessionRef.current;
    if (pointerSession) {
      safeReleasePointerCapture(pointerSession.captureTarget, pointerSession.pointerId);
      segmentationPointerSessionRef.current = null;
    }
    segmentationVolumeRequestRef.current.controller?.abort();
    segmentationVolumeRequestRef.current = {
      generation: segmentationVolumeRequestRef.current.generation + 1,
      controller: null,
    };
    setSegmentationHelperOpen(false);
    setSegmentationPendingSelection(null);
    setSegmentationDraftShape(null);
    setSegmentationPointerPreview(null);
    setSegmentationVolumeLoading(false);
    setSegmentationVolumeStatus('');
    segmentationDraftRef.current = null;
    window.requestAnimationFrame(() => segmentationHelperOpenerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!segmentationHelperOpen) return undefined;
    segmentationHelperCloseRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeSegmentationHelper();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(
        segmentationHelperDialogRef.current?.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) || [],
      ).filter((element) => element.getAttribute('aria-hidden') !== 'true' && element.tabIndex >= 0);
      if (focusable.length === 0) return;
      const activeIndex = focusable.indexOf(document.activeElement);
      const nextIndex = event.shiftKey
        ? (activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1)
        : (activeIndex < 0 || activeIndex === focusable.length - 1 ? 0 : activeIndex + 1);
      event.preventDefault();
      focusable[nextIndex].focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closeSegmentationHelper, segmentationHelperOpen]);

  const drainSegmentationMutationQueue = async (queueKey) => {
    const queue = segmentationMutationQueuesRef.current.get(queueKey);
    if (!queue || queue.running) return;
    queue.running = true;

    while (queue.pending.length > 0) {
      const mutation = queue.pending.shift();
      const annotationId = queue.serverId || segmentationServerIdsRef.current.get(queueKey) || '';
      if (mutation.type === 'delete') {
        if (!annotationId) {
          setError('Failed to delete segment annotation (missing annotation id)');
          mutation.resolve(false);
          continue;
        }
        try {
          const resp = await fetch(
            `/api/projects/${queue.projectId}/parts/${queue.partId}/annotations/${encodeURIComponent(String(annotationId))}`,
            { method: 'DELETE' },
          );
          if (!resp.ok) throw new Error(`Failed to delete segment annotation (${resp.status})`);
          segmentationLocalDraftsRef.current.delete(queueKey);
          segmentationServerIdsRef.current.delete(queueKey);
          segmentationServerIdsRef.current.delete(`${queue.projectId}:${queue.partId}:${annotationId}`);
          if (activeSegmentationPersistenceScopeRef.current === `${queue.projectId}:${queue.partId}`) {
            setAnnotations((prev) => prev.filter((annotation) => (
              String(annotation.id) !== String(annotationId)
              && String(annotation.id) !== String(queue.localId)
            )));
            setSegmentationSegments((prev) => prev.filter((segment) => (
              String(segment.id) !== String(annotationId)
              && String(segment.id) !== String(queue.localId)
              && String(segment.annotationId) !== String(annotationId)
            )));
            setSelectedSegmentationSegmentId((current) => (
              [String(annotationId), String(queue.localId)].includes(String(current)) ? '' : current
            ));
            setEditingSegmentationSegmentId((current) => (
              [String(annotationId), String(queue.localId)].includes(String(current)) ? '' : current
            ));
            setSelectedAnnotationId((current) => (
              String(current) === String(annotationId) ? null : current
            ));
          }
          mutation.resolve(true);
        } catch (err) {
          queue.deleted = false;
          setError(err.message || 'Failed to delete segment annotation');
          mutation.resolve(false);
        }
        continue;
      }
      const payload = makeVistaSegmentAnnotationPayload(mutation.segment, queue.lastSavedAnnotation || null);
      try {
        const resp = await fetch(
          annotationId
            ? `/api/projects/${queue.projectId}/parts/${queue.partId}/annotations/${encodeURIComponent(String(annotationId))}`
            : `/api/projects/${queue.projectId}/parts/${queue.partId}/annotations`,
          {
            method: annotationId ? 'PATCH' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
        );
        if (!resp.ok) throw new Error(`Failed to save segment annotation (${resp.status})`);
        const responseAnnotation = await resp.json();
        const resolvedAnnotationId = String(annotationId || responseAnnotation?.id || '');
        if (!resolvedAnnotationId) throw new Error('Failed to save segment annotation (missing annotation id)');

        // Treat the submitted mutation as authoritative. A delayed or stale response may
        // contain older geometry, but it must never roll the local helper back.
        const saved = {
          ...(responseAnnotation || {}),
          ...payload,
          id: resolvedAnnotationId,
          geometry: payload.geometry,
          metadata: payload.metadata,
        };
        queue.serverId = resolvedAnnotationId;
        queue.lastSavedAnnotation = saved;
        segmentationServerIdsRef.current.set(queueKey, resolvedAnnotationId);
        segmentationServerIdsRef.current.set(
          `${queue.projectId}:${queue.partId}:${resolvedAnnotationId}`,
          resolvedAnnotationId,
        );
        const currentDraft = segmentationLocalDraftsRef.current.get(queueKey);
        if (currentDraft) {
          segmentationLocalDraftsRef.current.set(queueKey, {
            ...currentDraft,
            serverId: resolvedAnnotationId,
          });
        }

        const isLatestMutation = mutation.version === queue.latestVersion && queue.pending.length === 0;
        if (isLatestMutation) {
          segmentationLocalDraftsRef.current.delete(queueKey);
          if (activeSegmentationPersistenceScopeRef.current === `${queue.projectId}:${queue.partId}`) {
            setAnnotations((prev) => {
              let inserted = false;
              const next = [];
              prev.forEach((annotation) => {
                const candidateId = String(annotation.id);
                if (candidateId === String(queue.localId) && candidateId !== resolvedAnnotationId) return;
                if (candidateId === resolvedAnnotationId) {
                  if (!inserted) next.push(saved);
                  inserted = true;
                  return;
                }
                next.push(annotation);
              });
              if (!inserted) next.unshift(saved);
              return next;
            });
            const savedSegment = annotationToSegmentationHelperSegment(saved);
            setSegmentationSegments((prev) => prev.map((segment) => (
              String(segment.id) === String(queue.localId)
                || String(segment.id) === resolvedAnnotationId
                ? savedSegment
                : segment
            )));
            setSelectedSegmentationSegmentId((current) => (
              String(current) === String(queue.localId) ? resolvedAnnotationId : current
            ));
            setEditingSegmentationSegmentId((current) => (
              String(current) === String(queue.localId) ? resolvedAnnotationId : current
            ));
            setSelectedAnnotationId(resolvedAnnotationId);
          }
        }
        mutation.resolve(saved);
      } catch (err) {
        setError(err.message || 'Failed to save segment annotation');
        mutation.resolve(null);
        if (!annotationId) {
          // Without a server id, later entries cannot be PATCHed safely. Keep the
          // latest local draft visible and let the next user edit retry one POST.
          queue.pending.splice(0).forEach((pendingMutation) => pendingMutation.resolve(null));
        }
      }
    }

    queue.running = false;
    if (queue.pending.length === 0) segmentationMutationQueuesRef.current.delete(queueKey);
  };

  const persistSegmentationSegment = (segment) => {
    if (!selectedPart?.id || !segment) return Promise.resolve(null);
    const localId = String(segment.id || segment.annotationId || '');
    if (!localId) return Promise.resolve(null);
    const queueKey = `${projectId}:${selectedPart.id}:${localId}`;
    const knownServerId = String(
      segmentationServerIdsRef.current.get(queueKey)
      || segment.annotationId
      || annotations.find((annotation) => String(annotation.id) === localId)?.id
      || '',
    );
    let queue = segmentationMutationQueuesRef.current.get(queueKey);
    if (!queue) {
      const existingAnnotation = annotations.find((annotation) => (
        String(annotation.id) === String(knownServerId || localId)
      ));
      queue = {
        projectId,
        partId: String(selectedPart.id),
        localId,
        serverId: knownServerId,
        lastSavedAnnotation: existingAnnotation || null,
        latestVersion: 0,
        pending: [],
        running: false,
        deleted: false,
      };
      segmentationMutationQueuesRef.current.set(queueKey, queue);
    }
    if (queue.deleted) return Promise.resolve(null);
    queue.latestVersion += 1;
    const version = queue.latestVersion;
    const segmentSnapshot = {
      ...segment,
      areas: Array.isArray(segment.areas) ? [...segment.areas] : [],
    };
    segmentationLocalDraftsRef.current.set(queueKey, {
      localId,
      serverId: queue.serverId,
      version,
      segment: segmentSnapshot,
    });
    const supersededSaves = queue.pending.filter((entry) => entry.type === 'save');
    if (supersededSaves.length > 0) {
      queue.pending = queue.pending.filter((entry) => entry.type !== 'save');
      supersededSaves.forEach((entry) => entry.resolve(null));
    }
    const result = new Promise((resolve) => {
      queue.pending.push({ type: 'save', version, segment: segmentSnapshot, resolve });
    });
    drainSegmentationMutationQueue(queueKey);
    return result;
  };

  const deleteSegmentationSegment = (segmentId) => {
    if (!selectedPart?.id || !segmentId) return Promise.resolve(false);
    const segment = segmentationSegments.find((candidate) => (
      String(candidate.id) === String(segmentId)
      || String(candidate.annotationId) === String(segmentId)
    ));
    const localId = String(segment?.id || segmentId);
    const queueKey = `${projectId}:${selectedPart.id}:${localId}`;
    const knownServerId = String(
      segmentationServerIdsRef.current.get(queueKey)
      || segment?.annotationId
      || annotations.find((annotation) => String(annotation.id) === String(segmentId))?.id
      || segmentId,
    );
    let queue = segmentationMutationQueuesRef.current.get(queueKey);
    if (!queue) {
      queue = {
        projectId,
        partId: String(selectedPart.id),
        localId,
        serverId: knownServerId,
        lastSavedAnnotation: annotations.find((annotation) => String(annotation.id) === knownServerId) || null,
        latestVersion: 0,
        pending: [],
        running: false,
        deleted: false,
      };
      segmentationMutationQueuesRef.current.set(queueKey, queue);
    }
    if (queue.deleted) return Promise.resolve(false);
    queue.deleted = true;
    queue.latestVersion += 1;
    const result = new Promise((resolve) => {
      queue.pending.push({ type: 'delete', version: queue.latestVersion, resolve });
    });
    drainSegmentationMutationQueue(queueKey);
    return result;
  };

  const addSegmentationSegment = () => {
    cancelSegmentationDraft();
    const dimensions = getMprAxisImageDimensions(segmentationHelperAxis, mprDimensions, volumeCacheState.cache);
    const nextSegment = createDefaultSegment(segmentationSegments.length, {
      axis: segmentationHelperAxis,
      sliceIndex: getSegmentationCanonicalSliceIndex(segmentationHelperAxis),
      imageWidth: dimensions.width,
      imageHeight: dimensions.height,
      volumeDimensions: [
        mprDimensions.sagittal,
        mprDimensions.coronal,
        mprDimensions.axial,
      ],
    });
    setSegmentationSegments((prev) => [...prev, nextSegment]);
    setSelectedSegmentationSegmentId(nextSegment.id);
    setEditingSegmentationSegmentId(nextSegment.id);
    persistSegmentationSegment(nextSegment);
  };

  const updateSegmentationSegment = (segmentId, patch) => {
    setSegmentationSegments((prev) => prev.map((segment) => (
      segment.id === segmentId ? { ...segment, ...patch } : segment
    )));
  };

  const saveSegmentationSegmentPatch = async (segmentId, patch = {}) => {
    const segment = segmentationSegments.find((entry) => String(entry.id) === String(segmentId));
    if (!segment) return null;
    const volumeDimensions = getSegmentationVolumeDimensions();
    const maxSliceIndex = Math.max(0, (
      segment.axis === 'sagittal'
        ? volumeDimensions[0]
        : (segment.axis === 'coronal' ? volumeDimensions[1] : volumeDimensions[2])
    ) - 1);
    const next = {
      ...segment,
      ...patch,
      minSlice: clampRange(patch.minSlice ?? segment.minSlice, 0, maxSliceIndex, 0),
      maxSlice: clampRange(patch.maxSlice ?? segment.maxSlice, 0, maxSliceIndex, maxSliceIndex),
    };
    if (next.minSlice > next.maxSlice) {
      if (Object.prototype.hasOwnProperty.call(patch, 'minSlice')) next.maxSlice = next.minSlice;
      else next.minSlice = next.maxSlice;
    }
    updateSegmentationSegment(segmentId, next);
    return persistSegmentationSegment(next);
  };

  const getSegmentationPointerPosition = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const dimensions = getMprAxisImageDimensions(segmentationHelperAxis, mprDimensions, volumeCacheState.cache);
    const displayAxes = MPR_DISPLAY_AXES_BY_VIEW[segmentationHelperAxis] || MPR_DISPLAY_AXES_BY_VIEW.axial;
    const transform = getContainedImageTransform({
      elementRect: rect,
      sourceWidth: dimensions.width,
      sourceHeight: dimensions.height,
      mirrorX: mprProjectionMirror[displayAxes.x] === true,
      mirrorY: mprProjectionMirror[displayAxes.y] === true,
    });
    const point = clientPointToSource(transform, event, { rejectOutside: true });
    if (!point) return null;
    return {
      x: point.x,
      y: point.y,
      displayX: event.clientX - rect.left,
      displayY: event.clientY - rect.top,
      stageWidth: rect.width,
      stageHeight: rect.height,
      imageWidth: dimensions.width,
      imageHeight: dimensions.height,
    };
  };

  const getSegmentationVolumeDimensions = () => segmentationHelperVolumeDimensions;

  const getSegmentationCanonicalSliceIndex = (
    axis = segmentationHelperAxis,
    uiSliceIndex = slicePosition[axis],
  ) => {
    const safeAxis = MPR_AXES.includes(axis) ? axis : 'axial';
    const volumeDimensions = getSegmentationVolumeDimensions();
    return getCanonicalSegmentationSliceIndex(
      safeAxis,
      uiSliceIndex,
      mprDimensions,
      volumeDimensions,
    );
  };

  const getSegmentationVolumeSpacing = () => {
    const spacing = getMechanicalVolumeMetadata(selectedPart)?.spacing;
    return Array.isArray(spacing) && spacing.length >= 3
      ? spacing.slice(0, 3).map((value) => Math.max(Number.EPSILON, Number(value) || 1))
      : [1, 1, 1];
  };

  const getActiveSegmentationToolMode = (toolId = segmentationTool) => {
    const tool = SEGMENTATION_HELPER_TOOLS.find((entry) => entry.id === toolId);
    if (!tool?.modes?.includes('3d')) return '2d';
    if (segmentationHelperView === '3d') return '3d';
    return segmentationToolModes[toolId] === '3d' ? '3d' : '2d';
  };

  const getSegmentationVoxelPosition = (position, axis = segmentationHelperAxis) => {
    if (!position || !MPR_AXES.includes(axis)) return null;
    const volumeDimensions = getSegmentationVolumeDimensions();
    const mapped = mapVectorPlanePointToVoxel({
      axis,
      point: position,
      sliceIndex: getSegmentationCanonicalSliceIndex(axis),
      imageWidth: position.imageWidth,
      imageHeight: position.imageHeight,
      dimensions: volumeDimensions,
    });
    if (!Array.isArray(mapped) || mapped.length < 3) return null;
    return mapped.map((value, index) => Math.max(
      0,
      Math.min(volumeDimensions[index] - 1, Math.round(Number(value) || 0)),
    ));
  };

  const makeSegmentationShapeBase = (tool, position, overrides = {}) => {
    const mode = overrides.mode || getActiveSegmentationToolMode(tool);
    const axis = segmentationHelperAxis;
    const dimensions = getMprAxisImageDimensions(axis, mprDimensions, volumeCacheState.cache);
    return {
      id: `shape-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tool,
      mode,
      operation: segmentationOperation,
      axis,
      sliceIndex: getSegmentationCanonicalSliceIndex(axis),
      imageWidth: position?.imageWidth || dimensions.width,
      imageHeight: position?.imageHeight || dimensions.height,
      volumeDimensions: getSegmentationVolumeDimensions(),
      brushSize: Number(segmentationBrushSize) || 18,
      sensitivity: Number(segmentationSensitivity) || 28,
      ...overrides,
    };
  };

  const getSegmentationMlCacheKey = (axis = segmentationHelperAxis) => JSON.stringify({
    partId: selectedPart?.id || '',
    axis,
    sliceIndex: Number(slicePosition[axis] || 0),
    methodId: segmentationMlMethod,
    parameters: segmentationMlParameters,
    displayWindow,
  });

  const getSegmentationSliceDataUrl = (stageElement, axis = segmentationHelperAxis) => {
    const renderedCanvas = stageElement?.querySelector?.('canvas.mpr-slice-canvas');
    if (renderedCanvas?.toDataURL) {
      return renderedCanvas.toDataURL('image/png');
    }
    const cachedCanvas = getCachedMprSliceCanvas(axis, slicePosition, mprDimensions, volumeCacheState.cache);
    if (cachedCanvas?.toDataURL) {
      return cachedCanvas.toDataURL('image/png');
    }
    return '';
  };

  const getSegmentationSliceCanvasForSelection = (stageElement, axis = segmentationHelperAxis) => {
    const renderedCanvas = stageElement?.querySelector?.('canvas.mpr-slice-canvas');
    if (renderedCanvas?.getContext) return renderedCanvas;
    return getCachedMprSliceCanvas(axis, slicePosition, mprDimensions, volumeCacheState.cache);
  };

  const buildConnectedSegmentationSelection = (stageElement, position) => {
    const canvas = getSegmentationSliceCanvasForSelection(stageElement, segmentationHelperAxis);
    const ctx = canvas?.getContext?.('2d');
    const width = Math.max(1, Number(canvas?.width) || Math.round(position?.imageWidth || 1));
    const height = Math.max(1, Number(canvas?.height) || Math.round(position?.imageHeight || 1));
    if (!ctx?.getImageData || !position || width <= 0 || height <= 0) {
      const radius = Math.max(4, Number(segmentationSensitivity) || 28);
      return makeSegmentationShapeBase('connected', position, {
        seed: position,
        radius,
        points: [],
        error: 'slice-pixels-unavailable',
      });
    }

    let imageData;
    try {
      imageData = ctx.getImageData(0, 0, width, height);
    } catch (_) {
      imageData = null;
    }
    const data = imageData?.data;
    if (!data || data.length < width * height * 4) {
      return null;
    }

    const seedX = Math.max(0, Math.min(width - 1, Math.round((position.x / Math.max(1, position.imageWidth || width)) * (width - 1))));
    const seedY = Math.max(0, Math.min(height - 1, Math.round((position.y / Math.max(1, position.imageHeight || height)) * (height - 1))));
    const seedOffset = (seedY * width + seedX) * 4;
    const seed = [
      data[seedOffset],
      data[seedOffset + 1],
      data[seedOffset + 2],
      data[seedOffset + 3],
    ];
    const sensitivity = Math.max(0, Number(segmentationSensitivity) || 28);
    const maxDelta = sensitivity;
    const visited = new Uint8Array(width * height);
    const selected = new Uint8Array(width * height);
    const stack = [seedY * width + seedX];
    let areaPx = 0;
    let minX = seedX;
    let maxX = seedX;
    let minY = seedY;
    let maxY = seedY;

    const matchesSeed = (index) => {
      const offset = index * 4;
      return Math.max(
        Math.abs(data[offset] - seed[0]),
        Math.abs(data[offset + 1] - seed[1]),
        Math.abs(data[offset + 2] - seed[2]),
        Math.abs(data[offset + 3] - seed[3]),
      ) <= maxDelta;
    };

    while (stack.length > 0) {
      const index = stack.pop();
      if (visited[index]) continue;
      visited[index] = 1;
      if (!matchesSeed(index)) continue;
      selected[index] = 1;
      areaPx += 1;
      const x = index % width;
      const y = Math.floor(index / width);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0) stack.push(index - 1);
      if (x < width - 1) stack.push(index + 1);
      if (y > 0) stack.push(index - width);
      if (y < height - 1) stack.push(index + width);
    }

    const scaleX = (position.imageWidth || width) / width;
    const scaleY = (position.imageHeight || height) / height;
    const pathParts = [];
    const maskRuns = [];
    for (let y = minY; y <= maxY; y += 1) {
      let x = minX;
      while (x <= maxX) {
        const index = y * width + x;
        if (!selected[index]) {
          x += 1;
          continue;
        }
        const startX = x;
        while (x <= maxX && selected[y * width + x]) x += 1;
        const runWidth = x - startX;
        pathParts.push(`M ${startX * scaleX} ${y * scaleY} h ${runWidth * scaleX} v ${scaleY} h ${-runWidth * scaleX} Z`);
        maskRuns.push([y * scaleY, startX * scaleX, x * scaleX]);
      }
    }

    return makeSegmentationShapeBase('connected', position, {
      seed: position,
      points: [],
      maskPath: pathParts.join(' '),
      maskRuns,
      bbox: [minX * scaleX, minY * scaleY, (maxX + 1) * scaleX, (maxY + 1) * scaleY],
      areaPx,
      canvasWidth: width,
      canvasHeight: height,
      seedColor: seed,
    });
  };

  const makeConnectedVolumeSelection = (
    position,
    seedVoxel,
    result,
    segmentId,
    sourceAxis,
    sourceSliceIndex,
  ) => (
    makeSegmentationShapeBase('connected', position, {
      segmentId,
      axis: sourceAxis,
      sliceIndex: sourceSliceIndex,
      mode: '3d',
      seed: position,
      seedVoxel,
      points: [],
      volumeRuns: result?.volume_runs || result?.runs || [],
      volumeDimensions: result?.dimensions || getSegmentationVolumeDimensions(),
      voxelCount: Number(result?.voxel_count ?? result?.voxelCount ?? result?.stats?.voxelCount) || 0,
      examined: Number(result?.examined ?? result?.stats?.examined) || 0,
      connectivity: Number(result?.connectivity) || 6,
      truncated: result?.truncated === true || result?.stats?.truncated === true,
      truncationReason: String(
        result?.truncation_reason || result?.truncationReason || result?.reason || result?.stats?.reason || '',
      ),
    })
  );

  const buildConnectedVolumeSegmentationSelection = async (position) => {
    const sourceAxis = segmentationHelperAxis;
    const sourceSliceIndex = getSegmentationCanonicalSliceIndex(sourceAxis);
    const seedVoxel = getSegmentationVoxelPosition(position, sourceAxis);
    const segmentId = selectedSegmentationSegment?.id || '';
    if (!seedVoxel) {
      setSegmentationVolumeStatus('Choose a valid voxel in an X, Y, or Z slice.');
      return;
    }
    segmentationVolumeRequestRef.current.controller?.abort();
    const generation = segmentationVolumeRequestRef.current.generation + 1;
    const controller = new AbortController();
    segmentationVolumeRequestRef.current = { generation, controller, segmentId };
    setSegmentationPendingSelection(null);
    setSegmentationVolumeLoading(true);
    setSegmentationVolumeStatus('Growing a six-connected 3D preview…');
    try {
      let result;
      const volumeCache = volumeCacheState.cache;
      if (isServerVolumeDescriptor(volumeCache)) {
        const response = await fetch(
          `/api/images/${encodeURIComponent(String(volumeCache.imageId))}/volume-connected-selection`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              seed: seedVoxel,
              sensitivity: Math.max(0, Number(segmentationSensitivity) || 0),
              display_min: Number(displayWindow.min),
              display_max: Number(displayWindow.max),
              max_voxels: 50000,
              max_examined: 150000,
              max_runs: 10000,
            }),
          },
        );
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          throw new Error(body?.detail || `3D connected selection failed (${response.status})`);
        }
        result = await response.json();
      } else if (volumeCache?.slices?.length) {
        if (volumeCache.complete !== true) {
          throw new Error(
            `3D connected selection needs a complete volume (${Number(volumeCache.validSliceCount) || 0}/${volumeCache.slices.length} slices available).`,
          );
        }
        const dimensions = getSegmentationVolumeDimensions();
        result = await floodFillVolume3dAsync({
          dimensions,
          seed: seedVoxel,
          sensitivity: Math.max(0, Number(segmentationSensitivity) || 0),
          getVoxel: (x, y, z) => {
            const data = volumeCache.slices[z]?.imageData?.data;
            if (!data) return null;
            const offset = ((y * dimensions[0]) + x) * 4;
            return [
              data[offset],
              data[offset + 1],
              data[offset + 2],
              data[offset + 3],
            ];
          },
          maxVoxels: 50000,
          maxExamined: 150000,
          maxRuns: 10000,
          isCancelled: () => (
            controller.signal.aborted
            || segmentationVolumeRequestRef.current.generation !== generation
          ),
        });
      } else {
        throw new Error('The volume is still loading; try again when all slices are ready.');
      }
      if (
        controller.signal.aborted
        || segmentationVolumeRequestRef.current.generation !== generation
      ) return;
      const selection = makeConnectedVolumeSelection(
        position,
        seedVoxel,
        result,
        segmentId,
        sourceAxis,
        sourceSliceIndex,
      );
      setSegmentationPendingSelection(selection);
      const count = Number(selection.voxelCount) || 0;
      const truncatedSuffix = selection.truncated
        ? ` Limit reached (${selection.truncationReason || 'guard'}); preview is partial.`
        : '';
      setSegmentationVolumeStatus(
        `3D preview: ${count.toLocaleString()} voxels, 6-neighbor connectivity.${truncatedSuffix}`,
      );
    } catch (error) {
      if (error?.name !== 'AbortError') {
        setSegmentationVolumeStatus(error?.message || 'Unable to build the 3D connected preview.');
      }
    } finally {
      if (segmentationVolumeRequestRef.current.generation === generation) {
        segmentationVolumeRequestRef.current.controller = null;
        setSegmentationVolumeLoading(false);
      }
    }
  };

  const updateSegmentationMlParameter = (name, value) => {
    setSegmentationMlParameters((prev) => ({ ...prev, [name]: value }));
    setSegmentationPendingSelection(null);
    setSegmentationMlStatus('');
  };

  const changeSegmentationMlGroup = (groupId) => {
    const nextMethod = getDefaultSegmentationMlMethod(groupId);
    setSegmentationMlGroup(groupId);
    setSegmentationMlMethod(nextMethod);
    setSegmentationMlParameters(getDefaultSegmentationMlParameters(nextMethod));
    setSegmentationPendingSelection(null);
    setSegmentationMlStatus('');
  };

  const changeSegmentationMlMethod = (methodId) => {
    setSegmentationMlMethod(methodId);
    setSegmentationMlParameters(getDefaultSegmentationMlParameters(methodId));
    setSegmentationPendingSelection(null);
    setSegmentationMlStatus('');
  };

  const makeShapeFromMlRegion = (region, position, cachedResult) => {
    if (!region?.bbox) return null;
    const dimensions = getMprAxisImageDimensions(
      segmentationHelperAxis,
      mprDimensions,
      volumeCacheState.cache,
    );
    return makeSegmentationShapeBase('ml-helper', position, {
      bbox: region.bbox,
      seed: position,
      points: [
        position,
        ...(Array.isArray(region.centroid) ? [{ x: region.centroid[0], y: region.centroid[1] }] : []),
      ],
      label: region.label,
      areaPx: region.area_px,
      className: region.class_name,
      confidence: region.confidence,
      methodId: segmentationMlMethod,
      methodLabel: cachedResult?.method_id || segmentationMlMethod,
      imageWidth: position?.imageWidth || dimensions.width,
      imageHeight: position?.imageHeight || dimensions.height,
    });
  };

  const selectRegionFromCachedMlResult = (cachedResult, position) => {
    const regions = Array.isArray(cachedResult?.regions) ? cachedResult.regions : [];
    const containsPosition = (region) => {
      const bbox = Array.isArray(region?.bbox) ? region.bbox.map(Number) : [];
      if (bbox.length < 4 || bbox.some((value) => !Number.isFinite(value))) return false;
      return bbox[0] <= position.x && position.x <= bbox[2] && bbox[1] <= position.y && position.y <= bbox[3];
    };
    const containing = regions.filter((region) => {
      return containsPosition(region);
    });
    const selectedRegion = containing.length > 0
      ? containing.sort((left, right) => Number(left.area_px || Infinity) - Number(right.area_px || Infinity))[0]
      : (containsPosition(cachedResult?.selected_region) ? cachedResult.selected_region : null);
    const shape = makeShapeFromMlRegion(selectedRegion, position, cachedResult);
    if (shape) {
      setSegmentationPendingSelection(shape);
      setSegmentationMlStatus(`Selected ML region ${selectedRegion.label} from ${regions.length} cached regions.`);
    } else {
      setSegmentationPendingSelection(null);
      setSegmentationMlStatus(regions.length > 0 ? 'No ML segment contains that click.' : 'No ML segments were returned for this slice.');
    }
  };

  const runSegmentationMlHelper = async (event, position) => {
    if (!selectedPart?.id || !position) return;
    const cacheKey = getSegmentationMlCacheKey(segmentationHelperAxis);
    const cached = segmentationMlCacheRef.current.get(cacheKey);
    if (cached) {
      selectRegionFromCachedMlResult(cached, position);
      return;
    }
    const imageData = getSegmentationSliceDataUrl(event.currentTarget, segmentationHelperAxis);
    if (!imageData) {
      setSegmentationMlStatus('Current slice image is still loading.');
      return;
    }
    setSegmentationMlLoading(true);
    setSegmentationMlStatus('Running ML helper on this slice...');
    try {
      const resp = await fetch(`/api/projects/${projectId}/parts/${selectedPart.id}/slice-segmentation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          axis: segmentationHelperAxis,
          slice_index: Number(slicePosition[segmentationHelperAxis] || 0),
          method_id: segmentationMlMethod,
          parameters: segmentationMlParameters,
          image_data_base64: imageData,
          filename: `${selectedPart.serial_number || selectedPart.id}-${segmentationHelperAxis}-${slicePosition[segmentationHelperAxis] || 0}.png`,
          click_x: position.x,
          click_y: position.y,
        }),
      });
      if (!resp.ok) throw new Error(`ML helper failed (${resp.status})`);
      const result = await resp.json();
      segmentationMlCacheRef.current.set(cacheKey, result);
      selectRegionFromCachedMlResult(result, position);
    } catch (err) {
      setSegmentationMlStatus(err.message || 'ML helper failed.');
    } finally {
      setSegmentationMlLoading(false);
    }
  };

  const commitSegmentationShape = (shape, explicitOperation = segmentationOperation) => {
    if (!shape || !selectedSegmentationSegment) return;
    const makeCompactedVolumeArea = (compacted) => ({
      id: `volume-snapshot-${Date.now()}`,
      tool: 'volume-mask',
      mode: '3d',
      operation: 'add',
      volumeDimensions: compacted.dimensions,
      volumeRuns: compacted.runs,
      voxelCount: compacted.stats.voxelCount,
      spacing: getSegmentationVolumeSpacing(),
      truncated: compacted.stats.truncated,
      truncationReason: compacted.stats.truncated ? 'mask-compaction-limit' : '',
    });
    const nextShape = {
      ...shape,
      operation: explicitOperation,
      color: selectedSegmentationSegment.color,
      axis: MPR_AXES.includes(shape.axis) ? shape.axis : segmentationHelperAxis,
      id: shape.id || `shape-${Date.now()}`,
    };
    const volumeDimensions = nextShape.volumeDimensions
      || selectedSegmentationSegment.volumeDimensions
      || getSegmentationVolumeDimensions();
    let existingAreas = [...(selectedSegmentationSegment.areas || [])];
    let compactionWasTruncated = false;
    if (existingAreas.length >= 48) {
      const existingCompacted = buildPt3SegmentVolumeRuns(
        {
          ...selectedSegmentationSegment,
          volumeDimensions,
          areas: existingAreas,
        },
        volumeDimensions,
        { includePlanar: true },
      );
      compactionWasTruncated = existingCompacted.stats.truncated;
      existingAreas = existingCompacted.runs.length > 0
        ? [makeCompactedVolumeArea(existingCompacted)]
        : [];
    }
    let nextSegment = {
      ...selectedSegmentationSegment,
      ...(nextShape.mode === '3d'
        ? { version: 2, volumeDimensions }
        : {}),
      areas: [...existingAreas, nextShape],
    };
    const shouldCompact = segmentHasVolumeAreas(nextSegment) || nextSegment.areas.length >= 48;
    if (shouldCompact) {
      const compacted = buildPt3SegmentVolumeRuns(
        { ...nextSegment, volumeDimensions },
        volumeDimensions,
        { includePlanar: true },
      );
      nextSegment = {
        ...nextSegment,
        version: 2,
        volumeDimensions: compacted.dimensions,
        areas: compacted.runs.length > 0
          ? [makeCompactedVolumeArea(compacted)]
          : [],
      };
      compactionWasTruncated = compactionWasTruncated || compacted.stats.truncated;
      if (compactionWasTruncated) {
        setSegmentationVolumeStatus(
          'The segment reached its geometry limit; the saved mask is a bounded partial result.',
        );
      }
    }
    updateSegmentationSegment(selectedSegmentationSegment.id, nextSegment);
    persistSegmentationSegment(nextSegment);
    setSegmentationPendingSelection(null);
    setSegmentationDraftShape(null);
    if (shape.mode === '3d' && !compactionWasTruncated) {
      setSegmentationVolumeStatus(
        `${Number(
          nextSegment.areas?.[0]?.voxelCount ?? shape.voxelCount ?? 0,
        ).toLocaleString()} volumetric voxels applied.`,
      );
    }
    segmentationDraftRef.current = null;
  };

  const commitPendingSegmentationSelection = (operation = segmentationOperation) => {
    if (!segmentationPendingSelection) return;
    commitSegmentationShape(segmentationPendingSelection, operation);
  };

  const handleSegmentationHelperWheel = (event) => {
    event.preventDefault();
    stepSlicePosition(segmentationHelperAxis, event.deltaY > 0 ? 1 : -1);
  };

  const handleSegmentationStagePointerDown = (event) => {
    if (!selectedSegmentationSegment || (event.button !== undefined && event.button !== 0)) return;
    if (segmentationPointerSessionRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const position = getSegmentationPointerPosition(event);
    if (!position) return;
    setSegmentationPointerPreview(position);
    event.preventDefault();
    event.stopPropagation();
    const operation = segmentationTool === 'eraser' ? 'subtract' : segmentationOperation;
    const tool = segmentationTool === 'eraser' ? 'brush' : segmentationTool;
    const toolMode = getActiveSegmentationToolMode(segmentationTool);
    if (tool === 'ml-helper') {
      runSegmentationMlHelper(event, position);
      return;
    }
    if (tool === 'brush' || tool === 'scissors') {
      const voxel = toolMode === '3d' ? getSegmentationVoxelPosition(position) : null;
      const shape = makeSegmentationShapeBase(tool, position, {
        mode: tool === 'brush' ? toolMode : '2d',
        operation,
        points: [position],
        ...(voxel ? { voxelCenters: [voxel], seedVoxel: voxel } : {}),
      });
      segmentationDraftRef.current = shape;
      setSegmentationDraftShape(shape);
      segmentationPointerSessionRef.current = {
        pointerId: event.pointerId,
        captureTarget: event.currentTarget,
        captured: safeSetPointerCapture(event.currentTarget, event.pointerId),
      };
      return;
    }
    if (tool === 'circle') {
      const shape = makeSegmentationShapeBase(tool, position, { center: position, edge: position, radius: 0, points: [position] });
      segmentationDraftRef.current = shape;
      setSegmentationDraftShape(shape);
      segmentationPointerSessionRef.current = {
        pointerId: event.pointerId,
        captureTarget: event.currentTarget,
        captured: safeSetPointerCapture(event.currentTarget, event.pointerId),
      };
      return;
    }
    if (tool === 'rectangle') {
      const shape = makeSegmentationShapeBase(tool, position, { start: position, end: position, points: [position] });
      segmentationDraftRef.current = shape;
      setSegmentationDraftShape(shape);
      segmentationPointerSessionRef.current = {
        pointerId: event.pointerId,
        captureTarget: event.currentTarget,
        captured: safeSetPointerCapture(event.currentTarget, event.pointerId),
      };
      return;
    }
    if (tool === 'connected') {
      if (toolMode === '3d') {
        buildConnectedVolumeSegmentationSelection(position);
      } else {
        setSegmentationVolumeStatus('');
        setSegmentationPendingSelection(buildConnectedSegmentationSelection(event.currentTarget, position));
      }
      return;
    }
    if (['threshold', 'level-trace'].includes(tool)) {
      const radius = Math.max(6, Number(segmentationSensitivity) || 28);
      setSegmentationPendingSelection(makeSegmentationShapeBase(tool, position, {
        seed: position,
        radius,
        points: SEGMENTATION_POINT_MARKER_TOOLS.has(tool) ? [position] : [],
      }));
      return;
    }
    if (tool === 'polygon') {
      const existing = segmentationDraftRef.current?.tool === 'polygon' ? segmentationDraftRef.current : null;
      const points = [...(existing?.points || []), position];
      const shape = makeSegmentationShapeBase(tool, position, { ...(existing || {}), points, closed: false });
      segmentationDraftRef.current = shape;
      setSegmentationDraftShape(shape);
    }
  };

  const handleSegmentationStagePointerMove = (event) => {
    const pointerSession = segmentationPointerSessionRef.current;
    if (pointerSession
      && pointerSession.pointerId !== undefined
      && event.pointerId !== undefined
      && pointerSession.pointerId !== event.pointerId) return;
    if (segmentationDraftRef.current && event.pointerType === 'mouse' && event.buttons === 0) {
      safeReleasePointerCapture(pointerSession?.captureTarget, pointerSession?.pointerId);
      segmentationPointerSessionRef.current = null;
      setSegmentationDraftShape(null);
      segmentationDraftRef.current = null;
      return;
    }
    const position = getSegmentationPointerPosition(event);
    if (position) setSegmentationPointerPreview(position);
    const draft = segmentationDraftRef.current;
    if (!draft || draft.tool === 'polygon') return;
    if (!position) return;
    event.preventDefault();
    if (draft.tool === 'brush' || draft.tool === 'scissors') {
      const voxel = draft.mode === '3d' ? getSegmentationVoxelPosition(position, draft.axis) : null;
      const previousVoxel = draft.voxelCenters?.[draft.voxelCenters.length - 1];
      const voxelChanged = voxel && (
        !previousVoxel
        || voxel.some((value, index) => value !== previousVoxel[index])
      );
      const next = {
        ...draft,
        points: [...(draft.points || []), position],
        ...(voxelChanged ? { voxelCenters: [...(draft.voxelCenters || []), voxel] } : {}),
      };
      segmentationDraftRef.current = next;
      setSegmentationDraftShape(next);
      return;
    }
    if (draft.tool === 'circle') {
      const radius = Math.hypot(position.x - draft.center.x, position.y - draft.center.y);
      const next = { ...draft, edge: position, radius, points: [draft.center, position] };
      segmentationDraftRef.current = next;
      setSegmentationDraftShape(next);
      return;
    }
    if (draft.tool === 'rectangle') {
      const next = { ...draft, end: position, points: [draft.start, position] };
      segmentationDraftRef.current = next;
      setSegmentationDraftShape(next);
    }
  };

  const handleSegmentationStagePointerLeave = (event) => {
    const pointerSession = segmentationPointerSessionRef.current;
    if (pointerSession
      && pointerSession.pointerId !== undefined
      && event?.pointerId !== undefined
      && pointerSession.pointerId !== event.pointerId) return;
    setSegmentationPointerPreview(null);
    if (segmentationDraftRef.current && pointerSession && !pointerSession.captured) {
      safeReleasePointerCapture(pointerSession.captureTarget, pointerSession.pointerId);
      segmentationPointerSessionRef.current = null;
      setSegmentationDraftShape(null);
      segmentationDraftRef.current = null;
    }
  };

  const handleSegmentationStagePointerUp = (event) => {
    const pointerSession = segmentationPointerSessionRef.current;
    if (pointerSession
      && pointerSession.pointerId !== undefined
      && event.pointerId !== undefined
      && pointerSession.pointerId !== event.pointerId) return;
    const draft = segmentationDraftRef.current;
    if (!draft || draft.tool === 'polygon') return;
    event.preventDefault();
    event.stopPropagation();
    if (draft.tool === 'brush' || draft.tool === 'scissors') {
      if (draft.mode === '3d' && draft.tool === 'brush') {
        const spacing = getSegmentationVolumeSpacing();
        const inPlaneSpacing = draft.axis === 'coronal'
          ? [spacing[0], spacing[2]]
          : (draft.axis === 'sagittal' ? [spacing[1], spacing[2]] : [spacing[0], spacing[1]]);
        const physicalRadius = Math.max(
          Math.min(...inPlaneSpacing),
          (Number(draft.brushSize) / 2) * Math.min(...inPlaneSpacing),
        );
        const sphere = rasterizeSphereStroke({
          centers: draft.voxelCenters,
          radius: physicalRadius,
          dimensions: draft.volumeDimensions || getSegmentationVolumeDimensions(),
          spacing,
          maxRuns: 50000,
          maxVoxels: 250000,
        });
        const volumeShape = {
          ...draft,
          points: [],
          voxelCenters: undefined,
          volumeRuns: sphere.runs,
          voxelCount: sphere.voxelCount,
          spacing,
          truncated: sphere.truncated,
          truncationReason: sphere.reason,
        };
        if (sphere.runs.length > 0) {
          commitSegmentationShape(volumeShape, draft.operation);
          if (sphere.truncated) {
            setSegmentationVolumeStatus(
              `Sphere stroke was limited by ${sphere.reason || 'the volume guard'}; a partial stroke was applied.`,
            );
          }
        }
      } else if ((draft.points || []).length > 0) {
        commitSegmentationShape(draft, draft.operation);
      }
    } else {
      setSegmentationPendingSelection(draft);
      setSegmentationDraftShape(null);
      segmentationDraftRef.current = null;
    }
    safeReleasePointerCapture(pointerSession?.captureTarget || event.currentTarget, pointerSession?.pointerId ?? event.pointerId);
    segmentationPointerSessionRef.current = null;
  };

  const handleSegmentationStagePointerCancel = (event) => {
    const pointerSession = segmentationPointerSessionRef.current;
    if (pointerSession
      && pointerSession.pointerId !== undefined
      && event.pointerId !== undefined
      && pointerSession.pointerId !== event.pointerId) return;
    safeReleasePointerCapture(pointerSession?.captureTarget || event.currentTarget, pointerSession?.pointerId ?? event.pointerId);
    segmentationPointerSessionRef.current = null;
    setSegmentationPendingSelection(null);
    setSegmentationDraftShape(null);
    segmentationDraftRef.current = null;
  };

  const completeSegmentationPolygon = (event) => {
    if (segmentationTool !== 'polygon') return;
    const draft = segmentationDraftRef.current;
    if (!draft || draft.tool !== 'polygon' || (draft.points || []).length < 3) return;
    event.preventDefault();
    event.stopPropagation();
    const closed = { ...draft, closed: true };
    setSegmentationPendingSelection(closed);
    setSegmentationDraftShape(null);
    segmentationDraftRef.current = null;
  };

  const cancelSegmentationDraft = ({
    preservePendingSelection = false,
    preserveVolumeRequest = false,
  } = {}) => {
    const pointerSession = segmentationPointerSessionRef.current;
    if (pointerSession) {
      safeReleasePointerCapture(pointerSession.captureTarget, pointerSession.pointerId);
      segmentationPointerSessionRef.current = null;
    }
    if (!preserveVolumeRequest) {
      segmentationVolumeRequestRef.current.controller?.abort();
      segmentationVolumeRequestRef.current = {
        generation: segmentationVolumeRequestRef.current.generation + 1,
        controller: null,
        segmentId: '',
      };
      setSegmentationVolumeLoading(false);
    }
    setSegmentationDraftShape(null);
    if (!preservePendingSelection) setSegmentationPendingSelection(null);
    segmentationDraftRef.current = null;
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

  const toggleRenderCategory = (categoryId) => {
    setRenderCategories((prev) => (prev.includes(categoryId)
      ? prev.filter((entry) => entry !== categoryId)
      : [...prev, categoryId]));
  };
  const toggleViewVisibility = (viewName) => {
    const key = String(viewName || '').toLowerCase();
    if (!key) return;
    setHiddenViewNames((prev) => (prev.includes(key)
      ? prev.filter((entry) => entry !== key)
      : [...prev, key]));
  };

  const setAllViewVisibility = (viewNames = [], visible) => {
    const keys = viewNames.map((name) => String(name || '').toLowerCase()).filter(Boolean);
    if (keys.length === 0) return;
    setHiddenViewNames((prev) => {
      const next = new Set(prev.map((name) => String(name).toLowerCase()));
      keys.forEach((key) => {
        if (visible) next.delete(key); else next.add(key);
      });
      return Array.from(next);
    });
  };

  const setAllModalityVisibility = (modalities = [], visible) => {
    const keys = modalities.map((name) => String(name || '').toLowerCase()).filter(Boolean);
    if (keys.length === 0) return;
    setEnabledModalities((prev) => {
      const next = new Set(prev.map((name) => String(name).toLowerCase()));
      keys.forEach((key) => {
        if (visible) next.add(key); else next.delete(key);
      });
      return Array.from(next);
    });
  };

  const setAllLayerVisibility = (visible, layerAvailability = {}) => {
    setRenderCategories((prev) => {
      const next = new Set(prev);
      ['source', 'overlay', 'annotation', 'crop'].forEach((category) => {
        if (!layerAvailability[category]) return;
        if (visible) next.add(category); else next.delete(category);
      });
      return Array.from(next);
    });
    if (layerAvailability.annotation && visible) {
      setAnnotationsVisible(true);
    }
  };

  const toggleModalityVisibility = (modality) => {
    const key = String(modality || '').toLowerCase();
    if (!key) return;
    setEnabledModalities((prev) => {
      const normalized = prev.map((entry) => String(entry).toLowerCase());
      return normalized.includes(key)
        ? prev.filter((entry) => String(entry).toLowerCase() !== key)
        : [...prev, key];
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

  const resetAnnotationDraft = () => {
    setAnnotationDraft({
      defect_class: '',
      modality: enabledModalities[0] || modalityOptions[0] || 'visual',
      comment: '',
      disposition: 'open',
      measurement_name: '',
      measurement_value: '',
    });
  };

  const setTileAnnotationMode = (mode) => {
    setAnnotationToolMode((prev) => (prev === mode ? '' : mode));
    setTileAnnotationDraft(null);
    setTileAnnotationPreview(null);
    setTileCalibrationPromptImageId(null);
    tileAnnotationDraftRef.current = null;
    setMprAnnotationDraft(null);
    setMprAnnotationPreview(null);
    mprAnnotationDraftRef.current = null;
  };

  const openAnnotationEditModal = (annotation) => {
    if (!annotation?.id) return;
    setSelectedAnnotationId(annotation.id);
    setAnnotationEditDraft({
      id: annotation.id,
      defect_class: annotation.defect_class || '',
      comment: annotation.comment || '',
      disposition: annotation.disposition || 'open',
      color: getAnnotationColor(annotation),
      fill_opacity: getAnnotationFillOpacity(annotation),
    });
    setAnnotationEditModalVisible(true);
  };

  const closeAnnotationEditModal = () => {
    setAnnotationEditModalVisible(false);
    setAnnotationEditDraft(null);
  };

  const createAnnotation = async () => {
    if (!selectedPart?.id || !annotationDraft.defect_class.trim()) return;
    const mutationPartId = String(selectedPart.id);
    const mutationScope = `${projectId}:${mutationPartId}`;
    const mutationGeneration = activePartMutationGeneration;
    const measurementName = annotationDraft.measurement_name.trim();
    const measurementValue = Number(annotationDraft.measurement_value);
    const measurements = measurementName && Number.isFinite(measurementValue)
      ? { [measurementName]: Number(measurementValue.toFixed(2)) }
      : {};
    const payload = {
      defect_class: (annotationDraft.defect_class === 'Other' ? (customDefectTypeDraft.trim() || 'Other') : annotationDraft.defect_class).trim(),
      modality: (annotationDraft.modality || enabledModalities[0] || modalityOptions[0] || 'visual').trim(),
      comment: annotationDraft.comment.trim() || null,
      disposition: annotationDraft.disposition,
      measurements,
      hidden: false,
    };

    try {
      const resp = await fetch(`/api/projects/${projectId}/parts/${mutationPartId}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        throw new Error(`Failed to create annotation (${resp.status})`);
      }
      const created = await resp.json();
      if (!isActivePartMutation(mutationScope, mutationGeneration)) return created;
      setAnnotations((prev) => [created, ...prev]);
      resetAnnotationDraft();
      setOtherAnnotationModalVisible(false);
    } catch (err) {
      if (isActivePartMutation(mutationScope, mutationGeneration)) {
        setError(err.message || 'Failed to create annotation');
      }
    }
  };

  const createMeasurementAnnotation = async ({ imageId, line, name, color, distanceMm, modality, geometryPatch = {}, metadataPatch = {} }) => {
    if (!selectedPart?.id || !line || !line.imageWidth || !line.imageHeight) return;
    const mutationPartId = String(selectedPart.id);
    const mutationScope = `${projectId}:${mutationPartId}`;
    const mutationGeneration = activePartMutationGeneration;
    const annotationImageId = getAnnotationSourceImageIdForImage(imageId);
    const width = Math.abs(line.x2 - line.x1);
    const height = Math.abs(line.y2 - line.y1);
    const distancePixels = Math.sqrt((width ** 2) + (height ** 2));
    const payload = {
      annotation_kind: 'measurement',
      image_id: annotationImageId ? String(annotationImageId) : null,
      defect_class: 'Measurement',
      modality: modality || activeViewName || enabledModalities[0] || modalityOptions[0] || 'visual',
      comment: name || 'Captured from measurement tool.',
      disposition: 'open',
      measurements: { length_px: Number(distancePixels.toFixed(2)), ...(Number.isFinite(distanceMm) ? { length_mm: Number(distanceMm.toFixed(2)) } : {}) },
      geometry: { ...geometryPatch, line },
      metadata: { measurement_color: color, annotation_color: color, ...metadataPatch },
      bbox: {
        x: Number(Math.min(line.x1, line.x2).toFixed(2)),
        y: Number(Math.min(line.y1, line.y2).toFixed(2)),
        width: Number(width.toFixed(2)),
        height: Number(height.toFixed(2)),
      },
      hidden: false,
    };
    try {
      const resp = await fetch(`/api/projects/${projectId}/parts/${mutationPartId}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`Failed to create measurement annotation (${resp.status})`);
      const created = await resp.json();
      if (!isActivePartMutation(mutationScope, mutationGeneration)) return created;
      setAnnotations((prev) => [created, ...prev]);
      setSelectedAnnotationId(created.id);
      return created;
    } catch (err) {
      if (isActivePartMutation(mutationScope, mutationGeneration)) {
        setError(err.message || 'Failed to create measurement annotation');
      }
      return null;
    }
  };

	  const createBoxAnnotation = async ({ imageId, box, name, color, modality, defectClass = 'Bounding Box', geometryPatch = {}, metadataPatch = {} }) => {
	    if (!selectedPart?.id || !isFiniteAnnotationBox(box)) return null;
	    const mutationPartId = String(selectedPart.id);
	    const mutationScope = `${projectId}:${mutationPartId}`;
	    const mutationGeneration = activePartMutationGeneration;
	    const annotationImageId = getAnnotationSourceImageIdForImage(imageId);
	    const pixelsPerMm = Number(getCalibrationForImage(annotationImageId)?.pixels_per_mm || 0);
	    const widthMm = pixelsPerMm > 0 ? box.width / pixelsPerMm : null;
	    const heightMm = pixelsPerMm > 0 ? box.height / pixelsPerMm : null;
	    const payload = {
      image_id: annotationImageId ? String(annotationImageId) : null,
      defect_class: defectClass,
      modality: modality || activeViewName || enabledModalities[0] || modalityOptions[0] || 'visual',
      comment: name || 'Captured from draw box tool.',
      disposition: 'open',
	      measurements: {
	        width_px: Number(box.width.toFixed(2)),
	        height_px: Number(box.height.toFixed(2)),
	        ...(Number.isFinite(widthMm) ? { width_mm: Number(widthMm.toFixed(2)) } : {}),
	        ...(Number.isFinite(heightMm) ? { height_mm: Number(heightMm.toFixed(2)) } : {}),
	      },
      geometry: {
        ...geometryPatch,
        imageWidth: box.imageWidth,
        imageHeight: box.imageHeight,
        box: {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          imageWidth: box.imageWidth,
          imageHeight: box.imageHeight,
          ...(geometryPatch?.box || {}),
        },
      },
      metadata: { annotation_color: color, annotation_fill_opacity: DEFAULT_ANNOTATION_FILL_OPACITY, ...metadataPatch },
      bbox: {
        x: Number(box.x.toFixed(2)),
        y: Number(box.y.toFixed(2)),
        width: Number(box.width.toFixed(2)),
        height: Number(box.height.toFixed(2)),
      },
      hidden: false,
    };
    try {
      const resp = await fetch(`/api/projects/${projectId}/parts/${mutationPartId}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`Failed to create box annotation (${resp.status})`);
      const created = await resp.json();
      if (!isActivePartMutation(mutationScope, mutationGeneration)) return created;
      setAnnotations((prev) => [created, ...prev]);
      setSelectedAnnotationId(created.id);
      return created;
    } catch (err) {
      if (isActivePartMutation(mutationScope, mutationGeneration)) {
        setError(err.message || 'Failed to create box annotation');
      }
      return null;
    }
  };

  const createCubeAnnotation = async ({ axis, firstBox, secondBox, color }) => {
    if (!selectedPart?.id || !axis || !isFiniteAnnotationBox(firstBox) || !isFiniteAnnotationBox(secondBox)) return null;
    const mutationPartId = String(selectedPart.id);
    const mutationScope = `${projectId}:${mutationPartId}`;
    const mutationGeneration = activePartMutationGeneration;
    const firstSlice = Number(firstBox.sliceIndex);
    const secondSlice = Number(secondBox.sliceIndex);
    if (!Number.isFinite(firstSlice) || !Number.isFinite(secondSlice) || firstSlice === secondSlice) return null;
    const x = Math.min(firstBox.x, secondBox.x);
    const y = Math.min(firstBox.y, secondBox.y);
    const right = Math.max(firstBox.x + firstBox.width, secondBox.x + secondBox.width);
    const bottom = Math.max(firstBox.y + firstBox.height, secondBox.y + secondBox.height);
    const width = right - x;
    const height = bottom - y;
    const cube = {
      axis,
      startSlice: Math.min(firstSlice, secondSlice),
      endSlice: Math.max(firstSlice, secondSlice),
      x,
      y,
      width,
      height,
      imageWidth: secondBox.imageWidth || firstBox.imageWidth,
      imageHeight: secondBox.imageHeight || firstBox.imageHeight,
      firstBox,
      secondBox,
      vertices: makeMprCubeVertices(axis, firstBox, secondBox),
    };
    const payload = {
      image_id: null,
      defect_class: '3D Box',
      modality: 'volume',
      comment: 'Captured from 3D box tool.',
      disposition: 'open',
      measurements: {
        width_px: Number(width.toFixed(2)),
        height_px: Number(height.toFixed(2)),
        depth_slices: Math.abs(secondSlice - firstSlice),
      },
      geometry: { cube },
      metadata: { annotation_color: color, annotation_fill_opacity: DEFAULT_ANNOTATION_FILL_OPACITY },
      bbox: {
        x: Number(x.toFixed(2)),
        y: Number(y.toFixed(2)),
        width: Number(width.toFixed(2)),
        height: Number(height.toFixed(2)),
      },
      hidden: false,
    };
    try {
      const resp = await fetch(`/api/projects/${projectId}/parts/${mutationPartId}/annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`Failed to create 3D annotation (${resp.status})`);
      const created = await resp.json();
      if (!isActivePartMutation(mutationScope, mutationGeneration)) return created;
      setAnnotations((prev) => [created, ...prev]);
      setSelectedAnnotationId(created.id);
      return created;
    } catch (err) {
      if (isActivePartMutation(mutationScope, mutationGeneration)) {
        setError(err.message || 'Failed to create 3D annotation');
      }
      return null;
    }
  };

  const updateMeasurementAnnotationLine = async (lineId, nextLine) => {
    if (!selectedPart?.id || !lineId || !isFiniteMeasurementLine(nextLine)) return null;
    const mutationPartId = String(selectedPart.id);
    const mutationScope = `${projectId}:${mutationPartId}`;
    const mutationGeneration = activePartMutationGeneration;
    const existingAnnotation = annotations.find((annotation) => String(annotation.id) === String(lineId));
    const annotationImageId = getAnnotationSourceImageIdForImage(
      existingAnnotation?.image_id || nextLine.imageId || fullscreenBackingImageId,
    );
    const calibratedLine = getMeasurementLineWithDerivedLength(
      nextLine,
      annotationImageId,
      getCalibrationForImage(annotationImageId),
    );
    const width = Math.abs(calibratedLine.x2 - calibratedLine.x1);
    const height = Math.abs(calibratedLine.y2 - calibratedLine.y1);
    const measurements = {
      length_px: Number(calibratedLine.distancePx.toFixed(2)),
      ...(Number.isFinite(calibratedLine.distanceMm) ? { length_mm: Number(calibratedLine.distanceMm.toFixed(2)) } : {}),
    };
    const payload = {
      image_id: annotationImageId || calibratedLine.imageId,
      geometry: { ...(existingAnnotation?.geometry || {}), line: calibratedLine },
      measurements,
      metadata: {
        ...(existingAnnotation?.metadata || {}),
        measurement_color: nextLine.color,
        annotation_color: nextLine.color,
      },
      bbox: {
        x: Number(Math.min(calibratedLine.x1, calibratedLine.x2).toFixed(2)),
        y: Number(Math.min(calibratedLine.y1, calibratedLine.y2).toFixed(2)),
        width: Number(width.toFixed(2)),
        height: Number(height.toFixed(2)),
      },
    };
    try {
      const resp = await fetch(`/api/projects/${projectId}/parts/${mutationPartId}/annotations/${lineId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`Failed to update measurement annotation (${resp.status})`);
      const updated = await resp.json();
      if (!isActivePartMutation(mutationScope, mutationGeneration)) return updated;
      setAnnotations((prev) => prev.map((item) => (String(item.id) === String(updated.id) ? updated : item)));
      setFullscreenMeasurements((prev) => prev.map((item) => (String(item.id) === String(lineId)
        ? {
          ...item,
          ...calibratedLine,
          color: nextLine.color,
          distancePx: calibratedLine.distancePx,
          distanceMm: calibratedLine.distanceMm,
        }
        : item)));
      setSelectedAnnotationId(updated.id);
      return updated;
    } catch (err) {
      if (isActivePartMutation(mutationScope, mutationGeneration)) {
        setError(err.message || 'Failed to update measurement annotation');
      }
      return null;
    }
  };

  const updateBoxAnnotationGeometry = async (boxId, nextBox) => {
    if (!selectedPart?.id || !boxId || !isFiniteAnnotationBox(nextBox)) return null;
    const mutationPartId = String(selectedPart.id);
    const mutationScope = `${projectId}:${mutationPartId}`;
    const mutationGeneration = activePartMutationGeneration;
    const existingAnnotation = annotations.find((annotation) => String(annotation.id) === String(boxId));
    const annotationImageId = getAnnotationSourceImageIdForImage(
      existingAnnotation?.image_id || nextBox.imageId || fullscreenBackingImageId,
    );
    const pixelsPerMm = Number(getCalibrationForImage(annotationImageId)?.pixels_per_mm || 0);
    const widthMm = pixelsPerMm > 0 ? nextBox.width / pixelsPerMm : null;
    const heightMm = pixelsPerMm > 0 ? nextBox.height / pixelsPerMm : null;
    const measurements = {
      width_px: Number(nextBox.width.toFixed(2)),
      height_px: Number(nextBox.height.toFixed(2)),
      ...(Number.isFinite(widthMm) ? { width_mm: Number(widthMm.toFixed(2)) } : {}),
      ...(Number.isFinite(heightMm) ? { height_mm: Number(heightMm.toFixed(2)) } : {}),
    };
    const payload = {
      image_id: annotationImageId ? String(annotationImageId) : null,
      geometry: {
        ...(existingAnnotation?.geometry || {}),
        imageWidth: nextBox.imageWidth,
        imageHeight: nextBox.imageHeight,
        ...(nextBox.axis ? { axis: nextBox.axis, slice_index: nextBox.sliceIndex } : {}),
        box: {
          x: nextBox.x,
          y: nextBox.y,
          width: nextBox.width,
          height: nextBox.height,
          imageWidth: nextBox.imageWidth,
          imageHeight: nextBox.imageHeight,
          ...(nextBox.axis ? { axis: nextBox.axis, slice_index: nextBox.sliceIndex } : {}),
        },
      },
      measurements,
      metadata: { ...(existingAnnotation?.metadata || {}), annotation_color: nextBox.color },
      bbox: {
        x: Number(nextBox.x.toFixed(2)),
        y: Number(nextBox.y.toFixed(2)),
        width: Number(nextBox.width.toFixed(2)),
        height: Number(nextBox.height.toFixed(2)),
      },
    };
    try {
      const resp = await fetch(`/api/projects/${projectId}/parts/${mutationPartId}/annotations/${boxId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) throw new Error(`Failed to update box annotation (${resp.status})`);
      const updated = await resp.json();
      if (!isActivePartMutation(mutationScope, mutationGeneration)) return updated;
      setAnnotations((prev) => prev.map((item) => (String(item.id) === String(updated.id) ? updated : item)));
      setSelectedAnnotationId(updated.id);
      return updated;
    } catch (err) {
      if (isActivePartMutation(mutationScope, mutationGeneration)) {
        setError(err.message || 'Failed to update box annotation');
      }
      return null;
    }
  };

  const deleteMeasurementAnnotation = async (lineId) => {
    if (!selectedPart?.id || !lineId) return;
    const mutationPartId = String(selectedPart.id);
    const mutationScope = `${projectId}:${mutationPartId}`;
    const mutationGeneration = activePartMutationGeneration;
    const annotation = annotations.find((candidate) => String(candidate.id) === String(lineId));
    if (annotation && isVistaSegmentAnnotation(annotation)) {
      await deleteSegmentationSegment(lineId);
      return;
    }
    try {
      const resp = await fetch(`/api/projects/${projectId}/parts/${mutationPartId}/annotations/${lineId}`, {
        method: 'DELETE',
      });
      if (!resp.ok) throw new Error(`Failed to delete measurement annotation (${resp.status})`);
      if (!isActivePartMutation(mutationScope, mutationGeneration)) return;
      setAnnotations((prev) => prev.filter((item) => String(item.id) !== String(lineId)));
      setFullscreenMeasurements((prev) => prev.filter((item) => String(item.id) !== String(lineId)));
      setSelectedAnnotationId((prev) => (String(prev) === String(lineId) ? null : prev));
      setFullscreenBoundsEditAnnotationId((prev) => (String(prev) === String(lineId) ? null : prev));
      setFullscreenEditingEndpoint((prev) => (String(prev?.lineId) === String(lineId) ? null : prev));
      setFullscreenEditingBoxCorner((prev) => (String(prev?.boxId) === String(lineId) ? null : prev));
    } catch (err) {
      if (isActivePartMutation(mutationScope, mutationGeneration)) {
        setError(err.message || 'Failed to delete measurement annotation');
      }
    }
  };

  const createCropChildImage = async ({ parentImageId, cropBox, cropAnnotationId = '', title = '' }) => {
    if (!selectedPart?.id || !parentImageId || !isFiniteAnnotationBox(cropBox)) return null;
    const parentImage = projectImageLookup[parentImageId] || {};
    const parentFilename = parentImage.filename || parentImageId || 'image';
    const parentSourceRecord = (Array.isArray(selectedPart?.metadata?.source_images) ? selectedPart.metadata.source_images : [])
      .find((record) => [record?.image_id, record?.filename]
        .map((value) => String(value || '').trim())
        .includes(String(parentImageId || '').trim())
        || String(record?.filename || '').trim() === String(parentFilename || '').trim());
    const parentModality = String(parentImage.modality || parentImage.metadata?.modality || parentSourceRecord?.modality || parentSourceRecord?.metadata?.modality || 'visual').trim().toLowerCase() || 'visual';
    const cropFilename = getCropUploadFilename(cropBox, parentFilename);
    const cropTitle = title || getCropImageTitle(cropBox, parentFilename);
    setError(null);
    try {
      const sourceImage = await loadImageElement(`/api/images/${encodeURIComponent(String(parentImageId))}/content`);
      const naturalWidth = Number(sourceImage.naturalWidth || sourceImage.width || cropBox.imageWidth || 0);
      const naturalHeight = Number(sourceImage.naturalHeight || sourceImage.height || cropBox.imageHeight || 0);
      if (!Number.isFinite(naturalWidth) || !Number.isFinite(naturalHeight) || naturalWidth <= 0 || naturalHeight <= 0) {
        throw new Error('Source image dimensions are unavailable for crop');
      }
      const sourceWidth = cropBox.imageWidth || naturalWidth;
      const sourceHeight = cropBox.imageHeight || naturalHeight;
      const scaleX = naturalWidth / sourceWidth;
      const scaleY = naturalHeight / sourceHeight;
      const sx = Math.max(0, Math.min(naturalWidth - 1, cropBox.x * scaleX));
      const sy = Math.max(0, Math.min(naturalHeight - 1, cropBox.y * scaleY));
      const sw = Math.max(1, Math.min(naturalWidth - sx, cropBox.width * scaleX));
      const sh = Math.max(1, Math.min(naturalHeight - sy, cropBox.height * scaleY));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sw));
      canvas.height = Math.max(1, Math.round(sh));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Unable to prepare crop canvas');
      context.drawImage(sourceImage, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const blob = await canvasToBlob(canvas, 'image/png');
      const metadata = {
        crop_child_image: true,
        parent_image_id: String(parentImageId),
        parent_image_filename: parentFilename,
        crop_annotation_id: cropAnnotationId ? String(cropAnnotationId) : '',
        crop_title: cropTitle,
        crop_subtitle: '',
        crop_bbox: {
          x: cropBox.x,
          y: cropBox.y,
          width: cropBox.width,
          height: cropBox.height,
          imageWidth: cropBox.imageWidth || naturalWidth,
          imageHeight: cropBox.imageHeight || naturalHeight,
        },
        part_id: String(selectedPart.id),
        serial_number: selectedPart.serial_number || '',
        modality: parentModality,
        side: 'crop',
      };
      const formData = new FormData();
      formData.append('file', blob, cropFilename);
      formData.append('metadata', JSON.stringify(metadata));
      const uploadResp = await fetch(`/api/projects/${projectId}/images`, {
        method: 'POST',
        body: formData,
      });
      if (!uploadResp.ok) throw new Error(`Failed to upload cropped image (${uploadResp.status})`);
      const createdImage = await uploadResp.json();
      const assignResp = await fetch(`/api/projects/${projectId}/parts/image-assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: createdImage.filename || cropFilename, to_part_id: selectedPart.id }),
      });
      if (!assignResp.ok) throw new Error(`Failed to add crop to inspection workbench (${assignResp.status})`);
      const sourceEntry = {
        filename: createdImage.filename || cropFilename,
        image_id: String(createdImage.id || ''),
        side: 'crop',
        modality: parentModality,
        overlay: false,
        crop_child_image: true,
        parent_image_id: String(parentImageId),
        parent_image_filename: parentFilename,
        crop_annotation_id: cropAnnotationId ? String(cropAnnotationId) : '',
        crop_title: cropTitle,
        crop_subtitle: '',
        crop_bbox: metadata.crop_bbox,
      };
      setProjectImageLookup((prev) => ({
        ...prev,
        [sourceEntry.filename]: createdImage,
        [sourceEntry.image_id]: createdImage,
      }));
      setParts((prev) => prev.map((part) => {
        if (String(part.id) !== String(selectedPart.id)) return part;
        const existingSourceImages = Array.isArray(part.metadata?.source_images) ? part.metadata.source_images : [];
        const withoutDuplicate = existingSourceImages.filter((record) => String(record?.image_id || record?.filename || '') !== String(sourceEntry.image_id));
        return {
          ...part,
          metadata: {
            ...(part.metadata || {}),
            source_images: [...withoutDuplicate, sourceEntry],
          },
        };
      }));
      setEnabledModalities((prev) => {
        const normalized = prev.map((entry) => String(entry).toLowerCase());
        return normalized.includes(parentModality) ? prev : [...prev, parentModality];
      });
      setSelectedImageRef(sourceEntry.image_id || sourceEntry.filename);
      return sourceEntry;
    } catch (err) {
      setError(err.message || 'Failed to create crop child image');
      return null;
    }
  };

  const cropBoxAnnotation = async (annotation) => {
    if (!selectedPart?.id || !annotation?.id || !isBoundingBoxAnnotation(annotation)) return;
    const cropBox = getAnnotationCropBox(annotation);
    if (!cropBox) return;
    const annotationImageId = getAnnotationSourceImageIdForImage(annotation.image_id || annotation.imageId || annotation?.geometry?.image_id);
    if (!annotationImageId) throw new Error('Annotation source image is unavailable for crop');
    setCroppingAnnotationId(annotation.id);
    try {
      await createCropChildImage({
        parentImageId: annotationImageId,
        cropBox,
        cropAnnotationId: annotation.id,
        title: getCropImageTitle(annotation, (projectImageLookup[annotationImageId] || {}).filename || annotationImageId || 'image'),
      });
    } finally {
      setCroppingAnnotationId(null);
    }
  };

  const updateCropChildSubtitle = async (entry, subtitle) => {
    if (!selectedPart?.id || !entry?.cropChild) return;
    const imageKey = String(entry.imageId || entry.imageRef || entry.filename || '');
    setParts((prev) => prev.map((part) => {
      if (String(part.id) !== String(selectedPart.id)) return part;
      const sourceImages = Array.isArray(part.metadata?.source_images) ? part.metadata.source_images : [];
      return {
        ...part,
        metadata: {
          ...(part.metadata || {}),
          source_images: sourceImages.map((record) => {
            const recordKey = String(record?.image_id || record?.filename || '');
            return recordKey === imageKey ? { ...record, crop_subtitle: subtitle } : record;
          }),
        },
      };
    }));
    try {
      const resp = await fetch(`/api/projects/${projectId}/parts/${selectedPart.id}/source-images/${encodeURIComponent(imageKey)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crop_subtitle: subtitle }),
      });
      if (!resp.ok) throw new Error(`Failed to save crop subtitle (${resp.status})`);
    } catch (err) {
      setError(err.message || 'Failed to save crop subtitle');
    }
  };

  const setInspectionItemVisibility = async (item, visible) => {
    if (!selectedPart?.id || !item?.source) return;
    const mutationPartId = String(selectedPart.id);
    const mutationScope = `${projectId}:${mutationPartId}`;
    const mutationGeneration = activePartMutationGeneration;
    const hidden = !visible;
    if (item.source.resource === 'annotation') {
      if (item.kind === 'vista_segment') {
        const segment = segmentationSegments.find((candidate) => (
          String(candidate.id) === String(item.source.resourceId)
          || String(candidate.annotationId) === String(item.source.resourceId)
        )) || annotationToSegmentationHelperSegment(item.annotation);
        if (segment) {
          const nextSegment = { ...segment, visible };
          updateSegmentationSegment(segment.id, nextSegment);
          await persistSegmentationSegment(nextSegment);
          return;
        }
      }
      try {
        const resp = await fetch(
          `/api/projects/${projectId}/parts/${mutationPartId}/annotations/${encodeURIComponent(String(item.source.resourceId))}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hidden }),
          },
        );
        if (!resp.ok) throw new Error(`Failed to update annotation visibility (${resp.status})`);
        const updated = await resp.json();
        if (!isActivePartMutation(mutationScope, mutationGeneration)) return;
        setAnnotations((prev) => prev.map((annotation) => (
          String(annotation.id) === String(updated.id) ? updated : annotation
        )));
      } catch (err) {
        if (isActivePartMutation(mutationScope, mutationGeneration)) {
          setError(err.message || 'Failed to update annotation visibility');
        }
      }
      return;
    }
    if (item.source.resource === 'source_image') {
      try {
        const resp = await fetch(
          `/api/projects/${projectId}/parts/${mutationPartId}/source-images/${encodeURIComponent(String(item.source.resourceId))}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hidden }),
          },
        );
        if (!resp.ok) throw new Error(`Failed to update overlay visibility (${resp.status})`);
        const updatedPart = await resp.json();
        setParts((prev) => prev.map((part) => (
          String(part.id) === String(updatedPart.id) ? updatedPart : part
        )));
      } catch (err) {
        if (isActivePartMutation(mutationScope, mutationGeneration)) {
          setError(err.message || 'Failed to update overlay visibility');
        }
      }
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
            <option value="reject_confirmed">Reject</option>
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
                    const imageEntries = Object.entries(viewImages)
                      .filter(([viewName, imageRef]) => isInspectionImageRefLoaded({
                        imageRef: String(imageRef || ''),
                        filename: String(imageRef || ''),
                        viewName,
                      }, projectImageLookup));
                    const partImageRefs = getPartImageRefs(part)
                      .filter((entry) => isInspectionImageRefLoaded(entry, projectImageLookup));
                    const partModalities = getPartSummaryModalities(part, partImageRefs);
                    const hasAnalyzeOverlays = partImageRefs.some((entry) => entry.overlay);
                    const hasCropImages = partImageRefs.some((entry) => entry.cropChild);
                    const hasAnnotations = (Array.isArray(part.metadata?.annotations) && part.metadata.annotations.length > 0) || (Array.isArray(annotations) && annotations.length > 0);
                    const isSourceCategoryVisible = renderCategories.includes('source');
                    const isOverlayCategoryVisible = renderCategories.includes('overlay');
                    const isAnnotationCategoryVisible = annotationsVisible && renderCategories.includes('annotation');
                    const isCropCategoryVisible = renderCategories.includes('crop');
                    const showViewsRow = isUiSectionEnabled(projectConfiguration, 'inspection.part_summary.views_row');
                    const showModalitiesRow = isUiSectionEnabled(projectConfiguration, 'inspection.part_summary.modalities_row');
                    const showLayersRow = isUiSectionEnabled(projectConfiguration, 'inspection.part_summary.layers_row');
                    const allViewsVisible = imageEntries.every(([viewName]) => !hiddenViewNames.includes(String(viewName).toLowerCase()));
                    const enabledModalityKeys = enabledModalities.map((entry) => String(entry).toLowerCase());
                    const allModalitiesVisible = partModalities.every((modality) => enabledModalityKeys.includes(String(modality).toLowerCase()));
                    const allLayersVisible = (!partImageRefs.some((entry) => !entry.overlay && !entry.cropChild) || isSourceCategoryVisible)
                      && (!hasAnalyzeOverlays || isOverlayCategoryVisible)
                      && (!hasAnnotations || isAnnotationCategoryVisible)
                      && (!hasCropImages || isCropCategoryVisible);
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
                          {showViewsRow && imageEntries.length > 0 && (
                            <div className="part-summary-chip-group">
                              <span className="part-summary-chip-label">Views</span>
                              <div className="part-summary-images" aria-label={`${part.display_name || part.serial_number} view toggles`}>
                                {imageEntries.map(([viewName, imageRef]) => {
                                  const normalizedViewName = String(viewName).toLowerCase();
                                  const isHidden = hiddenViewNames.includes(normalizedViewName);
                                  return (
                                    <button
                                      type="button"
                                      key={`${part.id}-${viewName}`}
                                      className={`btn btn-secondary btn-sm ${isSelected && activeViewName === normalizedViewName ? 'active' : ''} ${isHidden ? 'muted-toggle' : ''}`}
                                      aria-pressed={!isHidden}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setSelectedPartId(part.id);
                                        toggleViewVisibility(viewName);
                                        setSelectedViewName(normalizedViewName);
                                        setSelectedImageRef(String(imageRef || ''));
                                      }}
                                    >
                                      {viewName.toUpperCase()}
                                    </button>
                                  );
                                })}
                                <button type="button" className={`btn btn-secondary btn-sm part-summary-all-toggle ${allViewsVisible ? 'active' : 'muted-toggle'}`} aria-pressed={allViewsVisible} onClick={(event) => { event.stopPropagation(); setSelectedPartId(part.id); setAllViewVisibility(imageEntries.map(([viewName]) => viewName), !allViewsVisible); }}>ALL</button>
                              </div>
                            </div>
                          )}
                          {showModalitiesRow && partModalities.length > 0 && (
                            <div className="part-summary-chip-group">
                              <span className="part-summary-chip-label">Modalities</span>
                              <div className="part-summary-images part-summary-modalities" aria-label={`${part.display_name || part.serial_number} modality toggles`}>
                                {partModalities.map((modality) => {
                                  const normalizedModality = String(modality).toLowerCase();
                                  const isEnabled = enabledModalities.map((entry) => String(entry).toLowerCase()).includes(normalizedModality);
                                  const matchingImage = partImageRefs.find((entry) => String(entry.modality || '').toLowerCase() === normalizedModality);
                                  return (
                                    <button
                                      type="button"
                                      key={`${part.id}-modality-${normalizedModality}`}
                                      className={`btn btn-secondary btn-sm ${isEnabled ? 'active' : 'muted-toggle'}`}
                                      aria-pressed={isEnabled}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setSelectedPartId(part.id);
                                        if (matchingImage?.overlay && !isEnabled) {
                                          setRenderCategories((prev) => (prev.includes('overlay') ? prev : [...prev, 'overlay']));
                                        }
                                        toggleModalityVisibility(normalizedModality);
                                        if (matchingImage) {
                                          setSelectedViewName(String(matchingImage.viewName || '').toLowerCase());
                                          setSelectedImageRef(String(matchingImage.imageRef || matchingImage.imageId || ''));
                                        }
                                      }}
                                    >
                                      {normalizedModality.toUpperCase()}
                                    </button>
                                  );
                                })}
                                <button type="button" className={`btn btn-secondary btn-sm part-summary-all-toggle ${allModalitiesVisible ? 'active' : 'muted-toggle'}`} aria-pressed={allModalitiesVisible} onClick={(event) => { event.stopPropagation(); setSelectedPartId(part.id); setAllModalityVisibility(partModalities, !allModalitiesVisible); }}>ALL</button>
                              </div>
                            </div>
                          )}
                          {showLayersRow && (partImageRefs.length > 0 || hasAnalyzeOverlays || hasAnnotations || hasCropImages) && (
                            <div className="part-summary-chip-group">
                              <span className="part-summary-chip-label">Layers</span>
                              <div className="part-summary-images part-summary-layers" aria-label={`${part.display_name || part.serial_number} layer toggles`}>
                                {partImageRefs.some((entry) => !entry.overlay && !entry.cropChild) && (
                                  <button
                                    type="button"
                                    className={`btn btn-secondary btn-sm ${isSourceCategoryVisible ? 'active' : 'muted-toggle'}`}
                                    aria-pressed={isSourceCategoryVisible}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setSelectedPartId(part.id);
                                      toggleRenderCategory('source');
                                    }}
                                  >
                                    SOURCE
                                  </button>
                                )}
                                {hasAnalyzeOverlays && (
                                  <button
                                    type="button"
                                    className={`btn btn-secondary btn-sm ${isOverlayCategoryVisible ? 'active' : 'muted-toggle'}`}
                                    aria-pressed={isOverlayCategoryVisible}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setSelectedPartId(part.id);
                                      toggleRenderCategory('overlay');
                                    }}
                                  >
                                    OVERLAY
                                  </button>
                                )}

                                {hasAnnotations && (
                                  <button
                                    type="button"
                                    className={`btn btn-secondary btn-sm ${isAnnotationCategoryVisible ? 'active' : 'muted-toggle'}`}
                                    aria-pressed={isAnnotationCategoryVisible}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setSelectedPartId(part.id);
                                      toggleRenderCategory('annotation');
                                      setAnnotationsVisible(true);
                                    }}
                                  >
                                    ANNOTATION
                                  </button>
                                )}
                                {hasCropImages && (
                                  <button
                                    type="button"
                                    className={`btn btn-secondary btn-sm ${isCropCategoryVisible ? 'active' : 'muted-toggle'}`}
                                    aria-pressed={isCropCategoryVisible}
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setSelectedPartId(part.id);
                                      toggleRenderCategory('crop');
                                    }}
                                  >
                                    CROP
                                  </button>
                                )}
                                <button type="button" className={`btn btn-secondary btn-sm part-summary-all-toggle ${allLayersVisible ? 'active' : 'muted-toggle'}`} aria-pressed={allLayersVisible} onClick={(event) => { event.stopPropagation(); setSelectedPartId(part.id); setAllLayerVisibility(!allLayersVisible, { source: partImageRefs.some((entry) => !entry.overlay && !entry.cropChild), overlay: hasAnalyzeOverlays, annotation: hasAnnotations, crop: hasCropImages }); }}>ALL</button>

                              </div>
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

  const renderSplatConfigurationModal = () => {
    if (!splatConfigModalOpen || !selectedPart) return null;
    const defaults = getDefaultSplatParameters(selectedPart, displayValueDomain);
    const domain = getNormalizedDisplayDomain(displayValueDomain);
    const draft = splatParameters;
    const updateDraft = (patch) => {
      setSplatParameterOverridesByPart((previous) => ({
        ...previous,
        [selectedPart.id]: {
          ...(previous[selectedPart.id] || {}),
          ...patch,
        },
      }));
    };
    const resetDefaults = () => {
      setSplatParameterOverridesByPart((previous) => {
        const next = { ...previous };
        delete next[selectedPart.id];
        return next;
      });
    };
    return (
      <div className="modal-backdrop" role="presentation">
        <div className="modal-content splat-config-modal" role="dialog" aria-modal="true" aria-labelledby="splat-config-title">
          <div className="modal-header">
            <h3 id="splat-config-title">Simplified 3DGS configuration</h3>
            <button type="button" className="modal-close" aria-label="Close splat configuration" onClick={() => setSplatConfigModalOpen(false)}>×</button>
          </div>
          <p className="muted">
            Defaults are derived from loaded mechanical-part image metadata: {formatWindowValue(domain.min)}-{formatWindowValue(domain.max)} {domain.label}, with a histogram-aware threshold when available.
          </p>
          <div className="splat-config-grid">
            <label htmlFor="splat-threshold">
              Intensity threshold
              <input
                id="splat-threshold"
                type="number"
                min={domain.min}
                max={domain.max}
                step={domain.step}
                value={draft.threshold}
                onChange={(event) => updateDraft({ threshold: Number(event.target.value) })}
              />
            </label>
            <label htmlFor="splat-downsample">
              Downsample stride
              <input
                id="splat-downsample"
                type="number"
                min="1"
                step="1"
                value={draft.downsample}
                onChange={(event) => updateDraft({ downsample: Math.max(1, Number(event.target.value) || 1) })}
              />
            </label>
            <label htmlFor="splat-max-count">
              Maximum splats
              <input
                id="splat-max-count"
                type="number"
                min="1"
                max="100000"
                step="1000"
                value={draft.maxSplats}
                onChange={(event) => updateDraft({
                  maxSplats: Math.min(100000, Math.max(1, Number(event.target.value) || defaults.maxSplats)),
                })}
              />
            </label>
            <label htmlFor="splat-output-format">
              Output format
              <select
                id="splat-output-format"
                value={draft.outputFormat}
                onChange={(event) => updateDraft({ outputFormat: event.target.value })}
              >
                <option value="ply">PLY</option>
                <option value="splat">SPLAT JSON</option>
                <option value="json">Metadata JSON</option>
              </select>
            </label>
            <label htmlFor="splat-opacity-min">
              Min opacity
              <input
                id="splat-opacity-min"
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={draft.opacityMin}
                onChange={(event) => updateDraft({ opacityMin: clampRange(Number(event.target.value), 0, 1, defaults.opacityMin) })}
              />
            </label>
            <label htmlFor="splat-opacity-max">
              Max opacity
              <input
                id="splat-opacity-max"
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={draft.opacityMax}
                onChange={(event) => updateDraft({ opacityMax: clampRange(Number(event.target.value), 0, 1, defaults.opacityMax) })}
              />
            </label>
          </div>
          <div className="splat-config-summary" data-testid="splat-config-summary">
            Using threshold {formatWindowValue(draft.threshold)}, stride {draft.downsample}, max {draft.maxSplats.toLocaleString()} splats. Defaults: threshold {formatWindowValue(defaults.threshold)}, stride {defaults.downsample}.
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={resetDefaults}>Reset intelligent defaults</button>
            <button type="button" className="btn btn-primary" onClick={() => setSplatConfigModalOpen(false)}>Apply splat parameters</button>
          </div>
        </div>
      </div>
    );
  };

  const renderMprPane = () => (
    <section className="mpr-shell" data-testid="mpr-panel" aria-label="Multi-Planar Reconstruction">
      {!selectedPart ? (
        <p className="muted">No part selected. Select a part to inspect the volume.</p>
      ) : (
        <>
          <div className="mpr-control-strip">
            {projectType === 'PT3' && filteredParts.length > 1 && (
              <label htmlFor="mpr-part-selector" className="mpr-part-selector">
                Part
                <select
                  id="mpr-part-selector"
                  data-testid="mpr-part-selector"
                  value={selectedPart?.id || ''}
                  onChange={(event) => setSelectedPartId(event.target.value)}
                >
                  {filteredParts.map((part) => (
                    <option key={part.id} value={part.id}>
                      {part.display_name || part.serial_number || part.id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <DisplayWindowControl
              displayWindow={displayWindow}
              displayDomain={displayValueDomain}
              onChange={setDisplayWindow}
            />
            <span className="group-badge">{formatWindowValue(displayWindow.min)}-{formatWindowValue(displayWindow.max)}</span>
            <label className="mpr-reconstruction-selector" htmlFor="mpr-reconstruction-mode">
              3D view
              <select
                id="mpr-reconstruction-mode"
                value={mprReconstructionSelectorValue}
                onChange={(event) => {
                  const selectedValue = event.target.value;
                  if (selectedValue.startsWith(RAY_MARCH_SELECTOR_PREFIX)) {
                    const reconstructionStyle = selectedValue.slice(RAY_MARCH_SELECTOR_PREFIX.length);
                    if (RAY_MARCH_RECONSTRUCTION_IDS.has(reconstructionStyle)) {
                      setMprReconstructionMode(MPR_RECONSTRUCTION_MODES.volume3d);
                      setRayMarchSettings((current) => ({
                        ...current,
                        reconstructionStyle,
                      }));
                    }
                    return;
                  }
                  setMprReconstructionMode(normalizeMprReconstructionMode(selectedValue));
                }}
              >
                <option value={MPR_RECONSTRUCTION_MODES.orientation}>Orientation only</option>
                <option value={MPR_RECONSTRUCTION_MODES.stack} disabled={!canShowStackReconstruction}>
                  Stack reconstruction
                </option>
                <optgroup label="Ray marching">
                  {RAY_MARCH_RECONSTRUCTION_OPTIONS.map(({ value, label }) => (
                    <option
                      key={value}
                      value={`${RAY_MARCH_SELECTOR_PREFIX}${value}`}
                      disabled={!canShowGaussianSplatPreview}
                    >
                      {label}
                    </option>
                  ))}
                </optgroup>
                <option value={MPR_RECONSTRUCTION_MODES.realSplat} disabled={!canShowGaussianSplatPreview}>
                  Real 3DGS
                </option>
              </select>
            </label>
            <span className="mpr-probe-readout">Probe {tooltipValues.base}</span>
            <div className="mpr-ml-actions">
              {projectType === 'PT3' && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={openSegmentationHelper}
                  disabled={!selectedPart}
                >
                  Segmentation Helpers
                </button>
              )}
            </div>
          </div>
          {volumeMetadataProbeState.warning && (
            <div className="alert alert-warning" role="alert" data-testid="volume-metadata-probe-warning">
              {volumeMetadataProbeState.warning}
            </div>
          )}
          <div className="mpr-grid mpr-grid-four" data-testid="mpr-grid">
            {volumeMetadataProbeState.pending && (
              <div className="mpr-grid-loading" role="status" aria-live="polite" data-testid="volume-metadata-probe-loading">
                <strong>Inspecting volume metadata…</strong>
                <small>VISTA is confirming volume dimensions and color channels before rendering.</small>
              </div>
            )}
            {volumeCacheState.status === 'loading' && hasVolumeImageSource && (
              <div className="mpr-grid-loading" role="status" aria-live="polite">
                <strong>Preparing MPR slices…</strong>
                <span>{getMprSliceCachingMessage(volumeCacheState.progress)}</span>
                <small>VISTA is loading the volume stack. Slice views will appear when caching completes.</small>
              </div>
            )}
            {MPR_AXES.map((axis) => {
              const upper = Math.max(0, (mprDimensions[axis] || 1) - 1);
              const config = MPR_AXIS_CONFIG[axis];
              const label = config?.label || MPR_AXIS_LABELS[axis] || axis.toUpperCase();
              const isMirrored = mprProjectionMirror[axis] === true;
              const crosshairStyle = getMprCrosshairStyle(axis, slicePosition, mprDimensions, mprProjectionMirror);
              const fallbackImage = getFallbackProjectionImage(axis, shellImageLayers);
              const currentSliceIndex = Number(slicePosition[axis] || 0);
              const mprSliceKey = getMprSliceKey(axis, currentSliceIndex);
              const mprPreviewLines = mprAnnotationPreview?.mode === 'measure'
                && mprAnnotationPreview.axis === axis
                && Number(mprAnnotationPreview.sliceIndex) === currentSliceIndex
                ? [mprAnnotationPreview.line]
                : [];
              const mprPreviewBoxes = mprAnnotationPreview?.box
                && mprAnnotationPreview.axis === axis
                && Number(mprAnnotationPreview.sliceIndex) === currentSliceIndex
                ? [mprAnnotationPreview.box]
                : [];
              const pendingCubeBoxes = mprAnnotationDraft?.mode === 'cube-pending'
                && mprAnnotationDraft.axis === axis
                && Number(mprAnnotationDraft.sliceIndex) === currentSliceIndex
                ? [{ ...mprAnnotationDraft.box, id: 'mpr-cube-pending', color: DEFAULT_ANNOTATION_COLOR, fillOpacity: DEFAULT_ANNOTATION_FILL_OPACITY }]
                : [];
              const mprSliceLines = (mprMeasurementLinesBySlice[mprSliceKey] || [])
                .filter(isFiniteMeasurementLine)
                .map((line) => (
                  mprGeometryDragPreview?.kind === 'line'
                  && String(mprGeometryDragPreview.geometry?.id) === String(line.id)
                    ? mprGeometryDragPreview.geometry
                    : line
                ));
              const mprEditableSliceBoxes = (mprBoxAnnotationsBySlice[mprSliceKey] || [])
                .filter(isFiniteAnnotationBox)
                .map((box) => (
                  mprGeometryDragPreview?.kind === 'box'
                  && String(mprGeometryDragPreview.geometry?.id) === String(box.id)
                    ? mprGeometryDragPreview.geometry
                    : box
                ));
              const mprSliceBoxes = [
                ...mprEditableSliceBoxes,
                ...getMprCubeBoxesForSlice(mprCubeAnnotations, axis, currentSliceIndex),
              ].filter(isFiniteAnnotationBox);
              const mprCanonicalSliceIndex = getSegmentationCanonicalSliceIndex(
                axis,
                currentSliceIndex,
              );
              const mprSliceSegments = annotationLayerVisible
                ? vectorSegmentAnnotations.filter((segment) => (
                  segmentVisibleOnSlice(segment, axis, mprCanonicalSliceIndex)
                ))
                : [];
              const mprImageDimensions = getMprAxisImageDimensions(axis, mprDimensions, volumeCacheState.cache);
              return (
                <article
                  key={axis}
                  className={`mpr-pane mpr-pane-${axis} ${activeMprPane === axis ? 'active-pane' : ''}`}
                  style={{ '--mpr-axis-color': config?.color, ...crosshairStyle }}
                  data-testid={`mpr-pane-${axis}`}
                  onClick={() => {
                    setActiveMprPane(axis);
                    openMprAnnotationTool(axis, '');
                    setFullscreenMeasureActive(false);
                    setFullscreenImageZoom({ scale: 1, panX: 0, panY: 0, originX: 50, originY: 50 });
                  }}
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
                    onMouseDown={(event) => handleMprAnnotationPointerDown(event, axis)}
                    onMouseMove={(event) => handleMprAnnotationPointerMove(event, axis)}
                    onMouseUp={(event) => handleMprAnnotationPointerUp(event, axis)}
                    onMouseLeave={handleMprAnnotationPointerCancel}
                    onClick={(event) => {
                      if (annotationToolMode) {
                        event.preventDefault();
                        event.stopPropagation();
                      }
                    }}
                  >
                    {hasVolumeImageSource ? (
                      <MprSliceCanvas
                        axis={axis}
                        volumeCache={volumeCacheState.cache}
                        overlayCaches={activeVolumeOverlayCaches}
                        volumeCacheStatus={volumeCacheState.status}
                        slicePosition={slicePosition}
                        dimensions={mprDimensions}
                        displayWindow={displayWindow}
                        displayDomain={displayValueDomain}
                        overlayOpacityMultiplier={annotationOpacityMultiplier}
                      />
                    ) : fallbackImage ? (
                      <MprWindowedImage
                        className="mpr-fallback-projection"
                        src={fallbackImage.url}
                        alt={`${label} fallback projection from ${fallbackImage.viewName} view`}
                        displayWindow={displayWindow}
                        displayDomain={displayValueDomain}
                      />
                    ) : (
                      <span className="mpr-empty-volume">No volume stack images</span>
                    )}
                    <span className="mpr-crosshair-h" />
                    <span className="mpr-crosshair-v" />
                    <span className="mpr-crosshair-center" />
                    <svg
                      className="inspection-fullscreen-measurement-overlay mpr-annotation-overlay mpr-projection-overlay"
                      viewBox={`0 0 ${mprImageDimensions.width} ${mprImageDimensions.height}`}
                      preserveAspectRatio="xMidYMid meet"
                      aria-label={`${label} annotation overlay`}
                    >
                      <g transform={`scale(${mprImageDimensions.width / 1000} ${mprImageDimensions.height / 1000})`}>
                        {renderAnnotationOverlay({
                          measurementLines: [...mprSliceLines, ...mprPreviewLines],
                          boxes: [...mprSliceBoxes, ...pendingCubeBoxes, ...mprPreviewBoxes],
                          fontSize: 26,
                          selectedAnnotationId,
                          opacityMultiplier: annotationOpacityMultiplier,
                        })}
                        {mprSliceLines.map((line) => {
                          const endpointPositions = getMeasurementEndpointViewBoxPosition(line);
                          const isSelected = String(selectedAnnotationId || '') === String(line.id || '');
                          return (
                            <g key={`mpr-line-controls-${line.id}`}>
                              <line
                                className="inspection-annotation-drag-target mpr-annotation-drag-target"
                                x1={endpointPositions.start.x}
                                y1={endpointPositions.start.y}
                                x2={endpointPositions.end.x}
                                y2={endpointPositions.end.y}
                                stroke="transparent"
                                strokeWidth="28"
                                pointerEvents="stroke"
                                aria-label={`Move ${line.name || 'MPR measurement'}`}
                                onPointerDown={(event) => startMprAnnotationGeometryDrag(
                                  event,
                                  'line',
                                  'translate',
                                  line,
                                  axis,
                                  currentSliceIndex,
                                )}
                                onPointerMove={handleMprAnnotationGeometryDragMove}
                                onPointerUp={finishMprAnnotationGeometryDrag}
                                onPointerCancel={(event) => finishMprAnnotationGeometryDrag(event, { cancel: true })}
                                onClick={stopMprAnnotationGeometryClick}
                              />
                              {isSelected && ['start', 'end'].map((endpoint) => (
                                <circle
                                  key={endpoint}
                                  className="inspection-measurement-endpoint-dot mpr-annotation-resize-handle"
                                  cx={endpointPositions[endpoint].x}
                                  cy={endpointPositions[endpoint].y}
                                  r="12"
                                  fill="#ffffff"
                                  stroke={line.color}
                                  strokeWidth="5"
                                  aria-label={`Resize ${endpoint} endpoint for ${line.name || 'MPR measurement'}`}
                                  onPointerDown={(event) => startMprAnnotationGeometryDrag(
                                    event,
                                    'line',
                                    endpoint,
                                    line,
                                    axis,
                                    currentSliceIndex,
                                  )}
                                  onPointerMove={handleMprAnnotationGeometryDragMove}
                                  onPointerUp={finishMprAnnotationGeometryDrag}
                                  onPointerCancel={(event) => finishMprAnnotationGeometryDrag(event, { cancel: true })}
                                  onClick={stopMprAnnotationGeometryClick}
                                />
                              ))}
                            </g>
                          );
                        })}
                        {mprEditableSliceBoxes.map((box) => {
                          const cornerPositions = getAnnotationBoxCornerViewBoxPosition(box);
                          const isSelected = String(selectedAnnotationId || '') === String(box.id || '');
                          return (
                            <g key={`mpr-box-controls-${box.id}`}>
                              <rect
                                className="inspection-annotation-drag-target mpr-annotation-drag-target"
                                x={(box.x / box.imageWidth) * 1000}
                                y={(box.y / box.imageHeight) * 1000}
                                width={(box.width / box.imageWidth) * 1000}
                                height={(box.height / box.imageHeight) * 1000}
                                fill="transparent"
                                pointerEvents="all"
                                aria-label={`Move ${box.name || 'MPR bounding box'}`}
                                onPointerDown={(event) => startMprAnnotationGeometryDrag(
                                  event,
                                  'box',
                                  'translate',
                                  box,
                                  axis,
                                  currentSliceIndex,
                                )}
                                onPointerMove={handleMprAnnotationGeometryDragMove}
                                onPointerUp={finishMprAnnotationGeometryDrag}
                                onPointerCancel={(event) => finishMprAnnotationGeometryDrag(event, { cancel: true })}
                                onClick={stopMprAnnotationGeometryClick}
                              />
                              {isSelected && Object.entries(cornerPositions).map(([corner, point]) => (
                                <circle
                                  key={corner}
                                  className="inspection-box-corner-dot mpr-annotation-resize-handle"
                                  cx={point.x}
                                  cy={point.y}
                                  r="12"
                                  fill="#ffffff"
                                  stroke={box.color}
                                  strokeWidth="5"
                                  aria-label={`Resize ${corner} corner for ${box.name || 'MPR bounding box'}`}
                                  onPointerDown={(event) => startMprAnnotationGeometryDrag(
                                    event,
                                    'box',
                                    corner,
                                    box,
                                    axis,
                                    currentSliceIndex,
                                  )}
                                  onPointerMove={handleMprAnnotationGeometryDragMove}
                                  onPointerUp={finishMprAnnotationGeometryDrag}
                                  onPointerCancel={(event) => finishMprAnnotationGeometryDrag(event, { cancel: true })}
                                  onClick={stopMprAnnotationGeometryClick}
                                />
                              ))}
                            </g>
                          );
                        })}
                      </g>
                      {mprSliceSegments.map((segment) => (
                        <g
                          key={`mpr-segment-${segment.id}`}
                          opacity={annotationOpacityMultiplier}
                        >
                          {renderCompositedSegmentationSegment(segment, {
                            color: segment.color,
                            fillOpacity: segment.opacity,
                            axis,
                            sliceIndex: mprCanonicalSliceIndex,
                            imageWidth: mprImageDimensions.width,
                            imageHeight: mprImageDimensions.height,
                            volumeDimensions: [
                              mprDimensions.sagittal,
                              mprDimensions.coronal,
                              mprDimensions.axial,
                            ],
                          })}
                        </g>
                      ))}
                    </svg>
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
            {mprFullscreenOpen && <div className="mpr-3d-fullscreen-backdrop" aria-hidden="true" onClick={closeMprFullscreen} />}
            <article
              className={`mpr-pane mpr-pane-volume ${activeMprPane === 'volume' ? 'active-pane' : ''} ${mprFullscreenOpen ? 'mpr-pane-volume-fullscreen' : ''}`}
              data-testid="mpr-pane-3d"
              role={mprFullscreenOpen ? 'dialog' : undefined}
              aria-modal={mprFullscreenOpen ? 'true' : undefined}
              aria-labelledby={mprFullscreenOpen ? 'mpr-3d-fullscreen-title' : undefined}
              aria-describedby={mprFullscreenOpen ? 'mpr-3d-fullscreen-mode' : undefined}
              onClick={() => {
                setActiveMprPane('volume');
              }}
              onWheel={handleMprVolumeWheel}
            >
              <header className="mpr-pane-header">
                <strong id={mprFullscreenOpen ? 'mpr-3d-fullscreen-title' : undefined}>{mprFullscreenOpen ? '3D reconstruction' : '3D'}</strong>
                <span id={mprFullscreenOpen ? 'mpr-3d-fullscreen-mode' : undefined}>
                  {mprFullscreenOpen ? `${effectiveMprReconstructionLabel} • ` : ''}Zoom {viewportTransform.zoom.toFixed(2)}x
                </span>
                {mprFullscreenOpen && (
                  <button
                    type="button"
                    className="modal-close-btn mpr-3d-fullscreen-close"
                    aria-label="Close fullscreen 3D view"
                    ref={mprFullscreenCloseRef}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeMprFullscreen();
                    }}
                  >
                    &times;
                  </button>
                )}
                {mprFullscreenOpen && (
                  <div
                    className="mpr-3d-display-controls"
                    role="group"
                    aria-label="Fullscreen 3D display options"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <label className="mpr-3d-display-toggle">
                      <input
                        type="checkbox"
                        checked={annotationsVisible}
                        onChange={(event) => setAnnotationsVisible(event.target.checked)}
                      />
                      Render annotations
                    </label>
                    <label className="mpr-3d-display-toggle">
                      <input
                        type="checkbox"
                        checked={mprFullscreenAnnotationListVisible}
                        onChange={(event) => setMprFullscreenAnnotationListVisible(event.target.checked)}
                      />
                      Show annotations list
                    </label>
                    <label className="mpr-3d-display-toggle">
                      <input
                        type="checkbox"
                        checked={mprFullscreenReconstructionSettingsVisible}
                        onChange={(event) => setMprFullscreenReconstructionSettingsVisible(event.target.checked)}
                      />
                      Show reconstruction settings
                    </label>
                  </div>
                )}
              </header>
              <div
                className="mpr-volume-scene"
                data-mirror-x={mprAxisMirrorScale.x}
                data-mirror-y={mprAxisMirrorScale.y}
                data-mirror-z={mprAxisMirrorScale.z}
                role={mprFullscreenOpen ? 'application' : 'button'}
                tabIndex={0}
                ref={mprFullscreenSceneRef}
                aria-label={mprFullscreenOpen ? 'Fullscreen 3D part view. Use arrow keys to orbit, plus and minus to zoom, and zero to reset.' : 'Open 3D part view fullscreen'}
                onClick={(event) => {
                  if (!mprFullscreenOpen && !event.target.closest('button, input, select, label, fieldset')) {
                    openMprFullscreen(event);
                  }
                }}
                onPointerDown={handleMprVolumePointerDown}
                onPointerMove={handleMprVolumePointerMove}
                onPointerUp={handleMprVolumePointerUp}
                onPointerCancel={handleMprVolumePointerCancel}
                onDragStart={preventMprNativeDrag}
                onKeyDown={(event) => {
                  if (!mprFullscreenOpen && ['Enter', ' '].includes(event.key)) {
                    event.preventDefault();
                    event.stopPropagation();
                    openMprFullscreen(event);
                    return;
                  }
                  if (!mprFullscreenOpen) return;
                  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '_', '0'].includes(event.key)) {
                    event.preventDefault();
                    event.stopPropagation();
                  }
                  if (event.key === 'ArrowLeft') setMprRotation((prev) => ({ ...prev, y: prev.y - 5 }));
                  else if (event.key === 'ArrowRight') setMprRotation((prev) => ({ ...prev, y: prev.y + 5 }));
                  else if (event.key === 'ArrowUp') setMprRotation((prev) => ({ ...prev, x: Math.max(-72, prev.x - 5) }));
                  else if (event.key === 'ArrowDown') setMprRotation((prev) => ({ ...prev, x: Math.min(72, prev.x + 5) }));
                  else if (['+', '='].includes(event.key)) adjustZoom(0.12);
                  else if (['-', '_'].includes(event.key)) adjustZoom(-0.12);
                  else if (event.key === '0') resetViewport();
                }}
              >
                {!PT3_RENDERER_RECONSTRUCTION_MODES.includes(effectiveMprReconstructionMode) && (
                  <canvas className="mpr-volume-overlay" ref={mprOverlayCanvasRef} aria-hidden="true" />
                )}
                {PT3_RENDERER_RECONSTRUCTION_MODES.includes(effectiveMprReconstructionMode)
                  && !(segmentationHelperOpen && segmentationHelperView === '3d') && (
                  <Pt3GaussianSplatViewer
                    part={selectedPart}
                    projectId={projectId}
                    volumeImageStack={volumeRendererImageStack}
                    volumeOverlayImageStacks={volumeRendererOverlayImageStacks}
                    splatParameters={splatParameters}
                    mode={effectiveMprReconstructionMode === MPR_RECONSTRUCTION_MODES.volume3d
                      ? 'volume'
                      : 'real-splat'}
                    rotation={mprRotation}
                    zoom={viewportTransform.zoom}
                    mirrorScale={mprAxisMirrorScale}
                    slicePosition={slicePosition}
                    activeSliceAxis={lastActiveMprAxis}
                    rayMarchSettings={rayMarchSettings}
                    splatViewSettings={splatViewSettings}
                    onRayMarchSettingsChange={setRayMarchSettings}
                    onSplatViewSettingsChange={setSplatViewSettings}
                    onRotationChange={setMprRotation}
                    onZoomChange={(nextZoom) => setViewportTransform((prev) => ({ ...prev, zoom: nextZoom }))}
                    onResetView={resetViewport}
                    showRayMarchControls={mprFullscreenOpen && mprFullscreenReconstructionSettingsVisible}
                    showSplatControls={mprFullscreenOpen && mprFullscreenReconstructionSettingsVisible}
                    showRealOptimizationControls={!mprFullscreenOpen || mprFullscreenReconstructionSettingsVisible}
                    vectorAnnotations={vectorSegmentAnnotations}
                    showAnnotations={annotationLayerVisible}
                    annotationOpacityMultiplier={annotationOpacityMultiplier}
                  />
                  )}
                {!PT3_RENDERER_RECONSTRUCTION_MODES.includes(effectiveMprReconstructionMode) && <div
                  className={`mpr-volume-model reconstruction-${effectiveMprReconstructionMode}`}
                  style={{
                    '--volume-rotate-x': `${-mprRotation.x}deg`,
                    '--volume-rotate-y': `${mprRotation.y}deg`,
                    '--volume-mirror-x': mprAxisMirrorScale.x,
                    '--volume-mirror-y': mprAxisMirrorScale.y,
                    '--volume-mirror-z': mprAxisMirrorScale.z,
                    '--volume-zoom': fallbackMprModelZoom,
                    '--slice-axial-depth': `${(getFraction(slicePosition.axial, mprDimensions.axial - 1) - 0.5) * 108}px`,
                    '--slice-coronal-y': `${(getFraction(slicePosition.coronal, mprDimensions.coronal - 1) - 0.5) * 138}px`,
                    '--slice-sagittal-x': `${(getFraction(slicePosition.sagittal, mprDimensions.sagittal - 1) - 0.5) * 190}px`,
                    '--reticle-active-color': MPR_AXIS_CONFIG[activeMprPane]?.color || '#f8fafc',
                  }}
                >
                  {effectiveMprReconstructionMode === MPR_RECONSTRUCTION_MODES.stack ? (
                    <>
                      {volumePreviewLayers.map((layer) => (
                        <MprWindowedImage
                          key={`${layer.id}-${layer.sliceIndex}`}
                          className="volume-slice-voxel"
                          src={layer.url}
                          alt={`Volume reconstruction slice ${layer.sliceIndex}`}
                          draggable={false}
                          onDragStart={preventMprNativeDrag}
                          style={{
                            '--slice-depth': `${layer.depth}px`,
                            '--slice-opacity': layer.opacity,
                          }}
                          displayWindow={displayWindow}
                          displayDomain={displayValueDomain}
                        />
                      ))}
                      {volumeRendererOverlayImageStacks.flatMap((stack, stackIndex) => (
                        stack.map((layer, layerIndex) => (
                          <img
                            key={`volume-overlay-${stackIndex}-${layer.id}-${layer.sliceIndex}-${layerIndex}`}
                            className="volume-slice-voxel volume-slice-segment-overlay"
                            src={layer.url}
                            alt=""
                            aria-hidden="true"
                            draggable={false}
                            onDragStart={preventMprNativeDrag}
                            style={{
                              '--slice-depth': `${layer.depth}px`,
                              '--slice-opacity': annotationOpacityMultiplier,
                            }}
                          />
                        ))
                      ))}
                    </>
                  ) : !canShowStackReconstruction && !canShowShellReconstruction ? (
                    <span className="volume-reconstruction-empty">No 3D reference</span>
                  ) : null}
                  {volumeCacheState.status === 'loading' && hasVolumeImageSource && (
                    <span className="volume-cache-status">Caching slices</span>
                  )}
                  <span className="volume-box volume-face-front" />
                  <span className="volume-box volume-face-back" />
                  <span className="volume-box volume-face-left" />
                  <span className="volume-box volume-face-right" />
                  <span className="volume-box volume-face-top" />
                  <span className="volume-box volume-face-bottom" />
                  <span className={`volume-plane volume-keepout plane-axial ${activeMprPane === 'axial' ? 'active' : ''}`} />
                  <span className={`volume-plane volume-keepout plane-coronal ${activeMprPane === 'coronal' ? 'active' : ''}`} />
                  <span className={`volume-plane volume-keepout plane-sagittal ${activeMprPane === 'sagittal' ? 'active' : ''}`} />
                  <span className="volume-reticle reticle-x" />
                  <span className="volume-reticle reticle-y" />
                  <span className="volume-reticle reticle-z" />
                </div>}
              </div>
              {mprFullscreenOpen && mprFullscreenAnnotationListVisible && (
                <aside
                  className="mpr-3d-annotation-list"
                  aria-label="3D annotations"
                  onClick={(event) => event.stopPropagation()}
                >
                  <h4>Annotations</h4>
                  {inspectionAnnotationItems.length === 0 ? (
                    <p className="muted">No annotations.</p>
                  ) : (
                    <ul>
                      {inspectionAnnotationItems.map((item) => (
                        <li key={`mpr-3d-${item.key}`} className={item.visible ? '' : 'annotation-entry-hidden'}>
                          <span className="overlay-swatch" style={{ backgroundColor: item.color }} />
                          <span title={item.label}>
                            {item.kind === 'external_overlay' ? `External: ${item.label}` : item.label}
                          </span>
                          <button
                            type="button"
                            aria-label={`${item.visible ? 'Hide' : 'Show'} 3D annotation ${item.label}`}
                            aria-pressed={item.visible}
                            onClick={() => setInspectionItemVisibility(item, !item.visible)}
                          >
                            {item.visible ? 'Hide' : 'Show'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </aside>
              )}
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
          {renderSplatConfigurationModal()}
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
          ) : visibleSelectedPartImageRefs.length === 0 ? (
            <p className="muted">No mapped images for this part.</p>
          ) : (
            <>
            <div className="view-board-controls">
              <div className="tile-size-control">
                <label htmlFor="inspection-tile-columns-slider">Tile size</label>
                <input
                  id="inspection-tile-columns-slider"
                  type="range"
                  aria-label="Inspection tile columns"
                  min="1"
                  max={tileColumnMax}
                  step="1"
                  value={normalizedTileColumnCount}
                  onChange={(event) => setTileColumnCount(Number(event.target.value))}
                />
                <input
                  id="inspection-tile-columns-input"
                  className="tile-size-input"
                  type="number"
                  aria-label="Inspection tile columns value"
                  min="1"
                  max={tileColumnMax}
                  step="1"
                  value={normalizedTileColumnCount}
                  onChange={(event) => {
                    const nextValue = Number(event.target.value);
                    if (!Number.isFinite(nextValue)) return;
                    setTileColumnCount(Math.round(clampRange(nextValue, 1, tileColumnMax, normalizedTileColumnCount)));
                  }}
                />
                <span>{normalizedTileColumnCount} / {tileColumnMax}</span>
              </div>
            </div>
            <div
              className="view-board"
              data-layout-region="visual_workspace"
              style={{
                '--inspection-tile-columns': normalizedTileColumnCount,
                '--inspection-tile-min-height': `${Math.max(240, Math.round(560 / normalizedTileColumnCount))}px`,
              }}
            >
              {visibleSelectedPartImageRefs.map((entry) => {
                const viewName = entry.viewName || 'image';
                const imageRef = String(entry.imageRef || '');
                const imageRecord = projectImageLookup[entry.imageId] || projectImageLookup[imageRef];
                const imageId = imageRecord?.id || entry.imageId || '';
                const baseRecord = entry.overlay
                  ? (projectImageLookup[entry.overlayBaseImageId] || projectImageLookup[entry.overlayBaseFilename])
                  : null;
                const baseImageId = baseRecord?.id || entry.overlayBaseImageId || '';
                const annotationSourceImageId = getAnnotationSourceImageId(entry, projectImageLookup);
                const tileAnnotationSourceImageId = String(annotationSourceImageId || imageId);
	                const tileMeasurementLines = (measurementLinesByImageId[tileAnnotationSourceImageId] || [])
	                  .filter(isFiniteMeasurementLine)
                      .map((line) => (
                        tileGeometryDragPreview?.kind === 'line'
                        && String(tileGeometryDragPreview.imageId || '') === tileAnnotationSourceImageId
                        && String(tileGeometryDragPreview.geometry?.id || '') === String(line.id || '')
                          ? tileGeometryDragPreview.geometry
                          : line
                      ));
		                const tileBoxes = (boxAnnotationsByImageId[tileAnnotationSourceImageId] || [])
		                  .filter(isFiniteAnnotationBox)
		                  .map((box) => (
                        tileGeometryDragPreview?.kind === 'box'
                        && String(tileGeometryDragPreview.imageId || '') === tileAnnotationSourceImageId
                        && String(tileGeometryDragPreview.geometry?.id || '') === String(box.id || '')
                          ? tileGeometryDragPreview.geometry
                          : box
                      ))
		                  .map((box) => getBoxWithDerivedDimensions(box, tileAnnotationSourceImageId));
	                const tilePreviewLines = tileAnnotationPreview?.mode === 'measure' && tileAnnotationPreview.imageId === tileAnnotationSourceImageId
	                  ? [tileAnnotationPreview.line].filter(isFiniteMeasurementLine)
	                  : [];
	                const tilePreviewBoxes = ['box', 'crop'].includes(tileAnnotationPreview?.mode) && tileAnnotationPreview.imageId === tileAnnotationSourceImageId
		                  ? [tileAnnotationPreview.box].filter(isFiniteAnnotationBox).map((box) => getBoxWithDerivedDimensions(box, tileAnnotationSourceImageId))
		                  : [];
                const tileOverlayGeometry = [...tileMeasurementLines, ...tileBoxes, ...tilePreviewLines, ...tilePreviewBoxes][0];
                const tileOverlayWidth = Math.max(1, Number(tileOverlayGeometry?.imageWidth) || 1000);
                const tileOverlayHeight = Math.max(1, Number(tileOverlayGeometry?.imageHeight) || 1000);
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
                    <div className={`view-cell-title ${entry.cropChild ? 'view-cell-title-crop-child' : ''}`}>
                      <div className="view-cell-title-text">
                        <span>{entry.label || viewName.toUpperCase()}</span>
                        {entry.cropChild && (
                          <input
                            type="text"
                            className="view-cell-subtitle-input"
                            aria-label={`Subtitle for ${entry.label || 'crop child image'}`}
                            placeholder="Add subtitle (e.g. Feature 1)"
                            value={entry.cropSubtitle || ''}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                            onChange={(event) => updateCropChildSubtitle(entry, event.target.value)}
                          />
                        )}
                      </div>
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
                          className="inspection-overlay-composite inspection-image-annotation-surface"
	                          data-testid="inspection-overlay-composite"
	                          onPointerDown={(event) => handleTileBoxPointerDown(event, imageId)}
	                          onPointerMove={(event) => handleTileAnnotationPointerMove(event, imageId)}
	                          onPointerUp={(event) => handleTileBoxPointerUp(event, imageId)}
	                          onPointerCancel={handleTileBoxPointerCancel}
	                          onClick={(event) => {
	                            event.stopPropagation();
	                            if (suppressNextTileClickRef.current) {
	                              suppressNextTileClickRef.current = false;
	                              return;
	                            }
	                            if (handleTileAnnotationPointerDown(event, imageId)) return;
	                            setFullscreenImageModal({
	                              imageId: String(imageId),
	                              baseImageId: String(baseImageId),
                              label: entry.label || viewName.toUpperCase(),
                            });
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
                            style={{ opacity: annotationOpacityMultiplier }}
                          />
	                          <svg className="inspection-fullscreen-measurement-overlay" viewBox={`0 0 ${tileOverlayWidth} ${tileOverlayHeight}`} preserveAspectRatio="xMidYMid meet" aria-label="tile measurement overlay">
	                            <g transform={`scale(${tileOverlayWidth / 1000} ${tileOverlayHeight / 1000})`}>
	                              {renderAnnotationOverlay({ measurementLines: [...tileMeasurementLines, ...tilePreviewLines], boxes: [...tileBoxes, ...tilePreviewBoxes], fontSize: 30, selectedAnnotationId, opacityMultiplier: annotationOpacityMultiplier })}
                                  {renderTileAnnotationEditingTargets({
                                    measurementLines: tileMeasurementLines,
                                    boxes: tileBoxes,
                                    selectedAnnotationId,
                                    onStartDrag: (event, kind, operation, geometry) => startTileAnnotationGeometryDrag(
                                      event,
                                      kind,
                                      operation,
                                      geometry,
                                      tileAnnotationSourceImageId,
                                    ),
                                    onDragMove: handleTileAnnotationGeometryDragMove,
                                    onDragFinish: finishTileAnnotationGeometryDrag,
                                    onDragCancel: (event) => finishTileAnnotationGeometryDrag(event, { cancel: true }),
                                  })}
	                            </g>
	                          </svg>
	                        </div>
	                      ) : imageId ? (
                        <div
                          className="inspection-image-annotation-surface"
	                          onPointerDown={(event) => handleTileBoxPointerDown(event, imageId)}
	                          onPointerMove={(event) => handleTileAnnotationPointerMove(event, imageId)}
	                          onPointerUp={(event) => handleTileBoxPointerUp(event, imageId)}
	                          onPointerCancel={handleTileBoxPointerCancel}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (suppressNextTileClickRef.current) {
                              suppressNextTileClickRef.current = false;
                              return;
                            }
                            if (handleTileAnnotationPointerDown(event, imageId)) return;
                            setFullscreenImageModal({ imageId: String(imageId), label: entry.label || viewName.toUpperCase() });
                          }}
                        >
                          <img
                            className="inspection-view-image"
                            src={`/api/images/${encodeURIComponent(String(imageId))}/content`}
                            alt={`${viewName} view`}
                            loading="lazy"
	                            style={entry.overlay ? { opacity: annotationOpacityMultiplier } : undefined}
	                          />
	                          <svg className="inspection-fullscreen-measurement-overlay" viewBox={`0 0 ${tileOverlayWidth} ${tileOverlayHeight}`} preserveAspectRatio="xMidYMid meet" aria-label="tile measurement overlay">
	                            <g transform={`scale(${tileOverlayWidth / 1000} ${tileOverlayHeight / 1000})`}>
	                              {renderAnnotationOverlay({ measurementLines: [...tileMeasurementLines, ...tilePreviewLines], boxes: [...tileBoxes, ...tilePreviewBoxes], fontSize: 30, selectedAnnotationId, opacityMultiplier: annotationOpacityMultiplier })}
                                  {renderTileAnnotationEditingTargets({
                                    measurementLines: tileMeasurementLines,
                                    boxes: tileBoxes,
                                    selectedAnnotationId,
                                    onStartDrag: (event, kind, operation, geometry) => startTileAnnotationGeometryDrag(
                                      event,
                                      kind,
                                      operation,
                                      geometry,
                                      tileAnnotationSourceImageId,
                                    ),
                                    onDragMove: handleTileAnnotationGeometryDragMove,
                                    onDragFinish: finishTileAnnotationGeometryDrag,
                                    onDragCancel: (event) => finishTileAnnotationGeometryDrag(event, { cancel: true }),
                                  })}
	                            </g>
	                          </svg>
	                        </div>
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
            </>
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
	        <label className="annotation-display-toggle">
	          <input
	            type="checkbox"
	            checked={annotationsVisible}
	            onChange={(event) => setAnnotationsVisible(event.target.checked)}
	          />
	          Show annotations
	        </label>
	        <label className="annotation-transparency-control" htmlFor="annotation-transparency-percent">
	          <span>Transparency</span>
	          <span className="annotation-transparency-input">
	            <input
	              id="annotation-transparency-percent"
	              type="number"
	              aria-label="Annotation transparency percent"
	              min="0"
	              max="100"
	              step="1"
	              value={annotationTransparencyPercent}
	              onChange={(event) => setAnnotationTransparencyPercent(
	                normalizeAnnotationTransparencyPercent(event.target.value),
	              )}
	            />
	            <span aria-hidden="true">%</span>
	          </span>
	        </label>
	        <p className="muted">For selected part: {selectedPart?.serial_number || 'No part selected'}</p>
	        <div className="annotation-tool-buttons" aria-label="Annotation tools">
	          <button
	            type="button"
	            className={`btn btn-secondary ${annotationToolMode === 'measure' ? 'active' : ''}`}
	            aria-label="Measure on tiles"
	            onClick={() => setTileAnnotationMode('measure')}
	            disabled={!selectedPart}
	          >
	            Measure
	          </button>
	          <button
	            type="button"
	            className={`btn btn-secondary ${annotationToolMode === 'box' ? 'active' : ''}`}
	            aria-label={projectType === 'PT3' ? 'Draw box on MPR slices' : 'Draw box on tiles'}
	            onClick={() => setTileAnnotationMode('box')}
	            disabled={!selectedPart}
	          >
	            Draw box
	          </button>
          {projectType !== 'PT3' && (
            <button
              type="button"
              className={`btn btn-secondary ${annotationToolMode === 'crop' ? 'active' : ''}`}
              aria-label="New Crop on tiles"
              onClick={() => setTileAnnotationMode('crop')}
              disabled={!selectedPart}
            >
              New Crop
            </button>
          )}
	          {projectType === 'PT3' && (
	            <button
	              type="button"
	              className={`btn btn-secondary ${annotationToolMode === 'cube' ? 'active' : ''}`}
	              aria-label="Draw 3D box on MPR slices"
	              onClick={() => setTileAnnotationMode('cube')}
	              disabled={!selectedPart}
	            >
	              3D Box
	            </button>
	          )}
	          <button
	            type="button"
	            className="btn btn-secondary"
	            onClick={() => {
	              resetAnnotationDraft();
	              setOtherAnnotationModalVisible(true);
	            }}
	            disabled={!selectedPart}
	          >
	            Other
	          </button>
	        </div>
	        {annotationToolMode === 'measure' && (
	          <p className="muted annotation-tool-hint">
	            Click two points {projectType === 'PT3' ? 'on an MPR slice' : 'on a tile'} to place a measurement line.
	          </p>
	        )}
	        {annotationToolMode === 'box' && (
	          <p className="muted annotation-tool-hint">
	            Drag two corners {projectType === 'PT3' ? 'on the active MPR slice' : 'on a tile'} to draw a bounding box.
	          </p>
        )}
        {annotationToolMode === 'crop' && (
          <p className="muted annotation-tool-hint">
            Drag around part of a parent image to create a child crop tile.
          </p>
        )}
	        {annotationToolMode === 'cube' && (
	          <p className="muted annotation-tool-hint">
	            Draw one box, move to another slice on the same axis, then draw the second box.
	          </p>
	        )}
        {tileCalibrationPromptImageId && (
          <div className="inspection-fullscreen-calibration-panel" role="dialog" aria-label="Measurement calibration required">
            <div className="workbench-notice">
              <strong>No Calibration Set</strong>
              <p>Set calibration before placing measurement annotations.</p>
            </div>
            <CalibrationManager
              projectId={projectId}
              imageId={tileCalibrationPromptImageId}
              image={projectImageLookup[tileCalibrationPromptImageId]}
              onCalibrationChange={handleTileCalibrationChange}
            />
          </div>
        )}
        <ul className="measurement-list" data-testid="annotation-list">
          {annotationsLoading ? (
            <li className="muted">Loading annotations…</li>
          ) : inspectionAnnotationItems.length === 0 ? (
            <li className="muted">No annotations captured.</li>
          ) : (
            inspectionAnnotationItems.map((item) => {
              const annotation = item.annotation;
              const isAnnotation = item.source.resource === 'annotation';
              const creator = isAnnotation ? getAnnotationCreator(annotation) : '';
              const createdAt = isAnnotation ? formatAnnotationTimestamp(getAnnotationCreatedAt(annotation)) : '';
              const selected = isAnnotation && String(selectedAnnotationId) === String(annotation.id);
              const typeLabel = item.kind === 'external_overlay'
                ? 'External overlay'
                : item.kind === 'vista_segment'
                  ? 'VISTA segment'
                  : getAnnotationListType(annotation);
              return (
                <li
                  key={item.key}
                  className={`annotation-entry ${selected ? 'selected' : ''} ${item.visible ? '' : 'annotation-entry-hidden'}`}
                  role="button"
                  tabIndex={0}
                  title={isAnnotation ? getAnnotationTooltip(annotation) : item.label}
                  onClick={() => {
                    if (isAnnotation) setSelectedAnnotationId(annotation.id);
                    else if (item.overlay?.imageRef) setSelectedImageRef(item.overlay.imageRef);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      if (isAnnotation) setSelectedAnnotationId(annotation.id);
                      else if (item.overlay?.imageRef) setSelectedImageRef(item.overlay.imageRef);
                    }
                  }}
                >
                  <div className="annotation-entry-content">
                    <span className="annotation-entry-type">{typeLabel}</span>
                    <span className="annotation-entry-value">
                      {item.kind === 'external_overlay'
                        ? `External: ${item.label}`
                        : item.kind === 'vista_segment'
                          ? item.label
                          : getAnnotationListValue(annotation)}
                    </span>
                    {item.kind === 'vista_segment' && (
                      <span className="annotation-entry-meta">
                        {annotation?.geometry?.segment?.axis || 'axial'} slices {annotation?.geometry?.segment?.min_slice ?? 0}-{annotation?.geometry?.segment?.max_slice ?? 0}
                      </span>
                    )}
                    {isAnnotation ? (
                      <>
                        <span className="annotation-entry-meta">Created by {creator}</span>
                        <span className="annotation-entry-meta">{createdAt}</span>
                      </>
                    ) : (
                      <span className="annotation-entry-meta">Assigned external image or volume</span>
                    )}
                  </div>
                  <div className="annotation-entry-actions">
                    <button
                      type="button"
                      className="annotation-entry-visibility"
                      aria-label={`${item.visible ? 'Hide' : 'Show'} ${typeLabel.toLowerCase()} ${item.label}`}
                      aria-pressed={item.visible}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setInspectionItemVisibility(item, !item.visible);
                      }}
                    >
                      {item.visible ? 'Hide' : 'Show'}
                    </button>
                    {projectType !== 'PT3' && isAnnotation && isBoundingBoxAnnotation(annotation) && (
                      <button
                        type="button"
                        className="annotation-entry-crop"
                        aria-label={`Crop annotation ${annotation.comment || annotation.defect_class || annotation.id}`}
                        disabled={croppingAnnotationId === annotation.id}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          cropBoxAnnotation(annotation);
                        }}
                      >
                        {croppingAnnotationId === annotation.id ? 'Cropping…' : 'Crop'}
                      </button>
                    )}
                    {isAnnotation && (
                      <button
                        type="button"
                        className="annotation-entry-edit"
                        aria-label={`Edit annotation ${annotation.comment || annotation.defect_class || annotation.id}`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          if (item.kind === 'vista_segment') {
                            segmentationHelperOpenerRef.current = event.currentTarget;
                            const segment = annotationToSegmentationHelperSegment(annotation);
                            setSelectedSegmentationSegmentId(segment.id);
                            setEditingSegmentationSegmentId(segment.id);
                            setSegmentationHelperAxis(segment.axis);
                            setSegmentationHelperView(SEGMENTATION_VIEW_BY_AXIS[segment.axis] || 'z');
                            setActiveMprPane(segment.axis);
                            setSegmentationPendingSelection(null);
                            setSegmentationVolumeStatus('');
                            setSegmentationHelperOpen(true);
                          } else {
                            openAnnotationEditModal(annotation);
                          }
                        }}
                      >
                        Edit
                      </button>
                    )}
                    {isAnnotation && (
                      <button
                        type="button"
                        className="annotation-entry-delete"
                        aria-label={`Delete annotation ${annotation.comment || annotation.defect_class || annotation.id}`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          deleteMeasurementAnnotation(annotation.id);
                        }}
                      >
                        ×
                      </button>
                    )}
                  </div>
                </li>
              );
            })
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

	  const renderOtherAnnotationModal = () => {
	    if (!otherAnnotationModalVisible) return null;
	    return (
	      <div className="modal" style={{ display: 'flex' }} onClick={() => setOtherAnnotationModalVisible(false)}>
	        <div className="modal-content workbench-utility-modal other-annotation-modal" role="dialog" aria-label="Other annotation" onClick={(event) => event.stopPropagation()}>
	          <div className="modal-header">
	            <h3>Other Annotation</h3>
	            <button
	              type="button"
	              className="modal-close-btn"
	              aria-label="Close other annotation"
	              onClick={() => setOtherAnnotationModalVisible(false)}
	            >
	              &times;
	            </button>
	          </div>
	          <div className="modal-body">
	            <div className="measurement-fields">
	              <select
	                aria-label="Annotation defect type"
	                value={annotationDraft.defect_class}
	                onChange={(event) => setAnnotationDraft((prev) => ({ ...prev, defect_class: event.target.value }))}
	              >
	                <option value="">Defect type</option>
	                {configuredDefectTypes.map((defectType) => (
	                  <option key={defectType} value={defectType}>{defectType}</option>
	                ))}
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
		            <div className="modal-actions">
	              <button type="button" className="btn btn-secondary" onClick={() => setOtherAnnotationModalVisible(false)}>
	                Cancel
	              </button>
	              <button
	                type="button"
	                className="btn btn-primary"
	                onClick={createAnnotation}
	                disabled={!selectedPart || !annotationDraft.defect_class.trim()}
	              >
	                Save annotation
	              </button>
	            </div>
	          </div>
	        </div>
	      </div>
	    );
	  };

	



  const updateAnnotationFromModal = async () => {
    const selected = annotations.find((annotation) => annotation.id === selectedAnnotationId);
    if (!selected || !selectedPart?.id) return;
    const mutationPartId = String(selectedPart.id);
    const mutationScope = `${projectId}:${mutationPartId}`;
    const mutationGeneration = activePartMutationGeneration;
    const draft = annotationEditDraft || {};
    const fillOpacity = clampRange(Number(draft.fill_opacity), 0, 1, getAnnotationFillOpacity(selected));
    const color = getAnnotationColor({ metadata: { annotation_color: draft.color } }, getAnnotationColor(selected));
    try {
      const resp = await fetch(`/api/projects/${projectId}/parts/${mutationPartId}/annotations/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          defect_class: draft.defect_class ?? selected.defect_class,
          comment: draft.comment ?? selected.comment,
          measurements: selected.measurements || {},
          disposition: draft.disposition || selected.disposition || 'open',
          metadata: {
            ...(selected.metadata || {}),
            annotation_color: color,
            measurement_color: color,
            annotation_fill_opacity: fillOpacity,
          },
        }),
      });
      if (!resp.ok) throw new Error(`Failed to update annotation (${resp.status})`);
      const updated = await resp.json();
      if (!isActivePartMutation(mutationScope, mutationGeneration)) return;
      setAnnotations((prev) => prev.map((annotation) => (annotation.id === updated.id ? updated : annotation)));
      closeAnnotationEditModal();
    } catch (err) {
      if (isActivePartMutation(mutationScope, mutationGeneration)) {
        setError(err.message || 'Failed to update annotation');
      }
    }
  };

  const renderAnnotationEditModal = () => {
    if (!annotationEditModalVisible) return null;
    const selected = annotations.find((annotation) => annotation.id === selectedAnnotationId);
    if (!selected) return null;
    const draft = annotationEditDraft || {
      defect_class: selected.defect_class || '',
      comment: selected.comment || '',
      disposition: selected.disposition || 'open',
      color: getAnnotationColor(selected),
      fill_opacity: getAnnotationFillOpacity(selected),
    };
    return (
      <div className="modal" style={{ display: 'flex' }} onClick={closeAnnotationEditModal}>
        <div className="modal-content workbench-utility-modal" role="dialog" aria-label="Edit annotation" onClick={(event) => event.stopPropagation()}>
          <div className="modal-header">
            <h3>Edit Annotation</h3>
            <button
              type="button"
              className="modal-close-btn modal-close-danger"
              aria-label="Cancel edit annotation"
              onClick={closeAnnotationEditModal}
            >
              ×
            </button>
          </div>
          <div className="modal-body">
            <div className="measurement-fields">
              <input
                type="text"
                aria-label="Edit annotation defect class"
                value={draft.defect_class}
                onChange={(event) => setAnnotationEditDraft((prev) => ({ ...(prev || draft), defect_class: event.target.value }))}
              />
              <select
                aria-label="Edit annotation disposition"
                value={draft.disposition}
                onChange={(event) => setAnnotationEditDraft((prev) => ({ ...(prev || draft), disposition: event.target.value }))}
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
                aria-label="Edit annotation comment"
                value={draft.comment}
                onChange={(event) => setAnnotationEditDraft((prev) => ({ ...(prev || draft), comment: event.target.value }))}
              />
            </div>
            <div className="measurement-fields annotation-style-fields">
              <label htmlFor="edit-annotation-color">
                Color
                <input
                  id="edit-annotation-color"
                  type="color"
                  aria-label="Edit annotation color"
                  value={draft.color || DEFAULT_ANNOTATION_COLOR}
                  onChange={(event) => setAnnotationEditDraft((prev) => ({ ...(prev || draft), color: event.target.value }))}
                />
              </label>
              <label htmlFor="edit-annotation-fill-opacity">
                Fill opacity
                <input
                  id="edit-annotation-fill-opacity"
                  type="number"
                  aria-label="Edit annotation fill opacity"
                  min="0"
                  max="1"
                  step="0.05"
                  value={draft.fill_opacity ?? DEFAULT_ANNOTATION_FILL_OPACITY}
                  onChange={(event) => setAnnotationEditDraft((prev) => ({ ...(prev || draft), fill_opacity: event.target.value }))}
                />
              </label>
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={closeAnnotationEditModal}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={updateAnnotationFromModal}>Save</button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderSegmentationHelperModal = () => {
    if (!segmentationHelperOpen) return null;
    const axis = MPR_AXES.includes(segmentationHelperAxis) ? segmentationHelperAxis : 'axial';
    const dimensions = getMprAxisImageDimensions(axis, mprDimensions, volumeCacheState.cache);
    const canonicalSliceIndex = getSegmentationCanonicalSliceIndex(
      axis,
      Number(slicePosition[axis] || 0),
    );
    const upper = Math.max(0, (mprDimensions[axis] || 1) - 1);
    const config = MPR_AXIS_CONFIG[axis] || MPR_AXIS_CONFIG.axial;
    const fallbackImage = getFallbackProjectionImage(axis, shellImageLayers);
    const crosshairStyle = getMprCrosshairStyle(axis, slicePosition, mprDimensions, mprProjectionMirror);
    const activeTool = SEGMENTATION_HELPER_TOOLS.find((tool) => tool.id === segmentationTool) || SEGMENTATION_HELPER_TOOLS[0];
    const activeToolMode = getActiveSegmentationToolMode(activeTool.id);
    const volumeDimensions = getSegmentationVolumeDimensions();
    const visibleSegments = segmentationSegments.filter((segment) => (
      segmentVisibleOnSlice(segment, axis, canonicalSliceIndex)
    ));
    const pendingVolumePreviewSegment = segmentationHelperPending3dPreviewSegment;
    const helper3dAnnotations = segmentationHelper3dAnnotations;
    const draftPoints = [
      ...getSegmentationShapePoints(segmentationDraftShape),
      ...getSegmentationShapePoints(segmentationPendingSelection),
    ];
    const brushPointerVisible = ['brush', 'eraser'].includes(segmentationTool) && segmentationPointerPreview;
    const brushPointerDiameter = Math.max(2, Number(segmentationBrushSize) || 18);

    return (
      <div className="modal segmentation-helper-modal" style={{ display: 'flex' }} onClick={closeSegmentationHelper}>
        <div
          ref={segmentationHelperDialogRef}
          className="modal-content segmentation-helper-modal-content"
          role="dialog"
          aria-modal="true"
          aria-label="Segmentation Helpers"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="modal-header segmentation-helper-header">
            <div>
              <h3>Segmentation Helpers</h3>
              <p className="muted">Linked slice and volumetric tools for PT3 segment masks.</p>
            </div>
            <button
              ref={segmentationHelperCloseRef}
              type="button"
              className="modal-close-btn"
              aria-label="Close Segmentation Helpers"
              onClick={closeSegmentationHelper}
            >
              &times;
            </button>
          </div>

          <nav
            className="segmentation-helper-view-tabs"
            role="tablist"
            aria-label="Segmentation workspace views"
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              const tabs = Array.from(event.currentTarget.querySelectorAll('[role="tab"]'));
              const currentIndex = Math.max(0, tabs.indexOf(document.activeElement));
              const nextIndex = event.key === 'Home'
                ? 0
                : (event.key === 'End'
                  ? tabs.length - 1
                  : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length);
              event.preventDefault();
              tabs[nextIndex]?.focus();
              tabs[nextIndex]?.click();
            }}
          >
            {SEGMENTATION_HELPER_VIEWS.map((view) => (
              <button
                key={view.id}
                id={`segmentation-view-tab-${view.id}`}
                type="button"
                role="tab"
                aria-selected={segmentationHelperView === view.id}
                tabIndex={segmentationHelperView === view.id ? 0 : -1}
                aria-controls={`segmentation-view-panel-${view.id}`}
                className={segmentationHelperView === view.id ? 'active' : ''}
                title={view.detail}
                onClick={() => {
                  cancelSegmentationDraft({
                    preservePendingSelection: true,
                    preserveVolumeRequest: true,
                  });
                  setSegmentationHelperView(view.id);
                  if (view.axis) {
                    setSegmentationHelperAxis(view.axis);
                    setActiveMprPane(view.axis);
                  } else if (view.id === '3d' && !activeTool.modes?.includes('3d')) {
                    setSegmentationTool('brush');
                  }
                }}
              >
                <strong>{view.label}</strong>
                {view.plane && <small>{view.plane}</small>}
              </button>
            ))}
          </nav>

          <div className="segmentation-helper-body">
            <aside className="segmentation-helper-sidebar" aria-label="Segmentation helper controls">
              <div className="segmentation-helper-view-summary">
                <span className="segmentation-helper-axis-dot" style={{ background: config.color }} />
                <div>
                  <strong>{SEGMENTATION_HELPER_VIEWS.find((view) => view.id === segmentationHelperView)?.detail}</strong>
                  <small>Crosshair: X {slicePosition.sagittal}, Y {slicePosition.coronal}, Z {slicePosition.axial}</small>
                </div>
              </div>

              <div className="segmentation-slice-sliders" aria-label="Slice navigation">
                {MPR_AXES.map((sliceAxis) => {
                  const sliceUpper = Math.max(0, (mprDimensions[sliceAxis] || 1) - 1);
                  return (
                    <label key={sliceAxis} htmlFor={`segmentation-helper-slice-${sliceAxis}`}>
                      <span>{MPR_AXIS_CONFIG[sliceAxis]?.sliceLabel || sliceAxis.toUpperCase()}</span>
                      <input
                        id={`segmentation-helper-slice-${sliceAxis}`}
                        type="range"
                        min="0"
                        max={sliceUpper}
                        value={slicePosition[sliceAxis]}
                        onChange={(event) => updateSlicePosition(sliceAxis, event.target.value, mprDimensions)}
                      />
                      <output>{slicePosition[sliceAxis]} / {sliceUpper}</output>
                    </label>
                  );
                })}
              </div>

              <div className="segmentation-segment-panel">
                <div className="segmentation-panel-title">
                  <h4>Segments</h4>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={addSegmentationSegment}>
                    Add new segment
                  </button>
                </div>
                <ul className="segmentation-segment-list" data-testid="segmentation-segment-list">
                  {segmentationSegments.length === 0 && (
                    <li className="muted">No segments yet. Choose an orientation, then add one.</li>
                  )}
                  {segmentationSegments.map((segment) => {
                    const selected = selectedSegmentationSegment?.id === segment.id;
                    const editing = editingSegmentationSegmentId === segment.id;
                    return (
                      <li
                        key={segment.id}
                        className={`segmentation-segment-row ${selected ? 'selected' : ''}`}
                        style={{ borderColor: selected ? segment.color : undefined }}
                      >
                        <button
                          type="button"
                          className="segmentation-segment-select"
                          onClick={() => {
                            cancelSegmentationDraft();
                            setSelectedSegmentationSegmentId(segment.id);
                            setSegmentationHelperAxis(segment.axis);
                            if (!['mpr', '3d'].includes(segmentationHelperView)) {
                              setSegmentationHelperView(SEGMENTATION_VIEW_BY_AXIS[segment.axis] || 'z');
                            }
                            setActiveMprPane(segment.axis);
                          }}
                        >
                          <span className="segmentation-segment-color" style={{ backgroundColor: segment.color }} />
                          <span>{segment.name}</span>
                          <small>{(segment.areas || []).length} areas</small>
                        </button>
                        <button
                          type="button"
                          className="annotation-entry-edit"
                          aria-label={`Edit ${segment.name}`}
                          onClick={() => {
                            cancelSegmentationDraft();
                            setSelectedSegmentationSegmentId(segment.id);
                            setSegmentationHelperAxis(segment.axis);
                            if (!['mpr', '3d'].includes(segmentationHelperView)) {
                              setSegmentationHelperView(SEGMENTATION_VIEW_BY_AXIS[segment.axis] || 'z');
                            }
                            setActiveMprPane(segment.axis);
                            setEditingSegmentationSegmentId(editing ? '' : segment.id);
                          }}
                        >
                          Edit
                        </button>
                        {editing && (
                          <div className="segmentation-segment-editor">
                            <label htmlFor={`segmentation-segment-name-${segment.id}`}>
                              Name
                              <input
                                id={`segmentation-segment-name-${segment.id}`}
                                type="text"
                                value={segment.name}
                                onChange={(event) => updateSegmentationSegment(segment.id, { name: event.target.value })}
                                onBlur={(event) => saveSegmentationSegmentPatch(segment.id, { name: event.target.value })}
                              />
                            </label>
                            <label htmlFor={`segmentation-segment-color-${segment.id}`}>
                              Color
                              <input
                                id={`segmentation-segment-color-${segment.id}`}
                                type="color"
                                value={segment.color}
                                onChange={(event) => saveSegmentationSegmentPatch(segment.id, { color: event.target.value })}
                              />
                            </label>
                            <label htmlFor={`segmentation-segment-axis-${segment.id}`}>
                              Creation axis
                              <input
                                id={`segmentation-segment-axis-${segment.id}`}
                                type="text"
                                value={MPR_AXIS_CONFIG[segment.axis]?.label || segment.axis}
                                readOnly
                              />
                            </label>
                            <label htmlFor={`segmentation-segment-min-slice-${segment.id}`}>
                              Min slice
                              <input
                                id={`segmentation-segment-min-slice-${segment.id}`}
                                type="number"
                                min="0"
                                max={Math.max(0, (
                                  segment.axis === 'sagittal'
                                    ? volumeDimensions[0]
                                    : (segment.axis === 'coronal' ? volumeDimensions[1] : volumeDimensions[2])
                                ) - 1)}
                                value={segment.minSlice}
                                onChange={(event) => updateSegmentationSegment(segment.id, { minSlice: Number(event.target.value) })}
                                onBlur={(event) => saveSegmentationSegmentPatch(segment.id, { minSlice: Number(event.target.value) })}
                              />
                            </label>
                            <label htmlFor={`segmentation-segment-max-slice-${segment.id}`}>
                              Max slice
                              <input
                                id={`segmentation-segment-max-slice-${segment.id}`}
                                type="number"
                                min="0"
                                max={Math.max(0, (
                                  segment.axis === 'sagittal'
                                    ? volumeDimensions[0]
                                    : (segment.axis === 'coronal' ? volumeDimensions[1] : volumeDimensions[2])
                                ) - 1)}
                                value={segment.maxSlice}
                                onChange={(event) => updateSegmentationSegment(segment.id, { maxSlice: Number(event.target.value) })}
                                onBlur={(event) => saveSegmentationSegmentPatch(segment.id, { maxSlice: Number(event.target.value) })}
                              />
                            </label>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </aside>

            <main
              id={`segmentation-view-panel-${segmentationHelperView}`}
              className="segmentation-helper-main"
              role="tabpanel"
              aria-labelledby={`segmentation-view-tab-${segmentationHelperView}`}
              aria-label="Segmentation helper workspace"
            >
              <div className="segmentation-helper-toolbar">
                <div className="segmentation-operation-buttons" aria-label="Selection operation">
                  <button
                    type="button"
                    className={segmentationOperation === 'add' ? 'active' : ''}
                    onClick={() => setSegmentationOperation('add')}
                  >
                    Add
                  </button>
                  <button
                    type="button"
                    className={segmentationOperation === 'subtract' ? 'active' : ''}
                    onClick={() => setSegmentationOperation('subtract')}
                  >
                    Subtract
                  </button>
                  <button
                    type="button"
                    disabled={!segmentationPendingSelection}
                    onClick={() => commitPendingSegmentationSelection('add')}
                  >
                    Add selection
                  </button>
                  <button
                    type="button"
                    disabled={!segmentationPendingSelection}
                    onClick={() => commitPendingSegmentationSelection('subtract')}
                  >
                    Subtract selection
                  </button>
                </div>
                <div className="segmentation-helper-current">
                  <span className="segmentation-segment-color" style={{ backgroundColor: selectedSegmentationSegment?.color || DEFAULT_SEGMENT_COLOR }} />
                  <strong>{selectedSegmentationSegment?.name || 'No segment'}</strong>
                  <span>{config.sliceLabel} {slicePosition[axis]} / {upper}</span>
                </div>
              </div>

              <div className="segmentation-tools-grid" aria-label="Segmentation tools">
                {SEGMENTATION_HELPER_TOOLS.map((tool) => {
                  const selected = segmentationTool === tool.id;
                  const supports3d = tool.modes?.includes('3d');
                  const disabledInView = segmentationHelperView === '3d';
                  const selectedMode = getActiveSegmentationToolMode(tool.id);
                  return (
                    <div
                      key={tool.id}
                      className={`segmentation-tool-tile ${selected ? 'active' : ''} ${selected && supports3d ? 'has-mode-switch' : ''}`}
                    >
                      <button
                        type="button"
                        className={`segmentation-tool-select ${selected ? 'active' : ''}`}
                        title={disabledInView ? 'Return to X, Y, or Z to edit the volume.' : tool.detail}
                        aria-label={`${tool.label}: ${tool.detail}`}
                        data-tooltip={`${tool.label}: ${tool.detail}`}
                        disabled={disabledInView}
                        onClick={() => {
                          setSegmentationTool(tool.id);
                          cancelSegmentationDraft();
                          setSegmentationVolumeStatus('');
                        }}
                      >
                        <SegmentationToolIcon icon={tool.icon} />
                        <span className="segmentation-tool-label">{tool.label}</span>
                      </button>
                      {selected && supports3d && (
                        <div
                          className="segmentation-tool-mode-switch"
                          role="group"
                          aria-label={`${tool.label} dimensional mode`}
                        >
                          {tool.modes.map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              className={selectedMode === mode ? 'active' : ''}
                              aria-pressed={selectedMode === mode}
                              aria-label={`${tool.label} ${mode.toUpperCase()} mode`}
                              title={`${mode.toUpperCase()} · ${tool.modeLabels?.[mode] || mode}`}
                              disabled={segmentationHelperView === '3d' && mode === '2d'}
                              onClick={() => {
                                cancelSegmentationDraft();
                                setSegmentationToolModes((previous) => ({ ...previous, [tool.id]: mode }));
                                setSegmentationVolumeStatus('');
                              }}
                            >
                              {mode.toUpperCase()}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="segmentation-tool-parameters">
                <label htmlFor="segmentation-brush-size">
                  Brush size
                  <input
                    id="segmentation-brush-size"
                    type="range"
                    min="2"
                    max="80"
                    value={segmentationBrushSize}
                    onChange={(event) => setSegmentationBrushSize(Number(event.target.value))}
                  />
                  <output>{segmentationBrushSize}px</output>
                </label>
                <label htmlFor="segmentation-sensitivity">
                  Sensitivity
                  <input
                    id="segmentation-sensitivity"
                    type="range"
                    min="2"
                    max="96"
                    value={segmentationSensitivity}
                    onChange={(event) => setSegmentationSensitivity(Number(event.target.value))}
                  />
                  <output>{segmentationSensitivity}</output>
                </label>
                <p className="muted">
                  <strong>{activeToolMode.toUpperCase()} · {activeTool.modeLabels?.[activeToolMode] || 'Slice'}</strong>
                  {' — '}
                  {activeTool.detail}
                </p>
                {SEGMENTATION_POINT_MARKER_TOOLS.has(segmentationTool) && (
                  <p className="muted">Defined points are shown as dots on the slice. Double-click closes polygon selections.</p>
                )}
                {(segmentationVolumeLoading || segmentationVolumeStatus) && (
                  <p
                    className={`segmentation-volume-status ${segmentationPendingSelection?.truncated ? 'warning' : ''}`}
                    role="status"
                    aria-live="polite"
                  >
                    {segmentationVolumeLoading ? 'Building 3D preview…' : segmentationVolumeStatus}
                  </p>
                )}
              </div>

              {segmentationTool === 'ml-helper' && (
                <div className="segmentation-ml-panel" aria-label="ML helper options">
                  <label htmlFor="segmentation-ml-group">
                    Method family
                    <select
                      id="segmentation-ml-group"
                      value={segmentationMlGroup}
                      onChange={(event) => changeSegmentationMlGroup(event.target.value)}
                    >
                      {SEGMENTATION_ML_METHOD_GROUPS.map((group) => (
                        <option key={group.id} value={group.id}>{group.label}</option>
                      ))}
                    </select>
                  </label>
                  <label htmlFor="segmentation-ml-method">
                    Segment function
                    <select
                      id="segmentation-ml-method"
                      value={segmentationMlMethod}
                      onChange={(event) => changeSegmentationMlMethod(event.target.value)}
                    >
                      {getSegmentationMlMethods(segmentationMlGroup).map((method) => (
                        <option key={method.id} value={method.id}>{method.label}</option>
                      ))}
                    </select>
                  </label>
                  {(SEGMENTATION_ML_PARAMETER_FIELDS[segmentationMlMethod] || []).map((field) => (
                    <label key={field.name} htmlFor={`segmentation-ml-${field.name}`}>
                      {field.label}
                      {field.type === 'select' ? (
                        <select
                          id={`segmentation-ml-${field.name}`}
                          value={segmentationMlParameters[field.name] ?? ''}
                          onChange={(event) => updateSegmentationMlParameter(field.name, event.target.value)}
                        >
                          {(field.options || []).map((option) => (
                            <option key={option} value={option}>{option}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id={`segmentation-ml-${field.name}`}
                          type={field.type}
                          min={field.min}
                          max={field.max}
                          step={field.step}
                          value={segmentationMlParameters[field.name] ?? ''}
                          onChange={(event) => updateSegmentationMlParameter(
                            field.name,
                            field.type === 'number' ? Number(event.target.value) : event.target.value,
                          )}
                        />
                      )}
                    </label>
                  ))}
                  <p className="muted">
                    {segmentationMlLoading ? 'Running analysis for this slice.' : (segmentationMlStatus || 'Click the slice to run once, cache this method result, and select the clicked segment.')}
                  </p>
                </div>
              )}

              {segmentationHelperView === 'mpr' && (
                <section className="segmentation-helper-mpr-grid" data-testid="segmentation-helper-mpr">
                  {MPR_AXES.map((previewAxis) => {
                    const previewConfig = MPR_AXIS_CONFIG[previewAxis];
                    const previewDimensions = getMprAxisImageDimensions(
                      previewAxis,
                      mprDimensions,
                      volumeCacheState.cache,
                    );
                    const previewSliceIndex = Number(slicePosition[previewAxis] || 0);
                    const previewCanonicalSliceIndex = getSegmentationCanonicalSliceIndex(
                      previewAxis,
                      previewSliceIndex,
                    );
                    const previewFallback = getFallbackProjectionImage(previewAxis, shellImageLayers);
                    const previewSegments = segmentationSegments.filter((segment) => (
                      segmentVisibleOnSlice(segment, previewAxis, previewCanonicalSliceIndex)
                    ));
                    return (
                      <button
                        key={previewAxis}
                        type="button"
                        className="segmentation-helper-mpr-pane"
                        style={{
                          '--segment-axis-color': previewConfig.color,
                          ...getMprCrosshairStyle(
                            previewAxis,
                            slicePosition,
                            mprDimensions,
                            mprProjectionMirror,
                          ),
                        }}
                        aria-label={`Edit ${previewConfig.sliceLabel} axis in ${previewConfig.label} plane`}
                        onClick={() => {
                          setSegmentationHelperAxis(previewAxis);
                          setSegmentationHelperView(SEGMENTATION_VIEW_BY_AXIS[previewAxis]);
                          setActiveMprPane(previewAxis);
                        }}
                        data-testid={`segmentation-helper-mpr-${previewAxis}`}
                      >
                        <header>
                          <strong>{previewConfig.sliceLabel}</strong>
                          <span>{previewConfig.label} · {previewSliceIndex}</span>
                        </header>
                        <div className="segmentation-helper-mpr-image">
                          {hasVolumeImageSource ? (
                            <MprSliceCanvas
                              axis={previewAxis}
                              volumeCache={volumeCacheState.cache}
                              overlayCaches={activeVolumeOverlayCaches}
                              volumeCacheStatus={volumeCacheState.status}
                              slicePosition={slicePosition}
                              dimensions={mprDimensions}
                              displayWindow={displayWindow}
                              displayDomain={displayValueDomain}
                              overlayOpacityMultiplier={annotationOpacityMultiplier}
                            />
                          ) : previewFallback ? (
                            <MprWindowedImage
                              className="mpr-fallback-projection"
                              src={previewFallback.url}
                              alt={`${previewConfig.label} segmentation helper fallback`}
                              displayWindow={displayWindow}
                              displayDomain={displayValueDomain}
                            />
                          ) : (
                            <span className="mpr-empty-volume">No volume stack images</span>
                          )}
                          <span className="mpr-crosshair-h" />
                          <span className="mpr-crosshair-v" />
                          <span className="mpr-crosshair-center" />
                          <svg
                            className="segmentation-helper-overlay mpr-projection-overlay"
                            viewBox={`0 0 ${previewDimensions.width} ${previewDimensions.height}`}
                            preserveAspectRatio="xMidYMid meet"
                            aria-label={`${previewConfig.sliceLabel} segmentation projection`}
                          >
                            {previewSegments.map((segment) => (
                              <g
                                key={`segmentation-mpr-mask-${previewAxis}-${segment.id}`}
                              >
                                {renderCompositedSegmentationSegment(segment, {
                                  color: segment.color,
                                  fillOpacity: segment.opacity ?? 0.2,
                                  axis: previewAxis,
                                  sliceIndex: previewCanonicalSliceIndex,
                                  imageWidth: previewDimensions.width,
                                  imageHeight: previewDimensions.height,
                                  volumeDimensions,
                                })}
                              </g>
                            ))}
                            {pendingVolumePreviewSegment && (
                              <g>
                                {renderCompositedSegmentationSegment(pendingVolumePreviewSegment, {
                                  color: '#fde047',
                                  fillOpacity: 0.3,
                                  axis: previewAxis,
                                  sliceIndex: previewCanonicalSliceIndex,
                                  imageWidth: previewDimensions.width,
                                  imageHeight: previewDimensions.height,
                                  volumeDimensions,
                                })}
                              </g>
                            )}
                          </svg>
                        </div>
                      </button>
                    );
                  })}
                  <p className="segmentation-helper-workspace-hint">
                    These three panes share one crosshair. Select a pane to open its editable axis view.
                  </p>
                </section>
              )}

              {segmentationHelperView === '3d' && (
                <section className="segmentation-helper-3d-stage" data-testid="segmentation-helper-3d-stage">
                  <Pt3GaussianSplatViewer
                    part={selectedPart}
                    volumeMetadata={segmentationHelper3dVolumeMetadata}
                    projectId={projectId}
                    volumeImageStack={volumeRendererImageStack}
                    volumeOverlayImageStacks={volumeRendererOverlayImageStacks}
                    splatParameters={splatParameters}
                    mode="volume"
                    rotation={mprRotation}
                    zoom={viewportTransform.zoom}
                    mirrorScale={mprAxisMirrorScale}
                    slicePosition={segmentationHelperCanonicalSlicePosition}
                    activeSliceAxis={lastActiveMprAxis}
                    rayMarchSettings={rayMarchSettings}
                    splatViewSettings={splatViewSettings}
                    onRayMarchSettingsChange={setRayMarchSettings}
                    onSplatViewSettingsChange={setSplatViewSettings}
                    onRotationChange={setMprRotation}
                    onZoomChange={(nextZoom) => setViewportTransform((previous) => ({ ...previous, zoom: nextZoom }))}
                    onResetView={resetViewport}
                    showRayMarchControls={false}
                    showSplatControls={false}
                    showRealOptimizationControls={false}
                    vectorAnnotations={helper3dAnnotations}
                    showAnnotations
                    annotationOpacityMultiplier={annotationOpacityMultiplier}
                  />
                  <div className="segmentation-helper-3d-hint">
                    <strong>Volume context</strong>
                    <span>Orbit to inspect the exact segment surface over sampled anatomy context. Paint or seed from X, Y, or Z.</span>
                    {segmentation3dSurfacePreviewTruncated && (
                      <span className="segmentation-volume-status warning" role="status">
                        3D surface preview truncated for performance; the stored mask is intact.
                      </span>
                    )}
                  </div>
                </section>
              )}

              {!['mpr', '3d'].includes(segmentationHelperView) && (
                <div
                  className={`segmentation-slice-stage ${brushPointerVisible ? 'show-brush-pointer' : ''} ${activeToolMode === '3d' ? 'mode-3d' : ''}`}
                  style={{
                    '--segment-axis-color': config.color,
                    '--brush-pointer-x': brushPointerVisible ? `${segmentationPointerPreview.displayX}px` : '50%',
                    '--brush-pointer-y': brushPointerVisible ? `${segmentationPointerPreview.displayY}px` : '50%',
                    '--brush-pointer-size': `${brushPointerDiameter}px`,
                    ...crosshairStyle,
                  }}
                  onWheel={handleSegmentationHelperWheel}
                  onPointerDown={handleSegmentationStagePointerDown}
                  onPointerMove={handleSegmentationStagePointerMove}
                  onPointerUp={handleSegmentationStagePointerUp}
                  onPointerLeave={handleSegmentationStagePointerLeave}
                  onPointerCancel={handleSegmentationStagePointerCancel}
                  onDoubleClick={completeSegmentationPolygon}
                  data-testid="segmentation-helper-stage"
                >
                  {hasVolumeImageSource ? (
                    <MprSliceCanvas
                      axis={axis}
                      volumeCache={volumeCacheState.cache}
                      overlayCaches={activeVolumeOverlayCaches}
                      volumeCacheStatus={volumeCacheState.status}
                      slicePosition={slicePosition}
                      dimensions={mprDimensions}
                      displayWindow={displayWindow}
                      displayDomain={displayValueDomain}
                      overlayOpacityMultiplier={annotationOpacityMultiplier}
                    />
                  ) : fallbackImage ? (
                    <MprWindowedImage
                      className="mpr-fallback-projection"
                      src={fallbackImage.url}
                      alt={`${config.label} segmentation helper fallback`}
                      displayWindow={displayWindow}
                      displayDomain={displayValueDomain}
                    />
                  ) : (
                    <span className="mpr-empty-volume">No volume stack images</span>
                  )}
                  <svg
                    className="segmentation-helper-overlay mpr-projection-overlay"
                    viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
                    preserveAspectRatio="xMidYMid meet"
                    aria-label="Segmentation helper overlay"
                  >
                    {visibleSegments.map((segment) => (
                      <g
                        key={`segmentation-segment-mask-${segment.id}`}
                        className={segment.id === selectedSegmentationSegment?.id ? 'active-segment' : ''}
                      >
                        {renderCompositedSegmentationSegment(segment, {
                          color: segment.color,
                          fillOpacity: segment.opacity ?? 0.2,
                          axis,
                          sliceIndex: canonicalSliceIndex,
                          imageWidth: dimensions.width,
                          imageHeight: dimensions.height,
                          volumeDimensions,
                        })}
                      </g>
                    ))}
                    {pendingVolumePreviewSegment && (
                      <g>
                        {renderCompositedSegmentationSegment(pendingVolumePreviewSegment, {
                          color: '#fde047',
                          fillOpacity: 0.3,
                          axis,
                          sliceIndex: canonicalSliceIndex,
                          imageWidth: dimensions.width,
                          imageHeight: dimensions.height,
                          volumeDimensions,
                        })}
                      </g>
                    )}
                    {segmentationPendingSelection?.mode !== '3d' && renderSegmentationShape(segmentationPendingSelection, {
                      color: '#fde047',
                      fillColor: '#fde047',
                      fillOpacity: 0.18,
                      preview: true,
                      strokeWidth: 3,
                    })}
                    {segmentationDraftShape && renderSegmentationShape(segmentationDraftShape, {
                      color: '#f8fafc',
                      fillColor: selectedSegmentationSegment?.color || DEFAULT_SEGMENT_COLOR,
                      fillOpacity: 0.15,
                      preview: true,
                      strokeWidth: 3,
                    })}
                    {draftPoints.map((point, index) => (
                      <circle
                        key={`segmentation-point-${index}-${point.x}-${point.y}`}
                        className="segmentation-helper-point"
                        cx={point.x}
                        cy={point.y}
                        r={Math.max(1.5, Math.min(dimensions.width, dimensions.height) * 0.006)}
                      />
                    ))}
                  </svg>
                </div>
              )}
            </main>
          </div>
        </div>
      </div>
    );
  };

  const renderMetadataTable = (rows, emptyMessage) => {
    if (!rows.length) return <p className="metadata-modal-empty">{emptyMessage}</p>;
    return (
      <table className="metadata-modal-table">
        <thead>
          <tr>
            <th scope="col">Metadata path</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.path}>
              <td className="metadata-modal-path"><code>{row.path}</code></td>
              <td><pre>{formatMetadataValue(row.value)}</pre></td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  };

  const renderMetadataModalBody = () => {
    if (!selectedPart) return <p className="metadata-modal-empty">Select a part to view metadata.</p>;
    const { nsiproEntries, otherMetadata } = getPartMetadataBreakout(selectedPart);
    const otherRows = collectMetadataLeafEntries(otherMetadata);
    return (
      <div className="part-metadata-modal-body">
        <div className="metadata-modal-part-summary">
          <strong>{selectedPart.display_name || selectedPart.serial_number || selectedPart.id}</strong>
          <span>{selectedPart.serial_number || selectedPart.id}</span>
        </div>
        <div className="project-tabs metadata-modal-tabs" role="tablist" aria-label="Part metadata categories">
          <button
            type="button"
            role="tab"
            aria-selected={activeMetadataTab === 'nsipro'}
            className={`project-tab ${activeMetadataTab === 'nsipro' ? 'active' : ''}`}
            onClick={() => setActiveMetadataTab('nsipro')}
          >
            .nsipro
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeMetadataTab === 'other'}
            className={`project-tab ${activeMetadataTab === 'other' ? 'active' : ''}`}
            onClick={() => setActiveMetadataTab('other')}
          >
            Other
          </button>
        </div>
        <section
          className="metadata-modal-tab-panel"
          role="tabpanel"
          aria-label={activeMetadataTab === 'nsipro' ? '.nsipro metadata' : 'Other metadata'}
        >
          {activeMetadataTab === 'nsipro'
            ? renderMetadataTable(nsiproEntries, 'No .nsipro metadata was found for the current part.')
            : renderMetadataTable(otherRows, 'No other metadata was found for the current part.')}
        </section>
      </div>
    );
  };

  const renderWorkbenchModal = () => {
    if (!activeWorkbenchModal) return null;
    const modalTitleByType = {
      parts: 'Part Selection',
      annotations: 'Annotations',
      metadata: 'Part Metadata',
    };
    const modalTitle = modalTitleByType[activeWorkbenchModal] || 'Workbench';
    const renderBody = () => {
      if (activeWorkbenchModal === 'parts') return renderPartSummaryPane();
      if (activeWorkbenchModal === 'metadata') return renderMetadataModalBody();
      return renderAnnotationsPane();
    };
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
            {renderBody()}
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
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!selectedPart}
            onClick={() => {
              setActiveMetadataTab('nsipro');
              setActiveWorkbenchModal('metadata');
            }}
          >
            Metadata
          </button>
          {selectedPart && (
            <>
              <button
                className="btn btn-success"
                disabled={savingPartId === selectedPart.id}
                onClick={() => updatePartReviewState(selectedPart, 'pass')}
              >
                Pass
              </button>
              <button
                className="btn btn-secondary"
                disabled={savingPartId === selectedPart.id}
                onClick={() => updatePartReviewState(selectedPart, 'unreviewed')}
              >
                Reset
              </button>
              <button
                className="btn btn-danger"
                disabled={savingPartId === selectedPart.id}
                onClick={() => updatePartReviewState(selectedPart, 'reject_confirmed')}
              >
                Reject
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
            <li>Reject: {inspectorHotkeys.reject_classification.toUpperCase()}</li>
            <li>Toggle this help: {inspectorHotkeys.toggle_shortcut_help.toUpperCase()}</li>
          </ul>
        </div>
      )}
      <div className="pt3-inspection-layout" data-testid="pt3-inspection-layout">
        <div className="pt3-mpr-center">
          {renderMprPane()}
        </div>
        <aside className="pt3-annotations-column" aria-label="PT3 annotations">
          {renderAnnotationsPane()}
        </aside>
      </div>
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
	    const pixelsPerMm = Number(getCalibrationForImage(getAnnotationSourceImageIdForImage(imageId))?.pixels_per_mm || 0);
	    const distancePx = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
	    return pixelsPerMm > 0 ? distancePx / pixelsPerMm : null;
	  };

	  const getBoxWithDerivedDimensions = (box, imageId) => {
	    if (!isFiniteAnnotationBox(box)) return box;
	    const pixelsPerMm = Number(getCalibrationForImage(getAnnotationSourceImageIdForImage(imageId))?.pixels_per_mm || 0);
	    if (pixelsPerMm <= 0) return box;
	    const widthMm = Number.isFinite(Number(box.widthMm)) ? Number(box.widthMm) : Number(box.width) / pixelsPerMm;
	    const heightMm = Number.isFinite(Number(box.heightMm)) ? Number(box.heightMm) : Number(box.height) / pixelsPerMm;
	    return { ...box, widthMm, heightMm };
	  };

  const getAnnotationSurfacePointerPosition = (event) => {
    const surface = event.currentTarget;
    const image = surface.tagName === 'IMG'
      ? surface
      : surface.querySelector('img.inspection-view-image:not(.analysis-overlay-image)') || surface.querySelector('img');
    const rect = image?.getBoundingClientRect?.() || surface.getBoundingClientRect();
    const naturalWidth = Number(image?.naturalWidth || rect.width);
    const naturalHeight = Number(image?.naturalHeight || rect.height);
    const transform = getContainedImageTransform({
      elementRect: rect,
      sourceWidth: naturalWidth,
      sourceHeight: naturalHeight,
    });
    const point = clientPointToSource(transform, event, { rejectOutside: true });
    if (!point) return null;
    return { x: point.x, y: point.y, imageWidth: naturalWidth, imageHeight: naturalHeight };
  };

  const getTileGeometryPointerPosition = (event, geometry, { clampToImage = false } = {}) => {
    const surface = event.currentTarget?.closest?.('.inspection-image-annotation-surface')
      || event.currentTarget;
    const image = surface?.querySelector?.('img.inspection-view-image:not(.analysis-overlay-image)')
      || surface?.querySelector?.('img');
    const rect = image?.getBoundingClientRect?.() || surface?.getBoundingClientRect?.();
    const naturalWidth = Number(image?.naturalWidth || rect?.width);
    const naturalHeight = Number(image?.naturalHeight || rect?.height);
    const geometryWidth = Number(geometry?.imageWidth);
    const geometryHeight = Number(geometry?.imageHeight);
    const transform = getContainedImageTransform({
      elementRect: rect,
      sourceWidth: naturalWidth,
      sourceHeight: naturalHeight,
    });
    const point = clientPointToSource(transform, event, {
      rejectOutside: !clampToImage,
      clamp: clampToImage,
    });
    if (
      !point
      || !Number.isFinite(geometryWidth)
      || !Number.isFinite(geometryHeight)
      || geometryWidth <= 0
      || geometryHeight <= 0
      || !Number.isFinite(naturalWidth)
      || !Number.isFinite(naturalHeight)
      || naturalWidth <= 0
      || naturalHeight <= 0
    ) return null;
    return {
      x: point.x * (geometryWidth / naturalWidth),
      y: point.y * (geometryHeight / naturalHeight),
    };
  };

  const setTileAnnotationGeometryDragPreview = (preview) => {
    tileGeometryDragPreviewRef.current = preview;
    setTileGeometryDragPreview(preview);
  };

  const startTileAnnotationGeometryDrag = (event, kind, operation, geometry, imageId) => {
    if (
      !geometry?.id
      || (event.button !== undefined && event.button !== 0)
      || !annotations.some((annotation) => String(annotation.id) === String(geometry.id))
    ) return;
    const startPoint = getTileGeometryPointerPosition(event, geometry);
    if (!startPoint) return;
    event.preventDefault();
    event.stopPropagation();
    suppressNextTileClickRef.current = true;
    setSelectedAnnotationId(geometry.id);
    setAnnotationToolMode('');
    setTileAnnotationDraft(null);
    setTileAnnotationPreview(null);
    tileAnnotationDraftRef.current = null;
    const source = { ...geometry };
    tileAnnotationGeometryDragRef.current = {
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      kind,
      operation,
      imageId: String(imageId || geometry.imageId || ''),
      source,
      startPoint,
    };
    setTileAnnotationGeometryDragPreview({
      kind,
      imageId: String(imageId || geometry.imageId || ''),
      geometry: source,
    });
    safeSetPointerCapture(event.currentTarget, event.pointerId);
  };

  const handleTileAnnotationGeometryDragMove = (event) => {
    const drag = tileAnnotationGeometryDragRef.current;
    if (!drag || (
      drag.pointerId !== undefined
      && event.pointerId !== undefined
      && drag.pointerId !== event.pointerId
    )) return;
    const position = getTileGeometryPointerPosition(event, drag.source, { clampToImage: true });
    if (!position) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = { width: drag.source.imageWidth, height: drag.source.imageHeight };
    const delta = {
      x: position.x - drag.startPoint.x,
      y: position.y - drag.startPoint.y,
    };
    let geometry = null;
    if (drag.kind === 'line') {
      geometry = drag.operation === 'translate'
        ? translateLine(drag.source, delta, bounds)
        : moveLineEndpoint(drag.source, drag.operation, position, bounds);
      if (geometry) {
        geometry = {
          ...geometry,
          distancePx: Math.hypot(geometry.x2 - geometry.x1, geometry.y2 - geometry.y1),
          distanceMm: getLineDistanceMm(geometry, drag.imageId),
        };
      }
    } else if (drag.kind === 'box') {
      geometry = drag.operation === 'translate'
        ? translateBox(drag.source, delta, bounds)
        : moveBoxCorner(drag.source, drag.operation, position, bounds);
    }
    if (geometry) {
      setTileAnnotationGeometryDragPreview({
        kind: drag.kind,
        imageId: drag.imageId,
        geometry,
      });
    }
  };

  const finishTileAnnotationGeometryDrag = async (event, { cancel = false } = {}) => {
    const drag = tileAnnotationGeometryDragRef.current;
    if (!drag || (
      drag.pointerId !== undefined
      && event.pointerId !== undefined
      && drag.pointerId !== event.pointerId
    )) return;
    event.preventDefault();
    event.stopPropagation();
    safeReleasePointerCapture(drag.captureTarget, drag.pointerId);
    const preview = tileGeometryDragPreviewRef.current;
    tileAnnotationGeometryDragRef.current = null;
    setTileAnnotationGeometryDragPreview(null);
    suppressNextTileClickRef.current = true;
    if (cancel || !preview?.geometry) return;
    const comparisonFields = preview.kind === 'line'
      ? ['x1', 'y1', 'x2', 'y2']
      : ['x', 'y', 'width', 'height'];
    const changed = comparisonFields.some((field) => (
      Number(preview.geometry[field]) !== Number(drag.source[field])
    ));
    if (!changed) return;
    if (preview.kind === 'line') {
      await updateMeasurementAnnotationLine(preview.geometry.id, preview.geometry);
    } else if (preview.kind === 'box') {
      await updateBoxAnnotationGeometry(preview.geometry.id, preview.geometry);
    }
  };

  const makeBoxFromPoints = (firstPoint, secondPoint) => {
    if (!firstPoint || !secondPoint) return null;
    const x = Math.min(firstPoint.x, secondPoint.x);
    const y = Math.min(firstPoint.y, secondPoint.y);
    const width = Math.abs(secondPoint.x - firstPoint.x);
    const height = Math.abs(secondPoint.y - firstPoint.y);
    return {
      x,
      y,
      width,
      height,
      imageWidth: secondPoint.imageWidth || firstPoint.imageWidth,
      imageHeight: secondPoint.imageHeight || firstPoint.imageHeight,
    };
  };

  const getMprAnnotationPointerPosition = (
    event,
    axis,
    explicitSliceIndex,
    { clampToImage = false } = {},
  ) => {
    const context = getMprAnnotationSliceContext(axis, explicitSliceIndex);
    const eventTarget = event.currentTarget;
    const surface = eventTarget?.classList?.contains('mpr-crosshair-preview')
      ? eventTarget
      : eventTarget?.closest?.('.mpr-crosshair-preview') || eventTarget;
    if (!surface?.getBoundingClientRect) return null;
    const rect = surface.getBoundingClientRect();
    const displayAxes = MPR_DISPLAY_AXES_BY_VIEW[axis] || MPR_DISPLAY_AXES_BY_VIEW.axial;
    const transform = getContainedImageTransform({
      elementRect: rect,
      sourceWidth: context.imageWidth,
      sourceHeight: context.imageHeight,
      mirrorX: mprProjectionMirror[displayAxes.x] === true,
      mirrorY: mprProjectionMirror[displayAxes.y] === true,
    });
    const point = clientPointToSource(transform, event, {
      rejectOutside: !clampToImage,
      clamp: clampToImage,
    });
    if (!point) return null;
    return { x: point.x, y: point.y, imageWidth: context.imageWidth, imageHeight: context.imageHeight, axis: context.axis, sliceIndex: context.sliceIndex, sliceKey: context.sliceKey, imageId: context.imageId };
  };

	  const handleTileAnnotationPointerDown = (event, imageId) => {
	    if (!annotationToolMode) return false;
	    event.preventDefault();
	    event.stopPropagation();
    const position = getAnnotationSurfacePointerPosition(event);
    if (!position) return true;
    const annotationImageId = getAnnotationSourceImageIdForImage(imageId);
    if (!requireCalibrationForAnnotation(annotationImageId, { surface: 'tile', toolMode: annotationToolMode })) return true;
    if (annotationToolMode === 'measure') {
      const firstPoint = tileAnnotationDraft?.mode === 'measure' ? tileAnnotationDraft : null;
      if (!firstPoint) {
        setTileAnnotationDraft({ ...position, mode: 'measure', imageId: annotationImageId });
        return true;
      }
      const line = { x1: firstPoint.x, y1: firstPoint.y, x2: position.x, y2: position.y, imageWidth: position.imageWidth, imageHeight: position.imageHeight };
      const existingLineCount = (storedMeasurementLinesByImageId[String(annotationImageId || '')] || []).length;
      const color = MEASUREMENT_COLORS[existingLineCount % MEASUREMENT_COLORS.length];
	      createMeasurementAnnotation({
	        imageId: annotationImageId,
	        line,
	        name: nextMeasurementName(classifyMeasurementLine(line)),
	        color,
	        distanceMm: getLineDistanceMm(line, annotationImageId),
	      });
	      setTileAnnotationDraft(null);
	      setTileAnnotationPreview(null);
	      setAnnotationToolMode('');
	      return true;
	    }
	    if (annotationToolMode === 'box' || annotationToolMode === 'crop') return true;
	    return true;
	  };

	  const handleTileBoxPointerDown = (event, imageId) => {
	    if (!['box', 'crop'].includes(annotationToolMode)) return false;
	    if (event.button !== undefined && event.button !== 0) return false;
	    event.preventDefault();
	    event.stopPropagation();
	    const position = getAnnotationSurfacePointerPosition(event);
	    if (!position) return true;
	    const annotationImageId = getAnnotationSourceImageIdForImage(imageId);
	    if (!requireCalibrationForAnnotation(annotationImageId, { surface: 'tile', toolMode: annotationToolMode })) return true;
	    const nextPoint = { ...position, mode: 'box', imageId: annotationImageId };
	    tileAnnotationDraftRef.current = nextPoint;
	    setTileAnnotationDraft(nextPoint);
	    setTileAnnotationPreview(null);
	    suppressNextTileClickRef.current = true;
	    safeSetPointerCapture(event.currentTarget, event.pointerId);
	    return true;
	  };

	  const handleTileBoxPointerUp = (event, imageId) => {
	    if (!['box', 'crop'].includes(annotationToolMode)) return false;
	    event.preventDefault();
	    event.stopPropagation();
	    suppressNextTileClickRef.current = true;
	    const firstPoint = tileAnnotationDraftRef.current || (tileAnnotationDraft?.mode === 'box' ? tileAnnotationDraft : null);
	    const position = getAnnotationSurfacePointerPosition(event);
	    if (firstPoint && position) {
	      const annotationImageId = getAnnotationSourceImageIdForImage(imageId);
	      const box = makeBoxFromPoints(firstPoint, position);
	      if (isFiniteAnnotationBox(box)) {
        if (annotationToolMode === 'crop') {
          createCropChildImage({ parentImageId: annotationImageId, cropBox: box });
        } else {
	        const existingBoxCount = (storedBoxAnnotationsByImageId[String(annotationImageId || '')] || []).length;
	        createBoxAnnotation({
	          imageId: annotationImageId,
	          box,
	          name: 'Drawn bounding box',
	          color: MEASUREMENT_COLORS[existingBoxCount % MEASUREMENT_COLORS.length],
	        });
        }
	      }
	    }
	    tileAnnotationDraftRef.current = null;
	    setTileAnnotationDraft(null);
	    setTileAnnotationPreview(null);
	    setAnnotationToolMode('');
	    safeReleasePointerCapture(event.currentTarget, event.pointerId);
	    return true;
	  };

	  const handleTileBoxPointerCancel = (event) => {
	    if (!tileAnnotationDraftRef.current && tileAnnotationDraft?.mode !== 'box') return;
	    event.preventDefault();
	    event.stopPropagation();
	    tileAnnotationDraftRef.current = null;
	    setTileAnnotationDraft(null);
	    setTileAnnotationPreview(null);
	    setAnnotationToolMode('');
	    suppressNextTileClickRef.current = true;
	    setFullscreenBoxActive(false);
    setFullscreenCropActive(false);
    safeReleasePointerCapture(event.currentTarget, event.pointerId);
	  };

	  const handleTileAnnotationPointerMove = (event, imageId) => {
	    const annotationImageId = getAnnotationSourceImageIdForImage(imageId);
	    const position = getAnnotationSurfacePointerPosition(event);
	    if (!position) return;
	    if (annotationToolMode === 'measure' && tileAnnotationDraft?.mode === 'measure' && String(tileAnnotationDraft.imageId || '') === String(annotationImageId || '')) {
	      const line = {
	        id: 'tile-measure-preview',
	        imageId: String(annotationImageId || ''),
	        x1: tileAnnotationDraft.x,
	        y1: tileAnnotationDraft.y,
	        x2: position.x,
	        y2: position.y,
	        imageWidth: position.imageWidth,
	        imageHeight: position.imageHeight,
	        color: '#f97316',
	        distancePx: Math.hypot(position.x - tileAnnotationDraft.x, position.y - tileAnnotationDraft.y),
	        distanceMm: getLineDistanceMm(
	          { x1: tileAnnotationDraft.x, y1: tileAnnotationDraft.y, x2: position.x, y2: position.y },
	          annotationImageId,
	        ),
	      };
	      setTileAnnotationPreview({ mode: 'measure', imageId: String(annotationImageId || ''), line });
	      return;
	    }
	    const firstPoint = tileAnnotationDraftRef.current || (tileAnnotationDraft?.mode === 'box' ? tileAnnotationDraft : null);
	    if (['box', 'crop'].includes(annotationToolMode) && firstPoint && String(firstPoint.imageId || '') === String(annotationImageId || '')) {
	      const box = {
	        ...makeBoxFromPoints(firstPoint, position),
	        id: 'tile-box-preview',
	        imageId: String(annotationImageId || ''),
	        color: '#f97316',
	      };
	      setTileAnnotationPreview({ mode: annotationToolMode, imageId: String(annotationImageId || ''), box });
	    }
	  };

  const handleMprAnnotationPointerDown = (event, axis) => {
    if (!['measure', 'box', 'cube'].includes(annotationToolMode)) return false;
    if (event.button !== undefined && event.button !== 0) return false;
    event.preventDefault();
    event.stopPropagation();
    setActiveMprPane(axis);
    const sliceIndex = Number(slicePosition[axis] || 0);
    const position = getMprAnnotationPointerPosition(event, axis, sliceIndex);
    if (!position) return true;
    if (annotationToolMode === 'measure'
      && !requireCalibrationForAnnotation(position.imageId, { surface: 'tile', toolMode: annotationToolMode })) return true;
    if (annotationToolMode === 'measure') {
      const firstPoint = mprAnnotationDraft?.mode === 'measure' && mprAnnotationDraft.axis === axis
        ? mprAnnotationDraft
        : null;
      if (!firstPoint) {
        setMprAnnotationDraft({ ...position, mode: 'measure', axis, sliceIndex });
        return true;
      }
      const line = {
        x1: firstPoint.x,
        y1: firstPoint.y,
        x2: position.x,
        y2: position.y,
        imageWidth: position.imageWidth,
        imageHeight: position.imageHeight,
        axis,
        slice_index: firstPoint.sliceIndex,
      };
      const key = firstPoint.sliceKey || getMprSliceKey(axis, firstPoint.sliceIndex);
      const existingLineCount = (storedMprMeasurementLinesBySlice[key] || []).length;
      createMeasurementAnnotation({
        imageId: firstPoint.imageId || getMprAnnotationImage(axis),
        line,
        name: nextMeasurementName(classifyMeasurementLine(line)),
        color: MEASUREMENT_COLORS[existingLineCount % MEASUREMENT_COLORS.length],
        modality: 'volume',
        geometryPatch: { axis, slice_index: firstPoint.sliceIndex },
      });
      setMprAnnotationDraft(null);
      setMprAnnotationPreview(null);
      setAnnotationToolMode('');
      return true;
    }
    const nextPoint = { ...position, mode: annotationToolMode, axis, sliceIndex };
    mprAnnotationDraftRef.current = nextPoint;
    if (!(annotationToolMode === 'cube' && mprAnnotationDraft?.mode === 'cube-pending')) {
      setMprAnnotationDraft(nextPoint);
    }
    setMprAnnotationPreview(null);
    safeSetPointerCapture(event.currentTarget, event.pointerId);
    return true;
  };

  const handleMprAnnotationPointerMove = (event, axis) => {
    if (!['measure', 'box', 'cube'].includes(annotationToolMode)) return;
    const sliceIndex = Number(slicePosition[axis] || 0);
    const position = getMprAnnotationPointerPosition(event, axis, annotationToolMode === 'measure' ? mprAnnotationDraft?.sliceIndex : sliceIndex);
    if (!position) return;
    if (annotationToolMode === 'measure' && mprAnnotationDraft?.mode === 'measure' && mprAnnotationDraft.axis === axis) {
      const line = {
        id: 'mpr-measure-preview',
        imageId: mprAnnotationDraft.sliceKey || getMprSliceKey(axis, mprAnnotationDraft.sliceIndex),
        x1: mprAnnotationDraft.x,
        y1: mprAnnotationDraft.y,
        x2: position.x,
        y2: position.y,
        imageWidth: position.imageWidth,
        imageHeight: position.imageHeight,
        axis,
        sliceIndex: mprAnnotationDraft.sliceIndex,
        color: DEFAULT_ANNOTATION_COLOR,
        distancePx: Math.hypot(position.x - mprAnnotationDraft.x, position.y - mprAnnotationDraft.y),
        distanceMm: null,
      };
      setMprAnnotationPreview({ mode: 'measure', axis, sliceIndex: mprAnnotationDraft.sliceIndex, line });
      return;
    }
    const firstPoint = mprAnnotationDraftRef.current;
    if (firstPoint && firstPoint.axis === axis && ['box', 'cube'].includes(annotationToolMode)) {
      const box = {
        ...makeBoxFromPoints(firstPoint, position),
        id: `mpr-${annotationToolMode}-preview`,
        imageId: position.sliceKey || getMprSliceKey(axis, sliceIndex),
        color: DEFAULT_ANNOTATION_COLOR,
        fillOpacity: DEFAULT_ANNOTATION_FILL_OPACITY,
        axis,
        sliceIndex,
      };
      setMprAnnotationPreview({ mode: annotationToolMode, axis, sliceIndex, box });
    }
  };

  const handleMprAnnotationPointerUp = (event, axis) => {
    if (!['box', 'cube'].includes(annotationToolMode)) return false;
    event.preventDefault();
    event.stopPropagation();
    const firstPoint = mprAnnotationDraftRef.current;
    const sliceIndex = Number(slicePosition[axis] || 0);
    const position = getMprAnnotationPointerPosition(event, axis, sliceIndex);
    if (firstPoint && position && firstPoint.axis === axis) {
      const box = {
        ...makeBoxFromPoints(firstPoint, position),
        axis,
        sliceIndex,
      };
      if (isFiniteAnnotationBox(box)) {
        if (annotationToolMode === 'box') {
          const key = position.sliceKey || getMprSliceKey(axis, sliceIndex);
          const existingBoxCount = (storedMprBoxAnnotationsBySlice[key] || []).length;
          createBoxAnnotation({
            imageId: position.imageId || getMprAnnotationImage(axis),
            box,
            name: 'Drawn MPR bounding box',
            color: MEASUREMENT_COLORS[existingBoxCount % MEASUREMENT_COLORS.length],
            modality: 'volume',
            geometryPatch: { axis, slice_index: sliceIndex, box: { axis, slice_index: sliceIndex } },
          });
          setAnnotationToolMode('');
        } else {
          const firstCubeBox = mprAnnotationDraft?.mode === 'cube-pending' ? mprAnnotationDraft.box : null;
          if (firstCubeBox && firstCubeBox.axis === axis && Number(firstCubeBox.sliceIndex) !== sliceIndex) {
            createCubeAnnotation({
              axis,
              firstBox: firstCubeBox,
              secondBox: box,
              color: DEFAULT_ANNOTATION_COLOR,
            });
            setAnnotationToolMode('');
            setMprAnnotationDraft(null);
          } else {
            setMprAnnotationDraft({ mode: 'cube-pending', axis, sliceIndex, box });
          }
        }
      }
    }
    mprAnnotationDraftRef.current = null;
    setMprAnnotationPreview(null);
    if (annotationToolMode !== 'cube') setMprAnnotationDraft(null);
    safeReleasePointerCapture(event.currentTarget, event.pointerId);
    return true;
  };

  const handleMprAnnotationPointerCancel = (event) => {
    if (!mprAnnotationDraftRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    mprAnnotationDraftRef.current = null;
    setMprAnnotationPreview(null);
    safeReleasePointerCapture(event.currentTarget, event.pointerId);
  };

  const setMprAnnotationGeometryDragPreview = (preview) => {
    mprGeometryDragPreviewRef.current = preview;
    setMprGeometryDragPreview(preview);
  };

  const getMprGeometryPointerPosition = (event, axis, sliceIndex, geometry, options = {}) => {
    const position = getMprAnnotationPointerPosition(event, axis, sliceIndex, options);
    const geometryWidth = Number(geometry?.imageWidth);
    const geometryHeight = Number(geometry?.imageHeight);
    if (
      !position
      || !Number.isFinite(geometryWidth)
      || !Number.isFinite(geometryHeight)
      || geometryWidth <= 0
      || geometryHeight <= 0
      || !Number.isFinite(Number(position.imageWidth))
      || !Number.isFinite(Number(position.imageHeight))
      || Number(position.imageWidth) <= 0
      || Number(position.imageHeight) <= 0
    ) return null;
    return {
      x: position.x * (geometryWidth / Number(position.imageWidth)),
      y: position.y * (geometryHeight / Number(position.imageHeight)),
    };
  };

  const startMprAnnotationGeometryDrag = (event, kind, operation, geometry, axis, sliceIndex) => {
    if (
      annotationToolMode
      || !geometry?.id
      || (event.button !== undefined && event.button !== 0)
      || !annotations.some((annotation) => String(annotation.id) === String(geometry.id))
    ) return;
    const startPoint = getMprGeometryPointerPosition(event, axis, sliceIndex, geometry);
    if (!startPoint) return;
    event.preventDefault();
    event.stopPropagation();
    setActiveMprPane(axis);
    setSelectedAnnotationId(geometry.id);
    const source = { ...geometry };
    mprAnnotationGeometryDragRef.current = {
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      kind,
      operation,
      axis,
      sliceIndex,
      source,
      startPoint,
    };
    setMprAnnotationGeometryDragPreview({ kind, geometry: source });
    safeSetPointerCapture(event.currentTarget, event.pointerId);
  };

  const handleMprAnnotationGeometryDragMove = (event) => {
    const drag = mprAnnotationGeometryDragRef.current;
    if (!drag || (
      drag.pointerId !== undefined
      && event.pointerId !== undefined
      && drag.pointerId !== event.pointerId
    )) return;
    const position = getMprGeometryPointerPosition(
      event,
      drag.axis,
      drag.sliceIndex,
      drag.source,
      { clampToImage: true },
    );
    if (!position) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = { width: drag.source.imageWidth, height: drag.source.imageHeight };
    const delta = {
      x: position.x - drag.startPoint.x,
      y: position.y - drag.startPoint.y,
    };
    let geometry = null;
    if (drag.kind === 'line') {
      geometry = drag.operation === 'translate'
        ? translateLine(drag.source, delta, bounds)
        : moveLineEndpoint(drag.source, drag.operation, position, bounds);
      if (geometry) {
        const distancePx = Math.hypot(geometry.x2 - geometry.x1, geometry.y2 - geometry.y1);
        geometry = {
          ...geometry,
          distancePx,
          distanceMm: getLineDistanceMm(geometry, geometry.imageId),
        };
      }
    } else if (drag.kind === 'box') {
      geometry = drag.operation === 'translate'
        ? translateBox(drag.source, delta, bounds)
        : moveBoxCorner(drag.source, drag.operation, position, bounds);
    }
    if (geometry) setMprAnnotationGeometryDragPreview({ kind: drag.kind, geometry });
  };

  const finishMprAnnotationGeometryDrag = async (event, { cancel = false } = {}) => {
    const drag = mprAnnotationGeometryDragRef.current;
    if (!drag || (
      drag.pointerId !== undefined
      && event.pointerId !== undefined
      && drag.pointerId !== event.pointerId
    )) return;
    event.preventDefault();
    event.stopPropagation();
    safeReleasePointerCapture(drag.captureTarget, drag.pointerId);
    const preview = mprGeometryDragPreviewRef.current;
    mprAnnotationGeometryDragRef.current = null;
    setMprAnnotationGeometryDragPreview(null);
    if (cancel || !preview?.geometry) return;
    const comparisonFields = preview.kind === 'line'
      ? ['x1', 'y1', 'x2', 'y2']
      : ['x', 'y', 'width', 'height'];
    const changed = comparisonFields.some((field) => (
      Number(preview.geometry[field]) !== Number(drag.source[field])
    ));
    if (!changed) return;
    if (preview.kind === 'line') await updateMeasurementAnnotationLine(preview.geometry.id, preview.geometry);
    if (preview.kind === 'box') await updateBoxAnnotationGeometry(preview.geometry.id, preview.geometry);
  };

  const stopMprAnnotationGeometryClick = (event) => {
    if (annotationToolMode) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const getFullscreenImagePointerPosition = (event, { clampToImage = false } = {}) => {
    const surface = fullscreenImageRef.current;
    if (!surface) return null;
    const rect = surface.getBoundingClientRect();
    const isCanvasSurface = surface.tagName === 'CANVAS';
    const naturalWidth = Number(isCanvasSurface ? surface.width : surface.naturalWidth);
    const naturalHeight = Number(isCanvasSurface ? surface.height : surface.naturalHeight);
    const isMprSurface = fullscreenImageModal?.sourceKind === 'mpr';
    const displayAxes = isMprSurface
      ? (MPR_DISPLAY_AXES_BY_VIEW[fullscreenImageModal.axis] || MPR_DISPLAY_AXES_BY_VIEW.axial)
      : null;
    const transform = getContainedImageTransform({
      elementRect: rect,
      sourceWidth: naturalWidth,
      sourceHeight: naturalHeight,
      mirrorX: Boolean(displayAxes && mprProjectionMirror[displayAxes.x] === true),
      mirrorY: Boolean(displayAxes && mprProjectionMirror[displayAxes.y] === true),
    });
    const point = clientPointToSource(transform, event, {
      rejectOutside: !clampToImage,
      clamp: clampToImage,
    });
    if (!point) return null;
    const rawDisplayX = event.clientX - rect.left;
    const rawDisplayY = event.clientY - rect.top;
    return {
      x: point.x,
      y: point.y,
      displayX: rawDisplayX,
      displayY: rawDisplayY,
      rawDisplayX,
      rawDisplayY,
      rect,
      naturalWidth,
      naturalHeight,
      contentRect: transform.contentRect,
    };
  };

  const getFullscreenGeometryPointerPosition = (event, geometry, options = {}) => {
    const position = getFullscreenImagePointerPosition(event, options);
    const geometryWidth = Number(geometry?.imageWidth);
    const geometryHeight = Number(geometry?.imageHeight);
    const surfaceWidth = Number(position?.naturalWidth);
    const surfaceHeight = Number(position?.naturalHeight);
    if (
      !position
      || !Number.isFinite(geometryWidth)
      || !Number.isFinite(geometryHeight)
      || geometryWidth <= 0
      || geometryHeight <= 0
      || !Number.isFinite(surfaceWidth)
      || !Number.isFinite(surfaceHeight)
      || surfaceWidth <= 0
      || surfaceHeight <= 0
    ) return null;
    return {
      ...position,
      x: position.x * (geometryWidth / surfaceWidth),
      y: position.y * (geometryHeight / surfaceHeight),
    };
  };

  const makeBoxFromMovedCorner = (box, corner, point, naturalWidth, naturalHeight) => {
    if (!isFiniteAnnotationBox(box) || !corner || !point) return null;
    const oppositeCorner = getAnnotationBoxOppositeCornerName(corner);
    const oppositePoint = getAnnotationBoxCornerPoints(box)[oppositeCorner];
    if (!oppositePoint) return null;
    return makeBoxFromPoints(
      { x: point.x, y: point.y, imageWidth: naturalWidth || box.imageWidth, imageHeight: naturalHeight || box.imageHeight },
      { x: oppositePoint.x, y: oppositePoint.y, imageWidth: naturalWidth || box.imageWidth, imageHeight: naturalHeight || box.imageHeight },
    );
  };


	  const updateFullscreenImageZoomFromWheel = (event) => {
	    if (fullscreenMeasureActive || fullscreenBoxActive || fullscreenCropActive || fullscreenEditingEndpoint || fullscreenEditingBoxCorner) return;
	    const position = getFullscreenImagePointerPosition(event);
	    if (!position) return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    const nextScale = Math.min(
      FULLSCREEN_IMAGE_ZOOM_MAX,
      Math.max(FULLSCREEN_IMAGE_ZOOM_MIN, fullscreenImageZoom.scale * (direction > 0 ? 1.15 : 1 / 1.15)),
    );
	    setFullscreenImageZoom({
	      scale: nextScale,
	      originX: (position.displayX / position.rect.width) * 100,
	      originY: (position.displayY / position.rect.height) * 100,
	      panX: fullscreenImageZoom.panX || 0,
	      panY: fullscreenImageZoom.panY || 0,
	    });
	  };

  const toggleFullscreenMeasure = () => {
    if (fullscreenMeasureActive) {
      setFullscreenMeasureActive(false);
      setPendingMeasurePoint(null);
      pendingMeasurePointRef.current = null;
	      setFullscreenEditingEndpoint(null);
      setFullscreenEditingBoxCorner(null);
		      setFullscreenAnnotationPreview(null);
	      return;
	    }
	    if (!getCalibrationForImage(getAnnotationSourceImageIdForImage(fullscreenBackingImageId))) {
      setFullscreenCalibrationPromptVisible(true);
      return;
    }
	    setFullscreenCalibrationPromptVisible(false);
	    setFullscreenBoxActive(false);
    setFullscreenCropActive(false);
	    setPendingBoxPoint(null);
	    pendingBoxPointRef.current = null;
    setFullscreenEditingBoxCorner(null);
	    setFullscreenAnnotationPreview(null);
	    setFullscreenMeasureActive(true);
	  };

	  const toggleFullscreenBox = () => {
	    if (fullscreenBoxActive || fullscreenCropActive) {
	      setFullscreenBoxActive(false);
	      setPendingBoxPoint(null);
	      pendingBoxPointRef.current = null;
      setFullscreenEditingBoxCorner(null);
	      setFullscreenAnnotationPreview(null);
	      return;
	    }
	    setFullscreenMeasureActive(false);
    setFullscreenCropActive(false);
	    setPendingMeasurePoint(null);
	    pendingMeasurePointRef.current = null;
	    if (!requireCalibrationForAnnotation(fullscreenBackingImageId, { surface: 'fullscreen', toolMode: 'box' })) return;
	    setFullscreenCalibrationPromptVisible(false);
	    setFullscreenEditingEndpoint(null);
    setFullscreenEditingBoxCorner(null);
	    setFullscreenAnnotationPreview(null);
	    setFullscreenBoxActive(true);
	  };

  const toggleFullscreenCrop = () => {
    if (fullscreenCropActive) {
      setFullscreenCropActive(false);
      setPendingBoxPoint(null);
      pendingBoxPointRef.current = null;
      setFullscreenEditingBoxCorner(null);
      setFullscreenAnnotationPreview(null);
      return;
    }
    setFullscreenMeasureActive(false);
    setFullscreenBoxActive(false);
    setPendingMeasurePoint(null);
    pendingMeasurePointRef.current = null;
    setPendingBoxPoint(null);
    pendingBoxPointRef.current = null;
    setFullscreenCalibrationPromptVisible(false);
    setFullscreenEditingEndpoint(null);
    setFullscreenEditingBoxCorner(null);
    setFullscreenAnnotationPreview(null);
    setFullscreenCropActive(true);
  };

	  const commitFullscreenBox = async (box) => {
	    if (isFiniteAnnotationBox(box)) {
	      if (!requireCalibrationForAnnotation(fullscreenBackingImageId, { surface: 'fullscreen', toolMode: 'box' })) {
	        setPendingBoxPoint(null);
	        pendingBoxPointRef.current = null;
	        setFullscreenAnnotationPreview(null);
	        return;
	      }
	      const annotationSourceImageId = getAnnotationSourceImageIdForImage(fullscreenBackingImageId);
	      const existingBoxCount = fullscreenMprSliceKey
	        ? (storedMprBoxAnnotationsBySlice[fullscreenMprSliceKey] || []).length
	        : (storedBoxAnnotationsByImageId[String(annotationSourceImageId || '')] || []).length;
	      const mprGeometryPatch = fullscreenMprSliceKey
	        ? {
	          axis: fullscreenImageModal.axis,
	          slice_index: fullscreenImageModal.sliceIndex,
	          box: { axis: fullscreenImageModal.axis, slice_index: fullscreenImageModal.sliceIndex },
	        }
	        : {};
	      const created = await createBoxAnnotation({
	        imageId: fullscreenBackingImageId,
	        box,
	        name: 'Drawn bounding box',
	        color: MEASUREMENT_COLORS[existingBoxCount % MEASUREMENT_COLORS.length],
	        modality: fullscreenMprSliceKey ? 'volume' : undefined,
	        geometryPatch: mprGeometryPatch,
	      });
	      if (created?.id) setFullscreenBoundsEditAnnotationId(created.id);
	    }
	    setPendingBoxPoint(null);
	    pendingBoxPointRef.current = null;
	    setFullscreenAnnotationPreview(null);
	  };

  const commitFullscreenMeasureLine = async (line) => {
    if (!line) return;
    if (!getCalibrationForImage(getAnnotationSourceImageIdForImage(fullscreenBackingImageId))) {
      setPendingMeasurePoint(null);
      pendingMeasurePointRef.current = null;
      setFullscreenMeasureActive(false);
      setFullscreenCalibrationPromptVisible(true);
      return;
    }
    const kind = classifyMeasurementLine(line);
    const name = nextMeasurementName(kind);
    const annotationSourceImageId = getAnnotationSourceImageIdForImage(fullscreenBackingImageId);
    const annotationLookupKey = fullscreenMprSliceKey || String(annotationSourceImageId || '');
    const existingLineCount = ((fullscreenMprSliceKey
      ? storedMprMeasurementLinesBySlice[fullscreenMprSliceKey]
      : storedMeasurementLinesByImageId[String(annotationSourceImageId || '')]) || []).length
      + fullscreenMeasurements.filter((item) => String(item.imageId || '') === annotationLookupKey).length;
    const color = MEASUREMENT_COLORS[existingLineCount % MEASUREMENT_COLORS.length];
    const distancePx = Math.hypot(line.x2 - line.x1, line.y2 - line.y1);
    const distanceMm = getLineDistanceMm(line, annotationSourceImageId);
    const mprLine = fullscreenMprSliceKey
      ? { ...line, axis: fullscreenImageModal.axis, slice_index: fullscreenImageModal.sliceIndex }
      : line;
    const created = await createMeasurementAnnotation({
      imageId: fullscreenBackingImageId,
      line: mprLine,
      name,
      color,
      distanceMm,
      modality: fullscreenMprSliceKey ? 'volume' : undefined,
      geometryPatch: fullscreenMprSliceKey
        ? { axis: fullscreenImageModal.axis, slice_index: fullscreenImageModal.sliceIndex }
        : {},
    });
    if (created && (!created.image_id || !created.geometry?.line)) {
      setFullscreenMeasurements((prev) => [...prev, { ...mprLine, id: created.id, imageId: annotationLookupKey, name, kind, color, distanceMm, distancePx }]);
    }
	    if (created?.id) setFullscreenBoundsEditAnnotationId(created.id);
	    setPendingMeasurePoint(null);
	    pendingMeasurePointRef.current = null;
	    setFullscreenAnnotationPreview(null);
	  };

  const handleFullscreenMeasurePointerDown = async (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const position = getFullscreenImagePointerPosition(event);
    if (!position) return;
    if (fullscreenEditingEndpoint?.lineId) {
      const sourceLine = fullscreenEditingEndpoint.line;
      const adjustedPosition = position;
      const coordinatePatch = fullscreenEditingEndpoint.endpoint === 'start'
        ? { x1: adjustedPosition.x, y1: adjustedPosition.y }
        : { x2: adjustedPosition.x, y2: adjustedPosition.y };
      const nextLine = {
        ...sourceLine,
        ...coordinatePatch,
        imageWidth: position.naturalWidth,
        imageHeight: position.naturalHeight,
      };
      await updateMeasurementAnnotationLine(fullscreenEditingEndpoint.lineId, nextLine);
      setFullscreenEditingEndpoint(null);
      return;
    }
    if (fullscreenEditingBoxCorner?.boxId) {
      const adjustedPosition = position;
      const nextBox = makeBoxFromMovedCorner(
        fullscreenEditingBoxCorner.box,
        fullscreenEditingBoxCorner.corner,
        adjustedPosition,
        position.naturalWidth,
        position.naturalHeight,
      );
      if (nextBox && isFiniteAnnotationBox(nextBox)) {
        await updateBoxAnnotationGeometry(fullscreenEditingBoxCorner.boxId, {
          ...nextBox,
          id: fullscreenEditingBoxCorner.boxId,
          color: fullscreenEditingBoxCorner.box.color,
          axis: fullscreenEditingBoxCorner.box.axis,
          sliceIndex: fullscreenEditingBoxCorner.box.sliceIndex,
        });
      }
      setFullscreenEditingBoxCorner(null);
      return;
    }
	    if (fullscreenBoxActive || fullscreenCropActive) return;
	    if (!fullscreenMeasureActive) return;
    if (!getCalibrationForImage(getAnnotationSourceImageIdForImage(fullscreenBackingImageId))) {
      setFullscreenMeasureActive(false);
      setFullscreenCalibrationPromptVisible(true);
      setPendingMeasurePoint(null);
      pendingMeasurePointRef.current = null;
      return;
    }
    const { x, y, naturalWidth, naturalHeight } = position;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    event.preventDefault();
    event.stopPropagation();
    const nextPoint = { x, y, imageWidth: naturalWidth, imageHeight: naturalHeight };
    pendingMeasurePointRef.current = nextPoint;
    setPendingMeasurePoint(nextPoint);
    setFullscreenAnnotationPreview(null);
  };

  const handleFullscreenMeasurePointerUp = async (event) => {
    if (!fullscreenMeasureActive) return;
    const firstPoint = pendingMeasurePointRef.current || pendingMeasurePoint;
    if (!firstPoint) return;
    const position = getFullscreenImagePointerPosition(event);
    event.preventDefault();
    event.stopPropagation();
    if (!position) {
      setPendingMeasurePoint(null);
      pendingMeasurePointRef.current = null;
      setFullscreenAnnotationPreview(null);
      return;
    }
    const line = {
      x1: firstPoint.x,
      y1: firstPoint.y,
      x2: position.x,
      y2: position.y,
      imageWidth: position.naturalWidth,
      imageHeight: position.naturalHeight,
    };
    if (!isFiniteMeasurementLine(line) || Math.hypot(line.x2 - line.x1, line.y2 - line.y1) < 2) {
      setPendingMeasurePoint(null);
      pendingMeasurePointRef.current = null;
      setFullscreenAnnotationPreview(null);
      return;
    }
    await commitFullscreenMeasureLine(line);
  };

	  const handleFullscreenBoxPointerDown = (event) => {
	    if (!fullscreenBoxActive && !fullscreenCropActive) return;
	    if (event.button !== undefined && event.button !== 0) return;
	    const position = getFullscreenImagePointerPosition(event);
	    if (!position) return;
	    event.preventDefault();
	    event.stopPropagation();
	    const nextPoint = {
	      x: position.x,
	      y: position.y,
	      imageWidth: position.naturalWidth,
	      imageHeight: position.naturalHeight,
	    };
	    pendingBoxPointRef.current = nextPoint;
	    setPendingBoxPoint(nextPoint);
	    setFullscreenAnnotationPreview(null);
	    safeSetPointerCapture(event.currentTarget, event.pointerId);
	  };

	  const handleFullscreenBoxPointerUp = async (event) => {
	    if (!fullscreenBoxActive && !fullscreenCropActive) return;
	    const position = getFullscreenImagePointerPosition(event);
	    event.preventDefault();
	    event.stopPropagation();
	    const firstPoint = pendingBoxPointRef.current || pendingBoxPoint;
	    if (firstPoint && position) {
	      const box = makeBoxFromPoints(firstPoint, {
	        x: position.x,
	        y: position.y,
	        imageWidth: position.naturalWidth,
	        imageHeight: position.naturalHeight,
	      });
	      if (fullscreenCropActive) {
	        await createCropChildImage({ parentImageId: getAnnotationSourceImageIdForImage(fullscreenBackingImageId), cropBox: box });
	      } else {
	        await commitFullscreenBox(box);
	      }
	    } else {
	      setPendingBoxPoint(null);
	      pendingBoxPointRef.current = null;
	      setFullscreenAnnotationPreview(null);
	      setFullscreenBoxActive(false);
	    }
        setFullscreenBoxActive(false);
        setFullscreenCropActive(false);
	    safeReleasePointerCapture(event.currentTarget, event.pointerId);
	  };

	  const handleFullscreenBoxPointerCancel = (event) => {
	    if (!fullscreenBoxActive && !fullscreenCropActive && !pendingBoxPointRef.current) return;
	    event.preventDefault();
	    event.stopPropagation();
	    setPendingBoxPoint(null);
	    pendingBoxPointRef.current = null;
	    setFullscreenAnnotationPreview(null);
	    setFullscreenBoxActive(false);
	    safeReleasePointerCapture(event.currentTarget, event.pointerId);
	  };

	  const handleFullscreenImageWheel = (event) => {
	    updateFullscreenImageZoomFromWheel(event);
	  };

	  const canPanFullscreenImage = () => (
	    !fullscreenMeasureActive
	    && !fullscreenBoxActive
	    && !fullscreenEditingEndpoint?.lineId
	    && !fullscreenEditingBoxCorner?.boxId
	    && !fullscreenAnnotationDragRef.current
	    && !fullscreenCalibrationPromptVisible
	  );

	  const handleFullscreenPanMouseDown = (event) => {
	    if (!canPanFullscreenImage()) return;
	    if (event.button !== undefined && event.button !== 0) return;
	    if (event.target?.classList?.contains('inspection-measurement-endpoint-dot')) return;
	    if (event.target?.classList?.contains('inspection-box-corner-dot')) return;
	    if (event.target?.classList?.contains('inspection-annotation-drag-target')) return;
	    event.preventDefault();
	    fullscreenPanDragRef.current = {
	      startClientX: event.clientX,
	      startClientY: event.clientY,
	      startPanX: Number(fullscreenImageZoom.panX || 0),
	      startPanY: Number(fullscreenImageZoom.panY || 0),
	    };
	    setFullscreenImagePanning(true);
	  };

	  const handleFullscreenPanMouseUp = () => {
	    fullscreenPanDragRef.current = null;
	    setFullscreenImagePanning(false);
	  };

	  const handleFullscreenImagePointerMove = (event, lines, boxes = []) => {
	    const panDrag = fullscreenPanDragRef.current;
	    if (panDrag) {
	      event.preventDefault();
	      const nextPanX = panDrag.startPanX + (event.clientX - panDrag.startClientX);
	      const nextPanY = panDrag.startPanY + (event.clientY - panDrag.startClientY);
	      setFullscreenImageZoom((prev) => ({
	        ...prev,
	        panX: nextPanX,
	        panY: nextPanY,
	      }));
	      return;
	    }
	    const position = getFullscreenImagePointerPosition(event);
	    if (fullscreenEditingEndpoint?.lineId || fullscreenEditingBoxCorner?.boxId) {
	      return;
	    }
	    if (fullscreenBoxActive || fullscreenCropActive) {
	      const firstPoint = pendingBoxPointRef.current || pendingBoxPoint;
	      if (firstPoint && position) {
	        const box = {
	          ...makeBoxFromPoints(firstPoint, {
	            x: position.x,
	            y: position.y,
	            imageWidth: position.naturalWidth,
	            imageHeight: position.naturalHeight,
	          }),
	          id: 'fullscreen-box-preview',
	          color: '#f97316',
	        };
	        setFullscreenAnnotationPreview({ mode: fullscreenCropActive ? 'crop' : 'box', box });
	      }
		      return;
	    }
	    const firstMeasurePoint = pendingMeasurePointRef.current || pendingMeasurePoint;
	    if (fullscreenMeasureActive && firstMeasurePoint && position) {
	      const line = {
	        id: 'fullscreen-measure-preview',
	        x1: firstMeasurePoint.x,
	        y1: firstMeasurePoint.y,
	        x2: position.x,
	        y2: position.y,
	        imageWidth: position.naturalWidth,
	        imageHeight: position.naturalHeight,
	        color: '#f97316',
	        distancePx: Math.hypot(position.x - firstMeasurePoint.x, position.y - firstMeasurePoint.y),
	        distanceMm: getLineDistanceMm(
	          { x1: firstMeasurePoint.x, y1: firstMeasurePoint.y, x2: position.x, y2: position.y },
	          fullscreenBackingImageId,
	        ),
	      };
	      setFullscreenAnnotationPreview({ mode: 'measure', line });
		      return;
	    }
  };

  const setFullscreenDragPreview = (preview) => {
    fullscreenGeometryDragPreviewRef.current = preview;
    setFullscreenGeometryDragPreview(preview);
  };

  const startFullscreenAnnotationDrag = (event, kind, operation, geometry) => {
    if (!geometry?.id || (event.button !== undefined && event.button !== 0)) return;
    const position = getFullscreenGeometryPointerPosition(event, geometry);
    if (!position) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedAnnotationId(geometry.id);
    setFullscreenBoundsEditAnnotationId(geometry.id);
    setFullscreenMeasureActive(false);
    setFullscreenBoxActive(false);
    setFullscreenCropActive(false);
    fullscreenPanDragRef.current = null;
    setFullscreenImagePanning(false);
    const source = { ...geometry };
    fullscreenAnnotationDragRef.current = {
      pointerId: event.pointerId,
      captureTarget: event.currentTarget,
      kind,
      operation,
      source,
      startPoint: { x: position.x, y: position.y },
    };
    setFullscreenDragPreview({ kind, geometry: source });
    safeSetPointerCapture(event.currentTarget, event.pointerId);
  };

  const handleFullscreenAnnotationDragMove = (event) => {
    const drag = fullscreenAnnotationDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const position = getFullscreenGeometryPointerPosition(
      event,
      drag.source,
      { clampToImage: true },
    );
    if (!position) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = { width: drag.source.imageWidth, height: drag.source.imageHeight };
    const delta = {
      x: position.x - drag.startPoint.x,
      y: position.y - drag.startPoint.y,
    };
    let geometry = null;
    if (drag.kind === 'line') {
      geometry = drag.operation === 'translate'
        ? translateLine(drag.source, delta, bounds)
        : moveLineEndpoint(drag.source, drag.operation, position, bounds);
    } else if (drag.kind === 'box') {
      geometry = drag.operation === 'translate'
        ? translateBox(drag.source, delta, bounds)
        : moveBoxCorner(drag.source, drag.operation, position, bounds);
    }
    if (geometry) setFullscreenDragPreview({ kind: drag.kind, geometry });
  };

  const finishFullscreenAnnotationDrag = async (event, { cancel = false } = {}) => {
    const drag = fullscreenAnnotationDragRef.current;
    if (!drag || (event.pointerId !== undefined && drag.pointerId !== event.pointerId)) return;
    event.preventDefault();
    event.stopPropagation();
    safeReleasePointerCapture(drag.captureTarget, drag.pointerId);
    const preview = fullscreenGeometryDragPreviewRef.current;
    fullscreenAnnotationDragRef.current = null;
    setFullscreenDragPreview(null);
    if (cancel || !preview?.geometry) return;
    if (preview.kind === 'line') await updateMeasurementAnnotationLine(preview.geometry.id, preview.geometry);
    if (preview.kind === 'box') await updateBoxAnnotationGeometry(preview.geometry.id, preview.geometry);
  };

	  const startFullscreenEndpointEdit = (event, line, endpoint) => {
	    event.preventDefault();
	    event.stopPropagation();
    if (String(fullscreenBoundsEditAnnotationId || '') !== String(line?.id || '')) return;
    const anchor = endpoint === 'start'
      ? { x: Number(line.x1), y: Number(line.y1) }
      : { x: Number(line.x2), y: Number(line.y2) };
	    setFullscreenMeasureActive(false);
	    setFullscreenBoxActive(false);
	    setPendingMeasurePoint(null);
	    pendingMeasurePointRef.current = null;
	    setPendingBoxPoint(null);
	    pendingBoxPointRef.current = null;
    setFullscreenEditingBoxCorner(null);
    setFullscreenEditingEndpoint({ lineId: String(line.id), endpoint, line, anchor });
  };

  const handleFullscreenEndpointDotClick = (event, line, endpoint) => {
    event.preventDefault();
    event.stopPropagation();
    if (fullscreenEditingEndpoint?.lineId) {
      handleFullscreenMeasurePointerDown(event);
      return;
    }
    startFullscreenEndpointEdit(event, line, endpoint);
  };

  const startFullscreenBoxCornerEdit = (event, box, corner) => {
    event.preventDefault();
    event.stopPropagation();
    if (String(fullscreenBoundsEditAnnotationId || '') !== String(box?.id || '')) return;
    const anchor = getAnnotationBoxCornerPoints(box)[corner];
    setFullscreenMeasureActive(false);
    setFullscreenBoxActive(false);
    setPendingMeasurePoint(null);
    pendingMeasurePointRef.current = null;
    setPendingBoxPoint(null);
    pendingBoxPointRef.current = null;
    setFullscreenEditingEndpoint(null);
    setFullscreenEditingBoxCorner({ boxId: String(box.id), corner, box, anchor });
  };

  const handleFullscreenBoxCornerDotClick = (event, box, corner) => {
    event.preventDefault();
    event.stopPropagation();
    if (fullscreenEditingBoxCorner?.boxId) {
      handleFullscreenMeasurePointerDown(event);
      return;
    }
    startFullscreenBoxCornerEdit(event, box, corner);
  };

  const closeFullscreenImageModal = () => {
	    const activeAnnotationDrag = fullscreenAnnotationDragRef.current;
	    if (activeAnnotationDrag) safeReleasePointerCapture(activeAnnotationDrag.captureTarget, activeAnnotationDrag.pointerId);
	    fullscreenAnnotationDragRef.current = null;
	    fullscreenGeometryDragPreviewRef.current = null;
	    setFullscreenGeometryDragPreview(null);
	    setFullscreenImageModal(null);
      setFullscreenBoundsEditAnnotationId(null);
	    fullscreenPanDragRef.current = null;
	    setFullscreenImagePanning(false);
	    setFullscreenMeasureActive(false);
	    setFullscreenBoxActive(false);
        setFullscreenCropActive(false);
	    setPendingMeasurePoint(null);
	    pendingMeasurePointRef.current = null;
	    setPendingBoxPoint(null);
	    pendingBoxPointRef.current = null;
    setFullscreenCalibrationPromptVisible(false);
	    setFullscreenEditingEndpoint(null);
    setFullscreenEditingBoxCorner(null);
	    setFullscreenImageZoom({ scale: 1, originX: 50, originY: 50, panX: 0, panY: 0 });
	    setFullscreenAnnotationPreview(null);
	  };

  const renderFullscreenImageModal = () => {
    if (!fullscreenBackingImageId) return null;
    const isMprFullscreen = fullscreenImageModal?.sourceKind === 'mpr';
    const fullscreenImageId = fullscreenBackingImageId;
    const fullscreenAnnotationSourceImageId = getAnnotationSourceImageIdForImage(fullscreenImageId);
    const fullscreenAnnotationLookupKey = isMprFullscreen
      ? fullscreenMprSliceKey
      : fullscreenAnnotationSourceImageId;
    const fullscreenBaseImageId = String(fullscreenImageModal.baseImageId || (
      fullscreenAnnotationSourceImageId && fullscreenAnnotationSourceImageId !== fullscreenImageId
        ? fullscreenAnnotationSourceImageId
        : ''
    ));
    const fullscreenImageRecord = projectImageLookup[fullscreenImageId] || {};
	    const fullscreenExternalOverlayItem = inspectionAnnotationItems.find((item) => (
	      item.kind === 'external_overlay'
	      && [
	        item.source?.resourceId,
	        item.overlay?.imageId,
	        item.overlay?.imageRef,
	        item.overlay?.filename,
	      ].some((identity) => String(identity || '') === fullscreenImageId)
	    ));
	    const fullscreenExternalOverlayVisible = !fullscreenExternalOverlayItem
	      || (annotationsVisible && fullscreenExternalOverlayItem.visible !== false);
	    const fullscreenMeasurementLines = [
	      ...(isMprFullscreen
	        ? (mprMeasurementLinesBySlice[fullscreenAnnotationLookupKey] || [])
	        : (measurementLinesByImageId[fullscreenAnnotationSourceImageId] || [])),
	      ...fullscreenMeasurements.filter((line) => String(line.imageId || '') === String(fullscreenAnnotationLookupKey || '')),
	    ].filter(isFiniteMeasurementLine);
	    const fullscreenBoxAnnotations = (isMprFullscreen
	      ? (mprBoxAnnotationsBySlice[fullscreenAnnotationLookupKey] || [])
	      : (boxAnnotationsByImageId[fullscreenAnnotationSourceImageId] || []))
	      .filter(isFiniteAnnotationBox)
	      .map((box) => getBoxWithDerivedDimensions(box, fullscreenAnnotationSourceImageId));
	    const renderedFullscreenMeasurementLines = fullscreenMeasurementLines.map((line) => (
	      fullscreenGeometryDragPreview?.kind === 'line'
	      && String(fullscreenGeometryDragPreview.geometry?.id) === String(line.id)
	        ? fullscreenGeometryDragPreview.geometry
	        : line
	    ));
	    const renderedFullscreenBoxAnnotations = fullscreenBoxAnnotations.map((box) => (
	      fullscreenGeometryDragPreview?.kind === 'box'
	      && String(fullscreenGeometryDragPreview.geometry?.id) === String(box.id)
	        ? fullscreenGeometryDragPreview.geometry
	        : box
	    ));
	    const fullscreenPreviewLines = fullscreenAnnotationPreview?.mode === 'measure'
	      ? [fullscreenAnnotationPreview.line].filter(isFiniteMeasurementLine)
	      : [];
	    const fullscreenPreviewBoxes = ['box', 'crop'].includes(fullscreenAnnotationPreview?.mode)
	      ? [fullscreenAnnotationPreview.box].filter(isFiniteAnnotationBox).map((box) => getBoxWithDerivedDimensions(box, fullscreenAnnotationSourceImageId))
	      : [];
	    const fullscreenInspectionItemById = new Map(
	      inspectionAnnotationItems.map((item) => [String(item.id), item]),
	    );
	    const fullscreenGeometryItems = [
	      ...renderedFullscreenMeasurementLines.map((line, index) => ({
	        ...line,
	        annotationType: 'measurement',
	        title: line.name || `Measurement ${index + 1}`,
	        summary: getMeasurementLineLabel(line),
	        inspectionItem: fullscreenInspectionItemById.get(String(line.id)),
	      })),
	      ...renderedFullscreenBoxAnnotations.map((box, index) => ({
	        ...box,
	        annotationType: 'box',
	        title: box.name || `Box ${index + 1}`,
	        summary: `${getAnnotationBoxWidthLabel(box)} • ${getAnnotationBoxHeightLabel(box)}`,
	        inspectionItem: fullscreenInspectionItemById.get(String(box.id)),
	      })),
	    ];
	    const fullscreenGeometryIds = new Set(fullscreenGeometryItems.map((item) => String(item.id)));
	    const fullscreenUnifiedItems = inspectionAnnotationItems
	      .filter((item) => !fullscreenGeometryIds.has(String(item.id)))
	      .map((item) => {
	        const segment = item.annotation?.geometry?.segment;
	        return {
	          id: item.id,
	          annotationType: item.kind,
	          title: item.kind === 'external_overlay' ? `External: ${item.label}` : item.label,
	          summary: item.kind === 'vista_segment'
	            ? `${segment?.axis || 'axial'} slices ${segment?.min_slice ?? 0}-${segment?.max_slice ?? 0}`
	            : item.kind === 'external_overlay'
	              ? 'Assigned external image or volume'
	              : getAnnotationListType(item.annotation),
	          color: item.color,
	          inspectionItem: item,
	        };
	      });
	    const fullscreenAnnotationItems = [...fullscreenGeometryItems, ...fullscreenUnifiedItems];
	    const fullscreenShowsExternalOverlay = Boolean(fullscreenBaseImageId && fullscreenExternalOverlayVisible);
	    const fullscreenSurfaceClassName = `inspection-fullscreen-image ${fullscreenShowsExternalOverlay ? 'analysis-overlay-image' : ''} ${fullscreenMeasureActive || fullscreenBoxActive || fullscreenCropActive || fullscreenEditingEndpoint || fullscreenEditingBoxCorner ? 'measurement-active' : ''}`;
	    const fullscreenSurfaceProps = {
	      ref: fullscreenImageRef,
	      className: fullscreenSurfaceClassName,
	      style: !isMprFullscreen && fullscreenShowsExternalOverlay
	        ? { opacity: annotationOpacityMultiplier }
	        : undefined,
	      'aria-label': `${fullscreenImageModal.label} fullscreen`,
	      onMouseDown: (event) => {
	        handleFullscreenMeasurePointerDown(event);
	        handleFullscreenBoxPointerDown(event);
	      },
	      onMouseUp: (event) => {
	        handleFullscreenMeasurePointerUp(event);
	        handleFullscreenBoxPointerUp(event);
	      },
	      onMouseLeave: (event) => {
	        handleFullscreenBoxPointerCancel(event);
	        if (fullscreenMeasureActive && pendingMeasurePointRef.current) {
	          setPendingMeasurePoint(null);
	          pendingMeasurePointRef.current = null;
	          setFullscreenAnnotationPreview(null);
	        }
	      },
	      onClick: (event) => {
	        if (fullscreenEditingEndpoint?.lineId || fullscreenEditingBoxCorner?.boxId) {
	          handleFullscreenMeasurePointerDown(event);
	        } else if (fullscreenMeasureActive) {
	          if (pendingMeasurePointRef.current || pendingMeasurePoint) {
	            handleFullscreenMeasurePointerUp(event);
	          } else {
	            handleFullscreenMeasurePointerDown(event);
	          }
	        }
	      },
	    };
	    const fullscreenMprSlicePosition = isMprFullscreen
	      ? { ...slicePosition, [fullscreenImageModal.axis]: fullscreenImageModal.sliceIndex }
	      : null;
	    const fullscreenMprProjectionStyle = isMprFullscreen
	      ? getMprCrosshairStyle(
	        fullscreenImageModal.axis,
	        fullscreenMprSlicePosition,
	        mprDimensions,
	        mprProjectionMirror,
	      )
	      : undefined;
	    const fullscreenMprImageDimensions = isMprFullscreen
	      ? getMprAxisImageDimensions(fullscreenImageModal.axis, mprDimensions, volumeCacheState.cache)
	      : null;
	    const fullscreenOverlayGeometry = [
	      ...renderedFullscreenMeasurementLines,
	      ...renderedFullscreenBoxAnnotations,
	      ...fullscreenPreviewLines,
	      ...fullscreenPreviewBoxes,
	    ][0];
	    const fullscreenOverlayWidth = fullscreenMprImageDimensions?.width
	      || Math.max(1, Number(fullscreenOverlayGeometry?.imageWidth) || 1000);
	    const fullscreenOverlayHeight = fullscreenMprImageDimensions?.height
	      || Math.max(1, Number(fullscreenOverlayGeometry?.imageHeight) || 1000);
	    const fullscreenOverlayViewBox = `0 0 ${fullscreenOverlayWidth} ${fullscreenOverlayHeight}`;
	    const fullscreenOverlayContentTransform = `scale(${fullscreenOverlayWidth / 1000} ${fullscreenOverlayHeight / 1000})`;
	    const fullscreenCanonicalSliceIndex = isMprFullscreen
	      ? getSegmentationCanonicalSliceIndex(
	        fullscreenImageModal.axis,
	        Number(fullscreenImageModal.sliceIndex),
	      )
	      : 0;
	    const fullscreenSegmentAnnotations = isMprFullscreen && annotationLayerVisible
	      ? vectorSegmentAnnotations.filter((segment) => (
	        segmentVisibleOnSlice(
	          segment,
	          fullscreenImageModal.axis,
	          fullscreenCanonicalSliceIndex,
	        )
	      ))
	      : [];
	    return (
      <div className="modal inspection-fullscreen-modal" style={{ display: 'flex' }} onClick={closeFullscreenImageModal}>
        <div className="modal-content inspection-fullscreen-modal-content" onClick={(event) => event.stopPropagation()}>
          <div className="modal-header">
            <h3>{fullscreenImageModal.label}</h3>
            <div className="workbench-detail-actions">
	              <label className="annotation-display-toggle">
	                <input
	                  type="checkbox"
	                  checked={annotationsVisible}
	                  onChange={(event) => setAnnotationsVisible(event.target.checked)}
	                />
	                Show annotations
	              </label>
	              <button type="button" className={`btn btn-secondary ${fullscreenMeasureActive ? 'active' : ''}`} onClick={toggleFullscreenMeasure}>
	                {fullscreenMeasureActive ? 'Done Measuring' : 'Measure'}
	              </button>
                  <button type="button" className="btn btn-secondary" onClick={() => setFullscreenImageZoom({ scale: 1, originX: 50, originY: 50, panX: 0, panY: 0 })}>
                    Reset zoom
                  </button>
	              <button type="button" className={`btn btn-secondary ${fullscreenBoxActive ? 'active' : ''}`} onClick={toggleFullscreenBox}>
	                Draw box
	              </button>
                  {!isMprFullscreen && (
                    <button type="button" className={`btn btn-secondary ${fullscreenCropActive ? 'active' : ''}`} onClick={toggleFullscreenCrop}>
                      New Crop
                    </button>
                  )}
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
            {(fullscreenMeasureActive || fullscreenBoxActive || fullscreenCropActive || fullscreenEditingEndpoint || fullscreenEditingBoxCorner) && (
              <div className="inspection-fullscreen-tool-notice" aria-live="polite">
                {fullscreenMeasureActive && <div className="workbench-notice">Click and drag to draw a measurement line.</div>}
                {fullscreenBoxActive && <div className="workbench-notice">Press and drag to draw a bounding box.</div>}
                {fullscreenCropActive && <div className="workbench-notice">Press and drag around the parent image feature to create a child crop.</div>}
                {(fullscreenEditingEndpoint || fullscreenEditingBoxCorner) && <div className="workbench-notice">Click the new endpoint or corner position to update the selected annotation.</div>}
              </div>
            )}
            <div className="inspection-fullscreen-workspace">
              <div
	                className={`inspection-fullscreen-image-frame ${fullscreenImageZoom.scale > 1 ? 'zoomed' : ''} ${fullscreenImagePanning ? 'panning' : ''}`}
	                onMouseDown={handleFullscreenPanMouseDown}
	                onMouseMove={(event) => handleFullscreenImagePointerMove(event, renderedFullscreenMeasurementLines, renderedFullscreenBoxAnnotations)}
	                onMouseUp={handleFullscreenPanMouseUp}
	                onMouseLeave={() => {
	                  handleFullscreenPanMouseUp();
	                }}
                onWheel={handleFullscreenImageWheel}
              >
                <div
                  className="inspection-fullscreen-image-zoom-layer"
	                  style={{
	                    transform: `translate(${fullscreenImageZoom.panX || 0}px, ${fullscreenImageZoom.panY || 0}px) scale(${fullscreenImageZoom.scale})`,
	                    transformOrigin: `${fullscreenImageZoom.originX}% ${fullscreenImageZoom.originY}%`,
	                  }}
                >
                  {!isMprFullscreen && fullscreenShowsExternalOverlay && (
                    <img
                      src={`/api/images/${encodeURIComponent(fullscreenBaseImageId)}/content`}
                      alt={`${fullscreenImageModal.label} source fullscreen`}
                      className="inspection-fullscreen-image"
                    />
                  )}
                  {isMprFullscreen ? (
                    <MprSliceCanvas
                      {...fullscreenSurfaceProps}
                      className={`${fullscreenSurfaceClassName} inspection-fullscreen-mpr-slice`}
                      axis={fullscreenImageModal.axis}
                      volumeCache={volumeCacheState.cache}
                      overlayCaches={activeVolumeOverlayCaches}
                      volumeCacheStatus={volumeCacheState.status}
                      slicePosition={fullscreenMprSlicePosition}
                      dimensions={mprDimensions}
                      displayWindow={displayWindow}
                      displayDomain={displayValueDomain}
                      overlayOpacityMultiplier={annotationOpacityMultiplier}
                      style={fullscreenMprProjectionStyle}
                      data-testid="fullscreen-mpr-slice"
                      data-mpr-slice-key={fullscreenMprSliceKey}
                      data-mpr-backing-image-id={fullscreenImageId}
                    />
                  ) : (
                    <img
                      {...fullscreenSurfaceProps}
                      src={`/api/images/${encodeURIComponent(
                        fullscreenShowsExternalOverlay ? fullscreenImageId : (fullscreenBaseImageId || fullscreenImageId),
                      )}/content`}
                      alt={`${fullscreenImageModal.label} fullscreen`}
		                />
                  )}
		          <svg
		            className={`inspection-fullscreen-measurement-overlay ${isMprFullscreen ? 'mpr-projection-overlay' : ''}`.trim()}
		            viewBox={fullscreenOverlayViewBox}
		            preserveAspectRatio="xMidYMid meet"
		            style={fullscreenMprProjectionStyle}
		            aria-label="fullscreen measurement overlay"
		          >
		            <g transform={fullscreenOverlayContentTransform}>
	                    {[...renderedFullscreenMeasurementLines, ...fullscreenPreviewLines].map((line) => {
                      const labelPosition = getMeasurementLabelViewBoxPosition(line, 20);
                      const endpointPositions = getMeasurementEndpointViewBoxPosition(line);
                      const endpointActive = fullscreenEditingEndpoint?.lineId === String(line.id)
                        || String(fullscreenBoundsEditAnnotationId || '') === String(line.id);
                      return (
                        <g key={line.id}>
                          <line
                            x1={(line.x1 / line.imageWidth) * 1000}
                            y1={(line.y1 / line.imageHeight) * 1000}
                            x2={(line.x2 / line.imageWidth) * 1000}
                            y2={(line.y2 / line.imageHeight) * 1000}
                            stroke={line.color}
                            strokeWidth="3"
                            pointerEvents="none"
                            opacity={annotationOpacityMultiplier}
                          />
                          <text
                            x={labelPosition.x}
                            y={labelPosition.y}
                            fill={line.color}
                            fontSize="20"
                            pointerEvents="none"
                            opacity={annotationOpacityMultiplier}
                          >
                            {getMeasurementLineLabel(line)}
                          </text>
                          {line.id !== 'fullscreen-measure-preview' && (
                            <line
                              className="inspection-annotation-drag-target"
                              x1={(line.x1 / line.imageWidth) * 1000}
                              y1={(line.y1 / line.imageHeight) * 1000}
                              x2={(line.x2 / line.imageWidth) * 1000}
                              y2={(line.y2 / line.imageHeight) * 1000}
                              stroke="transparent"
                              strokeWidth="24"
                              pointerEvents="stroke"
                              onPointerDown={(event) => startFullscreenAnnotationDrag(event, 'line', 'translate', line)}
                              onPointerMove={handleFullscreenAnnotationDragMove}
                              onPointerUp={finishFullscreenAnnotationDrag}
                              onPointerCancel={(event) => finishFullscreenAnnotationDrag(event, { cancel: true })}
                            />
                          )}
                          {endpointActive && ['start', 'end'].map((endpoint) => (
                            <circle
                              key={endpoint}
                              className="inspection-measurement-endpoint-dot"
                              cx={endpointPositions[endpoint].x}
                              cy={endpointPositions[endpoint].y}
                              r="11"
                              fill="#ffffff"
                              stroke={line.color}
                              strokeWidth="5"
                              role="button"
                              tabIndex={0}
                              aria-label={`Reposition ${endpoint} endpoint for ${line.name || 'measurement'}`}
                              onPointerDown={(event) => startFullscreenAnnotationDrag(event, 'line', endpoint, line)}
                              onPointerMove={handleFullscreenAnnotationDragMove}
                              onPointerUp={finishFullscreenAnnotationDrag}
                              onPointerCancel={(event) => finishFullscreenAnnotationDrag(event, { cancel: true })}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (event.detail === 0) handleFullscreenEndpointDotClick(event, line, endpoint);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  handleFullscreenEndpointDotClick(event, line, endpoint);
                                }
                              }}
                            />
                          ))}
                        </g>
	                      );
	                    })}
	                    {renderAnnotationOverlay({ measurementLines: [], boxes: [...renderedFullscreenBoxAnnotations, ...fullscreenPreviewBoxes], fontSize: 20, selectedAnnotationId, opacityMultiplier: annotationOpacityMultiplier })}
                    {renderedFullscreenBoxAnnotations.map((box) => {
                      const cornerPositions = getAnnotationBoxCornerViewBoxPosition(box);
                      const cornerActive = fullscreenEditingBoxCorner?.boxId === String(box.id)
                        || String(fullscreenBoundsEditAnnotationId || '') === String(box.id);
                      return (
                        <g key={`box-corners-${box.id}`}>
                          <rect
                            className="inspection-annotation-drag-target"
                            x={(box.x / box.imageWidth) * 1000}
                            y={(box.y / box.imageHeight) * 1000}
                            width={(box.width / box.imageWidth) * 1000}
                            height={(box.height / box.imageHeight) * 1000}
                            fill="transparent"
                            pointerEvents="all"
                            onPointerDown={(event) => startFullscreenAnnotationDrag(event, 'box', 'translate', box)}
                            onPointerMove={handleFullscreenAnnotationDragMove}
                            onPointerUp={finishFullscreenAnnotationDrag}
                            onPointerCancel={(event) => finishFullscreenAnnotationDrag(event, { cancel: true })}
                          />
                          {cornerActive && Object.entries(cornerPositions).map(([corner, point]) => (
                            <circle
                              key={corner}
                              className="inspection-box-corner-dot"
                              cx={point.x}
                              cy={point.y}
                              r="11"
                              fill="#ffffff"
                              stroke={box.color}
                              strokeWidth="5"
                              role="button"
                              tabIndex={0}
                              aria-label={`Reposition ${corner} corner for ${box.name || 'bounding box'}`}
                              onPointerDown={(event) => startFullscreenAnnotationDrag(event, 'box', corner, box)}
                              onPointerMove={handleFullscreenAnnotationDragMove}
                              onPointerUp={finishFullscreenAnnotationDrag}
                              onPointerCancel={(event) => finishFullscreenAnnotationDrag(event, { cancel: true })}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (event.detail === 0) handleFullscreenBoxCornerDotClick(event, box, corner);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  handleFullscreenBoxCornerDotClick(event, box, corner);
                                }
                              }}
                            />
                          ))}
                        </g>
                      );
                    })}
		            </g>
		            {fullscreenSegmentAnnotations.map((segment) => (
		              <g
		                key={`fullscreen-segment-${segment.id}`}
		                opacity={annotationOpacityMultiplier}
		              >
		                {renderCompositedSegmentationSegment(segment, {
		                  color: segment.color,
		                  fillOpacity: segment.opacity,
		                  axis: fullscreenImageModal.axis,
		                  sliceIndex: fullscreenCanonicalSliceIndex,
		                  imageWidth: fullscreenOverlayWidth,
		                  imageHeight: fullscreenOverlayHeight,
		                  volumeDimensions: [
		                    mprDimensions.sagittal,
		                    mprDimensions.coronal,
		                    mprDimensions.axial,
		                  ],
		                })}
		              </g>
		            ))}
	                  </svg>
	                </div>

              </div>
	              <aside className="inspection-fullscreen-annotations" aria-label="Annotations" data-testid="fullscreen-annotation-list">
	                <h4>Annotations</h4>
	                {fullscreenAnnotationItems.length === 0 ? (
	                  <p className="muted">No annotations.</p>
	                ) : (
	                  <ul className="inspection-fullscreen-annotation-list">
	                    {fullscreenAnnotationItems.map((annotation, index) => {
	                      const inspectionItem = annotation.inspectionItem;
	                      const itemVisible = inspectionItem?.visible !== false;
	                      return (
	                        <li
	                          key={`${annotation.annotationType}-${annotation.id}`}
	                          className={`inspection-fullscreen-annotation ${selectedAnnotationId === annotation.id ? 'selected' : ''} ${itemVisible ? '' : 'annotation-entry-hidden'}`}
	                          style={{ borderColor: annotation.color }}
	                        >
	                        <button
	                          type="button"
	                          className="inspection-fullscreen-annotation-body"
	                          onClick={() => {
	                            if (inspectionItem?.source.resource === 'annotation') {
	                              setSelectedAnnotationId(annotation.id);
	                              if (['measurement', 'box'].includes(annotation.annotationType)) {
	                                setFullscreenBoundsEditAnnotationId(annotation.id);
	                              }
	                            }
	                          }}
	                        >
	                          <span className="inspection-fullscreen-annotation-title">{annotation.title || `Annotation ${index + 1}`}</span>
	                          <span className="inspection-fullscreen-annotation-length">{annotation.summary}</span>
	                        </button>
	                        {inspectionItem && (
	                          <button
	                            type="button"
	                            className="inspection-fullscreen-annotation-visibility"
	                            aria-label={`${itemVisible ? 'Hide' : 'Show'} fullscreen annotation ${annotation.title || index + 1}`}
	                            aria-pressed={itemVisible}
	                            onClick={(event) => {
	                              event.stopPropagation();
	                              setInspectionItemVisibility(inspectionItem, !itemVisible);
	                            }}
	                          >
	                            {itemVisible ? 'Hide' : 'Show'}
	                          </button>
	                        )}
	                        {projectType !== 'PT3' && annotation.annotationType === 'box' && !isMprFullscreen && (
	                          <button
	                            type="button"
	                            className="inspection-fullscreen-annotation-crop"
	                            aria-label={`Crop ${annotation.title || `annotation ${index + 1}`}`}
	                            disabled={croppingAnnotationId === annotation.id}
	                            onClick={(event) => {
	                              event.stopPropagation();
	                              cropBoxAnnotation(annotation);
	                            }}
	                          >
	                            {croppingAnnotationId === annotation.id ? '…' : 'Crop'}
	                          </button>
	                        )}
	                        {inspectionItem?.source.resource !== 'source_image' && (
	                          <button
	                            type="button"
	                            className="inspection-fullscreen-annotation-delete"
	                            aria-label={`Delete ${annotation.title || `annotation ${index + 1}`}`}
	                            onClick={() => deleteMeasurementAnnotation(annotation.id)}
	                          >
	                            ×
	                          </button>
	                        )}
	                      </li>
	                      );
	                    })}
                  </ul>
                )}
              </aside>
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
                        className="btn btn-success"
                        disabled={savingPartId === selectedPart.id}
                        onClick={() => updatePartReviewState(selectedPart, 'pass')}
                      >
                        Pass
                      </button>
                      <button
                        className="btn btn-secondary"
                        disabled={savingPartId === selectedPart.id}
                        onClick={() => updatePartReviewState(selectedPart, 'unreviewed')}
                      >
                        Reset
                      </button>
                      <button
                        className="btn btn-danger"
                        disabled={savingPartId === selectedPart.id}
                        onClick={() => updatePartReviewState(selectedPart, 'reject_confirmed')}
                      >
                        Reject
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
                        <li>Reject: {inspectorHotkeys.reject_classification.toUpperCase()}</li>
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
	      {renderOtherAnnotationModal()}
      {renderAnnotationEditModal()}
      {renderSegmentationHelperModal()}
	      {renderFullscreenImageModal()}
	    </section>
	  );
}

export {
  getVolumeSourceImages,
  getVolumeOverlayStacks,
  getAlignedVolumeOverlayRendererStacks,
  getVolumeSummaryRepresentativeIndices,
  getVolumeRendererSliceIndices,
  getSemantic3dVolumeOverlayStacks,
  isConfirmedRgbaVolumeOverlay,
  mapWithConcurrency,
};
export {
  MPR_AXES,
  MPR_AXIS_CONFIG,
  MPR_SERVER_VOLUME_KIND,
  MPR_VOLUME_SLICE_RENDER_VERSION,
  MprSliceCanvas,
  getMprFallbackModelZoom,
  getMprAxisImageDimensions,
  getCanonicalSegmentationSliceIndex,
  getMprSliceCanvasCacheStats,
  getMprSliceCachingMessage,
  getMprOverlayCompositeAlpha,
  getAnnotationOpacityMultiplier,
  normalizeAnnotationTransparencyPercent,
  getServerVolumePrefetchSources,
  getServerVolumeSliceUrl,
  projectMprPointToOverlay,
  drawServerMprSliceImage,
  drawMprOverlaySlice,
  createServerVolumeDescriptor,
  getMprVolumeCacheKey,
  rememberSliceCanvas,
  resetMprSliceCanvasCacheForTests,
  shouldApplyDisplayWindowToVolumeCache,
  useMprVolumeCache,
};
export default InspectionWorkbenchPanel;
