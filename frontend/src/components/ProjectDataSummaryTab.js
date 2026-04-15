import React from 'react';

function ProjectDataSummaryTab({ counts, loading }) {
  return (
    <section className="workbench-panel" aria-label="Project data summary">
      <header className="workbench-header">
        <div>
          <h2>Project Data</h2>
          <p>Summary counts for loaded project data artifacts.</p>
        </div>
      </header>
      {loading ? (
        <div className="loading-text">Loading data counts…</div>
      ) : (
        <div className="workbench-summary-grid" data-testid="project-data-summary">
          <article className="summary-card">
            <h3>Parts Loaded</h3>
            <p>{counts.partsLoaded}</p>
          </article>
          <article className="summary-card">
            <h3>Raw Images</h3>
            <p>{counts.rawImages}</p>
          </article>
          <article className="summary-card">
            <h3>Image Metadata</h3>
            <p>{counts.imageMetadata}</p>
          </article>
          <article className="summary-card">
            <h3>Overlay Images</h3>
            <p>{counts.overlayImages}</p>
          </article>
          <article className="summary-card">
            <h3>Annotations</h3>
            <p>{counts.annotations}</p>
          </article>
        </div>
      )}
    </section>
  );
}

export default ProjectDataSummaryTab;
