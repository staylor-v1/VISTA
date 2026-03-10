import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

function GroupThumbnail({ groupId }) {
  const [thumbnailUrl, setThumbnailUrl] = useState(null);

  useEffect(() => {
    fetch(`/api/groups/${groupId}/thumbnail`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data && data.url) setThumbnailUrl(data.url);
      })
      .catch(() => {});
  }, [groupId]);

  if (!thumbnailUrl) {
    return (
      <div className="group-thumbnail group-thumbnail-empty">
        <span className="group-thumbnail-icon">+</span>
      </div>
    );
  }
  return (
    <img
      src={thumbnailUrl}
      alt="group thumbnail"
      className="group-thumbnail group-thumbnail-img"
      onError={() => setThumbnailUrl(null)}
    />
  );
}

function GroupedImagesPage({ projectId, projectName, onBack }) {
  const navigate = useNavigate();
  const [groups, setGroups] = useState([]);
  const [total, setTotal] = useState(0);
  const [ungroupedCount, setUngroupedCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const fetchGroups = useCallback(async (searchVal) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (searchVal) params.set('search', searchVal);
      const resp = await fetch(`/api/projects/${projectId}/groups?${params}`);
      if (!resp.ok) throw new Error(`HTTP error ${resp.status}`);
      const data = await resp.json();
      setGroups(data.groups || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const fetchUngroupedCount = useCallback(async () => {
    try {
      const countResp = await fetch(`/api/projects/${projectId}/ungrouped-count`);
      if (countResp.ok) {
        const data = await countResp.json();
        setUngroupedCount(data.count || 0);
      }
    } catch (_) {}
  }, [projectId]);

  useEffect(() => {
    fetchGroups(debouncedSearch);
    fetchUngroupedCount();
  }, [debouncedSearch, fetchGroups, fetchUngroupedCount]);

  const handleGroupClick = (group) => {
    navigate(`/project/${projectId}/group/${group.id}`, {
      state: { groupIdentifier: group.identifier, groupId: group.id },
    });
  };

  const handleUngroupedClick = () => {
    navigate(`/project/${projectId}/ungrouped`);
  };

  const statusLabel = (status) => {
    if (!status) return null;
    const map = {
      reject_confirmed: 'Rejected',
      reject_pending: 'Reject Pending',
      pass: 'Pass',
    };
    return map[status] || status;
  };

  return (
    <div className="grouped-images-page">
      <div className="grouped-images-header">
        <div className="grouped-images-search">
          <input
            type="text"
            className="search-input"
            placeholder="Search groups..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="grouped-images-stats">
          {!loading && (
            <span className="grouped-images-count">
              {total} {total === 1 ? 'group' : 'groups'}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="alert alert-error">
          <strong>Error:</strong> {error}
        </div>
      )}

      {loading ? (
        <div className="gallery-loading">
          <div className="spinner"></div>
          <p>Loading groups...</p>
        </div>
      ) : (
        <div className="group-grid">
          {groups.map((group) => (
            <div
              key={group.id}
              className="group-card"
              onClick={() => handleGroupClick(group)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && handleGroupClick(group)}
            >
              <div className="group-card-thumbnail">
                <GroupThumbnail groupId={group.id} />
              </div>
              <div className="group-card-body">
                <div className="group-card-title">
                  {group.display_name || group.identifier}
                </div>
                {group.display_name && group.display_name !== group.identifier && (
                  <div className="group-card-identifier">{group.identifier}</div>
                )}
                <div className="group-card-meta">
                  <span className="group-card-count">
                    {group.image_count} {group.image_count === 1 ? 'image' : 'images'}
                  </span>
                  {group.aggregate_review_status && (
                    <span className={`group-status-badge group-status-${group.aggregate_review_status}`}>
                      {statusLabel(group.aggregate_review_status)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}

          {/* Ungrouped virtual entry */}
          {ungroupedCount > 0 && (
            <div
              className="group-card group-card-ungrouped"
              onClick={handleUngroupedClick}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => e.key === 'Enter' && handleUngroupedClick()}
            >
              <div className="group-card-thumbnail">
                <div className="group-thumbnail group-thumbnail-empty">
                  <span className="group-thumbnail-icon">?</span>
                </div>
              </div>
              <div className="group-card-body">
                <div className="group-card-title">Ungrouped</div>
                <div className="group-card-meta">
                  <span className="group-card-count">
                    {ungroupedCount} {ungroupedCount === 1 ? 'image' : 'images'}
                  </span>
                </div>
              </div>
            </div>
          )}

          {groups.length === 0 && ungroupedCount === 0 && (
            <div className="gallery-empty">
              <div className="empty-icon">+</div>
              <h3>No groups yet</h3>
              <p>Upload images with a group identifier to create groups.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default GroupedImagesPage;
