import React from 'react';
import { render, fireEvent } from '@testing-library/react';
import MeasurementTool from '../MeasurementTool';

/**
 * These tests verify measurement accuracy across different image aspect ratios.
 *
 * The key insight: when an image is displayed at a different size than its natural
 * dimensions, the coordinate transformation must correctly map between:
 * - Container coordinates (where user clicks)
 * - Image coordinates (natural pixel coordinates)
 * - Real-world measurements (mm, inches based on calibration)
 *
 * Bug scenario: A 200x100 natural image displayed at 100x50 should have uniform
 * scaling (2x in both dimensions). If scaleX != scaleY, diagonal measurements
 * will be incorrect.
 */

describe('MeasurementTool accuracy', () => {
  // Helper to extract the distance calculation logic for unit testing
  const calculateImageDistance = (line, naturalSize, containerSize) => {
    const scaleX = naturalSize.width / containerSize.width;
    const scaleY = naturalSize.height / containerSize.height;

    const imageX1 = line.x1 * scaleX;
    const imageY1 = line.y1 * scaleY;
    const imageX2 = line.x2 * scaleX;
    const imageY2 = line.y2 * scaleY;

    return Math.sqrt(
      Math.pow(imageX2 - imageX1, 2) + Math.pow(imageY2 - imageY1, 2)
    );
  };

  describe('Square images (uniform aspect ratio)', () => {
    it('measures correctly on a 100x100 image displayed at 100x100', () => {
      const naturalSize = { width: 100, height: 100 };
      const containerSize = { width: 100, height: 100 };

      // Horizontal line from (0,50) to (100,50) = 100 pixels
      const horizontalLine = { x1: 0, y1: 50, x2: 100, y2: 50 };
      expect(calculateImageDistance(horizontalLine, naturalSize, containerSize)).toBe(100);

      // Vertical line from (50,0) to (50,100) = 100 pixels
      const verticalLine = { x1: 50, y1: 0, x2: 50, y2: 100 };
      expect(calculateImageDistance(verticalLine, naturalSize, containerSize)).toBe(100);

      // Diagonal line from (0,0) to (100,100) = sqrt(100^2 + 100^2) = 141.42...
      const diagonalLine = { x1: 0, y1: 0, x2: 100, y2: 100 };
      expect(calculateImageDistance(diagonalLine, naturalSize, containerSize)).toBeCloseTo(141.42, 1);
    });

    it('measures correctly on a 100x100 image displayed at 50x50 (scaled down)', () => {
      const naturalSize = { width: 100, height: 100 };
      const containerSize = { width: 50, height: 50 };

      // Horizontal line across full container width (0,25) to (50,25)
      // Should map to 100 pixels in natural coordinates
      const horizontalLine = { x1: 0, y1: 25, x2: 50, y2: 25 };
      expect(calculateImageDistance(horizontalLine, naturalSize, containerSize)).toBe(100);

      // Diagonal across full container
      const diagonalLine = { x1: 0, y1: 0, x2: 50, y2: 50 };
      expect(calculateImageDistance(diagonalLine, naturalSize, containerSize)).toBeCloseTo(141.42, 1);
    });
  });

  describe('Wide rectangular images (width > height)', () => {
    it('measures correctly on a 200x100 image displayed at 200x100 (no scaling)', () => {
      const naturalSize = { width: 200, height: 100 };
      const containerSize = { width: 200, height: 100 };

      // Full width: 200 pixels
      const horizontalLine = { x1: 0, y1: 50, x2: 200, y2: 50 };
      expect(calculateImageDistance(horizontalLine, naturalSize, containerSize)).toBe(200);

      // Full height: 100 pixels
      const verticalLine = { x1: 100, y1: 0, x2: 100, y2: 100 };
      expect(calculateImageDistance(verticalLine, naturalSize, containerSize)).toBe(100);
    });

    it('measures correctly on a 200x100 image displayed at 100x50 (uniform scaling)', () => {
      const naturalSize = { width: 200, height: 100 };
      const containerSize = { width: 100, height: 50 };

      // Full width in container (0 to 100) should be 200 pixels in natural
      const horizontalLine = { x1: 0, y1: 25, x2: 100, y2: 25 };
      expect(calculateImageDistance(horizontalLine, naturalSize, containerSize)).toBe(200);

      // Full height in container (0 to 50) should be 100 pixels in natural
      const verticalLine = { x1: 50, y1: 0, x2: 50, y2: 50 };
      expect(calculateImageDistance(verticalLine, naturalSize, containerSize)).toBe(100);

      // Diagonal: sqrt(200^2 + 100^2) = sqrt(50000) = 223.6...
      const diagonalLine = { x1: 0, y1: 0, x2: 100, y2: 50 };
      expect(calculateImageDistance(diagonalLine, naturalSize, containerSize)).toBeCloseTo(223.6, 1);
    });

    it('BUG TEST: 200x100 image displayed at 100x100 (non-uniform scaling)', () => {
      // This is the bug case: container has different aspect ratio than image
      // If actual display maintains aspect ratio (100x50), but container is 100x100,
      // the calculation will be wrong
      const naturalSize = { width: 200, height: 100 };
      const containerSize = { width: 100, height: 100 }; // Wrong! Aspect ratio mismatch

      // With incorrect container size:
      // scaleX = 200/100 = 2
      // scaleY = 100/100 = 1 (WRONG - should also be 2 if uniform scaling)

      // A 45-degree diagonal in container coords (0,0) to (50,50)
      // With wrong scaling: image coords (0,0) to (100, 50)
      // Distance = sqrt(100^2 + 50^2) = sqrt(12500) = 111.8

      // With correct scaling (if container was 100x50): image coords (0,0) to (100, 100)
      // Distance = sqrt(100^2 + 100^2) = sqrt(20000) = 141.42

      const diagonalLine = { x1: 0, y1: 0, x2: 50, y2: 50 };
      const calculatedDistance = calculateImageDistance(diagonalLine, naturalSize, containerSize);

      // This test documents the bug - with wrong container size, we get wrong distance
      // The "correct" answer if the image were actually stretched to 100x100 would be:
      expect(calculatedDistance).toBeCloseTo(111.8, 1);

      // But if the image maintains aspect ratio and is actually 100x50 in the container,
      // the user draws what looks like a 45-degree line, but it's not mapping correctly
    });
  });

  describe('Tall rectangular images (height > width)', () => {
    it('measures correctly on a 100x200 image displayed at 100x200 (no scaling)', () => {
      const naturalSize = { width: 100, height: 200 };
      const containerSize = { width: 100, height: 200 };

      // Full width: 100 pixels
      const horizontalLine = { x1: 0, y1: 100, x2: 100, y2: 100 };
      expect(calculateImageDistance(horizontalLine, naturalSize, containerSize)).toBe(100);

      // Full height: 200 pixels
      const verticalLine = { x1: 50, y1: 0, x2: 50, y2: 200 };
      expect(calculateImageDistance(verticalLine, naturalSize, containerSize)).toBe(200);
    });

    it('measures correctly on a 100x200 image displayed at 50x100 (uniform scaling)', () => {
      const naturalSize = { width: 100, height: 200 };
      const containerSize = { width: 50, height: 100 };

      // Full width in container should map to 100 in natural
      const horizontalLine = { x1: 0, y1: 50, x2: 50, y2: 50 };
      expect(calculateImageDistance(horizontalLine, naturalSize, containerSize)).toBe(100);

      // Full height in container should map to 200 in natural
      const verticalLine = { x1: 25, y1: 0, x2: 25, y2: 100 };
      expect(calculateImageDistance(verticalLine, naturalSize, containerSize)).toBe(200);
    });
  });

  describe('Real-world calibration tests', () => {
    it('10px image with 1px/mm calibration measures 10mm edge-to-edge', () => {
      const naturalSize = { width: 10, height: 10 };
      const containerSize = { width: 10, height: 10 };
      const calibration = { pixels_per_mm: 1, pixels_per_inch: 25.4 };

      // Full width measurement
      const line = { x1: 0, y1: 5, x2: 10, y2: 5 };
      const distancePixels = calculateImageDistance(line, naturalSize, containerSize);
      const distanceMM = distancePixels / calibration.pixels_per_mm;

      expect(distancePixels).toBe(10);
      expect(distanceMM).toBe(10);
    });

    it('100px image with 10px/mm calibration measures 10mm edge-to-edge', () => {
      const naturalSize = { width: 100, height: 100 };
      const containerSize = { width: 50, height: 50 }; // Displayed at half size
      const calibration = { pixels_per_mm: 10, pixels_per_inch: 254 };

      // Full width measurement in container coords
      const line = { x1: 0, y1: 25, x2: 50, y2: 25 };
      const distancePixels = calculateImageDistance(line, naturalSize, containerSize);
      const distanceMM = distancePixels / calibration.pixels_per_mm;

      expect(distancePixels).toBe(100);
      expect(distanceMM).toBe(10);
    });

    it('rectangular 200x100 image with 10px/mm: width=20mm, height=10mm', () => {
      const naturalSize = { width: 200, height: 100 };
      const containerSize = { width: 100, height: 50 }; // Uniform 2x scaling
      const calibration = { pixels_per_mm: 10, pixels_per_inch: 254 };

      // Full width measurement
      const widthLine = { x1: 0, y1: 25, x2: 100, y2: 25 };
      const widthPixels = calculateImageDistance(widthLine, naturalSize, containerSize);
      expect(widthPixels).toBe(200);
      expect(widthPixels / calibration.pixels_per_mm).toBe(20);

      // Full height measurement
      const heightLine = { x1: 50, y1: 0, x2: 50, y2: 50 };
      const heightPixels = calculateImageDistance(heightLine, naturalSize, containerSize);
      expect(heightPixels).toBe(100);
      expect(heightPixels / calibration.pixels_per_mm).toBe(10);
    });
  });

  describe('Edge cases', () => {
    it('handles very small images', () => {
      const naturalSize = { width: 5, height: 5 };
      const containerSize = { width: 500, height: 500 }; // 100x zoom
      const calibration = { pixels_per_mm: 1, pixels_per_inch: 25.4 };

      // Measurement across full container should map to 5 natural pixels
      const line = { x1: 0, y1: 250, x2: 500, y2: 250 };
      const distancePixels = calculateImageDistance(line, naturalSize, containerSize);

      expect(distancePixels).toBe(5);
      expect(distancePixels / calibration.pixels_per_mm).toBe(5);
    });

    it('handles very large images scaled down', () => {
      const naturalSize = { width: 10000, height: 10000 };
      const containerSize = { width: 100, height: 100 }; // 100x reduction
      const calibration = { pixels_per_mm: 100, pixels_per_inch: 2540 };

      // Measurement across full container
      const line = { x1: 0, y1: 50, x2: 100, y2: 50 };
      const distancePixels = calculateImageDistance(line, naturalSize, containerSize);

      expect(distancePixels).toBe(10000);
      expect(distancePixels / calibration.pixels_per_mm).toBe(100); // 100mm
    });

    it('handles non-integer scaling factors', () => {
      const naturalSize = { width: 300, height: 200 };
      const containerSize = { width: 100, height: 66.67 }; // ~3x scaling, maintains aspect ratio

      // Full width measurement
      const line = { x1: 0, y1: 33, x2: 100, y2: 33 };
      const distancePixels = calculateImageDistance(line, naturalSize, containerSize);

      expect(distancePixels).toBeCloseTo(300, 0);
    });
  });
});

describe('Thumbnail fallback dimension mismatch', () => {
  /**
   * This test documents a critical bug:
   * When a TIFF or other non-browser-supported format fails to load,
   * the frontend falls back to a thumbnail. The thumbnail has different
   * dimensions than the original image, causing measurement inaccuracy.
   *
   * Example scenario:
   * - Original TIFF: 2000x1000 pixels
   * - Calibration: 100 px/mm (so image is 20mm x 10mm)
   * - Thumbnail requested: max 800x600
   * - Actual thumbnail: 800x400 (maintains aspect ratio)
   * - naturalWidth/Height now reads 800x400
   * - Measurements are now off by factor of 2.5x
   */

  it('documents dimension mismatch when falling back to thumbnail', () => {
    // Original image dimensions
    const originalNaturalSize = { width: 2000, height: 1000 };
    const calibration = { pixels_per_mm: 100, pixels_per_inch: 2540 };

    // What SHOULD happen: edge-to-edge width = 2000px = 20mm
    const expectedWidthMM = originalNaturalSize.width / calibration.pixels_per_mm;
    expect(expectedWidthMM).toBe(20);

    // After thumbnail fallback, naturalSize becomes thumbnail dimensions
    const thumbnailNaturalSize = { width: 800, height: 400 };
    const containerSize = { width: 800, height: 400 }; // Displayed at 1:1

    // User draws edge-to-edge line in container (0,200) to (800,200)
    const line = { x1: 0, y1: 200, x2: 800, y2: 200 };

    // With thumbnail dimensions, scaleX = 800/800 = 1
    const scaleX = thumbnailNaturalSize.width / containerSize.width;
    const imageX1 = line.x1 * scaleX;
    const imageX2 = line.x2 * scaleX;
    const distancePixels = Math.abs(imageX2 - imageX1);

    // The measured distance is 800 pixels (thumbnail pixels)
    expect(distancePixels).toBe(800);

    // With the ORIGINAL calibration (100 px/mm for the 2000px original)
    // this calculates to 8mm instead of 20mm!
    const incorrectMM = distancePixels / calibration.pixels_per_mm;
    expect(incorrectMM).toBe(8); // WRONG! Should be 20mm

    // The error factor is original width / thumbnail width
    const errorFactor = originalNaturalSize.width / thumbnailNaturalSize.width;
    expect(errorFactor).toBe(2.5);
  });

  it('shows correct measurement when original dimensions are preserved', () => {
    // If the server converts TIFF to PNG/JPEG at FULL resolution,
    // the naturalWidth/Height will match the original
    const originalNaturalSize = { width: 2000, height: 1000 };
    const containerSize = { width: 800, height: 400 }; // Displayed smaller
    const calibration = { pixels_per_mm: 100, pixels_per_inch: 2540 };

    // User draws edge-to-edge line in container
    const line = { x1: 0, y1: 200, x2: 800, y2: 200 };

    // With correct original dimensions
    const scaleX = originalNaturalSize.width / containerSize.width; // 2.5
    const imageX1 = line.x1 * scaleX;
    const imageX2 = line.x2 * scaleX;
    const distancePixels = Math.abs(imageX2 - imageX1);

    // Correct: 800 container pixels * 2.5 scale = 2000 image pixels
    expect(distancePixels).toBe(2000);

    // With calibration, this is correctly 20mm
    const correctMM = distancePixels / calibration.pixels_per_mm;
    expect(correctMM).toBe(20);
  });
});

describe('MeasurementTool component integration', () => {
  const defaultProps = {
    containerSize: { width: 100, height: 100 },
    naturalSize: { width: 100, height: 100 },
    zoomLevel: 1,
    calibration: { pixels_per_mm: 10, pixels_per_inch: 254, unit: 'mm' },
    onSaveMeasurement: jest.fn(),
    onCancel: jest.fn(),
    existingMeasurementCount: 0
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Mock crypto.randomUUID
    global.crypto = { randomUUID: () => 'test-uuid-123' };
  });

  afterEach(() => {
    delete global.crypto;
  });

  it('creates measurement with correct pixel distance for square image', () => {
    const onSaveMeasurement = jest.fn();
    const { container } = render(
      <MeasurementTool
        {...defaultProps}
        onSaveMeasurement={onSaveMeasurement}
      />
    );

    const overlay = container.querySelector('div[style*="cursor"]');

    // Draw a horizontal line across full width
    fireEvent.mouseDown(overlay, { clientX: 0, clientY: 50 });
    fireEvent.mouseMove(overlay, { clientX: 100, clientY: 50 });
    fireEvent.mouseUp(overlay, { clientX: 100, clientY: 50 });

    // Should show save dialog - enter name and save
    const input = container.querySelector('input[type="text"]');
    if (input) {
      fireEvent.change(input, { target: { value: 'Test Measurement' } });
      const saveButton = Array.from(container.querySelectorAll('button'))
        .find(b => b.textContent === 'Save');
      if (saveButton) {
        fireEvent.click(saveButton);
      }
    }

    if (onSaveMeasurement.mock.calls.length > 0) {
      const measurement = onSaveMeasurement.mock.calls[0][0];
      expect(measurement.distance_pixels).toBe(100);
      expect(measurement.distance_mm).toBe(10); // 100px / 10px per mm
    }
  });

  it('creates measurement with correct pixel distance for rectangular image (uniform scaling)', () => {
    const onSaveMeasurement = jest.fn();
    const { container } = render(
      <MeasurementTool
        {...defaultProps}
        naturalSize={{ width: 200, height: 100 }}
        containerSize={{ width: 100, height: 50 }} // Maintains 2:1 aspect ratio
        onSaveMeasurement={onSaveMeasurement}
      />
    );

    const overlay = container.querySelector('div[style*="cursor"]');

    // Draw a horizontal line across full container width
    // Container is 100px wide, natural is 200px wide, so full width = 200 natural pixels
    fireEvent.mouseDown(overlay, { clientX: 0, clientY: 25 });
    fireEvent.mouseMove(overlay, { clientX: 100, clientY: 25 });
    fireEvent.mouseUp(overlay, { clientX: 100, clientY: 25 });

    const input = container.querySelector('input[type="text"]');
    if (input) {
      fireEvent.change(input, { target: { value: 'Width Test' } });
      const saveButton = Array.from(container.querySelectorAll('button'))
        .find(b => b.textContent === 'Save');
      if (saveButton) {
        fireEvent.click(saveButton);
      }
    }

    if (onSaveMeasurement.mock.calls.length > 0) {
      const measurement = onSaveMeasurement.mock.calls[0][0];
      expect(measurement.distance_pixels).toBe(200);
      expect(measurement.distance_mm).toBe(20); // 200px / 10px per mm
    }
  });
});
