import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ImagesToPartsTab from '../ImagesToPartsTab';

describe('ImagesToPartsTab', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('renders unassigned and per-part image hierarchy', () => {
    render(
      <ImagesToPartsTab
        projectId="proj-1"
        parts={[
          {
            id: 'part-1',
            serial_number: 'SN-001',
            display_name: 'Part 1',
            metadata: { source_images: [{ filename: 'assigned-a.png' }] },
          },
        ]}
        images={[
          { filename: 'assigned-a.png' },
          { filename: 'unassigned-z.png' },
        ]}
      />
    );

    expect(screen.getByText('Images to Parts')).toBeInTheDocument();
    expect(screen.getByText('assigned-a.png')).toBeInTheDocument();
    expect(screen.getByText('unassigned-z.png')).toBeInTheDocument();
  });

  test('moves an unassigned image into a part and calls backend assignment API', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({}) });
    const onAssignmentsChanged = jest.fn().mockResolvedValue();

    render(
      <ImagesToPartsTab
        projectId="proj-1"
        parts={[
          {
            id: 'part-1',
            serial_number: 'SN-001',
            display_name: 'Part 1',
            metadata: { source_images: [] },
          },
        ]}
        images={[{ filename: 'unassigned-z.png' }]}
        onAssignmentsChanged={onAssignmentsChanged}
        setError={jest.fn()}
      />
    );

    fireEvent.dragStart(screen.getByRole('button', { name: 'unassigned-z.png' }));
    fireEvent.drop(screen.getByTestId('images-to-parts-target-part-1'));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith('/api/projects/proj-1/parts/image-assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'unassigned-z.png', to_part_id: 'part-1' }),
      });
    });
    await waitFor(() => {
      expect(onAssignmentsChanged).toHaveBeenCalled();
    });
  });
});
