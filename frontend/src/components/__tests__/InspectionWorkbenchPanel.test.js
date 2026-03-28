import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import InspectionWorkbenchPanel from '../InspectionWorkbenchPanel';

const projectTypes = ['PT1', 'PT2', 'PT3'];

const scenarioByUser = [
  {
    user: 'basic',
    batches: [{ id: 'batch-basic', name: 'Batch Basic' }],
    parts: [
      {
        id: 'part-basic-1',
        batch_id: 'batch-basic',
        serial_number: 'SN-BASIC-0001',
        display_name: 'Basic Part',
        review_state: 'unreviewed',
        metadata: {
          defect_count: 0,
          configured_views: ['front', 'back'],
          view_images: { front: 'front-basic.png' },
        },
      },
    ],
  },
  {
    user: 'intermediate',
    batches: [
      { id: 'batch-mid-a', name: 'Batch Mid A' },
      { id: 'batch-mid-b', name: 'Batch Mid B' },
    ],
    parts: [
      {
        id: 'part-mid-1',
        batch_id: 'batch-mid-a',
        serial_number: 'SN-MID-0101',
        display_name: 'Mid Part 1',
        review_state: 'in_review',
        metadata: {
          defects: [{ severity: 'minor' }, { severity: 'critical' }],
          configured_views: ['left', 'right', 'top'],
          view_images: { left: 'left-mid.png' },
        },
      },
      {
        id: 'part-mid-2',
        batch_id: 'batch-mid-b',
        serial_number: 'SN-MID-0102',
        display_name: 'Mid Part 2',
        review_state: 'unreviewed',
        metadata: {
          defects: [],
          configured_views: ['front', 'back'],
        },
      },
    ],
  },
  {
    user: 'advanced',
    batches: [
      { id: 'batch-adv-a', name: 'Batch Adv A' },
      { id: 'batch-adv-b', name: 'Batch Adv B' },
    ],
    parts: [
      {
        id: 'part-adv-1',
        batch_id: 'batch-adv-a',
        serial_number: 'SN-ADV-9001',
        display_name: 'Adv Part 1',
        review_state: 'reject_pending',
        metadata: {
          defects: [{ severity: 'critical' }, { severity: 'critical' }, { severity: 'major' }],
          view_images: { front: 'adv-front.png', top: 'adv-top.png' },
        },
      },
      {
        id: 'part-adv-2',
        batch_id: 'batch-adv-a',
        serial_number: 'SN-ADV-9002',
        display_name: 'Adv Part 2',
        review_state: 'in_review',
        metadata: {
          defects: [{ severity: 'major' }],
        },
      },
      {
        id: 'part-adv-3',
        batch_id: 'batch-adv-b',
        serial_number: 'SN-ADV-9003',
        display_name: 'Adv Part 3',
        review_state: 'pass',
        metadata: {
          defects: [],
        },
      },
    ],
  },
];

function mockWorkbenchFetch({ batches, parts }) {
  let mutableParts = [...parts];

  global.fetch = jest.fn((url, options = {}) => {
    if (url.includes('/batches')) {
      return Promise.resolve({ ok: true, json: async () => batches });
    }
    if (url.includes('/parts/') && options.method === 'PATCH') {
      const partId = url.split('/').pop();
      const payload = JSON.parse(options.body || '{}');
      mutableParts = mutableParts.map((part) =>
        part.id === partId ? { ...part, review_state: payload.review_state } : part,
      );
      const updated = mutableParts.find((part) => part.id === partId);
      return Promise.resolve({ ok: true, json: async () => updated });
    }
    if (url.includes('/parts')) {
      return Promise.resolve({ ok: true, json: async () => mutableParts });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });
}

describe('InspectionWorkbenchPanel', () => {
  afterEach(() => {
    delete global.fetch;
  });

  test.each(projectTypes)('supports progressive PT workflows for %s', async (projectType) => {
    for (const scenario of scenarioByUser) {
      mockWorkbenchFetch(scenario);
      const { unmount } = render(<InspectionWorkbenchPanel projectId="proj-1" projectType={projectType} />);

      await waitFor(() => {
        expect(screen.getByText(`Batches: ${scenario.batches.length}`)).toBeInTheDocument();
      });
      expect(screen.getByText(`Parts: ${scenario.parts.length}`)).toBeInTheDocument();
      expect(screen.getByText(new RegExp(projectType))).toBeInTheDocument();

      // Defect-centric filter
      fireEvent.change(screen.getByLabelText('Defect filter'), { target: { value: 'has_defects' } });
      const expectedDefectRows = scenario.parts.filter((part) => (part.metadata?.defect_count || part.metadata?.defects?.length || 0) > 0);
      if (expectedDefectRows.length > 0) {
        expect(screen.getAllByTestId('part-review-state').length).toBe(expectedDefectRows.length);
      } else {
        expect(screen.getByText('No parts found for the current filters.')).toBeInTheDocument();
      }

      // Reset filter and test batch filter
      fireEvent.change(screen.getByLabelText('Defect filter'), { target: { value: 'all' } });
      if (scenario.batches.length > 1) {
        fireEvent.change(screen.getByLabelText('Batch'), { target: { value: scenario.batches[0].id } });
        const expectedBatchRows = scenario.parts.filter((part) => part.batch_id === scenario.batches[0].id);
        expect(screen.getAllByTestId('part-review-state').length).toBe(expectedBatchRows.length);
      }

      // Review action updates indicator
      fireEvent.click(screen.getByRole('button', { name: /mark pass/i }));
      await waitFor(() => {
        expect(screen.getByText('Passed: 1')).toBeInTheDocument();
      });

      // View-board should render at least one configured/default view cell
      expect(screen.getAllByText(/No image mapped|Mapped:/).length).toBeGreaterThan(0);

      unmount();
    }
  });
});
