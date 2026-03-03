import React, { useState } from 'react';

const BATCH_SIZE = 15;

function BulkMetadataModal({ selectedImages, onClose, onImageUpdated, refreshProjectImages, onClearSelection }) {
  const [metaKey, setMetaKey] = useState('');
  const [metaValue, setMetaValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const updateMetadata = (imageId, key, value) =>
    fetch(`/api/images/${imageId}/metadata`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    }).then(resp => {
      if (!resp.ok) return resp.text().then(t => { throw new Error(t); });
      return resp.json();
    });

  const handleSubmit = async () => {
    if (metaKey.trim() === '') {
      setError('Metadata key cannot be empty');
      return;
    }

    let parsedValue = metaValue;
    try {
      parsedValue = JSON.parse(metaValue);
    } catch {
      // treat as plain string
    }

    setSubmitting(true);
    setError(null);

    const ids = Array.from(selectedImages);
    const allResults = [];

    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      const batch = ids.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(id => updateMetadata(id, metaKey.trim(), parsedValue))
      );
      allResults.push(...results);
    }

    setSubmitting(false);
    const succeeded = allResults.filter(r => r.status === 'fulfilled');
    const failed = allResults.filter(r => r.status === 'rejected');

    if (succeeded.length > 0) {
      succeeded.forEach(r => { if (onImageUpdated) onImageUpdated(r.value); });
      if (refreshProjectImages) refreshProjectImages();
    }

    if (failed.length > 0) {
      setError(`${failed.length} update(s) failed. Succeeded: ${succeeded.length}`);
    } else {
      onClose();
      onClearSelection();
    }
  };

  return (
    <div className="modal" style={{ display: 'flex' }}>
      <div className="modal-content">
        <div className="modal-header">
          <h3>Add Metadata to Selected Images</h3>
          <button className="modal-close-btn" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <div className="modal-body">
          <p>The key-value pair will be applied to all {selectedImages.size} selected image(s).</p>
          <div className="form-group">
            <label htmlFor="bulk-meta-key">Key</label>
            <input
              type="text"
              id="bulk-meta-key"
              value={metaKey}
              onChange={e => { setMetaKey(e.target.value); if (error) setError(null); }}
              placeholder="Enter metadata key"
              disabled={submitting}
              autoFocus
            />
          </div>
          <div className="form-group">
            <label htmlFor="bulk-meta-value">Value</label>
            <textarea
              id="bulk-meta-value"
              rows={3}
              value={metaValue}
              onChange={e => setMetaValue(e.target.value)}
              placeholder="Enter a simple value or valid JSON"
              disabled={submitting}
            />
            <small>You can enter a simple text value or valid JSON (arrays, objects, numbers, booleans, null).</small>
          </div>
          {error && <div className="alert alert-error">{error}</div>}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Applying...' : 'Apply to All Selected'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default BulkMetadataModal;
