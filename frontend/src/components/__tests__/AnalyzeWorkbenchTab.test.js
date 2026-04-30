import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import AnalyzeWorkbenchTab from '../AnalyzeWorkbenchTab';

const toolboxPayload = {
  name: 'test_toolbox',
  version: '0.1.0',
  contract_version: 'vista-analyze.v1',
  methods: [
    {
      id: 'source.project_part_images',
      name: 'Project Part Image Source',
      category: 'Input',
      description: 'Source',
      input_types: ['any'],
      output_types: ['image'],
      parameters: [{ name: 'example_image_id', label: 'Choose Example', type: 'string', default: '' }],
    },
    {
      id: 'output.versioned_image_artifact',
      name: 'Versioned Image Output',
      category: 'Output',
      description: 'Output',
      input_types: ['image', 'mask', 'labels', 'detections', 'measurements', 'metadata'],
      output_types: ['metadata'],
      parameters: [
        {
          name: 'mode',
          label: 'Output Mode',
          type: 'select',
          default: 'versioned_image',
          options: ['versioned_image', 'overlay_metadata', 'measurements_table', 'review_only'],
        },
        {
          name: 'version_strategy',
          label: 'Version Strategy',
          type: 'select',
          default: 'append_vn',
          options: ['append_vn', 'metadata_only'],
        },
        { name: 'preserve_original', label: 'Preserve Original', type: 'boolean', default: true },
        { name: 'overlay_metadata', label: 'Write Overlay Metadata', type: 'boolean', default: true },
        { name: 'measurement_table', label: 'Write Measurements Table', type: 'boolean', default: true },
      ],
    },
    {
      id: 'preprocess.window_level_normalization',
      name: 'Window / Level Normalization',
      category: 'Preprocessing',
      description: 'Normalize',
      input_types: ['image'],
      output_types: ['image'],
      parameters: [
        { name: 'window', label: 'Window', type: 'float', default: 400 },
        { name: 'level', label: 'Level', type: 'float', default: 40 },
        { name: 'clip', label: 'Clip Outliers', type: 'boolean', default: true },
      ],
    },
    {
      id: 'segmentation.watershed_seeds',
      name: 'Watershed From Seeds',
      category: 'Segmentation',
      description: 'Segment',
      input_types: ['image', 'mask'],
      output_types: ['labels'],
      parameters: [{ name: 'seed_spacing_px', label: 'Seed Spacing (px)', type: 'integer', default: 18 }],
    },
    {
      id: 'ml.yolov8.detect',
      name: 'YOLOv8 Object Detection',
      category: 'Machine Learning',
      description: 'Detect',
      input_types: ['image'],
      output_types: ['detections'],
      parameters: [{ name: 'model', label: 'Model', type: 'string', default: 'yolov8n.pt', required: true }],
    },
  ],
};

const inputPayload = {
  project_id: 'proj-1',
  source: {
    id: 'all-loaded-part-images',
    label: 'All images from loaded parts',
    kind: 'project_parts',
    project_id: 'proj-1',
    image_count: 2,
    part_count: 1,
  },
  parts: [{ part_id: 'part-1', serial_number: 'SN-1', display_name: 'Part 1', image_count: 2 }],
  images: [
    { image_id: 'img-1', filename: 'slice-001.png', part_id: 'part-1', part_serial_number: 'SN-1', slice_index: 1 },
    { image_id: 'img-2', filename: 'slice-002.png', part_id: 'part-1', part_serial_number: 'SN-1', slice_index: 2 },
  ],
};

function mockFetch() {
  global.fetch = jest.fn((url, options = {}) => {
    if (url === '/api/analyze/toolbox') {
      return Promise.resolve({ ok: true, json: async () => toolboxPayload });
    }
    if (url === '/api/projects/proj-1/analyze/input-source') {
      return Promise.resolve({ ok: true, json: async () => inputPayload });
    }
    if (url === '/api/projects/proj-1/analyze/workflows/execute' && options.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          run_id: 'run-1',
          workflow_name: 'Part image analysis workflow',
          status: 'simulated',
          execution_mode: 'simulation',
          image_count: 2,
          node_results: [{ node_id: 'input-source', method_id: 'source.project_part_images', status: 'completed' }],
          warnings: [],
        }),
      });
    }
    if (url === '/api/projects/proj-1/analyze/workflows/validate' && options.method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          run_id: 'run-1',
          workflow_name: 'Part image analysis workflow',
          status: 'validated',
          image_count: 2,
          node_results: [],
          warnings: [],
        }),
      });
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ detail: 'not found' }) });
  });
}

describe('AnalyzeWorkbenchTab', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  test('loads toolbox methods, renders graph, edits window level, and runs workflow', async () => {
    mockFetch();
    render(<AnalyzeWorkbenchTab projectId="proj-1" projectType="PT3" setError={jest.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Workflow Studio' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('analyze-source-summary')).toHaveTextContent('1 parts'));
    expect(screen.getByTestId('analyze-source-summary')).toHaveTextContent('2 images');
    expect(screen.getByRole('button', { name: /Workflow block Window \/ Level Normalization/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /YOLOv8 Object Detection/i }));
    expect(screen.getByRole('button', { name: /Workflow block YOLOv8 Object Detection/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Workflow block Window \/ Level Normalization/i }));
    fireEvent.change(screen.getByLabelText('Window'), { target: { value: '250' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByTestId('analyze-run-summary')).toHaveTextContent('simulated'));
    const executeCall = global.fetch.mock.calls.find(([url]) => url === '/api/projects/proj-1/analyze/workflows/execute');
    expect(executeCall).toEqual([
      '/api/projects/proj-1/analyze/workflows/execute',
      expect.objectContaining({
        method: 'POST',
      })
    ]);
    const workflow = JSON.parse(executeCall[1].body);
    expect(workflow.nodes.some((node) => node.method_id === 'output.versioned_image_artifact')).toBe(true);
    expect(workflow.output).toEqual(expect.objectContaining({ mode: 'versioned_image', version_strategy: 'append_vn', preserve_original: true }));
    expect(workflow.source.kind).toBe('project_parts');
    expect(executeCall[1].body).toContain('"window":250');
  });

  test('chooses an example image and runs only the example through the pipeline', async () => {
    mockFetch();
    render(<AnalyzeWorkbenchTab projectId="proj-1" projectType="PT3" setError={jest.fn()} />);

    await screen.findByRole('heading', { name: 'Workflow Studio' });
    await waitFor(() => expect(screen.getByTestId('analyze-source-summary')).toHaveTextContent('2 images'));

    fireEvent.click(screen.getByRole('button', { name: /Workflow block Loaded Part Images/i }));
    const dialog = screen.getByRole('dialog', { name: 'Loaded Images to Process' });
    expect(dialog).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Choose Example'), { target: { value: 'img-2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close input source chooser' }));

    fireEvent.click(screen.getByRole('button', { name: 'Run Example' }));

    await waitFor(() => expect(screen.getByTestId('analyze-run-summary')).toHaveTextContent('simulated'));
    const executeCall = global.fetch.mock.calls.find(([url]) => url === '/api/projects/proj-1/analyze/workflows/execute');
    const workflow = JSON.parse(executeCall[1].body);
    expect(workflow.source.kind).toBe('manual_selection');
    expect(workflow.source.selected_image_ids).toEqual(['img-2']);
    expect(workflow.source.example_image_id).toBe('img-2');
  });

  test('removes images from the process set through the input block modal', async () => {
    mockFetch();
    render(<AnalyzeWorkbenchTab projectId="proj-1" projectType="PT3" setError={jest.fn()} />);

    await screen.findByRole('heading', { name: 'Workflow Studio' });
    await waitFor(() => expect(screen.getByTestId('analyze-source-summary')).toHaveTextContent('2 images'));
    fireEvent.click(screen.getByRole('button', { name: /Workflow block Loaded Part Images/i }));
    const dialog = screen.getByRole('dialog', { name: 'Loaded Images to Process' });
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Remove' })[0]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close input source chooser' }));

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByTestId('analyze-run-summary')).toHaveTextContent('simulated'));
    const executeCall = global.fetch.mock.calls.find(([url]) => url === '/api/projects/proj-1/analyze/workflows/execute');
    const workflow = JSON.parse(executeCall[1].body);
    expect(workflow.source.kind).toBe('manual_selection');
    expect(workflow.source.selected_image_ids).toEqual(['img-2']);
  });

  test('removes the selected workflow block from the configuration column', async () => {
    mockFetch();
    render(<AnalyzeWorkbenchTab projectId="proj-1" projectType="PT3" setError={jest.fn()} />);

    await waitFor(() => expect(screen.getByRole('button', { name: /Workflow block Window \/ Level Normalization/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Workflow block Window \/ Level Normalization/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(screen.queryByRole('button', { name: /Workflow block Window \/ Level Normalization/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByTestId('analyze-run-summary')).toHaveTextContent('simulated'));
    const executeCall = global.fetch.mock.calls.find(([url]) => url === '/api/projects/proj-1/analyze/workflows/execute');
    const workflow = JSON.parse(executeCall[1].body);
    expect(workflow.nodes.map((node) => node.method_id)).not.toContain('preprocess.window_level_normalization');
  });

  test('drags workflow blocks to reposition them on the graph canvas', async () => {
    mockFetch();
    render(<AnalyzeWorkbenchTab projectId="proj-1" projectType="PT3" setError={jest.fn()} />);

    const windowNode = await screen.findByRole('button', { name: /Workflow block Window \/ Level Normalization/i });
    expect(windowNode).toHaveStyle({ left: '247px', top: '188px' });

    fireEvent.mouseDown(windowNode, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseMove(windowNode, { clientX: 150, clientY: 132 });
    fireEvent.mouseUp(windowNode, { clientX: 150, clientY: 132 });

    await waitFor(() => expect(windowNode).toHaveStyle({ left: '297px', top: '220px' }));
  });
});
