import React, { useState, useRef, useEffect, useCallback } from 'react';

export default function MeasurementTool({
  containerSize,
  naturalSize,
  zoomLevel,
  calibration,
  onSaveMeasurement,
  onCancel,
  existingMeasurementCount
}) {
  const [drawingLine, setDrawingLine] = useState(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [measurementName, setMeasurementName] = useState('');
  const [isDrawing, setIsDrawing] = useState(false);
  const [validationError, setValidationError] = useState(null);
  const overlayRef = useRef(null);

  useEffect(() => {
    if (showSaveDialog) {
      const defaultName = `Measurement ${(existingMeasurementCount || 0) + 1}`;
      setMeasurementName(defaultName);
    }
  }, [showSaveDialog, existingMeasurementCount]);

  const getAdjustedCoordinates = (e) => {
    if (!overlayRef.current) return { x: 0, y: 0 };

    const rect = overlayRef.current.getBoundingClientRect();
    const x = (e.clientX - rect.left) / zoomLevel;
    const y = (e.clientY - rect.top) / zoomLevel;

    return { x, y };
  };

  const handleMouseDown = (e) => {
    if (showSaveDialog) return;

    const coords = getAdjustedCoordinates(e);
    setDrawingLine({
      x1: coords.x,
      y1: coords.y,
      x2: coords.x,
      y2: coords.y
    });
    setIsDrawing(true);
  };

  const handleMouseMove = (e) => {
    if (!isDrawing || !drawingLine) return;

    const coords = getAdjustedCoordinates(e);
    setDrawingLine(prev => ({
      ...prev,
      x2: coords.x,
      y2: coords.y
    }));
  };

  const handleMouseUp = (e) => {
    if (!isDrawing || !drawingLine) return;

    const coords = getAdjustedCoordinates(e);
    const finalLine = {
      ...drawingLine,
      x2: coords.x,
      y2: coords.y
    };

    const distance = calculateDistance(finalLine);
    if (distance < 5) {
      setDrawingLine(null);
      setIsDrawing(false);
      return;
    }

    setDrawingLine(finalLine);
    setIsDrawing(false);
    setShowSaveDialog(true);
  };

  const calculateDistance = (line) => {
    if (!line) return 0;
    return Math.sqrt(
      Math.pow(line.x2 - line.x1, 2) + Math.pow(line.y2 - line.y1, 2)
    );
  };

  const calculateRealWorldDistances = (line) => {
    const scaleX = naturalSize.width / containerSize.width;
    const scaleY = naturalSize.height / containerSize.height;

    const imageX1 = line.x1 * scaleX;
    const imageY1 = line.y1 * scaleY;
    const imageX2 = line.x2 * scaleX;
    const imageY2 = line.y2 * scaleY;

    const distancePixelsImage = Math.sqrt(
      Math.pow(imageX2 - imageX1, 2) + Math.pow(imageY2 - imageY1, 2)
    );

    if (!calibration) {
      return {
        pixels: distancePixelsImage,
        mm: null,
        inches: null
      };
    }

    const distanceMM = distancePixelsImage / calibration.pixels_per_mm;
    const distanceInches = distancePixelsImage / calibration.pixels_per_inch;

    return {
      pixels: distancePixelsImage,
      mm: distanceMM,
      inches: distanceInches
    };
  };

  const formatDistance = (line) => {
    const distances = calculateRealWorldDistances(line);

    if (!calibration) {
      return `${distances.pixels.toFixed(1)} px (no calibration)`;
    }

    return `${distances.mm.toFixed(2)} mm (${distances.inches.toFixed(3)}")`;
  };

  const handleSave = () => {
    if (!measurementName.trim()) {
      setValidationError('Please enter a name for this measurement');
      return;
    }
    setValidationError(null);

    const scaleX = naturalSize.width / containerSize.width;
    const scaleY = naturalSize.height / containerSize.height;

    const imageX1 = drawingLine.x1 * scaleX;
    const imageY1 = drawingLine.y1 * scaleY;
    const imageX2 = drawingLine.x2 * scaleX;
    const imageY2 = drawingLine.y2 * scaleY;

    const distances = calculateRealWorldDistances(drawingLine);

    const measurement = {
      id: crypto.randomUUID(),
      name: measurementName.trim(),
      x1: imageX1,
      y1: imageY1,
      x2: imageX2,
      y2: imageY2,
      distance_pixels: distances.pixels,
      distance_mm: distances.mm,
      distance_inches: distances.inches,
      created_at: new Date().toISOString()
    };

    if (onSaveMeasurement) {
      onSaveMeasurement(measurement);
    }

    setDrawingLine(null);
    setShowSaveDialog(false);
    setMeasurementName('');
  };

  const handleCancelSave = useCallback(() => {
    setDrawingLine(null);
    setShowSaveDialog(false);
    setMeasurementName('');
    setValidationError(null);
  }, []);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      if (showSaveDialog) {
        setDrawingLine(null);
        setShowSaveDialog(false);
        setMeasurementName('');
        setValidationError(null);
      } else if (onCancel) {
        onCancel();
      }
    }
  }, [showSaveDialog, onCancel]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!calibration) {
    return (
      <div style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        background: 'rgba(255, 255, 255, 0.95)',
        padding: '24px',
        borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        maxWidth: '400px',
        textAlign: 'center',
        zIndex: 2000
      }}>
        <h3 style={{ margin: '0 0 12px 0', color: '#dc2626' }}>No Calibration Set</h3>
        <p style={{ margin: '0 0 16px 0', color: '#6b7280' }}>
          Please set calibration in the Calibration section before using the measurement tool.
        </p>
        <button
          onClick={onCancel}
          style={{
            padding: '8px 16px',
            background: '#3b82f6',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
            fontSize: '14px'
          }}
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <>
      <div
        ref={overlayRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: containerSize.width,
          height: containerSize.height,
          transform: `scale(${zoomLevel})`,
          transformOrigin: 'top left',
          cursor: showSaveDialog ? 'default' : 'crosshair',
          zIndex: 1000,
          pointerEvents: 'auto'
        }}
      >
        <svg
          width={containerSize.width}
          height={containerSize.height}
          style={{ display: 'block' }}
        >
          {drawingLine && (
            <>
              <line
                x1={drawingLine.x1}
                y1={drawingLine.y1}
                x2={drawingLine.x2}
                y2={drawingLine.y2}
                stroke="#f59e0b"
                strokeWidth={3 / zoomLevel}
                strokeDasharray={`${5 / zoomLevel},${5 / zoomLevel}`}
              />
              <circle
                cx={drawingLine.x1}
                cy={drawingLine.y1}
                r={4 / zoomLevel}
                fill="#f59e0b"
                stroke="white"
                strokeWidth={1 / zoomLevel}
              />
              <circle
                cx={drawingLine.x2}
                cy={drawingLine.y2}
                r={4 / zoomLevel}
                fill="#f59e0b"
                stroke="white"
                strokeWidth={1 / zoomLevel}
              />
              <text
                x={(drawingLine.x1 + drawingLine.x2) / 2}
                y={(drawingLine.y1 + drawingLine.y2) / 2 - 10 / zoomLevel}
                fill="#f59e0b"
                fontSize={14 / zoomLevel}
                fontWeight="bold"
                textAnchor="middle"
                style={{
                  textShadow: '0 0 3px white, 0 0 3px white, 0 0 3px white'
                }}
              >
                {formatDistance(drawingLine)}
              </text>
            </>
          )}
        </svg>
      </div>

      {showSaveDialog && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          background: 'white',
          padding: '24px',
          borderRadius: '8px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
          minWidth: '350px',
          zIndex: 2000
        }}>
          <h3 style={{ margin: '0 0 16px 0', fontSize: '18px' }}>Save Measurement</h3>

          <div style={{ marginBottom: '16px' }}>
            <div style={{
              padding: '12px',
              background: '#f3f4f6',
              borderRadius: '4px',
              fontSize: '14px',
              color: '#374151'
            }}>
              {drawingLine && formatDistance(drawingLine)}
            </div>
          </div>

          <div style={{ marginBottom: '16px' }}>
            <label style={{
              display: 'block',
              fontSize: '13px',
              fontWeight: '500',
              marginBottom: '4px',
              color: '#374151'
            }}>
              Measurement Name
            </label>
            <input
              type="text"
              value={measurementName}
              onChange={(e) => {
                setMeasurementName(e.target.value);
                if (validationError) setValidationError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleSave();
                }
              }}
              placeholder="Enter name"
              autoFocus
              style={{
                width: '100%',
                padding: '8px',
                border: validationError ? '1px solid #dc2626' : '1px solid #d1d5db',
                borderRadius: '4px',
                fontSize: '14px'
              }}
            />
            {validationError && (
              <div style={{
                marginTop: '4px',
                fontSize: '12px',
                color: '#dc2626'
              }}>
                {validationError}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={handleSave}
              style={{
                flex: 1,
                padding: '10px',
                background: '#10b981',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: '500'
              }}
            >
              Save
            </button>
            <button
              onClick={handleCancelSave}
              style={{
                flex: 1,
                padding: '10px',
                background: 'white',
                color: '#6b7280',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '14px'
              }}
            >
              Cancel
            </button>
          </div>

          <div style={{
            marginTop: '12px',
            fontSize: '12px',
            color: '#9ca3af',
            textAlign: 'center'
          }}>
            Press Enter to save, Escape to cancel
          </div>
        </div>
      )}
    </>
  );
}
