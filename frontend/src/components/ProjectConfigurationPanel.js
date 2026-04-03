import React, { useEffect, useMemo, useState } from 'react';

const EMPTY_CONFIG = {
  image_modalities: [],
  part_views: [],
  defect_types: [],
  process_settings: {
    require_disposition_on_submit: true,
    require_measurement_for_critical: false,
    require_second_reviewer_for_reject: false,
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
  const [copySourceProjectId, setCopySourceProjectId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');

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
          const filtered = Array.isArray(projectsData)
            ? projectsData.filter((project) => project.id !== projectId)
            : [];
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

  const hasConfiguration = useMemo(
    () =>
      config.image_modalities.length > 0 ||
      config.part_views.length > 0 ||
      config.defect_types.length > 0,
    [config.defect_types.length, config.image_modalities.length, config.part_views.length],
  );

  const saveConfiguration = async () => {
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

  const copyConfiguration = async () => {
    if (!copySourceProjectId) return;

    try {
      setSaving(true);
      setError(null);
      const sourceResp = await fetch(`/api/projects/${copySourceProjectId}/configuration`);
      if (!sourceResp.ok) {
        throw new Error(`Failed to load source configuration (${sourceResp.status})`);
      }
      const sourceData = await sourceResp.json();
      const copiedConfig = sourceData?.config || EMPTY_CONFIG;
      setConfig(copiedConfig);

      const persistResp = await fetch(`/api/projects/${projectId}/configuration`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: copiedConfig }),
      });

      if (!persistResp.ok) {
        throw new Error(`Failed to persist copied configuration (${persistResp.status})`);
      }

      setStatusMessage('Configuration copied from existing project.');
    } catch (err) {
      setError(err.message || 'Failed to copy project configuration');
    } finally {
      setSaving(false);
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
            <p>Copy settings from another project into this one.</p>
            <div className="workbench-controls-row">
              <select
                aria-label="Source project"
                value={copySourceProjectId}
                onChange={(event) => setCopySourceProjectId(event.target.value)}
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
                disabled={!copySourceProjectId || saving}
                onClick={copyConfiguration}
              >
                Copy from Project
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
