import {
  loadGalleryState,
  saveGalleryState,
  filterBySearch,
  filterByReviewStatus,
  sortImages,
  applyGalleryFilters,
} from '../galleryState';

const mockImages = [
  {
    id: 'img-1',
    filename: 'alpha.jpg',
    size_bytes: 500,
    created_at: '2023-01-01T00:00:00Z',
    content_type: 'image/jpeg',
    uploaded_by_user_id: 'alice@test.com',
    metadata: { color: 'red', location: 'lab-a' },
  },
  {
    id: 'img-2',
    filename: 'bravo.png',
    size_bytes: 2000,
    created_at: '2023-01-03T00:00:00Z',
    content_type: 'image/png',
    uploaded_by_user_id: 'bob@test.com',
    metadata: { color: 'blue', location: 'lab-b' },
  },
  {
    id: 'img-3',
    filename: 'charlie.jpg',
    size_bytes: 1000,
    created_at: '2023-01-02T00:00:00Z',
    content_type: 'image/jpeg',
    uploaded_by_user_id: 'alice@test.com',
  },
];

describe('galleryState utilities', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe('loadGalleryState / saveGalleryState', () => {
    test('returns empty object when key does not exist', () => {
      expect(loadGalleryState('nonexistent')).toEqual({});
    });

    test('round-trips state through localStorage', () => {
      const state = { sortBy: 'name', viewMode: 'large' };
      saveGalleryState('my-key', state);
      expect(loadGalleryState('my-key')).toEqual(state);
    });

    test('returns empty object on corrupt JSON', () => {
      localStorage.setItem('gallery_state_bad', '{not json');
      expect(loadGalleryState('bad')).toEqual({});
    });
  });

  describe('filterBySearch', () => {
    test('returns all images when searchValue is empty', () => {
      expect(filterBySearch(mockImages, 'filename', '')).toBe(mockImages);
    });

    test('returns all images when searchField is empty', () => {
      expect(filterBySearch(mockImages, '', 'alpha')).toBe(mockImages);
    });

    test('filters by filename', () => {
      const result = filterBySearch(mockImages, 'filename', 'alpha');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('img-1');
    });

    test('filters by content_type', () => {
      const result = filterBySearch(mockImages, 'content_type', 'png');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('img-2');
    });

    test('filters by uploaded_by', () => {
      const result = filterBySearch(mockImages, 'uploaded_by', 'bob');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('img-2');
    });

    test('filters by all metadata values', () => {
      const result = filterBySearch(mockImages, 'metadata', 'blue');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('img-2');
    });

    test('filters by specific metadata key', () => {
      const result = filterBySearch(mockImages, 'location', 'lab-a');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('img-1');
    });

    test('returns empty when metadata key is missing from image', () => {
      const result = filterBySearch(mockImages, 'location', 'lab');
      // img-3 has no metadata, so only img-1 and img-2 match
      expect(result).toHaveLength(2);
    });

    test('is case-insensitive', () => {
      const result = filterBySearch(mockImages, 'filename', 'ALPHA');
      expect(result).toHaveLength(1);
    });

    test('handles images with metadata_ instead of metadata', () => {
      const images = [{ id: 'x', metadata_: { tag: 'special' } }];
      const result = filterBySearch(images, 'metadata', 'special');
      expect(result).toHaveLength(1);
    });
  });

  describe('filterByReviewStatus', () => {
    const statuses = { 'img-1': 'pass', 'img-2': 'reject_pending' };

    test('returns all images when filter is "all"', () => {
      expect(filterByReviewStatus(mockImages, 'all', statuses)).toBe(mockImages);
    });

    test('returns all images when filter is falsy', () => {
      expect(filterByReviewStatus(mockImages, null, statuses)).toBe(mockImages);
      expect(filterByReviewStatus(mockImages, '', statuses)).toBe(mockImages);
    });

    test('filters by matching status', () => {
      const result = filterByReviewStatus(mockImages, 'pass', statuses);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('img-1');
    });

    test('treats missing status as unreviewed', () => {
      const result = filterByReviewStatus(mockImages, 'unreviewed', statuses);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('img-3');
    });

    test('handles null reviewStatuses gracefully', () => {
      const result = filterByReviewStatus(mockImages, 'unreviewed', null);
      expect(result).toHaveLength(3);
    });
  });

  describe('sortImages', () => {
    test('sorts by date descending (default)', () => {
      const result = sortImages(mockImages, 'date');
      expect(result.map(i => i.id)).toEqual(['img-2', 'img-3', 'img-1']);
    });

    test('sorts by name ascending', () => {
      const result = sortImages(mockImages, 'name');
      expect(result.map(i => i.id)).toEqual(['img-1', 'img-2', 'img-3']);
    });

    test('sorts by size descending', () => {
      const result = sortImages(mockImages, 'size');
      expect(result.map(i => i.id)).toEqual(['img-2', 'img-3', 'img-1']);
    });

    test('defaults to date sort for unknown sort key', () => {
      const result = sortImages(mockImages, 'unknown');
      expect(result.map(i => i.id)).toEqual(['img-2', 'img-3', 'img-1']);
    });

    test('does not mutate the original array', () => {
      const original = [...mockImages];
      sortImages(mockImages, 'name');
      expect(mockImages).toEqual(original);
    });
  });

  describe('applyGalleryFilters', () => {
    test('applies search, review, and sort together', () => {
      const statuses = { 'img-1': 'pass', 'img-2': 'pass' };
      const result = applyGalleryFilters(mockImages, {
        searchField: 'content_type',
        searchValue: 'jpeg',
        reviewFilter: 'pass',
        sortBy: 'name',
        reviewStatuses: statuses,
      });
      // jpeg matches img-1 and img-3; pass filter keeps only img-1
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('img-1');
    });

    test('defaults to date sort when sortBy is not provided', () => {
      const result = applyGalleryFilters(mockImages, {
        searchField: 'filename',
        searchValue: '',
        reviewFilter: 'all',
        reviewStatuses: {},
      });
      expect(result.map(i => i.id)).toEqual(['img-2', 'img-3', 'img-1']);
    });

    test('works with empty options', () => {
      const result = applyGalleryFilters(mockImages, {});
      expect(result).toHaveLength(3);
    });
  });
});
