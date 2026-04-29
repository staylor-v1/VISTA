import React, { useMemo, useState } from 'react';

function buildImageLookup(images) {
  return (Array.isArray(images) ? images : []).reduce((lookup, image) => {
    const filename = typeof image?.filename === 'string' ? image.filename : '';
    if (filename) lookup.set(filename, image);
    return lookup;
  }, new Map());
}

function buildImageRef(filename, imageLookup, sourceRecord = null) {
  const lookupRecord = imageLookup.get(filename) || {};
  const imageId = sourceRecord?.image_id || lookupRecord.id || null;
  return {
    id: imageId ? String(imageId) : '',
    filename,
    contentUrl: imageId ? `/api/images/${encodeURIComponent(String(imageId))}/content` : '',
    thumbnailUrl: imageId ? `/api/images/${encodeURIComponent(String(imageId))}/thumbnail?width=96&height=96` : '',
  };
}

function buildBuckets({ parts, images }) {
  const imageLookup = buildImageLookup(images);
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
      images: sourceImages
        .map((record) => (typeof record?.filename === 'string' ? buildImageRef(record.filename, imageLookup, record) : null))
        .filter(Boolean),
    };
  });

  const unassigned = (Array.isArray(images) ? images : [])
    .filter((image) => !image?.deleted_at)
    .map((image) => (typeof image?.filename === 'string' ? image.filename : ''))
    .filter(Boolean)
    .filter((filename) => !filenameToPartId.has(filename))
    .sort((left, right) => left.localeCompare(right))
    .map((filename) => buildImageRef(filename, imageLookup));

  return { partBuckets, unassigned };
}

function ImagesToPartsTab({ projectId, parts = [], images = [], onAssignmentsChanged, setError }) {
  const initialBuckets = useMemo(() => buildBuckets({ parts, images }), [parts, images]);
  const [localBuckets, setLocalBuckets] = useState(initialBuckets);
  const [movingFilename, setMovingFilename] = useState('');
  const [showThumbnails, setShowThumbnails] = useState(true);
  const [activeImageModal, setActiveImageModal] = useState(null);

  React.useEffect(() => {
    setLocalBuckets(initialBuckets);
  }, [initialBuckets]);

  React.useEffect(() => {
    if (!activeImageModal) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setActiveImageModal(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [activeImageModal]);

  const findImageRef = (filename) => {
    const allImages = [
      ...localBuckets.unassigned,
      ...localBuckets.partBuckets.flatMap((part) => part.images),
    ];
    return allImages.find((image) => image.filename === filename) || { filename };
  };

  const openImageModal = (imageRef) => {
    setActiveImageModal({
      title: imageRef.filename,
      images: [imageRef],
      mode: 'single',
    });
  };

  const openPartModal = (part) => {
    setActiveImageModal({
      title: part.displayName,
      subtitle: `Serial: ${part.serialNumber || 'Unspecified'}`,
      images: part.images,
      mode: 'part',
    });
  };

  const handleDropToPart = async (toPartId) => {
    if (!movingFilename || !toPartId) return;
    try {
      const response = await fetch(`/api/projects/${projectId}/parts/image-assignments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: movingFilename, to_part_id: toPartId }),
      });
      if (!response.ok) throw new Error(`Failed to move image (${response.status})`);
      const movedImage = findImageRef(movingFilename);
      const nextBuckets = {
        partBuckets: localBuckets.partBuckets.map((part) => {
          const withoutFile = part.images.filter((image) => image.filename !== movingFilename);
          if (part.id !== toPartId) return { ...part, images: withoutFile };
          return {
            ...part,
            images: withoutFile.some((image) => image.filename === movingFilename)
              ? withoutFile
              : [...withoutFile, movedImage].sort((left, right) => left.filename.localeCompare(right.filename)),
          };
        }),
        unassigned: localBuckets.unassigned.filter((image) => image.filename !== movingFilename),
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

  const renderImageChip = (imageRef) => (
    <button
      key={imageRef.filename}
      type="button"
      className="image-part-chip"
      draggable
      onClick={() => openImageModal(imageRef)}
      onDragStart={() => setMovingFilename(imageRef.filename)}
      title={imageRef.id ? `Open ${imageRef.filename}` : `${imageRef.filename} has no image record`}
    >
      {showThumbnails && imageRef.thumbnailUrl ? (
        <img
          src={imageRef.thumbnailUrl}
          alt=""
          className="image-part-chip-thumbnail"
          loading="lazy"
        />
      ) : null}
      <span>{imageRef.filename}</span>
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
          <label className="thumbnail-switch">
            <input
              type="checkbox"
              checked={showThumbnails}
              onChange={(event) => setShowThumbnails(event.target.checked)}
              aria-label="Show image thumbnails"
            />
            <span className="thumbnail-switch-track" aria-hidden="true">
              <span className="thumbnail-switch-thumb" />
            </span>
            <span>Thumbnails</span>
          </label>
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
                <h3>
                  <button
                    type="button"
                    className="part-heading-button"
                    onClick={() => openPartModal(part)}
                  >
                    {part.displayName}
                  </button>
                </h3>
                <p className="muted">Serial: {part.serialNumber}</p>
                <div className="image-part-chip-list">
                  {part.images.length === 0 ? <p className="muted">No mapped images.</p> : part.images.map(renderImageChip)}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {activeImageModal && (
        <div
          className="modal image-part-viewer-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="image-part-viewer-title"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setActiveImageModal(null);
          }}
        >
          <div className="modal-content image-part-viewer-content">
            <div className="modal-header">
              <div>
                <h3 id="image-part-viewer-title">{activeImageModal.title}</h3>
                {activeImageModal.subtitle ? <p className="muted">{activeImageModal.subtitle}</p> : null}
              </div>
              <button
                type="button"
                className="modal-close-btn"
                onClick={() => setActiveImageModal(null)}
                aria-label="Close image viewer"
              >
                &times;
              </button>
            </div>
            <div className="modal-body">
              {activeImageModal.images.length === 0 ? (
                <p className="muted">No mapped images for this part.</p>
              ) : (
                <div className={activeImageModal.mode === 'single' ? 'image-part-single-view' : 'image-part-tile-grid'}>
                  {activeImageModal.images.map((imageRef) => (
                    <figure className="image-part-viewer-tile" key={imageRef.filename}>
                      {imageRef.contentUrl ? (
                        <img
                          src={imageRef.contentUrl}
                          alt={imageRef.filename}
                          loading="lazy"
                          onError={(event) => {
                            if (imageRef.thumbnailUrl && event.currentTarget.src !== imageRef.thumbnailUrl) {
                              event.currentTarget.src = imageRef.thumbnailUrl;
                            }
                          }}
                        />
                      ) : (
                        <div className="image-part-missing-preview">Image unavailable</div>
                      )}
                      <figcaption>{imageRef.filename}</figcaption>
                    </figure>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ImagesToPartsTab;
