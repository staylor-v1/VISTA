import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import Pt3GaussianSplatViewer from '../Pt3GaussianSplatViewer';
import { createThreeMechanicalRenderer } from '../pt3ThreeRenderer';

jest.mock('../pt3ThreeRenderer', () => ({
  createThreeMechanicalRenderer: jest.fn(),
}));

const part = {
  id: 'part-volume',
  metadata: {
    volume_shape: { sagittal: 128, coronal: 1, axial: 1 },
    spacing: [0.08, 0.08, 0.08],
  },
};

function makeRenderer(type = 'three-webgl-raymarch') {
  return { rendererType: type, render: jest.fn(), dispose: jest.fn() };
}

describe('Pt3GaussianSplatViewer renderer degradation', () => {
  beforeEach(() => {
    createThreeMechanicalRenderer.mockReset();
  });

  test('shows an explicit aligned 3DGS fallback when the Hybrid ray layer fails', async () => {
    createThreeMechanicalRenderer.mockRejectedValue(new Error('WebGL unavailable'));
    render(<Pt3GaussianSplatViewer part={part} mode="hybrid" />);

    expect(await screen.findByText('Ray-marched layer unavailable. Showing the aligned 3DGS fallback only.'))
      .toBeInTheDocument();
    expect(screen.getByTestId('pt3-gaussian-splat-viewer')).toHaveTextContent('HYBRID degraded');
    expect(screen.getByLabelText('Three.js mechanical volume renderer')).toHaveAttribute('hidden');
  });

  test('does not reuse a ready Hybrid WebGL state while volume renderer recreation is pending', async () => {
    const hybridRenderer = makeRenderer();
    let resolveVolumeRenderer;
    createThreeMechanicalRenderer
      .mockResolvedValueOnce(hybridRenderer)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveVolumeRenderer = resolve; }));

    const { rerender } = render(<Pt3GaussianSplatViewer part={part} mode="hybrid" />);
    const webglCanvas = screen.getByLabelText('Three.js mechanical volume renderer');
    await waitFor(() => expect(webglCanvas).not.toHaveAttribute('hidden'));

    rerender(<Pt3GaussianSplatViewer part={part} mode="volume" volumeImageStack={[{ id: 'slice-1', url: '/slice.png', sliceIndex: 0 }]} />);
    expect(webglCanvas).toHaveAttribute('hidden');
    expect(hybridRenderer.dispose).toHaveBeenCalled();

    const volumeRenderer = makeRenderer();
    resolveVolumeRenderer(volumeRenderer);
    await waitFor(() => expect(webglCanvas).not.toHaveAttribute('hidden'));
  });
});
