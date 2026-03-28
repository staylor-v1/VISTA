import React, { useEffect, useMemo, useState } from 'react';

const VIEW_ORDER = ['front', 'back', 'left', 'right', 'top', 'bottom'];
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

  useEffect(() => {
    if (selectedPart && selectedPart.id !== selectedPartId) {
      setSelectedPartId(selectedPart.id);
    }
  }, [selectedPart, selectedPartId]);

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
