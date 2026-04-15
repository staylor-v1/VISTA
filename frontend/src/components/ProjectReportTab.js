import React, { useState } from 'react';
import { downloadExcel } from '../utils/downloadExcel';

const EXPORT_ACTIONS = {
  bundle_summary: 'bundle_summary',
  bundle_archive: 'bundle_archive',
  report_json: 'report_json',
  report_pdf: 'report_pdf',
};

function ProjectReportTab({ projectId, projectName, setError }) {
  const [bundleExport, setBundleExport] = useState({ loading: false, error: null, payload: null });
  const [bundleArchive, setBundleArchive] = useState({ loading: false, error: null, details: null });
  const [reportExport, setReportExport] = useState({ loading: false, error: null, payload: null });
  const [exportAction, setExportAction] = useState(EXPORT_ACTIONS.bundle_summary);
  const [exportingExcel, setExportingExcel] = useState(false);

  const requestExportBundleSummary = async () => {
    try {
      setBundleExport({ loading: true, error: null, payload: null });
      const resp = await fetch(`/api/projects/${projectId}/export-bundle-json`);
      if (!resp.ok) throw new Error(`Failed to generate export bundle summary (${resp.status})`);
      const payload = await resp.json();
      setBundleExport({ loading: false, error: null, payload });
    } catch (err) {
      setBundleExport({ loading: false, error: err.message || 'Failed to generate export bundle summary', payload: null });
    }
  };

  const requestExportBundleArchive = async () => {
    try {
      setBundleArchive({ loading: true, error: null, details: null });
      const resp = await fetch(`/api/projects/${projectId}/export-bundle`);
      if (!resp.ok) throw new Error(`Failed to generate export bundle archive (${resp.status})`);
      const archiveBlob = await resp.blob();
      setBundleArchive({
        loading: false,
        error: null,
        details: { sizeBytes: archiveBlob.size, contentType: resp.headers.get('content-type') || 'application/octet-stream' },
      });
    } catch (err) {
      setBundleArchive({ loading: false, error: err.message || 'Failed to generate export bundle archive', details: null });
    }
  };

  const runProjectExportAction = async () => {
    if (exportAction === EXPORT_ACTIONS.bundle_summary) return requestExportBundleSummary();
    if (exportAction === EXPORT_ACTIONS.bundle_archive) return requestExportBundleArchive();
    if (exportAction === EXPORT_ACTIONS.report_pdf) {
      try {
        setReportExport({ loading: true, error: null, payload: null });
        const resp = await fetch(`/api/projects/${projectId}/report-pdf`);
        if (!resp.ok) throw new Error(`Failed to generate PDF report (${resp.status})`);
        const blob = await resp.blob();
        setReportExport({ loading: false, error: null, payload: { format: 'pdf', sizeBytes: blob.size } });
      } catch (err) {
        setReportExport({ loading: false, error: err.message || 'Failed to generate PDF report', payload: null });
      }
      return;
    }
    try {
      setReportExport({ loading: true, error: null, payload: null });
      const resp = await fetch(`/api/projects/${projectId}/report-json`);
      if (!resp.ok) throw new Error(`Failed to generate report (${resp.status})`);
      const payload = await resp.json();
      setReportExport({ loading: false, error: null, payload });
    } catch (err) {
      setReportExport({ loading: false, error: err.message || 'Failed to generate report', payload: null });
    }
  };

  const handleExportExcel = async () => {
    try {
      setExportingExcel(true);
      await downloadExcel(projectId, projectName);
    } catch (err) {
      setError(`Export failed: ${err.message}`);
    } finally {
      setExportingExcel(false);
    }
  };

  return (
    <section className="workbench-panel" aria-label="Project report and export">
      <header className="workbench-header">
        <h2>Report</h2>
        <p>Generate project reports and export bundles.</p>
      </header>
      <div className="workbench-detail-actions">
        <button type="button" className="btn btn-primary" onClick={handleExportExcel} disabled={exportingExcel}>
          {exportingExcel ? 'Exporting...' : 'Export Data (Excel)'}
        </button>
        <label htmlFor="project-report-mode" className="form-label">Export/report mode</label>
        <select id="project-report-mode" className="form-control" value={exportAction} onChange={(e) => setExportAction(e.target.value)}>
          <option value={EXPORT_ACTIONS.bundle_summary}>Export bundle summary</option>
          <option value={EXPORT_ACTIONS.bundle_archive}>Export bundle archive</option>
          <option value={EXPORT_ACTIONS.report_json}>Project report JSON</option>
          <option value={EXPORT_ACTIONS.report_pdf}>Project report PDF</option>
        </select>
        <button type="button" className="btn btn-secondary" onClick={runProjectExportAction} disabled={bundleExport.loading || bundleArchive.loading || reportExport.loading}>
          {bundleExport.loading || bundleArchive.loading || reportExport.loading ? 'Running…' : 'Run Export/Report'}
        </button>
      </div>
      {bundleExport.error && <div className="alert alert-error">{bundleExport.error}</div>}
      {bundleArchive.error && <div className="alert alert-error">{bundleArchive.error}</div>}
      {reportExport.error && <div className="alert alert-error">{reportExport.error}</div>}
      {bundleExport.payload && <div className="alert alert-success">Export summary generated.</div>}
      {bundleArchive.details && <div className="alert alert-success">Export archive ready: {bundleArchive.details.sizeBytes} bytes.</div>}
      {reportExport.payload && <div className="alert alert-success">Report generated successfully.</div>}
    </section>
  );
}

export default ProjectReportTab;
