/**
 * Shared gallery filter, sort, and state persistence utilities.
 *
 * Used by ImageGallery (to persist/restore controls) and ImageView (to apply
 * the same filter/sort when building the prev/next navigation list).
 */

const STORAGE_PREFIX = 'gallery_state_';

/**
 * Load saved gallery state from localStorage for a given key.
 * Returns an empty object on missing or corrupt data.
 */
function loadGalleryState(key) {
  try {
    const stored = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
    return stored ? JSON.parse(stored) : {};
  } catch (e) {
    return {};
  }
}

/**
 * Persist gallery state to localStorage under the given key.
 */
function saveGalleryState(key, state) {
  localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(state));
}

/**
 * Return true if a search term matches the image according to the field.
 */
function imageMatchesSearch(image, searchField, searchLower) {
  switch (searchField) {
    case 'filename':
      return (image.filename || '').toLowerCase().includes(searchLower);
    case 'content_type':
      return (image.content_type || '').toLowerCase().includes(searchLower);
    case 'uploaded_by':
      return (image.uploaded_by_user_id || '').toLowerCase().includes(searchLower);
    case 'metadata': {
      const meta = image.metadata || image.metadata_;
      if (!meta) return false;
      return Object.values(meta).some(v =>
        String(v).toLowerCase().includes(searchLower)
      );
    }
    default: {
      const meta = image.metadata || image.metadata_;
      if (!meta || !meta[searchField]) return false;
      return String(meta[searchField]).toLowerCase().includes(searchLower);
    }
  }
}

/**
 * Filter an array of images by search field/value.
 * Returns the original array when there is nothing to filter.
 */
function filterBySearch(images, searchField, searchValue) {
  if (!searchValue || !searchField) return images;
  const searchLower = searchValue.toLowerCase();
  return images.filter(img => imageMatchesSearch(img, searchField, searchLower));
}

/**
 * Filter images by review status using a pre-fetched status map.
 * `reviewStatuses` is an object mapping image id -> status string.
 */
function filterByReviewStatus(images, reviewFilter, reviewStatuses) {
  if (!reviewFilter || reviewFilter === 'all') return images;
  return images.filter(img => {
    const status = (reviewStatuses && reviewStatuses[img.id]) || 'unreviewed';
    return status === reviewFilter;
  });
}

/**
 * Sort a copy of the images array by the given sort key.
 */
function sortImages(images, sortBy) {
  return [...images].sort((a, b) => {
    switch (sortBy) {
      case 'name':
        return (a.filename || '').localeCompare(b.filename || '');
      case 'size':
        return (b.size_bytes || 0) - (a.size_bytes || 0);
      case 'date':
      default:
        return new Date(b.created_at || 0) - new Date(a.created_at || 0);
    }
  });
}

/**
 * Apply the full filter-then-sort pipeline in one call.
 * `reviewStatuses` may be null/undefined when no review filter is active.
 */
function applyGalleryFilters(images, { searchField, searchValue, reviewFilter, sortBy, reviewStatuses }) {
  let result = filterBySearch(images, searchField, searchValue);
  result = filterByReviewStatus(result, reviewFilter, reviewStatuses);
  result = sortImages(result, sortBy || 'date');
  return result;
}

export {
  loadGalleryState,
  saveGalleryState,
  filterBySearch,
  filterByReviewStatus,
  sortImages,
  applyGalleryFilters,
};
