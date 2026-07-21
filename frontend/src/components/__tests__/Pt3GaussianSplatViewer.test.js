import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import Pt3GaussianSplatViewer, {
  getPt3RealGaussianSplatAsset,
  getPt3RealSplatCameras,
  REAL_SPLAT_BROWSER_MAX,
} from '../Pt3GaussianSplatViewer';
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
    createThreeMechanicalRenderer.mockResolvedValue(null);
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

  test('real 3DGS accepts only explicit real asset declarations', () => {
    expect(getPt3RealGaussianSplatAsset({ metadata: { gaussian_splat_url: '/simplified.json' } })).toBeNull();
    expect(getPt3RealGaussianSplatAsset({
      metadata: { pt3_real_splat_asset: { status: 'ready', asset_url: '/optimized.json' } },
    })).toEqual(expect.objectContaining({ url: '/optimized.json' }));
  });

  test('counts only fully calibrated cameras and rejects boolean numeric impostors', () => {
    const validCamera = {
      image_id: 'valid',
      width: 16,
      height: 16,
      intrinsics: [1, 0, 8, 0, 1, 8, 0, 0, 1],
      rotation_quaternion: [1, 0, 0, 0],
      translation: [0, 0, 0],
    };
    expect(getPt3RealSplatCameras({
      metadata: {
        pt3_real_3dgs: {
          cameras: [
            validCamera,
            { ...validCamera, image_id: 'boolean-width', width: true },
            { ...validCamera, image_id: 'boolean-vector', translation: [false, 0, 0] },
            { ...validCamera, image_id: 'zero-quaternion', rotation_quaternion: [0, 0, 0, 0] },
          ],
        },
      },
    })).toEqual([validCamera]);
  });

  test('submits a camera-free direct voxel fit with the chosen splat budget', async () => {
    const calibratedPart = {
      ...part,
      metadata: {
        ...part.metadata,
        pt3_real_3dgs: {
          cameras: [
            { image_id: 'a', width: 16, height: 16, intrinsics: [1, 0, 8, 0, 1, 8, 0, 0, 1], rotation_quaternion: [1, 0, 0, 0], translation: [0, 0, 0] },
            { image_id: 'b', width: 16, height: 16, intrinsics: [1, 0, 8, 0, 1, 8, 0, 0, 1], rotation_quaternion: [1, 0, 0, 0], translation: [1, 0, 0] },
          ],
        },
      },
    };
    expect(getPt3RealSplatCameras(calibratedPart)).toHaveLength(2);
    const originalFetch = global.fetch;
    global.fetch = jest.fn((url, options = {}) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(options.method === 'POST'
        ? { status: 'pending', stage: 'queued', progress_percent: 0 }
        : { status: 'missing', progress_percent: 0, metadata: { provider_configured: true } }),
    }));
    const { unmount } = render(<Pt3GaussianSplatViewer part={calibratedPart} projectId="project-a" mode="real-splat" />);
    expect(await screen.findByLabelText('Real 3DGS fitting strategy')).toHaveValue('voxel_direct');
    const budget = await screen.findByLabelText('Real 3DGS splat budget');
    expect(budget).toHaveAttribute('max', String(REAL_SPLAT_BROWSER_MAX));
    fireEvent.change(budget, { target: { value: '200000' } });
    expect(budget.value).toBe(String(REAL_SPLAT_BROWSER_MAX));
    fireEvent.change(budget, { target: { value: '80000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fit voxel splats' }));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/project-a/parts/part-volume/real-gaussian-splat-assets',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"fit_mode":"voxel_direct"'),
      }),
    ));
    const post = global.fetch.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(JSON.parse(post[1].body)).toEqual(expect.objectContaining({
      cameras: [],
      parameters: expect.objectContaining({ max_splats: 80000, sh_degree: 0, optimize_camera_poses: false }),
    }));
    unmount();
    global.fetch = originalFetch;
  });

  test('keeps arrow-key interaction inside the Real fit controls', async () => {
    const parentKeyDown = jest.fn();
    render(
      <div onKeyDown={parentKeyDown}>
        <Pt3GaussianSplatViewer part={part} mode="real-splat" />
      </div>,
    );
    const strategy = await screen.findByLabelText('Real 3DGS fitting strategy');
    const budget = screen.getByLabelText('Real 3DGS splat budget');
    fireEvent.keyDown(strategy, { key: 'ArrowDown' });
    fireEvent.keyDown(budget, { key: 'ArrowRight' });
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  test('shows an honest unavailable state without substituting simplified splats', async () => {
    render(<Pt3GaussianSplatViewer
      part={{ ...part, metadata: { ...part.metadata, gaussian_splat_url: '/simplified.json' } }}
      mode="real-splat"
    />);

    expect(await screen.findByText('Real 3DGS unavailable')).toBeInTheDocument();
    expect(screen.getByTestId('pt3-gaussian-splat-viewer')).toHaveTextContent('Real 3DGS unavailable');
    expect(screen.getByTestId('pt3-gaussian-splat-viewer')).not.toHaveTextContent('deterministic mechanical fallback');
    expect(createThreeMechanicalRenderer).not.toHaveBeenCalled();
  });

  test('shows shared segmentation controls only when segment metadata exists', () => {
    const segmentedPart = {
      ...part,
      metadata: {
        ...part.metadata,
        pt3_segmentation: { segments: [{ id: 1, label: 'Shell', color: '#f97316' }] },
      },
    };
    const { rerender } = render(<Pt3GaussianSplatViewer part={part} mode="volume" />);
    expect(screen.queryByRole('group', { name: 'Segmentation display' })).not.toBeInTheDocument();
    rerender(<Pt3GaussianSplatViewer part={segmentedPart} mode="volume" />);
    expect(screen.getByRole('group', { name: 'Segmentation display' })).toHaveTextContent('Shell');
    expect(screen.getByLabelText('Show Shell')).toBeChecked();
  });

  test('keeps keyboard interaction inside every segmentation control', () => {
    const parentKeyDown = jest.fn();
    const segmentedPart = {
      ...part,
      metadata: {
        ...part.metadata,
        pt3_segmentation: { segments: [{ id: 1, label: 'Shell', color: '#f97316' }] },
      },
    };
    render(
      <div onKeyDown={parentKeyDown}>
        <Pt3GaussianSplatViewer part={segmentedPart} mode="volume" />
      </div>,
    );

    fireEvent.keyDown(screen.getByLabelText('Show Shell'), { key: ' ' });
    fireEvent.keyDown(screen.getByLabelText('Shell opacity'), { key: 'ArrowRight' });
    expect(parentKeyDown).not.toHaveBeenCalled();
  });
});
