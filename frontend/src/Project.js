import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import './App.css';

import ImageUploader from './components/ImageUploader';
import MetadataManager from './components/MetadataManager';
import ClassManager from './components/ClassManager';
import InspectionWorkbenchPanel, { buildInspectionShareParams } from './components/InspectionWorkbenchPanel';
import AnalyzeWorkbenchTab from './components/AnalyzeWorkbenchTab';
import ProjectConfigurationPanel from './components/ProjectConfigurationPanel';
import ProjectDataSummaryTab from './components/ProjectDataSummaryTab';
import ProjectDataExportPanel from './components/ProjectDataExportPanel';
import ProjectReportTab from './components/ProjectReportTab';
import ProjectPhaseFlow from './components/ProjectPhaseFlow';
import ImagesToPartsTab from './components/ImagesToPartsTab';
import BatchesTab from './components/BatchesTab';
import RemoveImagesTab from './components/RemoveImagesTab';
import OverlaysTab from './components/OverlaysTab';
import ProjectDataMetadataTab from './components/ProjectDataMetadataTab';
import { resolveCurrentProjectPhase } from './utils/projectPhases';
import { DEFAULT_INTERFACE_HIERARCHY, loadInterfaceHierarchy } from './utils/interfaceHierarchy';
import { copyCurrentShareUrl } from './utils/shareLink';
import { getProjectTypeLabel } from './projectTypes';
import { isUiSectionEnabled } from './utils/uiSections';
import { fetchProjectImagePages } from './utils/projectImages';

const MAIN_TAB_DEFINITIONS = {
  project_configuration: { label: 'Project Configuration' },
  project_data: { label: 'Project Data' },
  analyze: { label: 'Analyze' },
  inspection: { label: 'Inspection' },
  report: { label: 'Report' },
};
const ALLOWED_PROJECT_QUERY_TABS = new Set(Object.keys(MAIN_TAB_DEFINITIONS));

const PROJECT_DATA_TABS_REQUIRING_PARTS = new Set([
  'batches',
  'images_to_parts',
  'overlays',
  'metadata',
  'remove_images',
]);
const PROJECT_DATA_TABS_REQUIRING_IMAGES = new Set([
  'images_to_parts',
  'overlays',
  'remove_images',
]);

const emptyProjectDataCounts = () => ({
  partsLoaded: 0,
  rawImages: 0,
  imageMetadata: 0,
  overlayImages: 0,
  annotations: 0,
});

const isAbortError = (error) => error?.name === 'AbortError';

function mergeImagesByIdentity(currentImages, confirmedImages) {
  const next = Array.isArray(currentImages) ? [...currentImages] : [];
  const indexesById = new Map();
  next.forEach((image, index) => {
    if (image?.id !== undefined && image?.id !== null) {
      indexesById.set(String(image.id), index);
    }
  });
  (Array.isArray(confirmedImages) ? confirmedImages : []).forEach((image) => {
    if (!image || typeof image !== 'object') return;
    const id = image.id !== undefined && image.id !== null ? String(image.id) : '';
    if (id && indexesById.has(id)) {
      const index = indexesById.get(id);
      next[index] = { ...next[index], ...image };
      return;
    }
    if (id) indexesById.set(id, next.length);
    next.push(image);
  });
  return next;
}

const PROJECT_DATA_TABS = {
  load_images: { label: 'Load Images' },
  images_to_parts: { label: 'Images to Parts' },
  overlays: { label: 'Overlays' },
  metadata: { label: 'Metadata' },
  batches: { label: 'Batches' },
  remove_images: { label: 'Unload Images' },
  recently_deleted: { label: 'Recently Deleted' },
};

async function buildHttpErrorMessage(response, fallbackLabel) {
  const requestId = response.headers.get('x-request-id') || response.headers.get('x-correlation-id');
  let details = '';
  try {
    const payload = await response.clone().json();
    if (payload?.detail) details = typeof payload.detail === 'string' ? payload.detail : JSON.stringify(payload.detail);
    else if (payload?.message) details = String(payload.message);
  } catch (_) {
    try {
      const text = (await response.clone().text()).trim();
      if (text) details = text;
    } catch (_) {
      // Ignore response parse failures.
    }
  }

  return [
    `${fallbackLabel} (${response.status}${response.statusText ? ` ${response.statusText}` : ''})`,
    `endpoint=${response.url || 'unknown'}`,
    requestId ? `request_id=${requestId}` : null,
    details ? `details=${details.slice(0, 280)}` : null,
  ].filter(Boolean).join(' | ');
}

function LazyProjectDataState({ label, error, onRetry }) {
  if (error) {
    return (
      <div className="project-data-tab-panel" role="tabpanel" aria-label={label}>
        <div className="alert alert-error">{error}</div>
        <button type="button" className="btn btn-secondary" onClick={onRetry}>Retry</button>
      </div>
    );
  }
  return (
    <div className="project-data-tab-panel" role="tabpanel" aria-label={label}>
      <div className="loading-text" role="status">Loading complete project data...</div>
    </div>
  );
}

function Project({ currentUserGroups = [] }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [project, setProject] = useState(null);
  const [metadata, setMetadata] = useState({});
  const [classes, setClasses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [projectConfiguration, setProjectConfiguration] = useState(null);
  const [interfaceHierarchy, setInterfaceHierarchy] = useState(DEFAULT_INTERFACE_HIERARCHY);
  const [activeMainTab, setActiveMainTab] = useState(DEFAULT_INTERFACE_HIERARCHY.mainTabs[0]);
  const [activeProjectDataTab, setActiveProjectDataTab] = useState('load_images');
  const [activeProjectConfigurationSubtab, setActiveProjectConfigurationSubtab] = useState('general');
  const [dataCounts, setDataCounts] = useState(emptyProjectDataCounts);
  const [projectParts, setProjectParts] = useState([]);
  const [projectImages, setProjectImages] = useState([]);
  const [projectPartsState, setProjectPartsState] = useState({
    loaded: false,
    loading: false,
    stale: true,
    error: null,
  });
  const [projectImagesState, setProjectImagesState] = useState({
    loaded: false,
    loading: false,
    stale: true,
    error: null,
  });
  const [recentlyDeletedOverlays, setRecentlyDeletedOverlays] = useState([]);
  const [recentlyDeletedLoading, setRecentlyDeletedLoading] = useState(false);
  const [countsLoading, setCountsLoading] = useState(true);
  const [ingestResult, setIngestResult] = useState({
    loading: false,
    error: null,
    payload: null,
  });
  const [inspectionLaunchFilters, setInspectionLaunchFilters] = useState(null);
  const [inspectionMprSlicePositions, setInspectionMprSlicePositions] = useState({});
  const projectConfigurationPanelRef = useRef(null);
  const projectPartsRequestRef = useRef(null);
  const projectImagesRequestRef = useRef(null);
  const projectPartsAbortControllerRef = useRef(null);
  const projectImagesAbortControllerRef = useRef(null);
  const projectPartsGenerationRef = useRef(0);
  const projectImagesGenerationRef = useRef(0);
  const loadedProjectPartsGenerationRef = useRef(-1);
  const loadedProjectImagesGenerationRef = useRef(-1);
  const activeProjectIdRef = useRef(id);
  activeProjectIdRef.current = id;
  const [autosaveTabDelayMessage, setAutosaveTabDelayMessage] = useState('');
  const [shareLinkMessage, setShareLinkMessage] = useState(null);

  const isActiveProject = useCallback((projectId) => (
    activeProjectIdRef.current === projectId
  ), []);

  // Child components can finish asynchronous work after React Router has
  // reused this Project instance for another id. Keep their state setters
  // scoped to the project that created the callback.
  const setActiveProjectError = useCallback((value) => {
    if (isActiveProject(id)) setError(value);
  }, [id, isActiveProject]);
  const setActiveProjectLoading = useCallback((value) => {
    if (isActiveProject(id)) setLoading(value);
  }, [id, isActiveProject]);
  const setActiveProjectMetadata = useCallback((value) => {
    if (isActiveProject(id)) setMetadata(value);
  }, [id, isActiveProject]);
  const setActiveProjectClasses = useCallback((value) => {
    if (isActiveProject(id)) setClasses(value);
  }, [id, isActiveProject]);
  const setActiveProjectConfigurationValue = useCallback((value) => {
    if (isActiveProject(id)) setProjectConfiguration(value);
  }, [id, isActiveProject]);
  const setActiveProjectConfigurationSubtabValue = useCallback((value) => {
    if (isActiveProject(id)) setActiveProjectConfigurationSubtab(value);
  }, [id, isActiveProject]);

  const projectQueryParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const queryMainTab = projectQueryParams.get('tab');
  const queryProjectDataTab = projectQueryParams.get('dataTab');
  const validQueryMainTab = ALLOWED_PROJECT_QUERY_TABS.has(queryMainTab) ? queryMainTab : null;
  const validQueryProjectDataTab = Object.prototype.hasOwnProperty.call(PROJECT_DATA_TABS, queryProjectDataTab)
    ? queryProjectDataTab
    : null;

  const visibleMainTabs = useMemo(() => (interfaceHierarchy.mainTabs || []).filter((tabKey) => (
    isUiSectionEnabled(projectConfiguration, `main.${tabKey}`)
  )), [interfaceHierarchy.mainTabs, projectConfiguration]);

  const visibleProjectDataTabs = useMemo(() => Object.entries(PROJECT_DATA_TABS).filter(([tabKey]) => (
    isUiSectionEnabled(projectConfiguration, `project_data.${tabKey}`)
  )), [projectConfiguration]);

  const visibleProjectDataTabKeys = useMemo(() => visibleProjectDataTabs.map(([tabKey]) => tabKey), [visibleProjectDataTabs]);

  const queryInspectionLaunchFilters = useMemo(() => {
    if (validQueryMainTab !== 'inspection') return null;

    const filterParamMap = {
      batch: 'selected_batch_id',
      part: 'selected_part_id',
      review: 'review_filter',
      image: 'selected_image_ref',
      metadataTab: 'active_metadata_tab',
      mprPane: 'active_mpr_pane',
    };

    const filters = Object.entries(filterParamMap).reduce((acc, [queryKey, filterKey]) => {
      const value = projectQueryParams.get(queryKey);
      if (value) acc[filterKey] = value;
      return acc;
    }, {});
    const overlayParam = projectQueryParams.get('overlays');
    if (overlayParam) {
      filters.active_overlay_ids = overlayParam.split(',').map((entry) => entry.trim()).filter(Boolean);
    }

    return Object.keys(filters).length > 0 ? filters : null;
  }, [projectQueryParams, validQueryMainTab]);

  const refreshProjectCounts = useCallback(async ({
    requestProjectId = id,
    signal,
  } = {}) => {
    if (signal?.aborted || !isActiveProject(requestProjectId)) return 'stale';
    setCountsLoading(true);
    try {
      const response = await fetch(
        `/api/projects/${requestProjectId}/data-summary`,
        signal ? { signal } : undefined,
      );
      if (!response.ok) {
        throw new Error(await buildHttpErrorMessage(response, 'Failed to load project summary counts'));
      }
      const payload = await response.json();
      if (signal?.aborted || !isActiveProject(requestProjectId)) return 'stale';
      setDataCounts({
        partsLoaded: Number(payload?.part_count) || 0,
        rawImages: Number(payload?.active_image_count) || 0,
        imageMetadata: Number(payload?.image_metadata_fields) || 0,
        overlayImages: Number(payload?.overlay_layer_count) || 0,
        annotations: Number(payload?.annotation_count) || 0,
      });
      return 'fresh';
    } catch (err) {
      if (signal?.aborted || isAbortError(err) || !isActiveProject(requestProjectId)) return 'stale';
      setError(err.message || 'Failed to load project summary counts');
      return 'error';
    } finally {
      if (!signal?.aborted && isActiveProject(requestProjectId)) setCountsLoading(false);
    }
  }, [id, isActiveProject]);

  const refreshProjectConfiguration = useCallback(async ({
    requestProjectId = id,
    signal,
  } = {}) => {
    if (signal?.aborted || !isActiveProject(requestProjectId)) return 'stale';
    try {
      const response = await fetch(
        `/api/projects/${requestProjectId}/configuration`,
        signal ? { signal } : undefined,
      );
      if (!response.ok) return 'error';
      const payload = await response.json();
      if (signal?.aborted || !isActiveProject(requestProjectId)) return 'stale';
      setProjectConfiguration(payload?.config || null);
      return 'fresh';
    } catch (err) {
      if (signal?.aborted || isAbortError(err) || !isActiveProject(requestProjectId)) return 'stale';
      throw err;
    }
  }, [id, isActiveProject]);

  useEffect(() => {
    const requestProjectId = id;
    const controller = new AbortController();
    const { signal } = controller;
    const requestIsActive = () => !signal.aborted && isActiveProject(requestProjectId);

    const fetchProjectData = async () => {
      try {
        setLoading(true);
        setError(null);
        setProject(null);
        setMetadata({});
        setClasses([]);
        setProjectConfiguration(null);
        setDataCounts(emptyProjectDataCounts());
        setCountsLoading(true);
        setRecentlyDeletedOverlays([]);
        setRecentlyDeletedLoading(false);
        setIngestResult({ loading: false, error: null, payload: null });
        setAutosaveTabDelayMessage('');
        setShareLinkMessage(null);
        projectPartsAbortControllerRef.current?.abort();
        projectImagesAbortControllerRef.current?.abort();
        projectPartsAbortControllerRef.current = null;
        projectImagesAbortControllerRef.current = null;
        projectPartsRequestRef.current = null;
        projectImagesRequestRef.current = null;
        projectPartsGenerationRef.current += 1;
        projectImagesGenerationRef.current += 1;
        loadedProjectPartsGenerationRef.current = -1;
        loadedProjectImagesGenerationRef.current = -1;
        setProjectParts([]);
        setProjectImages([]);
        setProjectPartsState({ loaded: false, loading: false, stale: true, error: null });
        setProjectImagesState({ loaded: false, loading: false, stale: true, error: null });
        const projectResponse = await fetch(`/api/projects/${requestProjectId}`, { signal });
        if (!projectResponse.ok) {
          throw new Error(`HTTP error! status: ${projectResponse.status}`);
        }
        const projectData = await projectResponse.json();
        if (!requestIsActive()) return;
        setProject(projectData);

        await Promise.all([
          (async () => {
            const metadataResponse = await fetch(
              `/api/projects/${requestProjectId}/metadata-dict`,
              { signal },
            );
            if (!metadataResponse.ok) return;
            const metadataData = await metadataResponse.json();
            if (requestIsActive()) setMetadata(metadataData);
          })(),
          (async () => {
            const classesResponse = await fetch(
              `/api/projects/${requestProjectId}/classes`,
              { signal },
            );
            if (!classesResponse.ok) return;
            const classesData = await classesResponse.json();
            if (requestIsActive()) setClasses(classesData);
          })(),
          refreshProjectCounts({ requestProjectId, signal }),
          refreshProjectConfiguration({ requestProjectId, signal }),
        ]);
        if (requestIsActive()) setLoading(false);
      } catch (err) {
        if (!requestIsActive() || isAbortError(err)) return;
        setError(err.message);
        setLoading(false);
      }
    };

    fetchProjectData();
    return () => {
      controller.abort();
      projectPartsAbortControllerRef.current?.abort();
      projectImagesAbortControllerRef.current?.abort();
    };
  }, [id, isActiveProject, refreshProjectConfiguration, refreshProjectCounts]);

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
        setActiveMainTab((prev) => (
          validQueryMainTab && DEFAULT_INTERFACE_HIERARCHY.mainTabs.includes(validQueryMainTab)
            ? validQueryMainTab
            : DEFAULT_INTERFACE_HIERARCHY.mainTabs.includes(prev)
              ? prev
              : DEFAULT_INTERFACE_HIERARCHY.mainTabs[0]
        ));
        return;
      }
      setInterfaceHierarchy(nextHierarchy);
      setActiveMainTab((prev) => (
        validQueryMainTab && validTabs.includes(validQueryMainTab)
          ? validQueryMainTab
          : validTabs.includes(prev)
            ? prev
            : validTabs[0]
      ));
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
  }, [validQueryMainTab]);


  useEffect(() => {
    if (validQueryMainTab && visibleMainTabs.includes(validQueryMainTab)) {
      setActiveMainTab(validQueryMainTab);
      return;
    }
    if (!visibleMainTabs.includes(activeMainTab)) {
      setActiveMainTab(visibleMainTabs[0] || 'project_configuration');
    }
  }, [activeMainTab, validQueryMainTab, visibleMainTabs]);

  useEffect(() => {
    if (validQueryProjectDataTab && visibleProjectDataTabKeys.includes(validQueryProjectDataTab)) {
      setActiveProjectDataTab(validQueryProjectDataTab);
      return;
    }
    if (!visibleProjectDataTabKeys.includes(activeProjectDataTab)) {
      setActiveProjectDataTab(visibleProjectDataTabKeys[0] || 'load_images');
    }
  }, [activeProjectDataTab, validQueryProjectDataTab, visibleProjectDataTabKeys]);

  useEffect(() => {
    if (validQueryMainTab === 'inspection') {
      setInspectionLaunchFilters(queryInspectionLaunchFilters);
    }
  }, [queryInspectionLaunchFilters, validQueryMainTab]);

  const refreshProjectMetadata = useCallback(async ({
    requestProjectId = id,
    signal,
  } = {}) => {
    if (signal?.aborted || !isActiveProject(requestProjectId)) return 'stale';
    try {
      const metadataResponse = await fetch(
        `/api/projects/${requestProjectId}/metadata-dict`,
        signal ? { signal } : undefined,
      );
      if (!metadataResponse.ok) return 'error';
      const metadataData = await metadataResponse.json();
      if (signal?.aborted || !isActiveProject(requestProjectId)) return 'stale';
      setMetadata(metadataData);
      return 'fresh';
    } catch (err) {
      if (signal?.aborted || isAbortError(err) || !isActiveProject(requestProjectId)) return 'stale';
      throw err;
    }
  }, [id, isActiveProject]);

  const handleProjectMetadataLoaded = useCallback(() => (
    refreshProjectMetadata({ requestProjectId: id })
  ), [id, refreshProjectMetadata]);

  const loadProjectParts = useCallback(() => {
    const requestProjectId = id;
    if (!isActiveProject(requestProjectId)) return Promise.resolve('stale');
    if (projectPartsRequestRef.current) return projectPartsRequestRef.current;
    const requestGeneration = projectPartsGenerationRef.current;
    const controller = new AbortController();
    projectPartsAbortControllerRef.current = controller;
    const { signal } = controller;
    const operation = (async () => {
      setProjectPartsState((previous) => ({ ...previous, loading: true, error: null }));
      try {
        const response = await fetch(`/api/projects/${requestProjectId}/parts`, { signal });
        if (!response.ok) throw new Error(`Failed to load project parts (${response.status})`);
        const payload = await response.json();
        if (signal.aborted || activeProjectIdRef.current !== requestProjectId) return 'stale';
        const stale = projectPartsGenerationRef.current !== requestGeneration;
        setProjectParts(Array.isArray(payload) ? payload : []);
        if (!stale) loadedProjectPartsGenerationRef.current = requestGeneration;
        setProjectPartsState({ loaded: true, loading: false, stale, error: null });
        return stale ? 'stale' : 'fresh';
      } catch (err) {
        if (signal.aborted || isAbortError(err) || activeProjectIdRef.current !== requestProjectId) {
          return 'stale';
        }
        setProjectPartsState((previous) => ({
          ...previous,
          loading: false,
          error: err?.message || 'Failed to load project parts',
        }));
        return 'error';
      }
    })();
    const request = operation.finally(() => {
      if (projectPartsRequestRef.current === request) projectPartsRequestRef.current = null;
      if (projectPartsAbortControllerRef.current === controller) {
        projectPartsAbortControllerRef.current = null;
      }
    });
    projectPartsRequestRef.current = request;
    return request;
  }, [id, isActiveProject]);

  const loadProjectImages = useCallback(() => {
    const requestProjectId = id;
    if (!isActiveProject(requestProjectId)) return Promise.resolve('stale');
    if (projectImagesRequestRef.current) return projectImagesRequestRef.current;
    const requestGeneration = projectImagesGenerationRef.current;
    const controller = new AbortController();
    projectImagesAbortControllerRef.current = controller;
    const { signal } = controller;
    const operation = (async () => {
      setProjectImagesState((previous) => ({ ...previous, loading: true, error: null }));
      try {
        const payload = await fetchProjectImagePages(requestProjectId, {
          includeDeleted: true,
          signal,
        });
        if (signal.aborted || activeProjectIdRef.current !== requestProjectId) return 'stale';
        const stale = projectImagesGenerationRef.current !== requestGeneration;
        setProjectImages(payload.items);
        if (!stale) loadedProjectImagesGenerationRef.current = requestGeneration;
        setProjectImagesState({ loaded: true, loading: false, stale, error: null });
        return stale ? 'stale' : 'fresh';
      } catch (err) {
        if (signal.aborted || isAbortError(err) || activeProjectIdRef.current !== requestProjectId) {
          return 'stale';
        }
        setProjectImagesState((previous) => ({
          ...previous,
          loading: false,
          error: err?.message || 'Failed to load project images',
        }));
        return 'error';
      }
    })();
    const request = operation.finally(() => {
      if (projectImagesRequestRef.current === request) projectImagesRequestRef.current = null;
      if (projectImagesAbortControllerRef.current === controller) {
        projectImagesAbortControllerRef.current = null;
      }
    });
    projectImagesRequestRef.current = request;
    return request;
  }, [id, isActiveProject]);

  useEffect(() => {
    if (activeMainTab !== 'project_data') return;
    if (
      PROJECT_DATA_TABS_REQUIRING_PARTS.has(activeProjectDataTab)
      && !projectPartsState.loading
      && !projectPartsState.error
      && (!projectPartsState.loaded || projectPartsState.stale)
    ) {
      loadProjectParts();
    }
    if (
      PROJECT_DATA_TABS_REQUIRING_IMAGES.has(activeProjectDataTab)
      && !projectImagesState.loading
      && !projectImagesState.error
      && (!projectImagesState.loaded || projectImagesState.stale)
    ) {
      loadProjectImages();
    }
  }, [
    activeMainTab,
    activeProjectDataTab,
    loadProjectImages,
    loadProjectParts,
    projectImagesState.loaded,
    projectImagesState.error,
    projectImagesState.loading,
    projectImagesState.stale,
    projectPartsState.loaded,
    projectPartsState.error,
    projectPartsState.loading,
    projectPartsState.stale,
  ]);

  const markProjectCollectionsStale = useCallback(({ images = true, parts = true } = {}) => {
    if (!isActiveProject(id)) return false;
    if (images) {
      projectImagesGenerationRef.current += 1;
      setProjectImagesState((previous) => ({ ...previous, stale: true, error: null }));
    }
    if (parts) {
      projectPartsGenerationRef.current += 1;
      setProjectPartsState((previous) => ({ ...previous, stale: true, error: null }));
    }
    return true;
  }, [id, isActiveProject]);

  const reconcileProjectImages = useCallback(async () => {
    if (!isActiveProject(id)) return false;
    while (loadedProjectImagesGenerationRef.current !== projectImagesGenerationRef.current) {
      if (!isActiveProject(id)) return false;
      const result = await loadProjectImages();
      if (result === 'error') return false;
      if (result === 'stale' && !isActiveProject(id)) return false;
    }
    return isActiveProject(id);
  }, [id, isActiveProject, loadProjectImages]);

  const reconcileProjectParts = useCallback(async () => {
    if (!isActiveProject(id)) return false;
    while (loadedProjectPartsGenerationRef.current !== projectPartsGenerationRef.current) {
      if (!isActiveProject(id)) return false;
      const result = await loadProjectParts();
      if (result === 'error') return false;
      if (result === 'stale' && !isActiveProject(id)) return false;
    }
    return isActiveProject(id);
  }, [id, isActiveProject, loadProjectParts]);

  const handleUploadComplete = useCallback(async (confirmedImages = [], completion = {}) => {
    const requestProjectId = id;
    if (!isActiveProject(requestProjectId)) {
      return { reconciled: false, authoritative: Boolean(completion?.requiresAuthoritativeReconciliation), stale: true };
    }
    if (Array.isArray(confirmedImages) && confirmedImages.length > 0) {
      setProjectImages((previous) => mergeImagesByIdentity(previous, confirmedImages));
    }
    markProjectCollectionsStale({
      images: true,
      parts: completion?.partsMayHaveChanged !== false,
    });
    const summaryRefresh = refreshProjectCounts({ requestProjectId });
    if (!completion?.requiresAuthoritativeReconciliation) {
      const summaryResult = await summaryRefresh;
      if (summaryResult === 'stale' || !isActiveProject(requestProjectId)) {
        return { reconciled: false, authoritative: false, stale: true };
      }
      return { reconciled: true, authoritative: false };
    }

    const [imagesReconciled, partsReconciled] = await Promise.all([
      reconcileProjectImages(),
      completion?.partsMayHaveChanged === false
        ? Promise.resolve(true)
        : reconcileProjectParts(),
      summaryRefresh,
    ]);
    if (!isActiveProject(requestProjectId)) {
      return { reconciled: false, authoritative: true, stale: true };
    }
    return {
      reconciled: imagesReconciled === true && partsReconciled === true,
      authoritative: true,
    };
  }, [id, isActiveProject, markProjectCollectionsStale, reconcileProjectImages, reconcileProjectParts, refreshProjectCounts]);

  const handleProjectCollectionsChanged = useCallback(async () => {
    const requestProjectId = id;
    if (!isActiveProject(requestProjectId)) return 'stale';
    markProjectCollectionsStale();
    return refreshProjectCounts({ requestProjectId });
  }, [id, isActiveProject, markProjectCollectionsStale, refreshProjectCounts]);

  const handleMetadataAssociationsChanged = useCallback(async () => {
    const requestProjectId = id;
    if (!isActiveProject(requestProjectId)) return 'stale';
    markProjectCollectionsStale({ images: false, parts: true });
    await Promise.all([
      refreshProjectCounts({ requestProjectId }),
      refreshProjectMetadata({ requestProjectId }),
    ]);
    return isActiveProject(requestProjectId) ? 'fresh' : 'stale';
  }, [id, isActiveProject, markProjectCollectionsStale, refreshProjectCounts, refreshProjectMetadata]);

  const handleBundleImportComplete = useCallback(async () => {
    const requestProjectId = id;
    if (!isActiveProject(requestProjectId)) return 'stale';
    markProjectCollectionsStale();
    await Promise.allSettled([
      refreshProjectCounts({ requestProjectId }),
      refreshProjectMetadata({ requestProjectId }),
      refreshProjectConfiguration({ requestProjectId }),
    ]);
    return isActiveProject(requestProjectId) ? 'fresh' : 'stale';
  }, [id, isActiveProject, markProjectCollectionsStale, refreshProjectConfiguration, refreshProjectCounts, refreshProjectMetadata]);

  const updateProjectTabRoute = useCallback((nextMainTab, nextDataTab = null) => {
    const params = new URLSearchParams(location.search);
    params.set('tab', nextMainTab);
    if (nextMainTab === 'project_data') {
      if (nextDataTab) params.set('dataTab', nextDataTab);
    } else {
      params.delete('dataTab');
    }

    navigate({ pathname: location.pathname, search: params.toString() }, { replace: false });
  }, [location.pathname, location.search, navigate]);

  const handleCopySessionLink = useCallback(async () => {
    const requestProjectId = id;
    if (!isActiveProject(requestProjectId)) return;
    try {
      await copyCurrentShareUrl();
      if (!isActiveProject(requestProjectId)) return;
      setShareLinkMessage({ type: 'success', text: 'Session link copied to clipboard.' });
    } catch (err) {
      if (!isActiveProject(requestProjectId)) return;
      setShareLinkMessage({
        type: 'error',
        text: err?.message || 'Unable to copy session link. Please copy the browser URL manually.',
      });
    }
  }, [id, isActiveProject]);

  const handleInspectionShareStateChange = useCallback((shareState, options = {}) => {
    if (!isActiveProject(id)) return;
    const params = new URLSearchParams(location.search);
    params.set('tab', 'inspection');
    ['batch', 'part', 'image', 'review', 'metadataTab', 'mprPane', 'overlays'].forEach((key) => params.delete(key));
    buildInspectionShareParams(shareState).forEach((value, key) => params.set(key, value));
    const nextSearch = params.toString();
    const currentSearch = new URLSearchParams(location.search).toString();
    if (nextSearch === currentSearch) return;
    navigate(
      { pathname: location.pathname, search: nextSearch },
      { replace: options.replace !== false },
    );
  }, [id, isActiveProject, location.pathname, location.search, navigate]);

  const handleInspectionMprSlicePositionChange = useCallback((slicePosition) => {
    if (!isActiveProject(id) || !slicePosition) return;
    setInspectionMprSlicePositions((previous) => ({
      ...previous,
      [id]: slicePosition,
    }));
  }, [id, isActiveProject]);

  const handleMainTabChange = useCallback(async (nextTabKey) => {
    const requestProjectId = id;
    if (!isActiveProject(requestProjectId)) return;
    if (nextTabKey === activeMainTab) return;

    if (activeMainTab === 'project_configuration' && projectConfigurationPanelRef.current?.hasPendingAutosave()) {
      setAutosaveTabDelayMessage('Autosaving project configuration before changing tabs…');
      const saved = await projectConfigurationPanelRef.current.flushPendingAutosave('Configuration autosaved.');
      if (!isActiveProject(requestProjectId)) return;
      setAutosaveTabDelayMessage('');
      if (!saved) {
        return;
      }
    }

    setActiveMainTab(nextTabKey);
    updateProjectTabRoute(nextTabKey, nextTabKey === 'project_data' ? activeProjectDataTab : null);
  }, [activeMainTab, activeProjectDataTab, id, isActiveProject, updateProjectTabRoute]);

  const handleProjectDataTabChange = useCallback((nextTabKey) => {
    setActiveMainTab('project_data');
    setActiveProjectDataTab(nextTabKey);
    updateProjectTabRoute('project_data', nextTabKey);
  }, [updateProjectTabRoute]);

  const refreshRecentlyDeletedOverlays = useCallback(async ({
    requestProjectId = id,
    signal,
  } = {}) => {
    if (signal?.aborted || !isActiveProject(requestProjectId)) return 'stale';
    setRecentlyDeletedLoading(true);
    try {
      const resp = await fetch(
        `/api/projects/${requestProjectId}/analyze/overlays/recently-deleted`,
        signal ? { signal } : undefined,
      );
      if (!resp.ok) throw new Error(`Failed to load recently deleted overlays (${resp.status})`);
      const payload = await resp.json();
      if (signal?.aborted || !isActiveProject(requestProjectId)) return 'stale';
      setRecentlyDeletedOverlays(Array.isArray(payload) ? payload : []);
      return 'fresh';
    } catch (err) {
      if (signal?.aborted || isAbortError(err) || !isActiveProject(requestProjectId)) return 'stale';
      setError(err.message || 'Failed to load recently deleted overlays');
      return 'error';
    } finally {
      if (!signal?.aborted && isActiveProject(requestProjectId)) setRecentlyDeletedLoading(false);
    }
  }, [id, isActiveProject]);

  useEffect(() => {
    if (activeMainTab === 'project_data' && activeProjectDataTab === 'recently_deleted') {
      const controller = new AbortController();
      refreshRecentlyDeletedOverlays({ requestProjectId: id, signal: controller.signal });
      return () => controller.abort();
    }
    return undefined;
  }, [activeMainTab, activeProjectDataTab, id, refreshRecentlyDeletedOverlays]);

  const restoreRecentlyDeletedOverlay = useCallback(async (overlay) => {
    const requestProjectId = id;
    if (!isActiveProject(requestProjectId)) return 'stale';
    const overlayId = overlay?.image_id;
    if (!overlayId) return;
    try {
      const resp = await fetch(`/api/projects/${requestProjectId}/analyze/overlays/${encodeURIComponent(String(overlayId))}/restore`, {
        method: 'POST',
      });
      if (!resp.ok) throw new Error(`Failed to restore overlay (${resp.status})`);
      if (!isActiveProject(requestProjectId)) return 'stale';
      await refreshRecentlyDeletedOverlays({ requestProjectId });
      if (!isActiveProject(requestProjectId)) return 'stale';
      await handleProjectCollectionsChanged();
      return isActiveProject(requestProjectId) ? 'fresh' : 'stale';
    } catch (err) {
      if (!isActiveProject(requestProjectId)) return 'stale';
      setError(err.message || 'Failed to restore overlay');
      return 'error';
    }
  }, [handleProjectCollectionsChanged, id, isActiveProject, refreshRecentlyDeletedOverlays]);

  const requestIngestValidation = useCallback(async () => {
    const requestProjectId = id;
    if (!isActiveProject(requestProjectId)) return 'stale';
    try {
      setIngestResult({ loading: true, error: null, payload: null });
      const [batchResp, partResp] = await Promise.all([
        fetch(`/api/projects/${requestProjectId}/batches`),
        fetch(`/api/projects/${requestProjectId}/parts`),
      ]);
      if (!isActiveProject(requestProjectId)) return 'stale';
      if (!batchResp.ok) throw new Error(await buildHttpErrorMessage(batchResp, 'Failed to load batches'));
      if (!partResp.ok) throw new Error(await buildHttpErrorMessage(partResp, 'Failed to load parts'));

      const [batchData, partData] = await Promise.all([batchResp.json(), partResp.json()]);
      if (!isActiveProject(requestProjectId)) return 'stale';
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

      const resp = await fetch(`/api/projects/${requestProjectId}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(syntheticPayload),
      });
      if (!resp.ok) throw new Error(await buildHttpErrorMessage(resp, 'Failed to run ingest validation'));
      const payload = await resp.json();
      if (!isActiveProject(requestProjectId)) return 'stale';
      setIngestResult({ loading: false, error: null, payload });
      await handleProjectCollectionsChanged();
      return isActiveProject(requestProjectId) ? 'fresh' : 'stale';
    } catch (err) {
      if (!isActiveProject(requestProjectId)) return 'stale';
      setIngestResult({ loading: false, error: err.message || 'Failed to run ingest validation', payload: null });
      return 'error';
    }
  }, [handleProjectCollectionsChanged, id, isActiveProject]);

  const currentPhase = resolveCurrentProjectPhase({
    phaseSettings: projectConfiguration?.phase_settings,
    partsLoaded: dataCounts.partsLoaded,
    annotations: dataCounts.annotations,
  });

  const projectPartsReady = projectPartsState.loaded
    && !projectPartsState.loading
    && !projectPartsState.stale;
  const projectImagesReady = projectImagesState.loaded
    && !projectImagesState.loading
    && !projectImagesState.stale;
  const completeProjectCollectionsReady = projectPartsReady && projectImagesReady;
  const completeProjectCollectionsError = projectPartsState.error || projectImagesState.error;

  const projectDataContent = useMemo(() => (
    <>
      {isUiSectionEnabled(projectConfiguration, 'project_data.summary') && (
        <ProjectDataSummaryTab counts={dataCounts} loading={countsLoading} />
      )}

      <div className="project-data-subtabs project-tabs" role="tablist" aria-label="Project data sections">
        {visibleProjectDataTabs.map(([tabKey, definition]) => (
          <button
            key={tabKey}
            type="button"
            className={`project-tab ${activeProjectDataTab === tabKey ? 'active' : ''}`}
            role="tab"
            aria-selected={activeProjectDataTab === tabKey}
            onClick={() => handleProjectDataTabChange(tabKey)}
          >
            {definition.label}
          </button>
        ))}
      </div>

      {activeProjectDataTab === 'load_images' && (
        <div className="project-data-tab-panel" role="tabpanel" aria-label="Load Images">
          {!project?.is_archived && (
            <div className="management-sections project-data-upload-first">
              <div className="upload-section">
                <ImageUploader
                  projectId={id}
                  projectType={project?.project_type}
                  projectConfiguration={projectConfiguration}
                  onUploadComplete={handleUploadComplete}
                  onProjectMetadataLoaded={handleProjectMetadataLoaded}
                  setError={setActiveProjectError}
                />
              </div>
              <div className="export-section">
                <ProjectDataExportPanel
                  projectId={id}
                  projectName={project?.name}
                  counts={dataCounts}
                  setError={setActiveProjectError}
                  onImportComplete={handleBundleImportComplete}
                />
              </div>
            </div>
          )}
          {isUiSectionEnabled(projectConfiguration, 'project_data.data_validation') && (
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
          )}
        </div>
      )}

      {activeProjectDataTab === 'batches' && !projectPartsReady && (
        <LazyProjectDataState
          label="Batches"
          error={projectPartsState.error}
          onRetry={loadProjectParts}
        />
      )}

      {activeProjectDataTab === 'batches' && projectPartsReady && (
        <BatchesTab
          projectId={id}
          parts={projectParts}
          onAssignmentsChanged={handleProjectCollectionsChanged}
          setError={setActiveProjectError}
          onInspectBatch={(batch) => {
            setInspectionLaunchFilters({
              selected_batch_id: batch.id,
              review_filter: 'manual',
              source: 'batches_tab_inspect',
              source_batch_name: batch.name,
              at: Date.now(),
            });
            setActiveMainTab('inspection');
          }}
        />
      )}

      {activeProjectDataTab === 'images_to_parts' && !completeProjectCollectionsReady && (
        <LazyProjectDataState
          label="Images to Parts"
          error={completeProjectCollectionsError}
          onRetry={() => {
            if (!projectPartsReady) loadProjectParts();
            if (!projectImagesReady) loadProjectImages();
          }}
        />
      )}

      {activeProjectDataTab === 'images_to_parts' && completeProjectCollectionsReady && (
        <ImagesToPartsTab
          projectId={id}
          parts={projectParts}
          images={projectImages}
          projectConfiguration={projectConfiguration}
          onAssignmentsChanged={handleProjectCollectionsChanged}
          setError={setActiveProjectError}
        />
      )}

      {activeProjectDataTab === 'overlays' && !completeProjectCollectionsReady && (
        <LazyProjectDataState
          label="Overlays"
          error={completeProjectCollectionsError}
          onRetry={() => {
            if (!projectPartsReady) loadProjectParts();
            if (!projectImagesReady) loadProjectImages();
          }}
        />
      )}

      {activeProjectDataTab === 'overlays' && completeProjectCollectionsReady && (
        <OverlaysTab
          projectId={id}
          parts={projectParts}
          images={projectImages}
          projectConfiguration={projectConfiguration}
          onAssignmentsChanged={handleProjectCollectionsChanged}
          setError={setActiveProjectError}
        />
      )}

      {activeProjectDataTab === 'metadata' && !projectPartsReady && (
        <LazyProjectDataState
          label="Metadata"
          error={projectPartsState.error}
          onRetry={loadProjectParts}
        />
      )}

      {activeProjectDataTab === 'metadata' && projectPartsReady && (
        <ProjectDataMetadataTab
          projectId={id}
          metadata={metadata}
          parts={projectParts}
          onAssociationsChanged={handleMetadataAssociationsChanged}
          setError={setActiveProjectError}
        />
      )}

      {activeProjectDataTab === 'remove_images' && !completeProjectCollectionsReady && (
        <LazyProjectDataState
          label="Unload Images"
          error={completeProjectCollectionsError}
          onRetry={() => {
            if (!projectPartsReady) loadProjectParts();
            if (!projectImagesReady) loadProjectImages();
          }}
        />
      )}

      {activeProjectDataTab === 'remove_images' && completeProjectCollectionsReady && (
        <RemoveImagesTab
          projectId={id}
          parts={projectParts}
          images={projectImages}
          onImagesRemoved={handleProjectCollectionsChanged}
          setError={setActiveProjectError}
        />
      )}

            {activeProjectDataTab === 'recently_deleted' && (
        <section className="workbench-panel recently-deleted-overlays-panel" role="tabpanel" aria-label="Recently Deleted">
          <header className="workbench-header">
            <div>
              <h2>Recently Deleted Overlays</h2>
              <p>Analyze overlays remain recoverable for 48 hours before their part metadata is purged.</p>
            </div>
            <div className="workbench-detail-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={recentlyDeletedLoading}
                onClick={refreshRecentlyDeletedOverlays}
              >
                {recentlyDeletedLoading ? 'Refreshing...' : 'Refresh'}
              </button>
            </div>
          </header>
          {recentlyDeletedLoading ? (
            <div className="loading-text">Loading recently deleted overlays...</div>
          ) : recentlyDeletedOverlays.length === 0 ? (
            <p className="muted">No Analyze overlays are waiting for deletion.</p>
          ) : (
            <div className="recently-deleted-overlay-list">
              {recentlyDeletedOverlays.map((overlay) => (
                <article key={`${overlay.part_id}-${overlay.image_id}`} className="recently-deleted-overlay-row">
                  <div>
                    <h3>{overlay.label || 'Analyze Overlay'}</h3>
                    <p>
                      {overlay.part_display_name || overlay.part_serial_number}
                      {' '}
                      -
                      {' '}
                      {overlay.filename}
                    </p>
                    <span>
                      Deleted {overlay.deleted_at ? new Date(overlay.deleted_at).toLocaleString() : 'recently'}
                      {' '}
                      -
                      {' '}
                      purges {overlay.pending_hard_delete_at ? new Date(overlay.pending_hard_delete_at).toLocaleString() : 'after retention'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => restoreRecentlyDeletedOverlay(overlay)}
                  >
                    Restore
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      )}
    </>
  ), [
    activeProjectDataTab,
    handleProjectDataTabChange,
    countsLoading,
    completeProjectCollectionsError,
    completeProjectCollectionsReady,
    dataCounts,
    handleMetadataAssociationsChanged,
    handleProjectMetadataLoaded,
    handleBundleImportComplete,
    handleProjectCollectionsChanged,
    id,
    loadProjectImages,
    loadProjectParts,
    projectImages,
    projectImagesReady,
    projectParts,
    projectPartsReady,
    projectPartsState.error,
    recentlyDeletedLoading,
    recentlyDeletedOverlays,
    handleUploadComplete,
    ingestResult,
    metadata,
    project?.is_archived,
    project?.name,
    project?.project_type,
    projectConfiguration,
    visibleProjectDataTabs,
    refreshRecentlyDeletedOverlays,
    requestIngestValidation,
    restoreRecentlyDeletedOverlay,
    setActiveProjectError,
  ]);

  const renderMainPanel = () => {
    if (activeMainTab === 'inspection') {
      return (
        <InspectionWorkbenchPanel
          projectId={id}
          projectType={project?.project_type}
          hierarchy={interfaceHierarchy.inspection}
          launchFilters={inspectionLaunchFilters}
          sessionMprSlicePosition={inspectionMprSlicePositions[id]}
          onMprSlicePositionChange={handleInspectionMprSlicePositionChange}
          onInspectionShareStateChange={handleInspectionShareStateChange}
        />
      );
    }
    if (activeMainTab === 'project_data') {
      return projectDataContent;
    }
    if (activeMainTab === 'analyze') {
      return (
        <AnalyzeWorkbenchTab
          projectId={id}
          projectType={project?.project_type}
          setError={setActiveProjectError}
        />
      );
    }
    if (activeMainTab === 'project_configuration') {
      return (
        <>
          <ProjectConfigurationPanel
            projectId={id}
            projectType={project?.project_type}
            currentInterfaceLayout={interfaceHierarchy}
            isAdminUser={currentUserGroups.includes('admin') || currentUserGroups.includes('admins')}
            ref={projectConfigurationPanelRef}
            onConfigurationSaved={setActiveProjectConfigurationValue}
            onActiveSubtabChange={setActiveProjectConfigurationSubtabValue}
          />
          {!project?.is_archived && activeProjectConfigurationSubtab === 'general' && (
            <div className="management-sections project-configuration-management">
              <div className="classes-section">
                <ClassManager
                  projectId={id}
                  classes={classes}
                  setClasses={setActiveProjectClasses}
                  loading={loading}
                  setLoading={setActiveProjectLoading}
                  setError={setActiveProjectError}
                />
              </div>
              <div className="metadata-section">
                <MetadataManager
                  projectId={id}
                  metadata={metadata}
                  setMetadata={setActiveProjectMetadata}
                  loading={loading}
                  setLoading={setActiveProjectLoading}
                  setError={setActiveProjectError}
                />
              </div>
            </div>
          )}
        </>
      );
    }
    if (activeMainTab === 'report') {
      return <ProjectReportTab projectId={id} projectName={project?.name} setError={setActiveProjectError} />;
    }
    return null;
  };

  const renderMainTabs = (className = '') => (
    <div className={`project-tabs project-main-tabs ${className}`.trim()} role="tablist" aria-label="Project sections">
      {visibleMainTabs.map((tabKey) => (
        <button
          key={tabKey}
          type="button"
          className={`project-tab ${activeMainTab === tabKey ? 'active' : ''}`}
          role="tab"
          aria-selected={activeMainTab === tabKey}
          onClick={() => handleMainTabChange(tabKey)}
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
              <button className="back-btn share-link-btn" onClick={handleCopySessionLink}>
                Copy session link
              </button>
            </div>
            <div className="project-info">
              <div className="project-title-row">
                <h1 className="project-title">{project ? project.name : 'Loading project...'}</h1>
                <span className="project-group">Type: {getProjectTypeLabel(project?.project_type, { short: true })}</span>
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

        {autosaveTabDelayMessage && (
          <div className="alert alert-info" role="status">
            {autosaveTabDelayMessage}
          </div>
        )}

        {shareLinkMessage && (
          <div className={`alert alert-${shareLinkMessage.type}`} role="status">
            {shareLinkMessage.text}
          </div>
        )}

        {loading && (
          <div className="loading-container">
            <div className="spinner"></div>
            <div className="loading-text">Loading project data...</div>
          </div>
        )}

        {!loading && (
          <div className="project-content project-main-tab-shell" data-active-main-tab={activeMainTab}>
            <section className="project-main-panel" data-active-main-tab={activeMainTab} aria-label="Selected project section">
              {renderMainPanel()}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

export default Project;
