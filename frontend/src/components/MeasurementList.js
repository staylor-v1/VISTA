import React, { useState } from 'react';

export default function MeasurementList({
  measurements,
  calibration,
  onDeleteMeasurement,
  onRenameMeasurement,
  onToggleVisibility,
  visibleMeasurementIds,
  selectedMeasurementId,
  onSelectMeasurement
}) {
  const [editingId, setEditingId] = useState(null);
  const [editingName, setEditingName] = useState('');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [expandedId, setExpandedId] = useState(null);

  const handleStartRename = (measurement) => {
    setEditingId(measurement.id);
    setEditingName(measurement.name);
  };

  const handleSaveRename = () => {
    if (editingName.trim() && onRenameMeasurement) {
      onRenameMeasurement(editingId, editingName.trim());
    }
    setEditingId(null);
    setEditingName('');
  };

  const handleCancelRename = () => {
    setEditingId(null);
    setEditingName('');
  };

  const handleDelete = (e, measurementId, measurementName) => {
    e.stopPropagation();
    if (window.confirm(`Delete measurement "${measurementName}"?`)) {
      if (onDeleteMeasurement) {
        onDeleteMeasurement(measurementId);
      }
    }
  };

  const handleExportCSV = () => {
    if (!measurements || measurements.length === 0) return;

    const headers = ['Name', 'Distance (pixels)', 'Distance (mm)', 'Distance (inches)', 'Created At'];
    const rows = measurements.map(m => [
      m.name,
      m.distance_pixels?.toFixed(2) || '',
      m.distance_mm?.toFixed(4) || '',
      m.distance_inches?.toFixed(6) || '',
      m.created_at || ''
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(row => row.map(cell => `"${cell}"`).join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `measurements-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const formatDistance = (measurement) => {
    if (!calibration || measurement.distance_mm === null) {
      return `${measurement.distance_pixels.toFixed(1)} px`;
    }
    return (
      <div>
        <div>{measurement.distance_mm.toFixed(2)} mm</div>
        <div style={{ fontSize: '11px', color: '#9ca3af' }}>
          {measurement.distance_inches.toFixed(3)}"
        </div>
      </div>
    );
  };

  const isVisible = (id) => {
    if (!visibleMeasurementIds) return true;
    return visibleMeasurementIds.includes(id);
  };

  const toggleExpanded = (id) => {
    setExpandedId(expandedId === id ? null : id);
  };

  if (!measurements || measurements.length === 0) {
    return (
      <div style={{
        padding: '16px',
        borderBottom: '1px solid #e5e7eb',
        background: '#f9fafb'
      }}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: '16px', fontWeight: '600' }}>
          Measurements
        </h3>
        <div style={{
          padding: '12px',
          background: 'white',
          borderRadius: '4px',
          fontSize: '13px',
          color: '#6b7280',
          textAlign: 'center'
        }}>
          No measurements yet. Click "Measure" to start.
        </div>
      </div>
    );
  }

  return (
    <div style={{
      padding: '16px',
      borderBottom: '1px solid #e5e7eb',
      background: '#f9fafb'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '12px'
      }}>
        <h3
          style={{
            margin: 0,
            fontSize: '16px',
            fontWeight: '600',
            cursor: 'pointer',
            userSelect: 'none'
          }}
          onClick={() => setIsCollapsed(!isCollapsed)}
        >
          Measurements ({measurements.length}) {isCollapsed ? '+' : '-'}
        </h3>
        <button
          onClick={handleExportCSV}
          style={{
            padding: '4px 8px',
            fontSize: '12px',
            background: '#10b981',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer'
          }}
        >
          Export CSV
        </button>
      </div>

      {!isCollapsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {measurements.map((measurement) => (
            <div
              key={measurement.id}
              style={{
                padding: '12px',
                background: selectedMeasurementId === measurement.id ? '#eff6ff' : 'white',
                borderRadius: '4px',
                border: selectedMeasurementId === measurement.id ? '2px solid #3b82f6' : '1px solid #e5e7eb'
              }}
              onMouseEnter={() => onSelectMeasurement && onSelectMeasurement(measurement.id)}
              onMouseLeave={() => onSelectMeasurement && onSelectMeasurement(null)}
            >
              {editingId === measurement.id ? (
                <div>
                  <input
                    type="text"
                    value={editingName}
                    onChange={(e) => setEditingName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveRename();
                      if (e.key === 'Escape') handleCancelRename();
                    }}
                    autoFocus
                    style={{
                      width: '100%',
                      padding: '6px',
                      border: '1px solid #d1d5db',
                      borderRadius: '4px',
                      fontSize: '13px',
                      marginBottom: '8px'
                    }}
                  />
                  <div style={{ display: 'flex', gap: '4px' }}>
                    <button
                      onClick={handleSaveRename}
                      style={{
                        flex: 1,
                        padding: '4px',
                        fontSize: '12px',
                        background: '#10b981',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      Save
                    </button>
                    <button
                      onClick={handleCancelRename}
                      style={{
                        flex: 1,
                        padding: '4px',
                        fontSize: '12px',
                        background: 'white',
                        color: '#6b7280',
                        border: '1px solid #d1d5db',
                        borderRadius: '4px',
                        cursor: 'pointer'
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div>
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'flex-start',
                    marginBottom: '8px'
                  }}>
                    <div
                      style={{
                        fontSize: '14px',
                        fontWeight: '500',
                        color: '#1f2937',
                        cursor: 'pointer',
                        flex: 1
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleStartRename(measurement);
                      }}
                    >
                      {measurement.name}
                    </div>
                    <div style={{ display: 'flex', gap: '4px' }}>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleVisibility && onToggleVisibility(measurement.id);
                        }}
                        style={{
                          padding: '2px 6px',
                          fontSize: '11px',
                          background: 'transparent',
                          color: isVisible(measurement.id) ? '#3b82f6' : '#9ca3af',
                          border: 'none',
                          cursor: 'pointer'
                        }}
                        title={isVisible(measurement.id) ? 'Hide' : 'Show'}
                      >
                        {isVisible(measurement.id) ? '●' : '○'}
                      </button>
                      <button
                        onClick={(e) => handleDelete(e, measurement.id, measurement.name)}
                        style={{
                          padding: '2px 6px',
                          fontSize: '11px',
                          background: 'transparent',
                          color: '#dc2626',
                          border: 'none',
                          cursor: 'pointer'
                        }}
                        title="Delete"
                      >
                        ×
                      </button>
                    </div>
                  </div>

                  <div
                    style={{
                      padding: '8px',
                      background: '#f3f4f6',
                      borderRadius: '4px',
                      fontSize: '13px',
                      color: '#374151',
                      cursor: 'pointer'
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpanded(measurement.id);
                    }}
                  >
                    {formatDistance(measurement)}
                  </div>

                  {expandedId === measurement.id && (
                    <div style={{
                      marginTop: '8px',
                      padding: '8px',
                      background: '#eff6ff',
                      borderRadius: '4px',
                      fontSize: '12px',
                      color: '#1f2937',
                      borderLeft: '3px solid #3b82f6'
                    }}>
                      <div style={{ fontWeight: '600', marginBottom: '8px' }}>Measurement Details</div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#6b7280' }}>Start Point:</span>
                          <span style={{ fontFamily: 'monospace' }}>
                            ({measurement.x1?.toFixed(0)}, {measurement.y1?.toFixed(0)})
                          </span>
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#6b7280' }}>End Point:</span>
                          <span style={{ fontFamily: 'monospace' }}>
                            ({measurement.x2?.toFixed(0)}, {measurement.y2?.toFixed(0)})
                          </span>
                        </div>

                        <div style={{ height: '1px', background: '#cbd5e1', margin: '4px 0' }} />

                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: '#6b7280' }}>Distance (pixels):</span>
                          <span style={{ fontFamily: 'monospace' }}>
                            {measurement.distance_pixels?.toFixed(2)} px
                          </span>
                        </div>

                        {calibration && (
                          <>
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ color: '#6b7280' }}>Distance (mm):</span>
                              <span style={{ fontFamily: 'monospace' }}>
                                {measurement.distance_mm?.toFixed(4)} mm
                              </span>
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ color: '#6b7280' }}>Distance (inches):</span>
                              <span style={{ fontFamily: 'monospace' }}>
                                {measurement.distance_inches?.toFixed(6)}"
                              </span>
                            </div>
                          </>
                        )}

                        {measurement.created_at && (
                          <>
                            <div style={{ height: '1px', background: '#cbd5e1', margin: '4px 0' }} />
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ color: '#6b7280' }}>Created:</span>
                              <span style={{ fontSize: '11px' }}>
                                {new Date(measurement.created_at).toLocaleString()}
                              </span>
                            </div>
                          </>
                        )}

                        {measurement.created_by && (
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#6b7280' }}>Created By:</span>
                            <span style={{ fontSize: '11px' }}>
                              {measurement.created_by}
                            </span>
                          </div>
                        )}
                      </div>

                      <div style={{
                        marginTop: '8px',
                        fontSize: '11px',
                        color: '#6b7280',
                        fontStyle: 'italic',
                        textAlign: 'center'
                      }}>
                        Click again to collapse
                      </div>
                    </div>
                  )}

                  {!expandedId && measurement.created_at && (
                    <div style={{
                      marginTop: '4px',
                      fontSize: '11px',
                      color: '#9ca3af'
                    }}>
                      {new Date(measurement.created_at).toLocaleString()}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
