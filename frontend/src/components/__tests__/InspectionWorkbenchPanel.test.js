import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import InspectionWorkbenchPanel from '../InspectionWorkbenchPanel';

jest.setTimeout(90000);

const projectTypes = ['PT1', 'PT2', 'PT3'];

const scenarioByUser = [
  {
    user: 'basic',
    hotkeys: { accept_classification: 'q', reject_classification: 'w', toggle_shortcut_help: 'e' },
    workspaceState: {
      selected_batch_id: 'batch-basic',
      defect_filter: 'all',
      sort_mode: 'defect_desc',
      panel_layout: {
        part_list: { is_open: true, width_px: 300, height_px: 410, orientation: 'vertical' },
        inspector: { is_open: true, width_px: 340, height_px: 400, orientation: 'vertical' },
        mpr_controls: { is_open: false, width_px: 330, height_px: 350, orientation: 'horizontal' },
      },
      inspector: {
        shortcut_help_visible: false,
        normalization_triage_field: '',
        image_enabled: true,
        modalities: ['visual'],
        view_name: 'front',
        measurements: [{ id: 'basic-length', label: 'Length', value: '12.6' }],
      },
    },
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
          modalities: ['visual'],
          view_images: { front: 'front-basic.png' },
          volume_shape: { axial: 20, coronal: 18, sagittal: 16 },
          overlay_layers: [{ id: 'voids', label: 'Voids', color: '#f59e0b' }],
          annotations: [
            {
              id: 'seed-annotation-basic',
              defect_class: 'seed-basic',
              modality: 'visual',
              disposition: 'open',
              hidden: false,
              updated_by: 'seed-user@example.com',
              updated_at: '2026-03-28T11:00:00Z',
            },
          ],
        },
      },
    ],
  },
  {
    user: 'intermediate',
    hotkeys: { accept_classification: 's', reject_classification: 'd', toggle_shortcut_help: 'f' },
    workspaceState: {
      selected_batch_id: 'batch-mid-a',
      defect_filter: 'critical_only',
      sort_mode: 'serial_asc',
      selected_part_id: 'part-mid-1',
      mpr: {
        slice_position: { axial: 5, coronal: 4, sagittal: 3 },
        viewport_transform: { zoom: 1.2, panX: 10, panY: -5 },
        contrast_percent: 115,
        active_overlay_ids: ['porosity'],
        cursor_probe: { x: 60, y: 45 },
      },
      panel_layout: {
        part_list: { is_open: true, width_px: 360, height_px: 520, orientation: 'vertical' },
        inspector: { is_open: false, width_px: 410, height_px: 500, orientation: 'horizontal' },
        mpr_controls: { is_open: true, width_px: 390, height_px: 380, orientation: 'horizontal' },
      },
      inspector: {
        shortcut_help_visible: true,
        normalization_triage_field: 'segmentation_runs',
        image_enabled: false,
        modalities: ['infrared'],
        view_name: 'left',
        measurements: [
          { id: 'mid-length', label: 'Crack length', value: 10.2 },
          { id: 'mid-area', label: 'Pore area', value: '1.8' },
        ],
      },
    },
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
          modalities: ['visual', 'infrared'],
          view_images: { left: 'left-mid.png' },
          volume_shape: { axial: 32, coronal: 28, sagittal: 24 },
          overlay_layers: [
            { id: 'segmentation', label: 'Segmentation', color: '#ef4444' },
            { id: 'porosity', label: 'Porosity', color: '#8b5cf6' },
          ],
          segmentation_runs: [
            'legacy-seg-entry',
            {
              run_id: 'seeded-seg-mid',
              axis: 'axial',
              slice_index: 3,
              status: 'completed',
              overlay_id: 'segmentation-axial-3',
            },
          ],
          measurement_runs: [
            {
              run_id: 'seeded-measure-mid',
              status: 'completed',
              units: 'mm',
              values: { crack_length_mm: 10.2, pore_area_mm2: 1.8, edge_offset_mm: 0.41 },
            },
          ],
          annotations: [
            {
              id: 'seed-annotation-mid',
              defect_class: 'seed-mid',
              modality: 'infrared',
              disposition: 'needs_info',
              hidden: false,
              updated_by: 'seed-user@example.com',
              updated_at: '2026-03-28T11:00:00Z',
            },
          ],
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
          volume_shape: { axial: 40, coronal: 36, sagittal: 34 },
        },
      },
    ],
  },
  {
    user: 'advanced',
    hotkeys: { accept_classification: 'z', reject_classification: 'x', toggle_shortcut_help: 'c' },
    workspaceState: {
      selected_batch_id: 'batch-adv-a',
      defect_filter: 'has_defects',
      sort_mode: 'defect_desc',
      selected_part_id: 'part-adv-1',
      mpr: {
        slice_position: { axial: 11, coronal: 8, sagittal: 6 },
        viewport_transform: { zoom: 1.3, panX: 16, panY: -12 },
        contrast_percent: 110,
        active_overlay_ids: ['segmentation', 'porosity'],
        cursor_probe: { x: 55, y: 48 },
      },
      panel_layout: {
        part_list: { is_open: 'yes', width_px: -25, height_px: 9999, orientation: 'diagonal' },
        inspector: { is_open: true, width_px: 260, height_px: 460, orientation: 'vertical' },
        mpr_controls: { is_open: true, width_px: '400', height_px: '420', orientation: 'horizontal' },
      },
      inspector: {
        shortcut_help_visible: 'yes',
        normalization_triage_field: 73,
        image_enabled: 'no',
        modalities: 'not-a-list',
        view_name: 45,
        measurements: [
          { id: 'adv-invalid-empty', label: ' ', value: '4.5' },
          { id: 'adv-invalid-missing', label: 'Depth' },
          'not-a-measurement',
        ],
      },
    },
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
          modalities: ['visual', 'infrared', 'uv'],
          view_images: { front: 'adv-front.png', top: 'adv-top.png' },
          volume_shape: { axial: 128, coronal: 96, sagittal: 80 },
          overlay_layers: [
            { id: 'segmentation', label: 'Segmentation', color: '#ef4444' },
            { id: 'heatmap', label: 'Heatmap', color: '#8b5cf6' },
            { id: 'porosity', label: 'Porosity', color: '#f59e0b' },
          ],
          annotations: [
            {
              id: 'seed-annotation-adv',
              defect_class: 'seed-adv',
              modality: 'uv',
              disposition: 'open',
              hidden: false,
              updated_by: 'seed-user@example.com',
              updated_at: '2026-03-28T11:00:00Z',
            },
          ],
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
          volume_shape: { axial: 256, coronal: 192, sagittal: 144 },
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
          volume_shape: { axial: 300, coronal: 240, sagittal: 180 },
        },
      },
    ],
  },
];

function mockWorkbenchFetch({ user, batches, parts, workspaceState = {}, hotkeys }) {
  let mutableParts = [...parts];
  const savedWorkspaceStates = [];
  const savedConfigurations = [];
  const annotationsByPart = Object.fromEntries(
    mutableParts.map((part) => [part.id, Array.isArray(part.metadata?.annotations) ? [...part.metadata.annotations] : []]),
  );
  let annotationSeq = 0;

  global.fetch = jest.fn((url, options = {}) => {
    if (url.includes('/export-bundle') && !url.includes('/export-bundle-json')) {
      return Promise.resolve({
        ok: true,
        headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/zip' : null) },
        blob: async () => new Blob(['synthetic-bundle']),
      });
    }
    if (url.includes('/export-bundle-json')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          project: { id: 'proj-1', project_type: 'PT1' },
          summary: {
            images: { total: mutableParts.length, total_bytes: mutableParts.length * 2048 },
            annotations: {
              total: Object.values(annotationsByPart).reduce((acc, entries) => acc + entries.length, 0),
            },
            overlays: {
              segmentation_runs: mutableParts.reduce(
                (acc, part) => acc + (Array.isArray(part.metadata?.segmentation_runs) ? part.metadata.segmentation_runs.length : 0),
                0,
              ),
            },
          },
        }),
      });
    }
    if (url.includes('/report-json')) {
      const metadataNormalizationByUser = {
        basic: {},
        intermediate: { segmentation_runs: 1 },
        advanced: { segmentation_runs: 1, measurement_runs: 1, '': 2, 'legacy value[]': 3 },
      };
      return Promise.resolve({
        ok: true,
        json: async () => ({
          project: { id: 'proj-1', project_type: 'PT1' },
          summary: {
            total_images: mutableParts.length,
            total_batches: batches.length,
            total_parts: mutableParts.length,
            reviewed_parts: mutableParts.filter((part) => ['pass', 'reject_pending', 'reject_confirmed'].includes(part.review_state)).length,
            metadata_normalization: {
              dropped_non_object_items: metadataNormalizationByUser[user] || {},
            },
          },
        }),
      });
    }
    if (url.includes('/report-pdf')) {
      return Promise.resolve({
        ok: true,
        headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/pdf' : null) },
        blob: async () => new Blob(['synthetic-pdf']),
      });
    }
    if (url.includes('/ingest') && options.method === 'POST') {
      const payload = JSON.parse(options.body || '{}');
      const partsReceived = Array.isArray(payload.batches)
        ? payload.batches.reduce((acc, batch) => acc + (Array.isArray(batch.parts) ? batch.parts.length : 0), 0)
        : 0;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          project_id: 'proj-1',
          counters: {
            batches_received: Array.isArray(payload.batches) ? payload.batches.length : 0,
            parts_received: partsReceived,
            batches_created: 0,
            parts_created: 0,
            parts_skipped_existing: partsReceived,
            parts_skipped_discrepancy: scenarioNameIncludesAdvanced(payload) ? 1 : 0,
          },
          discrepancies: scenarioNameIncludesAdvanced(payload)
            ? [
              {
                code: 'duplicate_serial_in_payload',
                batch_name: payload.batches?.[0]?.name || 'batch',
                serial_number: payload.batches?.[0]?.parts?.[0]?.serial_number || null,
                message: 'Synthetic duplicate for advanced scenario',
              },
            ]
            : [],
        }),
      });
    }
    if (url.includes('/workspace-state') && (!options.method || options.method === 'GET')) {
      return Promise.resolve({ ok: true, json: async () => ({ state: workspaceState }) });
    }
    if (url.includes('/configuration') && (!options.method || options.method === 'GET')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          config: {
            process_settings: {
              configurable_hotkeys: hotkeys || {
                accept_classification: 'a',
                reject_classification: 'r',
                toggle_shortcut_help: 'h',
              },
            },
          },
        }),
      });
    }
    if (url.includes('/configuration') && options.method === 'PUT') {
      const payload = JSON.parse(options.body || '{}');
      savedConfigurations.push(payload);
      return Promise.resolve({
        ok: true,
        json: async () => ({ config: payload.config || {} }),
      });
    }
    if (url.includes('/workspace-state') && options.method === 'PUT') {
      savedWorkspaceStates.push(JSON.parse(options.body || '{}'));
      return Promise.resolve({ ok: true, json: async () => ({ state: workspaceState }) });
    }
    if (url.includes('/batches')) {
      return Promise.resolve({ ok: true, json: async () => batches });
    }
    if (url.includes('/parts/') && options.method === 'PATCH') {
      if (url.includes('/annotations/')) {
        const segments = url.split('/');
        const partId = segments[segments.length - 3];
        const annotationId = segments[segments.length - 1];
        const payload = JSON.parse(options.body || '{}');
        const updatedItems = (annotationsByPart[partId] || []).map((annotation) =>
          annotation.id === annotationId
            ? {
              ...annotation,
              ...payload,
              updated_at: '2026-03-28T12:30:00Z',
              updated_by: 'qa-reviewer@example.com',
            }
            : annotation,
        );
        annotationsByPart[partId] = updatedItems;
        return Promise.resolve({
          ok: true,
          json: async () => updatedItems.find((annotation) => annotation.id === annotationId),
        });
      }
      const partId = url.split('/').pop();
      const payload = JSON.parse(options.body || '{}');
      mutableParts = mutableParts.map((part) =>
        part.id === partId ? { ...part, review_state: payload.review_state } : part,
      );
      const updated = mutableParts.find((part) => part.id === partId);
      return Promise.resolve({ ok: true, json: async () => updated });
    }
    if (url.includes('/segmentation-runs') && options.method === 'POST') {
      const payload = JSON.parse(options.body || '{}');
      return Promise.resolve({
        ok: true,
        json: async () => ({
          run_id: 'seg-run-1',
          part_id: mutableParts[0]?.id || 'part',
          axis: payload.axis || 'axial',
          slice_index: payload.slice_index || 0,
          status: 'completed',
          overlay_id: `segmentation-${payload.axis || 'axial'}-${payload.slice_index || 0}`,
        }),
      });
    }
    if (url.includes('/measurement-runs') && options.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          run_id: 'measure-run-1',
          part_id: mutableParts[0]?.id || 'part',
          status: 'completed',
          units: 'mm',
          values: {
            crack_length_mm: 12.4,
            pore_area_mm2: 2.1,
            edge_offset_mm: 0.46,
          },
        }),
      });
    }
    if (url.includes('/annotations') && options.method === 'POST') {
      const segments = url.split('/');
      const partId = segments[segments.length - 2];
      annotationSeq += 1;
      const payload = JSON.parse(options.body || '{}');
      const created = {
        id: `annotation-${annotationSeq}`,
        ...payload,
        created_at: '2026-03-28T12:00:00Z',
        created_by: 'qa-reviewer@example.com',
        updated_at: '2026-03-28T12:00:00Z',
        updated_by: 'qa-reviewer@example.com',
      };
      annotationsByPart[partId] = [created, ...(annotationsByPart[partId] || [])];
      return Promise.resolve({ ok: true, json: async () => created });
    }
    if (url.includes('/annotations') && (!options.method || options.method === 'GET')) {
      const segments = url.split('?')[0].split('/');
      const partId = segments[segments.length - 2];
      return Promise.resolve({
        ok: true,
        json: async () => ({ part_id: partId, annotations: annotationsByPart[partId] || [] }),
      });
    }
    if (url.includes('/parts')) {
      return Promise.resolve({ ok: true, json: async () => mutableParts });
    }
    return Promise.resolve({ ok: false, status: 404 });
  });

  return {
    getWorkspaceSaves: () => savedWorkspaceStates,
    getConfigurationSaves: () => savedConfigurations,
  };
}

function scenarioNameIncludesAdvanced(payload) {
  const group = payload?.batches?.[0]?.description || '';
  return /adv/i.test(group);
}


describe('InspectionWorkbenchPanel', () => {
  afterEach(() => {
    delete global.fetch;
  });

  test.each(projectTypes)('supports progressive PT workflows for %s', async (projectType) => {
    for (const scenario of scenarioByUser) {
      const workspaceTracker = mockWorkbenchFetch(scenario);
      const { unmount } = render(<InspectionWorkbenchPanel projectId="proj-1" projectType={projectType} />);

      await waitFor(() => {
        expect(screen.getByText(`Batches: ${scenario.batches.length}`)).toBeInTheDocument();
      });
      fireEvent.click(screen.getByTestId('request-ingest-validation'));
      await waitFor(() => {
        expect(screen.getByTestId('ingest-validation-result')).toHaveTextContent(/Ingest validation complete:/);
      });
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/ingest'),
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      expect(screen.getByText(`Parts: ${scenario.parts.length}`)).toBeInTheDocument();
      expect(screen.getByText(new RegExp(projectType))).toBeInTheDocument();
      expect(screen.getByTestId('inspector-common-controls')).toBeInTheDocument();
      expect(screen.getByTestId('panel-layout-controls')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('part list width'), { target: { value: '9999' } });
      fireEvent.change(screen.getByLabelText('part list height'), { target: { value: '100' } });
      fireEvent.change(screen.getByLabelText('part list orientation'), { target: { value: 'horizontal' } });

      if (scenario.user === 'advanced') {
        expect(screen.getByTestId('manual-measurement-list')).toHaveTextContent('No measurements captured.');
      } else if (scenario.user === 'basic') {
        expect(screen.getByTestId('manual-measurement-list')).toHaveTextContent('Length: 12.6');
      } else {
        expect(screen.getByTestId('manual-measurement-list')).toHaveTextContent('Crack length: 10.2');
      }

      fireEvent.change(screen.getByPlaceholderText('label'), { target: { value: `${scenario.user}-length` } });
      fireEvent.change(screen.getByPlaceholderText('value'), { target: { value: '12.6' } });
      fireEvent.click(screen.getByRole('button', { name: /save measurement/i }));
      expect(screen.getByTestId('manual-measurement-list')).toHaveTextContent(`${scenario.user}-length: 12.6mm`);
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`Delete measurement ${scenario.user}-length`, 'i') }));
      expect(screen.getByTestId('manual-measurement-list')).not.toHaveTextContent(`${scenario.user}-length: 12.6mm`);
      if (scenario.user === 'advanced') {
        expect(screen.getByTestId('manual-measurement-list')).toHaveTextContent('No measurements captured.');
      }
      expect(screen.getByTestId('inspector-viewport-state')).toHaveTextContent(/Zoom 1\.\d{2}x|Zoom 1.00x/);
      const inspectorNav = screen.getByTestId('inspector-nav-controls');
      fireEvent.click(within(inspectorNav).getByRole('button', { name: 'Zoom +' }));
      fireEvent.click(within(inspectorNav).getByRole('button', { name: 'Pan →' }));
      await waitFor(() => {
        expect(screen.getByTestId('inspector-viewport-state')).toHaveTextContent(/Zoom 1\.10x/);
        expect(screen.getByTestId('inspector-viewport-state')).toHaveTextContent(/Pan \(10, 0\)/);
      });

      fireEvent.click(screen.getByTestId('toggle-image-visibility'));
      const initialImageEnabled = typeof scenario.workspaceState?.inspector?.image_enabled === 'boolean'
        ? scenario.workspaceState.inspector.image_enabled
        : true;
      if (projectType === 'PT1') {
        if (initialImageEnabled) {
          expect(screen.getAllByText('Image hidden').length).toBeGreaterThan(0);
        } else {
          expect(screen.getAllByText(/Mapped:|No image mapped/).length).toBeGreaterThan(0);
        }
      }

      // Inspection-status filter
      fireEvent.change(screen.getByLabelText('Inspection status'), { target: { value: 'pass' } });
      const filteredRows = screen.queryAllByTestId('part-review-state');
      if (filteredRows.length > 0) {
        const expectedPassedRows = scenario.parts.filter((part) => (part.review_state || '').toLowerCase() === 'pass');
        expect(filteredRows.length).toBeLessThanOrEqual(expectedPassedRows.length);
      } else {
        expect(screen.getByText('No parts found for the current filters.')).toBeInTheDocument();
      }

      // Reset filter and test batch filter
      fireEvent.change(screen.getByLabelText('Inspection status'), { target: { value: 'all' } });
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

      await waitFor(() => {
        expect(screen.getByTestId('annotation-list')).toHaveTextContent(/@ 2026-03-28/);
      });
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.change(screen.getByLabelText('Edit annotation defect class'), { target: { value: `${scenario.user}-edited-defect` } });
      fireEvent.change(screen.getByLabelText('Edit annotation disposition'), { target: { value: 'accepted' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => {
        expect(screen.getByTestId('annotation-list')).toHaveTextContent(`${scenario.user}-edited-defect •`);
        expect(screen.getByTestId('annotation-list')).toHaveTextContent('• accepted');
      });
      fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
      await waitFor(() => {
        expect(screen.getByTestId('annotation-list')).toHaveTextContent('Hidden');
        expect(screen.getByTestId('annotation-list')).toHaveTextContent('qa-reviewer@example.com @ 2026-03-28 12:30:00');
      });
      fireEvent.change(screen.getByLabelText('Annotation defect type'), { target: { value: 'Other' } });
      fireEvent.change(screen.getByPlaceholderText('annotation modality'), { target: { value: 'visual' } });
      fireEvent.change(screen.getByPlaceholderText('annotation comment'), { target: { value: `${scenario.user}-crack` } });
      fireEvent.click(screen.getByRole('button', { name: /add annotation/i }));
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/annotations'),
          expect.objectContaining({ method: 'POST' }),
        );
      });

      if (projectType === 'PT1') {
        // PT1 keeps the configured external-view board.
        expect(screen.getAllByText(/Image hidden|No image mapped|Mapped:/).length).toBeGreaterThan(0);
        const quickSwitch = screen.getByText('View quick switch').closest('.view-switcher');
        const quickSwitchButtons = within(quickSwitch).getAllByRole('button');
        fireEvent.click(quickSwitchButtons[0]);
      } else {
        // PT2/PT3 render MPR shell with synchronized locator state.
        expect(screen.getByTestId('mpr-shell')).toBeInTheDocument();
        expect(screen.getByText('Axial plane')).toBeInTheDocument();
        expect(screen.getByText('Coronal plane')).toBeInTheDocument();
        expect(screen.getByText('Sagittal plane')).toBeInTheDocument();
        expect(screen.getByLabelText(/Contrast/)).toBeInTheDocument();
        const tooltip = screen.getByTestId('mpr-tooltip-values');
        expect(tooltip).toHaveTextContent(/Cursor/);
        const initialPart = scenario.parts[0];
        const expectedSagittal = scenario.workspaceState?.mpr?.slice_position?.sagittal != null
          ? scenario.workspaceState.mpr.slice_position.sagittal + 1
          : Math.floor((initialPart.metadata.volume_shape.sagittal - 1) / 2) + 1;
        expect(screen.getByTestId('mpr-locator')).toHaveTextContent(new RegExp(`S${expectedSagittal}`));
        expect(screen.getByTestId('mpr-tooltip-values')).toHaveTextContent('Base');
        const firstOverlay = scenario.parts[0].metadata.overlay_layers?.[0]?.label || 'Segmentation';
        const firstOverlayToggle = screen.getByLabelText(firstOverlay);
        fireEvent.click(firstOverlayToggle);
        expect(screen.getByTestId('mpr-tooltip-values')).toHaveTextContent(/No overlays selected|%/);
        if (scenario.parts[0].metadata?.segmentation_runs?.length) {
          expect(screen.getByTestId('segmentation-result')).toHaveTextContent(/Segmentation completed/);
        }
        if (scenario.parts[0].metadata?.measurement_runs?.length) {
          expect(screen.getByTestId('measurement-result')).toHaveTextContent(/Measurements completed/);
        }
        fireEvent.click(screen.getByTestId('run-segmentation'));
        await waitFor(() => {
          expect(screen.getByTestId('segmentation-result')).toHaveTextContent(/Segmentation completed/);
        });
        fireEvent.click(screen.getByTestId('run-measurements'));
        await waitFor(() => {
          expect(screen.getByTestId('measurement-result')).toHaveTextContent(/Measurements completed/);
        });
        const mprNav = screen.getByLabelText('3D orientation pane');
        fireEvent.click(within(mprNav).getByRole('button', { name: 'Zoom +' }));
        fireEvent.click(within(mprNav).getByRole('button', { name: 'Pan →' }));
        await waitFor(() => {
          expect(screen.getAllByText(/Pan \((-?\d+), (-?\d+)\)/).length).toBeGreaterThan(0);
        });

        // Reset batch filter to make all parts visible and validate synchronized part-switch behavior.
        if (screen.queryByTestId('normalization-triage-clear')) {
          fireEvent.click(screen.getByTestId('normalization-triage-clear'));
          await waitFor(() => {
            expect(screen.queryByTestId('normalization-triage-active')).not.toBeInTheDocument();
          });
        }
        fireEvent.change(screen.getByLabelText('Inspection status'), { target: { value: 'all' } });
        fireEvent.change(screen.getByLabelText('Batch'), { target: { value: '' } });
      }
      await waitFor(() => {
        expect(workspaceTracker.getWorkspaceSaves().length).toBeGreaterThan(0);
      });
      const lastWorkspaceSave = workspaceTracker.getWorkspaceSaves().at(-1);
      expect(lastWorkspaceSave?.state?.panel_layout?.part_list).toEqual(
        expect.objectContaining({
          width_px: 1200,
          height_px: 220,
          orientation: 'horizontal',
        }),
      );

      unmount();
    }
  }, 90000);

  test.each(projectTypes)('applies configurable inspector hotkeys for %s', async (projectType) => {
    for (const scenario of scenarioByUser) {
      const workspaceTracker = mockWorkbenchFetch(scenario);
      const { unmount } = render(<InspectionWorkbenchPanel projectId="proj-1" projectType={projectType} />);

      await waitFor(() => {
        expect(screen.getByTestId('inspector-hotkey-hints')).toHaveTextContent(
          new RegExp(`pass \\(${scenario.hotkeys.accept_classification.toUpperCase()}\\)`),
        );
      });

      if (scenario.workspaceState?.inspector?.shortcut_help_visible === true) {
        expect(screen.queryByTestId('shortcut-help-panel')).toBeInTheDocument();
      }

      fireEvent.keyDown(document, { key: scenario.hotkeys.toggle_shortcut_help });
      if (scenario.workspaceState?.inspector?.shortcut_help_visible === true) {
        expect(screen.queryByTestId('shortcut-help-panel')).not.toBeInTheDocument();
      } else {
        expect(screen.getByTestId('shortcut-help-panel')).toHaveTextContent('Shortcut help');
      }

      fireEvent.keyDown(document, { key: scenario.hotkeys.accept_classification });
      await waitFor(() => {
        expect(screen.getByText(/Passed: \d+/)).toBeInTheDocument();
      });

      fireEvent.keyDown(document, { key: scenario.hotkeys.reject_classification });
      await waitFor(() => {
        expect(screen.getByText(/Rejected: \d+/)).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(workspaceTracker.getWorkspaceSaves().length).toBeGreaterThan(0);
      });
      const savedVisibilityStates = workspaceTracker
        .getWorkspaceSaves()
        .map((entry) => entry?.state?.inspector?.shortcut_help_visible);
      expect(savedVisibilityStates.every((value) => typeof value === 'boolean')).toBe(true);
      const savedTriageFields = workspaceTracker
        .getWorkspaceSaves()
        .map((entry) => entry?.state?.inspector?.normalization_triage_field);
      expect(savedTriageFields.every((value) => typeof value === 'string')).toBe(true);
      const savedImageEnabledStates = workspaceTracker
        .getWorkspaceSaves()
        .map((entry) => entry?.state?.inspector?.image_enabled);
      expect(savedImageEnabledStates.every((value) => typeof value === 'boolean')).toBe(true);
      const savedModalities = workspaceTracker
        .getWorkspaceSaves()
        .map((entry) => entry?.state?.inspector?.modalities);
      expect(savedModalities.every((value) => Array.isArray(value))).toBe(true);
      const savedViewNames = workspaceTracker
        .getWorkspaceSaves()
        .map((entry) => entry?.state?.inspector?.view_name);
      expect(savedViewNames.every((value) => typeof value === 'string')).toBe(true);
      unmount();
    }
  });

  test.each(projectTypes)('saves configurable hotkeys for progressive %s workflows', async (projectType) => {
    for (const scenario of scenarioByUser) {
      const workspaceTracker = mockWorkbenchFetch(scenario);
      const { unmount } = render(<InspectionWorkbenchPanel projectId="proj-1" projectType={projectType} />);

      await waitFor(() => {
        expect(screen.getByLabelText('Hotkey pass')).toHaveValue(scenario.hotkeys.accept_classification);
      });

      fireEvent.change(screen.getByLabelText('Hotkey pass'), { target: { value: '1' } });
      fireEvent.change(screen.getByLabelText('Hotkey reject'), { target: { value: '1' } });
      fireEvent.change(screen.getByLabelText('Hotkey help'), { target: { value: '2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save Hotkeys' }));
      await waitFor(() => {
        expect(screen.getByText('Hotkeys must use unique key bindings.')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByLabelText('Hotkey pass'), { target: { value: 'v' } });
      fireEvent.change(screen.getByLabelText('Hotkey reject'), { target: { value: 'b' } });
      fireEvent.change(screen.getByLabelText('Hotkey help'), { target: { value: 'n' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save Hotkeys' }));
      await waitFor(() => {
        expect(screen.getByText('Hotkeys saved for this project.')).toBeInTheDocument();
      });
      await waitFor(() => {
        expect(screen.getByTestId('inspector-hotkey-hints')).toHaveTextContent(/pass \(V\), reject \(B\), shortcuts help \(N\)/);
      });
      const savedConfigPayload = workspaceTracker.getConfigurationSaves().at(-1);
      expect(savedConfigPayload.config.process_settings.configurable_hotkeys).toEqual({
        accept_classification: 'v',
        reject_classification: 'b',
        toggle_shortcut_help: 'n',
      });
      unmount();
    }
  });

});
