import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import GalleryListView from './GalleryListView';
import GalleryGridView from './GalleryGridView';
import GalleryDebugPanel from './GalleryDebugPanel';

function ImageGallery({ projectId, images, loading, onImageUpdated, refreshProjectImages }) {
  const navigate = useNavigate();
  const [imageLoadStatus, setImageLoadStatus] = useState({});
  const [currentPage, setCurrentPage] = useState(1);
  const [viewMode, setViewMode] = useState('medium'); // small, medium, large, list
  const [sortBy, setSortBy] = useState('date'); // date, name, size
  const [searchField, setSearchField] = useState('filename'); // 'filename', 'content_type', 'uploaded_by', 'metadata', or specific key
  const [searchValue, setSearchValue] = useState('');
  const [availableMetadataKeys, setAvailableMetadataKeys] = useState([]);
  const [selectedImages, setSelectedImages] = useState(new Set());
  const [lastSelectedId, setLastSelectedId] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [reviewStatuses, setReviewStatuses] = useState({});
  const [reviewFilter, setReviewFilter] = useState('all'); // all, unreviewed, pass, reject_pending, reject_confirmed

  // Bulk delete modal state
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);
  const [bulkDeleteReason, setBulkDeleteReason] = useState('');
  const [bulkDeleteForce, setBulkDeleteForce] = useState(false);
  const [bulkDeleteSubmitting, setBulkDeleteSubmitting] = useState(false);
  const [bulkDeleteError, setBulkDeleteError] = useState(null);

  // Bulk metadata modal state
  const [showBulkMetaModal, setShowBulkMetaModal] = useState(false);
  const [bulkMetaKey, setBulkMetaKey] = useState('');
  const [bulkMetaValue, setBulkMetaValue] = useState('');
  const [bulkMetaSubmitting, setBulkMetaSubmitting] = useState(false);
  const [bulkMetaError, setBulkMetaError] = useState(null);

  const MIN_DELETE_REASON = 5;

  const imagesPerPage = viewMode === 'small' ? 100 : viewMode === 'medium' ? 50 : viewMode === 'large' ? 25 : 200;
  
  // Filter and sort images
  const filteredImages = images
    .filter(image => {
      // Review status filter
      if (reviewFilter !== 'all') {
        const imgStatus = reviewStatuses[image.id] || 'unreviewed';
        if (imgStatus !== reviewFilter) return false;
      }
      if (!searchValue) return true;

      const searchLower = searchValue.toLowerCase();
      
      switch (searchField) {
        case 'filename':
          return (image.filename || '').toLowerCase().includes(searchLower);
        case 'content_type':
          return (image.content_type || '').toLowerCase().includes(searchLower);
        case 'uploaded_by':
          return (image.uploaded_by_user_id || '').toLowerCase().includes(searchLower);
        case 'metadata': {
          // Search across all metadata values
          const meta = image.metadata || image.metadata_;
          if (!meta) return false;
          return Object.values(meta).some(value =>
            String(value).toLowerCase().includes(searchLower)
          );
        }
        default: {
          // Search specific metadata key
          const meta = image.metadata || image.metadata_;
          if (!meta || !meta[searchField]) return false;
          return String(meta[searchField]).toLowerCase().includes(searchLower);
        }
      }
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return (a.filename || '').localeCompare(b.filename || '');
        case 'size':
          return (b.size_bytes || 0) - (a.size_bytes || 0);
        case 'date':
        default:
          return new Date(b.created_at || 0) - new Date(a.created_at || 0);
      }
    });
  
  // Calculate total pages
  const totalPages = Math.ceil(filteredImages.length / imagesPerPage);
  
  // Get current images for the page
  const indexOfLastImage = currentPage * imagesPerPage;
  const indexOfFirstImage = indexOfLastImage - imagesPerPage;
  const currentImages = filteredImages.slice(indexOfFirstImage, indexOfLastImage);
  
  // Reset to first page when images, filters, or view mode changes
  useEffect(() => {
    setCurrentPage(1);
  }, [images.length, searchValue, searchField, sortBy, viewMode]);
  
  // Collect available metadata keys (excluding internal 'measurements' key)
  useEffect(() => {
    const keys = new Set();
    images.forEach(image => {
      const meta = image.metadata || image.metadata_;
      if (meta) {
        Object.keys(meta).forEach(key => {
          if (key !== 'measurements') keys.add(key);
        });
      }
    });
    setAvailableMetadataKeys(Array.from(keys).sort());
  }, [images]);
  
  // Fetch review statuses for all images in the project
  const loadReviewStatuses = useCallback(async () => {
    if (!projectId) return;
    try {
      const response = await fetch(`/api/projects/${projectId}/image-review-statuses`);
      if (response.ok) {
        const data = await response.json();
        setReviewStatuses(data);
      }
    } catch (err) {
      console.error('Failed to load review statuses:', err);
    }
  }, [projectId]);

  useEffect(() => {
    loadReviewStatuses();
  }, [loadReviewStatuses]);

  // Fetch images when search parameters change
  useEffect(() => {
    if (refreshProjectImages) {
      refreshProjectImages({
        searchField: searchField,
        searchValue: searchValue
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchField, searchValue]);
  
  // Page change handler
  const handlePageChange = (pageNumber) => {
    setCurrentPage(pageNumber);
    const selector = viewMode === 'list' ? '.gallery-list' : '.gallery-grid';
    document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth' });
  };
  
  // Image selection handlers
  const handleImageSelection = (imageId, event) => {
    if (event && event.shiftKey && lastSelectedId !== null) {
      const lastIndex = currentImages.findIndex(img => img.id === lastSelectedId);
      const currentIndex = currentImages.findIndex(img => img.id === imageId);
      if (lastIndex >= 0 && currentIndex >= 0) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        const newSelected = new Set(selectedImages);
        for (let i = start; i <= end; i++) {
          newSelected.add(currentImages[i].id);
        }
        setSelectedImages(newSelected);
        return;
      }
    }
    const newSelected = new Set(selectedImages);
    if (newSelected.has(imageId)) {
      newSelected.delete(imageId);
    } else {
      newSelected.add(imageId);
    }
    setSelectedImages(newSelected);
    setLastSelectedId(imageId);
  };

  const selectAllImages = () => {
    setSelectedImages(new Set(currentImages.map(img => img.id)));
  };

  const clearSelection = () => {
    setSelectedImages(new Set());
    setLastSelectedId(null);
  };

  const handleBulkDelete = async () => {
    if (bulkDeleteReason.trim().length < MIN_DELETE_REASON) {
      setBulkDeleteError(`Reason must be at least ${MIN_DELETE_REASON} characters`);
      return;
    }
    setBulkDeleteSubmitting(true);
    setBulkDeleteError(null);
    const ids = Array.from(selectedImages);
    const results = await Promise.allSettled(
      ids.map(imageId =>
        fetch(`/api/projects/${projectId}/images/${imageId}`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: bulkDeleteReason.trim(), force: bulkDeleteForce }),
        }).then(resp => {
          if (!resp.ok) return resp.text().then(t => { throw new Error(t); });
          return resp.json();
        })
      )
    );
    setBulkDeleteSubmitting(false);
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
      setBulkDeleteError(`${failed.length} deletion(s) failed. Succeeded: ${results.length - failed.length}`);
    } else {
      results.forEach(r => { if (r.status === 'fulfilled' && onImageUpdated) onImageUpdated(r.value); });
      if (refreshProjectImages) refreshProjectImages();
      setShowBulkDeleteModal(false);
      setBulkDeleteReason('');
      setBulkDeleteForce(false);
      clearSelection();
    }
  };

  const handleBulkMetadata = async () => {
    if (bulkMetaKey.trim() === '') {
      setBulkMetaError('Metadata key cannot be empty');
      return;
    }
    // Attempt to parse as JSON; non-JSON values (including plain strings) are used as-is
    let parsedValue = bulkMetaValue;
    try {
      parsedValue = JSON.parse(bulkMetaValue);
    } catch {
      // treat as plain string
    }
    setBulkMetaSubmitting(true);
    setBulkMetaError(null);
    const ids = Array.from(selectedImages);
    const results = await Promise.allSettled(
      ids.map(imageId =>
        fetch(`/api/images/${imageId}/metadata`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: bulkMetaKey.trim(), value: parsedValue }),
        }).then(resp => {
          if (!resp.ok) return resp.text().then(t => { throw new Error(t); });
          return resp.json();
        })
      )
    );
    setBulkMetaSubmitting(false);
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
      setBulkMetaError(`${failed.length} update(s) failed. Succeeded: ${results.length - failed.length}`);
    } else {
      results.forEach(r => { if (r.status === 'fulfilled' && onImageUpdated) onImageUpdated(r.value); });
      if (refreshProjectImages) refreshProjectImages();
      setShowBulkMetaModal(false);
      setBulkMetaKey('');
      setBulkMetaValue('');
      clearSelection();
    }
  };

  const handleRestore = async (image) => {
    try {
      const resp = await fetch(`/api/projects/${projectId}/images/${image.id}/restore`, { method: 'POST' });
      if (!resp.ok) {
        const detail = await resp.text();
        throw new Error(`Restore failed (${resp.status}): ${detail}`);
      }
      const data = await resp.json();
      if (onImageUpdated) onImageUpdated(data);
      if (refreshProjectImages) refreshProjectImages();
    } catch (e) {
      setActionError(e.message);
    }
  };

  return (
    <div className="modern-gallery">
      {/* Gallery Header with Controls */}
      <div className="gallery-header">
        <div className="gallery-title-section">
          <h1 className="gallery-title">Images</h1>
          <div className="gallery-stats">
            <span className="image-count">
              {filteredImages.length} {filteredImages.length === 1 ? 'image' : 'images'}
              {searchValue && ` found for "${searchValue}" in ${searchField}`}
            </span>
            {selectedImages.size > 0 && (
              <span className="selection-count">
                {selectedImages.size} selected
              </span>
            )}
          </div>
        </div>
        
        <div className="gallery-controls">
          <div className="search-control">
            <select 
              value={searchField} 
              onChange={(e) => setSearchField(e.target.value)}
              className="search-field-select"
            >
              <option value="filename">Filename</option>
              <option value="content_type">Content Type</option>
              <option value="uploaded_by">Uploaded By</option>
              <option value="metadata">All Metadata</option>
              {availableMetadataKeys.map(key => (
                <option key={key} value={key}>{key}</option>
              ))}
            </select>
            <input
              type="text"
              placeholder={`Search by ${searchField}...`}
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              className="search-input"
            />
          </div>
          
          <div className="view-controls">
            <select
              value={reviewFilter}
              onChange={(e) => setReviewFilter(e.target.value)}
              className="sort-select"
              title="Filter by review status"
            >
              <option value="all">All Statuses</option>
              <option value="unreviewed">Unreviewed</option>
              <option value="pass">Pass</option>
              <option value="reject_pending">Reject (Pending)</option>
              <option value="reject_confirmed">Reject (Confirmed)</option>
            </select>

            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="sort-select"
            >
              <option value="date">Sort by Date</option>
              <option value="name">Sort by Name</option>
              <option value="size">Sort by Size</option>
            </select>
            
            <div className="view-mode-buttons">
              <button
                className={`view-mode-btn ${viewMode === 'small' ? 'active' : ''}`}
                onClick={() => setViewMode('small')}
                title="Small thumbnails"
                aria-label="Small thumbnails"
                aria-pressed={viewMode === 'small'}
              >
                S
              </button>
              <button
                className={`view-mode-btn ${viewMode === 'medium' ? 'active' : ''}`}
                onClick={() => setViewMode('medium')}
                title="Medium thumbnails"
                aria-label="Medium thumbnails"
                aria-pressed={viewMode === 'medium'}
              >
                M
              </button>
              <button
                className={`view-mode-btn ${viewMode === 'large' ? 'active' : ''}`}
                onClick={() => setViewMode('large')}
                title="Large thumbnails"
                aria-label="Large thumbnails"
                aria-pressed={viewMode === 'large'}
              >
                L
              </button>
              <button
                className={`view-mode-btn ${viewMode === 'list' ? 'active' : ''}`}
                onClick={() => setViewMode('list')}
                title="List view"
                aria-label="List view"
                aria-pressed={viewMode === 'list'}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="8" y1="6" x2="21" y2="6"/>
                  <line x1="8" y1="12" x2="21" y2="12"/>
                  <line x1="8" y1="18" x2="21" y2="18"/>
                  <line x1="3" y1="6" x2="3.01" y2="6"/>
                  <line x1="3" y1="12" x2="3.01" y2="12"/>
                  <line x1="3" y1="18" x2="3.01" y2="18"/>
                </svg>
              </button>
            </div>
          </div>
          
          {selectedImages.size > 0 && (
            <div className="selection-controls">
              <button
                onClick={() => { setBulkDeleteReason(''); setBulkDeleteForce(false); setBulkDeleteError(null); setShowBulkDeleteModal(true); }}
                className="btn btn-danger btn-small"
              >
                Delete Selected ({selectedImages.size})
              </button>
              <button
                onClick={() => { setBulkMetaKey(''); setBulkMetaValue(''); setBulkMetaError(null); setShowBulkMetaModal(true); }}
                className="btn btn-secondary btn-small"
              >
                Add Metadata to Selected
              </button>
              <button onClick={clearSelection} className="btn btn-secondary btn-small">
                Clear Selection
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Error Display */}
      {actionError && (
        <div className="error-banner">
          <span className="error-message">{actionError}</span>
          <button onClick={() => setActionError(null)} className="error-close">×</button>
        </div>
      )}

      {/* Gallery Content */}
      <div className="gallery-content">
        {loading && (
          <div className="gallery-loading">
            <div className="spinner"></div>
            <p>Loading images...</p>
          </div>
        )}
        
        {!loading && images.length === 0 && (
          <div className="gallery-empty">
            <div className="empty-icon">+</div>
            <h3>No images yet</h3>
            <p>Upload your first image to get started</p>
          </div>
        )}
        
        {!loading && filteredImages.length === 0 && images.length > 0 && (
          <div className="gallery-empty">
            <div className="empty-icon">?</div>
            <h3>No images found</h3>
            <p>Try adjusting your search terms</p>
            <button 
              onClick={() => {
                setSearchValue('');
                setSearchField('filename');
              }} 
              className="btn btn-primary btn-small"
            >
              Clear Search
            </button>
          </div>
        )}
        
        {!loading && currentImages.length > 0 && (
          <>
            <div className="gallery-pagination-info">
              <span>
                Showing {indexOfFirstImage + 1}-{Math.min(indexOfLastImage, filteredImages.length)} of {filteredImages.length} images
              </span>
              {selectedImages.size === 0 && (
                <button onClick={selectAllImages} className="btn btn-secondary btn-small">
                  Select All on Page
                </button>
              )}
            </div>
            
            {viewMode === 'list' ? (
              <GalleryListView
                images={currentImages}
                metadataKeys={availableMetadataKeys}
                selectedImages={selectedImages}
                reviewStatuses={reviewStatuses}
                onImageClick={(imageId) => navigate(`/view/${imageId}?project=${projectId}`)}
                onToggleSelection={handleImageSelection}
              />
            ) : (
              <GalleryGridView
                images={currentImages}
                viewMode={viewMode}
                selectedImages={selectedImages}
                reviewStatuses={reviewStatuses}
                onImageClick={(imageId) => navigate(`/view/${imageId}?project=${projectId}`)}
                onToggleSelection={handleImageSelection}
                onRestore={handleRestore}
                onImageLoadStatusChange={(imageId, status) => {
                  setImageLoadStatus(prev => ({ ...prev, [imageId]: status }));
                }}
              />
            )}
            
            {totalPages > 1 && (
              <div className="gallery-pagination">
                <button onClick={() => handlePageChange(1)} disabled={currentPage === 1} className="pagination-btn">
                  ‹‹
                </button>
                <button onClick={() => handlePageChange(currentPage - 1)} disabled={currentPage === 1} className="pagination-btn">
                  ‹
                </button>
                <span className="pagination-info">Page {currentPage} of {totalPages}</span>
                <button onClick={() => handlePageChange(currentPage + 1)} disabled={currentPage === totalPages} className="pagination-btn">
                  ›
                </button>
                <button onClick={() => handlePageChange(totalPages)} disabled={currentPage === totalPages} className="pagination-btn">
                  ››
                </button>
              </div>
            )}
          </>
        )}
      </div>

      <GalleryDebugPanel images={images} imageLoadStatus={imageLoadStatus} />

      {/* Bulk Delete Modal */}
      {showBulkDeleteModal && (
        <div className="modal" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3>{bulkDeleteForce ? 'Force Delete Selected Images' : 'Delete Selected Images'}</h3>
              <button className="modal-close-btn" onClick={() => setShowBulkDeleteModal(false)} aria-label="Close">&times;</button>
            </div>
            <div className="modal-body">
              <p>
                {bulkDeleteForce
                  ? `This will permanently remove ${selectedImages.size} image(s) from storage. Database records will remain for audit purposes.`
                  : `${selectedImages.size} image(s) will be soft-deleted and hidden from the default list. They can be restored until retention expires.`}
              </p>
              <div className="form-group">
                <label htmlFor="bulk-delete-reason">Reason (required)</label>
                <textarea
                  id="bulk-delete-reason"
                  rows={3}
                  value={bulkDeleteReason}
                  onChange={e => setBulkDeleteReason(e.target.value)}
                  disabled={bulkDeleteSubmitting}
                />
                <small>Min {MIN_DELETE_REASON} chars.</small>
              </div>
              <div className="form-group">
                <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={bulkDeleteForce}
                    onChange={e => setBulkDeleteForce(e.target.checked)}
                    disabled={bulkDeleteSubmitting}
                  />
                  Force delete (also remove objects from storage)
                </label>
              </div>
              {bulkDeleteError && <div className="alert alert-error">{bulkDeleteError}</div>}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowBulkDeleteModal(false)} disabled={bulkDeleteSubmitting}>Cancel</button>
              <button className="btn btn-danger" onClick={handleBulkDelete} disabled={bulkDeleteSubmitting}>
                {bulkDeleteSubmitting ? 'Deleting...' : (bulkDeleteForce ? 'Force Delete' : 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Metadata Modal */}
      {showBulkMetaModal && (
        <div className="modal" style={{ display: 'flex' }}>
          <div className="modal-content">
            <div className="modal-header">
              <h3>Add Metadata to Selected Images</h3>
              <button className="modal-close-btn" onClick={() => setShowBulkMetaModal(false)} aria-label="Close">&times;</button>
            </div>
            <div className="modal-body">
              <p>The key-value pair will be applied to all {selectedImages.size} selected image(s).</p>
              <div className="form-group">
                <label htmlFor="bulk-meta-key">Key</label>
                <input
                  type="text"
                  id="bulk-meta-key"
                  value={bulkMetaKey}
                  onChange={e => { setBulkMetaKey(e.target.value); if (bulkMetaError) setBulkMetaError(null); }}
                  placeholder="Enter metadata key"
                  disabled={bulkMetaSubmitting}
                  autoFocus
                />
              </div>
              <div className="form-group">
                <label htmlFor="bulk-meta-value">Value</label>
                <textarea
                  id="bulk-meta-value"
                  rows={3}
                  value={bulkMetaValue}
                  onChange={e => setBulkMetaValue(e.target.value)}
                  placeholder="Enter a simple value or valid JSON"
                  disabled={bulkMetaSubmitting}
                />
                <small>You can enter a simple text value or valid JSON (arrays, objects, numbers, booleans, null).</small>
              </div>
              {bulkMetaError && <div className="alert alert-error">{bulkMetaError}</div>}
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setShowBulkMetaModal(false)} disabled={bulkMetaSubmitting}>Cancel</button>
              <button className="btn btn-primary" onClick={handleBulkMetadata} disabled={bulkMetaSubmitting}>
                {bulkMetaSubmitting ? 'Applying...' : 'Apply to All Selected'}
              </button>
            </div>
          </div>
        </div>
      )}
  </div>
  );
}

export default ImageGallery;
