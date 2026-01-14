import React, { useState, useEffect } from 'react';
import CalibrationEditForm from './CalibrationEditForm';

const MM_PER_INCH = 25.4;

export default function CalibrationManager({
  projectId,
  imageId,
  image,
  onCalibrationChange
}) {
  const [calibration, setCalibration] = useState(null);
  const [isImageOverride, setIsImageOverride] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editUnit, setEditUnit] = useState('mm');
  const [editPixelsPerUnit, setEditPixelsPerUnit] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    loadCalibration();
  }, [imageId, image]);

  const loadCalibration = async () => {
    setError(null);

    const metadata = image?.metadata || image?.metadata_;
    if (metadata?.calibration_override) {
      setCalibration(metadata.calibration_override);
      setIsImageOverride(true);
      if (onCalibrationChange) {
        onCalibrationChange(metadata.calibration_override);
      }
      return;
    }

    setIsImageOverride(false);

    try {
      const response = await fetch(`/api/projects/${projectId}/metadata/calibration_default`);
      if (response.ok) {
        const data = await response.json();
        if (data.value) {
          setCalibration(data.value);
          if (onCalibrationChange) {
            onCalibrationChange(data.value);
          }
          return;
        }
      }
    } catch (err) {
      console.error('Error loading project calibration:', err);
    }

    setCalibration(null);
    if (onCalibrationChange) {
      onCalibrationChange(null);
    }
  };

  const handleStartEdit = () => {
    if (calibration) {
      setEditUnit(calibration.unit || 'mm');
      setEditPixelsPerUnit(
        calibration.unit === 'mm'
          ? calibration.pixels_per_mm.toString()
          : calibration.pixels_per_inch.toString()
      );
    } else {
      setEditUnit('mm');
      setEditPixelsPerUnit('');
    }
    setIsEditing(true);
    setError(null);
    setMessage(null);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setError(null);
    setMessage(null);
  };

  const validateCalibration = (value) => {
    const num = parseFloat(value);
    if (isNaN(num) || num <= 0) {
      return 'Calibration must be a positive number';
    }
    if (num < 0.1 || num > 10000) {
      return 'Warning: Calibration value seems unrealistic (expected between 0.1 and 10000 px/unit)';
    }
    return null;
  };

  const handleSaveProjectDefault = async () => {
    const validation = validateCalibration(editPixelsPerUnit);
    if (validation && validation.startsWith('Calibration must')) {
      setError(validation);
      return;
    }

    const pixelsPerUnit = parseFloat(editPixelsPerUnit);
    const pixels_per_mm = editUnit === 'mm' ? pixelsPerUnit : pixelsPerUnit / MM_PER_INCH;
    const pixels_per_inch = editUnit === 'inches' ? pixelsPerUnit : pixelsPerUnit * MM_PER_INCH;

    const calibrationData = {
      pixels_per_mm,
      pixels_per_inch,
      unit: editUnit,
      updated_at: new Date().toISOString()
    };

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/projects/${projectId}/metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'calibration_default',
          value: calibrationData
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to save project calibration: ${response.statusText}`);
      }

      setCalibration(calibrationData);
      setIsImageOverride(false);
      setIsEditing(false);
      setMessage('Project calibration saved successfully');
      setTimeout(() => setMessage(null), 3000);

      if (onCalibrationChange) {
        onCalibrationChange(calibrationData);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveImageOverride = async () => {
    const validation = validateCalibration(editPixelsPerUnit);
    if (validation && validation.startsWith('Calibration must')) {
      setError(validation);
      return;
    }

    const pixelsPerUnit = parseFloat(editPixelsPerUnit);
    const pixels_per_mm = editUnit === 'mm' ? pixelsPerUnit : pixelsPerUnit / MM_PER_INCH;
    const pixels_per_inch = editUnit === 'inches' ? pixelsPerUnit : pixelsPerUnit * MM_PER_INCH;

    const calibrationData = {
      pixels_per_mm,
      pixels_per_inch,
      unit: editUnit,
      updated_at: new Date().toISOString()
    };

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/images/${imageId}/metadata`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'calibration_override',
          value: calibrationData
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to save image calibration: ${response.statusText}`);
      }

      setCalibration(calibrationData);
      setIsImageOverride(true);
      setIsEditing(false);
      setMessage('Image-specific calibration saved successfully');
      setTimeout(() => setMessage(null), 3000);

      if (onCalibrationChange) {
        onCalibrationChange(calibrationData);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearOverride = async () => {
    if (!window.confirm('Clear image-specific calibration and revert to project default?')) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(`/api/images/${imageId}/metadata/calibration_override`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(`Failed to clear override: ${response.statusText}`);
      }

      setMessage('Reverted to project default calibration');
      setTimeout(() => setMessage(null), 3000);
      await loadCalibration();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const formatCalibration = (cal) => {
    if (!cal) return null;
    return (
      <div style={{ fontSize: '14px', color: '#4b5563' }}>
        <div>{cal.pixels_per_mm.toFixed(2)} px/mm</div>
        <div>{cal.pixels_per_inch.toFixed(2)} px/inch</div>
        <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
          ({(1 / cal.pixels_per_mm).toFixed(4)} mm/px)
        </div>
      </div>
    );
  };

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
        <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600' }}>Calibration</h3>
        {!isEditing && calibration && (
          <button
            onClick={handleStartEdit}
            style={{
              padding: '4px 8px',
              fontSize: '12px',
              background: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Edit
          </button>
        )}
      </div>

      {message && (
        <div style={{
          padding: '8px',
          marginBottom: '12px',
          background: '#d1fae5',
          color: '#065f46',
          borderRadius: '4px',
          fontSize: '13px'
        }}>
          {message}
        </div>
      )}

      {error && (
        <div style={{
          padding: '8px',
          marginBottom: '12px',
          background: '#fee2e2',
          color: '#991b1b',
          borderRadius: '4px',
          fontSize: '13px'
        }}>
          {error}
        </div>
      )}

      {!isEditing ? (
        <div>
          {calibration ? (
            <div>
              <div style={{
                padding: '8px',
                background: 'white',
                borderRadius: '4px',
                marginBottom: '8px'
              }}>
                {formatCalibration(calibration)}
              </div>
              <div style={{
                fontSize: '12px',
                color: isImageOverride ? '#d97706' : '#059669',
                fontWeight: '500',
                marginBottom: '8px'
              }}>
                {isImageOverride
                  ? 'Using image-specific calibration'
                  : 'Using project default calibration'}
              </div>
              {isImageOverride && (
                <button
                  onClick={handleClearOverride}
                  disabled={isLoading}
                  style={{
                    padding: '6px 12px',
                    fontSize: '13px',
                    background: 'white',
                    color: '#dc2626',
                    border: '1px solid #dc2626',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    width: '100%'
                  }}
                >
                  {isLoading ? 'Clearing...' : 'Revert to Project Default'}
                </button>
              )}
            </div>
          ) : (
            <div>
              <div style={{
                padding: '12px',
                background: '#fef3c7',
                color: '#92400e',
                borderRadius: '4px',
                fontSize: '13px',
                marginBottom: '12px'
              }}>
                No calibration set. Set calibration to enable measurements.
              </div>
              <button
                onClick={handleStartEdit}
                style={{
                  padding: '8px 12px',
                  fontSize: '14px',
                  background: '#3b82f6',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  width: '100%'
                }}
              >
                Set Calibration
              </button>
            </div>
          )}
        </div>
      ) : (
        <CalibrationEditForm
          editUnit={editUnit}
          setEditUnit={setEditUnit}
          editPixelsPerUnit={editPixelsPerUnit}
          setEditPixelsPerUnit={setEditPixelsPerUnit}
          isLoading={isLoading}
          onSaveProjectDefault={handleSaveProjectDefault}
          onSaveImageOverride={handleSaveImageOverride}
          onCancel={handleCancelEdit}
        />
      )}
    </div>
  );
}
