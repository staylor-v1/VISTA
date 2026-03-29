import React, { useEffect, useMemo, useState } from 'react';

const VIEW_ORDER = ['front', 'back', 'left', 'right', 'top', 'bottom'];
const MPR_AXES = ['axial', 'coronal', 'sagittal'];
const DEFAULT_OVERLAY_LAYERS = [
  { id: 'segmentation', label: 'Segmentation', color: '#ef4444' },
  { id: 'heatmap', label: 'Heatmap', color: '#8b5cf6' },
  { id: 'voids', label: 'Voids', color: '#f59e0b' },
];
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

function getMprDimensions(part) {
  const raw = part?.metadata?.volume_shape || part?.metadata?.mpr?.volume_shape || {};
  const dimensions = MPR_AXES.reduce((acc, axis) => {
    const value = Number(raw?.[axis]);
    acc[axis] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 128;
    return acc;
  }, {});
  return dimensions;
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

  useEffect(() => {
    const loadWorkbenchData = async () => {
      try {
        setLoading(true);
        setError(null);

        const [batchResp, partResp] = await Promise.all([
          fetch(`/api/projects/${projectId}/batches`),
          fetch(`/api/projects/${projectId}/parts`),
        ]);
        if (!batchResp.ok) {
          throw new Error(`Failed to load batches (${batchResp.status})`);
        }
        if (!partResp.ok) {
          throw new Error(`Failed to load parts (${partResp.status})`);
        }

        const [batchData, partData] = await Promise.all([batchResp.json(), partResp.json()]);
        const safeBatches = Array.isArray(batchData) ? batchData : [];
        const safeParts = Array.isArray(partData) ? partData : [];
        setBatches(safeBatches);
        setParts(safeParts);
        if (safeParts.length > 0) {
          setSelectedPartId(safeParts[0].id);
        }
      } catch (err) {
        setError(err.message || 'Failed to load inspection workbench data');
      } finally {
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
  const tooltipValues = useMemo(() => {
    const axisSeed = slicePosition.axial + slicePosition.coronal + slicePosition.sagittal;
    const base = Math.min(
      255,
      Math.max(
        0,
        Math.round(((cursorProbe.x * 0.35 + cursorProbe.y * 0.65 + axisSeed) * contrastPercent) / 100),
      ),
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
    setSlicePosition({
      axial: Math.floor((mprDimensions.axial - 1) / 2),
      coronal: Math.floor((mprDimensions.coronal - 1) / 2),
      sagittal: Math.floor((mprDimensions.sagittal - 1) / 2),
    });
    setViewportTransform({ zoom: 1, panX: 0, panY: 0 });
    setContrastPercent(100);
    const defaultActive = getOverlayLayers(selectedPart)
      .slice(0, 2)
      .map((overlay) => overlay.id);
    setActiveOverlayIds(defaultActive);
    setCursorProbe({ x: 50, y: 50 });
  }, [selectedPart, projectType, mprDimensions]);

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

  return (
    <section className="workbench-panel" aria-label="Inspection Workbench">
      <div className="workbench-header">
        <h2>Project Data</h2>
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
                          <div key={viewName} className="view-cell">
                            <div className="view-cell-title">{viewName.toUpperCase()}</div>
                            <div className="view-cell-body">
                              {imageRef ? (
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
