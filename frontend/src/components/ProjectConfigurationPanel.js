import React, {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { PROJECT_PHASE_LABELS, PROJECT_PHASE_SEQUENCE } from '../utils/projectPhases';
import { UI_SECTION_GROUPS, isUiSectionEnabled, normalizeUiSections } from '../utils/uiSections';
import { buildErrorWithServiceDiagnostics } from '../utils/serviceDiagnostics';
import {
  DEFAULT_PT3_3D_GUIDE_SETTINGS,
  PT3_3D_GUIDE_LIMITS,
  getPt3GuideAppearance,
  normalizePt3GuideSettings,
} from '../utils/pt3GuideSettings';
import {
  MM_PER_INCH,
  areCalibrationScalesConsistent,
} from '../utils/calibration';
import { metadataKeyFromFilenameEntry } from './FilenameMetadataExtractor';



const PT3_GUIDE_FIELDS = Object.freeze({
  crosshair_transparency_percent: Object.freeze({
    label: 'Crosshair transparency',
    limits: PT3_3D_GUIDE_LIMITS.transparencyPercent,
    unit: '%',
  }),
  crosshair_line_width_px: Object.freeze({
    label: 'Crosshair line width',
    limits: PT3_3D_GUIDE_LIMITS.lineWidthPx,
    unit: 'px',
  }),
  plane_outline_transparency_percent: Object.freeze({
    label: 'Plane outline transparency',
    limits: PT3_3D_GUIDE_LIMITS.transparencyPercent,
    unit: '%',
  }),
  plane_outline_line_width_px: Object.freeze({
    label: 'Plane outline line width',
    limits: PT3_3D_GUIDE_LIMITS.lineWidthPx,
    unit: 'px',
    description: 'The selected plane uses this width; the other planes use half for visual hierarchy.',
  }),
});

function formatPt3GuideValue(value, unit) {
  if (unit === '%') return `${Math.round(value)}%`;
  return `${Number(value).toFixed(2).replace(/\.?0+$/, '')} px`;
}

function Pt3GuideRangeControl({ field, value, onChange }) {
  const definition = PT3_GUIDE_FIELDS[field];
  const controlId = `pt3-guide-${field.replaceAll('_', '-')}`;
  const descriptionId = definition.description ? `${controlId}-description` : undefined;
  return (
    <div className="pt3-guide-control">
      <span className="pt3-guide-control-heading">
        <label htmlFor={controlId}>{definition.label}</label>
        <output>{formatPt3GuideValue(value, definition.unit)}</output>
      </span>
      <input
        id={controlId}
        type="range"
        aria-label={definition.label}
        min={definition.limits.min}
        max={definition.limits.max}
        step={definition.limits.step}
        value={value}
        aria-describedby={descriptionId}
        onChange={(event) => onChange(field, Number(event.target.value))}
      />
      {definition.description && (
        <small id={descriptionId} className="pt3-guide-control-note">
          {definition.description}
        </small>
      )}
    </div>
  );
}

function Pt3GuidePreview({ settings }) {
  const appearance = getPt3GuideAppearance(settings);
  const inactivePlaneWidth = appearance.planeOutlineLineWidthPx / 2;
  return (
    <figure className="pt3-guide-preview">
      <svg
        viewBox="0 0 260 158"
        role="img"
        aria-label="Live 3D guide appearance preview"
        data-testid="pt3-guide-preview"
      >
        <title>Live 3D guide appearance preview</title>
        <desc>Three orthogonal slice planes and their shared crosshair.</desc>
        <defs>
          <linearGradient id="pt3-guide-preview-bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#0f172a" />
            <stop offset="1" stopColor="#020617" />
          </linearGradient>
        </defs>
        <rect width="260" height="158" rx="12" fill="url(#pt3-guide-preview-bg)" />
        <path
          d="M53 43 L174 24 L218 61 L96 80 Z M53 43 L53 111 L96 139 L96 80 M96 139 L218 112 L218 61"
          fill="none"
          stroke="rgba(148,163,184,0.26)"
          strokeWidth="1"
        />
        <g
          fill="none"
          opacity={appearance.planeOutlineOpacity}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        >
          <path
            d="M62 72 L183 50 L211 73 L90 97 Z"
            stroke="#3b82f6"
            strokeWidth={appearance.planeOutlineLineWidthPx}
          />
          <path
            d="M81 40 L160 31 L160 121 L81 132 Z"
            stroke="#f59e0b"
            strokeWidth={inactivePlaneWidth}
          />
          <path
            d="M123 34 L199 66 L178 124 L103 91 Z"
            stroke="#10b981"
            strokeWidth={inactivePlaneWidth}
          />
        </g>
        <g
          fill="none"
          opacity={appearance.crosshairOpacity}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        >
          <path d="M62 83 L211 68" stroke="#3b82f6" strokeWidth={appearance.crosshairLineWidthPx} />
          <path d="M82 86 L188 77" stroke="#f59e0b" strokeWidth={appearance.crosshairLineWidthPx} />
          <path d="M136 37 L136 128" stroke="#10b981" strokeWidth={appearance.crosshairLineWidthPx} />
          <circle cx="136" cy="78" r="4.2" fill="#f8fafc" stroke="#020617" strokeWidth="2" />
        </g>
      </svg>
      <figcaption aria-live="polite">
        Crosshair {settings.crosshair_transparency_percent}% transparent
        <span aria-hidden="true"> · </span>
        Plane outlines {settings.plane_outline_transparency_percent}% transparent
      </figcaption>
    </figure>
  );
}

function isValidOptionalPt3GuideSettings(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(PT3_GUIDE_FIELDS).every(([field, definition]) => {
    const candidate = value[field];
    if (candidate === undefined) return true;
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) return false;
    if (candidate < definition.limits.min || candidate > definition.limits.max) return false;
    return definition.unit !== '%' || Number.isInteger(candidate);
  });
}

function isValidOptionalProjectCalibration(value) {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  if (
    !areCalibrationScalesConsistent(value.pixels_per_mm, value.pixels_per_inch)
    || !['mm', 'inches'].includes(value.unit)
  ) {
    return false;
  }
  return value.updated_at === undefined
    || value.updated_at === null
    || (typeof value.updated_at === 'string' && Number.isFinite(Date.parse(value.updated_at)));
}

function formatCalibrationScale(value) {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return '';
  return Number(Number(value).toPrecision(12)).toString();
}

function getProjectAccessGroup(project) {
  return typeof project?.meta_group_id === 'string' ? project.meta_group_id : '';
}

function getValidatedAccessGroupProject(payload, expectedProjectId, expectedAccessGroup) {
  const hasValidShape = (
    payload !== null
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && String(payload.id) === String(expectedProjectId)
    && payload.meta_group_id === expectedAccessGroup
    && typeof payload.name === 'string'
    && typeof payload.project_type === 'string'
    && typeof payload.is_archived === 'boolean'
  );
  if (!hasValidShape) {
    throw new Error('Failed to update Access Group (invalid project response).');
  }
  return payload;
}

function ProjectAccessGroupControl({
  project,
  projectId,
  onProjectUpdated,
}) {
  const idPrefix = useId();
  const initialAccessGroup = getProjectAccessGroup(project);
  const [draftAccessGroup, setDraftAccessGroup] = useState(initialAccessGroup);
  const [savedAccessGroup, setSavedAccessGroup] = useState(initialAccessGroup);
  const [savingAccessGroup, setSavingAccessGroup] = useState(false);
  const [accessGroupError, setAccessGroupError] = useState('');
  const [accessGroupStatus, setAccessGroupStatus] = useState('');
  const requestTokenRef = useRef(0);
  const savedAccessGroupRef = useRef(initialAccessGroup);
  const syncedProjectRef = useRef({
    id: project?.id || projectId || '',
    accessGroup: initialAccessGroup,
  });

  useEffect(() => {
    const nextProjectId = project?.id || projectId || '';
    const nextAccessGroup = getProjectAccessGroup(project);
    const previousSync = syncedProjectRef.current;
    const identityChanged = previousSync.id !== nextProjectId;
    const acknowledgesLocalSave = !identityChanged
      && nextAccessGroup === savedAccessGroupRef.current;

    requestTokenRef.current += 1;
    syncedProjectRef.current = {
      id: nextProjectId,
      accessGroup: nextAccessGroup,
    };
    savedAccessGroupRef.current = nextAccessGroup;
    setDraftAccessGroup(nextAccessGroup);
    setSavedAccessGroup(nextAccessGroup);
    setSavingAccessGroup(false);
    setAccessGroupError('');
    if (!acknowledgesLocalSave) {
      setAccessGroupStatus('');
    }
  }, [project?.id, project?.is_archived, project?.meta_group_id, projectId]);

  const trimmedAccessGroup = draftAccessGroup.trim();
  const accessGroupUnchanged = trimmedAccessGroup === savedAccessGroup;
  const readOnly = project?.is_archived === true;

  const updateAccessGroup = async () => {
    if (!trimmedAccessGroup) {
      setAccessGroupError('Access Group is required.');
      setAccessGroupStatus('');
      return;
    }
    if (trimmedAccessGroup.length > 255) {
      setAccessGroupError('Access Group must be 255 characters or fewer.');
      setAccessGroupStatus('');
      return;
    }
    if (readOnly || savingAccessGroup || accessGroupUnchanged) return;

    const targetProjectId = project?.id || projectId;
    if (!targetProjectId) {
      setAccessGroupError('Project details are unavailable. Reload the project and try again.');
      setAccessGroupStatus('');
      return;
    }

    const requestToken = requestTokenRef.current + 1;
    requestTokenRef.current = requestToken;
    setSavingAccessGroup(true);
    setAccessGroupError('');
    setAccessGroupStatus('');

    try {
      const response = await fetch(`/api/projects/${targetProjectId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta_group_id: trimmedAccessGroup }),
      });
      const payload = await parseJsonSafely(response);
      if (!response.ok) {
        const detail = typeof payload?.detail === 'string'
          ? payload.detail
          : `Failed to update Access Group (${response.status})`;
        throw new Error(detail);
      }
      if (requestToken !== requestTokenRef.current) return;

      const updatedProject = getValidatedAccessGroupProject(
        payload,
        targetProjectId,
        trimmedAccessGroup,
      );
      const nextSavedAccessGroup = updatedProject.meta_group_id;
      savedAccessGroupRef.current = nextSavedAccessGroup;
      setSavedAccessGroup(nextSavedAccessGroup);
      setDraftAccessGroup(nextSavedAccessGroup);
      setAccessGroupError('');
      setAccessGroupStatus('Access Group updated.');
      if (typeof onProjectUpdated === 'function') {
        onProjectUpdated(updatedProject);
      }
    } catch (err) {
      if (requestToken !== requestTokenRef.current) return;
      setAccessGroupError(err.message || 'Failed to update Access Group.');
      setAccessGroupStatus('');
    } finally {
      if (requestToken === requestTokenRef.current) {
        setSavingAccessGroup(false);
      }
    }
  };

  const headingId = `${idPrefix}-project-access-group-heading`;
  const inputId = `${idPrefix}-project-access-group`;
  const errorId = `${idPrefix}-project-access-group-error`;
  const statusId = `${idPrefix}-project-access-group-status`;
  const warningId = `${idPrefix}-project-access-group-warning`;

  return (
    <section className="part-detail-panel" aria-labelledby={headingId}>
      <h3 id={headingId}>Access Group</h3>
      <p>
        Set the identity group that can open and manage this project.
      </p>
      <div id={warningId} className="alert alert-warning" role="note">
        <strong>Security boundary:</strong>
        {' '}
        changing this value immediately changes project access. You must belong to the destination group.
      </div>
      <label htmlFor={inputId}>Access Group</label>
      <div className="workbench-controls-row">
        <input
          id={inputId}
          className="form-control"
          type="text"
          maxLength={255}
          value={draftAccessGroup}
          disabled={readOnly || savingAccessGroup}
          aria-invalid={Boolean(accessGroupError)}
          aria-describedby={[
            warningId,
            accessGroupError ? errorId : '',
            accessGroupStatus ? statusId : '',
          ].filter(Boolean).join(' ')}
          onChange={(event) => {
            setDraftAccessGroup(event.target.value);
            setAccessGroupError('');
            setAccessGroupStatus('');
          }}
        />
        <button
          className="btn btn-primary"
          type="button"
          disabled={readOnly || savingAccessGroup || accessGroupUnchanged}
          onClick={updateAccessGroup}
        >
          {savingAccessGroup ? 'Updating Access Group...' : 'Update Access Group'}
        </button>
      </div>
      {readOnly && <p className="muted">Archived projects are read-only.</p>}
      {accessGroupError && (
        <div id={errorId} className="alert alert-error" role="alert">
          {accessGroupError}
        </div>
      )}
      {accessGroupStatus && (
        <div id={statusId} className="alert alert-success" role="status">
          {accessGroupStatus}
        </div>
      )}
    </section>
  );
}

function ProjectCalibrationControl({
  calibration,
  disabled,
  onChange,
  onValidityChange,
}) {
  const calibrationIsSet = isValidOptionalProjectCalibration(calibration) && calibration != null;
  const persistedUnit = calibration?.unit === 'inches' ? 'inches' : 'mm';
  const [unit, setUnit] = useState(persistedUnit);
  const [scaleTouched, setScaleTouched] = useState(false);
  const [draftScale, setDraftScale] = useState(() => (
    calibrationIsSet
      ? formatCalibrationScale(
        persistedUnit === 'inches' ? calibration.pixels_per_inch : calibration.pixels_per_mm,
      )
      : ''
  ));

  useEffect(() => {
    const nextUnit = calibration?.unit === 'inches' ? 'inches' : 'mm';
    setUnit(nextUnit);
    setDraftScale(calibration && isValidOptionalProjectCalibration(calibration)
      ? formatCalibrationScale(
        nextUnit === 'inches' ? calibration.pixels_per_inch : calibration.pixels_per_mm,
      )
      : '');
    setScaleTouched(false);
    onValidityChange(true);
  }, [
    calibration,
    calibration?.pixels_per_inch,
    calibration?.pixels_per_mm,
    calibration?.unit,
    onValidityChange,
  ]);

  const updateScale = (nextDraft) => {
    setDraftScale(nextDraft);
    setScaleTouched(true);
    const pixelsPerSelectedUnit = Number(nextDraft);
    const selectedScaleIsValid = nextDraft !== ''
      && Number.isFinite(pixelsPerSelectedUnit)
      && pixelsPerSelectedUnit > 0;
    const pixelsPerMm = unit === 'mm'
      ? pixelsPerSelectedUnit
      : pixelsPerSelectedUnit / MM_PER_INCH;
    const pixelsPerInch = pixelsPerMm * MM_PER_INCH;
    const nextScaleIsValid = selectedScaleIsValid
      && areCalibrationScalesConsistent(pixelsPerMm, pixelsPerInch);
    onValidityChange(nextScaleIsValid);
    if (!nextScaleIsValid) return;
    onChange({
      pixels_per_mm: pixelsPerMm,
      pixels_per_inch: pixelsPerInch,
      unit,
      updated_at: new Date().toISOString(),
    });
  };

  const updateUnit = (nextUnit) => {
    setUnit(nextUnit);
    setScaleTouched(false);
    onValidityChange(true);
    if (!calibrationIsSet) {
      setDraftScale('');
      return;
    }
    setDraftScale(formatCalibrationScale(
      nextUnit === 'inches' ? calibration.pixels_per_inch : calibration.pixels_per_mm,
    ));
    onChange({
      ...calibration,
      unit: nextUnit,
      updated_at: new Date().toISOString(),
    });
  };

  const draftPixelsPerSelectedUnit = Number(draftScale);
  const draftPixelsPerMm = unit === 'mm'
    ? draftPixelsPerSelectedUnit
    : draftPixelsPerSelectedUnit / MM_PER_INCH;
  const scaleIsInvalid = scaleTouched && (
    draftScale === ''
    || !areCalibrationScalesConsistent(
      draftPixelsPerMm,
      draftPixelsPerMm * MM_PER_INCH,
    )
  );
  const inputLabel = unit === 'inches' ? 'Pixels per inch' : 'Pixels per millimeter';
  const scaleDescriptionId = 'project-calibration-scale-description';
  const validationMessageId = 'project-calibration-scale-error';

  return (
    <section
      className="part-detail-panel project-calibration-card"
      aria-labelledby="project-calibration-heading"
    >
      <div className="project-calibration-heading">
        <div>
          <span>METROLOGY · PROJECT DEFAULT</span>
          <h3 id="project-calibration-heading">Project Calibration</h3>
        </div>
        <strong className={calibrationIsSet ? 'is-set' : ''}>
          {calibrationIsSet ? 'CALIBRATED' : 'NOT SET'}
        </strong>
      </div>
      <p>
        Set the global image scale used when an image has no session, image, or metadata-rule calibration.
      </p>
      <div className="project-calibration-controls">
        <label htmlFor="project-calibration-unit">Calibration unit</label>
        <select
          id="project-calibration-unit"
          aria-label="Project calibration unit"
          value={unit}
          disabled={disabled}
          onChange={(event) => updateUnit(event.target.value)}
        >
          <option value="mm">Millimeters (mm)</option>
          <option value="inches">Inches (in)</option>
        </select>

        <label htmlFor="project-calibration-scale">{inputLabel}</label>
        <div className="project-calibration-scale-field">
          <input
            id="project-calibration-scale"
            aria-label={inputLabel}
            aria-describedby={`${scaleDescriptionId}${scaleIsInvalid ? ` ${validationMessageId}` : ''}`}
            aria-invalid={scaleIsInvalid}
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            placeholder={unit === 'inches' ? 'e.g. 254' : 'e.g. 10'}
            value={draftScale}
            disabled={disabled}
            onChange={(event) => updateScale(event.target.value)}
          />
          <span>px/{unit === 'inches' ? 'in' : 'mm'}</span>
        </div>
      </div>
      <small id={scaleDescriptionId}>
        Enter a positive scale. VISTA stores the equivalent millimeter and inch values.
      </small>
      {scaleIsInvalid && (
        <div id={validationMessageId} className="project-calibration-error" role="alert">
          Calibration must be a positive finite number.
        </div>
      )}
      <div className="project-calibration-footer">
        <output aria-live="polite">
          {calibrationIsSet
            ? `1 ${unit === 'inches' ? 'in' : 'mm'} = ${formatCalibrationScale(
              unit === 'inches' ? calibration.pixels_per_inch : calibration.pixels_per_mm,
            )} px`
            : 'Measurements fall back to legacy project metadata when available.'}
        </output>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={disabled || calibration == null}
          onClick={() => {
            setScaleTouched(false);
            onValidityChange(true);
            onChange(null);
          }}
        >
          Clear Calibration
        </button>
      </div>
    </section>
  );
}

function collectUiSectionMatches(groups = UI_SECTION_GROUPS, query = '') {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];
  const matches = [];
  const visit = (group, path = []) => {
    const nextPath = [...path, group.id];
    if (group.label.toLowerCase().includes(normalizedQuery)) {
      matches.push({ type: 'group', key: group.id, label: group.label, path: nextPath });
    }
    (group.sections || []).forEach((section) => {
      if (section.label.toLowerCase().includes(normalizedQuery) || section.key.toLowerCase().includes(normalizedQuery)) {
        matches.push({ type: 'section', key: section.key, label: section.label, path: nextPath });
      }
    });
    (group.children || []).forEach((child) => visit(child, nextPath));
  };
  groups.forEach((group) => visit(group));
  return matches;
}

function collectUiSectionKeys(group) {
  return [
    ...(group.primarySectionKey ? [group.primarySectionKey] : []),
    ...(group.sections || []).map((section) => section.key),
    ...(group.children || []).flatMap((childGroup) => collectUiSectionKeys(childGroup)),
  ];
}

function ConfigurableUiSectionGroup({ group, config, setConfig, expandedGroups, toggleGroup, highlightedKey, level = 0 }) {
  const isExpanded = expandedGroups.includes(group.id);
  const normalizedSections = normalizeUiSections(config);
  const groupSectionKeys = collectUiSectionKeys(group);
  const enabledSectionCount = groupSectionKeys.filter((key) => normalizedSections[key] !== false).length;
  const allGroupSectionsEnabled = groupSectionKeys.length === 0 || enabledSectionCount === groupSectionKeys.length;
  const someGroupSectionsEnabled = enabledSectionCount > 0 && enabledSectionCount < groupSectionKeys.length;
  const groupCheckboxRef = useRef(null);

  useEffect(() => {
    if (groupCheckboxRef.current) {
      groupCheckboxRef.current.indeterminate = someGroupSectionsEnabled;
    }
  }, [someGroupSectionsEnabled]);

  const setGroupEnabled = (checked) => {
    setConfig((previous) => {
      const nextUiSections = { ...normalizeUiSections(previous) };
      groupSectionKeys.forEach((sectionKey) => {
        nextUiSections[sectionKey] = checked;
      });
      return {
        ...previous,
        ui_sections: nextUiSections,
      };
    });
  };

  return (
    <div className="configurable-ui-section-group" data-depth={level}>
      <div className={`configurable-ui-section-summary ${highlightedKey === group.id ? 'search-highlight' : ''}`}>
        <button
          type="button"
          className="configurable-ui-section-expander"
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${group.label}`}
          aria-expanded={isExpanded}
          onClick={() => toggleGroup(group.id)}
        >
          {isExpanded ? '-' : '+'}
        </button>
        <label className="configurable-ui-section-check-label">
          <input
            ref={groupCheckboxRef}
            type="checkbox"
            checked={allGroupSectionsEnabled}
            onChange={(event) => setGroupEnabled(event.target.checked)}
          />
          <span>{group.label}</span>
        </label>
        {(group.sections || []).length > 0 && (
          <span className="configurable-ui-section-count">{group.sections.length} section{group.sections.length === 1 ? '' : 's'}</span>
        )}
      </div>
      {isExpanded && (
        <div className="configurable-ui-section-body">
          {group.description && <p className="muted">{group.description}</p>}
          {(group.sections || []).length > 0 && (
            <div className="configurable-ui-section-options">
              {group.sections.map((section) => (
                <label key={section.key} className={`configurable-ui-section-leaf ${highlightedKey === section.key ? 'search-highlight' : ''}`}>
                  <span className="configurable-ui-section-expander-spacer" aria-hidden="true" />
                  <input
                    type="checkbox"
                    checked={normalizedSections[section.key] !== false}
                    onChange={(event) => {
                      setConfig((previous) => ({
                        ...previous,
                        ui_sections: {
                          ...normalizeUiSections(previous),
                          [section.key]: event.target.checked,
                        },
                      }));
                    }}
                  />
                  <span>{section.label}</span>
                </label>
              ))}
            </div>
          )}
          {(group.children || []).length > 0 && (
            <div className="configurable-ui-section-children">
              {group.children.map((childGroup) => (
                <ConfigurableUiSectionGroup
                  key={childGroup.id}
                  group={childGroup}
                  config={config}
                  setConfig={setConfig}
                  expandedGroups={expandedGroups}
                  toggleGroup={toggleGroup}
                  highlightedKey={highlightedKey}
                  level={level + 1}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function isSingleAlphanumeric(value) {
  return /^[a-z0-9]$/i.test((value || '').trim());
}

function normalizeLower(value) {
  return (value || '').trim().toLowerCase();
}

async function parseJsonSafely(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

function getCloneConfigOrThrow(cloneResponseData) {
  if (!cloneResponseData || typeof cloneResponseData !== 'object' || !cloneResponseData.config) {
    throw new Error('Failed to copy project configuration (missing config payload)');
  }
  const clonedConfig = cloneResponseData.config;
  const hasValidTopLevelShape =
    typeof clonedConfig === 'object' &&
    Array.isArray(clonedConfig.image_modalities) &&
    Array.isArray(clonedConfig.part_views) &&
    Array.isArray(clonedConfig.defect_types) &&
    clonedConfig.process_settings &&
    typeof clonedConfig.process_settings === 'object' &&
    clonedConfig.display_settings &&
    typeof clonedConfig.display_settings === 'object';

  if (!hasValidTopLevelShape) {
    throw new Error('Failed to copy project configuration (invalid config payload shape)');
  }

  const hasValidCollectionEntries =
    clonedConfig.image_modalities.every(
      (modality) => modality && typeof modality === 'object',
    ) &&
    clonedConfig.part_views.every(
      (partView) =>
        partView &&
        typeof partView === 'object' &&
        Array.isArray(partView.required_modalities || []),
    ) &&
    clonedConfig.defect_types.every(
      (defectType) => defectType && typeof defectType === 'object',
    );

  if (!hasValidCollectionEntries) {
    throw new Error('Failed to copy project configuration (invalid config payload entries)');
  }

  const hasValidScalarFields =
    clonedConfig.image_modalities.every(
      (modality) => typeof modality.id === 'string' && typeof modality.label === 'string',
    ) &&
    clonedConfig.part_views.every(
      (partView) =>
        typeof partView.id === 'string' &&
        typeof partView.label === 'string' &&
        partView.required_modalities.every((requiredModality) => typeof requiredModality === 'string'),
    ) &&
    clonedConfig.defect_types.every(
      (defectType) => typeof defectType.name === 'string' && typeof defectType.color === 'string',
    );

  if (!hasValidScalarFields) {
    throw new Error('Failed to copy project configuration (invalid config scalar fields)');
  }

  const hasValidSemanticScalarFields =
    clonedConfig.image_modalities.every(
      (modality) => normalizeLower(modality.id).length > 0 && (modality.label || '').trim().length > 0,
    ) &&
    clonedConfig.part_views.every(
      (partView) =>
        normalizeLower(partView.id).length > 0 &&
        (partView.label || '').trim().length > 0 &&
        partView.required_modalities.every(
          (requiredModality) => normalizeLower(requiredModality).length > 0,
        ),
    ) &&
    clonedConfig.defect_types.every(
      (defectType) =>
        (defectType.name || '').trim().length > 0 &&
        /^#[0-9a-fA-F]{6}$/.test((defectType.color || '').trim()),
    );

  if (!hasValidSemanticScalarFields) {
    throw new Error('Failed to copy project configuration (invalid config semantic fields)');
  }

  const hasValidSettingsFields =
    typeof clonedConfig.process_settings.require_disposition_on_submit === 'boolean' &&
    typeof clonedConfig.process_settings.require_measurement_for_critical === 'boolean' &&
    typeof clonedConfig.process_settings.require_second_reviewer_for_reject === 'boolean' &&
    clonedConfig.process_settings.configurable_hotkeys &&
    typeof clonedConfig.process_settings.configurable_hotkeys === 'object' &&
    typeof clonedConfig.process_settings.configurable_hotkeys.accept_classification === 'string' &&
    typeof clonedConfig.process_settings.configurable_hotkeys.reject_classification === 'string' &&
    typeof clonedConfig.process_settings.configurable_hotkeys.toggle_shortcut_help === 'string' &&
    typeof clonedConfig.display_settings.default_colormap === 'string' &&
    typeof clonedConfig.display_settings.anomaly_colormap === 'string' &&
    typeof clonedConfig.display_settings.grayscale_base_image === 'boolean' &&
    isValidOptionalPt3GuideSettings(clonedConfig.display_settings.pt3_3d_guides) &&
    isValidOptionalProjectCalibration(clonedConfig.calibration);

  if (!hasValidSettingsFields) {
    throw new Error('Failed to copy project configuration (invalid config settings fields)');
  }

  const allowedColormaps = new Set(['grayscale', 'magma', 'viridis']);
  const hasValidDomainFields =
    clonedConfig.part_views.every(
      (partView) => !partView.source || partView.source === 'manual' || partView.source === 'auto',
    ) &&
    allowedColormaps.has(clonedConfig.display_settings.default_colormap) &&
    allowedColormaps.has(clonedConfig.display_settings.anomaly_colormap);

  if (!hasValidDomainFields) {
    throw new Error('Failed to copy project configuration (invalid config domain fields)');
  }

  const cloneHotkeys = clonedConfig.process_settings.configurable_hotkeys || {};
  const normalizedCloneHotkeys = [
    normalizeLower(cloneHotkeys.accept_classification),
    normalizeLower(cloneHotkeys.reject_classification),
    normalizeLower(cloneHotkeys.toggle_shortcut_help),
  ];
  const hasValidHotkeyDomainFields =
    normalizedCloneHotkeys.every((hotkeyValue) => isSingleAlphanumeric(hotkeyValue)) &&
    new Set(normalizedCloneHotkeys).size === normalizedCloneHotkeys.length;

  if (!hasValidHotkeyDomainFields) {
    throw new Error('Failed to copy project configuration (invalid config hotkey domain fields)');
  }

  const normalizedModalityIds = clonedConfig.image_modalities.map((modality) => normalizeLower(modality.id));
  const normalizedPartViewIds = clonedConfig.part_views.map((partView) => normalizeLower(partView.id));
  const normalizedDefectNames = clonedConfig.defect_types.map((defectType) => normalizeLower(defectType.name));
  const hasDuplicateModalityIds = new Set(normalizedModalityIds).size !== normalizedModalityIds.length;
  const hasDuplicatePartViewIds = new Set(normalizedPartViewIds).size !== normalizedPartViewIds.length;
  const hasDuplicateDefectNames = new Set(normalizedDefectNames).size !== normalizedDefectNames.length;
  const hasUnknownRequiredModalities = clonedConfig.part_views.some((partView) =>
    partView.required_modalities.some(
      (requiredModalityId) => !normalizedModalityIds.includes(normalizeLower(requiredModalityId)),
    ),
  );

  if (hasDuplicateModalityIds || hasDuplicatePartViewIds || hasDuplicateDefectNames || hasUnknownRequiredModalities) {
    throw new Error('Failed to copy project configuration (invalid config relational fields)');
  }

  return clonedConfig;
}

function validateConfiguration(config) {
  const errors = [];

  const modalities = (config.image_modalities || []).map((modality) => ({
    id: normalizeLower(modality.id),
    label: (modality.label || '').trim(),
  }));
  const modalityIds = modalities.map((modality) => modality.id).filter(Boolean);
  const duplicateModalityIds = modalityIds.filter((id, index) => modalityIds.indexOf(id) !== index);

  if (modalities.some((modality) => !modality.id || !modality.label)) {
    errors.push('Each modality requires both a filename value and label.');
  }
  if (duplicateModalityIds.length > 0) {
    errors.push('Modality filename values must be unique.');
  }

  const partViews = (config.part_views || []).map((view) => ({
    id: normalizeLower(view.id),
    label: (view.label || '').trim(),
    required_modalities: (view.required_modalities || []).map(normalizeLower).filter(Boolean),
  }));
  const partViewIds = partViews.map((view) => view.id).filter(Boolean);
  const duplicatePartViewIds = partViewIds.filter((id, index) => partViewIds.indexOf(id) !== index);

  if (partViews.some((view) => !view.id || !view.label)) {
    errors.push('Each side requires both a filename value and label.');
  }
  if (duplicatePartViewIds.length > 0) {
    errors.push('Side filename values must be unique.');
  }

  const unknownModalityReference = partViews.some((view) =>
    view.required_modalities.some((requiredModality) => !modalityIds.includes(requiredModality)),
  );
  if (unknownModalityReference) {
    errors.push('Stored side modality requirements must reference configured modalities.');
  }

  const defectTypes = (config.defect_types || []).map((defectType) => ({
    name: (defectType.name || '').trim(),
    color: (defectType.color || '').trim(),
  }));
  if (defectTypes.some((defectType) => !defectType.name)) {
    errors.push('Each defect type requires a name.');
  }
  const normalizedDefectNames = defectTypes.map((defectType) => normalizeLower(defectType.name)).filter(Boolean);
  const duplicateDefectNames = normalizedDefectNames.filter(
    (name, index) => normalizedDefectNames.indexOf(name) !== index,
  );
  if (duplicateDefectNames.length > 0) {
    errors.push('Defect type names must be unique (case-insensitive).');
  }
  if (defectTypes.some((defectType) => !/^#[0-9a-fA-F]{6}$/.test(defectType.color))) {
    errors.push('Defect type colors must be valid 6-digit hex values (for example #ef4444).');
  }

  const hotkeys = config.process_settings?.configurable_hotkeys || {};
  const hotkeyValues = [
    normalizeLower(hotkeys.accept_classification),
    normalizeLower(hotkeys.reject_classification),
    normalizeLower(hotkeys.toggle_shortcut_help),
  ];

  if (hotkeyValues.some((hotkeyValue) => !isSingleAlphanumeric(hotkeyValue))) {
    errors.push('Hotkeys must be single alphanumeric characters.');
  }
  if (new Set(hotkeyValues).size !== hotkeyValues.length) {
    errors.push('Hotkeys must be unique across accept, reject, and help actions.');
  }
  if (!isValidOptionalProjectCalibration(config.calibration)) {
    errors.push('Project calibration requires positive finite pixel scales and a valid unit.');
  }

  return errors;
}

const EMPTY_CONFIG = {
  image_modalities: [],
  part_views: [],
  defect_types: [],
  process_settings: {
    require_disposition_on_submit: true,
    require_measurement_for_critical: false,
    require_second_reviewer_for_reject: false,
    configurable_hotkeys: {
      accept_classification: 'a',
      reject_classification: 'r',
      toggle_shortcut_help: 'h',
    },
  },
  display_settings: {
    default_colormap: 'grayscale',
    anomaly_colormap: 'viridis',
    grayscale_base_image: true,
    pt3_3d_guides: {
      ...DEFAULT_PT3_3D_GUIDE_SETTINGS,
    },
  },
  serial_number_scheme: {
    batch_sn_enabled: true,
    sub_batching_enabled: false,
    sub_batch_sn_enabled: false,
    part_sn_enabled: true,
  },
  phase_settings: {
    manual_phase_selection_enabled: false,
    manual_phase: 'data_ingestion',
  },
  metadata_parsers: {
    nsipro: {
      parser_id: 'default',
    },
  },
  project_owner: {
    name: '',
    email: '',
  },
  current_user: {
    username: '',
    sso_authenticated: false,
  },
  ui_sections: normalizeUiSections(),
  file_naming_scheme: {
    use_filename_convention: true,
    hierarchy_levels: [
      { id: 'drawing_number', label: 'Drawing Number', abbreviation: 'D' },
      { id: 'part_number', label: 'Part Number', abbreviation: 'P' },
      { id: 'lot_number', label: 'Lot Number', abbreviation: 'L' },
      { id: 'serial_number', label: 'Serial Number', abbreviation: 'S' },
      { id: 'revision', label: 'Revision', abbreviation: 'R' },
    ],
    image_descriptors: [
      { id: 'view', label: 'View', abbreviation: 'V' },
      { id: 'modality', label: 'Modality', abbreviation: 'M' },
    ],
    overlay_indicator: {
      enabled: true,
      field_key: 'overlay',
      values: ['true', 'overlay', 'ov', 'mask', 'heatmap'],
      remove_from_base_filename: true,
    },
  },
};
const FILE_NAME_ELEMENT_OPTIONS = [
  { id: 'drawing_number', label: 'Drawing Number', abbreviation: 'D' },
  { id: 'part_number', label: 'Part Number', abbreviation: 'P' },
  { id: 'lot_number', label: 'Lot Number', abbreviation: 'L' },
  { id: 'serial_number', label: 'Serial Number', abbreviation: 'S' },
  { id: 'revision', label: 'Revision', abbreviation: 'R' },
  { id: 'batch', label: 'Batch', abbreviation: 'B' },
  { id: 'sub_batch', label: 'Sub Batch', abbreviation: 'SB' },
  { id: 'timestamp', label: 'Timestamp', abbreviation: 'T' },
  { id: 'operator', label: 'Operator', abbreviation: 'O' },
  { id: 'version', label: 'Image Version', abbreviation: 'v' },
  { id: 'image_identifier', label: 'Image Identifier', abbreviation: 'IMG' },
  { id: 'image_sequence', label: 'Image Sequence', abbreviation: 'I' },
  { id: 'channel', label: 'Channel', abbreviation: 'C' },
  { id: 'wavelength', label: 'Wavelength', abbreviation: 'WL' },
  { id: 'exposure', label: 'Exposure', abbreviation: 'EXP' },
  { id: 'lighting', label: 'Lighting', abbreviation: 'LGT' },
  { id: 'view', label: 'View', abbreviation: 'V' },
  { id: 'side', label: 'Side', abbreviation: 'SIDE' },
  { id: 'modality', label: 'Modality', abbreviation: 'M' },
  { id: 'overlay', label: 'Overlay', abbreviation: 'OV' },
];

const DEFAULT_DEFECT_TYPE_COLORS = ['#ef4444', '#f59e0b', '#3b82f6'];


function getFilenameEntryName(entry, fallback) {
  const candidate = (entry?.label || entry?.id || fallback || '').trim();
  return candidate || fallback;
}

function normalizeFilenameToken(value, fallback) {
  const token = String(value || fallback || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return token || fallback;
}


function getFilenameEntryMetadataKey(entry, fallback) {
  return metadataKeyFromFilenameEntry(entry, fallback) || fallback;
}

function normalizeOverlayIndicator(source = {}) {
  const values = Array.isArray(source.values) ? source.values : String(source.values || '').split(',');
  const normalizedValues = values
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return {
    enabled: source.enabled !== false,
    field_key: String(source.field_key || 'overlay').trim() || 'overlay',
    values: normalizedValues.length > 0 ? normalizedValues : ['true', 'overlay', 'ov', 'mask', 'heatmap'],
    remove_from_base_filename: source.remove_from_base_filename !== false,
  };
}

function getDisplayTokenForFilenameEntry(entry, fallback, { hierarchy = false } = {}) {
  const prefix = String(entry?.abbreviation || '').trim();
  if (hierarchy) return `${prefix || getFilenameEntryName(entry, fallback)}001`;
  const key = getFilenameEntryMetadataKey(entry, fallback);
  if (key === 'overlay') return prefix ? `${prefix}overlay` : 'overlay';
  if (key === 'version') return `${prefix || 'v'}1`;
  if (!hierarchy && (key === 'view' || key === 'side')) return 'side';
  return normalizeFilenameToken(getFilenameEntryName(entry, fallback), fallback);
}

function buildExpectedFilenameExample(fileNamingScheme) {
  const normalizedScheme = normalizeFileNamingScheme({ file_naming_scheme: fileNamingScheme });
  const hierarchySegments = normalizedScheme.hierarchy_levels.map((level, index) =>
    getDisplayTokenForFilenameEntry(level, `level${index + 1}`, { hierarchy: true })
  );
  const descriptorSegments = normalizedScheme.image_descriptors.map((descriptor, index) =>
    getDisplayTokenForFilenameEntry(descriptor, `descriptor${index + 1}`)
  );
  const delimiter = normalizedScheme.delimiter || '_';
  return [...hierarchySegments, ...descriptorSegments].filter(Boolean).join(delimiter) + '.type';
}


const FILENAME_CONVENTION_COLORS = [
  '#2563eb',
  '#7c3aed',
  '#0891b2',
  '#16a34a',
  '#f97316',
  '#dc2626',
  '#4f46e5',
  '#0f766e',
];

function getFilenameConventionSegments(fileNamingScheme) {
  const normalizedScheme = normalizeFileNamingScheme({ file_naming_scheme: fileNamingScheme });
  const delimiter = normalizedScheme.delimiter || '_';
  const hierarchySegments = normalizedScheme.hierarchy_levels.map((level, index) => {
    return {
      type: 'hierarchy',
      index,
      key: `hierarchy-${index}`,
      label: getFilenameEntryName(level, `Level ${index + 1}`),
      token: getDisplayTokenForFilenameEntry(level, `level${index + 1}`, { hierarchy: true }),
      color: FILENAME_CONVENTION_COLORS[index % FILENAME_CONVENTION_COLORS.length],
    };
  });
  const descriptorSegments = normalizedScheme.image_descriptors.map((descriptor, index) => {
    return {
      type: 'descriptor',
      index,
      key: `descriptor-${index}`,
      label: getFilenameEntryName(descriptor, `Descriptor ${index + 1}`),
      token: getDisplayTokenForFilenameEntry(descriptor, `descriptor${index + 1}`),
      color: FILENAME_CONVENTION_COLORS[(hierarchySegments.length + index) % FILENAME_CONVENTION_COLORS.length],
    };
  });
  return {
    delimiter,
    segments: [...hierarchySegments, ...descriptorSegments],
  };
}

function normalizeProjectTypeSuffix(projectType) {
  const suffix = String(projectType || 'PT1').trim().toUpperCase();
  return suffix || 'PT1';
}

function getDefaultDefectTypes(projectType) {
  const projectTypeSuffix = normalizeProjectTypeSuffix(projectType);
  return DEFAULT_DEFECT_TYPE_COLORS.map((color, index) => ({
    name: `DefectType${index + 1}_${projectTypeSuffix}`,
    color,
    definition: '',
  }));
}

function normalizeSerialNumberScheme(config) {
  const candidate = config?.serial_number_scheme || {};
  return {
    batch_sn_enabled: candidate.batch_sn_enabled !== false,
    sub_batching_enabled: candidate.sub_batching_enabled === true,
    sub_batch_sn_enabled: candidate.sub_batch_sn_enabled === true,
    part_sn_enabled: candidate.part_sn_enabled !== false,
  };
}

function normalizePhaseSettings(config) {
  const candidate = config?.phase_settings || {};
  return {
    manual_phase_selection_enabled: candidate.manual_phase_selection_enabled === true,
    manual_phase: PROJECT_PHASE_SEQUENCE.includes(candidate.manual_phase)
      ? candidate.manual_phase
      : 'data_ingestion',
  };
}

function normalizeDisplaySettings(config) {
  const candidate = config?.display_settings;
  const source = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate
    : {};
  return {
    ...EMPTY_CONFIG.display_settings,
    ...source,
    pt3_3d_guides: normalizePt3GuideSettings(source.pt3_3d_guides),
  };
}

function normalizeProjectConfiguration(config, projectType) {
  const incomingConfig = config && typeof config === 'object' ? config : {};
  const defectTypes = Array.isArray(incomingConfig.defect_types)
    ? incomingConfig.defect_types
    : getDefaultDefectTypes(projectType);

  return {
    ...EMPTY_CONFIG,
    ...incomingConfig,
    defect_types: defectTypes,
    display_settings: normalizeDisplaySettings(incomingConfig),
    serial_number_scheme: normalizeSerialNumberScheme(incomingConfig),
    phase_settings: normalizePhaseSettings(incomingConfig),
    metadata_parsers: normalizeMetadataParsers(incomingConfig),
    ui_sections: normalizeUiSections(incomingConfig),
    file_naming_scheme: normalizeFileNamingScheme(incomingConfig),
  };
}


function normalizeMetadataParsers(config) {
  const nsipro = config?.metadata_parsers?.nsipro || {};
  const parserId = typeof nsipro.parser_id === 'string' && nsipro.parser_id.trim()
    ? nsipro.parser_id.trim()
    : EMPTY_CONFIG.metadata_parsers.nsipro.parser_id;
  return {
    nsipro: {
      ...nsipro,
      parser_id: parserId,
    },
  };
}

function normalizeFileNamingScheme(config) {
  const source = config?.file_naming_scheme || {};
  const normalizeEntry = (entry) => ({
    id: (entry?.id || 'other').trim() || 'other',
    label: (entry?.label || '').trim(),
    abbreviation: (entry?.abbreviation || '').trim(),
  });
  const defaultScheme = EMPTY_CONFIG.file_naming_scheme;
  const hierarchyLevels = Array.isArray(source.hierarchy_levels) && source.hierarchy_levels.length > 0
    ? source.hierarchy_levels.map(normalizeEntry)
    : defaultScheme.hierarchy_levels;
  const imageDescriptors = Array.isArray(source.image_descriptors) && source.image_descriptors.length > 0
    ? source.image_descriptors.map(normalizeEntry)
    : defaultScheme.image_descriptors;
  return {
    use_filename_convention: source.use_filename_convention !== false,
    hierarchy_levels: hierarchyLevels,
    image_descriptors: imageDescriptors,
    delimiter: String(source.delimiter || '_'),
    metadata_extractor: source.metadata_extractor && typeof source.metadata_extractor === 'object'
      ? source.metadata_extractor
      : null,
    overlay_indicator: normalizeOverlayIndicator(source.overlay_indicator || defaultScheme.overlay_indicator),
  };
}

const AUTOSAVE_DELAY_MS = 500;

const CONFIGURATION_SUBTABS = [
  { id: 'general', label: 'General', sectionKey: 'project_configuration.general', panelId: 'configuration-general-panel' },
  { id: 'filenameConvention', label: 'Filename Convention', sectionKey: 'project_configuration.filename_convention', panelId: 'configuration-filename-convention-panel' },
  { id: 'hotkeys', label: 'Hotkeys', sectionKey: 'project_configuration.hotkeys', panelId: 'configuration-hotkeys-panel' },
  { id: 'uiConfiguration', label: 'UI Configuration', sectionKey: 'project_configuration.ui_configuration', panelId: 'configuration-ui-panel' },
];

const GENERAL_CONFIGURATION_SECTIONS = [
  'project_configuration.owner_section',
  'project_configuration.user_section',
  'project_configuration.calibration',
  'project_configuration.process_settings',
  'project_configuration.serial_scheme',
  'project_configuration.project_phase_settings',
  'project_configuration.defect_types',
  'project_configuration.display_options',
  'project_configuration.copy_configuration',
];

const getConfigurationSignature = (configuration) => JSON.stringify(configuration || {});

const ProjectConfigurationPanel = forwardRef(function ProjectConfigurationPanel({
  projectId,
  project = null,
  projectType,
  currentInterfaceLayout = null,
  isAdminUser = false,
  onConfigurationSaved = null,
  onProjectUpdated = null,
  onActiveSubtabChange = null,
}, ref) {
  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [availableProjects, setAvailableProjects] = useState([]);
  const [currentProjectType, setCurrentProjectType] = useState('');
  const [copySourceProjectId, setCopySourceProjectId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [calibrationInputValid, setCalibrationInputValid] = useState(true);
  const [copyingConfiguration, setCopyingConfiguration] = useState(false);
  const [activeConfigurationSubtab, setActiveConfigurationSubtab] = useState('general');
  const [uiSearchQuery, setUiSearchQuery] = useState('');
  const [uiSearchIndex, setUiSearchIndex] = useState(0);
  const [expandedUiGroups, setExpandedUiGroups] = useState(['main']);
  const configRef = useRef(config);
  const autosaveTimerRef = useRef(null);
  const loadCompleteRef = useRef(false);
  const lastSavedSignatureRef = useRef(getConfigurationSignature(EMPTY_CONFIG));
  const saveLoopPromiseRef = useRef(null);
  const autosaveRequestedDuringSaveRef = useRef(false);
  const calibrationInputValidRef = useRef(true);
  const readOnly = project?.is_archived === true;

  const updateCalibrationInputValidity = useCallback((isValid) => {
    calibrationInputValidRef.current = isValid;
    setCalibrationInputValid(isValid);
  }, []);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    onActiveSubtabChange?.(activeConfigurationSubtab);
  }, [activeConfigurationSubtab, onActiveSubtabChange]);

  useEffect(() => () => {
    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (readOnly) return undefined;
    const loadCurrentUser = async () => {
      try {
        const resp = await fetch('/api/users/me');
        if (!resp.ok) return;
        const data = await resp.json();
        const username = String(data?.email || data?.username || "").trim();
        if (!username) return;
        setConfig((previous) => ({
          ...previous,
          current_user: {
            username,
            sso_authenticated: true,
          },
        }));
      } catch (_err) {}
    };
    loadCurrentUser();
    return undefined;
  }, [readOnly]);
  const [savingInterfaceLayoutDefault, setSavingInterfaceLayoutDefault] = useState(false);
  const [savingProjectTypeLayoutDefault, setSavingProjectTypeLayoutDefault] = useState(false);
  const hasCompatibleCopySources = availableProjects.length > 0;
  const selectedCopySourceProject = availableProjects.find((project) => project.id === copySourceProjectId) || null;
  const [primaryError, diagnosticError] = typeof error === 'string'
    ? error.split('\n\n', 2)
    : ['', ''];
  const uiSectionSearchResults = useMemo(() => collectUiSectionMatches(UI_SECTION_GROUPS, uiSearchQuery), [uiSearchQuery]);
  const selectedUiSectionSearchResult = uiSectionSearchResults[uiSearchIndex] || null;
  const visibleConfigurationSubtabs = useMemo(
    () => CONFIGURATION_SUBTABS.filter((subtab) => isUiSectionEnabled(config, subtab.sectionKey)),
    [config],
  );
  const visibleConfigurationSubtabIds = useMemo(
    () => new Set(visibleConfigurationSubtabs.map((subtab) => subtab.id)),
    [visibleConfigurationSubtabs],
  );
  const visibleGeneralSectionCount = useMemo(
    () => GENERAL_CONFIGURATION_SECTIONS.filter((sectionKey) => isUiSectionEnabled(config, sectionKey)).length,
    [config],
  );
  const calibrationSectionVisible = isUiSectionEnabled(
    config,
    'project_configuration.calibration',
  );
  useEffect(() => {
    if (!calibrationSectionVisible) {
      updateCalibrationInputValidity(true);
    }
  }, [calibrationSectionVisible, updateCalibrationInputValidity]);
  const isPt3Project = normalizeProjectTypeSuffix(projectType || currentProjectType) === 'PT3';
  const pt3GuideSettings = normalizePt3GuideSettings(
    config.display_settings?.pt3_3d_guides,
  );
  const pt3GuideSettingsAreDefault = Object.entries(DEFAULT_PT3_3D_GUIDE_SETTINGS)
    .every(([field, value]) => pt3GuideSettings[field] === value);

  const updatePt3GuideSetting = useCallback((field, value) => {
    setConfig((previous) => {
      const displaySettings = normalizeDisplaySettings(previous);
      return {
        ...previous,
        display_settings: {
          ...displaySettings,
          pt3_3d_guides: normalizePt3GuideSettings({
            ...displaySettings.pt3_3d_guides,
            [field]: value,
          }),
        },
      };
    });
  }, []);

  const resetPt3GuideSettings = useCallback(() => {
    setConfig((previous) => ({
      ...previous,
      display_settings: {
        ...normalizeDisplaySettings(previous),
        pt3_3d_guides: {
          ...DEFAULT_PT3_3D_GUIDE_SETTINGS,
        },
      },
    }));
  }, []);


  useEffect(() => {
    if (visibleConfigurationSubtabs.length === 0 || visibleConfigurationSubtabIds.has(activeConfigurationSubtab)) {
      return;
    }
    setActiveConfigurationSubtab(visibleConfigurationSubtabs[0].id);
  }, [activeConfigurationSubtab, visibleConfigurationSubtabIds, visibleConfigurationSubtabs]);

  useEffect(() => {
    setUiSearchIndex(0);
  }, [uiSearchQuery]);

  useEffect(() => {
    if (selectedUiSectionSearchResult) {
      setExpandedUiGroups(selectedUiSectionSearchResult.path);
    } else if (!uiSearchQuery.trim()) {
      setExpandedUiGroups((previous) => (previous.length > 0 ? previous : ['main']));
    }
  }, [selectedUiSectionSearchResult, uiSearchQuery]);

  const toggleUiGroup = useCallback((groupId) => {
    setExpandedUiGroups((previous) => (previous.includes(groupId)
      ? previous.filter((id) => id !== groupId)
      : [...previous, groupId]));
  }, []);

  const normalizedFileNamingScheme = normalizeFileNamingScheme(config);
  const filenameConvention = useMemo(
    () => getFilenameConventionSegments(normalizedFileNamingScheme),
    [normalizedFileNamingScheme],
  );
  const expectedFilenameExample = useMemo(
    () => buildExpectedFilenameExample(normalizedFileNamingScheme),
    [normalizedFileNamingScheme],
  );

  useEffect(() => {
    const loadConfiguration = async () => {
      try {
        setLoading(true);
        loadCompleteRef.current = false;
        setError(null);
        setStatusMessage('');

        const [configResp, projectsResp] = await Promise.all([
          fetch(`/api/projects/${projectId}/configuration`),
          fetch('/api/projects/'),
        ]);

        if (!configResp.ok) {
          throw new Error(`Failed to load project configuration (${configResp.status})`);
        }

        const configData = await configResp.json();
        const incomingConfig = configData?.config && typeof configData.config === 'object' ? configData.config : {};
        let targetProjectType = configData?.project_type || projectType || '';

        if (projectsResp.ok) {
          const projectsData = await projectsResp.json();
          const projectList = Array.isArray(projectsData) ? projectsData : [];
          const currentProject = projectList.find((project) => project.id === projectId);
          targetProjectType = currentProject?.project_type || targetProjectType;
          setCurrentProjectType(targetProjectType);
          const filtered = projectList.filter((project) => {
            if (project.id === projectId) {
              return false;
            }
            if (!targetProjectType) {
              return true;
            }
            return project.project_type === targetProjectType;
          });
          setAvailableProjects(filtered);
        }

        const normalizedConfig = normalizeProjectConfiguration(incomingConfig, targetProjectType);
        lastSavedSignatureRef.current = getConfigurationSignature(normalizedConfig);
        loadCompleteRef.current = true;
        setConfig(normalizedConfig);
      } catch (err) {
        const message = err.message || 'Failed to load project configuration';
        setError(await buildErrorWithServiceDiagnostics(message, projectId));
      } finally {
        setLoading(false);
      }
    };

    loadConfiguration();
  }, [projectId, projectType]);

  useEffect(() => {
    if (!copySourceProjectId) {
      return;
    }
    const stillAvailable = availableProjects.some((project) => project.id === copySourceProjectId);
    if (!stillAvailable) {
      setCopySourceProjectId('');
    }
  }, [availableProjects, copySourceProjectId]);

  const hasConfiguration = useMemo(
    () =>
      config.image_modalities.length > 0 ||
      config.part_views.length > 0 ||
      config.defect_types.length > 0,
    [config.defect_types.length, config.image_modalities.length, config.part_views.length],
  );

  const persistConfiguration = useCallback(async (configurationToSave, statusLabel = 'Configuration saved.') => {
    if (readOnly) return false;
    const validationErrors = validateConfiguration(configurationToSave);
    if (validationErrors.length > 0) {
      setError(validationErrors.join(' '));
      setStatusMessage('');
      return false;
    }

    try {
      setSaving(true);
      setError(null);
      const response = await fetch(`/api/projects/${projectId}/configuration`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: configurationToSave }),
      });
      if (!response.ok) {
        throw new Error(`Failed to save project configuration (${response.status})`);
      }
      const payload = await response.json();
      lastSavedSignatureRef.current = getConfigurationSignature(configurationToSave);
      setStatusMessage(statusLabel);
      if (payload?.config && typeof onConfigurationSaved === 'function') {
        onConfigurationSaved(payload.config);
      }
      return true;
    } catch (err) {
      const message = err.message || 'Failed to save project configuration';
      setError(await buildErrorWithServiceDiagnostics(message, projectId));
      return false;
    } finally {
      setSaving(false);
    }
  }, [onConfigurationSaved, projectId, readOnly]);

  const runAutosave = useCallback((statusLabel = 'Configuration autosaved.') => {
    if (readOnly) return Promise.resolve(true);
    if (!calibrationInputValidRef.current) {
      setError('Enter a valid project calibration before saving or leaving Configuration.');
      setStatusMessage('');
      return Promise.resolve(false);
    }
    if (saveLoopPromiseRef.current) {
      autosaveRequestedDuringSaveRef.current = true;
      return saveLoopPromiseRef.current;
    }

    saveLoopPromiseRef.current = (async () => {
      let shouldContinue = true;
      while (shouldContinue) {
        autosaveRequestedDuringSaveRef.current = false;
        const latestConfig = configRef.current;
        const latestSignature = getConfigurationSignature(latestConfig);
        if (latestSignature === lastSavedSignatureRef.current) {
          return true;
        }
        const saved = await persistConfiguration(latestConfig, statusLabel);
        if (!saved) {
          return false;
        }
        shouldContinue =
          autosaveRequestedDuringSaveRef.current ||
          getConfigurationSignature(configRef.current) !== lastSavedSignatureRef.current;
      }
      return true;
    })().finally(() => {
      saveLoopPromiseRef.current = null;
    });

    return saveLoopPromiseRef.current;
  }, [persistConfiguration, readOnly]);

  const hasPendingAutosave = useCallback(() => {
    if (!loadCompleteRef.current || readOnly) return false;
    return Boolean(
      autosaveTimerRef.current ||
      saveLoopPromiseRef.current ||
      !calibrationInputValidRef.current ||
      getConfigurationSignature(configRef.current) !== lastSavedSignatureRef.current,
    );
  }, [readOnly]);

  const flushPendingAutosave = useCallback(async (statusLabel = 'Configuration autosaved.') => {
    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
      autosaveTimerRef.current = null;
    }
    if (!hasPendingAutosave()) {
      return true;
    }
    if (!calibrationInputValidRef.current) {
      setError('Enter a valid project calibration before saving or leaving Configuration.');
      setStatusMessage('');
      return false;
    }
    return runAutosave(statusLabel);
  }, [hasPendingAutosave, runAutosave]);

  useImperativeHandle(ref, () => ({
    hasPendingAutosave,
    flushPendingAutosave,
  }), [flushPendingAutosave, hasPendingAutosave]);

  useEffect(() => {
    if (!loadCompleteRef.current || loading || readOnly) {
      if (readOnly && autosaveTimerRef.current) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
      return;
    }
    const latestSignature = getConfigurationSignature(config);
    if (latestSignature === lastSavedSignatureRef.current) {
      return;
    }
    if (autosaveTimerRef.current) {
      window.clearTimeout(autosaveTimerRef.current);
    }
    setStatusMessage('Unsaved changes will autosave shortly.');
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null;
      runAutosave();
    }, AUTOSAVE_DELAY_MS);
  }, [config, loading, readOnly, runAutosave]);

  const saveConfiguration = async () => {
    if (readOnly || !calibrationInputValid) return;
    if (hasPendingAutosave()) {
      await flushPendingAutosave('Configuration saved.');
      return;
    }
    await persistConfiguration(configRef.current, 'Configuration saved.');
  };

  const saveInterfaceLayoutAsProjectDefault = async () => {
    if (!currentInterfaceLayout || savingInterfaceLayoutDefault) return;
    try {
      setSavingInterfaceLayoutDefault(true);
      setError(null);
      setStatusMessage('');
      const response = await fetch(`/api/projects/${projectId}/configuration/interface-layout/default`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout_model: currentInterfaceLayout }),
      });
      if (!response.ok) {
        throw new Error(`Failed to save project interface default (${response.status})`);
      }
      const payload = await response.json();
      if (payload?.config) {
        setConfig((previous) => ({
          ...previous,
          ...payload.config,
          display_settings: normalizeDisplaySettings(payload.config),
          serial_number_scheme: normalizeSerialNumberScheme(payload.config),
          phase_settings: normalizePhaseSettings(payload.config),
          file_naming_scheme: normalizeFileNamingScheme(payload.config),
        }));
        if (typeof onConfigurationSaved === 'function') {
          onConfigurationSaved(payload.config);
        }
      }
      setStatusMessage('Current interface saved as this project default.');
    } catch (err) {
      const message = err.message || 'Failed to save project interface default';
      setError(await buildErrorWithServiceDiagnostics(message, projectId));
    } finally {
      setSavingInterfaceLayoutDefault(false);
    }
  };

  const saveInterfaceLayoutAsProjectTypeDefault = async () => {
    if (!currentInterfaceLayout || savingProjectTypeLayoutDefault || !isAdminUser) return;
    try {
      setSavingProjectTypeLayoutDefault(true);
      setError(null);
      setStatusMessage('');
      const response = await fetch(`/api/projects/${projectId}/configuration/interface-layout/project-type-default`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layout_model: currentInterfaceLayout }),
      });
      if (!response.ok) {
        throw new Error(`Failed to save ${projectType || 'project type'} interface default (${response.status})`);
      }
      const payload = await response.json();
      if (payload?.config && typeof onConfigurationSaved === 'function') {
        onConfigurationSaved(payload.config);
      }
      setStatusMessage(`Current interface saved as the default for ${projectType || 'this project type'}.`);
    } catch (err) {
      const message = err.message || 'Failed to save project type interface default';
      setError(await buildErrorWithServiceDiagnostics(message, projectId));
    } finally {
      setSavingProjectTypeLayoutDefault(false);
    }
  };

  const addDefectType = () => {
    setConfig((previous) => ({
      ...previous,
      defect_types: [
        ...previous.defect_types,
        {
          name: '',
          color: '#ef4444',
          definition: '',
        },
      ],
    }));
  };

  const updateDefectType = (index, patch) => {
    setConfig((previous) => ({
      ...previous,
      defect_types: previous.defect_types.map((defectType, defectIndex) =>
        defectIndex === index ? { ...defectType, ...patch } : defectType,
      ),
    }));
  };

  const removeDefectType = (index) => {
    setConfig((previous) => ({
      ...previous,
      defect_types: previous.defect_types.filter((_, defectIndex) => defectIndex !== index),
    }));
  };

  const addImageModality = () => {
    setConfig((previous) => ({
      ...previous,
      image_modalities: [
        ...(previous.image_modalities || []),
        {
          id: '',
          label: '',
          calibration_required: false,
          example_image_uploaded: false,
        },
      ],
    }));
  };

  const updateImageModality = (index, patch) => {
    setConfig((previous) => {
      const previousId = previous.image_modalities?.[index]?.id;
      const nextId = patch.id;
      return {
        ...previous,
        image_modalities: (previous.image_modalities || []).map((modality, modalityIndex) =>
          modalityIndex === index ? { ...modality, ...patch } : modality,
        ),
        part_views: nextId !== undefined && normalizeLower(previousId) !== normalizeLower(nextId)
          ? (previous.part_views || []).map((partView) => ({
              ...partView,
              required_modalities: (partView.required_modalities || []).map((requiredModality) =>
                normalizeLower(requiredModality) === normalizeLower(previousId) ? nextId : requiredModality,
              ),
            }))
          : previous.part_views,
      };
    });
  };

  const removeImageModality = (index) => {
    setConfig((previous) => {
      const removedId = previous.image_modalities?.[index]?.id;
      return {
        ...previous,
        image_modalities: (previous.image_modalities || []).filter((_, modalityIndex) => modalityIndex !== index),
        part_views: (previous.part_views || []).map((partView) => ({
          ...partView,
          required_modalities: (partView.required_modalities || []).filter(
            (requiredModality) => normalizeLower(requiredModality) !== normalizeLower(removedId),
          ),
        })),
      };
    });
  };

  const addPartView = () => {
    setConfig((previous) => ({
      ...previous,
      part_views: [
        ...(previous.part_views || []),
        {
          id: '',
          label: '',
          required_modalities: [],
          source: 'manual',
        },
      ],
    }));
  };

  const updatePartView = (index, patch) => {
    setConfig((previous) => ({
      ...previous,
      part_views: (previous.part_views || []).map((partView, partViewIndex) =>
        partViewIndex === index ? { ...partView, ...patch } : partView,
      ),
    }));
  };

  const removePartView = (index) => {
    setConfig((previous) => ({
      ...previous,
      part_views: (previous.part_views || []).filter((_, partViewIndex) => partViewIndex !== index),
    }));
  };

  const updateFileNameEntry = (entryType, index, patch) => {
    setConfig((previous) => ({
      ...previous,
      file_naming_scheme: {
        ...normalizeFileNamingScheme(previous),
        [entryType]: normalizeFileNamingScheme(previous)[entryType].map((entry, entryIndex) =>
          entryIndex === index ? { ...entry, ...patch } : entry,
        ),
      },
    }));
  };

  const addFileNameEntry = (entryType) => {
    setConfig((previous) => ({
      ...previous,
      file_naming_scheme: {
        ...normalizeFileNamingScheme(previous),
        [entryType]: [...normalizeFileNamingScheme(previous)[entryType], { id: 'other', label: '', abbreviation: '' }],
      },
    }));
  };

  const removeFileNameEntry = (entryType, index) => {
    setConfig((previous) => ({
      ...previous,
      file_naming_scheme: {
        ...normalizeFileNamingScheme(previous),
        [entryType]: normalizeFileNamingScheme(previous)[entryType].filter((_, entryIndex) => entryIndex !== index),
      },
    }));
  };


  const updateOverlayIndicator = (patch) => {
    setConfig((previous) => {
      const currentScheme = normalizeFileNamingScheme(previous);
      return {
        ...previous,
        file_naming_scheme: {
          ...currentScheme,
          overlay_indicator: normalizeOverlayIndicator({
            ...currentScheme.overlay_indicator,
            ...patch,
          }),
        },
      };
    });
  };



  const copyConfiguration = async () => {
    if (readOnly || !copySourceProjectId || copyingConfiguration) return;

    try {
      setCopyingConfiguration(true);
      setError(null);
      setStatusMessage('');
      const cloneResp = await fetch(`/api/projects/${projectId}/configuration/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_project_id: copySourceProjectId }),
      });

      const cloneData = await parseJsonSafely(cloneResp);
      if (!cloneResp.ok) {
        throw new Error(cloneData?.detail || `Failed to copy project configuration (${cloneResp.status})`);
      }

      const clonedConfig = getCloneConfigOrThrow(cloneData);
      const nextClonedConfig = normalizeProjectConfiguration(
        clonedConfig,
        currentProjectType || projectType,
      );
      lastSavedSignatureRef.current = getConfigurationSignature(nextClonedConfig);
      setConfig(nextClonedConfig);
      const copiedFromProject = selectedCopySourceProject?.name || 'existing project';
      setCopySourceProjectId('');
      setStatusMessage(`Configuration copied from ${copiedFromProject}.`);
    } catch (err) {
      setStatusMessage('');
      const message = err.message || 'Failed to copy project configuration';
      setError(await buildErrorWithServiceDiagnostics(message, projectId));
    } finally {
      setCopyingConfiguration(false);
    }
  };

  return (
    <section className="workbench-panel project-configuration-panel" aria-label="Project Configuration">
      <header className="workbench-header">
        <div>
          <h2>Project Configuration</h2>
          <p>
            Configure filename side and modality labels, defect definitions, process controls, and display options.
          </p>
        </div>
      </header>

      {loading && <div className="loading-text">Loading project configuration…</div>}
      {error && !loading && (
        <div className="alert alert-error service-diagnostic-alert">
          <div>{primaryError}</div>
          {diagnosticError && <pre>{diagnosticError}</pre>}
        </div>
      )}
      {statusMessage && !loading && <div className="alert alert-success">{statusMessage}</div>}

      {!loading && !error && (
        <>
          <div className="workbench-summary-grid" data-testid="project-configuration-summary">
            <article className="summary-card">
              <h3>Modalities</h3>
              <p>{config.image_modalities.length} filename labels configured</p>
            </article>
            <article className="summary-card">
              <h3>Sides</h3>
              <p>{config.part_views.length} filename labels configured</p>
            </article>
            <article className="summary-card">
              <h3>Defect Types</h3>
              <p>{config.defect_types.length} configured</p>
            </article>
          </div>

          {visibleConfigurationSubtabs.length > 0 ? (
            <div className="configuration-subtabs project-tabs" role="tablist" aria-label="Configuration sections">
              {visibleConfigurationSubtabs.map((subtab) => (
                <button
                  key={subtab.id}
                  type="button"
                  className={`project-tab ${activeConfigurationSubtab === subtab.id ? 'active' : ''}`}
                  role="tab"
                  aria-selected={activeConfigurationSubtab === subtab.id}
                  aria-controls={subtab.panelId}
                  onClick={() => setActiveConfigurationSubtab(subtab.id)}
                >
                  {subtab.label}
                </button>
              ))}
            </div>
          ) : (
            <section className="part-detail-panel" aria-live="polite">
              <p className="muted">No Project Configuration sections are enabled. Re-enable sections from a project default or administrator configuration.</p>
            </section>
          )}

          {visibleConfigurationSubtabIds.has('general') && activeConfigurationSubtab === 'general' && (
          <div
            id="configuration-general-panel"
            className="configuration-sections-grid"
            data-testid="configuration-sections-grid"
            role="tabpanel"
            aria-label="General configuration"
          >
            {visibleGeneralSectionCount === 0 && (
              <section className="part-detail-panel" aria-live="polite">
                <p className="muted">No General configuration sections are enabled.</p>
              </section>
            )}
            <ProjectAccessGroupControl
              project={project}
              projectId={projectId}
              onProjectUpdated={onProjectUpdated}
            />
            {calibrationSectionVisible && (
              <ProjectCalibrationControl
                calibration={config.calibration}
                disabled={readOnly || saving}
                onChange={(calibration) => {
                  setConfig((previous) => ({
                    ...previous,
                    calibration,
                  }));
                }}
                onValidityChange={updateCalibrationInputValidity}
              />
            )}
            {isUiSectionEnabled(config, 'project_configuration.owner_section') && (
          <section className="part-detail-panel" aria-label="Project owner">
            <h3>Project Owner</h3>
            <div className="workbench-controls-row">
              <label htmlFor="project-owner-name">Owner Name</label>
              <input id="project-owner-name" className="form-control" value={config.project_owner?.name || ''} onChange={(event) => setConfig((previous) => ({ ...previous, project_owner: { ...(previous.project_owner || {}), name: event.target.value } }))} />
              <label htmlFor="project-owner-email">Owner Email</label>
              <input id="project-owner-email" className="form-control" value={config.project_owner?.email || ''} onChange={(event) => setConfig((previous) => ({ ...previous, project_owner: { ...(previous.project_owner || {}), email: event.target.value } }))} />
            </div>
          </section>
          )}
          
          {isUiSectionEnabled(config, 'project_configuration.user_section') && (
          <section className="part-detail-panel" aria-label="Current user">
            <h3>Current User</h3>
            <div className="workbench-controls-row">
              <label htmlFor="current-user-name">Active Username</label>
              <input id="current-user-name" className="form-control" value={config.current_user?.username || ''} onChange={(event) => setConfig((previous) => ({ ...previous, current_user: { ...(previous.current_user || {}), username: event.target.value, sso_authenticated: false } }))} />
              <p className="muted">
                Status: {config.current_user?.sso_authenticated ? 'Authenticated via SSO' : 'Manual (manual)'}
              </p>
            </div>
          </section>
          )}

          {isUiSectionEnabled(config, 'project_configuration.process_settings') && (
          <section className="part-detail-panel" aria-label="Process settings">
            <h3>Process Settings</h3>
            <label>
              <input
                type="checkbox"
                checked={Boolean(config.process_settings?.require_disposition_on_submit)}
                onChange={(event) => {
                  setConfig((previous) => ({
                    ...previous,
                    process_settings: {
                      ...previous.process_settings,
                      require_disposition_on_submit: event.target.checked,
                    },
                  }));
                }}
              />
              Require disposition on submit
            </label>
            <label>
              <input
                type="checkbox"
                aria-label="Require measurement for critical defects"
                checked={Boolean(config.process_settings?.require_measurement_for_critical)}
                onChange={(event) => {
                  setConfig((previous) => ({
                    ...previous,
                    process_settings: {
                      ...previous.process_settings,
                      require_measurement_for_critical: event.target.checked,
                    },
                  }));
                }}
              />
              Require measurement for critical defects
            </label>
            <label>
              <input
                type="checkbox"
                aria-label="Require second reviewer for rejects"
                checked={Boolean(config.process_settings?.require_second_reviewer_for_reject)}
                onChange={(event) => {
                  setConfig((previous) => ({
                    ...previous,
                    process_settings: {
                      ...previous.process_settings,
                      require_second_reviewer_for_reject: event.target.checked,
                    },
                  }));
                }}
              />
              Require second reviewer for rejects
            </label>
          </section>
          )}

          {isUiSectionEnabled(config, 'project_configuration.serial_scheme') && (
          <section className="part-detail-panel" aria-label="Serial number scheme">
            <h3>Serial Number Scheme</h3>
            <p>Choose whether serial numbers are tracked at batch, sub-batch, and part levels.</p>
            <label>
              <input
                type="checkbox"
                checked={Boolean(config.serial_number_scheme?.batch_sn_enabled)}
                onChange={(event) =>
                  setConfig((previous) => ({
                    ...previous,
                    serial_number_scheme: {
                      ...normalizeSerialNumberScheme(previous),
                      batch_sn_enabled: event.target.checked,
                    },
                  }))
                }
              />
              Track serial number at batch level
            </label>
            <label>
              <input
                type="checkbox"
                checked={Boolean(config.serial_number_scheme?.sub_batching_enabled)}
                onChange={(event) =>
                  setConfig((previous) => {
                    const enabled = event.target.checked;
                    return {
                      ...previous,
                      serial_number_scheme: {
                        ...normalizeSerialNumberScheme(previous),
                        sub_batching_enabled: enabled,
                        sub_batch_sn_enabled: enabled ? previous.serial_number_scheme?.sub_batch_sn_enabled === true : false,
                      },
                    };
                  })
                }
              />
              Organize each batch into sub-batches
            </label>
            <label>
              <input
                type="checkbox"
                checked={Boolean(config.serial_number_scheme?.sub_batch_sn_enabled)}
                disabled={!config.serial_number_scheme?.sub_batching_enabled}
                onChange={(event) =>
                  setConfig((previous) => ({
                    ...previous,
                    serial_number_scheme: {
                      ...normalizeSerialNumberScheme(previous),
                      sub_batch_sn_enabled: event.target.checked,
                    },
                  }))
                }
              />
              Track serial number at sub-batch level
            </label>
            <label>
              <input
                type="checkbox"
                checked={Boolean(config.serial_number_scheme?.part_sn_enabled)}
                onChange={(event) =>
                  setConfig((previous) => ({
                    ...previous,
                    serial_number_scheme: {
                      ...normalizeSerialNumberScheme(previous),
                      part_sn_enabled: event.target.checked,
                    },
                  }))
                }
              />
              Track serial number at part level
            </label>
          </section>
          )}

          {isUiSectionEnabled(config, 'project_configuration.project_phase_settings') && (
          <section className="part-detail-panel" aria-label="Project phase settings">
            <h3>Project Phase Settings</h3>
            <p>
              By default, projects progress automatically from Data Ingestion to Part Inspection to Reporting as data is
              loaded and annotated.
            </p>
            <label>
              <input
                type="checkbox"
                checked={Boolean(config.phase_settings?.manual_phase_selection_enabled)}
                onChange={(event) =>
                  setConfig((previous) => ({
                    ...previous,
                    phase_settings: {
                      ...normalizePhaseSettings(previous),
                      manual_phase_selection_enabled: event.target.checked,
                    },
                  }))
                }
              />
              Manually choose current project phase
            </label>
            <div className="workbench-controls-row">
              <label htmlFor="manual-project-phase">Manual phase</label>
              <select
                id="manual-project-phase"
                aria-label="Manual project phase"
                disabled={!config.phase_settings?.manual_phase_selection_enabled}
                value={config.phase_settings?.manual_phase || 'data_ingestion'}
                onChange={(event) =>
                  setConfig((previous) => ({
                    ...previous,
                    phase_settings: {
                      ...normalizePhaseSettings(previous),
                      manual_phase: event.target.value,
                    },
                  }))
                }
              >
                {PROJECT_PHASE_SEQUENCE.map((phaseKey) => (
                  <option key={phaseKey} value={phaseKey}>
                    {PROJECT_PHASE_LABELS[phaseKey]}
                  </option>
                ))}
              </select>
            </div>
          </section>
          )}

          {isUiSectionEnabled(config, 'project_configuration.defect_types') && (
          <section className="part-detail-panel" aria-label="Defect types">
            <h3>Defect Types</h3>
            <p>Define the defect taxonomy used in annotations and review workflows.</p>
            <div className="workbench-controls-row">
              <button className="btn btn-secondary" type="button" onClick={addDefectType} disabled={saving}>
                Add Defect Type
              </button>
            </div>
            {config.defect_types.length === 0 ? (
              <p>No defect types configured yet.</p>
            ) : (
              config.defect_types.map((defectType, index) => (
                <div className="workbench-controls-row config-entry-grid" key={`defect-type-${index}`}>
                  <label htmlFor={`defect-type-name-${index}`}>Name</label>
                  <input
                    id={`defect-type-name-${index}`}
                    aria-label={`Defect type name ${index + 1}`}
                    type="text"
                    value={defectType.name}
                    onChange={(event) => updateDefectType(index, { name: event.target.value })}
                  />
                  <label htmlFor={`defect-type-color-${index}`}>Color</label>
                  <input
                    id={`defect-type-color-${index}`}
                    aria-label={`Defect type color ${index + 1}`}
                    type="text"
                    value={defectType.color}
                    onChange={(event) => updateDefectType(index, { color: event.target.value })}
                  />
                  <label htmlFor={`defect-type-definition-${index}`}>Definition</label>
                  <input
                    id={`defect-type-definition-${index}`}
                    aria-label={`Defect type definition ${index + 1}`}
                    type="text"
                    value={defectType.definition || ''}
                    onChange={(event) => updateDefectType(index, { definition: event.target.value })}
                  />
                  <button
                    className="btn btn-secondary"
                    type="button"
                    aria-label={`Remove defect type ${index + 1}`}
                    onClick={() => removeDefectType(index)}
                    disabled={saving}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
          </section>
          )}


          {isUiSectionEnabled(config, 'project_configuration.display_options') && (
          <section className="part-detail-panel" aria-label="Display settings">
            <h3>Display Settings</h3>
            <label htmlFor="default-colormap">Default colormap</label>
            <select
              id="default-colormap"
              value={config.display_settings?.default_colormap || 'grayscale'}
              onChange={(event) => {
                const nextValue = event.target.value;
                setConfig((previous) => ({
                  ...previous,
                  display_settings: {
                    ...previous.display_settings,
                    default_colormap: nextValue,
                  },
                }));
              }}
            >
              <option value="grayscale">grayscale</option>
              <option value="magma">magma</option>
              <option value="viridis">viridis</option>
            </select>
            <label htmlFor="anomaly-colormap">Anomaly colormap</label>
            <select
              id="anomaly-colormap"
              aria-label="Anomaly colormap"
              value={config.display_settings?.anomaly_colormap || 'viridis'}
              onChange={(event) => {
                const nextValue = event.target.value;
                setConfig((previous) => ({
                  ...previous,
                  display_settings: {
                    ...previous.display_settings,
                    anomaly_colormap: nextValue,
                  },
                }));
              }}
            >
              <option value="grayscale">grayscale</option>
              <option value="magma">magma</option>
              <option value="viridis">viridis</option>
            </select>
            <label>
              <input
                type="checkbox"
                aria-label="Use grayscale base image"
                checked={Boolean(config.display_settings?.grayscale_base_image)}
                onChange={(event) => {
                  setConfig((previous) => ({
                    ...previous,
                    display_settings: {
                      ...previous.display_settings,
                      grayscale_base_image: event.target.checked,
                    },
                  }));
                }}
              />
              Use grayscale base image
            </label>
          </section>
          )}

          {isUiSectionEnabled(config, 'project_configuration.copy_configuration') && (
          <section className="part-detail-panel" aria-label="Copy configuration">
            <h3>Copy Configuration</h3>
            <p>
              Copy settings from another project into this one.
              {currentProjectType
                ? ` Only ${currentProjectType} source projects are listed.`
                : ''}
            </p>
            {!hasCompatibleCopySources && (
              <p className="muted" data-testid="no-compatible-copy-sources">
                No compatible source projects are available yet.
              </p>
            )}
            <div className="workbench-controls-row" aria-busy={copyingConfiguration}>
              <select
                aria-label="Source project"
                value={copySourceProjectId}
                disabled={readOnly || !hasCompatibleCopySources || copyingConfiguration}
                onChange={(event) => {
                  setCopySourceProjectId(event.target.value);
                  setError(null);
                  setStatusMessage('');
                }}
              >
                <option value="">Select project</option>
                {availableProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-secondary"
                type="button"
                disabled={readOnly || !copySourceProjectId || !hasCompatibleCopySources || copyingConfiguration}
                onClick={copyConfiguration}
              >
                {copyingConfiguration ? 'Copying...' : 'Copy from Project'}
              </button>
            </div>
          </section>
          )}
          </div>
          )}


          {visibleConfigurationSubtabIds.has('uiConfiguration') && activeConfigurationSubtab === 'uiConfiguration' && (
          <div
            id="configuration-ui-panel"
            className="configuration-sections-grid configuration-ui-panel"
            role="tabpanel"
            aria-label="UI Configuration"
          >
          {isUiSectionEnabled(config, 'project_configuration.available_ui_sections') && (
          <section className="part-detail-panel configurable-ui-sections-panel" aria-label="Configurable UI sections">
            <div className="configurable-ui-sections-header">
              <div>
                <h3>Available UI Sections</h3>
                <p>Search, expand, and select the Vista interface elements that should be visible for this project.</p>
              </div>
            </div>
            <div className="configurable-ui-search-row">
              <input
                type="search"
                aria-label="Search UI configuration tree"
                placeholder="Search UI elements…"
                value={uiSearchQuery}
                onChange={(event) => setUiSearchQuery(event.target.value)}
              />
              <span className="configurable-ui-search-count" aria-live="polite">
                {uiSectionSearchResults.length > 0 ? `${uiSearchIndex + 1} of ${uiSectionSearchResults.length}` : 'No results'}
              </span>
              <button type="button" className="btn btn-secondary btn-sm" aria-label="Previous UI search result" disabled={uiSectionSearchResults.length === 0} onClick={() => setUiSearchIndex((previous) => (previous - 1 + uiSectionSearchResults.length) % uiSectionSearchResults.length)}>⌃</button>
              <button type="button" className="btn btn-secondary btn-sm" aria-label="Next UI search result" disabled={uiSectionSearchResults.length === 0} onClick={() => setUiSearchIndex((previous) => (previous + 1) % uiSectionSearchResults.length)}>⌄</button>
            </div>
            <div id="advanced-ui-section-controls" className="configurable-ui-section-groups">
              {UI_SECTION_GROUPS.map((group) => (
                <ConfigurableUiSectionGroup
                  key={group.id}
                  group={group}
                  config={config}
                  setConfig={setConfig}
                  expandedGroups={expandedUiGroups}
                  toggleGroup={toggleUiGroup}
                  highlightedKey={selectedUiSectionSearchResult?.key || ''}
                />
              ))}
            </div>
          </section>
          )}
          {!isUiSectionEnabled(config, 'project_configuration.available_ui_sections') && !isPt3Project && (
            <section className="part-detail-panel" aria-live="polite">
              <p className="muted">No UI Configuration sections are enabled.</p>
            </section>
          )}
          {isPt3Project && (
            <section
              className="part-detail-panel pt3-guide-configuration-card"
              aria-label="3D view guides"
              data-testid="pt3-guide-configuration-card"
            >
              <div className="pt3-guide-card-header">
                <div>
                  <span className="pt3-guide-eyebrow">PT3 · 3D VIEW</span>
                  <h3>3D View Guides</h3>
                  <p>
                    Tune the crosshair and slice-plane outlines used to locate X, Y, and Z positions in 3D.
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  aria-label="Reset 3D view guides to defaults"
                  disabled={pt3GuideSettingsAreDefault}
                  onClick={resetPt3GuideSettings}
                >
                  Reset
                </button>
              </div>
              <div className="pt3-guide-card-body">
                <div className="pt3-guide-controls" role="group" aria-label="3D view guide appearance">
                  {Object.keys(PT3_GUIDE_FIELDS).map((field) => (
                    <Pt3GuideRangeControl
                      key={field}
                      field={field}
                      value={pt3GuideSettings[field]}
                      onChange={updatePt3GuideSetting}
                    />
                  ))}
                </div>
                <Pt3GuidePreview settings={pt3GuideSettings} />
              </div>
            </section>
          )}
          </div>
          )}

          {visibleConfigurationSubtabIds.has('filenameConvention') && activeConfigurationSubtab === 'filenameConvention' && (
            <div
              id="configuration-filename-convention-panel"
              className="configuration-filename-convention-panel"
              role="tabpanel"
              aria-label="Filename Convention configuration"
            >
          <section className="part-detail-panel filename-convention-panel" aria-label="Filename convention">
            <div className="filename-convention-heading">
              <div>
                <h3>Filename Convention</h3>
              </div>
              <code data-testid="expected-filename-preview">{expectedFilenameExample}</code>
            </div>

            <div className="filename-breakdown" aria-label="Expected filename preview">
              {filenameConvention.segments.map((segment, index) => (
                <React.Fragment key={segment.key}>
                  <div className="filename-breakdown-segment" style={{ '--segment-color': segment.color }}>
                    <span className="filename-breakdown-label">{segment.label}</span>
                    <strong>{segment.token}</strong>
                    <span className="filename-breakdown-decodes">
                      {segment.type === 'hierarchy' ? 'ID value: 001' : 'Filename descriptor'}
                    </span>
                  </div>
                  {index < filenameConvention.segments.length - 1 && (
                    <span className="filename-breakdown-delimiter">{filenameConvention.delimiter}</span>
                  )}
                </React.Fragment>
              ))}
              <span className="filename-breakdown-extension">.type</span>
            </div>

            <p>
              Configure each option directly under the filename part it controls. Numeric placeholders use
              <strong> 001 </strong> because these fields normally decode image or part identifiers from the filename.
            </p>

            <p className="muted">Part hierarchy assignment is configured in Project Data → Images to Parts → Automatically Assign Images to Parts.</p>

            <label className="filename-convention-toggle">
              <input
                type="checkbox"
                aria-label="Use filename convention"
                checked={normalizedFileNamingScheme.use_filename_convention !== false}
                onChange={(event) => setConfig((previous) => ({
                  ...previous,
                  file_naming_scheme: {
                    ...normalizeFileNamingScheme(previous),
                    use_filename_convention: event.target.checked,
                  },
                }))}
              />
              Use filename convention for automatic metadata and part-assignment assumptions
            </label>
            {normalizedFileNamingScheme.use_filename_convention === false && (
              <p className="muted">
                Filename convention assumptions are disabled. VISTA will only use metadata explicitly supplied through regex/delimiter loading tools, associated metadata, or manual user assignments after loading.
              </p>
            )}

            <h4>Image Descriptors</h4>
            <div className="filename-option-grid">
              {normalizedFileNamingScheme.image_descriptors.map((descriptor, index) => {
                const segment = filenameConvention.segments.find((item) => item.type === 'descriptor' && item.index === index);
                return (
                  <div className="filename-option-card" style={{ '--segment-color': segment?.color }} key={`image-descriptor-${index}`}>
                    <div className="filename-option-card-header">
                      <span>{segment?.token}</span>
                      <button className="btn btn-secondary" type="button" onClick={() => removeFileNameEntry('image_descriptors', index)}>Remove</button>
                    </div>
                    <label htmlFor={`image-descriptor-select-${index}`}>Descriptor {index + 1}</label>
                    <select
                      id={`image-descriptor-select-${index}`}
                      value={descriptor.id}
                      onChange={(event) => {
                        const selected = FILE_NAME_ELEMENT_OPTIONS.find((option) => option.id === event.target.value);
                        updateFileNameEntry('image_descriptors', index, selected
                          ? { id: selected.id, label: selected.label, abbreviation: selected.abbreviation }
                          : { id: 'other', label: '', abbreviation: '' });
                      }}
                    >
                      {FILE_NAME_ELEMENT_OPTIONS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                      <option value="other">Other</option>
                    </select>
                    {descriptor.id === 'other' && (
                      <>
                        <label htmlFor={`image-descriptor-custom-label-${index}`}>Custom Label</label>
                        <input id={`image-descriptor-custom-label-${index}`} value={descriptor.label} onChange={(event) => updateFileNameEntry('image_descriptors', index, { label: event.target.value })} />
                      </>
                    )}
                    <small className="filename-metadata-key">Metadata key: {getFilenameEntryMetadataKey(descriptor, `descriptor_${index + 1}`)}</small>
                    <label htmlFor={`image-descriptor-abbreviation-${index}`}>Abbreviation</label>
                    <input id={`image-descriptor-abbreviation-${index}`} value={descriptor.abbreviation} onChange={(event) => updateFileNameEntry('image_descriptors', index, { abbreviation: event.target.value })} />
                  </div>
                );
              })}
            </div>
            <div className="workbench-controls-row">
              <button className="btn btn-secondary" type="button" onClick={() => addFileNameEntry('image_descriptors')}>
                Add Image Descriptor
              </button>
            </div>

            <h4>Overlay Matching</h4>
            <p>
              Use this when a filename segment marks an image as an overlay. Overlay images are rendered
              on top of the non-overlay image with the same configured hierarchy/identifier values after
              the overlay specifier is removed.
            </p>
            <div className="filename-option-card filename-overlay-card">
              <label>
                <input
                  type="checkbox"
                  aria-label="Enable overlay filename matching"
                  checked={normalizedFileNamingScheme.overlay_indicator.enabled}
                  onChange={(event) => updateOverlayIndicator({ enabled: event.target.checked })}
                />
                Enable overlay filename matching
              </label>
              <label htmlFor="overlay-field-key">Overlay metadata key</label>
              <select
                id="overlay-field-key"
                value={normalizedFileNamingScheme.overlay_indicator.field_key}
                onChange={(event) => updateOverlayIndicator({ field_key: event.target.value })}
              >
                {[...normalizedFileNamingScheme.hierarchy_levels, ...normalizedFileNamingScheme.image_descriptors]
                  .map((entry, index) => getFilenameEntryMetadataKey(entry, `filename_field_${index + 1}`))
                  .filter(Boolean)
                  .filter((key, index, keys) => keys.indexOf(key) === index)
                  .map((key) => <option key={key} value={key}>{key}</option>)}
                {!([...normalizedFileNamingScheme.hierarchy_levels, ...normalizedFileNamingScheme.image_descriptors]
                  .map((entry, index) => getFilenameEntryMetadataKey(entry, `filename_field_${index + 1}`))
                  .includes(normalizedFileNamingScheme.overlay_indicator.field_key)) && (
                  <option value={normalizedFileNamingScheme.overlay_indicator.field_key}>{normalizedFileNamingScheme.overlay_indicator.field_key}</option>
                )}
              </select>
              <label htmlFor="overlay-values">Overlay values</label>
              <input
                id="overlay-values"
                aria-label="Overlay values"
                type="text"
                value={normalizedFileNamingScheme.overlay_indicator.values.join(', ')}
                onChange={(event) => updateOverlayIndicator({ values: event.target.value.split(',') })}
              />
              <label>
                <input
                  type="checkbox"
                  aria-label="Remove overlay specifier when matching base image"
                  checked={normalizedFileNamingScheme.overlay_indicator.remove_from_base_filename}
                  onChange={(event) => updateOverlayIndicator({ remove_from_base_filename: event.target.checked })}
                />
                Match the base image by removing the overlay specifier from the filename
              </label>
            </div>


            {isUiSectionEnabled(config, 'project_configuration.view_options') && (
            <section className="filename-value-section" aria-label="Sides">
            <h4>Sides</h4>
            <p>Specify the potential side labels that may appear in loaded image filenames.</p>
            <div className="workbench-controls-row">
              <button className="btn btn-secondary" type="button" onClick={addPartView} disabled={saving}>
                Add Side
              </button>
            </div>
            {(config.part_views || []).length === 0 ? (
              <p>No side labels configured yet.</p>
            ) : (
              (config.part_views || []).map((partView, index) => (
                <div className="workbench-controls-row config-entry-grid" key={`part-view-${index}`}>
                  <label htmlFor={`part-view-label-${index}`}>Side label</label>
                  <input
                    id={`part-view-label-${index}`}
                    aria-label={`Side label ${index + 1}`}
                    type="text"
                    value={partView.label || ''}
                    onChange={(event) => updatePartView(index, { label: event.target.value })}
                  />
                  <label htmlFor={`part-view-id-${index}`}>Filename value</label>
                  <input
                    id={`part-view-id-${index}`}
                    aria-label={`Side filename value ${index + 1}`}
                    type="text"
                    value={partView.id || ''}
                    onChange={(event) => updatePartView(index, { id: event.target.value })}
                  />
                  <button
                    className="btn btn-secondary"
                    type="button"
                    aria-label={`Remove side ${index + 1}`}
                    onClick={() => removePartView(index)}
                    disabled={saving}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
            </section>
            )}

            <section className="filename-value-section" aria-label="Modalities">
            <h4>Modalities</h4>
            <p>Specify the potential modality labels that may appear in loaded image filenames.</p>
            <div className="workbench-controls-row">
              <button className="btn btn-secondary" type="button" onClick={addImageModality} disabled={saving}>
                Add Modality
              </button>
            </div>
            {(config.image_modalities || []).length === 0 ? (
              <p>No image modalities configured yet.</p>
            ) : (
              <div className="filename-option-grid modality-option-grid">
                {(config.image_modalities || []).map((modality, index) => (
                  <div className="filename-option-card" style={{ '--segment-color': '#f97316' }} key={`image-modality-${index}`}>
                    <div className="filename-option-card-header">
                      <span>{modality.id || `modality-${index + 1}`}</span>
                      <button
                        className="btn btn-secondary"
                        type="button"
                        aria-label={`Remove image modality ${index + 1}`}
                        onClick={() => removeImageModality(index)}
                        disabled={saving}
                      >
                        Remove
                      </button>
                    </div>
                    <label htmlFor={`image-modality-label-${index}`}>Modality label</label>
                    <input
                      id={`image-modality-label-${index}`}
                      aria-label={`Modality label ${index + 1}`}
                      type="text"
                      value={modality.label || ''}
                      onChange={(event) => updateImageModality(index, { label: event.target.value })}
                    />
                    <label htmlFor={`image-modality-id-${index}`}>Filename value</label>
                    <input
                      id={`image-modality-id-${index}`}
                      aria-label={`Modality filename value ${index + 1}`}
                      type="text"
                      value={modality.id || ''}
                      onChange={(event) => updateImageModality(index, { id: event.target.value })}
                    />
                  </div>
                ))}
              </div>
            )}
            </section>
          </section>
            </div>
          )}


          {visibleConfigurationSubtabIds.has('hotkeys') && activeConfigurationSubtab === 'hotkeys' && (
            <div
              id="configuration-hotkeys-panel"
              className="configuration-hotkeys-panel"
              role="tabpanel"
              aria-label="Hotkeys configuration"
            >
              <section className="part-detail-panel" aria-label="Hotkeys">
                <h3>Hotkeys</h3>
                <p>Customize the single-key shortcuts used while classifying inspection results.</p>
                <div className="workbench-controls-row config-entry-grid">
                  <label htmlFor="hotkey-accept">Accept hotkey</label>
                  <input
                    id="hotkey-accept"
                    aria-label="Accept hotkey"
                    type="text"
                    maxLength={1}
                    value={config.process_settings?.configurable_hotkeys?.accept_classification || 'a'}
                    onChange={(event) => {
                      const nextValue = event.target.value.toLowerCase();
                      setConfig((previous) => ({
                        ...previous,
                        process_settings: {
                          ...previous.process_settings,
                          configurable_hotkeys: {
                            ...(previous.process_settings?.configurable_hotkeys || {}),
                            accept_classification: nextValue,
                          },
                        },
                      }));
                    }}
                  />
                  <label htmlFor="hotkey-reject">Reject hotkey</label>
                  <input
                    id="hotkey-reject"
                    aria-label="Reject hotkey"
                    type="text"
                    maxLength={1}
                    value={config.process_settings?.configurable_hotkeys?.reject_classification || 'r'}
                    onChange={(event) => {
                      const nextValue = event.target.value.toLowerCase();
                      setConfig((previous) => ({
                        ...previous,
                        process_settings: {
                          ...previous.process_settings,
                          configurable_hotkeys: {
                            ...(previous.process_settings?.configurable_hotkeys || {}),
                            reject_classification: nextValue,
                          },
                        },
                      }));
                    }}
                  />
                  <label htmlFor="hotkey-help">Help hotkey</label>
                  <input
                    id="hotkey-help"
                    aria-label="Help hotkey"
                    type="text"
                    maxLength={1}
                    value={config.process_settings?.configurable_hotkeys?.toggle_shortcut_help || 'h'}
                    onChange={(event) => {
                      const nextValue = event.target.value.toLowerCase();
                      setConfig((previous) => ({
                        ...previous,
                        process_settings: {
                          ...previous.process_settings,
                          configurable_hotkeys: {
                            ...(previous.process_settings?.configurable_hotkeys || {}),
                            toggle_shortcut_help: nextValue,
                          },
                        },
                      }));
                    }}
                  />
                </div>
                <p className="muted">Hotkeys must be unique single alphanumeric characters.</p>
              </section>
            </div>
          )}

          <div
            className={[
              'workbench-controls-row',
              'configuration-action-bar',
              activeConfigurationSubtab === 'general'
                ? 'configuration-action-bar--calibration-safe'
                : '',
            ].filter(Boolean).join(' ')}
          >
            <button
              className="btn btn-primary"
              type="button"
              disabled={readOnly || saving || !calibrationInputValid}
              onClick={saveConfiguration}
            >
              {saving ? 'Saving...' : 'Save Configuration'}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={!currentInterfaceLayout || savingInterfaceLayoutDefault}
              onClick={saveInterfaceLayoutAsProjectDefault}
            >
              {savingInterfaceLayoutDefault ? 'Saving Layout...' : 'Save Current Interface as Project Default'}
            </button>
            {isAdminUser && (
              <button
                className="btn btn-secondary"
                type="button"
                disabled={!currentInterfaceLayout || savingProjectTypeLayoutDefault}
                onClick={saveInterfaceLayoutAsProjectTypeDefault}
              >
                {savingProjectTypeLayoutDefault
                  ? 'Saving Type Layout...'
                  : `Save Current Interface as ${projectType || 'Type'} Default`}
              </button>
            )}
            <span>{hasConfiguration ? 'Configuration is populated.' : 'Using defaults until sections are configured.'}</span>
          </div>
        </>
      )}
    </section>
  );
});

export default ProjectConfigurationPanel;
