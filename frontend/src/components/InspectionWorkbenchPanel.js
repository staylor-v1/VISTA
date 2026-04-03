import React, { useEffect, useMemo, useState } from 'react';

const VIEW_ORDER = ['front', 'back', 'left', 'right', 'top', 'bottom'];
const MPR_AXES = ['axial', 'coronal', 'sagittal'];
const DEFAULT_OVERLAY_LAYERS = [
  { id: 'segmentation', label: 'Segmentation', color: '#ef4444' },
  { id: 'heatmap', label: 'Heatmap', color: '#8b5cf6' },
  { id: 'voids', label: 'Voids', color: '#f59e0b' },
];
const DEFAULT_MODALITIES = ['visual', 'infrared', 'uv'];
const REVIEW_LABELS = {
  unreviewed: 'Unreviewed',
  in_review: 'In Review',
  pass: 'Pass',
  reject_pending: 'Reject Pending',
  reject_confirmed: 'Reject Confirmed',
};

function getDefectCount(part) {
  const defects = part?.metadata?.defects;
  if (Array.isArray(defects)) return defects.length;
  const explicitCount = part?.metadata?.defect_count;
  return Number.isFinite(explicitCount) ? explicitCount : 0;
}

function getCriticalDefectCount(part) {
  const defects = part?.metadata?.defects;
  if (!Array.isArray(defects)) return 0;
  return defects.filter((item) => (item?.severity || '').toLowerCase() === 'critical').length;
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

function InspectionWorkbenchPanel({ projectId, projectType }) {
  const [batches, setBatches] = useState([]);
  const [parts, setParts] = useState([]);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [selectedPartId, setSelectedPartId] = useState('');
  const [defectFilter, setDefectFilter] = useState('all');
  const [sortMode, setSortMode] = useState('defect_desc');
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
  const [bundleExport, setBundleExport] = useState({
    loading: false,
    error: null,
    payload: null,
  });

  useEffect(() => {
    const loadWorkbenchData = async () => {
      try {
        setLoading(true);
        setError(null);

        const [batchResp, partResp, workspaceResp] = await Promise.all([
          fetch(`/api/projects/${projectId}/batches`),
          fetch(`/api/projects/${projectId}/parts`),
          fetch(`/api/projects/${projectId}/workspace-state`),
        ]);
        if (!batchResp.ok) {
          throw new Error(`Failed to load batches (${batchResp.status})`);
        }
        if (!partResp.ok) {
          throw new Error(`Failed to load parts (${partResp.status})`);
        }

        const [batchData, partData, workspaceData] = await Promise.all([
          batchResp.json(),
          partResp.json(),
          workspaceResp.ok ? workspaceResp.json() : Promise.resolve({ state: {} }),
        ]);
        const safeBatches = Array.isArray(batchData) ? batchData : [];
        const safeParts = Array.isArray(partData) ? partData : [];
        const savedState = workspaceData?.state && typeof workspaceData.state === 'object' ? workspaceData.state : {};
        setWorkspaceHydration(savedState);
        setBatches(safeBatches);
        setParts(safeParts);
        const savedBatchId = String(savedState.selected_batch_id || '');
        setSelectedBatchId(savedBatchId);
        const savedDefectFilter = String(savedState.defect_filter || 'all');
        setDefectFilter(['all', 'has_defects', 'critical_only'].includes(savedDefectFilter) ? savedDefectFilter : 'all');
        const savedSortMode = String(savedState.sort_mode || 'defect_desc');
        setSortMode(['defect_desc', 'serial_asc'].includes(savedSortMode) ? savedSortMode : 'defect_desc');
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

  const filteredParts = useMemo(() => {
    let output = [...parts];

    if (selectedBatchId) {
      output = output.filter((part) => part.batch_id === selectedBatchId);
    }
    if (defectFilter === 'has_defects') {
      output = output.filter((part) => getDefectCount(part) > 0);
    } else if (defectFilter === 'critical_only') {
      output = output.filter((part) => getCriticalDefectCount(part) > 0);
    }

    if (sortMode === 'defect_desc') {
      output.sort((a, b) => getDefectCount(b) - getDefectCount(a));
    } else if (sortMode === 'serial_asc') {
      output.sort((a, b) => String(a.serial_number).localeCompare(String(b.serial_number)));
    }

    return output;
  }, [parts, selectedBatchId, defectFilter, sortMode]);

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
    if (!selectedPart) return;
    const savedInspector = workspaceHydration?.inspector || {};
    const savedModalities = Array.isArray(savedInspector.modalities)
      ? savedInspector.modalities.map((value) => String(value))
      : [];
    setEnabledModalities(savedModalities.length > 0 ? savedModalities : getModalities(selectedPart).slice(0, 1));
    setSelectedViewName(savedInspector.view_name ? String(savedInspector.view_name) : '');
    setImageEnabled(savedInspector.image_enabled !== false);
    setMeasurementEntries(Array.isArray(savedInspector.measurements) ? savedInspector.measurements : []);
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
              defect_filter: defectFilter,
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
                measurements: measurementEntries,
                viewport_transform: inspectorViewport,
              },
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
    defectFilter,
    enabledModalities,
    imageEnabled,
    loading,
    measurementEntries,
    inspectorViewport,
    projectId,
    projectType,
    selectedBatchId,
    selectedPart,
    slicePosition,
    sortMode,
    viewportTransform,
    workspaceStateLoaded,
  ]);

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

  const updatePartReviewState = async (part, nextState) => {
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
  };

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

  const requestExportBundleSummary = async () => {
    try {
      setBundleExport({ loading: true, error: null, payload: null });
      const resp = await fetch(`/api/projects/${projectId}/export-bundle-json`);
      if (!resp.ok) {
        throw new Error(`Failed to generate export bundle summary (${resp.status})`);
      }
      const payload = await resp.json();
      setBundleExport({ loading: false, error: null, payload });
    } catch (err) {
      setBundleExport({ loading: false, error: err.message || 'Failed to generate export bundle summary', payload: null });
    }
  };

  return (
    <section className="workbench-panel" aria-label="Inspection Workbench">
      <div className="workbench-header">
        <h2>Project Data</h2>
        <p>
          Inspection workbench for <strong>{projectType || 'PT1'}</strong> projects.
        </p>
        <div className="workbench-detail-actions">
          <button
            type="button"
            className="btn btn-secondary"
            data-testid="request-export-bundle-summary"
            disabled={bundleExport.loading}
            onClick={requestExportBundleSummary}
          >
            {bundleExport.loading ? 'Preparing Export Summary…' : 'Export Bundle Summary'}
          </button>
        </div>
      </div>

      {loading && <div className="loading-text">Loading inspection workbench…</div>}
      {error && <div className="alert alert-error">{error}</div>}
      {bundleExport.error && <div className="alert alert-error">{bundleExport.error}</div>}
      {bundleExport.payload && (
        <div className="alert alert-success" data-testid="export-bundle-summary-result">
          Export summary ready: {bundleExport.payload?.summary?.images?.total || 0} images,{' '}
          {bundleExport.payload?.summary?.annotations?.total || 0} annotations,{' '}
          {bundleExport.payload?.summary?.overlays?.segmentation_runs || 0} segmentation runs.
        </div>
      )}

      {!loading && !error && (
        <>
          <div className="workbench-stats">
            <span className="group-badge">Batches: {batches.length}</span>
            <span className="group-badge">Parts: {parts.length}</span>
            <span className="group-badge">Passed: {reviewSummary.pass}</span>
            <span className="group-badge">Rejected: {reviewSummary.reject_confirmed + reviewSummary.reject_pending}</span>
          </div>

          <div className="workbench-controls">
            <label htmlFor="batchFilter" className="form-label">
              Batch
            </label>
            <select
              id="batchFilter"
              className="form-control"
              value={selectedBatchId}
              onChange={(e) => setSelectedBatchId(e.target.value)}
            >
              <option value="">All batches</option>
              {batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {batch.name}
                </option>
              ))}
            </select>

            <label htmlFor="defectFilter" className="form-label">
              Defect filter
            </label>
            <select
              id="defectFilter"
              className="form-control"
              value={defectFilter}
              onChange={(e) => setDefectFilter(e.target.value)}
            >
              <option value="all">All parts</option>
              <option value="has_defects">Has defects</option>
              <option value="critical_only">Critical defects only</option>
            </select>

            <label htmlFor="sortMode" className="form-label">
              Sort
            </label>
            <select
              id="sortMode"
              className="form-control"
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value)}
            >
              <option value="defect_desc">Defect count (high → low)</option>
              <option value="serial_asc">Serial Number (A → Z)</option>
            </select>
          </div>

          <div className="workbench-layout">
            <div className="workbench-list">
              {filteredParts.length === 0 ? (
                <p className="muted">No parts found for the current filters.</p>
              ) : (
                filteredParts.map((part) => {
                  const state = part.review_state || 'unreviewed';
                  const defectCount = getDefectCount(part);
                  const isSelected = part.id === selectedPart?.id;
                  return (
                    <article
                      key={part.id}
                      className={`workbench-part-row ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelectedPartId(part.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          setSelectedPartId(part.id);
                        }
                      }}
                    >
                      <div>
                        <div className="group-row-name">
                          {part.display_name || part.serial_number}
                          {state === 'pass' && <span className="part-checkmark" title="Part passed review">✓</span>}
                        </div>
                        <div className="group-row-identifier">{part.serial_number}</div>
                        <div className="workbench-defect-count">Defects: {defectCount}</div>
                      </div>
                      <span
                        className={`group-status-badge group-status-${state}`}
                        data-testid="part-review-state"
                      >
                        {REVIEW_LABELS[state] || REVIEW_LABELS.unreviewed}
                      </span>
                    </article>
                  );
                })
              )}
            </div>

            <div className="workbench-details">
              {!selectedPart ? (
                <p className="muted">Select a part to inspect its configured view board.</p>
              ) : (
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

                  <div className="inspector-common-controls" data-testid="inspector-common-controls">
                    <div className="modality-controls">
                      <strong>Modalities</strong>
                      <div className="modality-list">
                        {modalityOptions.map((modality) => (
                          <label key={modality} className="overlay-toggle">
                            <input
                              type="checkbox"
                              checked={enabledModalities.includes(modality)}
                              onChange={() => toggleModality(modality)}
                            />
                            <span>{modality}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                    <div className="view-switcher">
                      <strong>View quick switch</strong>
                      <div className="view-thumbnail-list">
                        {getPartViews(selectedPart).map((viewName) => (
                          <button
                            key={viewName}
                            type="button"
                            className={`btn btn-secondary btn-sm ${activeViewName === viewName ? 'active' : ''}`}
                            onClick={() => setSelectedViewName(viewName)}
                          >
                            {viewName.toUpperCase()}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="image-toggle">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        data-testid="toggle-image-visibility"
                        onClick={() => setImageEnabled((prev) => !prev)}
                      >
                        {imageEnabled ? 'Hide image' : 'Show image'}
                      </button>
                    </div>
                    <div className="measurement-capture">
                      <strong>Measurements</strong>
                      <div className="measurement-fields">
                        <input
                          type="text"
                          placeholder="label"
                          value={measurementDraft.label}
                          onChange={(event) => setMeasurementDraft((prev) => ({ ...prev, label: event.target.value }))}
                        />
                        <input
                          type="number"
                          placeholder="value"
                          value={measurementDraft.value}
                          onChange={(event) => setMeasurementDraft((prev) => ({ ...prev, value: event.target.value }))}
                        />
                        <button type="button" className="btn btn-secondary btn-sm" onClick={saveMeasurement}>
                          Save measurement
                        </button>
                      </div>
                      <ul className="measurement-list" data-testid="manual-measurement-list">
                        {measurementEntries.length === 0 ? (
                          <li className="muted">No measurements captured.</li>
                        ) : (
                          measurementEntries.map((entry) => (
                            <li key={entry.id}>
                              <span>
                                {entry.label}: {entry.value}
                                {entry.units} ({entry.modality} • {entry.view})
                              </span>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => deleteMeasurement(entry.id)}
                                aria-label={`Delete measurement ${entry.label}`}
                              >
                                Delete
                              </button>
                            </li>
                          ))
                        )}
                      </ul>
                    </div>
                    <div className="inspector-nav-controls" data-testid="inspector-nav-controls">
                      <strong>Inspector viewport</strong>
                      <div className="mpr-nav-controls">
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => adjustInspectorZoom(0.1)}>Zoom +</button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => adjustInspectorZoom(-0.1)}>Zoom -</button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={resetInspectorViewport}>Reset</button>
                      </div>
                      <div className="mpr-nav-controls">
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => panInspectorViewport(0, -10)}>Pan ↑</button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => panInspectorViewport(-10, 0)}>Pan ←</button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => panInspectorViewport(10, 0)}>Pan →</button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => panInspectorViewport(0, 10)}>Pan ↓</button>
                      </div>
                      <p className="muted" data-testid="inspector-viewport-state">
                        Zoom {inspectorViewport.zoom.toFixed(2)}x • Pan ({inspectorViewport.panX}, {inspectorViewport.panY})
                      </p>
                    </div>
                    <div className="annotation-controls" data-testid="annotation-controls">
                      <strong>Annotations</strong>
                      <div className="measurement-fields">
                        <input
                          type="text"
                          placeholder="defect class"
                          value={annotationDraft.defect_class}
                          onChange={(event) => setAnnotationDraft((prev) => ({ ...prev, defect_class: event.target.value }))}
                        />
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
                        <button type="button" className="btn btn-secondary btn-sm" onClick={createAnnotation}>
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
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => startAnnotationEdit(annotation)}
                                  >
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => updateAnnotationVisibility(annotation.id, !annotation.hidden)}
                                  >
                                    {annotation.hidden ? 'Show' : 'Hide'}
                                  </button>
                                </>
                              )}
                            </li>
                          ))
                        )}
                      </ul>
                    </div>
                  </div>

                  {['PT2', 'PT3'].includes(projectType) ? (
                    <div className="mpr-shell" data-testid="mpr-shell">
                      <div className="mpr-controls">
                        <label htmlFor="contrastSlider">Contrast ({contrastPercent}%)</label>
                        <input
                          id="contrastSlider"
                          data-testid="contrast-slider"
                          type="range"
                          min="50"
                          max="150"
                          value={contrastPercent}
                          onChange={(e) => setContrastPercent(Number(e.target.value))}
                        />
                        <div className="overlay-toggles">
                          {overlayLayers.map((overlay) => {
                            const checked = activeOverlayIds.includes(overlay.id);
                            return (
                              <label key={overlay.id} className="overlay-toggle">
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggleOverlay(overlay.id)}
                                />
                                <span
                                  className="overlay-swatch"
                                  style={{ backgroundColor: overlay.color }}
                                  aria-hidden="true"
                                />
                                {overlay.label}
                              </label>
                            );
                          })}
                        </div>
                        <div className="probe-controls">
                          <label htmlFor="probeX">Cursor X ({cursorProbe.x})</label>
                          <input
                            id="probeX"
                            data-testid="probe-x"
                            type="range"
                            min="0"
                            max="100"
                            value={cursorProbe.x}
                            onChange={(e) => setCursorProbe((prev) => ({ ...prev, x: Number(e.target.value) }))}
                          />
                          <label htmlFor="probeY">Cursor Y ({cursorProbe.y})</label>
                          <input
                            id="probeY"
                            data-testid="probe-y"
                            type="range"
                            min="0"
                            max="100"
                            value={cursorProbe.y}
                            onChange={(e) => setCursorProbe((prev) => ({ ...prev, y: Number(e.target.value) }))}
                          />
                        </div>
                        <p data-testid="mpr-tooltip-values">
                          Cursor ({cursorProbe.x}, {cursorProbe.y}) • Base {tooltipValues.base}
                          {tooltipValues.overlays.length > 0
                            ? ` • ${tooltipValues.overlays
                              .map((entry) => `${entry.overlayId}: ${entry.value}%`)
                              .join(' | ')}`
                            : ' • No overlays selected'}
                        </p>
                        <div className="mpr-ml-actions">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            data-testid="run-segmentation"
                            onClick={runSegmentation}
                            disabled={mlActionLoading.segmentation}
                          >
                            {mlActionLoading.segmentation ? 'Running…' : 'Run Segmentation'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            data-testid="run-measurements"
                            onClick={runMeasurements}
                            disabled={mlActionLoading.measurement}
                          >
                            {mlActionLoading.measurement ? 'Running…' : 'Run AI Measurements'}
                          </button>
                        </div>
                        {segmentationRun && (
                          <p data-testid="segmentation-result">
                            Segmentation {segmentationRun.status}: {segmentationRun.overlay_id} on {segmentationRun.axis} slice {segmentationRun.slice_index + 1}
                          </p>
                        )}
                        {measurementRun && (
                          <p data-testid="measurement-result">
                            Measurements {measurementRun.status}: {Object.entries(measurementRun.values || {})
                              .map(([key, value]) => `${key}=${value}${measurementRun.units || ''}`)
                              .join(' • ')}
                          </p>
                        )}
                      </div>
                      <div className="mpr-grid">
                        <section className="mpr-pane mpr-pane-axial" aria-label="Axial pane">
                          <header>
                            <strong>Axial</strong>
                            <span>
                              Slice {slicePosition.axial + 1} / {mprDimensions.axial}
                            </span>
                          </header>
                          <label htmlFor="axialSlice">Axial slice</label>
                          <input
                            id="axialSlice"
                            data-testid="slice-slider-axial"
                            type="range"
                            min="0"
                            max={Math.max(0, mprDimensions.axial - 1)}
                            value={slicePosition.axial}
                            onChange={(e) => updateSlicePosition('axial', e.target.value, mprDimensions)}
                          />
                          <div className="mpr-crosshair-preview" aria-hidden="true">
                            <span className="line line-coronal" style={{ top: `${((slicePosition.coronal + 1) / mprDimensions.coronal) * 100}%` }} />
                            <span className="line line-sagittal" style={{ left: `${((slicePosition.sagittal + 1) / mprDimensions.sagittal) * 100}%` }} />
                          </div>
                          <p>Crosshair at C{slicePosition.coronal + 1} / S{slicePosition.sagittal + 1}</p>
                          <p className="muted">Zoom {viewportTransform.zoom.toFixed(2)}x • Pan ({viewportTransform.panX}, {viewportTransform.panY})</p>
                        </section>

                        <section className="mpr-pane mpr-pane-coronal" aria-label="Coronal pane">
                          <header>
                            <strong>Coronal</strong>
                            <span>
                              Slice {slicePosition.coronal + 1} / {mprDimensions.coronal}
                            </span>
                          </header>
                          <label htmlFor="coronalSlice">Coronal slice</label>
                          <input
                            id="coronalSlice"
                            data-testid="slice-slider-coronal"
                            type="range"
                            min="0"
                            max={Math.max(0, mprDimensions.coronal - 1)}
                            value={slicePosition.coronal}
                            onChange={(e) => updateSlicePosition('coronal', e.target.value, mprDimensions)}
                          />
                          <div className="mpr-crosshair-preview" aria-hidden="true">
                            <span className="line line-axial" style={{ top: `${((slicePosition.axial + 1) / mprDimensions.axial) * 100}%` }} />
                            <span className="line line-sagittal" style={{ left: `${((slicePosition.sagittal + 1) / mprDimensions.sagittal) * 100}%` }} />
                          </div>
                          <p>Crosshair at A{slicePosition.axial + 1} / S{slicePosition.sagittal + 1}</p>
                          <p className="muted">Zoom {viewportTransform.zoom.toFixed(2)}x • Pan ({viewportTransform.panX}, {viewportTransform.panY})</p>
                        </section>

                        <section className="mpr-pane mpr-pane-sagittal" aria-label="Sagittal pane">
                          <header>
                            <strong>Sagittal</strong>
                            <span>
                              Slice {slicePosition.sagittal + 1} / {mprDimensions.sagittal}
                            </span>
                          </header>
                          <label htmlFor="sagittalSlice">Sagittal slice</label>
                          <input
                            id="sagittalSlice"
                            data-testid="slice-slider-sagittal"
                            type="range"
                            min="0"
                            max={Math.max(0, mprDimensions.sagittal - 1)}
                            value={slicePosition.sagittal}
                            onChange={(e) => updateSlicePosition('sagittal', e.target.value, mprDimensions)}
                          />
                          <div className="mpr-crosshair-preview" aria-hidden="true">
                            <span className="line line-axial" style={{ top: `${((slicePosition.axial + 1) / mprDimensions.axial) * 100}%` }} />
                            <span className="line line-coronal" style={{ left: `${((slicePosition.coronal + 1) / mprDimensions.coronal) * 100}%` }} />
                          </div>
                          <p>Crosshair at A{slicePosition.axial + 1} / C{slicePosition.coronal + 1}</p>
                          <p className="muted">Zoom {viewportTransform.zoom.toFixed(2)}x • Pan ({viewportTransform.panX}, {viewportTransform.panY})</p>
                        </section>

                        <section className="mpr-pane mpr-pane-3d" aria-label="3D orientation pane">
                          <header>
                            <strong>3D Orientation</strong>
                            <span>Locator</span>
                          </header>
                          <p data-testid="mpr-locator">
                            A{slicePosition.axial + 1} • C{slicePosition.coronal + 1} • S{slicePosition.sagittal + 1}
                          </p>
                          <div className="mpr-legend">
                            <span className="chip chip-axial">Axial plane</span>
                            <span className="chip chip-coronal">Coronal plane</span>
                            <span className="chip chip-sagittal">Sagittal plane</span>
                          </div>
                          <div className="mpr-nav-controls">
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => adjustZoom(0.1)}>Zoom +</button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => adjustZoom(-0.1)}>Zoom -</button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={resetViewport}>Reset</button>
                          </div>
                          <div className="mpr-nav-controls">
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => panViewport(0, -10)}>Pan ↑</button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => panViewport(-10, 0)}>Pan ←</button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => panViewport(10, 0)}>Pan →</button>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => panViewport(0, 10)}>Pan ↓</button>
                          </div>
                          <p className="muted">
                            Plane intersections are synchronized across orthographic panes.
                          </p>
                        </section>
                      </div>
                    </div>
                  ) : (
                    <div className="view-board">
                      {getPartViews(selectedPart).map((viewName) => {
                        const imagesByView = selectedPart?.metadata?.view_images || {};
                        const imageRef = imagesByView?.[viewName];
                        return (
                          <div key={viewName} className={`view-cell ${activeViewName === viewName ? 'selected' : ''}`}>
                            <div className="view-cell-title">{viewName.toUpperCase()}</div>
                            <div className="view-cell-body">
                              {!imageEnabled ? (
                                <span className="view-cell-empty">Image hidden</span>
                              ) : imageRef ? (
                                <span className="view-cell-has-data">Mapped: {imageRef}</span>
                              ) : (
                                <span className="view-cell-empty">No image mapped</span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

export default InspectionWorkbenchPanel;
