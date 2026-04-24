import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Actions, Layout, Model } from 'flexlayout-react';
import 'flexlayout-react/style/light.css';
import { DEFAULT_INTERFACE_HIERARCHY } from '../utils/interfaceHierarchy';

const VIEW_ORDER = ['front', 'back', 'left', 'right', 'top', 'bottom'];
const MPR_AXES = ['axial', 'coronal', 'sagittal'];
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
      .filter((overlay) => overlay && overlay.id)
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

function validateInspectorHotkeysDraft(candidate) {
  const normalized = {};
  const usedKeys = new Set();
  for (const binding of Object.keys(DEFAULT_INSPECTOR_HOTKEYS)) {
    const raw = String(candidate?.[binding] || '').trim().toLowerCase();
    if (!/^[a-z0-9]$/.test(raw)) {
      return { valid: false, message: 'Hotkeys must be single alphanumeric characters.', normalized: null };
    }
    if (usedKeys.has(raw)) {
      return { valid: false, message: 'Hotkeys must use unique key bindings.', normalized: null };
    }
    usedKeys.add(raw);
    normalized[binding] = raw;
  }
  return { valid: true, message: '', normalized };
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

function panelRegionStyle(region) {
  const style = {};
  if (!region) return style;
  if (region.order != null) style.order = region.order;
  if (region.widthPx != null) style.width = `${region.widthPx}px`;
  if (region.minWidthPx != null) style.minWidth = `${region.minWidthPx}px`;
  if (region.maxWidthPx != null) style.maxWidth = `${region.maxWidthPx}px`;
  if (region.heightPx != null) style.height = `${region.heightPx}px`;
  if (region.minHeightPx != null) style.minHeight = `${region.minHeightPx}px`;
  if (region.maxHeightPx != null) style.maxHeight = `${region.maxHeightPx}px`;
  return style;
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

function InspectionWorkbenchPanel({ projectId, projectType, hierarchy }) {
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
  const [measurementDraft, setMeasurementDraft] = useState({ label: '', value: '' });
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
  const [inspectorHotkeyDraft, setInspectorHotkeyDraft] = useState(DEFAULT_INSPECTOR_HOTKEYS);
  const [hotkeySaveState, setHotkeySaveState] = useState({ loading: false, message: null, severity: null });
  const [projectConfiguration, setProjectConfiguration] = useState(null);
  const [inspectionColumnWidths, setInspectionColumnWidths] = useState(DEFAULT_INSPECTION_COLUMN_WIDTHS);
  const [shortcutHelpVisible, setShortcutHelpVisible] = useState(false);
  const [panelLayout, setPanelLayout] = useState(DEFAULT_PANEL_LAYOUT);
  const [normalizationTriageField, setNormalizationTriageField] = useState('');
  const [selectedImageRef, setSelectedImageRef] = useState('');
  const [projectImageLookup, setProjectImageLookup] = useState({});
  const [viewportWidth, setViewportWidth] = useState(() => (
    typeof window === 'undefined' ? Number.POSITIVE_INFINITY : window.innerWidth
  ));
  const [workbenchWidth, setWorkbenchWidth] = useState(0);
  const workbenchDetailsRef = useRef(null);
  const inspectionResizeSaveTimerRef = useRef(null);

  const inspectionHierarchy = useMemo(() => normalizeInspectionHierarchy(hierarchy || {}), [hierarchy]);
  const leftRegion = inspectionHierarchy.regions[inspectionHierarchy.leftColumn];
  const rightRegion = inspectionHierarchy.regions[inspectionHierarchy.rightColumn];
  const inspectorRegion = inspectionHierarchy.regions.inspector;
  const availableLayoutWidth = workbenchWidth > 0 ? workbenchWidth : viewportWidth;
  const inspectionLayoutCollapsed = availableLayoutWidth <= inspectionHierarchy.layout.collapseBreakpointPx;
  const defaultLeftColumnWidthPx = normalizeLayoutNumber(leftRegion?.widthPx ?? leftRegion?.minWidthPx, 240);
  const defaultRightColumnWidthPx = normalizeLayoutNumber(rightRegion?.widthPx ?? rightRegion?.minWidthPx, 240);
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
        },
        [inspectionHierarchy.rightColumn]: {
          ...rightRegion,
          widthPx: configuredRightColumnWidthPx,
        },
      },
    },
    leftRegion: {
      ...leftRegion,
      widthPx: configuredLeftColumnWidthPx,
    },
    inspectorRegion,
    rightRegion: {
      ...rightRegion,
      widthPx: configuredRightColumnWidthPx,
    },
    inspectionLayoutCollapsed,
  }), [
    configuredLeftColumnWidthPx,
    configuredRightColumnWidthPx,
    inspectionHierarchy,
    inspectionLayoutCollapsed,
    inspectorRegion,
    leftRegion,
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

        const [batchResp, partResp, workspaceResp, configResp, imageResp] = await Promise.all([
          fetch(`/api/projects/${projectId}/batches`),
          fetch(`/api/projects/${projectId}/parts`),
          fetch(`/api/projects/${projectId}/workspace-state`),
          fetch(`/api/projects/${projectId}/configuration`),
          fetch(`/api/projects/${projectId}/images?include_deleted=true&limit=5000`),
        ]);
        if (!batchResp.ok) {
          throw new Error(`Failed to load batches (${batchResp.status})`);
        }
        if (!partResp.ok) {
          throw new Error(`Failed to load parts (${partResp.status})`);
        }

        const [batchData, partData, workspaceData, configData, imageData] = await Promise.all([
          batchResp.json(),
          partResp.json(),
          workspaceResp.ok ? workspaceResp.json() : Promise.resolve({ state: {} }),
          configResp.ok ? configResp.json() : Promise.resolve({}),
          imageResp.ok ? imageResp.json() : Promise.resolve([]),
        ]);
        const safeBatches = Array.isArray(batchData) ? batchData : [];
        const safeParts = Array.isArray(partData) ? partData : [];
        const savedState = workspaceData?.state && typeof workspaceData.state === 'object' ? workspaceData.state : {};
        setPanelLayout(normalizePanelLayout(savedState.panel_layout));
        const resolvedConfig = configData?.config && typeof configData.config === 'object' ? configData.config : {};
        setProjectConfiguration(resolvedConfig);
        setInspectionColumnWidths(normalizeInspectionColumnWidths(resolvedConfig?.inspection_layout?.column_widths));
        const savedHotkeys = normalizeInspectorHotkeys(
          resolvedConfig?.process_settings?.configurable_hotkeys,
        );
        setInspectorHotkeys(savedHotkeys);
        setInspectorHotkeyDraft(savedHotkeys);
        setWorkspaceHydration(savedState);
        setBatches(safeBatches);
        setParts(safeParts);
        const imageLookup = (Array.isArray(imageData) ? imageData : []).reduce((acc, image) => {
          const filename = String(image?.filename || '');
          if (!filename) return acc;
          acc[filename] = image;
          return acc;
        }, {});
        setProjectImageLookup(imageLookup);
        const savedBatchId = String(savedState.selected_batch_id || '');
        setSelectedBatchId(savedBatchId);
        const savedReviewFilter = String(savedState.review_filter || 'all');
        setReviewFilter(['all', 'pass', 'reject_pending', 'reject_confirmed', 'none'].includes(savedReviewFilter) ? savedReviewFilter : 'all');
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

  const saveInspectorHotkeys = async () => {
    const validation = validateInspectorHotkeysDraft(inspectorHotkeyDraft);
    if (!validation.valid) {
      setHotkeySaveState({ loading: false, message: validation.message, severity: 'error' });
      return;
    }

    const nextConfig = {
      ...(projectConfiguration && typeof projectConfiguration === 'object' ? projectConfiguration : {}),
      process_settings: {
        ...((projectConfiguration && projectConfiguration.process_settings) || {}),
        configurable_hotkeys: validation.normalized,
      },
    };

    try {
      setHotkeySaveState({ loading: true, message: null, severity: null });
      const resp = await fetch(`/api/projects/${projectId}/configuration`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: nextConfig }),
      });
      if (!resp.ok) {
        throw new Error(`Failed to save hotkeys (${resp.status})`);
      }
      const payload = await resp.json();
      const persistedConfig = payload?.config && typeof payload.config === 'object' ? payload.config : nextConfig;
      const persistedHotkeys = normalizeInspectorHotkeys(
        persistedConfig?.process_settings?.configurable_hotkeys,
      );
      setProjectConfiguration(persistedConfig);
      setInspectorHotkeys(persistedHotkeys);
      setInspectorHotkeyDraft(persistedHotkeys);
      setHotkeySaveState({ loading: false, message: 'Hotkeys saved for this project.', severity: 'success' });
    } catch (err) {
      setHotkeySaveState({
        loading: false,
        message: err?.message || 'Failed to save hotkeys.',
        severity: 'error',
      });
    }
  };

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

  const updatePanelLayout = (panelKey, updates) => {
    setPanelLayout((prev) => {
      const next = normalizePanelLayout({
        ...prev,
        [panelKey]: {
          ...(prev[panelKey] || DEFAULT_PANEL_LAYOUT[panelKey]),
          ...updates,
        },
      });
      return next;
    });
  };

  const filteredParts = useMemo(() => {
    let output = [...parts];

    if (selectedBatchId) {
      output = output.filter((part) => part.batch_id === selectedBatchId);
    }
    if (reviewFilter !== 'all') {
      if (reviewFilter === 'none') {
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
    const imagesByView = selectedPart.metadata.view_images || {};
    if (!imagesByView || typeof imagesByView !== 'object') return [];
    return Object.entries(imagesByView).map(([viewName, imageRef]) => ({
      id: `${selectedPart.id}-${viewName}`,
      viewName,
      imageRef: imageRef ? String(imageRef) : '',
    }));
  }, [selectedPart]);
  const selectedImageRecord = useMemo(() => {
    if (!selectedImageRef) return null;
    return projectImageLookup[selectedImageRef] || null;
  }, [projectImageLookup, selectedImageRef]);

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
    setMeasurementDraft({ label: '', value: '' });
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

  const adjustZoom = (delta) => {
    setViewportTransform((prev) => {
      const nextZoom = Math.min(4, Math.max(0.5, Number((prev.zoom + delta).toFixed(2))));
      return { ...prev, zoom: nextZoom };
    });
  };

  const panViewport = (dx, dy) => {
    setViewportTransform((prev) => ({
      ...prev,
      panX: Math.min(200, Math.max(-200, prev.panX + dx)),
      panY: Math.min(200, Math.max(-200, prev.panY + dy)),
    }));
  };

  const resetViewport = () => {
    setViewportTransform({ zoom: 1, panX: 0, panY: 0 });
  };

  const toggleOverlay = (overlayId) => {
    setActiveOverlayIds((prev) => {
      if (prev.includes(overlayId)) return prev.filter((id) => id !== overlayId);
      return [...prev, overlayId];
    });
  };

  const toggleModality = (modality) => {
    setEnabledModalities((prev) => {
      if (prev.includes(modality)) {
        if (prev.length === 1) return prev;
        return prev.filter((value) => value !== modality);
      }
      return [...prev, modality];
    });
  };

  const saveMeasurement = () => {
    const value = Number(measurementDraft.value);
    const label = measurementDraft.label.trim();
    if (!label || !Number.isFinite(value)) return;
    const nextEntry = {
      id: `${Date.now()}-${measurementEntries.length + 1}`,
      label,
      value: Number(value.toFixed(2)),
      units: 'mm',
      modality: enabledModalities[0] || modalityOptions[0] || 'visual',
      view: activeViewName || 'axial',
    };
    setMeasurementEntries((prev) => [nextEntry, ...prev]);
    setMeasurementDraft({ label: '', value: '' });
  };

  const deleteMeasurement = (measurementId) => {
    setMeasurementEntries((prev) => prev.filter((entry) => entry.id !== measurementId));
  };

  const adjustInspectorZoom = (delta) => {
    setInspectorViewport((prev) => ({
      ...prev,
      zoom: Math.min(4, Math.max(0.5, Number((prev.zoom + delta).toFixed(2)))),
    }));
  };

  const panInspectorViewport = (dx, dy) => {
    setInspectorViewport((prev) => ({
      ...prev,
      panX: Math.min(200, Math.max(-200, prev.panX + dx)),
      panY: Math.min(200, Math.max(-200, prev.panY + dy)),
    }));
  };

  const resetInspectorViewport = () => {
    setInspectorViewport({ zoom: 1, panX: 0, panY: 0 });
  };

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
      style={panelRegionStyle(leftRegion)}
      data-layout-region={inspectionHierarchy.leftColumn}
    >
      <div className="workspace-panel-layout">
        <strong>{leftRegion?.label || 'Part Summary'}</strong>
        <p className="muted">Navigate by batch, part, and image.</p>
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

          <label htmlFor="reviewFilter" className="form-label">Inspection status</label>
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
            <option value="none">None</option>
          </select>

          <label htmlFor="partFilter" className="form-label">Batch / Part filter</label>
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
                  <h4>{batchKey}</h4>
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
                          <div className="group-row-identifier">{part.serial_number}</div>
                          <div className="workbench-defect-count">
                            Reviewed: {state === 'unreviewed' ? 'No' : 'Yes'} • Defects: {defectCount} • Annotations: {annotationCount}
                          </div>
                          {imageEntries.length > 0 && (
                            <div className="part-summary-images">
                              {imageEntries.map(([viewName, imageRef]) => (
                                <button
                                  type="button"
                                  key={`${part.id}-${viewName}`}
                                  className={`btn btn-secondary btn-sm ${selectedImageRef === String(imageRef || '') ? 'active' : ''}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    setSelectedPartId(part.id);
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

  const renderCenterPane = (tabKey) => (
    <section
      className="workbench-tabbed-panel"
      style={panelRegionStyle(inspectorRegion)}
      data-layout-region="center"
    >
      <div className="workspace-panel-layout" data-testid="selected-image-panel">
        <strong>{inspectionHierarchy.regions[tabKey]?.label || 'Inspection'}</strong>
        {tabKey === 'image_metadata' ? (
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
              {getPartViews(selectedPart).map((viewName) => {
                const imagesByView = selectedPart?.metadata?.view_images || {};
                const imageRef = String(imagesByView?.[viewName] || '');
                const imageRecord = projectImageLookup[imageRef];
                const imageId = imageRecord?.id;
                return (
                  <div key={viewName} className={`view-cell ${activeViewName === viewName ? 'selected' : ''}`}>
                    <div className="view-cell-title">{viewName.toUpperCase()}</div>
                    <div className="view-cell-body">
                      {!imageEnabled ? (
                        <span className="view-cell-empty">Image hidden</span>
                      ) : imageId ? (
                        <img
                          className="inspection-view-image"
                          src={`/api/images/${encodeURIComponent(String(imageId))}/content`}
                          alt={`${viewName} view`}
                          loading="lazy"
                        />
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
      style={panelRegionStyle(rightRegion)}
      data-layout-region={inspectionHierarchy.rightColumn}
    >
      <div className="annotation-controls" data-testid="annotation-controls">
        <strong>{rightRegion?.label || 'Annotations'}</strong>
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
              <li key={annotation.id}>
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
                ) : (
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

  return (
    <section className="workbench-panel" aria-label="Inspection Workbench">
      <div className="workbench-header">
        <h2>Inspection Workbench</h2>
        <p>
          Inspection workbench for <strong>{projectType || 'PT1'}</strong> projects.
        </p>
      </div>

      {loading && <div className="loading-text">Loading inspection workbench…</div>}
      {error && <div className="alert alert-error">{error}</div>}

      {!loading && !error && (
        <>
          <div className="workbench-stats">
            <span className="group-badge">Batches: {batches.length}</span>
            <span className="group-badge">Parts: {parts.length}</span>
            <span className="group-badge">Passed: {reviewSummary.pass}</span>
            <span className="group-badge">Rejected: {reviewSummary.reject_confirmed + reviewSummary.reject_pending}</span>
          </div>

          <div className="workbench-layout">
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
          </div>
        </>
      )}
    </section>
  );
}

export default InspectionWorkbenchPanel;
