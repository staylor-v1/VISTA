const projectId = 'proj-e2e-inspection';

const initialProject = {
  id: projectId,
  name: 'E2E Inspection Workflow Project',
  description: 'Synthetic project for end-to-end inspection workflow coverage',
  meta_group_id: 'qa-team',
  project_type: 'PT1',
};

function buildReviewStatus(parts, imageCount) {
  const summary = {
    total_images: imageCount,
    reviewed: 0,
    unreviewed: 0,
    passed: 0,
    reject_pending: 0,
    reject_confirmed: 0,
  };

  parts.forEach((part) => {
    const state = part.review_state || 'unreviewed';
    if (state === 'pass') summary.passed += 1;
    else if (state === 'reject_pending') summary.reject_pending += 1;
    else if (state === 'reject_confirmed') summary.reject_confirmed += 1;

    if (state === 'unreviewed') summary.unreviewed += 1;
    else summary.reviewed += 1;
  });

  return summary;
}

async function mockFullInspectionWorkflowRoutes(page) {
  const projects = [];
  const uploadedImages = [];
  const savedWorkspaceStates = [];
  const reportRequests = [];
  const bundleSummary = {
    imagesTotal: 0,
    overlaysConfiguredLayers: 3,
    annotationsTotal: 1,
  };

  let mutableParts = [
    {
      id: 'part-e2e-001',
      batch_id: 'batch-e2e-1',
      serial_number: 'SN-E2E-001',
      display_name: 'Housing E2E A',
      review_state: 'unreviewed',
      metadata: {
        defects: [{ severity: 'minor' }],
        view_images: {
          front: 'housing-e2e-a-front.png',
          back: 'housing-e2e-a-back.png',
        },
      },
    },
    {
      id: 'part-e2e-002',
      batch_id: 'batch-e2e-1',
      serial_number: 'SN-E2E-002',
      display_name: 'Housing E2E B',
      review_state: 'unreviewed',
      metadata: {
        defects: [{ severity: 'critical' }],
        view_images: {
          front: 'housing-e2e-b-front.png',
        },
      },
    },
  ];

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();

    if (url.endsWith('/api/users/me')) {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ detail: 'Unauthorized' }) });
      return;
    }

    if ((url.endsWith('/api/projects/') || url.endsWith('/api/projects')) && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(projects) });
      return;
    }

    if ((url.endsWith('/api/projects/') || url.endsWith('/api/projects')) && method === 'POST') {
      const payload = request.postDataJSON() || {};
      const created = {
        ...initialProject,
        name: payload.name || initialProject.name,
        description: payload.description || initialProject.description,
        meta_group_id: payload.meta_group_id || initialProject.meta_group_id,
        project_type: payload.project_type || initialProject.project_type,
      };
      projects.splice(0, projects.length, created);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(created) });
      return;
    }

    if (url.endsWith(`/api/projects/${projectId}`) && method === 'GET') {
      const project = projects[0] || initialProject;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(project) });
      return;
    }

    if (url.endsWith(`/api/projects/${projectId}/metadata-dict`)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      return;
    }

    if (url.endsWith(`/api/projects/${projectId}/classes`)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return;
    }

    if (url.endsWith(`/api/projects/${projectId}/has-groups`)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ has_groups: false }) });
      return;
    }

    if (url.endsWith(`/api/projects/${projectId}/configuration`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          project_id: projectId,
          config: {
            phase_settings: {
              data_ingestion: { required_parts: 2 },
              inspection: { required_annotations: 1 },
            },
          },
        }),
      });
      return;
    }

    if (url.includes(`/api/projects/${projectId}/images`) && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(uploadedImages) });
      return;
    }

    if (url.endsWith(`/api/projects/${projectId}/images`) && method === 'POST') {
      const rawPayload = request.postData() || '';
      const filenames = [...rawPayload.matchAll(/filename="([^"]+)"/g)].map((match) => match[1]);
      const filename = filenames[0] || `synthetic-upload-${uploadedImages.length + 1}.png`;
      const image = {
        id: `img-${uploadedImages.length + 1}`,
        filename,
        metadata: {},
      };
      uploadedImages.push(image);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(image) });
      return;
    }

    if (url.endsWith(`/api/projects/${projectId}/batches`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'batch-e2e-1', name: 'Batch E2E 1' }]),
      });
      return;
    }

    if (url.endsWith(`/api/projects/${projectId}/parts`)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mutableParts) });
      return;
    }

    if (url.includes(`/api/projects/${projectId}/parts/`) && method === 'PATCH') {
      const partId = url.split('/').pop();
      const payload = request.postDataJSON() || {};
      mutableParts = mutableParts.map((part) => (
        part.id === partId
          ? { ...part, review_state: payload.review_state || part.review_state }
          : part
      ));
      const updated = mutableParts.find((part) => part.id === partId);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(updated) });
      return;
    }

    if (url.endsWith(`/api/projects/${projectId}/workspace-state`) && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          project_id: projectId,
          user_email: 'workflow-e2e@example.com',
          state: {
            selected_batch_id: 'batch-e2e-1',
            selected_part_id: mutableParts[0].id,
            defect_filter: 'all',
            sort_mode: 'serial_asc',
          },
        }),
      });
      return;
    }

    if (url.endsWith(`/api/projects/${projectId}/workspace-state`) && method === 'PUT') {
      const payload = request.postDataJSON() || {};
      savedWorkspaceStates.push(payload);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
      return;
    }

    if (url.endsWith(`/api/projects/${projectId}/review-status`) && method === 'GET') {
      const summary = buildReviewStatus(mutableParts, uploadedImages.length);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(summary) });
      return;
    }

    if (url.endsWith(`/api/projects/${projectId}/export-bundle-json`) && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          bundle_summary: {
            images: { total: bundleSummary.imagesTotal },
            overlays: { configured_layers: bundleSummary.overlaysConfiguredLayers },
            annotations: { total: bundleSummary.annotationsTotal },
          },
        }),
      });
      return;
    }

    if (url.endsWith(`/api/projects/${projectId}/export-bundle`) && method === 'GET') {
      await route.fulfill({ status: 200, headers: { 'content-type': 'application/zip' }, body: 'zip-data' });
      return;
    }

    if (url.endsWith(`/api/projects/${projectId}/report-json`) && method === 'GET') {
      const summary = buildReviewStatus(mutableParts, uploadedImages.length);
      reportRequests.push({ method: 'json', summary });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          project: { id: projectId },
          summary,
          parts: mutableParts.map((part) => ({
            part_id: part.id,
            part_name: part.display_name,
            review_state: part.review_state,
          })),
        }),
      });
      return;
    }

    if (url.endsWith(`/api/projects/${projectId}/report-pdf`) && method === 'GET') {
      reportRequests.push({ method: 'pdf' });
      await route.fulfill({ status: 200, headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.4 synthetic' });
      return;
    }

    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'mock route not found' }) });
  });

  return {
    projectId,
    getUploadedImages: () => uploadedImages,
    getParts: () => mutableParts,
    getSavedWorkspaceStates: () => savedWorkspaceStates,
    getReportRequests: () => reportRequests,
  };
}

module.exports = {
  mockFullInspectionWorkflowRoutes,
};
