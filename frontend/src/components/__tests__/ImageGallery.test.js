import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import ImageGallery from '../ImageGallery';

// Mock react-router-dom
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

// Mock data
const mockRegularImage = {
  id: 'img-1',
  filename: 'test-image.jpg',
  size_bytes: 1024000,
  created_at: '2023-01-01T00:00:00Z',
  deleted_at: null,
  storage_deleted: false
};

const mockDeletedImage = {
  id: 'img-2',
  filename: 'deleted-image.jpg',
  size_bytes: 512000,
  created_at: '2023-01-02T00:00:00Z',
  deleted_at: '2023-01-03T00:00:00Z',
  storage_deleted: false,
  deletion_reason: 'Test deletion'
};

const mockPermanentlyDeletedImage = {
  id: 'img-3',
  filename: 'permanently-deleted.jpg',
  size_bytes: 256000,
  created_at: '2023-01-01T00:00:00Z',
  deleted_at: '2023-01-02T00:00:00Z',
  storage_deleted: true,
  deletion_reason: 'Permanent deletion test'
};

const mockImageWithMetadata = {
  id: 'img-4',
  filename: 'brick-wall.jpg',
  size_bytes: 2048000,
  created_at: '2023-01-04T00:00:00Z',
  deleted_at: null,
  storage_deleted: false,
  metadata: { brick: true, color: 'red', location: 'warehouse' }
};

const mockImageWithMetadataUnderscore = {
  id: 'img-5',
  filename: 'concrete-slab.jpg',
  size_bytes: 3072000,
  created_at: '2023-01-05T00:00:00Z',
  deleted_at: null,
  storage_deleted: false,
  metadata_: { concrete: true, color: 'gray' }
};

const mockImageNoMetadata = {
  id: 'img-6',
  filename: 'no-meta.jpg',
  size_bytes: 512000,
  created_at: '2023-01-06T00:00:00Z',
  deleted_at: null,
  storage_deleted: false
};

const renderImageGallery = (props = {}) => {
  const defaultProps = {
    projectId: 'test-project-id',
    images: [mockRegularImage],
    loading: false,
    onImageUpdated: jest.fn(),
    refreshProjectImages: jest.fn(),
    ...props
  };

  return render(
    <BrowserRouter>
      <ImageGallery {...defaultProps} />
    </BrowserRouter>
  );
};

describe('ImageGallery', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
  });

  describe('Regular Images', () => {
    test('renders regular images with proper thumbnail URLs', () => {
      renderImageGallery();
      
      const image = screen.getByAltText('test-image.jpg');
      expect(image).toBeInTheDocument();
      expect(image.src).toContain('/api/images/img-1/thumbnail?width=400&height=400');
    });

    test('displays image filename and size', () => {
      renderImageGallery();
      
      expect(screen.getByText('test-image.jpg')).toBeInTheDocument();
      expect(screen.getByText('1000 KB')).toBeInTheDocument();
    });

    test('navigates to image view when image is clicked', () => {
      renderImageGallery();
      
      const imageContainer = screen.getByAltText('test-image.jpg').closest('.gallery-item-image');
      fireEvent.click(imageContainer);
      
      expect(mockNavigate).toHaveBeenCalledWith('/view/img-1?project=test-project-id');
    });

    test('shows View button on hover', () => {
      renderImageGallery();
      
      const viewButton = screen.getByText('View');
      expect(viewButton).toBeInTheDocument();
    });
  });

  describe('Deleted Images', () => {
    test('renders deleted images with placeholder SVG', () => {
      renderImageGallery({ images: [mockDeletedImage] });
      
      const image = screen.getByAltText('deleted-image.jpg');
      expect(image).toBeInTheDocument();
      expect(image.src).toContain('data:image/svg+xml;base64,');
      // Decode the base64 content to check for "Image Deleted" text
      const base64Content = image.src.split(',')[1];
      const decodedContent = atob(base64Content);
      expect(decodedContent).toContain('Image Deleted');
    });

    test('applies deleted class to gallery item', () => {
      renderImageGallery({ images: [mockDeletedImage] });
      
      const galleryItem = screen.getByAltText('deleted-image.jpg').closest('.gallery-item');
      expect(galleryItem).toHaveClass('deleted');
    });

    test('shows deleted status indicator', () => {
      renderImageGallery({ images: [mockDeletedImage] });
      
      expect(screen.getByText('Deleted')).toBeInTheDocument();
    });

    test('shows Restore button for deleted but not permanently deleted images', () => {
      renderImageGallery({ images: [mockDeletedImage] });
      
      const restoreButton = screen.getByText('Restore');
      expect(restoreButton).toBeInTheDocument();
    });

    test('does not show Restore button for permanently deleted images', () => {
      renderImageGallery({ images: [mockPermanentlyDeletedImage] });
      
      expect(screen.queryByText('Restore')).not.toBeInTheDocument();
    });

    test('does not show Delete button for any images in gallery', () => {
      renderImageGallery({ images: [mockRegularImage, mockDeletedImage] });
      
      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });
  });

  describe('Image Loading', () => {
    test('uses fallback SVG on image load error for regular images', async () => {
      renderImageGallery();
      
      const image = screen.getByAltText('test-image.jpg');
      
      // Simulate image load error
      fireEvent.error(image);
      
      await waitFor(() => {
        expect(image.src).toContain('data:image/svg+xml;base64,');
        const base64Content = image.src.split(',')[1];
        const decodedContent = atob(base64Content);
        expect(decodedContent).toContain('Image Unavailable');
      });
    });

    test('uses deleted placeholder SVG on image load error for deleted images', async () => {
      renderImageGallery({ images: [mockDeletedImage] });
      
      const image = screen.getByAltText('deleted-image.jpg');
      
      // Simulate image load error
      fireEvent.error(image);
      
      await waitFor(() => {
        expect(image.src).toContain('data:image/svg+xml;base64,');
        const base64Content = image.src.split(',')[1];
        const decodedContent = atob(base64Content);
        expect(decodedContent).toContain('Image Deleted');
      });
    });
  });

  describe('Gallery Controls', () => {
    test('displays correct image count', () => {
      renderImageGallery({ images: [mockRegularImage, mockDeletedImage] });
      
      expect(screen.getByText('2 images')).toBeInTheDocument();
    });

    test('shows search functionality', () => {
      renderImageGallery();

      const searchInput = screen.getByPlaceholderText('Search by filename...');
      expect(searchInput).toBeInTheDocument();
    });

    test('filters images based on search term', async () => {
      renderImageGallery({ images: [mockRegularImage, mockDeletedImage] });

      const searchInput = screen.getByPlaceholderText('Search by filename...');
      fireEvent.change(searchInput, { target: { value: 'test-image' } });

      await waitFor(() => {
        expect(screen.getByText('test-image.jpg')).toBeInTheDocument();
        expect(screen.queryByText('deleted-image.jpg')).not.toBeInTheDocument();
      });
    });
  });

  describe('Loading States', () => {
    test('shows loading spinner when loading is true', () => {
      renderImageGallery({ loading: true, images: [] });
      
      expect(screen.getByText('Loading images...')).toBeInTheDocument();
      const spinnerElement = document.querySelector('.spinner');
      expect(spinnerElement).toBeInTheDocument();
    });

    test('shows empty state when no images', () => {
      renderImageGallery({ images: [] });
      
      expect(screen.getByText('No images yet')).toBeInTheDocument();
      expect(screen.getByText('Upload your first image to get started')).toBeInTheDocument();
    });
  });

  describe('Metadata Search', () => {
    const metadataImages = [mockImageWithMetadata, mockImageWithMetadataUnderscore, mockImageNoMetadata];

    test('filters by "All Metadata" and returns images with matching values', async () => {
      renderImageGallery({ images: metadataImages });

      const select = screen.getByDisplayValue('Filename');
      fireEvent.change(select, { target: { value: 'metadata' } });

      const searchInput = screen.getByPlaceholderText('Search by metadata...');
      fireEvent.change(searchInput, { target: { value: 'red' } });

      await waitFor(() => {
        expect(screen.getByText('brick-wall.jpg')).toBeInTheDocument();
        expect(screen.queryByText('concrete-slab.jpg')).not.toBeInTheDocument();
        expect(screen.queryByText('no-meta.jpg')).not.toBeInTheDocument();
      });
    });

    test('filters by "All Metadata" with metadata_ field (backward compat)', async () => {
      renderImageGallery({ images: metadataImages });

      const select = screen.getByDisplayValue('Filename');
      fireEvent.change(select, { target: { value: 'metadata' } });

      const searchInput = screen.getByPlaceholderText('Search by metadata...');
      fireEvent.change(searchInput, { target: { value: 'gray' } });

      await waitFor(() => {
        expect(screen.getByText('concrete-slab.jpg')).toBeInTheDocument();
        expect(screen.queryByText('brick-wall.jpg')).not.toBeInTheDocument();
        expect(screen.queryByText('no-meta.jpg')).not.toBeInTheDocument();
      });
    });

    test('filters by specific metadata key', async () => {
      renderImageGallery({ images: metadataImages });

      const select = screen.getByDisplayValue('Filename');
      fireEvent.change(select, { target: { value: 'color' } });

      const searchInput = screen.getByPlaceholderText('Search by color...');
      fireEvent.change(searchInput, { target: { value: 'red' } });

      await waitFor(() => {
        expect(screen.getByText('brick-wall.jpg')).toBeInTheDocument();
        expect(screen.queryByText('concrete-slab.jpg')).not.toBeInTheDocument();
      });
    });

    test('populates metadata keys dropdown from both metadata and metadata_ fields', () => {
      renderImageGallery({ images: metadataImages });

      const select = screen.getByDisplayValue('Filename');
      const options = Array.from(select.querySelectorAll('option')).map(o => o.value);

      // Keys from metadata field (brick, color, location)
      expect(options).toContain('brick');
      expect(options).toContain('color');
      expect(options).toContain('location');
      // Keys from metadata_ field (concrete, color -- color already present)
      expect(options).toContain('concrete');
    });

    test('returns no images when metadata search has no matches', async () => {
      renderImageGallery({ images: metadataImages });

      const select = screen.getByDisplayValue('Filename');
      fireEvent.change(select, { target: { value: 'metadata' } });

      const searchInput = screen.getByPlaceholderText('Search by metadata...');
      fireEvent.change(searchInput, { target: { value: 'nonexistent_value_xyz' } });

      await waitFor(() => {
        expect(screen.queryByText('brick-wall.jpg')).not.toBeInTheDocument();
        expect(screen.queryByText('concrete-slab.jpg')).not.toBeInTheDocument();
        expect(screen.queryByText('no-meta.jpg')).not.toBeInTheDocument();
      });
    });

    test('images without metadata are excluded from metadata search', async () => {
      renderImageGallery({ images: metadataImages });

      const select = screen.getByDisplayValue('Filename');
      fireEvent.change(select, { target: { value: 'metadata' } });

      const searchInput = screen.getByPlaceholderText('Search by metadata...');
      fireEvent.change(searchInput, { target: { value: 'true' } });

      await waitFor(() => {
        // Both images with metadata match (brick: true, concrete: true)
        expect(screen.getByText('brick-wall.jpg')).toBeInTheDocument();
        expect(screen.getByText('concrete-slab.jpg')).toBeInTheDocument();
        // Image without metadata is excluded
        expect(screen.queryByText('no-meta.jpg')).not.toBeInTheDocument();
      });
    });
  });

  describe('Restore Functionality', () => {
    test('calls handleRestore when restore button is clicked', async () => {
      global.fetch = jest.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ...mockDeletedImage, deleted_at: null })
        })
      );

      const mockOnImageUpdated = jest.fn();
      const mockRefreshProjectImages = jest.fn();
      
      renderImageGallery({ 
        images: [mockDeletedImage],
        onImageUpdated: mockOnImageUpdated,
        refreshProjectImages: mockRefreshProjectImages
      });
      
      const restoreButton = screen.getByText('Restore');
      fireEvent.click(restoreButton);
      
      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/projects/test-project-id/images/img-2/restore',
          { method: 'POST' }
        );
      });

      global.fetch.mockRestore();
    });
  });

  describe('List View', () => {
    test('switches to list view when list button is clicked', () => {
      renderImageGallery({ images: [mockRegularImage] });

      const listButton = screen.getByTitle('List view');
      fireEvent.click(listButton);

      expect(document.querySelector('.gallery-list')).toBeInTheDocument();
      expect(document.querySelector('.gallery-grid')).not.toBeInTheDocument();
    });

    test('list view shows filename column header and filename', () => {
      renderImageGallery({ images: [mockRegularImage] });

      fireEvent.click(screen.getByTitle('List view'));

      const headers = document.querySelectorAll('.gallery-list-header .gallery-list-cell');
      const headerTexts = Array.from(headers).map(h => h.textContent);
      expect(headerTexts).toContain('Filename');
      expect(headerTexts).toContain('Review Status');

      expect(screen.getAllByText('test-image.jpg').length).toBeGreaterThan(0);
    });

    test('list view shows metadata columns from image metadata', () => {
      renderImageGallery({ images: [mockImageWithMetadata] });

      fireEvent.click(screen.getByTitle('List view'));

      const headers = document.querySelectorAll('.gallery-list-header .gallery-list-cell');
      const headerTexts = Array.from(headers).map(h => h.textContent);
      expect(headerTexts).toContain('color');
      expect(headerTexts).toContain('location');
    });

    test('list view navigates to image on row click', () => {
      renderImageGallery({ images: [mockRegularImage] });

      fireEvent.click(screen.getByTitle('List view'));

      const row = document.querySelector('.gallery-list-row');
      fireEvent.click(row);

      expect(mockNavigate).toHaveBeenCalledWith('/view/img-1?project=test-project-id');
    });

    test('list view shows deleted badge for deleted images', () => {
      renderImageGallery({ images: [mockDeletedImage] });

      fireEvent.click(screen.getByTitle('List view'));

      expect(screen.getByText('Deleted')).toBeInTheDocument();
    });

    test('list view row has deleted class for deleted images', () => {
      renderImageGallery({ images: [mockDeletedImage] });

      fireEvent.click(screen.getByTitle('List view'));

      const row = document.querySelector('.gallery-list-row');
      expect(row).toHaveClass('deleted');
    });

    test('list view supports checkbox selection', () => {
      renderImageGallery({ images: [mockRegularImage] });

      fireEvent.click(screen.getByTitle('List view'));

      const checkbox = document.querySelector('.gallery-list-row input[type="checkbox"]');
      expect(checkbox).toBeInTheDocument();
      fireEvent.click(checkbox);

      const row = document.querySelector('.gallery-list-row');
      expect(row).toHaveClass('selected');
    });

    test('list view excludes measurements key from metadata columns', () => {
      const imageWithMeasurements = {
        id: 'img-meas',
        filename: 'measured.jpg',
        size_bytes: 1024,
        created_at: '2023-01-01T00:00:00Z',
        deleted_at: null,
        storage_deleted: false,
        metadata: { color: 'blue', measurements: [{ id: 1, length: 42 }] }
      };
      renderImageGallery({ images: [imageWithMeasurements] });

      fireEvent.click(screen.getByTitle('List view'));

      const headers = document.querySelectorAll('.gallery-list-header .gallery-list-cell');
      const headerTexts = Array.from(headers).map(h => h.textContent);
      expect(headerTexts).toContain('color');
      expect(headerTexts).not.toContain('measurements');
    });
  });
});