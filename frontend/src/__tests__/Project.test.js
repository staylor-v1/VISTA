import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Project from '../Project';
import { PROJECT_TYPE_OPTIONS } from '../projectTypes';

let mockPendingAutosave = false;
let mockSearch = '';
let mockFlushResolve = null;
const mockFlushPendingAutosave = jest.fn();
const mockNavigate = jest.fn();
const mockNavigateToLocation = (to) => {
  const search = to?.search ? `?${String(to.search).replace(/^\?/, '')}` : '';
  mockSearch = search;
  window.history.pushState({}, '', `${to?.pathname || '/project/proj-1'}${search}`);
};

jest.mock('react-router-dom', () => ({
  useParams: () => ({ id: 'proj-1' }),
  useNavigate: () => mockNavigate,
  useLocation: () => ({ pathname: '/project/proj-1', search: mockSearch }),
}));

jest.mock('../components/ProjectConfigurationPanel', () => {
  const React = require('react');
  return React.forwardRef(function MockProjectConfigurationPanel(props, ref) {
    React.useImperativeHandle(ref, () => ({
      hasPendingAutosave: () => mockPendingAutosave,
      flushPendingAutosave: mockFlushPendingAutosave,
    }));
    return (
      <div>
        <div>Project configuration editor</div>
        <button type="button" onClick={() => props.onActiveSubtabChange?.('general')}>Show general config</button>
        <button type="button" onClick={() => props.onActiveSubtabChange?.('filenameConvention')}>Show filename config</button>
        <button type="button" onClick={() => props.onActiveSubtabChange?.('hotkeys')}>Show hotkeys config</button>
      </div>
    );
  });
});

jest.mock('../components/ImageUploader', () => () => <div>Image uploader</div>);
jest.mock('../components/MetadataManager', () => () => <div>Metadata manager</div>);
jest.mock('../components/ClassManager', () => () => <div>Class manager</div>);
jest.mock('../components/InspectionWorkbenchPanel', () => {
  const React = require('react');
  const MockInspectionWorkbenchPanel = ({ launchFilters, onInspectionShareStateChange }) => (
    <div>
      <div>Inspection workbench</div>
      <output data-testid="inspection-launch-filters">{JSON.stringify(launchFilters || null)}</output>
      <button
        type="button"
        onClick={() => onInspectionShareStateChange?.({
          selectedBatchId: 'batch-10',
          selectedPartId: 'part-43',
          selectedImageRef: 'image-8',
          reviewFilter: 'pass',
          activeMetadataTab: 'other',
          activeMprPane: 'coronal',
          activeOverlayIds: ['overlay-a'],
        }, { replace: true })}
      >
        Share inspection state
      </button>
    </div>
  );
  return {
    __esModule: true,
    default: MockInspectionWorkbenchPanel,
    buildInspectionShareParams: (state = {}) => {
      const params = new URLSearchParams();
      if (state.selectedBatchId) params.set('batch', state.selectedBatchId);
      if (state.selectedPartId) params.set('part', state.selectedPartId);
      if (state.selectedImageRef) params.set('image', state.selectedImageRef);
      if (state.reviewFilter && state.reviewFilter !== 'all') params.set('review', state.reviewFilter);
      if (state.activeMetadataTab && state.activeMetadataTab !== 'nsipro') params.set('metadataTab', state.activeMetadataTab);
      if (state.activeMprPane && state.activeMprPane !== 'axial') params.set('mprPane', state.activeMprPane);
      if (Array.isArray(state.activeOverlayIds) && state.activeOverlayIds.length > 0) params.set('overlays', state.activeOverlayIds.join(','));
      return params;
    },
  };
});
jest.mock('../components/AnalyzeWorkbenchTab', () => () => <div>Analyze workbench</div>);
jest.mock('../components/ProjectDataSummaryTab', () => () => <div>Project data summary</div>);
jest.mock('../components/ProjectDataExportPanel', () => () => <div>Project data export</div>);
jest.mock('../components/ProjectReportTab', () => () => <div>Project report</div>);
jest.mock('../components/ProjectPhaseFlow', () => () => <div>Project phase flow</div>);
jest.mock('../components/ImagesToPartsTab', () => () => <div>Images to parts</div>);
jest.mock('../components/OverlaysTab', () => () => <div>Overlays tab</div>);
jest.mock('../components/BatchesTab', () => () => <div>Batches</div>);
jest.mock('../components/RemoveImagesTab', () => () => <div>Remove images</div>);
jest.mock('../components/ProjectDataMetadataTab', () => () => <div>Project data metadata</div>);


describe('Project title bar type label', () => {
  const originalPt2ShortLabel = PROJECT_TYPE_OPTIONS.find((option) => option.value === 'PT2')?.shortLabel;

  beforeEach(() => {
    mockPendingAutosave = false;
    mockSearch = '';
    mockNavigate.mockClear();
    mockNavigate.mockImplementation(mockNavigateToLocation);
    window.history.pushState({}, '', '/project/proj-1');
    const pt2Option = PROJECT_TYPE_OPTIONS.find((option) => option.value === 'PT2');
    if (pt2Option) pt2Option.shortLabel = 'Config Short Type';
    global.fetch = jest.fn((url) => {
      if (url === '/api/projects/proj-1') {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'proj-1', name: 'Configurable Type Project', project_type: 'PT2' }) });
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
    const pt2Option = PROJECT_TYPE_OPTIONS.find((option) => option.value === 'PT2');
    if (pt2Option) pt2Option.shortLabel = originalPt2ShortLabel;
    jest.clearAllMocks();
  });

  test('renders the configured short project type string instead of the raw project type code', async () => {
    render(<Project />);

    expect(await screen.findByText('Type: Config Short Type')).toBeInTheDocument();
    expect(screen.queryByText('Type: PT2')).not.toBeInTheDocument();
  });
});

describe('Project tab autosave coordination', () => {
  beforeEach(() => {
    mockPendingAutosave = false;
    mockSearch = '';
    mockFlushResolve = null;
    mockFlushPendingAutosave.mockReset();
    mockFlushPendingAutosave.mockImplementation(() => new Promise((resolve) => {
      mockFlushResolve = () => {
        mockPendingAutosave = false;
        resolve(true);
      };
    }));
    mockNavigate.mockClear();
    mockNavigate.mockImplementation(mockNavigateToLocation);
    window.history.pushState({}, '', `/project/proj-1${mockSearch}`);
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
});


describe('Project query parameter tab selection', () => {
  beforeEach(() => {
    mockPendingAutosave = false;
    mockSearch = '?tab=inspection&part=part-42&batch=batch-9&review=manual&image=image-7&metadataTab=details';
    mockNavigate.mockClear();
    mockNavigate.mockImplementation(mockNavigateToLocation);
    window.history.pushState({}, '', `/project/proj-1${mockSearch}`);
    global.fetch = jest.fn((url) => {
      if (url === '/api/projects/proj-1') {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'proj-1', name: 'Inspection Project', project_type: 'PT1' }) });
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

  test('updates the URL query when clicking a main tab while preserving unrelated params and clearing stale dataTab', async () => {
    mockSearch = '?tab=project_data&dataTab=metadata&batch=batch-9&review=manual';
    window.history.pushState({}, '', `/project/proj-1${mockSearch}`);

    render(<Project />);

    await waitFor(() => expect(screen.getByText('Project data metadata')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: 'Analyze' }));

    await waitFor(() => expect(screen.getByText('Analyze workbench')).toBeInTheDocument());
    expect(mockNavigate).toHaveBeenCalledWith(
      { pathname: '/project/proj-1', search: 'tab=analyze&batch=batch-9&review=manual' },
      { replace: false },
    );
    expect(window.location.search).toBe('?tab=analyze&batch=batch-9&review=manual');
  });

  test('updates tab and dataTab query params when clicking project data subtabs', async () => {
    mockSearch = '?tab=project_data&batch=batch-9';
    window.history.pushState({}, '', `/project/proj-1${mockSearch}`);

    render(<Project />);

    await waitFor(() => expect(screen.getByText('Image uploader')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('tab', { name: 'Overlays' }));

    await waitFor(() => expect(screen.getByText('Overlays tab')).toBeInTheDocument());
    expect(mockNavigate).toHaveBeenCalledWith(
      { pathname: '/project/proj-1', search: 'tab=project_data&batch=batch-9&dataTab=overlays' },
      { replace: false },
    );
    expect(window.location.search).toBe('?tab=project_data&batch=batch-9&dataTab=overlays');
  });

  test('selects the Inspection tab from the project URL query string and passes launch filters', async () => {
    render(<Project />);

    await waitFor(() => expect(screen.getByText('Inspection workbench')).toBeInTheDocument());

    expect(screen.getByRole('tab', { name: 'Inspection' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('inspection-launch-filters')).toHaveTextContent(JSON.stringify({
      selected_batch_id: 'batch-9',
      selected_part_id: 'part-42',
      review_filter: 'manual',
      selected_image_ref: 'image-7',
      active_metadata_tab: 'details',
    }));
  });

  test('shows project classes and metadata management only on the configuration General subtab', async () => {
    mockSearch = '?tab=project_configuration';
    render(<Project />);

    await waitFor(() => expect(screen.getByText('Project configuration editor')).toBeInTheDocument());
    expect(screen.getByText('Class manager')).toBeInTheDocument();
    expect(screen.getByText('Metadata manager')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show filename config' }));
    expect(screen.queryByText('Class manager')).not.toBeInTheDocument();
    expect(screen.queryByText('Metadata manager')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show hotkeys config' }));
    expect(screen.queryByText('Class manager')).not.toBeInTheDocument();
    expect(screen.queryByText('Metadata manager')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show general config' }));
    expect(screen.getByText('Class manager')).toBeInTheDocument();
    expect(screen.getByText('Metadata manager')).toBeInTheDocument();
  });

  test('replaces the parent route query with allowlisted inspection share state', async () => {
    render(<Project />);

    await waitFor(() => expect(screen.getByText('Inspection workbench')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Share inspection state' }));

    expect(mockNavigate).toHaveBeenLastCalledWith(
      {
        pathname: '/project/proj-1',
        search: 'tab=inspection&batch=batch-10&part=part-43&image=image-8&review=pass&metadataTab=other&mprPane=coronal&overlays=overlay-a',
      },
      { replace: true },
    );
  });

});

describe('Project session link sharing', () => {
  beforeEach(() => {
    mockPendingAutosave = false;
    mockSearch = '?tab=inspection&image=image-7';
    mockNavigate.mockClear();
    mockNavigate.mockImplementation(mockNavigateToLocation);
    window.history.pushState({}, '', `/project/proj-1${mockSearch}`);
    global.fetch = jest.fn((url) => {
      if (url === '/api/projects/proj-1') return Promise.resolve({ ok: true, json: async () => ({ id: 'proj-1', name: 'Share Project', project_type: 'PT1' }) });
      if (url === '/api/projects/proj-1/metadata-dict') return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url === '/api/projects/proj-1/classes') return Promise.resolve({ ok: true, json: async () => [] });
      if (String(url).startsWith('/api/projects/proj-1/images')) return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/api/projects/proj-1/parts') return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/api/projects/proj-1/export-bundle-json') return Promise.resolve({ ok: true, json: async () => ({ bundle_summary: {} }) });
      if (url === '/api/projects/proj-1/configuration') return Promise.resolve({ ok: true, json: async () => ({ config: {} }) });
      if (String(url).startsWith('/interface-hierarchy.toml')) return Promise.resolve({ ok: false, text: async () => '' });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
  });

  test('copies the exact current browser URL from the project header', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    render(<Project />);
    await waitFor(() => expect(screen.getByText('Share Project')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Copy session link' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(window.location.href));
    await waitFor(() => expect(screen.getByText('Session link copied to clipboard.')).toBeInTheDocument());
  });
});

describe('Project configurable UI sections', () => {
  beforeEach(() => {
    mockPendingAutosave = false;
    mockSearch = '';
    mockNavigate.mockClear();
    mockNavigate.mockImplementation(mockNavigateToLocation);
    window.history.pushState({}, '', '/project/proj-1');
    global.fetch = jest.fn((url) => {
      if (url === '/api/projects/proj-1') {
        return Promise.resolve({ ok: true, json: async () => ({ id: 'proj-1', name: 'Configurable UI Project', project_type: 'PT1' }) });
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
        return Promise.resolve({
          ok: true,
          json: async () => ({
            config: {
              ui_sections: {
                'main.analyze': false,
                'main.report': false,
                'project_data.batches': false,
                'project_data.data_validation': false,
              },
            },
          }),
        });
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

  test('hides project tabs and Project Data sections disabled by configuration', async () => {
    render(<Project />);

    await waitFor(() => expect(screen.getByText('Project configuration editor')).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('tab', { name: 'Analyze' })).not.toBeInTheDocument());
    expect(screen.queryByRole('tab', { name: 'Report' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Project Data' }));

    expect(screen.queryByRole('tab', { name: 'Batches' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Data Validation' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Images to Parts' })).toBeInTheDocument();
  });
});
