import React, { useEffect, useMemo, useState } from 'react';

const BATCH_STATUS_OPTIONS = [
  { value: 'not_started', label: 'Not Started' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'complete', label: 'Complete' },
];

function normalizeBatches(batches = []) {
  return (Array.isArray(batches) ? batches : []).map((batch) => ({
    ...batch,
    name: String(batch?.name || ''),
    owner: String(batch?.owner || ''),
    status: String(batch?.status || 'not_started'),
  }));
}

function summaryForParts(parts = []) {
  return parts.reduce((acc, part) => {
    acc.total += 1;
    if (part.review_state === 'pass') acc.accepted += 1;
    if (part.review_state === 'reject_pending' || part.review_state === 'reject_confirmed') acc.rejected += 1;
    if (part?.metadata?.manual_flagged === true) acc.manual += 1;
    return acc;
  }, { total: 0, accepted: 0, rejected: 0, manual: 0 });
}

function BatchesTab({ projectId, parts = [], onAssignmentsChanged, setError, onInspectBatch }) {
  const [batches, setBatches] = useState([]);
  const [movingPartId, setMovingPartId] = useState('');

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const resp = await fetch(`/api/projects/${projectId}/batches`);
        if (!resp.ok) throw new Error(`Failed to load batches (${resp.status})`);
        const payload = await resp.json();
        if (!cancelled) setBatches(normalizeBatches(payload));
      } catch (err) {
        if (!cancelled && setError) setError(err.message || 'Failed to load batches');
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [projectId, setError]);

  const partsByBatch = useMemo(() => {
    const grouped = new Map();
    grouped.set('__unbatched__', []);
    parts.forEach((part) => {
      const key = part?.batch_id || '__unbatched__';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(part);
    });
    grouped.forEach((entries) => entries.sort((a, b) => String(a.display_name || a.serial_number || '').localeCompare(String(b.display_name || b.serial_number || ''))));
    return grouped;
  }, [parts]);

  const updateBatch = async (batchId, patch) => {
    try {
      const resp = await fetch(`/api/projects/${projectId}/batches/${batchId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!resp.ok) throw new Error(`Failed to update batch (${resp.status})`);
      const updated = await resp.json();
      setBatches((prev) => prev.map((batch) => (batch.id === batchId ? normalizeBatches([updated])[0] : batch)));
      if (setError) setError(null);
    } catch (err) {
      if (setError) setError(err.message || 'Failed to update batch');
    }
  };

  const assignPartToBatch = async (partId, toBatchId) => {
    if (!partId) return;
    try {
      const resp = await fetch(`/api/projects/${projectId}/parts/batch-assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ part_id: partId, to_batch_id: toBatchId || null }),
      });
      if (!resp.ok) throw new Error(`Failed to assign part (${resp.status})`);
      if (onAssignmentsChanged) await onAssignmentsChanged();
      if (setError) setError(null);
    } catch (err) {
      if (setError) setError(err.message || 'Failed to assign batch for part');
    } finally {
      setMovingPartId('');
    }
  };

  const setManualFlag = async (partId, manualFlagged) => {
    try {
      const resp = await fetch(`/api/projects/${projectId}/parts/${partId}/manual-flag`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manual_flagged: manualFlagged }),
      });
      if (!resp.ok) throw new Error(`Failed to update manual flag (${resp.status})`);
      if (onAssignmentsChanged) await onAssignmentsChanged();
    } catch (err) {
      if (setError) setError(err.message || 'Failed to update manual flag');
    }
  };

  const renderPartChip = (part) => (
    <div
      key={part.id}
      className="image-part-chip batch-part-chip"
      draggable
      onDragStart={() => setMovingPartId(part.id)}
    >
      <div className="batch-part-chip-header">{part.display_name || part.serial_number}</div>
      <label className="batch-manual-toggle">
        <input
          type="checkbox"
          checked={part?.metadata?.manual_flagged === true}
          onChange={(event) => setManualFlag(part.id, event.target.checked)}
        />
        Manual
      </label>
    </div>
  );

  return (
    <div className="project-data-tab-panel" role="tabpanel" aria-label="Batches">
      <section className="workbench-panel">
        <header className="workbench-header">
          <div>
            <h2>Batches</h2>
            <p>Drag parts between batches to override filename-based grouping and assign unbatched parts.</p>
          </div>
        </header>

        <div className="images-to-parts-grid batches-grid">
          <div
            className="images-to-parts-column"
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => assignPartToBatch(movingPartId, null)}
            data-testid="batch-target-unbatched"
          >
            <h3>Unbatched Parts</h3>
            <div className="image-part-chip-list">
              {(partsByBatch.get('__unbatched__') || []).length === 0
                ? <p className="muted">No unbatched parts.</p>
                : (partsByBatch.get('__unbatched__') || []).map(renderPartChip)}
            </div>
          </div>

          <div className="images-to-parts-column parts-column">
            {batches.map((batch) => {
              const batchParts = partsByBatch.get(batch.id) || [];
              const summary = summaryForParts(batchParts);
              return (
                <article
                  key={batch.id}
                  className="images-to-parts-part-card batch-card"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => assignPartToBatch(movingPartId, batch.id)}
                  data-testid={`batch-target-${batch.id}`}
                >
                  <div className="batch-card-header">
                    <input
                      className="form-control"
                      aria-label={`Batch name ${batch.name}`}
                      value={batch.name}
                      onChange={(event) => {
                        const value = event.target.value;
                        setBatches((prev) => prev.map((item) => (item.id === batch.id ? { ...item, name: value } : item)));
                      }}
                      onBlur={() => updateBatch(batch.id, { name: batch.name })}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => onInspectBatch && onInspectBatch(batch)}
                    >
                      Inspect
                    </button>
                  </div>
                  <div className="batch-summary muted">
                    Parts: {summary.total} • Accepted: {summary.accepted} • Rejected: {summary.rejected} • Manual: {summary.manual}
                  </div>
                  <div className="batch-card-controls">
                    <label className="form-label">
                      Owner
                      <input
                        className="form-control"
                        value={batch.owner || ''}
                        onChange={(event) => {
                          const value = event.target.value;
                          setBatches((prev) => prev.map((item) => (item.id === batch.id ? { ...item, owner: value } : item)));
                        }}
                        onBlur={() => updateBatch(batch.id, { owner: batch.owner || null })}
                      />
                    </label>
                    <label className="form-label">
                      Status
                      <select
                        className="form-control"
                        value={batch.status || 'not_started'}
                        onChange={(event) => {
                          const value = event.target.value;
                          setBatches((prev) => prev.map((item) => (item.id === batch.id ? { ...item, status: value } : item)));
                          updateBatch(batch.id, { status: value });
                        }}
                      >
                        {BATCH_STATUS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="image-part-chip-list">
                    {batchParts.length === 0 ? <p className="muted">No parts assigned.</p> : batchParts.map(renderPartChip)}
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

export default BatchesTab;
