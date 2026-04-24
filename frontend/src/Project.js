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
  const [ingestResult, setIngestResult] = useState({
    loading: false,
    error: null,
    payload: null,
  });

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

  const requestIngestValidation = useCallback(async () => {
    try {
      setIngestResult({ loading: true, error: null, payload: null });
      const [batchResp, partResp] = await Promise.all([
        fetch(`/api/projects/${id}/batches`),
        fetch(`/api/projects/${id}/parts`),
      ]);
      if (!batchResp.ok) throw new Error(`Failed to load batches (${batchResp.status})`);
      if (!partResp.ok) throw new Error(`Failed to load parts (${partResp.status})`);

      const [batchData, partData] = await Promise.all([batchResp.json(), partResp.json()]);
      const batches = Array.isArray(batchData) ? batchData : [];
      const parts = Array.isArray(partData) ? partData : [];
      const syntheticPayload = {
        batches: batches.slice(0, 1).map((batch) => ({
          name: batch.name,
          description: `Validation run for ${batch.name}`,
          parts: parts
            .filter((part) => part.batch_id === batch.id)
            .slice(0, 3)
            .map((part) => ({
              serial_number: part.serial_number,
              display_name: part.display_name,
              review_state: part.review_state || 'unreviewed',
              metadata: {
                source: 'project-data-ingest-validation',
                existing_part_id: part.id,
              },
            })),
        })),
      };

      const resp = await fetch(`/api/projects/${id}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(syntheticPayload),
      });
      if (!resp.ok) throw new Error(`Failed to run ingest validation (${resp.status})`);
      const payload = await resp.json();
      setIngestResult({ loading: false, error: null, payload });
      await refreshProjectCounts();
    } catch (err) {
      setIngestResult({ loading: false, error: err.message || 'Failed to run ingest validation', payload: null });
    }
  }, [id, refreshProjectCounts]);

  const currentPhase = resolveCurrentProjectPhase({
    phaseSettings: projectConfiguration?.phase_settings,
    partsLoaded: dataCounts.partsLoaded,
    annotations: dataCounts.annotations,
  });

  const projectDataContent = useMemo(() => (
    <>
      {!project?.is_archived && (
        <div className="management-sections project-data-upload-first">
          <div className="upload-section">
            <ImageUploader projectId={id} onUploadComplete={handleUploadComplete} setError={setError} />
          </div>
        </div>
      )}
      <ProjectDataSummaryTab counts={dataCounts} loading={countsLoading} />
      <section className="workbench-panel project-data-action-panel" aria-label="Project data validation">
        <header className="workbench-header">
          <div>
            <h2>Data Validation</h2>
            <p>Run a synthetic ingest pass against the current batch and part structure.</p>
          </div>
          <div className="workbench-detail-actions">
            <button
              type="button"
              className="btn btn-secondary"
              data-testid="request-ingest-validation"
              disabled={ingestResult.loading}
              onClick={requestIngestValidation}
            >
              {ingestResult.loading ? 'Running Ingest Validation...' : 'Run Ingest Validation'}
            </button>
          </div>
        </header>
        {ingestResult.error && <div className="alert alert-error">{ingestResult.error}</div>}
        {ingestResult.payload && (
          <div className="alert alert-success" data-testid="ingest-validation-result">
            Ingest validation complete: created {ingestResult.payload?.counters?.parts_created || 0} parts, skipped{' '}
            {ingestResult.payload?.counters?.parts_skipped_existing || 0} existing, discrepancies{' '}
            {(ingestResult.payload?.discrepancies || []).length}.
          </div>
        )}
      </section>
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
    ingestResult,
    project?.is_archived,
    project?.name,
    requestIngestValidation,
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

  const renderMainTabs = (className = '') => (
    <div className={`project-tabs project-main-tabs ${className}`.trim()} role="tablist" aria-label="Project sections">
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
  );

  return (
    <div className="App">
      <header className="project-header">
        <div className="project-header-content">
          <div className="project-header-top">
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
            </div>
          </div>
          <div className="project-header-bottom">
            {!loading && renderMainTabs('project-header-tabs')}
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
