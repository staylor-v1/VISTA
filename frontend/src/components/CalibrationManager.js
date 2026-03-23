import React, { useState, useEffect, useCallback, useMemo } from 'react';
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
  const [matchedRule, setMatchedRule] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editUnit, setEditUnit] = useState('mm');
  const [editPixelsPerUnit, setEditPixelsPerUnit] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  const imageMetadata = useMemo(() => image?.metadata || image?.metadata_ || {}, [image]);

  const loadCalibration = useCallback(async () => {
    setError(null);

    const metadata = imageMetadata;
    if (metadata?.calibration_override) {
      setCalibration(metadata.calibration_override);
      setIsImageOverride(true);
      setMatchedRule(null);
      if (onCalibrationChange) {
        onCalibrationChange(metadata.calibration_override);
      }
      return;
    }

    setIsImageOverride(false);

    try {
      const response = await fetch(`/api/projects/${projectId}/metadata-dict`);
      if (response.ok) {
        const data = await response.json();

        // Check metadata-based calibration rules (priority between image override and project default)
        const rules = Array.isArray(data.calibration_rules) ? data.calibration_rules : [];
        if (metadata && rules.length > 0) {
          for (const rule of rules) {
            if (
              rule.metadata_key &&
              rule.metadata_value !== undefined &&
              metadata[rule.metadata_key] !== undefined &&
              String(metadata[rule.metadata_key]) === String(rule.metadata_value)
            ) {
              setCalibration(rule.calibration);
              setIsImageOverride(false);
              setMatchedRule(rule);
              if (onCalibrationChange) {
                onCalibrationChange(rule.calibration);
              }
              return;
            }
          }
        }

        setMatchedRule(null);

        if (data.calibration_default) {
          setCalibration(data.calibration_default);
          if (onCalibrationChange) {
            onCalibrationChange(data.calibration_default);
          }
          return;
        }
      }
    } catch (err) {
      console.error('Error loading project calibration:', err);
    }

    setMatchedRule(null);
    setCalibration(null);
    if (onCalibrationChange) {
      onCalibrationChange(null);
    }
  }, [imageMetadata, projectId, onCalibrationChange]);

  useEffect(() => {
    loadCalibration();
  }, [loadCalibration]);

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
    if (validation) {
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
    if (validation) {
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
    if (!window.confirm('Clear image-specific calibration?')) {
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

      // Remove from local image object so loadCalibration does not short-circuit
      if (image?.metadata) delete image.metadata.calibration_override;
      if (image?.metadata_) delete image.metadata_.calibration_override;

      setMessage('Image calibration override cleared');
      setTimeout(() => setMessage(null), 3000);
      await loadCalibration();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveMetadataRule = async (metadataKey, metadataValue) => {
    const validation = validateCalibration(editPixelsPerUnit);
    if (validation) {
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
      const fetchResp = await fetch(`/api/projects/${projectId}/metadata-dict`);
      let existingRules = [];
      if (fetchResp.ok) {
        const data = await fetchResp.json();
        existingRules = Array.isArray(data.calibration_rules) ? data.calibration_rules : [];
      }

      const filteredRules = existingRules.filter(
        r => !(r.metadata_key === metadataKey && String(r.metadata_value) === String(metadataValue))
      );
      const newRules = [...filteredRules, {
        metadata_key: metadataKey,
        metadata_value: String(metadataValue),
        calibration: calibrationData
      }];

      const saveResp = await fetch(`/api/projects/${projectId}/metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'calibration_rules', value: newRules })
      });

      if (!saveResp.ok) {
        throw new Error(`Failed to save metadata rule: ${saveResp.statusText}`);
      }

      setIsEditing(false);
      setMessage(`Metadata calibration rule saved (${metadataKey} = ${metadataValue})`);
      setTimeout(() => setMessage(null), 3000);
      await loadCalibration();
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteMetadataRule = async () => {
    if (!matchedRule) return;
    if (!window.confirm(
      `Remove calibration rule for ${matchedRule.metadata_key} = ${matchedRule.metadata_value}?`
    )) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const fetchResp = await fetch(`/api/projects/${projectId}/metadata-dict`);
      let existingRules = [];
      if (fetchResp.ok) {
        const data = await fetchResp.json();
        existingRules = Array.isArray(data.calibration_rules) ? data.calibration_rules : [];
      }

      const updatedRules = existingRules.filter(
        r => !(r.metadata_key === matchedRule.metadata_key &&
               String(r.metadata_value) === String(matchedRule.metadata_value))
      );

      const saveResp = await fetch(`/api/projects/${projectId}/metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'calibration_rules', value: updatedRules })
      });

      if (!saveResp.ok) {
        throw new Error(`Failed to delete metadata rule: ${saveResp.statusText}`);
      }

      setMessage(`Metadata rule removed (${matchedRule.metadata_key} = ${matchedRule.metadata_value})`);
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
    const useInches = cal.unit === 'inches';
    const pxPerUnit = useInches ? cal.pixels_per_inch : cal.pixels_per_mm;
    const unitLabel = useInches ? 'inch' : 'mm';
    return (
      <div style={{ fontSize: '14px', color: '#4b5563' }}>
        <div>{pxPerUnit.toFixed(2)} px/{unitLabel}</div>
        <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>
          ({(1 / pxPerUnit).toFixed(4)} {unitLabel}/px)
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
                color: isImageOverride ? '#d97706' : matchedRule ? '#7c3aed' : '#059669',
                fontWeight: '500',
                marginBottom: '8px'
              }}>
                {isImageOverride
                  ? 'Using image-specific calibration'
                  : matchedRule
                    ? `Using metadata rule: ${matchedRule.metadata_key} = ${matchedRule.metadata_value}`
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
                  {isLoading ? 'Clearing...' : 'Clear Image Override'}
                </button>
              )}
              {matchedRule && !isImageOverride && (
                <button
                  onClick={handleDeleteMetadataRule}
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
                  {isLoading ? 'Removing...' : 'Remove Metadata Rule'}
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
          onSaveMetadataRule={handleSaveMetadataRule}
          imageMetadataKeys={Object.entries(imageMetadata)
            .filter(([key]) => key !== 'calibration_override')
            .map(([key, value]) => ({ key, value }))}
          onCancel={handleCancelEdit}
        />
      )}
    </div>
  );
}
