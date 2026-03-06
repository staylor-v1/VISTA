import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import ImageGallery from './ImageGallery';
import '../App.css';

function GroupGalleryView() {
  const { id: projectId, groupId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isUngrouped = !groupId;
  const groupIdentifier = location.state?.groupIdentifier || (isUngrouped ? 'Ungrouped' : groupId);

  const [project, setProject] = useState(null);
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchImages = useCallback(async (opts = {}) => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (isUngrouped) {
        params.set('ungrouped', 'true');
      } else {
        params.set('group_id', groupId);
      }
      if (opts.searchField && opts.searchValue) {
        params.set('search_field', opts.searchField);
        params.set('search_value', opts.searchValue);
      }
      params.set('limit', '1000');
      const resp = await fetch(`/api/projects/${projectId}/images?${params}`);
      if (resp.ok) {
        const data = await resp.json();
        setImages(data.filter(img => !img.deleted_at));
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, groupId, isUngrouped]);

  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => setProject(data))
      .catch(() => {});
    fetchImages();
  }, [projectId, fetchImages]);

  const handleImageUpdated = (updatedImage) => {
    setImages(prev => {
      const idx = prev.findIndex(i => i.id === updatedImage.id);
      if (idx === -1) return prev;
      const copy = [...prev];
      if (updatedImage.deleted_at) {
        copy.splice(idx, 1);
        return copy;
      }
      copy[idx] = updatedImage;
      return copy;
    });
  };

  return (
    <div className="App">
      <header className="project-header">
        <div className="project-header-content">
          <div className="project-nav">
            <button
              className="back-btn"
              onClick={() => navigate(`/project/${projectId}`)}
            >
              <span className="back-icon">←</span>
              <span>Back to Groups</span>
            </button>
            <div className="breadcrumb-mini">
              <span>Projects</span>
              <span className="breadcrumb-separator">›</span>
              <span
                className="breadcrumb-link"
                style={{ cursor: 'pointer', textDecoration: 'underline' }}
                onClick={() => navigate(`/project/${projectId}`)}
              >
                {project ? project.name : 'Loading...'}
              </span>
              <span className="breadcrumb-separator">›</span>
              <span className="current-project">{groupIdentifier}</span>
            </div>
          </div>
          <div className="project-info">
            <h1 className="project-title">{groupIdentifier}</h1>
            <p className="project-description">
              {project ? project.name : ''}
              {' - '}
              {isUngrouped ? 'Images not assigned to any group' : `Group: ${groupIdentifier}`}
            </p>
          </div>
        </div>
      </header>

      <div className="project-container">
        {error && (
          <div className="alert alert-error">
            <strong>Error:</strong> {error}
          </div>
        )}
        <div className="project-content">
          <div className="gallery-section">
            <ImageGallery
              projectId={projectId}
              images={images}
              loading={loading}
              onImageUpdated={handleImageUpdated}
              refreshProjectImages={(opts) => fetchImages(opts)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default GroupGalleryView;
