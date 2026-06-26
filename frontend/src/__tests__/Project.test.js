import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Project from '../Project';

let mockPendingAutosave = false;
let mockFlushResolve = null;
let mockImagesToPartsProps = null;
const mockFlushPendingAutosave = jest.fn();

jest.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'proj-1' }),
  useNavigate: () => jest.fn(),
}));

jest.mock('../components/ProjectConfigurationPanel', () => {
  const React = require('react');
  return React.forwardRef(function MockProjectConfigurationPanel(_props, ref) {
    React.useImperativeHandle(ref, () => ({
      hasPendingAutosave: () => mockPendingAutosave,
      flushPendingAutosave: mockFlushPendingAutosave,
    }));
    return <div>Project configuration editor</div>;
  });
});

jest.mock('../components/ImageUploader', () => () => <div>Image uploader</div>);
jest.mock('../components/MetadataManager', () => () => <div>Metadata manager</div>);
jest.mock('../components/ClassManager', () => () => <div>Class manager</div>);
jest.mock('../components/InspectionWorkbenchPanel', () => () => <div>Inspection workbench</div>);
jest.mock('../components/AnalyzeWorkbenchTab', () => () => <div>Analyze workbench</div>);
jest.mock('../components/ProjectDataSummaryTab', () => () => <div>Project data summary</div>);
jest.mock('../components/ProjectDataExportPanel', () => () => <div>Project data export</div>);
jest.mock('../components/ProjectReportTab', () => () => <div>Project report</div>);
jest.mock('../components/ProjectPhaseFlow', () => () => <div>Project phase flow</div>);
jest.mock('../components/ImagesToPartsTab', () => (props) => {
  mockImagesToPartsProps = props;
  return <div>Images to parts</div>;
});
jest.mock('../components/OverlaysTab', () => () => <div>Overlays tab</div>);
jest.mock('../components/BatchesTab', () => () => <div>Batches</div>);
jest.mock('../components/RemoveImagesTab', () => () => <div>Remove images</div>);

describe('Project tab autosave coordination', () => {
  beforeEach(() => {
    mockPendingAutosave = false;
    mockFlushResolve = null;
    mockImagesToPartsProps = null;
    mockFlushPendingAutosave.mockReset();
    mockFlushPendingAutosave.mockImplementation(() => new Promise((resolve) => {
      mockFlushResolve = () => {
        mockPendingAutosave = false;
        resolve(true);
      };
    }));
    global.fetch = jest.fn((url) => {
      if (url === '/api/projects/proj-1') {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'proj-1', name: 'Autosave Project', project_type: 'PT1' }) });
      }
      if (url === '/api/projects/proj-1/metadata-dict') {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url === '/api/projects/proj-1/classes') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (String(url).startsWith('/api/projects/proj-1/images')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/api/projects/proj-1/parts') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/api/projects/proj-1/export-bundle-json') {
        return Promise.resolve({ ok: true, json: async () => ({ bundle_summary: {} }) });
      }
      if (url === '/api/projects/proj-1/configuration') {
        return Promise.resolve({ ok: true, json: async () => ({ config: {} }) });
      }
      if (String(url).startsWith('/interface-hierarchy.toml')) {
        return Promise.resolve({ ok: false, text: async () => '' });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('delays tab changes and shows an autosaving message until configuration autosave finishes', async () => {
    mockPendingAutosave = true;
    render(<Project />);

    await waitFor(() => expect(screen.getByText('Project configuration editor')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: 'Project Data' }));

    expect(mockFlushPendingAutosave).toHaveBeenCalledWith('Configuration autosaved.');
    expect(screen.getByRole('status')).toHaveTextContent('Autosaving project configuration before changing tabs…');
    expect(screen.getByText('Project configuration editor')).toBeInTheDocument();

    await act(async () => {
      mockFlushResolve();
    });

    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    expect(screen.getByText('Project data summary')).toBeInTheDocument();
  });

  test('recovers Images to Parts image records from part source metadata when image list is empty but bundle reports images', async () => {
    global.fetch = jest.fn((url) => {
      if (url === '/api/projects/proj-1') {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'proj-1', name: 'Test Data Project', project_type: 'PT1' }) });
      }
      if (url === '/api/projects/proj-1/metadata-dict') {
        return Promise.resolve({ ok: true, json: async () => ({}) });
      }
      if (url === '/api/projects/proj-1/classes') {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (String(url).startsWith('/api/projects/proj-1/images')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      if (url === '/api/projects/proj-1/parts') {
        return Promise.resolve({ ok: true, json: async () => [{
          id: 'part-test-1',
          serial_number: 'TEST-001',
          display_name: 'Test Part 1',
          metadata: { source_images: [{ filename: 'test-data-front.png', image_id: 'img-test-front' }] },
        }] });
      }
      if (url === '/api/projects/proj-1/export-bundle-json') {
        return Promise.resolve({ ok: true, json: async () => ({ bundle_summary: { images: { total: 1 } } }) });
      }
      if (url === '/api/projects/proj-1/configuration') {
        return Promise.resolve({ ok: true, json: async () => ({ config: {} }) });
      }
      if (String(url).startsWith('/interface-hierarchy.toml')) {
        return Promise.resolve({ ok: false, text: async () => '' });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<Project />);

    await waitFor(() => expect(screen.getByText('Project configuration editor')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('tab', { name: 'Project Data' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Images to Parts' }));

    await waitFor(() => expect(mockImagesToPartsProps?.images).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'img-test-front', filename: 'test-data-front.png' }),
    ])));
  });

});
