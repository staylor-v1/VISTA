import React, { useState } from 'react';

function GalleryDebugPanel({ images, imageLoadStatus }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="debug-section">
      <div className="debug-header" onClick={() => setExpanded(!expanded)}>
        <h4>Debug Information</h4>
        <span className="debug-toggle">{expanded ? '\u25B2' : '\u25BC'}</span>
      </div>

      {expanded && (
        <div className="debug-content">
          <div className="debug-stats">
            <p>Image loading status: {Object.keys(imageLoadStatus).length} / {images.length} images tracked</p>
          </div>

          <div className="debug-log">
            <h5>Loading Status Log:</h5>
            <div className="debug-log-list">
              {Object.entries(imageLoadStatus).map(([imageId, status]) => (
                <div key={imageId} className={`debug-log-item ${status.status}`}>
                  <span className="log-id">{imageId}</span>
                  <span className="log-status">{status.status}</span>
                  <span className="log-time">{new Date(status.timestamp).toLocaleTimeString()}</span>
                  {status.error && <div className="log-error">Error: {status.error}</div>}
                </div>
              ))}
            </div>
          </div>

          <div className="debug-actions">
            <button
              className="debug-btn"
              onClick={(e) => {
                e.stopPropagation();
                console.log('Current image load status:', imageLoadStatus);
                console.log('Images data:', images);
              }}
            >
              Log to Console
            </button>

            <button
              className="debug-btn"
              onClick={(e) => {
                e.stopPropagation();
                if (images.length === 0) {
                  console.log('No images to test');
                  return;
                }
                const testImage = images[0];
                console.log(`Testing image loading for ${testImage.id}...`);

                fetch(`/api/images/${testImage.id}/download`)
                  .then(response => response.json())
                  .then(data => console.log('Download URL data:', data))
                  .catch(err => console.error('Error testing image URLs:', err));
              }}
            >
              Test Image URLs
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default GalleryDebugPanel;
