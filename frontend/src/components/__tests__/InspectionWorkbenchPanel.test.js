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
          source_images: [
            { filename: 'PT3_GEOMETRIC_DUAL_LABEL_Z000.png', image_id: 'pt3-z-000', metadata: { slice_index: 0 } },
            { filename: 'PT3_GEOMETRIC_DUAL_LABEL_Z016.png', image_id: 'pt3-z-016', metadata: { slice_index: 16 } },
            { filename: 'PT3_GEOMETRIC_DUAL_LABEL_Z032.png', image_id: 'pt3-z-032', metadata: { slice_index: 32 } },
            { filename: 'PT3_GEOMETRIC_DUAL_LABEL_Z048.png', image_id: 'pt3-z-048', metadata: { slice_index: 48 } },
            { filename: 'PT3_GEOMETRIC_DUAL_LABEL_Z063.png', image_id: 'pt3-z-063', metadata: { slice_index: 63 } },
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

const defaultCalibration = { pixels_per_mm: 20, pixels_per_inch: 508, unit: 'mm' };

function mockWorkbenchFetch({ user, batches, parts, workspaceState = {}, hotkeys, metadataDict = { calibration_default: defaultCalibration } }) {
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
    if (url.includes('/metadata-dict') && (!options.method || options.method === 'GET')) {
      return Promise.resolve({ ok: true, json: async () => metadataDict });
    }
    if (url.includes('/metadata') && options.method === 'POST') {
      const payload = JSON.parse(options.body || '{}');
      metadataDict[payload.key] = payload.value;
      return Promise.resolve({ ok: true, json: async () => metadataDict });
    }
    if (url.includes('/images/') && url.includes('/metadata') && options.method === 'PUT') {
      return Promise.resolve({ ok: true, json: async () => ({ metadata: { calibration_override: JSON.parse(options.body || '{}').value } }) });
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
    if (url.includes('/parts/') && url.includes('/annotations/') && options.method === 'DELETE') {
      const segments = url.split('/');
      const partId = segments[segments.length - 3];
      const annotationId = segments[segments.length - 1];
      annotationsByPart[partId] = (annotationsByPart[partId] || []).filter((annotation) => annotation.id !== annotationId);
      return Promise.resolve({ ok: true, status: 204 });
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
    if (url.includes('/analyze/overlays/') && options.method === 'DELETE') {
      const overlayId = decodeURIComponent(url.split('/').pop());
      const updatedPart = {
        ...mutableParts[0],
        metadata: {
          ...mutableParts[0].metadata,
          source_images: mutableParts[0].metadata.source_images.map((record) => (
            record.image_id === overlayId
              ? { ...record, overlay_delete_candidate: true, pending_hard_delete_at: '2026-05-02T12:00:00Z' }
              : record
          )),
          analysis_outputs: (mutableParts[0].metadata.analysis_outputs || []).map((record) => (
            record.image_id === overlayId
              ? { ...record, overlay_delete_candidate: true, pending_hard_delete_at: '2026-05-02T12:00:00Z' }
              : record
          )),
        },
      };
      mutableParts[0] = updatedPart;
      return Promise.resolve({ ok: true, json: async () => updatedPart });
    }
    if (url.includes('/parts')) {
      return Promise.resolve({ ok: true, json: async () => mutableParts });
    }
    if (url.includes('/images?include_deleted=true&limit=5000')) {
      const imageRecords = mutableParts.flatMap((part) => {
        const viewImages = part?.metadata?.view_images || {};
        const viewRecords = Object.entries(viewImages).map(([viewName, imageRef], index) => ({
          id: `${part.id}-image-${index + 1}`,
          filename: imageRef,
          metadata: {
            part_id: part.id,
            serial_number: part.serial_number,
            view_name: viewName,
          },
        }));
        const sourceRecords = Array.isArray(part?.metadata?.source_images)
          ? part.metadata.source_images.map((record, index) => ({
            id: record.image_id || `${part.id}-source-${index + 1}`,
            filename: record.filename,
            metadata: {
              part_id: part.id,
              serial_number: part.serial_number,
              ...record,
            },
          }))
          : [];
        return [...viewRecords, ...sourceRecords];
      });
      return Promise.resolve({ ok: true, json: async () => imageRecords });
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
      expect(screen.queryByTestId('request-ingest-validation')).not.toBeInTheDocument();
      expect(screen.getByText(`Parts: ${scenario.parts.length}`)).toBeInTheDocument();
      if (projectType === 'PT3') {
        expect(screen.getByTestId('mpr-panel')).toBeInTheDocument();
        expect(screen.queryByTestId('selected-image-panel')).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Part Selection' }));
        expect(screen.getByRole('heading', { name: 'Part Selection' })).toBeInTheDocument();
      }
      expect(screen.getByLabelText('Batch')).toBeInTheDocument();
      expect(screen.getByLabelText('Status')).toBeInTheDocument();
      expect(screen.getByLabelText('Filter')).toBeInTheDocument();
      expect(screen.getByLabelText('Sort')).toBeInTheDocument();
      if (projectType !== 'PT3') {
        expect(screen.getByTestId('selected-image-panel')).toBeInTheDocument();
      }

      // Inspection-status filter
      fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'pass' } });
      const filteredRows = screen.queryAllByTestId('part-review-state');
      if (filteredRows.length > 0) {
        const expectedPassedRows = scenario.parts.filter((part) => (part.review_state || '').toLowerCase() === 'pass');
        expect(filteredRows.length).toBeLessThanOrEqual(expectedPassedRows.length);
      } else {
        expect(screen.getByText('No parts found for the current filters.')).toBeInTheDocument();
      }

      // Reset filter and test batch filter
      fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } });
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

      if (projectType === 'PT3') {
        fireEvent.click(screen.getByRole('button', { name: 'Close Part Selection' }));
        fireEvent.click(screen.getByRole('button', { name: 'Annotations' }));
      }
      const seedAnnotationType = scenario.parts[0].metadata.annotations[0].defect_class;
      await waitFor(() => {
        expect(screen.getByTestId('annotation-list')).toHaveTextContent(seedAnnotationType);
        expect(screen.getByTestId('annotation-list')).not.toHaveTextContent('@ 2026-03-28');
      });
      fireEvent.click(screen.getByRole('button', { name: 'Other' }));
      fireEvent.change(screen.getByLabelText('Annotation defect type'), { target: { value: 'Other' } });
      fireEvent.change(screen.getByPlaceholderText('annotation modality'), { target: { value: 'visual' } });
      fireEvent.change(screen.getByPlaceholderText('annotation comment'), { target: { value: `${scenario.user}-crack` } });
      fireEvent.click(screen.getByRole('button', { name: /save annotation/i }));
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          expect.stringContaining('/annotations'),
          expect.objectContaining({ method: 'POST' }),
        );
        expect(screen.getByTestId('annotation-list')).toHaveTextContent('Other');
        expect(screen.getByTestId('annotation-list')).toHaveTextContent(`${scenario.user}-crack`);
      });
      if (projectType === 'PT3') {
        fireEvent.click(screen.getByRole('button', { name: 'Close Annotations' }));
        fireEvent.click(screen.getByRole('button', { name: 'Part Selection' }));
      }
      fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'all' } });
      fireEvent.change(screen.getByLabelText('Batch'), { target: { value: '' } });
      await waitFor(() => {
        expect(workspaceTracker.getWorkspaceSaves().length).toBeGreaterThan(0);
      });
      const lastWorkspaceSave = workspaceTracker.getWorkspaceSaves().at(-1);
      expect(lastWorkspaceSave?.state).toEqual(expect.objectContaining({
        review_filter: expect.any(String),
        part_filter: expect.any(String),
        sort_mode: expect.any(String),
      }));

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
        expect(screen.getByTestId('inspector-hotkey-hints')).toHaveTextContent(
          new RegExp(`pass \\(${scenario.hotkeys.accept_classification.toUpperCase()}\\)`),
        );
      });

      fireEvent.keyDown(document, { key: scenario.hotkeys.accept_classification });
      await waitFor(() => {
        expect(screen.getByText(/Passed: \d+/)).toBeInTheDocument();
      });

      fireEvent.keyDown(document, { key: scenario.hotkeys.reject_classification });
      await waitFor(() => {
        expect(screen.getByText(/Rejected: \d+/)).toBeInTheDocument();
      });
      expect(workspaceTracker.getConfigurationSaves().length).toBe(0);
      unmount();
    }
  });

  test('applies configured inspection layout labels, placement, and dimensions', async () => {
    const scenario = scenarioByUser[0];
    mockWorkbenchFetch(scenario);
    window.innerWidth = 1800;
    window.dispatchEvent(new Event('resize'));
    const hierarchy = {
      leftColumn: 'part_summary',
      centerTabs: ['image_metadata', 'inspector'],
      rightColumn: 'annotations',
      layout: {
        gridTemplateColumns: '300px minmax(620px, 1fr) 380px',
        gapPx: 18,
        minHeightPx: 680,
      },
      regions: {
        part_summary: {
          slot: 'left',
          label: 'Configured Navigator',
          order: 1,
          widthPx: 300,
          minWidthPx: 260,
          maxWidthPx: 360,
          minHeightPx: 500,
        },
        image_metadata: {
          slot: 'center',
          label: 'Configured Metadata',
          tabGroup: 'center',
          order: 1,
          minWidthPx: 540,
        },
        inspector: {
          slot: 'center',
          label: 'Configured Inspector',
          tabGroup: 'center',
          order: 2,
          minWidthPx: 620,
        },
        annotations: {
          slot: 'right',
          label: 'Configured Findings',
          order: 1,
          widthPx: 380,
          minWidthPx: 300,
          maxWidthPx: 460,
        },
      },
    };

    const { unmount } = render(
      <InspectionWorkbenchPanel projectId="proj-1" projectType="PT1" hierarchy={hierarchy} />,
    );

    await waitFor(() => {
      expect(screen.getByText(`Batches: ${scenario.batches.length}`)).toBeInTheDocument();
    });

    const grid = screen.getByTestId('inspection-layout-grid');
    await waitFor(() => {
      expect(grid.style.getPropertyValue('--inspection-grid-template-columns')).toBe('220px minmax(0, 1fr) 220px');
    });
    expect(grid.style.getPropertyValue('--inspection-layout-gap')).toBe('18px');
    expect(grid.style.getPropertyValue('--inspection-layout-min-height')).toBe('680px');

    expect(screen.getByRole('tab', { name: 'Configured Navigator' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Configured Metadata' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Configured Inspector' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Configured Findings' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Configured Inspector' }));
    expect(screen.getAllByText('Configured Inspector').length).toBeGreaterThan(0);

    unmount();
  });

  test('supports drag-resizing side columns and persists widths to project configuration', async () => {
    const scenario = scenarioByUser[0];
    const workspaceTracker = mockWorkbenchFetch(scenario);
    window.innerWidth = 1800;
    window.dispatchEvent(new Event('resize'));

    render(<InspectionWorkbenchPanel projectId="proj-1" projectType="PT1" />);

    await waitFor(() => {
      expect(screen.getByText(`Batches: ${scenario.batches.length}`)).toBeInTheDocument();
    });

    const leftDivider = screen.getByTestId('inspection-divider-left');
    fireEvent.pointerDown(leftDivider, { clientX: 320 });
    fireEvent.pointerMove(window, { clientX: 360 });
    fireEvent.pointerUp(window, { clientX: 360 });

    await waitFor(() => {
      expect(workspaceTracker.getConfigurationSaves().length).toBeGreaterThan(0);
    });
    const latestSave = workspaceTracker.getConfigurationSaves().at(-1);
    expect(latestSave?.config?.inspection_layout?.column_widths).toEqual(expect.objectContaining({
      left_px: expect.any(Number),
      right_px: expect.any(Number),
    }));
  });

  test('renders the configured inspection layout before any parts are loaded', async () => {
    mockWorkbenchFetch({
      user: 'empty',
      batches: [],
      parts: [],
      workspaceState: {},
      hotkeys: { accept_classification: 'a', reject_classification: 'r', toggle_shortcut_help: 'h' },
    });

    const { unmount } = render(<InspectionWorkbenchPanel projectId="proj-empty" projectType="PT1" />);

    await waitFor(() => {
      expect(screen.getByText('Batches: 0')).toBeInTheDocument();
      expect(screen.getByText('Parts: 0')).toBeInTheDocument();
    });

    expect(screen.getByTestId('inspection-empty-state')).toHaveTextContent('No part selected');
    expect(screen.getByTestId('inspection-layout-grid')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Part Summary' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Image Metadata' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Inspection' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Annotations' })).toBeInTheDocument();
    expect(screen.getByTestId('selected-image-panel')).toHaveTextContent(
      'No part selected. Select a part to inspect mapped images.',
    );
    expect(screen.getByTestId('annotation-controls')).toHaveTextContent('For selected part: No part selected');
    expect(screen.getByRole('button', { name: 'Measure on tiles' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Draw box on tiles' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Other' })).toBeDisabled();

    unmount();
  });

  test('switches center pane between inspector images and selected image metadata', async () => {
    mockWorkbenchFetch(scenarioByUser[0]);
    render(<InspectionWorkbenchPanel projectId="proj-1" projectType="PT1" />);

    await waitFor(() => {
      expect(screen.getAllByText('Basic Part').length).toBeGreaterThan(0);
    });

    expect(screen.getByAltText('front view')).toHaveAttribute('src', '/api/images/part-basic-1-image-1/content');
    fireEvent.click(screen.getByRole('tab', { name: 'Image Metadata' }));
    expect(screen.getByRole('tab', { name: 'Image Metadata' })).toHaveAttribute('aria-selected', 'true');

    await waitFor(() => {
      expect(screen.getByTestId('selected-image-metadata-panel')).toHaveTextContent(/Selected image:\s*front-basic\.png/);
    });
    expect(screen.getByTestId('selected-image-metadata-panel')).toHaveTextContent('"view_name": "front"');
  });

  test('deletes annotations from the main annotations list', async () => {
    mockWorkbenchFetch(scenarioByUser[0]);
    render(<InspectionWorkbenchPanel projectId="proj-1" projectType="PT1" />);

    await waitFor(() => expect(screen.getByTestId('annotation-list')).toHaveTextContent('seed-basic'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete annotation seed-basic' }));

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/proj-1/parts/part-basic-1/annotations/seed-annotation-basic',
        { method: 'DELETE' },
      );
      expect(screen.getByTestId('annotation-list')).not.toHaveTextContent('seed-basic');
    });
  });

  test('renders Analyze overlay outputs over their source image in the inspection window', async () => {
    mockWorkbenchFetch({
      user: 'analyze-output',
      batches: [{ id: 'batch-output', name: 'Batch Output' }],
      parts: [
        {
          id: 'part-output-1',
          batch_id: 'batch-output',
          serial_number: 'SN-OUTPUT-1',
          display_name: 'Analyze Output Part',
          review_state: 'in_review',
          metadata: {
            source_images: [
              { filename: 'source.png', image_id: 'source-image-1', side: 'front', modality: 'visual', overlay: false },
              {
                filename: 'source_analyze_overlay.png',
                image_id: 'overlay-image-1',
                label: 'Segmentation Overlay :: Watershed From Seeds',
                side: 'front',
                modality: 'analyze-overlay',
                overlay: true,
                analysis_output: true,
                overlay_base_image_id: 'source-image-1',
                overlay_base_filename: 'source.png',
              },
            ],
            analysis_outputs: [
              {
                filename: 'source_analyze_overlay.png',
                image_id: 'overlay-image-1',
                label: 'Segmentation Overlay :: Watershed From Seeds',
                overlay_base_image_id: 'source-image-1',
              },
            ],
          },
        },
      ],
      workspaceState: {},
      hotkeys: { accept_classification: 'a', reject_classification: 'r', toggle_shortcut_help: 'h' },
    });

    render(<InspectionWorkbenchPanel projectId="proj-1" projectType="PT1" />);

    await waitFor(() => expect(screen.getAllByText('Analyze Output Part').length).toBeGreaterThan(0));
    const composite = screen.getByTestId('inspection-overlay-composite');
    expect(screen.getByText('Watershed From Seeds :: Segmentation Overlay')).toBeInTheDocument();
    expect(within(composite).getByAltText('front source')).toHaveAttribute('src', '/api/images/source-image-1/content');
    expect(within(composite).getByAltText('front overlay')).toHaveAttribute('src', '/api/images/overlay-image-1/content');
    fireEvent.click(composite);
    expect(screen.getByAltText('Watershed From Seeds :: Segmentation Overlay fullscreen')).toBeInTheDocument();
    expect(screen.getByAltText('Watershed From Seeds :: Segmentation Overlay source fullscreen')).toHaveAttribute('src', '/api/images/source-image-1/content');
    fireEvent.click(screen.getByLabelText('Close fullscreen image'));

    fireEvent.click(screen.getByRole('button', { name: 'Delete overlay Watershed From Seeds :: Segmentation Overlay' }));
    await waitFor(() => {
      expect(screen.queryByText('Watershed From Seeds :: Segmentation Overlay')).not.toBeInTheDocument();
    });
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/proj-1/analyze/overlays/overlay-image-1', { method: 'DELETE' });
  });

  test('shows measurement instructions and persists geometry calibration payload when creating a line', async () => {
    mockWorkbenchFetch(scenarioByUser[0]);
    render(<InspectionWorkbenchPanel projectId="proj-1" projectType="PT1" />);
    await waitFor(() => expect(screen.getByAltText('front view')).toBeInTheDocument());
    fireEvent.click(screen.getByAltText('front view'));
    fireEvent.click(screen.getByRole('button', { name: 'Measure' }));
    expect(screen.getByText(/Click to set first point, click again to set second point/i)).toBeInTheDocument();

    const fullscreenImage = screen.getByAltText(/fullscreen$/i);
    Object.defineProperty(fullscreenImage, 'naturalWidth', { configurable: true, value: 1000 });
    Object.defineProperty(fullscreenImage, 'naturalHeight', { configurable: true, value: 500 });
	    fullscreenImage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500 });
	    fireEvent.click(fullscreenImage, { clientX: 100, clientY: 100 });
	    fireEvent.mouseMove(fullscreenImage, { clientX: 200, clientY: 100 });
	    await waitFor(() => expect(screen.getByLabelText('fullscreen measurement overlay')).toHaveTextContent('5.00 mm'));
	    fireEvent.click(fullscreenImage, { clientX: 300, clientY: 200 });

    await waitFor(() => {
      const postCall = global.fetch.mock.calls.find((call) => call[0].includes('/annotations') && call[1]?.method === 'POST');
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body.image_id).toBe('part-basic-1-image-1');
      expect(body.geometry.line).toEqual(expect.objectContaining({ imageWidth: 1000, imageHeight: 500 }));
      expect(body.measurements.length_px).toBeDefined();
      expect(body.measurements.length_mm).toBeCloseTo(11.18, 2);
    });
    await waitFor(() => expect(screen.getByLabelText('fullscreen measurement overlay')).toHaveTextContent('11.18 mm'));
  });

  test('draws measurement lines and bounding boxes directly on image tiles', async () => {
    mockWorkbenchFetch(scenarioByUser[0]);
    render(<InspectionWorkbenchPanel projectId="proj-1" projectType="PT1" />);
    await waitFor(() => expect(screen.getByAltText('front view')).toBeInTheDocument());

    const tileImage = screen.getByAltText('front view');
    Object.defineProperty(tileImage, 'naturalWidth', { configurable: true, value: 400 });
    Object.defineProperty(tileImage, 'naturalHeight', { configurable: true, value: 200 });
    tileImage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 });

	    fireEvent.click(screen.getByRole('button', { name: 'Measure on tiles' }));
	    fireEvent.click(tileImage, { clientX: 40, clientY: 20 });
	    fireEvent.mouseMove(tileImage, { clientX: 100, clientY: 60 });
	    await waitFor(() => expect(screen.getByLabelText('tile measurement overlay')).toHaveTextContent('3.61 mm'));
	    fireEvent.click(tileImage, { clientX: 140, clientY: 70 });

    await waitFor(() => {
      const postCall = global.fetch.mock.calls.find((call) => {
        if (!call[0].includes('/annotations') || call[1]?.method !== 'POST') return false;
        const body = JSON.parse(call[1].body);
        return body.geometry?.line;
      });
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body.image_id).toBe('part-basic-1-image-1');
      expect(body.geometry.line).toEqual(expect.objectContaining({
        x1: 40,
        y1: 20,
        x2: 140,
        y2: 70,
        imageWidth: 400,
        imageHeight: 200,
      }));
    });
	    await waitFor(() => expect(screen.getByLabelText('tile measurement overlay')).toHaveTextContent('5.59 mm'));
	    expect(screen.getByRole('button', { name: 'Measure on tiles' })).not.toHaveClass('active');

	    fireEvent.click(screen.getByRole('button', { name: 'Draw box on tiles' }));
	    fireEvent.mouseDown(tileImage, { clientX: 50, clientY: 30, button: 0 });
	    fireEvent.mouseMove(tileImage, { clientX: 170, clientY: 90 });
	    await waitFor(() => expect(screen.getByLabelText('tile measurement overlay')).toHaveTextContent('Width 6.00 mm'));
	    fireEvent.mouseUp(tileImage, { clientX: 210, clientY: 130, button: 0 });

	    await waitFor(() => {
      const postCall = global.fetch.mock.calls.find((call) => {
        if (!call[0].includes('/annotations') || call[1]?.method !== 'POST') return false;
        const body = JSON.parse(call[1].body);
        return body.geometry?.box;
      });
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body.image_id).toBe('part-basic-1-image-1');
      expect(body.bbox).toEqual(expect.objectContaining({ x: 50, y: 30, width: 160, height: 100 }));
      expect(body.measurements).toEqual(expect.objectContaining({
        width_px: 160,
        height_px: 100,
        width_mm: 8,
        height_mm: 5,
      }));
	    });
	    await waitFor(() => expect(screen.getByLabelText('tile measurement overlay')).toHaveTextContent('Width 8.00 mm'));
	    expect(screen.getByLabelText('tile measurement overlay')).toHaveTextContent('Height 5.00 mm');
	    expect(screen.getByRole('button', { name: 'Draw box on tiles' })).not.toHaveClass('active');
	  });

  test('anchors source tile annotations to the rendered image bounds', async () => {
    mockWorkbenchFetch(scenarioByUser[0]);
    render(<InspectionWorkbenchPanel projectId="proj-1" projectType="PT1" />);
    await waitFor(() => expect(screen.getByAltText('front view')).toBeInTheDocument());

    const tileImage = screen.getByAltText('front view');
    const tileSurface = tileImage.closest('.inspection-image-annotation-surface');
    expect(tileSurface).toBeInTheDocument();
    expect(tileSurface).toContainElement(screen.getByLabelText('tile measurement overlay'));
    Object.defineProperty(tileImage, 'naturalWidth', { configurable: true, value: 400 });
    Object.defineProperty(tileImage, 'naturalHeight', { configurable: true, value: 200 });
    tileImage.getBoundingClientRect = () => ({ left: 50, top: 25, width: 400, height: 200, right: 450, bottom: 225 });
    tileSurface.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 300, right: 500, bottom: 300 });

    fireEvent.click(screen.getByRole('button', { name: 'Measure on tiles' }));
    fireEvent.click(tileSurface, { clientX: 90, clientY: 45 });
    fireEvent.click(tileSurface, { clientX: 190, clientY: 95 });

    await waitFor(() => {
      const postCall = global.fetch.mock.calls.find((call) => {
        if (!call[0].includes('/annotations') || call[1]?.method !== 'POST') return false;
        const body = JSON.parse(call[1].body);
        return body.geometry?.line;
      });
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body.geometry.line).toEqual(expect.objectContaining({
        x1: 40,
        y1: 20,
        x2: 140,
        y2: 70,
        imageWidth: 400,
        imageHeight: 200,
      }));
    });
  });

  test('asks for calibration before allowing fullscreen measurement when calibration is missing', async () => {
    mockWorkbenchFetch({ ...scenarioByUser[0], metadataDict: {} });
    render(<InspectionWorkbenchPanel projectId="proj-1" projectType="PT1" />);
    await waitFor(() => expect(screen.getByAltText('front view')).toBeInTheDocument());
    fireEvent.click(screen.getByAltText('front view'));
    fireEvent.click(screen.getByRole('button', { name: 'Measure' }));

    expect(screen.getByRole('dialog', { name: 'Measurement calibration required' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set Calibration' })).toBeInTheDocument();
    expect(screen.queryByText(/Click to set first point/i)).not.toBeInTheDocument();

    const fullscreenImage = screen.getByAltText(/fullscreen$/i);
    Object.defineProperty(fullscreenImage, 'naturalWidth', { configurable: true, value: 1000 });
    Object.defineProperty(fullscreenImage, 'naturalHeight', { configurable: true, value: 500 });
    fullscreenImage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500 });
    fireEvent.click(fullscreenImage, { clientX: 100, clientY: 100 });
    expect(global.fetch.mock.calls.some((call) => call[0].includes('/annotations') && call[1]?.method === 'POST')).toBe(false);
  });

  test('renders measurement line and length text in both tile and fullscreen overlays', async () => {
    mockWorkbenchFetch({
      ...scenarioByUser[0],
      parts: [{
        ...scenarioByUser[0].parts[0],
        metadata: {
          ...scenarioByUser[0].parts[0].metadata,
          annotations: [{
            id: 'measurement-a',
            image_id: 'part-basic-1-image-1',
            geometry: { line: { x1: 100, y1: 80, x2: 280, y2: 160, imageWidth: 400, imageHeight: 200 } },
            measurements: { length_mm: 4.2 },
          }],
        },
      }],
    });
    render(<InspectionWorkbenchPanel projectId="proj-1" projectType="PT1" />);
    await waitFor(() => expect(screen.getByLabelText('tile measurement overlay')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByText('Loading annotations…')).not.toBeInTheDocument());
    expect(screen.getAllByText('4.20 mm').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByAltText('front view'));
    await waitFor(() => expect(screen.getAllByText('4.20 mm').length).toBeGreaterThan(1));
    expect(screen.getByTestId('fullscreen-annotation-list')).toHaveTextContent('4.20 mm');
  });

  test('draws and labels bounding boxes in the fullscreen view', async () => {
    mockWorkbenchFetch(scenarioByUser[0]);
    render(<InspectionWorkbenchPanel projectId="proj-1" projectType="PT1" />);
	    await waitFor(() => expect(screen.getByAltText('front view')).toBeInTheDocument());
	    fireEvent.click(screen.getByAltText('front view'));
	    fireEvent.click(screen.getByRole('button', { name: 'Draw box' }));
	    expect(screen.getByText(/Press and drag to draw a bounding box/i)).toBeInTheDocument();

	    const fullscreenImage = screen.getByAltText(/fullscreen$/i);
	    Object.defineProperty(fullscreenImage, 'naturalWidth', { configurable: true, value: 500 });
	    Object.defineProperty(fullscreenImage, 'naturalHeight', { configurable: true, value: 250 });
	    fullscreenImage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 250, right: 500, bottom: 250 });
	    fireEvent.mouseDown(fullscreenImage, { clientX: 80, clientY: 40, button: 0 });
	    fireEvent.mouseMove(fullscreenImage, { clientX: 180, clientY: 100 });
	    await waitFor(() => expect(screen.getByLabelText('fullscreen measurement overlay')).toHaveTextContent('Width 5.00 mm'));
	    fireEvent.mouseUp(fullscreenImage, { clientX: 230, clientY: 120, button: 0 });

    await waitFor(() => {
      const postCall = global.fetch.mock.calls.find((call) => {
        if (!call[0].includes('/annotations') || call[1]?.method !== 'POST') return false;
        const body = JSON.parse(call[1].body);
        return body.geometry?.box;
      });
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body.image_id).toBe('part-basic-1-image-1');
      expect(body.bbox).toEqual(expect.objectContaining({ x: 80, y: 40, width: 150, height: 80 }));
    });
	    await waitFor(() => expect(screen.getByLabelText('fullscreen measurement overlay')).toHaveTextContent('Width 7.50 mm'));
	    expect(screen.getByLabelText('fullscreen measurement overlay')).toHaveTextContent('Height 4.00 mm');
	    expect(screen.getByTestId('fullscreen-annotation-list')).toHaveTextContent('Width 7.50 mm');
	    expect(screen.getByRole('button', { name: 'Draw box' })).not.toHaveClass('active');

    const topLeftCorner = await screen.findByLabelText('Reposition topLeft corner for Drawn bounding box');
    fireEvent.click(topLeftCorner, { clientX: 80, clientY: 40 });
    expect(screen.getByTestId('fullscreen-measurement-zoom-lens')).toBeInTheDocument();
    fireEvent.click(fullscreenImage, { clientX: 100, clientY: 60 });

    await waitFor(() => {
      const patchCall = global.fetch.mock.calls.find((call) => {
        if (!call[0].includes('/annotations/annotation-1') || call[1]?.method !== 'PATCH') return false;
        const body = JSON.parse(call[1].body);
        return body.geometry?.box;
      });
      expect(patchCall).toBeDefined();
      const body = JSON.parse(patchCall[1].body);
      expect(body.bbox).toEqual(expect.objectContaining({ x: 90, y: 50, width: 140, height: 70 }));
      expect(body.measurements).toEqual(expect.objectContaining({ width_mm: 7, height_mm: 3.5 }));
    });
	  });

  test('shares source-image annotations across Analyze overlays and saves overlay measurements to the source image', async () => {
    mockWorkbenchFetch({
      user: 'overlay-measurements',
      batches: [{ id: 'batch-overlay', name: 'Batch Overlay' }],
      parts: [{
        id: 'part-overlay-1',
        batch_id: 'batch-overlay',
        serial_number: 'SN-OVERLAY-1',
        display_name: 'Overlay Part',
        review_state: 'in_review',
        metadata: {
          source_images: [
            { filename: 'source.png', image_id: 'source-image-1', side: 'front', modality: 'visual', overlay: false },
            {
              filename: 'source_overlay.png',
              image_id: 'overlay-image-1',
              label: 'Segmentation Overlay',
              side: 'front',
              modality: 'analyze-overlay',
              overlay: true,
              analysis_output: true,
              overlay_base_image_id: 'source-image-1',
              overlay_base_filename: 'source.png',
            },
          ],
          analysis_outputs: [],
          annotations: [{
            id: 'source-measurement-a',
            image_id: 'source-image-1',
            comment: 'Shared source length',
            geometry: { line: { x1: 40, y1: 40, x2: 140, y2: 40, imageWidth: 200, imageHeight: 100 } },
            measurements: { length_mm: 5 },
            metadata: { measurement_color: '#10b981' },
          }],
        },
      }],
      workspaceState: {},
      hotkeys: { accept_classification: 'a', reject_classification: 'r', toggle_shortcut_help: 'h' },
    });
    render(<InspectionWorkbenchPanel projectId="proj-1" projectType="PT1" />);
    await waitFor(() => expect(screen.getAllByText('5.00 mm').length).toBeGreaterThan(1));

    fireEvent.click(screen.getByTestId('inspection-overlay-composite'));
    await waitFor(() => expect(screen.getByTestId('fullscreen-annotation-list')).toHaveTextContent('Shared source length'));
    expect(screen.getByAltText('Segmentation Overlay source fullscreen')).toHaveAttribute('src', '/api/images/source-image-1/content');
    expect(screen.getByAltText('Segmentation Overlay fullscreen')).toHaveAttribute('src', '/api/images/overlay-image-1/content');
    fireEvent.click(screen.getByRole('button', { name: 'Measure' }));

    const fullscreenImage = screen.getByAltText('Segmentation Overlay fullscreen');
    Object.defineProperty(fullscreenImage, 'naturalWidth', { configurable: true, value: 200 });
    Object.defineProperty(fullscreenImage, 'naturalHeight', { configurable: true, value: 100 });
    fullscreenImage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 });
    fireEvent.click(fullscreenImage, { clientX: 20, clientY: 20 });
    fireEvent.click(fullscreenImage, { clientX: 80, clientY: 40 });

    await waitFor(() => {
      const postCall = global.fetch.mock.calls.find((call) => call[0].includes('/annotations') && call[1]?.method === 'POST');
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body.image_id).toBe('source-image-1');
    });
  });

  test('highlights, repositions, and deletes fullscreen measurement endpoints', async () => {
    mockWorkbenchFetch({
      ...scenarioByUser[0],
      parts: [{
        ...scenarioByUser[0].parts[0],
        metadata: {
          ...scenarioByUser[0].parts[0].metadata,
          annotations: [{
            id: 'measurement-endpoint-a',
            image_id: 'part-basic-1-image-1',
            comment: 'Endpoint check',
            geometry: { line: { x1: 100, y1: 80, x2: 280, y2: 160, imageWidth: 400, imageHeight: 200 } },
            measurements: { length_mm: 4.2, length_px: 196.98 },
            metadata: { measurement_color: '#3b82f6' },
          }],
        },
      }],
    });
    render(<InspectionWorkbenchPanel projectId="proj-1" projectType="PT1" />);
    await waitFor(() => expect(screen.getByAltText('front view')).toBeInTheDocument());
    fireEvent.click(screen.getByAltText('front view'));

    const fullscreenImage = screen.getByAltText(/fullscreen$/i);
    Object.defineProperty(fullscreenImage, 'naturalWidth', { configurable: true, value: 400 });
    Object.defineProperty(fullscreenImage, 'naturalHeight', { configurable: true, value: 200 });
    fullscreenImage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 });

    fireEvent.mouseMove(fullscreenImage, { clientX: 282, clientY: 160 });
    const endpointDot = await screen.findByLabelText('Reposition end endpoint for Endpoint check');
    expect(screen.getByLabelText('Reposition start endpoint for Endpoint check')).toBeInTheDocument();
    fireEvent.click(endpointDot, { clientX: 282, clientY: 160 });
    expect(screen.getByTestId('fullscreen-measurement-zoom-lens')).toBeInTheDocument();
    fireEvent.wheel(fullscreenImage, { deltaY: -80, clientX: 282, clientY: 160 });
    expect(screen.getByTestId('fullscreen-measurement-zoom-lens').style.backgroundSize).toBe('4400px 2200px');
    fireEvent.click(endpointDot, { clientX: 280, clientY: 160 });

    await waitFor(() => {
      const patchCall = global.fetch.mock.calls.find((call) => call[0].includes('/annotations/measurement-endpoint-a') && call[1]?.method === 'PATCH');
      expect(patchCall).toBeDefined();
      const body = JSON.parse(patchCall[1].body);
      expect(body.geometry.line).toEqual(expect.objectContaining({ x2: 280, y2: 160 }));
      expect(body.measurements.length_px).toBeCloseTo(196.98, 2);
    });

    fireEvent.mouseMove(fullscreenImage, { clientX: 100, clientY: 80 });
    const startDot = await screen.findByLabelText('Reposition start endpoint for Endpoint check');
    fireEvent.click(startDot, { clientX: 100, clientY: 80 });
    fireEvent.click(fullscreenImage, { clientX: 120, clientY: 90 });
    await waitFor(() => {
      const patchCalls = global.fetch.mock.calls.filter((call) => call[0].includes('/annotations/measurement-endpoint-a') && call[1]?.method === 'PATCH');
      expect(patchCalls.length).toBeGreaterThan(1);
      const body = JSON.parse(patchCalls.at(-1)[1].body);
      expect(body.geometry.line).toEqual(expect.objectContaining({ x1: 110, y1: 85 }));
    });
    await waitFor(() => expect(screen.queryByTestId('fullscreen-measurement-zoom-lens')).not.toBeInTheDocument());

	    fireEvent.wheel(fullscreenImage, { deltaY: -80, clientX: 200, clientY: 100 });
	    const zoomLayer = document.querySelector('.inspection-fullscreen-image-zoom-layer');
	    expect(zoomLayer.style.transform).toBe('translate(0px, 0px) scale(1.15)');
	    expect(zoomLayer.style.transformOrigin).toBe('50% 50%');

	    fireEvent.mouseDown(fullscreenImage, { clientX: 200, clientY: 100, button: 0 });
	    fireEvent.mouseMove(fullscreenImage, { clientX: 240, clientY: 130 });
	    fireEvent.mouseUp(fullscreenImage, { clientX: 240, clientY: 130, button: 0 });
	    expect(zoomLayer.style.transform).toBe('translate(40px, 30px) scale(1.15)');

	    fireEvent.click(screen.getByRole('button', { name: 'Delete Endpoint check' }));
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/proj-1/parts/part-basic-1/annotations/measurement-endpoint-a',
        { method: 'DELETE' },
      );
      expect(screen.getByTestId('fullscreen-annotation-list')).not.toHaveTextContent('Endpoint check');
    });
  });

  test('does not duplicate original front and back images from source_images when view_images exists', async () => {
    mockWorkbenchFetch({
      user: 'dedupe-originals',
      batches: [{ id: 'batch-dedupe', name: 'Batch Dedupe' }],
      parts: [
        {
          id: 'part-dedupe-1',
          batch_id: 'batch-dedupe',
          serial_number: 'SN-DEDUPE-1',
          display_name: 'Dedupe Part',
          review_state: 'in_review',
          metadata: {
            configured_views: ['front', 'back'],
            view_images: { front: 'front.png', back: 'back.png' },
            source_images: [
              { filename: 'front.png', image_id: 'front-image-1', side: 'front', modality: 'visual', overlay: false },
              { filename: 'back.png', image_id: 'back-image-1', side: 'back', modality: 'visual', overlay: false },
            ],
          },
        },
      ],
      workspaceState: {},
      hotkeys: { accept_classification: 'a', reject_classification: 'r', toggle_shortcut_help: 'h' },
    });

    render(<InspectionWorkbenchPanel projectId="proj-1" projectType="PT1" />);

    await waitFor(() => expect(screen.getAllByText('Dedupe Part').length).toBeGreaterThan(0));
    expect(screen.getAllByAltText('front view')).toHaveLength(1);
    expect(screen.getAllByAltText('back view')).toHaveLength(1);
    expect(screen.queryByText('IMAGE 1')).not.toBeInTheDocument();
    expect(screen.queryByText('IMAGE 2')).not.toBeInTheDocument();
  });

  test('defaults PT3 to focused four-quadrant MPR with modal access and wheel controls', async () => {
    mockWorkbenchFetch(scenarioByUser[2]);
    render(<InspectionWorkbenchPanel projectId="proj-1" projectType="PT3" />);

    await waitFor(() => {
      expect(screen.getByTestId('mpr-panel')).toBeInTheDocument();
    });

    expect(screen.queryByRole('tab', { name: 'MPR' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('inspection-layout-grid')).not.toBeInTheDocument();
    expect(screen.getByTestId('mpr-panel')).toHaveTextContent('XY');
    expect(screen.getByTestId('mpr-panel')).toHaveTextContent('XZ');
    expect(screen.getByTestId('mpr-panel')).toHaveTextContent('YZ');
    expect(screen.getByTestId('mpr-pane-3d')).toHaveTextContent('3D');
    expect(screen.getByLabelText('3D view')).toHaveValue('orientation');
    expect(screen.queryByAltText(/Volume reconstruction slice/)).not.toBeInTheDocument();
    expect(screen.queryByText(/axial/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/coronal/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sagittal/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('3D view'), { target: { value: 'stack' } });
    expect(screen.getAllByAltText(/Volume reconstruction slice/).length).toBeGreaterThan(0);
    expect(screen.getAllByAltText(/Volume reconstruction slice/)[0]).toHaveAttribute('draggable', 'false');

    const coronalPreview = screen.getByTestId('mpr-preview-coronal');
    const initialCoronalCrosshairY = coronalPreview.style.getPropertyValue('--crosshair-y');
    expect(coronalPreview.style.getPropertyValue('--crosshair-h-color')).toBe('#3b82f6');
    expect(coronalPreview.style.getPropertyValue('--crosshair-v-color')).toBe('#10b981');
    fireEvent.wheel(screen.getByTestId('mpr-pane-axial'), { deltaY: 80 });
    expect(coronalPreview.style.getPropertyValue('--crosshair-y')).not.toBe(initialCoronalCrosshairY);

    const axialPreview = screen.getByTestId('mpr-preview-axial');
    const sagittalPreview = screen.getByTestId('mpr-preview-sagittal');
    const initialAxialCrosshairY = axialPreview.style.getPropertyValue('--crosshair-y');
    const initialSagittalCrosshairX = sagittalPreview.style.getPropertyValue('--crosshair-x');
    fireEvent.click(screen.getByLabelText('Mirror', { selector: '#mpr-mirror-coronal' }));
    expect(axialPreview.style.getPropertyValue('--projection-scale-y')).toBe('-1');
    expect(axialPreview.style.getPropertyValue('--crosshair-y')).not.toBe(initialAxialCrosshairY);
    expect(sagittalPreview.style.getPropertyValue('--projection-scale-x')).toBe('-1');
    expect(sagittalPreview.style.getPropertyValue('--crosshair-x')).not.toBe(initialSagittalCrosshairX);
    expect(coronalPreview.style.getPropertyValue('--projection-scale-x')).toBe('1');
    expect(coronalPreview.style.getPropertyValue('--projection-scale-y')).toBe('1');

    expect(screen.getByTestId('mpr-pane-coronal')).toHaveTextContent('Y 8 / 95');
    fireEvent.wheel(screen.getByTestId('mpr-pane-coronal'), { deltaY: 80 });
    expect(screen.getByTestId('mpr-pane-coronal')).toHaveTextContent('Y 9 / 95');

    expect(screen.getByTestId('mpr-pane-3d')).toHaveTextContent('Zoom 1.30x');
    fireEvent.wheel(screen.getByTestId('mpr-pane-3d'), { deltaY: -80 });
    expect(screen.getByTestId('mpr-pane-3d')).toHaveTextContent('Zoom 1.42x');

    fireEvent.click(screen.getByRole('button', { name: 'Part Selection' }));
    expect(screen.getByRole('heading', { name: 'Part Selection' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close Part Selection' })).toBeInTheDocument();
  });

  test('renders a fast visual shell fallback for PT3 parts without volume metadata', async () => {
    mockWorkbenchFetch(scenarioByUser[0]);
    render(<InspectionWorkbenchPanel projectId="proj-1" projectType="PT3" />);

    await waitFor(() => {
      expect(screen.getByTestId('mpr-panel')).toBeInTheDocument();
    });

    expect(screen.queryByAltText(/Volume reconstruction slice/)).not.toBeInTheDocument();
    expect(screen.getAllByAltText(/fallback projection from front view/i).length).toBeGreaterThan(0);
    expect(screen.queryByAltText(/Fallback visual hull shell front view/i)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('3D view'), { target: { value: 'shell' } });
    expect(screen.getByAltText(/Fallback visual hull shell front view/i)).toBeInTheDocument();
    expect(screen.queryByText('No stack')).not.toBeInTheDocument();
  });

});
