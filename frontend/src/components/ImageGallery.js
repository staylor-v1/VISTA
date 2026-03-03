import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import GalleryListView from './GalleryListView';
import GalleryGridView from './GalleryGridView';
import GalleryDebugPanel from './GalleryDebugPanel';
import BulkDeleteModal from './BulkDeleteModal';
import BulkMetadataModal from './BulkMetadataModal';

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
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);
  const [showBulkMetaModal, setShowBulkMetaModal] = useState(false);

  const imagesPerPage = viewMode === 'small' ? 100 : viewMode === 'medium' ? 50 : viewMode === 'large' ? 25 : 200;

  const filteredImages = images
    .filter(image => {
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
          const meta = image.metadata || image.metadata_;
          if (!meta) return false;
          return Object.values(meta).some(value =>
            String(value).toLowerCase().includes(searchLower)
          );
        }
        default: {
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

  const totalPages = Math.ceil(filteredImages.length / imagesPerPage);
  const indexOfLastImage = currentPage * imagesPerPage;
  const indexOfFirstImage = indexOfLastImage - imagesPerPage;
  const currentImages = filteredImages.slice(indexOfFirstImage, indexOfLastImage);

  useEffect(() => {
    setCurrentPage(1);
  }, [images.length, searchValue, searchField, sortBy, viewMode]);

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

  useEffect(() => {
    if (refreshProjectImages) {
      refreshProjectImages({
        searchField: searchField,
        searchValue: searchValue
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchField, searchValue]);

  const handlePageChange = (pageNumber) => {
    setCurrentPage(pageNumber);
    const selector = viewMode === 'list' ? '.gallery-list' : '.gallery-grid';
    document.querySelector(selector)?.scrollIntoView({ behavior: 'smooth' });
  };

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
              {[
                { mode: 'small', label: 'Small thumbnails', content: 'S' },
                { mode: 'medium', label: 'Medium thumbnails', content: 'M' },
                { mode: 'large', label: 'Large thumbnails', content: 'L' },
              ].map(({ mode, label, content }) => (
                <button
                  key={mode}
                  className={`view-mode-btn ${viewMode === mode ? 'active' : ''}`}
                  onClick={() => setViewMode(mode)}
                  title={label}
                  aria-label={label}
                  aria-pressed={viewMode === mode}
                >{content}</button>
              ))}
              <button
                className={`view-mode-btn ${viewMode === 'list' ? 'active' : ''}`}
                onClick={() => setViewMode('list')}
                title="List view"
                aria-label="List view"
                aria-pressed={viewMode === 'list'}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                  <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
                </svg>
              </button>
            </div>
          </div>
          
          {selectedImages.size > 0 && (
            <div className="selection-controls">
              <button
                onClick={() => setShowBulkDeleteModal(true)}
                className="btn btn-danger btn-small"
              >
                Delete Selected ({selectedImages.size})
              </button>
              <button
                onClick={() => setShowBulkMetaModal(true)}
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

      {actionError && (
        <div className="error-banner">
          <span className="error-message">{actionError}</span>
          <button onClick={() => setActionError(null)} className="error-close">×</button>
        </div>
      )}

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
            <button onClick={() => { setSearchValue(''); setSearchField('filename'); }} className="btn btn-primary btn-small">
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
                <button onClick={() => handlePageChange(1)} disabled={currentPage === 1} className="pagination-btn">‹‹</button>
                <button onClick={() => handlePageChange(currentPage - 1)} disabled={currentPage === 1} className="pagination-btn">‹</button>
                <span className="pagination-info">Page {currentPage} of {totalPages}</span>
                <button onClick={() => handlePageChange(currentPage + 1)} disabled={currentPage === totalPages} className="pagination-btn">›</button>
                <button onClick={() => handlePageChange(totalPages)} disabled={currentPage === totalPages} className="pagination-btn">››</button>
              </div>
            )}
          </>
        )}
      </div>

      <GalleryDebugPanel images={images} imageLoadStatus={imageLoadStatus} />

      {showBulkDeleteModal && (
        <BulkDeleteModal
          projectId={projectId}
          selectedImages={selectedImages}
          onClose={() => setShowBulkDeleteModal(false)}
          onImageUpdated={onImageUpdated}
          refreshProjectImages={refreshProjectImages}
          onClearSelection={clearSelection}
        />
      )}

      {showBulkMetaModal && (
        <BulkMetadataModal
          selectedImages={selectedImages}
          onClose={() => setShowBulkMetaModal(false)}
          onImageUpdated={onImageUpdated}
          refreshProjectImages={refreshProjectImages}
          onClearSelection={clearSelection}
        />
      )}
  </div>
  );
}

export default ImageGallery;
