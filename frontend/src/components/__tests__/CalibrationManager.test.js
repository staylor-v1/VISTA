import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CalibrationManager from '../CalibrationManager';

describe('CalibrationManager', () => {
  const defaultProps = {
    projectId: 'project-123',
    imageId: 'image-456',
    image: null,
    onCalibrationChange: jest.fn()
  };

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('when no calibration exists', () => {
    beforeEach(() => {
      global.fetch.mockResolvedValue({
        ok: false
      });
    });

    it('shows "No calibration set" message', async () => {
      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/No calibration set/)).toBeInTheDocument();
      });
    });

    it('shows "Set Calibration" button', async () => {
      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Set Calibration' })).toBeInTheDocument();
      });
    });

    it('calls onCalibrationChange with null', async () => {
      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(defaultProps.onCalibrationChange).toHaveBeenCalledWith(null);
      });
    });
  });

  describe('when project default calibration exists', () => {
    const projectCalibration = {
      pixels_per_mm: 10,
      pixels_per_inch: 254,
      unit: 'mm'
    };

    beforeEach(() => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ value: projectCalibration })
      });
    });

    it('displays calibration values', async () => {
      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('10.00 px/mm')).toBeInTheDocument();
        expect(screen.getByText('254.00 px/inch')).toBeInTheDocument();
      });
    });

    it('shows "Using project default calibration" label', async () => {
      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Using project default calibration')).toBeInTheDocument();
      });
    });

    it('shows Edit button', async () => {
      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
      });
    });

    it('calls onCalibrationChange with calibration data', async () => {
      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(defaultProps.onCalibrationChange).toHaveBeenCalledWith(projectCalibration);
      });
    });
  });

  describe('when image has calibration override', () => {
    const imageCalibration = {
      pixels_per_mm: 20,
      pixels_per_inch: 508,
      unit: 'mm'
    };

    it('uses image override instead of project default', async () => {
      const imageWithOverride = {
        metadata: {
          calibration_override: imageCalibration
        }
      };

      render(<CalibrationManager {...defaultProps} image={imageWithOverride} />);

      await waitFor(() => {
        expect(screen.getByText('20.00 px/mm')).toBeInTheDocument();
        expect(screen.getByText('Using image-specific calibration')).toBeInTheDocument();
      });

      // Should not fetch project default when image has override
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('also checks metadata_ field for compatibility', async () => {
      const imageWithOverride = {
        metadata_: {
          calibration_override: imageCalibration
        }
      };

      render(<CalibrationManager {...defaultProps} image={imageWithOverride} />);

      await waitFor(() => {
        expect(screen.getByText('20.00 px/mm')).toBeInTheDocument();
      });
    });

    it('shows "Revert to Project Default" button', async () => {
      const imageWithOverride = {
        metadata: {
          calibration_override: imageCalibration
        }
      };

      render(<CalibrationManager {...defaultProps} image={imageWithOverride} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Revert to Project Default' })).toBeInTheDocument();
      });
    });
  });

  describe('edit form', () => {
    beforeEach(() => {
      global.fetch.mockResolvedValue({
        ok: false
      });
    });

    it('opens edit form when Set Calibration is clicked', async () => {
      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Set Calibration' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Set Calibration' }));

      expect(screen.getByText('Pixels per:')).toBeInTheDocument();
      expect(screen.getByLabelText('Millimeter')).toBeInTheDocument();
      expect(screen.getByLabelText('Inch')).toBeInTheDocument();
    });

    it('opens edit form when Edit button is clicked', async () => {
      const projectCalibration = {
        pixels_per_mm: 10,
        pixels_per_inch: 254,
        unit: 'mm'
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ value: projectCalibration })
      });

      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

      expect(screen.getByText('Pixels per:')).toBeInTheDocument();
      // Should pre-fill with existing value
      const input = screen.getByRole('spinbutton');
      expect(input.value).toBe('10');
    });

    it('closes edit form when Cancel is clicked', async () => {
      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Set Calibration' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Set Calibration' }));
      expect(screen.getByText('Pixels per:')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByText('Pixels per:')).not.toBeInTheDocument();
    });

    it('shows unit conversion preview', async () => {
      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Set Calibration' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Set Calibration' }));

      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: '10' } });

      // Should show conversion to inches (10 * 25.4 = 254)
      expect(screen.getByText('= 254.00 px/inch')).toBeInTheDocument();
    });
  });

  describe('validation', () => {
    beforeEach(() => {
      global.fetch.mockResolvedValue({
        ok: false
      });
    });

    it('shows error for non-positive numbers', async () => {
      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Set Calibration' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Set Calibration' }));

      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: '-5' } });

      fireEvent.click(screen.getByRole('button', { name: 'Save as Project Default' }));

      expect(screen.getByText('Calibration must be a positive number')).toBeInTheDocument();
    });

    it('shows error for zero', async () => {
      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Set Calibration' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Set Calibration' }));

      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: '0' } });

      fireEvent.click(screen.getByRole('button', { name: 'Save as Project Default' }));

      expect(screen.getByText('Calibration must be a positive number')).toBeInTheDocument();
    });
  });

  describe('saving calibration', () => {
    beforeEach(() => {
      global.fetch.mockResolvedValue({
        ok: false
      });
    });

    it('saves project default calibration', async () => {
      global.fetch
        .mockResolvedValueOnce({ ok: false }) // Initial load
        .mockResolvedValueOnce({ ok: true }); // Save

      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Set Calibration' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Set Calibration' }));

      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: '15' } });

      fireEvent.click(screen.getByRole('button', { name: 'Save as Project Default' }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/projects/project-123/metadata',
          expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('calibration_default')
          })
        );
      });

      await waitFor(() => {
        expect(screen.getByText('Project calibration saved successfully')).toBeInTheDocument();
      });
    });

    it('saves image-specific calibration', async () => {
      global.fetch
        .mockResolvedValueOnce({ ok: false }) // Initial load
        .mockResolvedValueOnce({ ok: true }); // Save

      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Set Calibration' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Set Calibration' }));

      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: '20' } });

      fireEvent.click(screen.getByRole('button', { name: 'Save for This Image Only' }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/images/image-456/metadata',
          expect.objectContaining({
            method: 'PUT',
            body: expect.stringContaining('calibration_override')
          })
        );
      });

      await waitFor(() => {
        expect(screen.getByText('Image-specific calibration saved successfully')).toBeInTheDocument();
      });
    });

    it('shows error when save fails', async () => {
      global.fetch
        .mockResolvedValueOnce({ ok: false }) // Initial load
        .mockResolvedValueOnce({ ok: false, statusText: 'Internal Server Error' }); // Save fails

      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Set Calibration' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Set Calibration' }));

      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: '15' } });

      fireEvent.click(screen.getByRole('button', { name: 'Save as Project Default' }));

      await waitFor(() => {
        expect(screen.getByText(/Failed to save project calibration/)).toBeInTheDocument();
      });
    });
  });

  describe('clearing image override', () => {
    const imageCalibration = {
      pixels_per_mm: 20,
      pixels_per_inch: 508,
      unit: 'mm'
    };

    it('clears override when confirmed', async () => {
      window.confirm = jest.fn(() => true);

      global.fetch.mockResolvedValue({ ok: true });

      const imageWithOverride = {
        metadata: {
          calibration_override: imageCalibration
        }
      };

      render(<CalibrationManager {...defaultProps} image={imageWithOverride} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Revert to Project Default' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Revert to Project Default' }));

      await waitFor(() => {
        expect(global.fetch).toHaveBeenCalledWith(
          '/api/images/image-456/metadata/calibration_override',
          expect.objectContaining({ method: 'DELETE' })
        );
      });
    });

    it('does not clear override when cancelled', async () => {
      window.confirm = jest.fn(() => false);

      const imageWithOverride = {
        metadata: {
          calibration_override: imageCalibration
        }
      };

      render(<CalibrationManager {...defaultProps} image={imageWithOverride} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Revert to Project Default' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Revert to Project Default' }));

      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe('unit conversion', () => {
    beforeEach(() => {
      global.fetch.mockResolvedValue({ ok: false });
    });

    it('correctly converts mm to inches when saving', async () => {
      global.fetch
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true });

      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Set Calibration' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Set Calibration' }));

      // Enter 10 px/mm
      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: '10' } });

      fireEvent.click(screen.getByRole('button', { name: 'Save as Project Default' }));

      await waitFor(() => {
        const fetchCall = global.fetch.mock.calls[1];
        const body = JSON.parse(fetchCall[1].body);

        expect(body.value.pixels_per_mm).toBe(10);
        expect(body.value.pixels_per_inch).toBe(254); // 10 * 25.4
        expect(body.value.unit).toBe('mm');
      });
    });

    it('correctly converts inches to mm when saving', async () => {
      global.fetch
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true });

      render(<CalibrationManager {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Set Calibration' })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Set Calibration' }));

      // Switch to inches
      fireEvent.click(screen.getByLabelText('Inch'));

      // Enter 254 px/inch
      const input = screen.getByRole('spinbutton');
      fireEvent.change(input, { target: { value: '254' } });

      fireEvent.click(screen.getByRole('button', { name: 'Save as Project Default' }));

      await waitFor(() => {
        const fetchCall = global.fetch.mock.calls[1];
        const body = JSON.parse(fetchCall[1].body);

        expect(body.value.pixels_per_inch).toBe(254);
        expect(body.value.pixels_per_mm).toBe(10); // 254 / 25.4
        expect(body.value.unit).toBe('inches');
      });
    });
  });
});
