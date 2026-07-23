import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import RemoveImagesTab from '../RemoveImagesTab';

const originalFetch = global.fetch;

jest.setTimeout(15000);

const waitForAsyncWork = async (assertion) => waitFor(assertion, { timeout: 3000 });

describe('RemoveImagesTab', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalFetch) {
      global.fetch = originalFetch;
    } else {
      delete global.fetch;
    }
  });

  test('unloads selected images', async () => {
    const fetchSpy = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = fetchSpy;
    const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
    const onImagesRemoved = jest.fn().mockResolvedValue();

    render(
      <RemoveImagesTab
        projectId="proj-1"
        parts={[]}
        images={[{ id: 'img-1', filename: 'unassigned-a.png' }]}
        onImagesRemoved={onImagesRemoved}
        setError={jest.fn()}
      />
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'unassigned-a.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unload Selected (1)' }));

    expect(confirmSpy).toHaveBeenCalledWith('Unload 1 selected image?');

    await waitForAsyncWork(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy).toHaveBeenCalledWith('/api/projects/proj-1/images/img-1', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Unloaded from Project Data Unload Images tab' }),
      });
    });
    await waitForAsyncWork(() => expect(onImagesRemoved).toHaveBeenCalledTimes(1));
    await waitForAsyncWork(() => expect(screen.getByRole('button', { name: 'Unload Selected (0)' })).toBeDisabled());
  });

  test('does not list images removed from active project image records in part buckets', () => {
    render(
      <RemoveImagesTab
        projectId="proj-1"
        parts={[{
          id: 'part-1',
          serial_number: 'SN-001',
          display_name: 'Part 1',
          metadata: { source_images: [{ filename: 'unloaded.png', image_id: 'img-unloaded' }] },
        }]}
        images={[{ id: 'img-unloaded', filename: 'unloaded.png', deleted_at: '2026-05-29T00:00:00Z' }]}
      />
    );

    expect(screen.queryByText('unloaded.png')).not.toBeInTheDocument();
    expect(screen.getByText('No images assigned to this part.')).toBeInTheDocument();
  });
});
