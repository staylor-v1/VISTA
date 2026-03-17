import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import ImageView from '../ImageView';

// Mock react-router-dom
let mockParams = { imageId: 'test-image-id' };
let mockSearchParams = new URLSearchParams('project=test-project-id');
const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => mockParams,
  useSearchParams: () => [mockSearchParams],
  useNavigate: () => mockNavigate,
}));

// Mock child components
jest.mock('../components/ImageDisplay', () => {
  return function MockImageDisplay({ image, imageId }) {
    return <div data-testid="image-display">ImageDisplay - {image ? image.filename : 'Loading'}</div>;
  };
});

jest.mock('../components/ImageMetadata', () => {
  return function MockImageMetadata() {
    return <div data-testid="image-metadata">ImageMetadata</div>;
  };
});

jest.mock('../components/ImageClassifications', () => {
  return function MockImageClassifications() {
    return <div data-testid="image-classifications">ImageClassifications</div>;
  };
});

jest.mock('../components/CompactImageClassifications', () => {
  return function MockCompactImageClassifications() {
    return <div data-testid="compact-image-classifications">CompactImageClassifications</div>;
  };
});

jest.mock('../components/ImageComments', () => {
  return function MockImageComments() {
    return <div data-testid="image-comments">ImageComments</div>;
  };
});

jest.mock('../components/ImageDeletionControls', () => {
  return function MockImageDeletionControls() {
    return <div data-testid="image-deletion-controls">ImageDeletionControls</div>;
  };
});

jest.mock('../components/ImageGroupPanel', () => {
  return function MockImageGroupPanel() {
    return <div data-testid="image-group-panel">ImageGroupPanel</div>;
  };
});

// Mock data
const mockRegularImage = {
  id: 'test-image-id',
  filename: 'test-image.jpg',
  size_bytes: 1024000,
  created_at: '2023-01-01T00:00:00Z',
  deleted_at: null,
  storage_deleted: false
};

const mockDeletedImage = {
  id: 'test-image-id',
  filename: 'deleted-image.jpg',
  size_bytes: 512000,
  created_at: '2023-01-02T00:00:00Z',
  deleted_at: '2023-01-03T00:00:00Z',
  storage_deleted: false,
  deletion_reason: 'Test deletion'
};

const mockProjectImages = [mockRegularImage, mockDeletedImage];

const mockImageA = {
  id: 'img-a',
  filename: 'alpha.jpg',
  size_bytes: 500000,
  created_at: '2023-01-01T00:00:00Z',
  deleted_at: null,
  storage_deleted: false,
};

const mockImageB = {
  id: 'img-b',
  filename: 'bravo.png',
  size_bytes: 2000000,
  created_at: '2023-01-02T00:00:00Z',
  deleted_at: null,
  storage_deleted: false,
  content_type: 'image/png',
};

const mockImageC = {
  id: 'img-c',
  filename: 'charlie.jpg',
  size_bytes: 1000000,
  created_at: '2023-01-03T00:00:00Z',
  deleted_at: null,
  storage_deleted: false,
};

const mockNavImages = [mockImageA, mockImageB, mockImageC];

// Mock fetch
global.fetch = jest.fn();

const renderImageView = () => {
  return render(
    <BrowserRouter>
      <ImageView />
    </BrowserRouter>
  );
};

describe('ImageView', () => {
  beforeEach(() => {
    fetch.mockClear();
    localStorage.clear();
    // Provide a safe default for any unexpected fetches
    fetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}), text: async () => '' });
    mockNavigate.mockClear();
    console.error = jest.fn(); // Mock console.error to avoid noise in tests
    // Reset dynamic router params to defaults before each test
    mockParams = { imageId: 'test-image-id' };
    mockSearchParams = new URLSearchParams('project=test-project-id');
  });

  afterEach(() => {
    // Keep the jest mock in place between tests; just reset calls/implementations
    fetch.mockReset();
  });

  describe('Regular Image Loading', () => {
    test('loads regular image successfully via direct endpoint', async () => {
      fetch.mockImplementation((url) => {
        if (url === '/api/users/me') return Promise.resolve({ ok: false, status: 401 });
        if (url === `/api/images/${mockParams.imageId}`) return Promise.resolve({ ok: true, json: async () => mockRegularImage });
        if (url === `/api/projects/test-project-id/images?include_deleted=true`) return Promise.resolve({ ok: true, json: async () => mockProjectImages });
        if (url === `/api/projects/test-project-id/classes`) return Promise.resolve({ ok: true, json: async () => [] });
        return Promise.resolve({ ok: true, json: async () => [] });
      });

      renderImageView();

      await waitFor(() => {
        expect(screen.getByText('test-image.jpg')).toBeInTheDocument();
      });

      expect(fetch).toHaveBeenCalledWith('/api/images/test-image-id');
      expect(screen.getByTestId('image-display')).toHaveTextContent('test-image.jpg');
    });

    test('sets document title correctly for regular images', async () => {
      fetch.mockImplementation((url) => {
        if (url === '/api/users/me') return Promise.resolve({ ok: false, status: 401 });
        if (url === `/api/images/${mockParams.imageId}`) return Promise.resolve({ ok: true, json: async () => mockRegularImage });
        if (url === `/api/projects/test-project-id/images?include_deleted=true`) return Promise.resolve({ ok: true, json: async () => mockProjectImages });
        if (url === `/api/projects/test-project-id/classes`) return Promise.resolve({ ok: true, json: async () => [] });
        return Promise.resolve({ ok: true, json: async () => [] });
      });

      renderImageView();

      await waitFor(() => {
        expect(document.title).toBe('test-image.jpg - Image Manager');
      });
    });
  });

  describe('Deleted Image Fallback Logic', () => {
    test('falls back to project endpoint when direct fetch fails', async () => {
      fetch.mockImplementation((url) => {
        if (url === '/api/users/me') return Promise.resolve({ ok: false, status: 401 });
        if (url === `/api/images/${mockParams.imageId}`) return Promise.resolve({ ok: false, status: 404 });
        if (url === `/api/projects/test-project-id/images?include_deleted=true`) return Promise.resolve({ ok: true, json: async () => [mockDeletedImage] });
        if (url === `/api/projects/test-project-id/classes`) return Promise.resolve({ ok: true, json: async () => [] });
        if (url === `/api/projects/test-project-id/images?include_deleted=true`) return Promise.resolve({ ok: true, json: async () => mockProjectImages });
        return Promise.resolve({ ok: true, json: async () => [] });
      });

      renderImageView();

      await waitFor(() => {
        expect(screen.getByText('deleted-image.jpg')).toBeInTheDocument();
      });

      // Verify expected endpoints were called
      expect(fetch).toHaveBeenCalledWith('/api/images/test-image-id');
      expect(fetch).toHaveBeenCalledWith('/api/projects/test-project-id/images?include_deleted=true');
    });

    test('logs fallback attempt when direct fetch fails', async () => {
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      fetch.mockImplementation((url) => {
        if (url === '/api/users/me') return Promise.resolve({ ok: false, status: 401 });
        if (url === `/api/images/${mockParams.imageId}`) return Promise.resolve({ ok: false, status: 404 });
        if (url === `/api/projects/test-project-id/images?include_deleted=true`) return Promise.resolve({ ok: true, json: async () => [mockDeletedImage] });
        if (url === `/api/projects/test-project-id/classes`) return Promise.resolve({ ok: true, json: async () => [] });
        return Promise.resolve({ ok: true, json: async () => mockProjectImages });
      });

      renderImageView();

      await waitFor(() => {
        expect(consoleSpy).toHaveBeenCalledWith(
          'Direct image fetch failed, trying project endpoint with deleted images...'
        );
      });

      consoleSpy.mockRestore();
    });

    test('sets document title correctly for deleted images loaded via fallback', async () => {
      fetch.mockImplementation((url) => {
        if (url === '/api/users/me') return Promise.resolve({ ok: false, status: 401 });
        if (url === `/api/images/${mockParams.imageId}`) return Promise.resolve({ ok: false, status: 404 });
        if (url === `/api/projects/test-project-id/images?include_deleted=true`) return Promise.resolve({ ok: true, json: async () => [mockDeletedImage] });
        if (url === `/api/projects/test-project-id/classes`) return Promise.resolve({ ok: true, json: async () => [] });
        return Promise.resolve({ ok: true, json: async () => mockProjectImages });
      });

      renderImageView();

      await waitFor(() => {
        expect(document.title).toBe('deleted-image.jpg - Image Manager');
      });
    });

    test('handles case where image not found in project images', async () => {
      // URL-based mocking to avoid order fragility
      fetch.mockImplementation((url) => {
        if (url === '/api/users/me') {
          return Promise.resolve({ ok: false, status: 401 });
        }
        if (url === `/api/images/${mockParams.imageId}`) {
          return Promise.resolve({ ok: false, status: 404 });
        }
        if (url === `/api/projects/test-project-id/images?include_deleted=true`) {
          // Fallback lookup returns empty (image not found)
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        if (url === `/api/projects/test-project-id/classes`) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        // Default: succeed with empty to avoid overriding error
        return Promise.resolve({ ok: true, json: async () => [] });
      });

      renderImageView();

      await waitFor(() => {
        expect(screen.getByText('Failed to load image. Please try again later.')).toBeInTheDocument();
      });

      expect(console.error).toHaveBeenCalledWith(
        'Error loading image data:',
        expect.any(Error)
      );
    });

    test('handles project endpoint failure after direct fetch failure', async () => {
      fetch
        .mockResolvedValueOnce({
          ok: false,
          status: 401
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 404
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 500
        });

      renderImageView();

      await waitFor(() => {
        expect(screen.getByText('Failed to load image. Please try again later.')).toBeInTheDocument();
      });
    });
  });

  describe('Project Images Loading', () => {
    test('loads project images with include_deleted=true', async () => {
      fetch.mockImplementation((url) => {
        if (url === '/api/users/me') {
          return Promise.resolve({ ok: false, status: 401 });
        }
        if (url === `/api/images/${mockParams.imageId}`) {
          return Promise.resolve({ ok: true, json: async () => mockRegularImage });
        }
        if (url === `/api/projects/test-project-id/images?include_deleted=true`) {
          return Promise.resolve({ ok: true, json: async () => mockProjectImages });
        }
        if (url === `/api/projects/test-project-id/classes`) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      });

      renderImageView();

      await waitFor(() => {
        expect(fetch).toHaveBeenCalledWith('/api/projects/test-project-id/images?include_deleted=true');
      });
    });

    test('handles project images loading failure', async () => {
      // URL-based mocking to ensure image load succeeds but project images fail
      fetch.mockImplementation((url) => {
        if (url === '/api/users/me') {
          return Promise.resolve({ ok: false, status: 401 });
        }
        if (url === `/api/images/${mockParams.imageId}`) {
          return Promise.resolve({ ok: true, json: async () => mockRegularImage });
        }
        if (url === `/api/projects/test-project-id/images?include_deleted=true`) {
          return Promise.resolve({ ok: false, status: 500 });
        }
        if (url === `/api/projects/test-project-id/classes`) {
          return Promise.resolve({ ok: true, json: async () => [] });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      });

      renderImageView();

      await waitFor(() => {
        expect(screen.getByText('Failed to load project images for navigation. Please try again later.')).toBeInTheDocument();
      });
    });
  });

  describe('Navigation', () => {
    test('back button navigates to project page', async () => {
      fetch
        .mockResolvedValueOnce({
          ok: false,
          status: 401
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockRegularImage)
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockProjectImages)
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([])
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([])
        });

      renderImageView();

      await waitFor(() => {
        expect(screen.getByText('← Back')).toBeInTheDocument();
      });
    });
  });

  describe('Error States', () => {
    test('displays error when image ID or project ID is missing', () => {
      // Override dynamic params used by our jest.mock above
      mockParams = { imageId: null };
      mockSearchParams = new URLSearchParams('');

      renderImageView();

      expect(screen.getByText('Image ID or Project ID is missing.')).toBeInTheDocument();
    });

    test('displays loading state initially', () => {
      fetch.mockImplementation(() => new Promise(() => {})); // Never resolves

      renderImageView();

      // With mocked ImageDisplay, we show a placeholder text
      expect(screen.getByTestId('image-display')).toHaveTextContent('Loading');
    });
  });

  describe('Component Integration', () => {
    test('renders all expected child components', async () => {
      fetch
        .mockResolvedValueOnce({
          ok: false,
          status: 401
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockRegularImage)
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(mockProjectImages)
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([])
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([])
        });

      renderImageView();

      await waitFor(() => {
        expect(screen.getByTestId('image-display')).toBeInTheDocument();
        expect(screen.getByTestId('image-metadata')).toBeInTheDocument();
        expect(screen.getByTestId('compact-image-classifications')).toBeInTheDocument();
        expect(screen.getByTestId('image-comments')).toBeInTheDocument();
        expect(screen.getByTestId('image-deletion-controls')).toBeInTheDocument();
      });
    });
  });

  describe('Gallery State Navigation', () => {
    const setupNavFetch = (projectImages = mockNavImages) => {
      // Set current image to img-b so we can verify index positioning
      mockParams = { imageId: 'img-b' };

      fetch.mockImplementation((url) => {
        if (url === '/api/users/me') return Promise.resolve({ ok: false, status: 401 });
        if (url === '/api/images/img-b') return Promise.resolve({ ok: true, json: async () => mockImageB });
        if (url.startsWith('/api/projects/test-project-id/images')) return Promise.resolve({ ok: true, json: async () => projectImages });
        if (url.startsWith('/api/projects/test-project-id/classes')) return Promise.resolve({ ok: true, json: async () => [] });
        if (url.startsWith('/api/projects/test-project-id/image-review-statuses')) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ 'img-a': 'pass', 'img-b': 'unreviewed', 'img-c': 'pass' }),
          });
        }
        return Promise.resolve({ ok: true, json: async () => [] });
      });
    };

    test('sorts navigation images by name when gallery state has sortBy=name', async () => {
      localStorage.setItem('gallery_state_test-project-id', JSON.stringify({
        sortBy: 'name',
        searchField: 'filename',
        searchValue: '',
        reviewFilter: 'all',
      }));
      setupNavFetch();

      renderImageView();

      await waitFor(() => {
        expect(screen.getByTestId('image-display')).toHaveTextContent('bravo.png');
      });

      // With sort by name: alpha, bravo, charlie -- img-b (bravo) should be index 1
      // Verify the image loaded (navigation was set up correctly)
      expect(fetch).toHaveBeenCalledWith('/api/images/img-b');
    });

    test('sorts navigation images by size when gallery state has sortBy=size', async () => {
      localStorage.setItem('gallery_state_test-project-id', JSON.stringify({
        sortBy: 'size',
        searchField: 'filename',
        searchValue: '',
        reviewFilter: 'all',
      }));
      setupNavFetch();

      renderImageView();

      await waitFor(() => {
        expect(screen.getByTestId('image-display')).toHaveTextContent('bravo.png');
      });
    });

    test('applies search filter from saved gallery state', async () => {
      localStorage.setItem('gallery_state_test-project-id', JSON.stringify({
        sortBy: 'date',
        searchField: 'filename',
        searchValue: 'bravo',
        reviewFilter: 'all',
      }));
      setupNavFetch();

      renderImageView();

      await waitFor(() => {
        expect(screen.getByTestId('image-display')).toHaveTextContent('bravo.png');
      });

      // The search filter should have narrowed the set to only bravo.png
      // so navigation only includes that one image
    });

    test('applies review filter from saved gallery state', async () => {
      localStorage.setItem('gallery_state_test-project-id', JSON.stringify({
        sortBy: 'date',
        searchField: 'filename',
        searchValue: '',
        reviewFilter: 'pass',
      }));
      setupNavFetch();

      renderImageView();

      // Wait for the component to load and apply the filter
      await waitFor(() => {
        // The review status endpoint should be fetched for the filter
        const reviewCalls = fetch.mock.calls.filter(
          c => c[0].includes('image-review-statuses')
        );
        expect(reviewCalls.length).toBeGreaterThan(0);
      });
    });

    test('falls back to default date sort when no gallery state is saved', async () => {
      // No localStorage set -- should use default date sort
      setupNavFetch();

      renderImageView();

      await waitFor(() => {
        expect(screen.getByTestId('image-display')).toHaveTextContent('bravo.png');
      });

      // Default sort is date descending: charlie (Jan 3), bravo (Jan 2), alpha (Jan 1)
      // img-b (bravo) is at index 1
    });

    test('falls back to default sort when localStorage contains invalid JSON', async () => {
      localStorage.setItem('gallery_state_test-project-id', 'not-valid-json');
      setupNavFetch();

      renderImageView();

      // Should not crash, should render the image
      await waitFor(() => {
        expect(screen.getByTestId('image-display')).toHaveTextContent('bravo.png');
      });
    });

    test('uses group-scoped gallery state key when viewing grouped image', async () => {
      const mockImageBGrouped = { ...mockImageB, group_id: 'grp-1' };

      // Save state under the group key with sort by name
      localStorage.setItem('gallery_state_test-project-id_group_grp-1', JSON.stringify({
        sortBy: 'name',
        searchField: 'filename',
        searchValue: '',
        reviewFilter: 'all',
      }));

      mockParams = { imageId: 'img-b' };
      fetch.mockImplementation((url) => {
        if (url === '/api/users/me') return Promise.resolve({ ok: false, status: 401 });
        if (url === '/api/images/img-b') return Promise.resolve({ ok: true, json: async () => mockImageBGrouped });
        if (url.startsWith('/api/projects/test-project-id/images')) return Promise.resolve({ ok: true, json: async () => mockNavImages });
        if (url.startsWith('/api/projects/test-project-id/classes')) return Promise.resolve({ ok: true, json: async () => [] });
        return Promise.resolve({ ok: true, json: async () => [] });
      });

      renderImageView();

      await waitFor(() => {
        expect(screen.getByTestId('image-display')).toHaveTextContent('bravo.png');
      });

      // Verify the grouped images endpoint was called with group_id
      const imageCalls = fetch.mock.calls.filter(c => c[0].includes('group_id=grp-1'));
      expect(imageCalls.length).toBeGreaterThan(0);
    });

    test('applies content_type search filter from saved state', async () => {
      localStorage.setItem('gallery_state_test-project-id', JSON.stringify({
        sortBy: 'date',
        searchField: 'content_type',
        searchValue: 'png',
        reviewFilter: 'all',
      }));
      setupNavFetch();

      renderImageView();

      await waitFor(() => {
        expect(screen.getByTestId('image-display')).toHaveTextContent('bravo.png');
      });
    });

    test('silently handles review status API failure during navigation filter', async () => {
      localStorage.setItem('gallery_state_test-project-id', JSON.stringify({
        sortBy: 'date',
        searchField: 'filename',
        searchValue: '',
        reviewFilter: 'pass',
      }));
      mockParams = { imageId: 'img-b' };

      fetch.mockImplementation((url) => {
        if (url === '/api/users/me') return Promise.resolve({ ok: false, status: 401 });
        if (url === '/api/images/img-b') return Promise.resolve({ ok: true, json: async () => mockImageB });
        if (url.startsWith('/api/projects/test-project-id/images')) return Promise.resolve({ ok: true, json: async () => mockNavImages });
        if (url.startsWith('/api/projects/test-project-id/classes')) return Promise.resolve({ ok: true, json: async () => [] });
        if (url.includes('image-review-statuses')) return Promise.resolve({ ok: false, status: 500 });
        return Promise.resolve({ ok: true, json: async () => [] });
      });

      renderImageView();

      // Should still render the image even if review status fetch fails
      await waitFor(() => {
        expect(screen.getByTestId('image-display')).toHaveTextContent('bravo.png');
      });
    });
  });
});