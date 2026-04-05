import React, { useEffect, useMemo, useState } from 'react';


function isSingleAlphanumeric(value) {
  return /^[a-z0-9]$/i.test((value || '').trim());
}

function normalizeLower(value) {
  return (value || '').trim().toLowerCase();
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
    errors.push('Each image modality requires both identifier and label.');
  }
  if (duplicateModalityIds.length > 0) {
    errors.push('Image modality identifiers must be unique.');
  }

  const partViews = (config.part_views || []).map((view) => ({
    id: normalizeLower(view.id),
    label: (view.label || '').trim(),
    required_modalities: (view.required_modalities || []).map(normalizeLower).filter(Boolean),
  }));
  const partViewIds = partViews.map((view) => view.id).filter(Boolean);
  const duplicatePartViewIds = partViewIds.filter((id, index) => partViewIds.indexOf(id) !== index);

  if (partViews.some((view) => !view.id || !view.label)) {
    errors.push('Each part view requires both identifier and label.');
  }
  if (duplicatePartViewIds.length > 0) {
    errors.push('Part view identifiers must be unique.');
  }

  const unknownModalityReference = partViews.some((view) =>
    view.required_modalities.some((requiredModality) => !modalityIds.includes(requiredModality)),
  );
  if (unknownModalityReference) {
    errors.push('Part views can only require modalities configured in Image Modalities.');
  }

  const defectTypes = (config.defect_types || []).map((defectType) => ({
    name: (defectType.name || '').trim(),
    color: (defectType.color || '').trim(),
  }));
  if (defectTypes.some((defectType) => !defectType.name)) {
    errors.push('Each defect type requires a name.');
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
  },
};

function ProjectConfigurationPanel({ projectId }) {
  const [config, setConfig] = useState(EMPTY_CONFIG);
  const [availableProjects, setAvailableProjects] = useState([]);
  const [currentProjectType, setCurrentProjectType] = useState('');
  const [copySourceProjectId, setCopySourceProjectId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [copyingConfiguration, setCopyingConfiguration] = useState(false);
  const hasCompatibleCopySources = availableProjects.length > 0;
  const selectedCopySourceProject = availableProjects.find((project) => project.id === copySourceProjectId) || null;

  useEffect(() => {
    const loadConfiguration = async () => {
      try {
        setLoading(true);
        setError(null);
        setStatusMessage('');

        const [configResp, projectsResp] = await Promise.all([
          fetch(`/api/projects/${projectId}/configuration`),
          fetch('/api/projects'),
        ]);

        if (!configResp.ok) {
          throw new Error(`Failed to load project configuration (${configResp.status})`);
        }

        const configData = await configResp.json();
        setConfig(configData?.config || EMPTY_CONFIG);

        if (projectsResp.ok) {
          const projectsData = await projectsResp.json();
          const projectList = Array.isArray(projectsData) ? projectsData : [];
          const currentProject = projectList.find((project) => project.id === projectId);
          const targetProjectType = currentProject?.project_type || '';
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
      } catch (err) {
        setError(err.message || 'Failed to load project configuration');
      } finally {
        setLoading(false);
      }
    };

    loadConfiguration();
  }, [projectId]);

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

  const saveConfiguration = async () => {
    const validationErrors = validateConfiguration(config);
    if (validationErrors.length > 0) {
      setError(validationErrors.join(' '));
      setStatusMessage('');
      return;
    }

    try {
      setSaving(true);
      setError(null);
      const response = await fetch(`/api/projects/${projectId}/configuration`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config }),
      });
      if (!response.ok) {
        throw new Error(`Failed to save project configuration (${response.status})`);
      }
      setStatusMessage('Configuration saved.');
    } catch (err) {
      setError(err.message || 'Failed to save project configuration');
    } finally {
      setSaving(false);
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
    setConfig((previous) => ({
      ...previous,
      image_modalities: (previous.image_modalities || []).map((modality, modalityIndex) =>
        modalityIndex === index ? { ...modality, ...patch } : modality,
      ),
    }));
  };

  const removeImageModality = (index) => {
    setConfig((previous) => ({
      ...previous,
      image_modalities: (previous.image_modalities || []).filter((_, modalityIndex) => modalityIndex !== index),
    }));
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

  const copyConfiguration = async () => {
    if (!copySourceProjectId || copyingConfiguration) return;

    try {
      setCopyingConfiguration(true);
      setError(null);
      setStatusMessage('');
      const cloneResp = await fetch(`/api/projects/${projectId}/configuration/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_project_id: copySourceProjectId }),
      });

      const cloneData = await cloneResp.json();
      if (!cloneResp.ok) {
        throw new Error(cloneData?.detail || `Failed to copy project configuration (${cloneResp.status})`);
      }

      setConfig(cloneData?.config || EMPTY_CONFIG);
      const copiedFromProject = selectedCopySourceProject?.name || 'existing project';
      setCopySourceProjectId('');
      setStatusMessage(`Configuration copied from ${copiedFromProject}.`);
    } catch (err) {
      setStatusMessage('');
      setError(err.message || 'Failed to copy project configuration');
    } finally {
      setCopyingConfiguration(false);
    }
  };

  return (
    <section className="workbench-panel" aria-label="Project Configuration">
      <header className="workbench-header">
        <div>
          <h2>Project Configuration</h2>
          <p>
            Configure modalities, part views, defect definitions, process controls, and display options.
          </p>
        </div>
      </header>

      {loading && <div className="loading-text">Loading project configuration…</div>}
      {error && !loading && <div className="alert alert-error">{error}</div>}
      {statusMessage && !loading && <div className="alert alert-success">{statusMessage}</div>}

      {!loading && !error && (
        <>
          <div className="workbench-summary-grid" data-testid="project-configuration-summary">
            <article className="summary-card">
              <h3>Image Modalities</h3>
              <p>{config.image_modalities.length} configured</p>
            </article>
            <article className="summary-card">
              <h3>Part Views</h3>
              <p>{config.part_views.length} configured</p>
            </article>
            <article className="summary-card">
              <h3>Defect Types</h3>
              <p>{config.defect_types.length} configured</p>
            </article>
          </div>

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
            <div className="workbench-controls-row">
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
          </section>

          <section className="part-detail-panel" aria-label="Image modalities">
            <h3>Image Modalities</h3>
            <p>Manage modality definitions and calibration requirements for this project.</p>
            <div className="workbench-controls-row">
              <button className="btn btn-secondary" type="button" onClick={addImageModality} disabled={saving}>
                Add Modality
              </button>
            </div>
            {(config.image_modalities || []).length === 0 ? (
              <p>No image modalities configured yet.</p>
            ) : (
              (config.image_modalities || []).map((modality, index) => (
                <div className="workbench-controls-row" key={`image-modality-${index}`}>
                  <label htmlFor={`image-modality-label-${index}`}>Label</label>
                  <input
                    id={`image-modality-label-${index}`}
                    aria-label={`Image modality label ${index + 1}`}
                    type="text"
                    value={modality.label || ''}
                    onChange={(event) => updateImageModality(index, { label: event.target.value })}
                  />
                  <label htmlFor={`image-modality-id-${index}`}>Identifier</label>
                  <input
                    id={`image-modality-id-${index}`}
                    aria-label={`Image modality id ${index + 1}`}
                    type="text"
                    value={modality.id || ''}
                    onChange={(event) => updateImageModality(index, { id: event.target.value })}
                  />
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`Image modality calibration required ${index + 1}`}
                      checked={Boolean(modality.calibration_required)}
                      onChange={(event) =>
                        updateImageModality(index, { calibration_required: event.target.checked })
                      }
                    />
                    Calibration required
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      aria-label={`Image modality example uploaded ${index + 1}`}
                      checked={Boolean(modality.example_image_uploaded)}
                      onChange={(event) =>
                        updateImageModality(index, { example_image_uploaded: event.target.checked })
                      }
                    />
                    Example uploaded
                  </label>
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
              ))
            )}
          </section>

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
                <div className="workbench-controls-row" key={`defect-type-${index}`}>
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

          <section className="part-detail-panel" aria-label="Part views">
            <h3>Part Views</h3>
            <p>Configure external/internal views and required modalities for each view.</p>
            <div className="workbench-controls-row">
              <button className="btn btn-secondary" type="button" onClick={addPartView} disabled={saving}>
                Add Part View
              </button>
            </div>
            {(config.part_views || []).length === 0 ? (
              <p>No part views configured yet.</p>
            ) : (
              (config.part_views || []).map((partView, index) => (
                <div className="workbench-controls-row" key={`part-view-${index}`}>
                  <label htmlFor={`part-view-label-${index}`}>Label</label>
                  <input
                    id={`part-view-label-${index}`}
                    aria-label={`Part view label ${index + 1}`}
                    type="text"
                    value={partView.label || ''}
                    onChange={(event) => updatePartView(index, { label: event.target.value })}
                  />
                  <label htmlFor={`part-view-id-${index}`}>Identifier</label>
                  <input
                    id={`part-view-id-${index}`}
                    aria-label={`Part view id ${index + 1}`}
                    type="text"
                    value={partView.id || ''}
                    onChange={(event) => updatePartView(index, { id: event.target.value })}
                  />
                  <label htmlFor={`part-view-required-modalities-${index}`}>Required modalities</label>
                  <input
                    id={`part-view-required-modalities-${index}`}
                    aria-label={`Part view required modalities ${index + 1}`}
                    type="text"
                    value={(partView.required_modalities || []).join(', ')}
                    onChange={(event) =>
                      updatePartView(index, {
                        required_modalities: event.target.value
                          .split(',')
                          .map((value) => value.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                  <label htmlFor={`part-view-source-${index}`}>Source</label>
                  <select
                    id={`part-view-source-${index}`}
                    aria-label={`Part view source ${index + 1}`}
                    value={partView.source || 'manual'}
                    onChange={(event) => updatePartView(index, { source: event.target.value })}
                  >
                    <option value="manual">manual</option>
                    <option value="auto">auto</option>
                  </select>
                  <button
                    className="btn btn-secondary"
                    type="button"
                    aria-label={`Remove part view ${index + 1}`}
                    onClick={() => removePartView(index)}
                    disabled={saving}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
          </section>

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
          </section>

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
                disabled={!hasCompatibleCopySources || copyingConfiguration}
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
                disabled={!copySourceProjectId || !hasCompatibleCopySources || copyingConfiguration}
                onClick={copyConfiguration}
              >
                {copyingConfiguration ? 'Copying...' : 'Copy from Project'}
              </button>
            </div>
          </section>

          <div className="workbench-controls-row">
            <button className="btn btn-primary" type="button" disabled={saving} onClick={saveConfiguration}>
              {saving ? 'Saving...' : 'Save Configuration'}
            </button>
            <span>{hasConfiguration ? 'Configuration is populated.' : 'Using defaults until sections are configured.'}</span>
          </div>
        </>
      )}
    </section>
  );
}

export default ProjectConfigurationPanel;
