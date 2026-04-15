import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import './App.css';

// Import components
import ImageUploader from './components/ImageUploader';
import MetadataManager from './components/MetadataManager';
import ClassManager from './components/ClassManager';
import ImageGallery from './components/ImageGallery';
import GroupedImagesPage from './components/GroupedImagesPage';
import ReviewStatusSummary from './components/ReviewStatusSummary';
import InspectionWorkbenchPanel from './components/InspectionWorkbenchPanel';
import ProjectConfigurationPanel from './components/ProjectConfigurationPanel';
import { downloadExcel } from './utils/downloadExcel';

function Project() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [images, setImages] = useState([]);
  const [metadata, setMetadata] = useState({});
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [deletedOnly, setDeletedOnly] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [hasGroups, setHasGroups] = useState(false);
  const [groupSearch, setGroupSearch] = useState('');
  const [activeTab, setActiveTab] = useState('inspection');

  const fetchImages = useCallback(async (projId, opts = {}) => {
    const inc = opts.includeDeleted ?? includeDeleted;
    const delOnly = opts.deletedOnly ?? deletedOnly;
    const searchField = opts.searchField;
    const searchValue = opts.searchValue;
    const baseParams = new URLSearchParams();
    if (delOnly) {
      baseParams.set('deleted_only', 'true');
    } else if (inc) {
      baseParams.set('include_deleted', 'true');
    }
    if (searchField && searchValue) {
      baseParams.set('search_field', searchField);
      baseParams.set('search_value', searchValue);
    }
    const PAGE_SIZE = 200;
    let skip = 0;
    let allImages = [];
    let hasMore = true;
    while (hasMore) {
      const params = new URLSearchParams(baseParams);
      params.set('skip', String(skip));
      params.set('limit', String(PAGE_SIZE));
      const resp = await fetch(`/api/projects/${projId}/images?${params}`);
      if (!resp.ok) break;
      const batch = await resp.json();
      allImages = allImages.concat(batch);
      hasMore = batch.length === PAGE_SIZE;
      skip += PAGE_SIZE;
    }
    setImages(allImages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Load project data, metadata, classes, and images
    const fetchProjectData = async () => {
      try {
        setLoading(true);
        
        // Fetch project details
        const projectResponse = await fetch(`/api/projects/${id}`);
        if (!projectResponse.ok) {
          throw new Error(`HTTP error! status: ${projectResponse.status}`);
        }
        const projectData = await projectResponse.json();
        setProject(projectData);
        
        // Fetch project metadata
        const metadataResponse = await fetch(`/api/projects/${id}/metadata-dict`);
        if (metadataResponse.ok) {
          const metadataData = await metadataResponse.json();
          setMetadata(metadataData);
        }
        
        // Fetch project classes
        const classesResponse = await fetch(`/api/projects/${id}/classes`);
        if (classesResponse.ok) {
          const classesData = await classesResponse.json();
          setClasses(classesData);
        }

        // Check if project has groups
        const hasGroupsResponse = await fetch(`/api/projects/${id}/has-groups`);
        let projectHasGroups = false;
        if (hasGroupsResponse.ok) {
          const hasGroupsData = await hasGroupsResponse.json();
          projectHasGroups = hasGroupsData.has_groups;
          setHasGroups(projectHasGroups);
        }

        // Only fetch the flat image list when the grouped view is not active.
        // When hasGroups is true, the GroupedImagesPage fetches its own data.
        if (!projectHasGroups) {
          await fetchImages(id);
        }
        
        setLoading(false);
      } catch (err) {
        console.error("Failed to fetch project data:", err);
        setError(err.message);
        setLoading(false);
      }
    };

    fetchProjectData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Refetch when deletion visibility changes, but only in the flat (non-grouped) view
  useEffect(() => {
    if (project && !hasGroups) {
      fetchImages(project.id, { includeDeleted, deletedOnly });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeDeleted, deletedOnly, project?.id, hasGroups]);

  // Handle image upload completion
  const handleUploadComplete = async (newImages) => {
    setImages(prevImages => [...prevImages, ...newImages]);
    // Re-check whether the project now has groups (upload may have created one)
    try {
      const resp = await fetch(`/api/projects/${id}/has-groups`);
      if (resp.ok) {
        const data = await resp.json();
        setHasGroups(data.has_groups);
        if (data.has_groups) {
          window.scrollTo(0, 0);
        }
      }
    } catch (_) {}
  };

  const handleImageStateUpdate = (updatedImage) => {
    setImages(prev => {
      const idx = prev.findIndex(i => i.id === updatedImage.id);
      if (idx === -1) return prev;
      const copy = [...prev];
      // If image became deleted and we are NOT including deleted, remove from list
      if (updatedImage.deleted_at && !includeDeleted && !deletedOnly) {
        copy.splice(idx, 1);
        return copy;
      }
      copy[idx] = updatedImage;
      return copy;
    });
  };

  const handleExportExcel = async () => {
    setExporting(true);
    setError(null);
    try {
      await downloadExcel(id, project?.name);
    } catch (err) {
      console.error('Excel export failed:', err);
      setError(`Export failed: ${err.message}`);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="App">
      <header className="project-header">
        <div className="project-header-content">
          <div className="project-nav">
            <button
              className="back-btn"
              onClick={() => navigate('/')}
            >
              <span className="back-icon">←</span>
              <span>Back to Dashboard</span>
            </button>
          </div>
          <div className="project-info">
            <h1 className="project-title">{project ? project.name : 'Loading project...'}</h1>
            <div className="project-meta">
              <span className="project-group">Type: {project?.project_type || 'PT1'}</span>
            </div>
          </div>
        </div>
      </header>

      <div className="project-container">

        {error && (
          <div className="alert alert-error">
            <strong>Error:</strong> {error}
          </div>
        )}
        
        {loading && (
          <div className="loading-container">
            <div className="spinner"></div>
            <div className="loading-text">Loading project data...</div>
          </div>
        )}
        
        {!loading && (
          <div className="project-content">
            {project?.is_archived && (
              <div className="archived-project-notice">
                <strong>This project is archived.</strong> It is read-only. Unarchive it from the dashboard to make changes.
              </div>
            )}
            <div className="project-tabs" role="tablist" aria-label="Project sections">
              <button
                className={`project-tab ${activeTab === 'inspection' ? 'active' : ''}`}
                onClick={() => setActiveTab('inspection')}
                role="tab"
                aria-selected={activeTab === 'inspection'}
              >
                Inspection
              </button>
              <button
                className={`project-tab ${activeTab === 'project-data' ? 'active' : ''}`}
                onClick={() => setActiveTab('project-data')}
                role="tab"
                aria-selected={activeTab === 'project-data'}
              >
                Project Data
              </button>
              <button
                className={`project-tab ${activeTab === 'project-configuration' ? 'active' : ''}`}
                onClick={() => setActiveTab('project-configuration')}
                role="tab"
                aria-selected={activeTab === 'project-configuration'}
              >
                Project Configuration
              </button>
            </div>

            {activeTab === 'inspection' ? (
              <InspectionWorkbenchPanel projectId={id} projectType={project?.project_type} />
            ) : activeTab === 'project-configuration' ? (
              <ProjectConfigurationPanel projectId={id} />
            ) : (
              <>
            <div className="project-actions" style={{ marginTop: '-16px', marginBottom: '8px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary"
                onClick={handleExportExcel}
                disabled={exporting || loading}
                title="Export all project image data to Microsoft Excel"
              >
                {exporting ? 'Exporting...' : 'Export Data'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => navigate(`/project/${id}/report`)}
                disabled={loading}
                title="View detailed project report"
              >
                View Report
              </button>
            </div>

            {/* Review Status Summary + group search */}
            <div className="review-summary-row">
              <ReviewStatusSummary projectId={id} />
              {hasGroups && (
                <input
                  type="text"
                  className="search-input group-search-inline"
                  placeholder="Search groups..."
                  value={groupSearch}
                  onChange={(e) => setGroupSearch(e.target.value)}
                />
              )}
            </div>

            {/* Main Gallery Section - grouped or flat */}
            {hasGroups ? (
              <div className="gallery-section">
                <GroupedImagesPage
                  projectId={id}
                  projectName={project?.name}
                  onBack={() => navigate('/')}
                  search={groupSearch}
                />
              </div>
            ) : (
              <div className="gallery-section">
                <ImageGallery
                  projectId={id}
                  images={images}
                  loading={loading}
                  onImageUpdated={handleImageStateUpdate}
                  refreshProjectImages={(searchOpts) => fetchImages(id, searchOpts)}
                />
              </div>
            )}
            
            {/* Quick Upload Section */}
            {!project?.is_archived && (
              <div className="upload-section">
                <ImageUploader
                  projectId={id}
                  onUploadComplete={handleUploadComplete}
                  setError={setError}
                />
              </div>
            )}
            
            {/* Management Sections */}
            {!project?.is_archived && (
            <div className="management-sections">
              <div className="metadata-section">
                <MetadataManager 
                  projectId={id} 
                  metadata={metadata} 
                  setMetadata={setMetadata} 
                  loading={loading} 
                  setLoading={setLoading} 
                  setError={setError} 
                />
              </div>
              
              <div className="classes-section">
                <ClassManager 
                  projectId={id} 
                  classes={classes} 
                  setClasses={setClasses} 
                  loading={loading} 
                  setLoading={setLoading} 
                  setError={setError} 
                />
              </div>
            </div>
            )}
            
            {/* Image Deletion Controls - only relevant for the flat gallery view */}
            {!hasGroups && (
            <div className="deletion-controls-section" style={{ marginTop: '24px', padding: '16px', backgroundColor: '#f8f9fa', borderRadius: '8px', border: '1px solid #e9ecef' }}>
              <h3 style={{ margin: '0 0 12px 0', fontSize: '1.1rem', fontWeight: '600', color: '#333' }}>Image View Options</h3>
              <div style={{ display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <input 
                    type="checkbox" 
                    checked={includeDeleted} 
                    onChange={(e) => {
                      const val = e.target.checked;
                      setIncludeDeleted(val);
                      if (!val) setDeletedOnly(false);
                    }}
                  />
                  Show deleted
                </label>
                <label style={{ display: 'flex', gap: '6px', alignItems: 'center', opacity: includeDeleted ? 1 : 0.4 }}>
                  <input 
                    type="checkbox" 
                    disabled={!includeDeleted} 
                    checked={deletedOnly} 
                    onChange={(e) => setDeletedOnly(e.target.checked)}
                  />
                  Deleted only
                </label>
                <span style={{ fontSize: '0.85rem', color: '#666', fontStyle: 'italic' }}>
                  Deleted images are kept for retention; force delete removes storage object.
                </span>
              </div>
            </div>
            )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default Project;
