import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import './App.css';

import ImageUploader from './components/ImageUploader';
import MetadataManager from './components/MetadataManager';
import ClassManager from './components/ClassManager';
import GroupedImagesPage from './components/GroupedImagesPage';
import ReviewStatusSummary from './components/ReviewStatusSummary';
import InspectionWorkbenchPanel from './components/InspectionWorkbenchPanel';
import ProjectConfigurationPanel from './components/ProjectConfigurationPanel';
import ProjectDataSummaryTab from './components/ProjectDataSummaryTab';
import ProjectReportTab from './components/ProjectReportTab';
import ProjectPhaseFlow from './components/ProjectPhaseFlow';
import { resolveCurrentProjectPhase } from './utils/projectPhases';
import { DEFAULT_INTERFACE_HIERARCHY, loadInterfaceHierarchy } from './utils/interfaceHierarchy';

const MAIN_TAB_DEFINITIONS = {
  project_configuration: { label: 'Project Configuration' },
  project_data: { label: 'Project Data' },
  inspection: { label: 'Inspection' },
  report: { label: 'Report' },
};

function Project({ currentUserGroups = [] }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [project, setProject] = useState(null);
  const [metadata, setMetadata] = useState({});
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hasGroups, setHasGroups] = useState(false);
  const [groupSearch, setGroupSearch] = useState('');
  const [projectConfiguration, setProjectConfiguration] = useState(null);
  const [interfaceHierarchy, setInterfaceHierarchy] = useState(DEFAULT_INTERFACE_HIERARCHY);
  const [activeMainTab, setActiveMainTab] = useState(DEFAULT_INTERFACE_HIERARCHY.mainTabs[0]);
  const [dataCounts, setDataCounts] = useState({
    partsLoaded: 0,
    rawImages: 0,
    imageMetadata: 0,
    overlayImages: 0,
    annotations: 0,
  });
  const [countsLoading, setCountsLoading] = useState(true);

  const fetchImages = useCallback(async (projId) => {
    const PAGE_SIZE = 200;
    let skip = 0;
    let allImages = [];
    let hasMore = true;
    while (hasMore) {
      const params = new URLSearchParams();
      params.set('skip', String(skip));
      params.set('limit', String(PAGE_SIZE));
      const resp = await fetch(`/api/projects/${projId}/images?${params}`);
      if (!resp.ok) break;
      const batch = await resp.json();
      allImages = allImages.concat(batch);
      hasMore = batch.length === PAGE_SIZE;
      skip += PAGE_SIZE;
    }
    return allImages;
  }, []);

  const refreshProjectCounts = useCallback(async () => {
    setCountsLoading(true);
    try {
      const [partsResp, bundleResp, imageResp, configResp] = await Promise.all([
        fetch(`/api/projects/${id}/parts`),
        fetch(`/api/projects/${id}/export-bundle-json`),
        fetch(`/api/projects/${id}/images?include_deleted=true&limit=2000`),
        fetch(`/api/projects/${id}/configuration`),
      ]);

      const partsPayload = partsResp.ok ? await partsResp.json() : [];
      const bundlePayload = bundleResp.ok ? await bundleResp.json() : {};
      const imagePayload = imageResp.ok ? await imageResp.json() : [];
      const configPayload = configResp.ok ? await configResp.json() : {};

      const allImages = Array.isArray(imagePayload) ? imagePayload : [];
      const activeImageCount = allImages.filter((image) => !image?.deleted_at).length;
      const imageMetadata = allImages.reduce((count, image) => {
        const metadataObj = image?.metadata;
        return count + (metadataObj && typeof metadataObj === 'object' ? Object.keys(metadataObj).length : 0);
      }, 0);
      const bundleRawImageCount = Number(bundlePayload?.bundle_summary?.images?.total) || 0;

      setProjectConfiguration(configPayload?.config || null);
      setDataCounts({
        partsLoaded: Array.isArray(partsPayload) ? partsPayload.length : 0,
        rawImages: Math.max(bundleRawImageCount, activeImageCount),
        imageMetadata,
        overlayImages: bundlePayload?.bundle_summary?.overlays?.configured_layers || 0,
        annotations: bundlePayload?.bundle_summary?.annotations?.total || 0,
      });
    } catch (err) {
      setError(err.message || 'Failed to load project summary counts');
    } finally {
      setCountsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    const fetchProjectData = async () => {
      try {
        setLoading(true);
        const projectResponse = await fetch(`/api/projects/${id}`);
        if (!projectResponse.ok) {
          throw new Error(`HTTP error! status: ${projectResponse.status}`);
        }
        const projectData = await projectResponse.json();
        setProject(projectData);

        const metadataResponse = await fetch(`/api/projects/${id}/metadata-dict`);
        if (metadataResponse.ok) {
          const metadataData = await metadataResponse.json();
          setMetadata(metadataData);
        }

        const classesResponse = await fetch(`/api/projects/${id}/classes`);
        if (classesResponse.ok) {
          const classesData = await classesResponse.json();
          setClasses(classesData);
        }

        const hasGroupsResponse = await fetch(`/api/projects/${id}/has-groups`);
        let projectHasGroups = false;
        if (hasGroupsResponse.ok) {
          const hasGroupsData = await hasGroupsResponse.json();
          projectHasGroups = hasGroupsData.has_groups;
          setHasGroups(projectHasGroups);
        }

        if (!projectHasGroups) {
          await fetchImages(id);
        }
        await refreshProjectCounts();
        setLoading(false);
      } catch (err) {
        setError(err.message);
        setLoading(false);
      }
    };

    fetchProjectData();
  }, [id, fetchImages, refreshProjectCounts]);

  useEffect(() => {
    let cancelled = false;
    let lastSerializedHierarchy = '';

    const loadHierarchy = async ({ cacheBust = false } = {}) => {
      const hierarchy = await loadInterfaceHierarchy({ cacheBust });
      if (cancelled) return;
      const validTabs = hierarchy.mainTabs.filter((tabKey) => MAIN_TAB_DEFINITIONS[tabKey]);
      const nextHierarchy = validTabs.length === 0
        ? DEFAULT_INTERFACE_HIERARCHY
        : { ...hierarchy, mainTabs: validTabs };
      const serializedHierarchy = JSON.stringify(nextHierarchy);
      if (serializedHierarchy === lastSerializedHierarchy) return;
      lastSerializedHierarchy = serializedHierarchy;

      if (validTabs.length === 0) {
        setInterfaceHierarchy(DEFAULT_INTERFACE_HIERARCHY);
        setActiveMainTab(DEFAULT_INTERFACE_HIERARCHY.mainTabs[0]);
        return;
      }
      setInterfaceHierarchy(nextHierarchy);
      setActiveMainTab((prev) => (validTabs.includes(prev) ? prev : validTabs[0]));
    };
    loadHierarchy();

    const pollMs = Number(window.__VISTA_INTERFACE_HIERARCHY_POLL_MS || 1500);
    const shouldPollHierarchy = process.env.NODE_ENV === 'development' && Number.isFinite(pollMs) && pollMs > 0;
    const intervalId = shouldPollHierarchy
      ? window.setInterval(() => loadHierarchy({ cacheBust: true }), pollMs)
      : null;

    return () => {
      cancelled = true;
      if (intervalId) window.clearInterval(intervalId);
    };
  }, []);

  const handleUploadComplete = useCallback(async () => {
    await refreshProjectCounts();
    try {
      const resp = await fetch(`/api/projects/${id}/has-groups`);
      if (resp.ok) {
        const data = await resp.json();
        setHasGroups(data.has_groups);
      }
    } catch (_) {}
  }, [id, refreshProjectCounts]);

  const currentPhase = resolveCurrentProjectPhase({
    phaseSettings: projectConfiguration?.phase_settings,
    partsLoaded: dataCounts.partsLoaded,
    annotations: dataCounts.annotations,
  });

  const projectDataContent = useMemo(() => (
    <>
      <ProjectDataSummaryTab counts={dataCounts} loading={countsLoading} />
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
      {hasGroups && (
        <div className="gallery-section">
          <GroupedImagesPage projectId={id} projectName={project?.name} onBack={() => navigate('/')} search={groupSearch} />
        </div>
      )}

      {!project?.is_archived && (
        <div className="management-sections">
          <div className="upload-section">
            <ImageUploader projectId={id} onUploadComplete={handleUploadComplete} setError={setError} />
          </div>
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
    </>
  ), [
    classes,
    countsLoading,
    dataCounts,
    groupSearch,
    hasGroups,
    id,
    loading,
    metadata,
    navigate,
    handleUploadComplete,
    project?.is_archived,
    project?.name,
  ]);

  const renderMainPanel = () => {
    if (activeMainTab === 'inspection') {
      return (
        <InspectionWorkbenchPanel
          projectId={id}
          projectType={project?.project_type}
          hierarchy={interfaceHierarchy.inspection}
        />
      );
    }
    if (activeMainTab === 'project_data') {
      return projectDataContent;
    }
    if (activeMainTab === 'project_configuration') {
      return (
        <ProjectConfigurationPanel
          projectId={id}
          projectType={project?.project_type}
          currentInterfaceLayout={interfaceHierarchy}
          isAdminUser={currentUserGroups.includes('admin') || currentUserGroups.includes('admins')}
          onConfigurationSaved={(nextConfig) => setProjectConfiguration(nextConfig)}
        />
      );
    }
    if (activeMainTab === 'report') {
      return <ProjectReportTab projectId={id} projectName={project?.name} setError={setError} />;
    }
    return null;
  };

  return (
    <div className="App">
      <header className="project-header">
        <div className="project-header-content">
          <div className="project-nav">
            <button className="back-btn" onClick={() => navigate('/')}>
              <span className="back-icon">←</span>
              <span>Back to Dashboard</span>
            </button>
          </div>
          <div className="project-info">
            <h1 className="project-title">{project ? project.name : 'Loading project...'}</h1>
            <div className="project-meta">
              <span className="project-group">Type: {project?.project_type || 'PT1'}</span>
            </div>
            <ProjectPhaseFlow currentPhase={currentPhase} />
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
          <div className="project-content project-main-tab-shell">
            <div className="project-tabs project-main-tabs" role="tablist" aria-label="Project sections">
              {interfaceHierarchy.mainTabs.map((tabKey) => (
                <button
                  key={tabKey}
                  type="button"
                  className={`project-tab ${activeMainTab === tabKey ? 'active' : ''}`}
                  role="tab"
                  aria-selected={activeMainTab === tabKey}
                  onClick={() => setActiveMainTab(tabKey)}
                >
                  {MAIN_TAB_DEFINITIONS[tabKey]?.label || tabKey}
                </button>
              ))}
            </div>
            <section className="project-main-panel" aria-label="Selected project section">
              {renderMainPanel()}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

export default Project;
