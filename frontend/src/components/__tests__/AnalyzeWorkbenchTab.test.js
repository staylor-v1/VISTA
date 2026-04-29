import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      parameters: [],
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
  images: [],
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
    fireEvent.click(screen.getByRole('button', { name: 'Simulate' }));

    await waitFor(() => expect(screen.getByTestId('analyze-run-summary')).toHaveTextContent('simulated'));
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/proj-1/analyze/workflows/execute',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"window":250'),
      })
    );
  });
});
