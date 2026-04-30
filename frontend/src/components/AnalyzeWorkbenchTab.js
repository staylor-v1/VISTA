import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const DEFAULT_WORKFLOW_NAME = 'Part image analysis workflow';
const OUTPUT_METHOD_ID = 'output.versioned_image_artifact';

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
    OUTPUT_METHOD_ID,
  ];
  return preferred
    .map((methodId) => methods.find((method) => method.id === methodId))
    .filter(Boolean)
    .map((method, index) => makeNode(method, index, {
      id: index === 0 ? 'input-source' : undefined,
      label: index === 0 ? 'Loaded Part Images' : method.name,
      y: method.id === OUTPUT_METHOD_ID ? 132 : undefined,
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

function imageIdFor(image) {
  return image?.image_id || image?.id || '';
}

function imageLabel(image) {
  const filename = image?.filename || 'Image';
  const side = image?.side ? ` / ${image.side}` : '';
  const slice = image?.slice_index !== null && image?.slice_index !== undefined ? ` / slice ${image.slice_index}` : '';
  return `${filename}${side}${slice}`;
}

function partIdFor(part) {
  return part?.part_id || part?.id || '';
}

function partLabel(part) {
  return part?.display_name || part?.serial_number || 'Part';
}

function imageIdsForPart(inputSource, partId) {
  return (inputSource?.images || [])
    .filter((image) => String(image.part_id || '') === String(partId))
    .map(imageIdFor)
    .filter(Boolean);
}

function eventPoint(event) {
  const clientX = Number.isFinite(event.clientX) ? event.clientX : Number(event.pageX) || 0;
  const clientY = Number.isFinite(event.clientY) ? event.clientY : Number(event.pageY) || 0;
  return { clientX, clientY };
}

function shouldIgnoreMouseFallback(event) {
  return event.type?.startsWith('mouse') && typeof window !== 'undefined' && Boolean(window.PointerEvent);
}

function buildOutputConfig(nodes) {
  const outputNode = nodes.find((node) => node.method_id === OUTPUT_METHOD_ID);
  const params = outputNode?.parameters || {};
  return {
    mode: params.mode || 'versioned_image',
    version_strategy: params.version_strategy || 'append_vn',
    preserve_original: params.preserve_original !== false,
    overlay_metadata: params.overlay_metadata !== false,
    measurement_table: params.measurement_table !== false,
    destination: 'project_images',
  };
}

function buildRunSource({ inputSource, selectedImageIds, exampleImageId, runScope }) {
  const images = inputSource?.images || [];
  const runImageIds = runScope === 'example'
    ? [exampleImageId].filter(Boolean)
    : selectedImageIds;
  const selectedSet = new Set(runImageIds.map(String));
  const selectedImages = images.filter((image) => selectedSet.has(String(imageIdFor(image))));
  const selectedPartIds = [...new Set(selectedImages.map((image) => image.part_id).filter(Boolean))];
  const allLoaded = images.length > 0 && selectedImages.length === images.length && runScope !== 'example';

  return {
    ...(inputSource?.source || {}),
    id: runScope === 'example' ? 'example-image-selection' : allLoaded ? 'all-loaded-part-images' : 'configured-process-selection',
    label: runScope === 'example' ? 'Chosen example image' : allLoaded ? 'All images from loaded parts' : 'Configured process image set',
    kind: allLoaded ? 'project_parts' : 'manual_selection',
    image_count: selectedImages.length,
    part_count: allLoaded ? (inputSource?.source?.part_count || 0) : selectedPartIds.length,
    selected_image_ids: allLoaded ? [] : runImageIds,
    selected_part_ids: allLoaded ? [] : selectedPartIds,
    example_image_id: exampleImageId || null,
  };
}

function buildWorkflow({ nodes, inputSource, selectedImageIds, exampleImageId, runScope }) {
  return {
    name: DEFAULT_WORKFLOW_NAME,
    source: buildRunSource({ inputSource, selectedImageIds, exampleImageId, runScope }),
    output: buildOutputConfig(nodes),
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

function ExampleImageParameter({ images, value, onChange, inputId = 'analyze-param-example-image' }) {
  return (
    <label className="analyze-field" htmlFor={inputId}>
      <span>Choose Example</span>
      <select
        id={inputId}
        value={value || ''}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">No example selected</option>
        {images.map((image) => {
          const id = imageIdFor(image);
          return <option key={id} value={id}>{imageLabel(image)}</option>;
        })}
      </select>
    </label>
  );
}

function InputSelectionModal({
  inputSource,
  processImageSet,
  availableImages,
  stagedImages,
  exampleImageId,
  onChooseExample,
  onClose,
  onDragStart,
  onDrop,
  onMoveImage,
  onRemoveImage,
  onMovePart,
  onRemovePart,
}) {
  const parts = inputSource?.parts || [];

  const renderImageButton = (image, mode) => {
    const id = imageIdFor(image);
    const inProcess = processImageSet.has(String(id));
    return (
      <div key={`${mode}-${id}`} className="analyze-source-image-row">
        <button
          type="button"
          className="analyze-source-image-name"
          draggable
          onDragStart={(event) => {
            event.dataTransfer?.setData('text/plain', id);
            onDragStart({ type: 'image', id });
          }}
          onClick={() => onChooseExample(id)}
          title="Click to use as the example image, or drag between columns."
        >
          {imageLabel(image)}
        </button>
        <button
          type="button"
          className="btn btn-small btn-secondary"
          onClick={() => (inProcess ? onRemoveImage(id) : onMoveImage(id))}
        >
          {inProcess ? 'Remove' : 'Process'}
        </button>
      </div>
    );
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal-content analyze-input-modal" role="dialog" aria-modal="true" aria-labelledby="analyze-input-title">
        <div className="modal-header">
          <div>
            <p className="analyze-eyebrow">Input Source</p>
            <h3 id="analyze-input-title">Loaded Images to Process</h3>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close input source chooser">&times;</button>
        </div>

        <div className="analyze-example-select">
          <ExampleImageParameter
            images={stagedImages.length > 0 ? stagedImages : (inputSource?.images || [])}
            value={exampleImageId}
            onChange={onChooseExample}
            inputId="analyze-param-example-image-modal"
          />
        </div>

        <div className="analyze-source-modal-grid">
          <section
            className="analyze-source-column"
            data-testid="analyze-loaded-dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => onDrop('loaded')}
          >
            <h4>Loaded</h4>
            <p className="muted">Images available in loaded parts but not currently in the processing set.</p>
            {parts.map((part) => {
              const id = partIdFor(part);
              const partImages = (inputSource?.images || []).filter((image) => String(image.part_id || '') === String(id));
              const availablePartImages = partImages.filter((image) => !processImageSet.has(String(imageIdFor(image))));
              if (availablePartImages.length === 0) return null;
              return (
                <article className="analyze-source-part" key={`loaded-${id}`}>
                  <button
                    type="button"
                    className="analyze-source-part-name"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer?.setData('text/plain', id);
                      onDragStart({ type: 'part', id });
                    }}
                    onClick={() => onMovePart(id)}
                  >
                    {partLabel(part)}
                  </button>
                  <div>{availablePartImages.map((image) => renderImageButton(image, 'loaded'))}</div>
                </article>
              );
            })}
            {availableImages.length === 0 && <p className="muted">All loaded images are in Process.</p>}
          </section>

          <section
            className="analyze-source-column process"
            data-testid="analyze-process-dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => onDrop('process')}
          >
            <h4>Process</h4>
            <p className="muted">Run Example uses the chosen example. Run uses this full processing set.</p>
            {parts.map((part) => {
              const id = partIdFor(part);
              const partImages = (inputSource?.images || []).filter((image) => String(image.part_id || '') === String(id));
              const processPartImages = partImages.filter((image) => processImageSet.has(String(imageIdFor(image))));
              if (processPartImages.length === 0) return null;
              return (
                <article className="analyze-source-part" key={`process-${id}`}>
                  <button
                    type="button"
                    className="analyze-source-part-name"
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer?.setData('text/plain', id);
                      onDragStart({ type: 'part', id });
                    }}
                    onClick={() => onRemovePart(id)}
                  >
                    {partLabel(part)}
                  </button>
                  <div>{processPartImages.map((image) => renderImageButton(image, 'process'))}</div>
                </article>
              );
            })}
            {stagedImages.length === 0 && <p className="muted">Drop loaded images or part names here.</p>}
          </section>
        </div>
      </div>
    </div>
  );
}

function AnalyzeWorkbenchTab({ projectId, projectType, setError }) {
  const [methods, setMethods] = useState([]);
  const [inputSource, setInputSource] = useState(null);
  const [nodes, setNodes] = useState([]);
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [processImageIds, setProcessImageIds] = useState([]);
  const [exampleImageId, setExampleImageId] = useState('');
  const [inputModalOpen, setInputModalOpen] = useState(false);
  const [dragPayload, setDragPayload] = useState(null);
  const [graphDrag, setGraphDrag] = useState(null);
  const [status, setStatus] = useState({ loading: true, message: 'Loading analyze workspace...', result: null });
  const graphDragRef = useRef(null);
  const suppressNodeClickRef = useRef(null);

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
  const loadedImages = inputSource?.images || [];
  const processImageSet = useMemo(() => new Set(processImageIds.map(String)), [processImageIds]);
  const stagedImages = useMemo(
    () => loadedImages.filter((image) => processImageSet.has(String(imageIdFor(image)))),
    [loadedImages, processImageSet]
  );
  const availableImages = useMemo(
    () => loadedImages.filter((image) => !processImageSet.has(String(imageIdFor(image)))),
    [loadedImages, processImageSet]
  );
  const outputConfig = useMemo(() => buildOutputConfig(nodes), [nodes]);

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
        const initialImageIds = (inputPayload?.images || []).map(imageIdFor).filter(Boolean);
        setProcessImageIds(initialImageIds);
        setExampleImageId(initialImageIds[0] || '');
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
    if (selectedNode.method_id === 'source.project_part_images' && name === 'example_image_id') {
      setExampleImageId(value);
    }
    setNodes((prevNodes) => prevNodes.map((node) => (
      node.id === selectedNode.id
        ? { ...node, parameters: { ...node.parameters, [name]: value } }
        : node
    )));
  }, [selectedNode]);

  const moveImagesToProcess = useCallback((imageIds) => {
    const ids = imageIds.filter(Boolean).map(String);
    if (ids.length === 0) return;
    setProcessImageIds((prevIds) => [...new Set([...prevIds.map(String), ...ids])]);
    setExampleImageId((prevExample) => prevExample || ids[0] || '');
  }, []);

  const removeImagesFromProcess = useCallback((imageIds) => {
    const removeSet = new Set(imageIds.filter(Boolean).map(String));
    setProcessImageIds((prevIds) => {
      const nextIds = prevIds.filter((id) => !removeSet.has(String(id)));
      setExampleImageId((prevExample) => (
        prevExample && !removeSet.has(String(prevExample)) ? prevExample : nextIds[0] || ''
      ));
      return nextIds;
    });
  }, []);

  const movePartToProcess = useCallback((partId) => {
    moveImagesToProcess(imageIdsForPart(inputSource, partId));
  }, [inputSource, moveImagesToProcess]);

  const removePartFromProcess = useCallback((partId) => {
    removeImagesFromProcess(imageIdsForPart(inputSource, partId));
  }, [inputSource, removeImagesFromProcess]);

  const handleDragStart = useCallback((payload) => {
    setDragPayload(payload);
  }, []);

  const handleDrop = useCallback((target) => {
    if (!dragPayload) return;
    const ids = dragPayload.type === 'part'
      ? imageIdsForPart(inputSource, dragPayload.id)
      : [dragPayload.id];
    if (target === 'process') {
      moveImagesToProcess(ids);
    } else {
      removeImagesFromProcess(ids);
    }
    setDragPayload(null);
  }, [dragPayload, inputSource, moveImagesToProcess, removeImagesFromProcess]);

  const handleNodeClick = useCallback((node) => {
    if (suppressNodeClickRef.current === node.id) {
      suppressNodeClickRef.current = null;
      return;
    }
    setSelectedNodeId(node.id);
    if (node.method_id === 'source.project_part_images') {
      setInputModalOpen(true);
    }
  }, []);

  const beginNodeDrag = useCallback((event, node) => {
    if (shouldIgnoreMouseFallback(event)) return;
    if (event.button !== undefined && event.button !== 0) return;
    const { clientX, clientY } = eventPoint(event);
    const dragState = {
      id: node.id,
      startX: clientX,
      startY: clientY,
      nodeX: node.x,
      nodeY: node.y,
      moved: false,
    };
    graphDragRef.current = dragState;
    setGraphDrag(dragState);
    setSelectedNodeId(node.id);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }, []);

  const moveNodeDrag = useCallback((event) => {
    if (shouldIgnoreMouseFallback(event)) return;
    const dragState = graphDragRef.current;
    if (!dragState) return;
    const { clientX, clientY } = eventPoint(event);
    const dx = clientX - dragState.startX;
    const dy = clientY - dragState.startY;
    const moved = dragState.moved || Math.abs(dx) > 2 || Math.abs(dy) > 2;
    const nextX = Math.max(12, Math.round(dragState.nodeX + dx));
    const nextY = Math.max(12, Math.round(dragState.nodeY + dy));
    const nextDrag = { ...dragState, moved };
    graphDragRef.current = nextDrag;
    setGraphDrag(nextDrag);
    setNodes((prevNodes) => prevNodes.map((node) => (
      node.id === dragState.id ? { ...node, x: nextX, y: nextY } : node
    )));
  }, []);

  const endNodeDrag = useCallback((event) => {
    if (shouldIgnoreMouseFallback(event)) return;
    const dragState = graphDragRef.current;
    if (!dragState) return;
    if (dragState.moved) {
      suppressNodeClickRef.current = dragState.id;
    }
    graphDragRef.current = null;
    setGraphDrag(null);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }, []);

  const removeSelectedNode = useCallback(() => {
    if (!selectedNode) return;
    setNodes((prevNodes) => {
      const selectedIndex = prevNodes.findIndex((node) => node.id === selectedNode.id);
      const nextNodes = prevNodes.filter((node) => node.id !== selectedNode.id);
      const nextSelectedNode = nextNodes[Math.min(selectedIndex, nextNodes.length - 1)] || nextNodes[0] || null;
      setSelectedNodeId(nextSelectedNode?.id || null);
      return nextNodes;
    });
    if (selectedNode.method_id === 'source.project_part_images') {
      setInputModalOpen(false);
    }
  }, [selectedNode]);

  const submitWorkflow = useCallback(async (mode, runScope = 'all') => {
    try {
      const selectedIds = processImageIds.length > 0 ? processImageIds : loadedImages.map(imageIdFor).filter(Boolean);
      const runLabel = runScope === 'example' ? 'example image' : `${selectedIds.length || 0} configured images`;
      setStatus({ loading: true, message: mode === 'execute' ? `Simulating ${runLabel}...` : 'Validating workflow...', result: null });
      const workflow = buildWorkflow({
        nodes,
        inputSource,
        selectedImageIds: selectedIds,
        exampleImageId,
        runScope,
      });
      const resp = await fetch(`/api/projects/${projectId}/analyze/workflows/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(workflow),
      });
      const payload = await resp.json();
      if (!resp.ok) throw new Error(payload?.detail || `Workflow ${mode} failed`);
      setStatus({
        loading: false,
        message: mode === 'execute'
          ? `Workflow simulation completed for ${runScope === 'example' ? 'the example image' : 'the configured image set'}; no image artifacts were generated.`
          : 'Workflow contract validated',
        result: payload,
      });
    } catch (err) {
      const message = err.message || 'Workflow request failed';
      setStatus({ loading: false, message, result: null });
      if (setError) setError(message);
    }
  }, [exampleImageId, inputSource, loadedImages, nodes, processImageIds, projectId, setError]);

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
          <span>{stagedImages.length} process</span>
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
              <button type="button" className="btn btn-secondary" disabled={status.loading || !exampleImageId || nodes.length === 0} onClick={() => submitWorkflow('execute', 'example')}>
                Run Example
              </button>
              <button type="button" className="btn btn-primary" disabled={status.loading || nodes.length === 0} onClick={() => submitWorkflow('execute', 'all')}>
                Run
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
                  className={`analyze-node ${selectedNodeId === node.id ? 'selected' : ''} ${graphDrag?.id === node.id ? 'dragging' : ''}`}
                  style={{ left: node.x, top: node.y }}
                  onPointerDown={(event) => beginNodeDrag(event, node)}
                  onPointerMove={moveNodeDrag}
                  onPointerUp={endNodeDrag}
                  onPointerCancel={endNodeDrag}
                  onMouseDown={(event) => beginNodeDrag(event, node)}
                  onMouseMove={moveNodeDrag}
                  onMouseUp={endNodeDrag}
                  onMouseLeave={endNodeDrag}
                  onClick={() => handleNodeClick(node)}
                  aria-label={`Workflow block ${node.label}`}
                  title="Drag to reposition this workflow block"
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
              {(selectedMethod.parameters || []).map((parameter) => {
                if (selectedMethod.id === 'source.project_part_images' && parameter.name === 'example_image_id') {
                  return (
                    <ExampleImageParameter
                      key={parameter.name}
                      images={stagedImages.length > 0 ? stagedImages : loadedImages}
                      value={exampleImageId}
                      onChange={(value) => updateSelectedParameter(parameter.name, value)}
                      inputId="analyze-param-example-image-inspector"
                    />
                  );
                }
                return (
                  <ParameterInput
                    key={parameter.name}
                    parameter={parameter}
                    value={selectedNode.parameters?.[parameter.name]}
                    onChange={(value) => updateSelectedParameter(parameter.name, value)}
                  />
                );
              })}
            </div>
          )}
          {selectedMethod?.id === OUTPUT_METHOD_ID && (
            <div className="analyze-output-note">
              <strong>Non-destructive output</strong>
              <p>
                Source images are preserved. Versioned image output is modeled as a new filename using
                {' '}
                <code>_vN</code>
                {' '}
                while VISTA displays the newest version and can roll back to the original.
              </p>
              <span>{outputConfig.mode}</span>
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
          {selectedNode && (
            <div className="analyze-block-actions">
              <button type="button" className="btn btn-danger" onClick={removeSelectedNode}>
                Remove
              </button>
            </div>
          )}
        </aside>
      </div>
      {inputModalOpen && (
        <InputSelectionModal
          inputSource={inputSource}
          processImageSet={processImageSet}
          availableImages={availableImages}
          stagedImages={stagedImages}
          exampleImageId={exampleImageId}
          onChooseExample={(value) => {
            setExampleImageId(value);
            setNodes((prevNodes) => prevNodes.map((node) => (
              node.method_id === 'source.project_part_images'
                ? { ...node, parameters: { ...node.parameters, example_image_id: value } }
                : node
            )));
          }}
          onClose={() => setInputModalOpen(false)}
          onDragStart={handleDragStart}
          onDrop={handleDrop}
          onMoveImage={(id) => moveImagesToProcess([id])}
          onRemoveImage={(id) => removeImagesFromProcess([id])}
          onMovePart={movePartToProcess}
          onRemovePart={removePartFromProcess}
        />
      )}
    </section>
  );
}

export default AnalyzeWorkbenchTab;
