const projectId = 'proj-pt1';

function createMockData() {
  const batches = [
    { id: 'batch-a', name: 'Batch A' },
    { id: 'batch-b', name: 'Batch B' },
  ];

  const parts = [
    {
      id: 'part-001',
      batch_id: 'batch-a',
      serial_number: 'SN-PT1-001',
      display_name: 'Housing Front',
      review_state: 'in_review',
      metadata: {
        defects: [{ severity: 'minor' }, { severity: 'critical' }],
        configured_views: ['front', 'back', 'left', 'right'],
        view_images: { front: 'housing-front.png', right: 'housing-right.png' },
      },
    },
    {
      id: 'part-002',
      batch_id: 'batch-b',
      serial_number: 'SN-PT1-002',
      display_name: 'Housing Rear',
      review_state: 'unreviewed',
      metadata: {
        defects: [],
        configured_views: ['front', 'back', 'top', 'bottom'],
      },
    },
    {
      id: 'part-003',
      batch_id: 'batch-b',
      serial_number: 'SN-PT1-003',
      display_name: 'Housing Critical',
      review_state: 'reject_pending',
      metadata: {
        defects: [{ severity: 'critical' }, { severity: 'critical' }],
        view_images: { top: 'critical-top.png' },
      },
    },
  ];

  return { batches, parts };
}

async function mockInspectionWorkbenchRoutes(page, { type = 'PT1' } = {}) {
  const { batches, parts } = createMockData();
  let mutableParts = [...parts];

  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();

    if (url.endsWith('/api/users/me')) {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ detail: 'Unauthorized' }) });
      return;
    }
    if (url.endsWith(`/api/projects/${projectId}`)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: projectId,
          name: `Inspection Workbench ${type}`,
          description: 'Playwright synthetic project',
          meta_group_id: 'qa-team',
          project_type: type,
        }),
      });
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
    if (url.includes(`/api/projects/${projectId}/images`)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return;
    }
    if (url.endsWith(`/api/projects/${projectId}/batches`)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(batches) });
      return;
    }
    if (url.includes(`/api/projects/${projectId}/parts/`) && method === 'PATCH') {
      const partId = url.split('/').pop();
      const payload = route.request().postDataJSON();
      mutableParts = mutableParts.map((part) => (part.id === partId ? { ...part, review_state: payload.review_state } : part));
      const updated = mutableParts.find((part) => part.id === partId);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(updated) });
      return;
    }
    if (url.includes(`/api/projects/${projectId}/parts`)) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mutableParts) });
      return;
    }

    await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ detail: 'mock route not found' }) });
  });

  return {
    projectId,
    getParts: () => mutableParts,
  };
}

module.exports = {
  mockInspectionWorkbenchRoutes,
};
