import React, { useMemo, useState } from 'react';

function buildBuckets({ parts, images }) {
  const filenameToPartId = new Map();
  const partBuckets = (Array.isArray(parts) ? parts : []).map((part) => {
    const sourceImages = Array.isArray(part?.metadata?.source_images) ? part.metadata.source_images : [];
    const filenames = sourceImages
      .map((record) => (typeof record?.filename === 'string' ? record.filename : ''))
      .filter(Boolean);
    filenames.forEach((filename) => filenameToPartId.set(filename, part.id));
    return {
      id: part.id,
      serialNumber: part.serial_number,
      displayName: part.display_name || part.serial_number,
      filenames,
    };
  });

  const unassigned = (Array.isArray(images) ? images : [])
    .filter((image) => !image?.deleted_at)
    .map((image) => image.filename)
    .filter(Boolean)
    .filter((filename) => !filenameToPartId.has(filename))
    .sort((left, right) => left.localeCompare(right));

  return { partBuckets, unassigned };
}

function ImagesToPartsTab({ projectId, parts = [], images = [], onAssignmentsChanged, setError }) {
  const initialBuckets = useMemo(() => buildBuckets({ parts, images }), [parts, images]);
  const [localBuckets, setLocalBuckets] = useState(initialBuckets);
  const [movingFilename, setMovingFilename] = useState('');

  React.useEffect(() => {
    setLocalBuckets(initialBuckets);
  }, [initialBuckets]);

  const handleDropToPart = async (toPartId) => {
    if (!movingFilename || !toPartId) return;
    try {
      const response = await fetch(`/api/projects/${projectId}/parts/image-assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: movingFilename, to_part_id: toPartId }),
      });
      if (!response.ok) throw new Error(`Failed to move image (${response.status})`);
      const nextBuckets = {
        partBuckets: localBuckets.partBuckets.map((part) => {
          const withoutFile = part.filenames.filter((filename) => filename !== movingFilename);
          if (part.id !== toPartId) return { ...part, filenames: withoutFile };
          return {
            ...part,
            filenames: withoutFile.includes(movingFilename) ? withoutFile : [...withoutFile, movingFilename].sort(),
          };
        }),
        unassigned: localBuckets.unassigned.filter((filename) => filename !== movingFilename),
      };
      setLocalBuckets(nextBuckets);
      if (onAssignmentsChanged) await onAssignmentsChanged();
      if (setError) setError(null);
    } catch (err) {
      if (setError) setError(err.message || 'Failed to assign image to part');
    } finally {
      setMovingFilename('');
    }
  };

  const renderImageChip = (filename) => (
    <button
      key={filename}
      type="button"
      className="image-part-chip"
      draggable
      onDragStart={() => setMovingFilename(filename)}
    >
      {filename}
    </button>
  );

  return (
    <div className="project-data-tab-panel" role="tabpanel" aria-label="Images to Parts">
      <section className="workbench-panel">
        <header className="workbench-header">
          <div>
            <h2>Images to Parts</h2>
            <p>Drag images into target parts to repair or refine image assignments.</p>
          </div>
        </header>

        <div className="images-to-parts-grid">
          <div
            className="images-to-parts-column"
            onDragOver={(event) => event.preventDefault()}
          >
            <h3>Unassigned</h3>
            {localBuckets.unassigned.length === 0 ? <p className="muted">No unassigned images.</p> : null}
            <div className="image-part-chip-list">{localBuckets.unassigned.map(renderImageChip)}</div>
          </div>

          <div className="images-to-parts-column parts-column">
            {localBuckets.partBuckets.map((part) => (
              <div
                key={part.id}
                className="images-to-parts-part-card"
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => handleDropToPart(part.id)}
                data-testid={`images-to-parts-target-${part.id}`}
              >
                <h3>{part.displayName}</h3>
                <p className="muted">Serial: {part.serialNumber}</p>
                <div className="image-part-chip-list">
                  {part.filenames.length === 0 ? <p className="muted">No mapped images.</p> : part.filenames.map(renderImageChip)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

export default ImagesToPartsTab;
