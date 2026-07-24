import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import './App.css';

// Import components
import ImageDisplay from './components/ImageDisplay';
import ImageMetadata from './components/ImageMetadata';
import CompactImageClassifications from './components/CompactImageClassifications';
import ImageComments from './components/ImageComments';
import ImageDeletionControls from './components/ImageDeletionControls';
import MLAnalysisPanel from './components/MLAnalysisPanel';
import OverlayControls from './components/OverlayControls';
import MLDebugOutputs from './components/MLDebugOutputs';
import CalibrationManager from './components/CalibrationManager';
import MeasurementList from './components/MeasurementList';
import ReviewPanel from './components/ReviewPanel';
import ImageGroupPanel from './components/ImageGroupPanel';
import { loadGalleryState, loadGalleryStateFromUrl, hasGalleryQueryParams, applyGalleryFilters, sortImages, preserveGalleryQueryParams } from './utils/galleryState';
import {
  getImageMeasurements,
  getMeasurementIds,
  mergeImageMeasurements,
  reconcileVisibleMeasurementIds,
  upsertMeasurementById,
} from './utils/measurementState';
import { copyCurrentShareUrl } from './utils/shareLink';

const EMPTY_LIST = Object.freeze([]);

function isAbortError(error) {
  return error?.name === 'AbortError';
}

function getMeasurementMutationKey(projectId, imageId) {
  return JSON.stringify([
    String(projectId ?? ''),
    String(imageId ?? ''),
  ]);
}

function ImageView() {
  const { imageId } = useParams();
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get('project');
  const navigate = useNavigate();
  const routeKey = `${projectId || ''}:${imageId || ''}`;
  const routeInstanceIdentityRef = useRef({
    epoch: 0,
    instanceKey: '',
    routeKey: null,
  });
  if (routeInstanceIdentityRef.current.routeKey !== routeKey) {
    const epoch = routeInstanceIdentityRef.current.epoch + 1;
    routeInstanceIdentityRef.current = {
      epoch,
      instanceKey: `${routeKey}#${epoch}`,
      routeKey,
    };
  }
  const routeInstanceKey = routeInstanceIdentityRef.current.instanceKey;
  const activeRouteInstanceKeyRef = useRef(routeInstanceKey);
  const activeProjectIdRef = useRef(projectId);
  activeRouteInstanceKeyRef.current = routeInstanceKey;
  activeProjectIdRef.current = projectId;

  // State variables
  const [imageState, setImageState] = useState({
    routeInstanceKey: null,
    value: null,
  });
  const image = imageState.routeInstanceKey === routeInstanceKey
    ? imageState.value
    : null;
  const [navigationState, setNavigationState] = useState({
    currentImageIndex: -1,
    images: [],
    routeInstanceKey: null,
  });
  const projectImages = navigationState.routeInstanceKey === routeInstanceKey
    ? navigationState.images
    : EMPTY_LIST;
  const currentImageIndex = navigationState.routeInstanceKey === routeInstanceKey
    ? navigationState.currentImageIndex
    : -1;
  const [classesState, setClassesState] = useState({
    classes: [],
    projectId: null,
  });
  const classes = classesState.projectId === projectId ? classesState.classes : EMPTY_LIST;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [sidebarWidth, setSidebarWidth] = useState(350);
  const [isResizing, setIsResizing] = useState(false);
  const [projectArchivedState, setProjectArchivedState] = useState({
    archived: null,
    projectId: null,
  });
  const projectArchived = projectArchivedState.projectId === projectId
    ? projectArchivedState.archived
    : null;
  const [shareLinkMessage, setShareLinkMessage] = useState(null);

  const handleCopySessionLink = useCallback(async () => {
    try {
      await copyCurrentShareUrl();
      setShareLinkMessage({ type: 'success', text: 'Link copied to clipboard.' });
    } catch (err) {
      setShareLinkMessage({
        type: 'error',
        text: err?.message || 'Unable to copy link. Please copy the browser URL manually.',
      });
    }
  }, []);

  // Navigation settings - restore from localStorage
  const [skipDeletedImages, setSkipDeletedImages] = useState(() => {
    const saved = localStorage.getItem('skipDeletedImages');
    return saved !== null ? JSON.parse(saved) : true; // Default to true (skip deleted)
  });

  // ML Analysis state - restore from localStorage if available
  const [analysisState, setAnalysisState] = useState({
    routeInstanceKey: null,
    selectedAnalysis: null,
    selectedAnnotations: EMPTY_LIST,
  });
  const selectedAnalysis = analysisState.routeInstanceKey === routeInstanceKey
    ? analysisState.selectedAnalysis
    : null;
  const selectedAnnotations = analysisState.routeInstanceKey === routeInstanceKey
    ? analysisState.selectedAnnotations
    : EMPTY_LIST;
  const [overlayOptions, setOverlayOptions] = useState(() => {
    const saved = localStorage.getItem('mlOverlayOptions');
    if (saved) {
      try {
        return { ...JSON.parse(saved), bitmapAvailable: false };
      } catch (e) {
        console.error('Failed to parse saved overlay options:', e);
      }
    }
    return {
      showBoxes: true,
      showHeatmap: false,
      opacity: 0.7,
      viewMode: 'overlay',
      bitmapAvailable: false
    };
  });
  const [autoSelectLatest, setAutoSelectLatest] = useState(() => {
    const saved = localStorage.getItem('mlAutoSelectLatest');
    return saved === 'true' || saved === null; // Default to true
  });

  // Measurement state
  const [calibrationState, setCalibrationState] = useState({
    routeInstanceKey: null,
    value: null,
  });
  const calibration = calibrationState.routeInstanceKey === routeInstanceKey
    ? calibrationState.value
    : null;
  const [measurementsState, setMeasurementsState] = useState({
    routeInstanceKey: null,
    value: EMPTY_LIST,
  });
  const measurements = measurementsState.routeInstanceKey === routeInstanceKey
    ? measurementsState.value
    : EMPTY_LIST;
  const [measurementActiveState, setMeasurementActiveState] = useState({
    routeInstanceKey: null,
    value: false,
  });
  const measurementActive = measurementActiveState.routeInstanceKey === routeInstanceKey
    ? measurementActiveState.value
    : false;
  const [selectedMeasurementState, setSelectedMeasurementState] = useState({
    routeInstanceKey: null,
    value: null,
  });
  const selectedMeasurementId = selectedMeasurementState.routeInstanceKey === routeInstanceKey
    ? selectedMeasurementState.value
    : null;
  const [visibleMeasurementsState, setVisibleMeasurementsState] = useState({
    routeInstanceKey: null,
    value: null,
  });
  const visibleMeasurementIds = visibleMeasurementsState.routeInstanceKey === routeInstanceKey
    ? visibleMeasurementsState.value
    : null;
  const measurementsRef = useRef([]);
  const visibleMeasurementIdsRef = useRef(null);
  const visibilityRevisionRef = useRef(0);
  const imageLoadGenerationRef = useRef(0);
  const imageLoadControllerRef = useRef(null);
  const navigationLoadRef = useRef({ generation: 0, controller: null });
  const navigationTimerRef = useRef(null);
  const measurementMutationGenerationRef = useRef(0);
  const measurementMutationStateByResourceRef = useRef(new Map());
  const confirmedMeasurementsByRouteRef = useRef(new Map());
  const componentMountedRef = useRef(true);

  useEffect(() => {
    componentMountedRef.current = true;
    return () => {
      componentMountedRef.current = false;
    };
  }, []);

  const replaceMeasurements = useCallback((nextMeasurements, expectedRouteInstanceKey = activeRouteInstanceKeyRef.current) => {
    if (activeRouteInstanceKeyRef.current !== expectedRouteInstanceKey) return;
    measurementsRef.current = nextMeasurements;
    setMeasurementsState({
      routeInstanceKey: expectedRouteInstanceKey,
      value: nextMeasurements,
    });
  }, []);

  const replaceVisibleMeasurementIds = useCallback((nextVisibleMeasurementIds, expectedRouteInstanceKey = activeRouteInstanceKeyRef.current) => {
    if (activeRouteInstanceKeyRef.current !== expectedRouteInstanceKey) return;
    visibleMeasurementIdsRef.current = nextVisibleMeasurementIds;
    setVisibleMeasurementsState({
      routeInstanceKey: expectedRouteInstanceKey,
      value: nextVisibleMeasurementIds,
    });
  }, []);

  const commitLoadedImage = useCallback((
    imageData,
    expectedRouteInstanceKey,
    imageMutationKey,
    measurementMutationRevisionAtLoad,
  ) => {
    if (activeRouteInstanceKeyRef.current !== expectedRouteInstanceKey) return false;

    const imageMeasurements = getImageMeasurements(imageData);
    const measurementIds = getMeasurementIds(imageMeasurements);
    const imageMutationState = measurementMutationStateByResourceRef.current.get(
      imageMutationKey,
    );
    if (
      imageMutationState
      && imageMutationState.pendingCount === 0
      && imageMutationState.revision === measurementMutationRevisionAtLoad
    ) {
      imageMutationState.confirmedMeasurements = imageMeasurements;
    }
    for (const confirmedRouteInstanceKey of confirmedMeasurementsByRouteRef.current.keys()) {
      if (confirmedRouteInstanceKey !== expectedRouteInstanceKey) {
        confirmedMeasurementsByRouteRef.current.delete(confirmedRouteInstanceKey);
      }
    }
    confirmedMeasurementsByRouteRef.current.set(expectedRouteInstanceKey, imageMeasurements);
    setImageState({
      routeInstanceKey: expectedRouteInstanceKey,
      value: imageData,
    });
    replaceMeasurements(imageMeasurements, expectedRouteInstanceKey);
    replaceVisibleMeasurementIds(
      measurementIds.length > 0 ? measurementIds : null,
      expectedRouteInstanceKey,
    );
    visibilityRevisionRef.current = 0;
    document.title = `${imageData.filename || 'Image'} - Image Manager`;
    return true;
  }, [replaceMeasurements, replaceVisibleMeasurementIds]);

  const updateCurrentImage = useCallback((nextImageOrUpdater) => {
    const expectedRouteInstanceKey = routeInstanceKey;
    if (activeRouteInstanceKeyRef.current !== expectedRouteInstanceKey) return;

    setImageState((previousState) => {
      if (activeRouteInstanceKeyRef.current !== expectedRouteInstanceKey) return previousState;
      const previousImage = previousState.routeInstanceKey === expectedRouteInstanceKey
        ? previousState.value
        : null;
      const nextImage = typeof nextImageOrUpdater === 'function'
        ? nextImageOrUpdater(previousImage)
        : nextImageOrUpdater;
      if (
        nextImage
        && nextImage.id !== null
        && nextImage.id !== undefined
        && String(nextImage.id) !== String(imageId)
      ) {
        return previousState;
      }
      return {
        routeInstanceKey: expectedRouteInstanceKey,
        value: nextImage,
      };
    });
  }, [imageId, routeInstanceKey]);

  const setRouteLoading = useCallback((nextLoading) => {
    if (activeRouteInstanceKeyRef.current !== routeInstanceKey) return;
    setLoading(nextLoading);
  }, [routeInstanceKey]);

  const setRouteError = useCallback((nextError) => {
    if (activeRouteInstanceKeyRef.current !== routeInstanceKey) return;
    setError(nextError);
  }, [routeInstanceKey]);

  const setRouteCalibration = useCallback((nextCalibrationOrUpdater) => {
    if (activeRouteInstanceKeyRef.current !== routeInstanceKey) return;
    setCalibrationState((previousState) => {
      if (activeRouteInstanceKeyRef.current !== routeInstanceKey) return previousState;
      const previousCalibration = previousState.routeInstanceKey === routeInstanceKey
        ? previousState.value
        : null;
      return {
        routeInstanceKey,
        value: typeof nextCalibrationOrUpdater === 'function'
          ? nextCalibrationOrUpdater(previousCalibration)
          : nextCalibrationOrUpdater,
      };
    });
  }, [routeInstanceKey]);

  const setRouteMeasurementActive = useCallback((nextMeasurementActive) => {
    if (activeRouteInstanceKeyRef.current !== routeInstanceKey) return;
    if (
      nextMeasurementActive
      && !confirmedMeasurementsByRouteRef.current.has(routeInstanceKey)
    ) return;
    setMeasurementActiveState({
      routeInstanceKey,
      value: nextMeasurementActive,
    });
  }, [routeInstanceKey]);

  const setRouteSelectedMeasurementId = useCallback((nextMeasurementId) => {
    if (activeRouteInstanceKeyRef.current !== routeInstanceKey) return;
    setSelectedMeasurementState({
      routeInstanceKey,
      value: nextMeasurementId,
    });
  }, [routeInstanceKey]);

  // ML analysis selection handler
  const handleMLAnalysisSelect = useCallback((data) => {
    if (activeRouteInstanceKeyRef.current !== routeInstanceKey) return;
    if (data && data.analysis) {
      setAnalysisState({
        routeInstanceKey,
        selectedAnalysis: data.analysis,
        selectedAnnotations: data.annotations || [],
      });
      // Check if any bitmap artifacts are available (heatmap, segmentation, mask)
      const hasBitmap = (data.annotations || []).some(a =>
        a.storage_path && ['heatmap', 'segmentation', 'mask'].includes(a.annotation_type)
      );
      setOverlayOptions(prev => ({ ...prev, bitmapAvailable: hasBitmap }));
    } else {
      setAnalysisState({
        routeInstanceKey,
        selectedAnalysis: null,
        selectedAnnotations: EMPTY_LIST,
      });
      setOverlayOptions(prev => ({ ...prev, bitmapAvailable: false }));
    }
  }, [routeInstanceKey]);

  // Load project images for navigation
  const loadProjectImages = useCallback(async (groupId) => {
    const expectedRouteInstanceKey = routeInstanceKey;
    const generation = navigationLoadRef.current.generation + 1;
    navigationLoadRef.current.controller?.abort();
    const controller = new AbortController();
    navigationLoadRef.current = { generation, controller };
    try {
      const params = new URLSearchParams({ include_deleted: 'true' });
      const urlGalleryKey = searchParams.get('galleryKey');
      const urlGroupId = searchParams.get('groupId');
      const isUngroupedGallery = searchParams.get('ungrouped') === 'true' || (urlGalleryKey && urlGalleryKey.endsWith('_ungrouped'));

      if (isUngroupedGallery) {
        params.set('ungrouped', 'true');
      } else if (urlGroupId) {
        params.set('group_id', urlGroupId);
      } else if (groupId) {
        params.set('group_id', groupId);
      }
      const response = await fetch(`/api/projects/${projectId}/images?${params}`, {
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const images = await response.json();

      if (!Array.isArray(images)) {
        console.error('Server response is not an array:', images);
        throw new Error('Invalid server response: expected an array of images');
      }

      // Determine the gallery state key for this view.
      // Prefer the explicit galleryKey from the URL (set by ImageGallery on click).
      // Fall back to a group-derived key, then the project key.
      let galleryStateKey;
      if (urlGalleryKey) {
        galleryStateKey = urlGalleryKey;
      } else if (groupId) {
        galleryStateKey = `${projectId}_group_${groupId}`;
      } else {
        galleryStateKey = projectId;
      }

      // Load saved gallery filter/sort state and apply it for consistent navigation
      let navImages;
      try {
        const galleryState = hasGalleryQueryParams(searchParams)
          ? { ...loadGalleryState(galleryStateKey), ...loadGalleryStateFromUrl(searchParams) }
          : loadGalleryState(galleryStateKey);

        // Fetch review statuses if a non-default review filter is active
        let reviewStatuses = null;
        if (galleryState.reviewFilter && galleryState.reviewFilter !== 'all') {
          try {
            const reviewResp = await fetch(`/api/projects/${projectId}/image-review-statuses`, {
              signal: controller.signal,
            });
            if (reviewResp.ok) {
              reviewStatuses = await reviewResp.json();
            } else {
              console.warn('Non-OK response when loading review statuses for navigation filter:', reviewResp.status);
            }
          } catch (e) {
            if (isAbortError(e) || controller.signal.aborted) throw e;
            console.warn('Failed to load review statuses for navigation filter:', e);
          }
        }

        // If review statuses are unavailable, bypass the review filter to avoid empty navImages
        const effectiveGalleryState =
          reviewStatuses != null
            ? { ...galleryState, reviewStatuses }
            : { ...galleryState, reviewFilter: 'all', reviewStatuses: null };

        navImages = applyGalleryFilters(images, effectiveGalleryState);
      } catch (e) {
        // If anything goes wrong reading saved state, fall back to default date sort
        navImages = sortImages(images, 'date');
      }

      if (
        controller.signal.aborted
        || navigationLoadRef.current.generation !== generation
        || activeRouteInstanceKeyRef.current !== expectedRouteInstanceKey
      ) {
        return;
      }

      // Find the index of the current image in the filtered/sorted array
      const index = navImages.findIndex(img => img.id === imageId);
      setNavigationState({
        currentImageIndex: index,
        images: navImages,
        routeInstanceKey: expectedRouteInstanceKey,
      });

    } catch (error) {
      if (
        isAbortError(error)
        || controller.signal.aborted
        || navigationLoadRef.current.generation !== generation
        || activeRouteInstanceKeyRef.current !== expectedRouteInstanceKey
      ) {
        return;
      }
      console.error('Error loading project images:', error);
      setError('Failed to load project images for navigation. Please try again later.');
    }
  }, [projectId, imageId, routeInstanceKey, searchParams]);

  // Save skip deleted preference to localStorage
  useEffect(() => {
    localStorage.setItem('skipDeletedImages', JSON.stringify(skipDeletedImages));
  }, [skipDeletedImages]);

  // Current-user state is session scoped; image navigation must not refetch it.
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    fetch('/api/users/me', { signal: controller.signal })
      .then(response => {
        if (!response.ok) {
          // If we get a 401, it's expected when authentication is disabled
          if (response.status === 401) {
            console.log("Authentication is disabled or user is not logged in");
            return null;
          }
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
      })
      .then(userData => {
        if (active && userData) {
          setCurrentUser(userData);
        }
      })
      .catch(err => {
        if (!active || isAbortError(err)) return;
        console.error("Failed to fetch current user:", err);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  // Project-level data is owned by projectId, not the current image.
  useEffect(() => {
    setClassesState({ classes: [], projectId: projectId || null });
    if (!projectId) return undefined;
    const controller = new AbortController();
    let active = true;

    fetch(`/api/projects/${projectId}/classes`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        return response.json();
      })
      .then((classesData) => {
        if (active && activeProjectIdRef.current === projectId) {
          setClassesState({
            classes: Array.isArray(classesData) ? classesData : [],
            projectId,
          });
        }
      })
      .catch((loadError) => {
        if (
          !active
          || isAbortError(loadError)
          || activeProjectIdRef.current !== projectId
        ) return;
        console.error('Error loading classes:', loadError);
        setError('Failed to load classes. Please try again later.');
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [projectId]);

  // The route owns image, measurement, loading, error, and title state. Image
  // reads are aborted on navigation, while measurement writes stay serialized
  // by project-image resource so an acknowledgement cannot be overtaken.
  useEffect(() => {
    imageLoadControllerRef.current?.abort();
    navigationLoadRef.current.controller?.abort();
    const pendingNavigation = navigationTimerRef.current;
    if (pendingNavigation) {
      window.clearTimeout(pendingNavigation.timeoutId);
      navigationTimerRef.current = null;
    }

    const expectedRouteInstanceKey = routeInstanceKey;
    setCalibrationState({ routeInstanceKey: expectedRouteInstanceKey, value: null });
    setNavigationState({
      currentImageIndex: -1,
      images: [],
      routeInstanceKey: expectedRouteInstanceKey,
    });
    visibilityRevisionRef.current = 0;

    if (!imageId || !projectId) {
      setError('Image ID or Project ID is missing.');
      setLoading(false);
      return undefined;
    }

    const controller = new AbortController();
    const routeConfirmedMeasurements = confirmedMeasurementsByRouteRef.current;
    imageLoadControllerRef.current = controller;
    const generation = imageLoadGenerationRef.current + 1;
    imageLoadGenerationRef.current = generation;
    measurementMutationGenerationRef.current += 1;
    const imageMutationKey = getMeasurementMutationKey(projectId, imageId);
    const measurementMutationRevisionAtLoad = (
      measurementMutationStateByResourceRef.current.get(imageMutationKey)?.revision
      || 0
    );

    setImageState({ routeInstanceKey: expectedRouteInstanceKey, value: null });
    replaceMeasurements([], expectedRouteInstanceKey);
    replaceVisibleMeasurementIds(null, expectedRouteInstanceKey);
    setError(null);
    setLoading(true);

    const loadCurrentImage = async () => {
      try {
        let response = await fetch(`/api/images/${imageId}`, {
          signal: controller.signal,
        });
        let imageData;

        if (!response.ok) {
          console.log('Direct image fetch failed, trying project endpoint with deleted images...');
          response = await fetch(`/api/projects/${projectId}/images?include_deleted=true`, {
            signal: controller.signal,
          });
          if (!response.ok) {
            throw new Error(`Failed to fetch project images: ${response.status}`);
          }
          const projectImageData = await response.json();
          if (!Array.isArray(projectImageData)) {
            throw new Error('Invalid project image response');
          }
          imageData = projectImageData.find((candidate) => String(candidate.id) === String(imageId));
          if (!imageData) throw new Error('Image not found in project');
        } else {
          imageData = await response.json();
          if (!imageData || String(imageData.id) !== String(imageId)) {
            throw new Error('Image response did not match the current route');
          }
        }

        if (
          !controller.signal.aborted
          && imageLoadGenerationRef.current === generation
          && activeRouteInstanceKeyRef.current === expectedRouteInstanceKey
        ) {
          commitLoadedImage(
            imageData,
            expectedRouteInstanceKey,
            imageMutationKey,
            measurementMutationRevisionAtLoad,
          );
        }
      } catch (loadError) {
        if (
          isAbortError(loadError)
          || controller.signal.aborted
          || imageLoadGenerationRef.current !== generation
          || activeRouteInstanceKeyRef.current !== expectedRouteInstanceKey
        ) {
          return;
        }
        console.error('Error loading image data:', loadError);
        setError('Failed to load image. Please try again later.');
      } finally {
        if (
          !controller.signal.aborted
          && imageLoadGenerationRef.current === generation
          && activeRouteInstanceKeyRef.current === expectedRouteInstanceKey
        ) {
          setLoading(false);
        }
      }
    };

    loadCurrentImage();
    return () => {
      controller.abort();
      navigationLoadRef.current.controller?.abort();
      const routeNavigation = navigationTimerRef.current;
      if (routeNavigation?.routeInstanceKey === expectedRouteInstanceKey) {
        window.clearTimeout(routeNavigation.timeoutId);
        navigationTimerRef.current = null;
      }
      if (imageLoadGenerationRef.current === generation) {
        imageLoadGenerationRef.current += 1;
      }
      measurementMutationGenerationRef.current += 1;
      routeConfirmedMeasurements.delete(expectedRouteInstanceKey);
    };
  }, [
    imageId,
    projectId,
    routeInstanceKey,
    commitLoadedImage,
    replaceMeasurements,
    replaceVisibleMeasurementIds,
  ]);

  // Fetch project archive status (only when projectId changes, not on every image navigation)
  useEffect(() => {
    setProjectArchivedState({ archived: null, projectId: projectId || null });
    if (!projectId) return undefined;
    const controller = new AbortController();
    let active = true;
    fetch(`/api/projects/${projectId}`, { signal: controller.signal })
        .then(r => r.ok ? r.json() : null)
        .then(data => {
          if (active && data && activeProjectIdRef.current === projectId) {
            setProjectArchivedState({
              archived: !!data.is_archived,
              projectId,
            });
          }
        })
        .catch((archiveError) => {
          if (
            !active
            || isAbortError(archiveError)
            || activeProjectIdRef.current !== projectId
          ) return;
        });
    return () => {
      active = false;
      controller.abort();
    };
  }, [projectId]);

  // Load project images for navigation once we know the current image's group
  useEffect(() => {
    if (image && projectId) {
      loadProjectImages(image.group_id || null);
    }
  }, [image?.id, image?.group_id, projectId, loadProjectImages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Build query string for navigation, preserving recognized gallery context params.
  const buildNavQuery = useCallback(() => {
    const params = preserveGalleryQueryParams(searchParams, { project: projectId });
    return params.toString();
  }, [projectId, searchParams]);

  const scheduleImageNavigation = useCallback((targetImage) => {
    if (!targetImage?.id) return;
    const pendingNavigation = navigationTimerRef.current;
    if (pendingNavigation) window.clearTimeout(pendingNavigation.timeoutId);

    const expectedRouteInstanceKey = routeInstanceKey;
    const targetImageId = targetImage.id;
    const navigationQuery = buildNavQuery();
    setIsTransitioning(true);
    const timeoutId = window.setTimeout(() => {
      if (navigationTimerRef.current?.timeoutId === timeoutId) {
        navigationTimerRef.current = null;
      }
      if (activeRouteInstanceKeyRef.current !== expectedRouteInstanceKey) return;
      navigate(`/view/${targetImageId}?${navigationQuery}`);
    }, 300);
    navigationTimerRef.current = {
      routeInstanceKey: expectedRouteInstanceKey,
      timeoutId,
    };
  }, [buildNavQuery, navigate, routeInstanceKey]);

  // Navigate to previous image with transition
  const navigateToPreviousImage = useCallback(() => {
    let targetIndex = currentImageIndex - 1;

    // Skip deleted images if option is enabled
    if (skipDeletedImages) {
      while (targetIndex >= 0 && projectImages[targetIndex]?.deleted_at) {
        targetIndex--;
      }
    }

    if (targetIndex >= 0) {
      scheduleImageNavigation(projectImages[targetIndex]);
    }
  }, [currentImageIndex, projectImages, scheduleImageNavigation, skipDeletedImages]);

  // Navigate to next image with transition
  const navigateToNextImage = useCallback(() => {
    let targetIndex = currentImageIndex + 1;

    // Skip deleted images if option is enabled
    if (skipDeletedImages) {
      while (targetIndex < projectImages.length && projectImages[targetIndex]?.deleted_at) {
        targetIndex++;
      }
    }

    if (targetIndex < projectImages.length) {
      scheduleImageNavigation(projectImages[targetIndex]);
    }
  }, [currentImageIndex, projectImages, scheduleImageNavigation, skipDeletedImages]);

  // Reset transition state when image changes (but keep ML settings)
  useEffect(() => {
    setIsTransitioning(false);
    // Clear selected analysis so MLAnalysisPanel can auto-select latest if enabled
    setAnalysisState({
      routeInstanceKey,
      selectedAnalysis: null,
      selectedAnnotations: EMPTY_LIST,
    });
    setOverlayOptions(prev => ({
      ...prev,
      bitmapAvailable: false
    }));
    // Clear measurement mode when image changes
    setMeasurementActiveState({ routeInstanceKey, value: false });
    setSelectedMeasurementState({ routeInstanceKey, value: null });
  }, [routeInstanceKey]);

  // Save overlay options to localStorage when they change
  useEffect(() => {
    const { bitmapAvailable, ...persistentOptions } = overlayOptions;
    localStorage.setItem('mlOverlayOptions', JSON.stringify(persistentOptions));
  }, [overlayOptions]);

  // Save auto-select preference to localStorage
  useEffect(() => {
    localStorage.setItem('mlAutoSelectLatest', autoSelectLatest.toString());
  }, [autoSelectLatest]);

  // Handle resize functionality
  const handleMouseDown = useCallback(() => {
    setIsResizing(true);
  }, []);

  const handleMouseMove = useCallback((e) => {
    if (!isResizing) return;

    const newWidth = e.clientX;
    const minWidth = 250;
    const maxWidth = window.innerWidth * 0.6; // Max 60% of screen width

    if (newWidth >= minWidth && newWidth <= maxWidth) {
      setSidebarWidth(newWidth);
    }
  }, [isResizing]);

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  // Add global mouse event listeners for resizing
  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
    }
  }, [isResizing, handleMouseMove, handleMouseUp]);


  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'ArrowLeft') {
        navigateToPreviousImage();
      } else if (e.key === 'ArrowRight') {
        navigateToNextImage();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [currentImageIndex, projectImages.length, navigateToNextImage, navigateToPreviousImage]);

  // Measurement writes are optimistic in the active route but serialized by
  // project-image resource for the lifetime of this view. Queue entries retain
  // the last acknowledged server representation so a later operation can be
  // rebased after navigation instead of overwriting it with a stale full-state
  // value.
  // Settled entries stay cached until unmount so a GET started before a write
  // settled cannot replace that acknowledged base.
  const persistMeasurementMutation = useCallback(async ({
    expectedRouteInstanceKey,
    targetProjectId,
    targetImageId,
    applyMeasurementMutation,
    optimisticMeasurements,
    nextVisibleMeasurementIds,
    originalMeasurements,
    originalVisibleMeasurementIds,
    visibilityRevisionAtMutation,
    failureLogPrefix,
    failureMessage,
  }) => {
    if (
      !componentMountedRef.current
      || activeRouteInstanceKeyRef.current !== expectedRouteInstanceKey
    ) {
      return;
    }

    const imageMutationKey = getMeasurementMutationKey(
      targetProjectId,
      targetImageId,
    );
    let imageMutationState = measurementMutationStateByResourceRef.current.get(
      imageMutationKey,
    );
    if (!imageMutationState) {
      imageMutationState = {
        confirmedMeasurements: (
          confirmedMeasurementsByRouteRef.current.get(expectedRouteInstanceKey)
          || originalMeasurements
        ),
        pendingCount: 0,
        revision: 0,
        tail: Promise.resolve(),
      };
      measurementMutationStateByResourceRef.current.set(
        imageMutationKey,
        imageMutationState,
      );
    }

    const generation = measurementMutationGenerationRef.current + 1;
    measurementMutationGenerationRef.current = generation;

    replaceMeasurements(optimisticMeasurements, expectedRouteInstanceKey);
    replaceVisibleMeasurementIds(
      nextVisibleMeasurementIds,
      expectedRouteInstanceKey,
    );

    const previousImageQueue = imageMutationState.tail;
    imageMutationState.pendingCount += 1;
    imageMutationState.revision += 1;
    const persistRequest = previousImageQueue
      .catch(() => undefined)
      .then(async () => {
        const rebasedMeasurements = applyMeasurementMutation(
          imageMutationState.confirmedMeasurements,
        );
        const response = await fetch(`/api/images/${targetImageId}/metadata`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            key: 'measurements',
            value: rebasedMeasurements,
          }),
        });
        if (!response.ok) {
          const detail = typeof response.text === 'function' ? await response.text() : '';
          throw new Error(`${failureMessage}: ${response.status || 'unknown'}${detail ? ` - ${detail}` : ''}`);
        }
        // A 2xx response acknowledges the full-state metadata write even if an
        // intermediary returns an empty or malformed body. Do not roll back a
        // server-confirmed write merely because response materialization fails.
        let acknowledgedMeasurements = rebasedMeasurements;
        try {
          const responseImage = await response.json();
          const responseContainsMeasurements = (
            Array.isArray(responseImage?.metadata?.measurements)
            || Array.isArray(responseImage?.metadata_?.measurements)
          );
          if (responseContainsMeasurements) {
            acknowledgedMeasurements = getImageMeasurements(responseImage);
          }
        } catch (_parseError) {
          // The HTTP acknowledgement is authoritative even when the optional
          // response representation is absent or malformed.
        }
        imageMutationState.confirmedMeasurements = acknowledgedMeasurements;
        if (
          componentMountedRef.current
          && activeRouteInstanceKeyRef.current === expectedRouteInstanceKey
        ) {
          confirmedMeasurementsByRouteRef.current.set(
            expectedRouteInstanceKey,
            acknowledgedMeasurements,
          );
        }
        return acknowledgedMeasurements;
      })
      .finally(() => {
        imageMutationState.pendingCount -= 1;
        imageMutationState.revision += 1;
      });
    const queueTail = persistRequest.catch(() => undefined);
    imageMutationState.tail = queueTail;

    try {
      const acknowledgedMeasurements = await persistRequest;
      if (
        measurementMutationGenerationRef.current === generation
        && componentMountedRef.current
        && activeRouteInstanceKeyRef.current === expectedRouteInstanceKey
      ) {
        replaceMeasurements(acknowledgedMeasurements);
        replaceVisibleMeasurementIds(reconcileVisibleMeasurementIds(
          acknowledgedMeasurements,
          visibleMeasurementIdsRef.current,
        ));
        updateCurrentImage((currentImage) => (
          mergeImageMeasurements(currentImage, acknowledgedMeasurements)
        ));
      }
    } catch (mutationError) {
      if (
        isAbortError(mutationError)
        || !componentMountedRef.current
        || measurementMutationGenerationRef.current !== generation
        || activeRouteInstanceKeyRef.current !== expectedRouteInstanceKey
      ) {
        return;
      }
      console.error(failureLogPrefix, mutationError);
      setError(`${failureMessage}. Please try again.`);
      const confirmedMeasurements = imageMutationState.confirmedMeasurements
        || originalMeasurements;
      const preferredVisibleMeasurementIds = (
        visibilityRevisionRef.current === visibilityRevisionAtMutation
          ? originalVisibleMeasurementIds
          : visibleMeasurementIdsRef.current
      );
      const confirmedVisibleIds = reconcileVisibleMeasurementIds(
        confirmedMeasurements,
        preferredVisibleMeasurementIds,
      );
      replaceMeasurements(confirmedMeasurements);
      replaceVisibleMeasurementIds(confirmedVisibleIds);
      updateCurrentImage((currentImage) => (
        mergeImageMeasurements(currentImage, confirmedMeasurements)
      ));
    }
  }, [
    replaceMeasurements,
    replaceVisibleMeasurementIds,
    updateCurrentImage,
  ]);

  // Measurement handlers
  const handleSaveMeasurement = useCallback(async (measurement) => {
    if (
      projectArchived !== false
      || activeRouteInstanceKeyRef.current !== routeInstanceKey
      || !confirmedMeasurementsByRouteRef.current.has(routeInstanceKey)
    ) return;
    const originalMeasurements = [...measurementsRef.current];
    const originalVisibleIds = visibleMeasurementIdsRef.current
      ? [...visibleMeasurementIdsRef.current]
      : null;
    const updatedMeasurements = upsertMeasurementById(originalMeasurements, measurement);
    const updatedIds = getMeasurementIds(updatedMeasurements);
    const updatedVisibleIds = originalVisibleIds === null
      ? updatedIds
      : [...new Set([
        ...originalVisibleIds.filter((id) => updatedIds.includes(id)),
        measurement?.id,
      ].filter((id) => id !== null && id !== undefined))];

    await persistMeasurementMutation({
      expectedRouteInstanceKey: routeInstanceKey,
      targetProjectId: projectId,
      targetImageId: imageId,
      applyMeasurementMutation: (confirmedMeasurements) => (
        upsertMeasurementById(confirmedMeasurements, measurement)
      ),
      optimisticMeasurements: updatedMeasurements,
      nextVisibleMeasurementIds: updatedVisibleIds.length > 0 ? updatedVisibleIds : null,
      originalMeasurements,
      originalVisibleMeasurementIds: originalVisibleIds,
      visibilityRevisionAtMutation: visibilityRevisionRef.current,
      failureLogPrefix: 'Error saving measurement:',
      failureMessage: 'Failed to save measurement',
    });
  }, [imageId, persistMeasurementMutation, projectArchived, projectId, routeInstanceKey]);

  const handleDeleteMeasurement = useCallback(async (measurementId) => {
    if (
      projectArchived !== false
      || activeRouteInstanceKeyRef.current !== routeInstanceKey
      || !confirmedMeasurementsByRouteRef.current.has(routeInstanceKey)
    ) return;
    const originalMeasurements = [...measurementsRef.current];
    const originalVisibleIds = visibleMeasurementIdsRef.current
      ? [...visibleMeasurementIdsRef.current]
      : null;
    const updatedMeasurements = originalMeasurements.filter(
      (measurement) => String(measurement.id) !== String(measurementId),
    );
    const updatedIds = getMeasurementIds(updatedMeasurements);
    const updatedVisibleIds = originalVisibleIds === null
      ? updatedIds
      : originalVisibleIds.filter((id) => updatedIds.includes(id));

    await persistMeasurementMutation({
      expectedRouteInstanceKey: routeInstanceKey,
      targetProjectId: projectId,
      targetImageId: imageId,
      applyMeasurementMutation: (confirmedMeasurements) => (
        confirmedMeasurements.filter(
          (confirmedMeasurement) => (
            String(confirmedMeasurement.id) !== String(measurementId)
          ),
        )
      ),
      optimisticMeasurements: updatedMeasurements,
      nextVisibleMeasurementIds: updatedMeasurements.length > 0 ? updatedVisibleIds : null,
      originalMeasurements,
      originalVisibleMeasurementIds: originalVisibleIds,
      visibilityRevisionAtMutation: visibilityRevisionRef.current,
      failureLogPrefix: 'Error deleting measurement:',
      failureMessage: 'Failed to delete measurement',
    });
  }, [imageId, persistMeasurementMutation, projectArchived, projectId, routeInstanceKey]);

  const handleRenameMeasurement = useCallback(async (measurementId, newName) => {
    if (
      projectArchived !== false
      || activeRouteInstanceKeyRef.current !== routeInstanceKey
      || !confirmedMeasurementsByRouteRef.current.has(routeInstanceKey)
    ) return;
    const originalMeasurements = [...measurementsRef.current];
    const originalVisibleIds = visibleMeasurementIdsRef.current
      ? [...visibleMeasurementIdsRef.current]
      : null;
    const updatedMeasurements = originalMeasurements.map((measurement) =>
      String(measurement.id) === String(measurementId)
        ? { ...measurement, name: newName }
        : measurement
    );

    await persistMeasurementMutation({
      expectedRouteInstanceKey: routeInstanceKey,
      targetProjectId: projectId,
      targetImageId: imageId,
      applyMeasurementMutation: (confirmedMeasurements) => (
        confirmedMeasurements.map((confirmedMeasurement) => (
          String(confirmedMeasurement.id) === String(measurementId)
            ? { ...confirmedMeasurement, name: newName }
            : confirmedMeasurement
        ))
      ),
      optimisticMeasurements: updatedMeasurements,
      nextVisibleMeasurementIds: originalVisibleIds,
      originalMeasurements,
      originalVisibleMeasurementIds: originalVisibleIds,
      visibilityRevisionAtMutation: visibilityRevisionRef.current,
      failureLogPrefix: 'Error renaming measurement:',
      failureMessage: 'Failed to rename measurement',
    });
  }, [imageId, persistMeasurementMutation, projectArchived, projectId, routeInstanceKey]);

  const handleToggleVisibility = useCallback((measurementId) => {
    if (activeRouteInstanceKeyRef.current !== routeInstanceKey) return;
    const previousIds = visibleMeasurementIdsRef.current;
    let nextIds;
    if (!previousIds) {
      nextIds = [measurementId];
    } else if (previousIds.includes(measurementId)) {
      nextIds = previousIds.filter((id) => id !== measurementId);
    } else {
      nextIds = [...previousIds, measurementId];
    }
    visibilityRevisionRef.current += 1;
    replaceVisibleMeasurementIds(nextIds);
  }, [replaceVisibleMeasurementIds, routeInstanceKey]);

  return (
    <div className="App" style={{ maxWidth: '100%', padding: '0' }}>
      <header className="view-header-compact">
        <div className="view-header-content">
          <div className="view-header-actions">
            <button
              className="btn btn-secondary btn-small"
              onClick={() => {
                if (image && image.group_id) {
                  navigate(`/project/${projectId}/group/${image.group_id}`);
                } else {
                  navigate(`/project/${projectId}`);
                }
              }}
            >
              ← Back
            </button>
            <button
              className="btn btn-secondary btn-small"
              onClick={handleCopySessionLink}
            >
              Copy link
            </button>
          </div>
          <span className="view-filename">{image ? image.filename : 'Loading...'}</span>
          {currentUser && (
            <span className="view-user-info">{currentUser.email}</span>
          )}
        </div>
      </header>

      <div className="container" style={{ maxWidth: '100%', padding: 'var(--space-4)' }}>
        {shareLinkMessage && (
          <div className={`alert alert-${shareLinkMessage.type}`} role="status">
            {shareLinkMessage.text}
          </div>
        )}

        {projectArchived === true && (
          <div className="archived-project-notice">
            <strong>This project is archived.</strong> It is read-only. Classifications, comments, reviews, and other edits are disabled.
          </div>
        )}
        {error && (
          <div className="alert alert-error">
            {error}
            <button
              className="close-alert"
              onClick={() => setError(null)}
            >
              &times;
            </button>
          </div>
        )}
        
        <div className="image-view-container">
          <div className="image-view-main">
            {/* Left sidebar with classification controls, metadata, and comments */}
            <div
              className="image-view-sidebar"
              style={{ width: `${sidebarWidth}px`, minWidth: `${sidebarWidth}px` }}
            >
              {/* Review verification panel */}
              {image && (
                <ReviewPanel
                  key={`review:${routeInstanceKey}`}
                  imageId={imageId}
                  readOnly={projectArchived !== false}
                />
              )}

              {/* Group assignment panel */}
              {image && projectId && (
                <ImageGroupPanel
                  key={`group:${routeInstanceKey}`}
                  imageId={imageId}
                  projectId={projectId}
                  groupId={image.group_id || null}
                  onGroupChanged={(newGroupId) => {
                    updateCurrentImage(prev => prev ? { ...prev, group_id: newGroupId } : prev);
                  }}
                  readOnly={projectArchived !== false}
                />
              )}

              {/* Classification controls */}
              <CompactImageClassifications
                key={`classifications:${routeInstanceKey}`}
                imageId={imageId}
                classes={classes}
                loading={loading}
                setLoading={setRouteLoading}
                setError={setRouteError}
                readOnly={projectArchived !== false}
              />


              <ImageComments
                key={`comments:${routeInstanceKey}`}
                imageId={imageId}
                loading={loading}
                setLoading={setRouteLoading}
                setError={setRouteError}
                readOnly={projectArchived !== false}
              />

              <ImageMetadata
                key={`metadata:${routeInstanceKey}`}
                imageId={imageId}
                image={image}
                setImage={updateCurrentImage}
                loading={loading}
                setLoading={setRouteLoading}
                setError={setRouteError}
                readOnly={projectArchived !== false}
              />

              {/* Calibration Manager */}
              {image && (
                <CalibrationManager
                  key={`calibration:${routeInstanceKey}`}
                  projectId={projectId}
                  imageId={imageId}
                  image={image}
                  onCalibrationChange={setRouteCalibration}
                  readOnly={projectArchived !== false}
                />
              )}

              {/* Measurement List */}
              {image && measurements.length > 0 && (
                <MeasurementList
                  key={`measurements:${routeInstanceKey}`}
                  measurements={measurements}
                  calibration={calibration}
                  onDeleteMeasurement={projectArchived === false ? handleDeleteMeasurement : undefined}
                  onRenameMeasurement={projectArchived === false ? handleRenameMeasurement : undefined}
                  onToggleVisibility={handleToggleVisibility}
                  visibleMeasurementIds={visibleMeasurementIds}
                  selectedMeasurementId={selectedMeasurementId}
                  onSelectMeasurement={setRouteSelectedMeasurementId}
                  readOnly={projectArchived !== false}
                />
              )}

              {/* ML Analysis Panel (read-only, only visible when analyses exist) */}
              {image && (
                <MLAnalysisPanel
                  key={`analysis:${routeInstanceKey}`}
                  imageId={imageId}
                  onSelect={handleMLAnalysisSelect}
                  autoSelectLatest={autoSelectLatest}
                  onAutoSelectChange={setAutoSelectLatest}
                />
              )}

              {/* Overlay controls (only visible when an analysis is selected) */}
              {selectedAnalysis && (
                <OverlayControls
                  options={overlayOptions}
                  onChange={setOverlayOptions}
                />
              )}
            </div>

            {/* Resizable divider */}
            <div
              className="resize-divider"
              onMouseDown={handleMouseDown}
              style={{ cursor: isResizing ? 'ew-resize' : 'ew-resize' }}
            >
              <div className="resize-handle"></div>
            </div>

            {/* Right side with image display */}
            <div className="image-view-content">
              <ImageDisplay
                key={`display:${routeInstanceKey}`}
                imageId={imageId}
                image={image}
                isTransitioning={isTransitioning}
                projectId={projectId}
                setImage={updateCurrentImage}
                refreshProjectImages={loadProjectImages}
                navigateToPreviousImage={navigateToPreviousImage}
                navigateToNextImage={navigateToNextImage}
                currentImageIndex={currentImageIndex}
                projectImages={projectImages}
                selectedAnalysis={selectedAnalysis}
                annotations={selectedAnnotations}
                overlayOptions={overlayOptions}
                calibration={calibration}
                measurements={measurements}
                measurementActive={measurementActive}
                setMeasurementActive={setRouteMeasurementActive}
                onSaveMeasurement={projectArchived === false ? handleSaveMeasurement : undefined}
                selectedMeasurementId={selectedMeasurementId}
                visibleMeasurementIds={visibleMeasurementIds}
              />
            </div>
          </div>

          {/* Keep deletion controls at the bottom for all to see (hidden for archived projects) */}
          {projectArchived === false && (
            <ImageDeletionControls
              key={`deletion:${routeInstanceKey}`}
              projectId={projectId}
              image={image}
              setImage={updateCurrentImage}
              refreshProjectImages={loadProjectImages}
            />
          )}

          {/* Navigation settings */}
          <div style={{
            marginTop: '1rem',
            padding: '0.75rem',
            background: 'var(--bg-secondary, #f8f9fa)',
            borderRadius: '6px',
            border: '1px solid var(--border-color, #dee2e6)'
          }}>
            <label style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
              fontSize: '0.9rem',
              cursor: 'pointer',
              userSelect: 'none'
            }}>
              <input
                type="checkbox"
                checked={skipDeletedImages}
                onChange={(e) => setSkipDeletedImages(e.target.checked)}
                style={{ cursor: 'pointer' }}
              />
              <span>Skip deleted images when navigating (arrow keys)</span>
            </label>
            <div style={{
              marginTop: '0.5rem',
              fontSize: '0.85rem',
              color: 'var(--text-muted, #6c757d)',
              paddingLeft: '1.5rem'
            }}>
              When enabled, arrow key navigation will automatically skip over soft-deleted images.
            </div>
          </div>

          {/* Debug ML outputs section */}
          {imageId && (
            <div style={{ marginTop: '1rem' }}>
              <MLDebugOutputs imageId={imageId} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ImageView;
