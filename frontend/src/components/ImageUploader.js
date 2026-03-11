import React, { useState, useCallback, useRef } from 'react';
import FilenameMetadataExtractor from './FilenameMetadataExtractor';

const CONCURRENT_UPLOADS = 6;

function ImageUploader({ projectId, onUploadComplete, loading, setLoading, setError }) {
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [uploadMetadata, setUploadMetadata] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [extractorConfig, setExtractorConfig] = useState({
    isValid: true,
    hasPattern: false,
    extractMetadata: () => null,
    keys: [],
  });
  const [groupKey, setGroupKey] = useState('');
  const [uploadProgress, setUploadProgress] = useState(null);
  const cancelledRef = useRef(false);

  const handleExtractorChange = useCallback((config) => {
    setExtractorConfig(config);
    // If selected group key is no longer in the keys list, clear it
    if (groupKey && config.keys && !config.keys.includes(groupKey)) {
      setGroupKey('');
    }
  }, [groupKey]);

  // Handle file input change
  const handleFileChange = (e) => {
    if (e.target.files) {
      setSelectedFiles(Array.from(e.target.files));
    }
  };

  // Handle drag and drop events
  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files) {
      setSelectedFiles(Array.from(e.dataTransfer.files));
    }
  };

  // Handle file upload
  const handleUpload = async (e) => {
    e.preventDefault();
    
    if (selectedFiles.length === 0) {
      setError('Please select at least one file to upload.');
      return;
    }

    // Block upload when the extractor configuration is invalid.
    if (!extractorConfig.isValid) {
      setError('Filename metadata extractor has errors. Please fix them before uploading.');
      return;
    }
    
    // Validate manual metadata JSON if provided
    let manualMetadata = null;
    if (uploadMetadata.trim()) {
      try {
        manualMetadata = JSON.parse(uploadMetadata);
      } catch (err) {
        setError('Invalid JSON format for metadata.');
        return;
      }
    }
    
    setLoading(true);
    cancelledRef.current = false;
    const total = selectedFiles.length;
    setUploadProgress({ completed: 0, failed: 0, total });

    const results = [];
    let completed = 0;
    let failed = 0;

    // Upload files with bounded concurrency
    const queue = [...selectedFiles];
    const uploadOne = async () => {
      while (queue.length > 0) {
        if (cancelledRef.current) return;
        const file = queue.shift();
        if (!file) return;

        const formData = new FormData();
        formData.append('file', file);

        const extractedMetadata = extractorConfig.extractMetadata(file.name);
        const mergedMetadata = (extractedMetadata || manualMetadata)
          ? { ...(extractedMetadata || {}), ...(manualMetadata || {}) }
          : null;

        if (mergedMetadata) {
          formData.append('metadata', JSON.stringify(mergedMetadata));
        }

        if (groupKey && extractedMetadata && extractedMetadata[groupKey]) {
          formData.append('group_identifier', extractedMetadata[groupKey]);
        }

        try {
          const response = await fetch(`/api/projects/${projectId}/images`, {
            method: 'POST',
            body: formData,
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          results.push(await response.json());
        } catch (err) {
          console.error(`Error uploading ${file.name}:`, err);
          failed += 1;
        }
        completed += 1;
        setUploadProgress({ completed, failed, total });
      }
    };

    const workers = Array.from(
      { length: Math.min(CONCURRENT_UPLOADS, total) },
      () => uploadOne()
    );
    await Promise.all(workers);

    if (results.length > 0) {
      onUploadComplete(results);
    }
    if (failed > 0) {
      setError(`Upload complete: ${results.length} succeeded, ${failed} failed out of ${total}.`);
    } else {
      setError(null);
    }
    setSelectedFiles([]);
    setUploadMetadata('');
    setUploadProgress(null);
    setLoading(false);
  };

  return (
    <div className="card">
      <div className="card-header">
        <h2>Upload Images</h2>
      </div>
      <div className="card-content">
        <form onSubmit={handleUpload}>
          <div 
            className={`upload-area ${isDragOver ? 'drag-over' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => document.getElementById('file-input').click()}
          >
            <div className="upload-area-content">
              <div className="upload-area-icon">
                +
              </div>
              <div className="upload-area-text">
                Drag and drop images here, or click to select files
              </div>
              <div className="upload-area-subtext">
                Supports multiple image files (JPG, PNG, GIF, etc.)
              </div>
              <div className={`upload-area-status ${selectedFiles.length > 0 ? 'has-files' : 'no-files'}`}>
                {selectedFiles.length > 0 
                  ? `${selectedFiles.length} ${selectedFiles.length === 1 ? 'file' : 'files'} selected` 
                  : 'No files selected'}
              </div>
            </div>
            <input 
              type="file" 
              id="file-input" 
              accept="image/*,image/tiff,.tiff,.tif" 
              multiple 
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </div>

          <FilenameMetadataExtractor
            files={selectedFiles}
            onConfigChange={handleExtractorChange}
          />

          {extractorConfig.keys && extractorConfig.keys.length > 0 && (
            <div className="form-group">
              <label htmlFor="group-key-select">Use as Group Identifier (Optional)</label>
              <select
                id="group-key-select"
                value={groupKey}
                onChange={(e) => setGroupKey(e.target.value)}
                className="form-control"
              >
                <option value="">-- None --</option>
                {extractorConfig.keys.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
              <small className="form-text">
                Select which extracted key to use as the group identifier for each uploaded image.
              </small>
            </div>
          )}
          
          <div className="form-group">
            <label htmlFor="metadata-input">Metadata (Optional JSON)</label>
            <textarea 
              id="metadata-input" 
              rows="3" 
              placeholder='{"key": "value"}'
              value={uploadMetadata}
              onChange={(e) => setUploadMetadata(e.target.value)}
            ></textarea>
          </div>
          
          <div className="form-group">
            <button
              type="submit"
              className="btn btn-success"
              disabled={loading || !extractorConfig.isValid}
            >
              {loading ? 'Uploading...' : 'Upload Images'}
            </button>
            {loading && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ marginLeft: '8px' }}
                onClick={() => { cancelledRef.current = true; }}
              >
                Cancel
              </button>
            )}
          </div>
          {uploadProgress && (
            <div style={{ marginTop: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '4px' }}>
                <span>{uploadProgress.completed} / {uploadProgress.total} uploaded</span>
                {uploadProgress.failed > 0 && (
                  <span style={{ color: '#dc3545' }}>{uploadProgress.failed} failed</span>
                )}
              </div>
              <div style={{ width: '100%', height: '8px', backgroundColor: '#e9ecef', borderRadius: '4px', overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${Math.round((uploadProgress.completed / uploadProgress.total) * 100)}%`,
                    height: '100%',
                    backgroundColor: uploadProgress.failed > 0 ? '#ffc107' : '#28a745',
                    transition: 'width 0.2s',
                  }}
                />
              </div>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

export default ImageUploader;
