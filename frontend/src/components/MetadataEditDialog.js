import React, { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

function MetadataEditDialog({
  isOpen,
  onClose,
  onSave,
  initialKey,
  initialValue,
  isLoading
}) {
  const [metadataKey, setMetadataKey] = useState('');
  const [metadataValue, setMetadataValue] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isOpen) {
      setMetadataKey(initialKey || '');
      setMetadataValue(initialValue || '');
      setError(null);
    }
  }, [isOpen, initialKey, initialValue]);

  const handleSave = useCallback(() => {
    if (metadataKey.trim() === '') {
      setError('Metadata key cannot be empty');
      return;
    }
    onSave(metadataKey, metadataValue);
  }, [metadataKey, metadataValue, onSave]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, handleKeyDown]);

  if (!isOpen) return null;

  const isNewMetadata = !initialKey;

  return createPortal(
    <div className="modal" onClick={onClose}>
      <div
        className="modal-content edit-metadata-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{isNewMetadata ? 'Add Metadata' : 'Edit Metadata'}</h3>
          <button
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close dialog"
          >
            &times;
          </button>
        </div>

        <div className="modal-body">
          {error && (
            <div className="error-message" style={{ marginBottom: '16px' }}>
              {error}
            </div>
          )}

          <div className="form-group">
            <label htmlFor="metadata-edit-key">Key</label>
            <input
              type="text"
              id="metadata-edit-key"
              value={metadataKey}
              onChange={(e) => {
                setMetadataKey(e.target.value);
                if (error) setError(null);
              }}
              placeholder="Enter metadata key"
              autoFocus
              disabled={isLoading}
            />
          </div>

          <div className="form-group">
            <label htmlFor="metadata-edit-value">Value</label>
            <textarea
              id="metadata-edit-value"
              className="metadata-edit-textarea"
              value={metadataValue}
              onChange={(e) => setMetadataValue(e.target.value)}
              placeholder="Enter a simple value or valid JSON"
              disabled={isLoading}
            />
            <span className="form-help">
              You can enter a simple text value or valid JSON (arrays, objects, numbers, booleans, null).
            </span>
          </div>
        </div>

        <div className="modal-footer">
          <button
            className="btn btn-secondary"
            onClick={onClose}
            disabled={isLoading}
          >
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSave}
            disabled={isLoading}
          >
            {isLoading ? 'Saving...' : (isNewMetadata ? 'Add' : 'Save')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export default MetadataEditDialog;
