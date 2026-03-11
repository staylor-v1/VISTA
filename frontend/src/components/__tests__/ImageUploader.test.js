import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ImageUploader from '../ImageUploader';

const makeFile = (name) => new File(['data'], name, { type: 'image/png' });

// Helpers to select files via the hidden input.
function selectFiles(files) {
  const input = document.getElementById('file-input');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

function renderUploader(props = {}) {
  const defaultProps = {
    projectId: 'proj-1',
    onUploadComplete: jest.fn(),
    loading: false,
    setLoading: jest.fn(),
    setError: jest.fn(),
    ...props,
  };
  return { ...render(<ImageUploader {...defaultProps} />), props: defaultProps };
}

beforeEach(() => {
  jest.restoreAllMocks();
});

describe('ImageUploader', () => {
  describe('Upload button disabled state', () => {
    test('upload button is enabled by default', () => {
      renderUploader();
      expect(screen.getByRole('button', { name: /upload images/i })).not.toBeDisabled();
    });

    test('upload button is disabled when loading is true', () => {
      renderUploader({ loading: true });
      expect(screen.getByRole('button', { name: /uploading/i })).toBeDisabled();
    });

    test('upload button is disabled when extractor config is invalid', async () => {
      renderUploader();
      const files = [makeFile('a_b_c.png')];
      selectFiles(files);

      // Configure extractor with a delimiter and mismatched key count to
      // trigger isValid=false.
      fireEvent.change(screen.getByLabelText('Delimiter'), {
        target: { value: '_' },
      });
      fireEvent.change(screen.getByLabelText('Keys (comma-separated)'), {
        target: { value: 'only_one_key' },
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /upload images/i })).toBeDisabled();
      });
    });

    test('upload button re-enables when extractor mismatch is resolved', async () => {
      renderUploader();
      const files = [makeFile('a_b.png')];
      selectFiles(files);

      fireEvent.change(screen.getByLabelText('Delimiter'), {
        target: { value: '_' },
      });
      // Mismatch: 2 values, 1 key.
      fireEvent.change(screen.getByLabelText('Keys (comma-separated)'), {
        target: { value: 'one' },
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /upload images/i })).toBeDisabled();
      });

      // Fix: provide 2 keys to match 2 values.
      fireEvent.change(screen.getByLabelText('Keys (comma-separated)'), {
        target: { value: 'first, second' },
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /upload images/i })).not.toBeDisabled();
      });
    });
  });

  describe('Upload with no extractor pattern', () => {
    test('sends file without metadata when no pattern or manual JSON set', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'img-1' }),
      });

      const { props } = renderUploader();
      selectFiles([makeFile('photo.png')]);

      fireEvent.click(screen.getByRole('button', { name: /upload images/i }));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toBe('/api/projects/proj-1/images');
      expect(options.method).toBe('POST');

      const body = options.body;
      expect(body.get('file')).toBeTruthy();
      expect(body.get('metadata')).toBeNull();
      expect(props.onUploadComplete).toHaveBeenCalledWith([{ id: 'img-1' }]);
    });
  });

  describe('Upload with manual metadata only', () => {
    test('sends manual JSON metadata in FormData', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'img-1' }),
      });

      renderUploader();
      selectFiles([makeFile('photo.png')]);

      fireEvent.change(screen.getByLabelText('Metadata (Optional JSON)'), {
        target: { value: '{"source": "manual"}' },
      });

      fireEvent.click(screen.getByRole('button', { name: /upload images/i }));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      const body = fetchSpy.mock.calls[0][1].body;
      expect(JSON.parse(body.get('metadata'))).toEqual({ source: 'manual' });
    });
  });

  describe('Upload with extracted metadata', () => {
    test('sends extracted metadata from filename in FormData', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'img-1' }),
      });

      renderUploader();
      const files = [makeFile('lot1_SN001.png')];
      selectFiles(files);

      fireEvent.change(screen.getByLabelText('Delimiter'), {
        target: { value: '_' },
      });
      fireEvent.change(screen.getByLabelText('Keys (comma-separated)'), {
        target: { value: 'lot, serial' },
      });

      // Wait for the config to settle (isValid=true, preview matches).
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /upload images/i })).not.toBeDisabled();
      });

      fireEvent.click(screen.getByRole('button', { name: /upload images/i }));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      const body = fetchSpy.mock.calls[0][1].body;
      expect(JSON.parse(body.get('metadata'))).toEqual({
        lot: 'lot1',
        serial: 'SN001',
      });
    });
  });

  describe('Metadata merge precedence', () => {
    test('manual metadata overrides extracted metadata on key collision', async () => {
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'img-1' }),
      });

      renderUploader();
      const files = [makeFile('lot1_SN001.png')];
      selectFiles(files);

      // Set up extractor: keys "lot" and "serial".
      fireEvent.change(screen.getByLabelText('Delimiter'), {
        target: { value: '_' },
      });
      fireEvent.change(screen.getByLabelText('Keys (comma-separated)'), {
        target: { value: 'lot, serial' },
      });

      // Manual metadata with an overlapping "lot" key and extra "source" key.
      fireEvent.change(screen.getByLabelText('Metadata (Optional JSON)'), {
        target: { value: '{"lot": "OVERRIDE", "source": "manual"}' },
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /upload images/i })).not.toBeDisabled();
      });

      fireEvent.click(screen.getByRole('button', { name: /upload images/i }));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      const body = fetchSpy.mock.calls[0][1].body;
      const metadata = JSON.parse(body.get('metadata'));
      expect(metadata).toEqual({
        lot: 'OVERRIDE',
        serial: 'SN001',
        source: 'manual',
      });
    });
  });

  describe('Validation errors', () => {
    test('sets error when submitting with no files', () => {
      const { props } = renderUploader();
      fireEvent.click(screen.getByRole('button', { name: /upload images/i }));
      expect(props.setError).toHaveBeenCalledWith(
        'Please select at least one file to upload.'
      );
    });

    test('sets error when submitting with invalid manual JSON', () => {
      const { props } = renderUploader();
      selectFiles([makeFile('photo.png')]);

      fireEvent.change(screen.getByLabelText('Metadata (Optional JSON)'), {
        target: { value: 'not valid json' },
      });

      fireEvent.click(screen.getByRole('button', { name: /upload images/i }));
      expect(props.setError).toHaveBeenCalledWith('Invalid JSON format for metadata.');
    });
  });

  describe('Upload failure handling', () => {
    test('sets error on fetch failure', async () => {
      jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network error'));
      jest.spyOn(console, 'error').mockImplementation(() => {});

      const { props } = renderUploader();
      selectFiles([makeFile('photo.png')]);

      fireEvent.click(screen.getByRole('button', { name: /upload images/i }));

      await waitFor(() => {
        expect(props.setError).toHaveBeenCalledWith(
          'Upload complete: 0 succeeded, 1 failed out of 1.'
        );
      });
    });

    test('sets error on non-ok response', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue({
        ok: false,
        status: 500,
      });
      jest.spyOn(console, 'error').mockImplementation(() => {});

      const { props } = renderUploader();
      selectFiles([makeFile('photo.png')]);

      fireEvent.click(screen.getByRole('button', { name: /upload images/i }));

      await waitFor(() => {
        expect(props.setError).toHaveBeenCalledWith(
          'Upload complete: 0 succeeded, 1 failed out of 1.'
        );
      });
    });
  });
});
