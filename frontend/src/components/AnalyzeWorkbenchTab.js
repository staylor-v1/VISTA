import React, { useCallback, useEffect, useMemo, useState } from 'react';

const DEFAULT_WORKFLOW_NAME = 'Part image analysis workflow';

function groupMethods(methods) {
  return methods.reduce((groups, method) => {
    const category = method.category || 'Other';
    if (!groups[category]) groups[category] = [];
    groups[category].push(method);
    return groups;
  }, {});
}

function parameterDefaults(method) {
  return (method?.parameters || []).reduce((acc, parameter) => {
    acc[parameter.name] = parameter.default;
    return acc;
  }, {});
}

function makeNode(method, index, overrides = {}) {
  const horizontalStep = 175;
  return {
    id: overrides.id || `${method.id.replace(/[^A-Za-z0-9_.-]/g, '-')}-${index + 1}`,
    method_id: method.id,
    label: overrides.label || method.name,
    parameters: { ...parameterDefaults(method), ...(overrides.parameters || {}) },
    x: overrides.x ?? 72 + (index * horizontalStep),
    y: overrides.y ?? (index % 2 === 0 ? 84 : 188),
  };
}

function makeDefaultNodes(methods) {
  const preferred = [
    'source.project_part_images',
    'preprocess.window_level_normalization',
    'segmentation.watershed_seeds',
  ];
  return preferred
    .map((methodId) => methods.find((method) => method.id === methodId))
    .filter(Boolean)
    .map((method, index) => makeNode(method, index, {
      id: index === 0 ? 'input-source' : undefined,
      label: index === 0 ? 'Loaded Part Images' : method.name,
    }));
}

function chainEdges(nodes) {
  return nodes.slice(1).map((node, index) => ({
    source_node: nodes[index].id,
    target_node: node.id,
    source_port: 'output',
    target_port: 'input',
  }));
}

function buildWorkflow({ nodes, inputSource }) {
  return {
    name: DEFAULT_WORKFLOW_NAME,
    source: inputSource?.source || {
      id: 'all-loaded-part-images',
      label: 'All images from loaded parts',
      kind: 'project_parts',
      image_count: 0,
      part_count: 0,
    },
    nodes,
    edges: chainEdges(nodes),
  };
}

function ParameterInput({ parameter, value, onChange }) {
  const id = `analyze-param-${parameter.name}`;
  if (parameter.type === 'boolean') {
    return (
      <label className="analyze-switch" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{parameter.label}</span>
      </label>
    );
  }

  if (parameter.type === 'select' && Array.isArray(parameter.options) && parameter.options.length > 0) {
    return (
      <label className="analyze-field" htmlFor={id}>
        <span>{parameter.label}</span>
        <select id={id} value={value || parameter.default || ''} onChange={(event) => onChange(event.target.value)}>
          {parameter.options.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>
    );
  }

  const numeric = parameter.type === 'integer' || parameter.type === 'float' || parameter.type === 'range';
  return (
    <label className="analyze-field" htmlFor={id}>
      <span>{parameter.label}</span>
      <input
        id={id}
        type={numeric ? 'number' : 'text'}
        step={parameter.type === 'integer' ? 1 : 'any'}
        min={parameter.min_value ?? undefined}
        max={parameter.max_value ?? undefined}
        value={value ?? ''}
        onChange={(event) => {
          if (!numeric) {
            onChange(event.target.value);
            return;
          }
          const nextValue = event.target.value === '' ? '' : Number(event.target.value);
          onChange(nextValue);
        }}
      />
    </label>
  );
}

function AnalyzeWorkbenchTab({ projectId, projectType, setError }) {
  const [methods, setMethods] = useState([]);
  const [inputSource, setInputSource] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [status, setStatus] = useState({ loading: true, message: 'Loading analyze workspace...', result: null });

  const methodById = useMemo(() => new Map(methods.map((method) => [method.id, method])), [methods]);
  const methodsByCategory = useMemo(() => groupMethods(methods), [methods]);
  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || nodes[0] || null,
    [nodes, selectedNodeId]
  );
  const selectedMethod = selectedNode ? methodById.get(selectedNode.method_id) : null;
  const edges = useMemo(() => chainEdges(nodes), [nodes]);
  const graphBounds = useMemo(() => {
    const maxX = nodes.reduce((value, node) => Math.max(value, node.x + 220), 980);
    const maxY = nodes.reduce((value, node) => Math.max(value, node.y + 140), 540);
    return { width: maxX, height: maxY };
  }, [nodes]);

  useEffect(() => {
    let cancelled = false;
    async function loadAnalyzeWorkspace() {
      try {
        setStatus({ loading: true, message: 'Loading analyze workspace...', result: null });
        const [toolboxResp, inputResp] = await Promise.all([
          fetch('/api/analyze/toolbox'),
          fetch(`/api/projects/${projectId}/analyze/input-source`),
        ]);
        if (!toolboxResp.ok) throw new Error(`Failed to load toolbox (${toolboxResp.status})`);
        if (!inputResp.ok) throw new Error(`Failed to load analyze inputs (${inputResp.status})`);
        const [toolboxPayload, inputPayload] = await Promise.all([toolboxResp.json(), inputResp.json()]);
        if (cancelled) return;
        const loadedMethods = Array.isArray(toolboxPayload.methods) ? toolboxPayload.methods : [];
        const initialNodes = makeDefaultNodes(loadedMethods);
        setMethods(loadedMethods);
        setInputSource(inputPayload);
        setNodes(initialNodes);
        setSelectedNodeId(initialNodes[1]?.id || initialNodes[0]?.id || null);
        setStatus({
          loading: false,
          message: `${loadedMethods.length} methods ready for ${inputPayload?.source?.image_count || 0} images`,
          result: null,
        });
      } catch (err) {
        const message = err.message || 'Failed to load analyze workspace';
        if (!cancelled) {
          setStatus({ loading: false, message, result: null });
          if (setError) setError(message);
        }
      }
    }
    loadAnalyzeWorkspace();
    return () => {
      cancelled = true;
    };
  }, [projectId, setError]);

  const addMethodNode = useCallback((method) => {
    setNodes((prevNodes) => {
      const nextNode = makeNode(method, prevNodes.length, {
        x: 72 + (prevNodes.length * 175),
        y: prevNodes.length % 2 === 0 ? 84 : 188,
      });
      setSelectedNodeId(nextNode.id);
      return [...prevNodes, nextNode];
    });
  }, []);

  const updateSelectedParameter = useCallback((name, value) => {
    if (!selectedNode) return;
    setNodes((prevNodes) => prevNodes.map((node) => (
      node.id === selectedNode.id
        ? { ...node, parameters: { ...node.parameters, [name]: value } }
        : node
    )));
  }, [selectedNode]);

  const submitWorkflow = useCallback(async (mode) => {
    try {
      setStatus({ loading: true, message: mode === 'execute' ? 'Simulating workflow...' : 'Validating workflow...', result: null });
      const workflow = buildWorkflow({ nodes, inputSource });
      const resp = await fetch(`/api/projects/${projectId}/analyze/workflows/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(workflow),
      });
      const payload = await resp.json();
      if (!resp.ok) throw new Error(payload?.detail || `Workflow ${mode} failed`);
      setStatus({
        loading: false,
        message: mode === 'execute' ? 'Workflow simulation completed; no image artifacts were generated.' : 'Workflow contract validated',
        result: payload,
      });
    } catch (err) {
      const message = err.message || 'Workflow request failed';
      setStatus({ loading: false, message, result: null });
      if (setError) setError(message);
    }
  }, [inputSource, nodes, projectId, setError]);

  return (
    <section className="analyze-workbench" aria-label="Analyze Workbench">
      <div className="analyze-command-strip">
        <div>
          <p className="analyze-eyebrow">Analyze / {projectType || 'PT1'}</p>
          <h2>Workflow Studio</h2>
        </div>
        <div className="analyze-source-stats" data-testid="analyze-source-summary">
          <span>{inputSource?.source?.part_count || 0} parts</span>
          <span>{inputSource?.source?.image_count || 0} images</span>
          <span>{methods.length} methods</span>
        </div>
      </div>

      <div className="analyze-grid">
        <aside className="analyze-toolbox" aria-label="Analyze toolbox">
          {Object.entries(methodsByCategory).map(([category, categoryMethods]) => (
            <section key={category} className="analyze-toolbox-group">
              <h3>{category}</h3>
              <div className="analyze-method-list">
                {categoryMethods.map((method) => (
                  <button
                    key={method.id}
                    type="button"
                    className="analyze-method-button"
                    onClick={() => addMethodNode(method)}
                    title={method.description}
                  >
                    <span>{method.name}</span>
                    <small>{method.output_types.join(' + ')}</small>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </aside>

        <main className="analyze-canvas-panel">
          <div className="analyze-canvas-toolbar">
            <strong>{DEFAULT_WORKFLOW_NAME}</strong>
            <div className="workbench-detail-actions">
              <button type="button" className="btn btn-secondary" disabled={status.loading} onClick={() => submitWorkflow('validate')}>
                Validate
              </button>
              <button type="button" className="btn btn-primary" disabled={status.loading || nodes.length === 0} onClick={() => submitWorkflow('execute')}>
                Simulate
              </button>
            </div>
          </div>

          <div
            className="analyze-graph"
            data-testid="analyze-graph"
            style={{
              '--analyze-graph-width': `${graphBounds.width}px`,
              '--analyze-graph-height': `${graphBounds.height}px`,
            }}
          >
            <div className="analyze-graph-surface">
            <svg
              className="analyze-edges"
              aria-hidden="true"
              width={graphBounds.width}
              height={graphBounds.height}
              viewBox={`0 0 ${graphBounds.width} ${graphBounds.height}`}
            >
              {edges.map((edge, index) => {
                const source = nodes.find((node) => node.id === edge.source_node);
                const target = nodes.find((node) => node.id === edge.target_node);
                if (!source || !target) return null;
                const x1 = source.x + 168;
                const y1 = source.y + 38;
                const x2 = target.x;
                const y2 = target.y + 38;
                const midX = (x1 + x2) / 2;
                return (
                  <path
                    key={`${edge.source_node}-${edge.target_node}-${index}`}
                    d={`M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`}
                  />
                );
              })}
            </svg>
            {nodes.map((node, index) => {
              const method = methodById.get(node.method_id);
              return (
                <button
                  key={node.id}
                  type="button"
                  className={`analyze-node ${selectedNodeId === node.id ? 'selected' : ''}`}
                  style={{ left: node.x, top: node.y }}
                  onClick={() => setSelectedNodeId(node.id)}
                  aria-label={`Workflow block ${node.label}`}
                >
                  <span className="analyze-node-index">{index + 1}</span>
                  <strong>{node.label}</strong>
                  <small>{method?.category || 'Method'}</small>
                </button>
              );
            })}
            </div>
          </div>
        </main>

        <aside className="analyze-inspector" aria-label="Workflow block settings">
          <div className="analyze-inspector-header">
            <h3>{selectedNode?.label || 'No block selected'}</h3>
            <p>{selectedMethod?.id || 'Select a workflow block'}</p>
          </div>
          {selectedMethod && (
            <div className="analyze-parameters">
              {(selectedMethod.parameters || []).length === 0 && <p className="muted">No parameters</p>}
              {(selectedMethod.parameters || []).map((parameter) => (
                <ParameterInput
                  key={parameter.name}
                  parameter={parameter}
                  value={selectedNode.parameters?.[parameter.name]}
                  onChange={(value) => updateSelectedParameter(parameter.name, value)}
                />
              ))}
            </div>
          )}
          <div className="analyze-status-panel">
            <strong>{status.loading ? 'Working' : 'Status'}</strong>
            <p>{status.message}</p>
            {status.result && (
              <div className="analyze-run-summary" data-testid="analyze-run-summary">
                <span>{status.result.status}</span>
                <span>{status.result.node_results?.length || 0} blocks</span>
                <span>{status.result.image_count || 0} images</span>
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}

export default AnalyzeWorkbenchTab;
