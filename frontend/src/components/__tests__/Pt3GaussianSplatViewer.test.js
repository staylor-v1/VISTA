import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Pt3GaussianSplatViewer, {
  DEFAULT_RAY_MARCH_SETTINGS,
  getPt3RealGaussianSplatAsset,
  getPt3RealSplatCameras,
  normalizeRayMarchSettings,
  REAL_SPLAT_BROWSER_MAX,
} from '../Pt3GaussianSplatViewer';
import {
  createThreeMechanicalRenderer,
  DEFAULT_PT3_RECONSTRUCTION_OPTIONS,
} from '../pt3ThreeRenderer';

jest.mock('../pt3ThreeRenderer', () => ({
  ...jest.requireActual('../pt3ThreeRenderer'),
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

function enableMockRayMarchRenderer() {
  const renderer = makeRenderer();
  createThreeMechanicalRenderer.mockResolvedValue(renderer);
  return renderer;
}

async function waitForActiveRayMarchControls() {
  const controls = screen.getByRole('group', { name: 'Ray-march controls' });
  await waitFor(() => expect(screen.getByLabelText('Ray-march reconstruction style')).toBeEnabled());
  return controls;
}

function RayMarchControlsHarness({ initialSettings, onSettingsChange = () => {} }) {
  const [settings, setSettings] = React.useState(initialSettings);
  const handleSettingsChange = (nextSettings) => {
    onSettingsChange(nextSettings);
    setSettings(nextSettings);
  };
  return <Pt3GaussianSplatViewer
    part={part}
    mode="volume"
    showRayMarchControls
    rayMarchSettings={settings}
    onRayMarchSettingsChange={handleSettingsChange}
  />;
}

describe('Pt3GaussianSplatViewer renderer degradation', () => {
  beforeEach(() => {
    createThreeMechanicalRenderer.mockReset();
    createThreeMechanicalRenderer.mockResolvedValue(null);
  });

  test('shows an explicit aligned 3DGS fallback when the Hybrid ray layer fails', async () => {
    const limitError = 'PT3 volume texture dimensions 4096×512×200 exceed this device\'s WebGL MAX_3D_TEXTURE_SIZE limit of 2048 voxels per axis';
    createThreeMechanicalRenderer.mockRejectedValue(new Error(limitError));
    render(<Pt3GaussianSplatViewer part={part} mode="hybrid" />);

    expect(await screen.findByText(
      `Ray-marched layer unavailable: ${limitError}. Showing the aligned 3DGS fallback only.`,
    ))
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

  test('does not show the previous part volume while a same-mode replacement is loading', async () => {
    const firstRenderer = makeRenderer();
    let resolveReplacementRenderer;
    createThreeMechanicalRenderer
      .mockResolvedValueOnce(firstRenderer)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveReplacementRenderer = resolve;
      }));
    const firstStack = [{ id: 'part-a-slice', url: '/part-a.png', sliceIndex: 0 }];
    const replacementStack = [{ id: 'part-b-slice', url: '/part-b.png', sliceIndex: 0 }];

    const { rerender } = render(
      <Pt3GaussianSplatViewer part={part} mode="volume" volumeImageStack={firstStack} />,
    );
    const webglCanvas = screen.getByLabelText('Three.js mechanical volume renderer');
    await waitFor(() => expect(webglCanvas).not.toHaveAttribute('hidden'));

    rerender(
      <Pt3GaussianSplatViewer part={part} mode="volume" volumeImageStack={replacementStack} />,
    );
    expect(webglCanvas).toHaveAttribute('hidden');
    expect(firstRenderer.dispose).toHaveBeenCalled();
    expect(createThreeMechanicalRenderer.mock.calls[0][1].signal).toHaveProperty('aborted', true);

    resolveReplacementRenderer(makeRenderer());
    await waitFor(() => expect(webglCanvas).not.toHaveAttribute('hidden'));
  });

  test('shares renderer defaults and normalizes adversarial saved settings', () => {
    Object.entries(DEFAULT_PT3_RECONSTRUCTION_OPTIONS).forEach(([key, value]) => {
      expect(DEFAULT_RAY_MARCH_SETTINGS[key]).toBe(value);
    });
    expect(normalizeRayMarchSettings(null)).toEqual(DEFAULT_RAY_MARCH_SETTINGS);
    expect(normalizeRayMarchSettings({
      opacityRampWidth: '-2',
      colorLow: '#ABCDEF',
      colorHigh: 'not-a-color',
      volumeOpacity: '7.5',
      intensityThreshold: Number.NaN,
      quality: 'turbo',
      showSliceGuides: 'false',
      reconstructionStyle: 'AVERAGE',
      windowCenter: '2',
      windowWidth: 0,
      isoThreshold: -3,
      isoWidth: Number.POSITIVE_INFINITY,
      boundaryEnhancement: 'true',
      boundaryStrength: '4',
      boundaryBandWidth: 0,
    })).toEqual({
      opacityRampWidth: 0.05,
      colorLow: '#abcdef',
      colorHigh: DEFAULT_RAY_MARCH_SETTINGS.colorHigh,
      volumeOpacity: 2.5,
      intensityThreshold: DEFAULT_RAY_MARCH_SETTINGS.intensityThreshold,
      quality: 'balanced',
      showSliceGuides: false,
      reconstructionStyle: 'xray',
      windowCenter: 1,
      windowWidth: 0.01,
      isoThreshold: 0,
      isoWidth: DEFAULT_RAY_MARCH_SETTINGS.isoWidth,
      boundaryEnhancement: true,
      boundaryStrength: 2,
      boundaryBandWidth: 0.001,
    });
    expect(normalizeRayMarchSettings({
      volumeOpacity: null,
      intensityThreshold: '',
      quality: null,
      showSliceGuides: 'not-a-boolean',
      boundaryEnhancement: 'false',
    })).toEqual(expect.objectContaining({
      volumeOpacity: DEFAULT_RAY_MARCH_SETTINGS.volumeOpacity,
      intensityThreshold: DEFAULT_RAY_MARCH_SETTINGS.intensityThreshold,
      quality: DEFAULT_RAY_MARCH_SETTINGS.quality,
      showSliceGuides: DEFAULT_RAY_MARCH_SETTINGS.showSliceGuides,
      boundaryEnhancement: false,
    }));
  });

  test('disables only reconstruction settings while keeping fallback view controls usable', async () => {
    createThreeMechanicalRenderer.mockRejectedValue(new Error('WebGL unavailable'));
    const onSettingsChange = jest.fn();
    const onRotationChange = jest.fn();
    const onZoomChange = jest.fn();
    const onResetView = jest.fn();
    render(<Pt3GaussianSplatViewer
      part={part}
      mode="volume"
      showRayMarchControls
      volumeImageStack={[{ id: 'slice-1', url: '/slice.png', sliceIndex: 0 }]}
      rayMarchSettings={{
        ...DEFAULT_RAY_MARCH_SETTINGS,
        reconstructionStyle: 'window',
        boundaryEnhancement: true,
      }}
      onRayMarchSettingsChange={onSettingsChange}
      onRotationChange={onRotationChange}
      onZoomChange={onZoomChange}
      onResetView={onResetView}
    />);

    const controls = screen.getByRole('group', { name: 'Ray-march controls' });
    expect(controls).toBeEnabled();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Reconstruction settings require an active WebGL volume renderer',
    );
    await waitFor(() => expect(screen.getByTestId('pt3-gaussian-splat-viewer')).toHaveTextContent('Ray march fallback'));
    [
      screen.getByLabelText('Ray-march reconstruction style'),
      screen.getByLabelText('Ray-march window center'),
      screen.getByLabelText('Ray-march window width'),
      screen.getByLabelText('Ray-march boundary enhancement'),
      screen.getByLabelText('Ray-march boundary strength'),
      screen.getByLabelText('Ray-march opacity ramp width'),
      screen.getByLabelText('Ray-march low color coefficient'),
      screen.getByLabelText('Ray-march high color coefficient'),
      screen.getByLabelText('Ray-march density'),
      screen.getByLabelText('Ray-march quality profile'),
      screen.getByLabelText('Show slice guides'),
      screen.getByRole('button', { name: 'Reset ray-march settings' }),
    ].forEach((control) => expect(control).toBeDisabled());
    const orbitX = screen.getByRole('slider', { name: 'Orbit X' });
    expect(orbitX).toBeEnabled();
    expect(screen.getByRole('slider', { name: 'Orbit Y' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Zoom +' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reset view' })).toBeEnabled();

    fireEvent.change(orbitX, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zoom +' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
    expect(onRotationChange).toHaveBeenCalledWith({ x: 12, y: 32 });
    expect(onZoomChange).toHaveBeenCalledWith(1.12);
    expect(onResetView).toHaveBeenCalledTimes(1);
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  test('selects and resets internal-feature reconstruction styles', async () => {
    enableMockRayMarchRenderer();
    const onSettingsChange = jest.fn();
    render(<RayMarchControlsHarness
      initialSettings={{ ...DEFAULT_RAY_MARCH_SETTINGS }}
      onSettingsChange={onSettingsChange}
    />);
    await waitForActiveRayMarchControls();

    const style = screen.getByLabelText('Ray-march reconstruction style');
    expect(style).toHaveValue('composite');
    const summary = screen.getByTestId('ray-march-transfer-summary');
    expect(style).toHaveAttribute('aria-describedby', summary.id);
    expect(summary).toHaveAttribute('aria-live', 'polite');
    expect(summary).toHaveAttribute('aria-atomic', 'true');
    expect(screen.getByTestId('ray-march-transfer-summary')).toHaveTextContent('Composite reconstruction');
    expect(summary).toHaveTextContent('normalized 0–1 preview luminance');
    expect(summary).toHaveTextContent('not original CT scalar units');

    fireEvent.change(style, { target: { value: 'mip' } });
    expect(style).toHaveValue('mip');
    expect(onSettingsChange).toHaveBeenLastCalledWith(expect.objectContaining({
      ...DEFAULT_RAY_MARCH_SETTINGS,
      reconstructionStyle: 'mip',
    }));
    expect(screen.getByTestId('ray-march-transfer-summary')).toHaveTextContent('highest-intensity sample');

    fireEvent.click(screen.getByRole('button', { name: 'Reset ray-march settings' }));
    expect(style).toHaveValue('composite');
    expect(onSettingsChange).toHaveBeenLastCalledWith({ ...DEFAULT_RAY_MARCH_SETTINGS });
  });

  test('supports keyboard traversal while containing ray-control shortcuts', async () => {
    enableMockRayMarchRenderer();
    const user = userEvent.setup();
    const parentKeyDown = jest.fn();
    render(
      <div onKeyDown={parentKeyDown}>
        <RayMarchControlsHarness initialSettings={{ ...DEFAULT_RAY_MARCH_SETTINGS }} />
      </div>,
    );
    await waitForActiveRayMarchControls();

    await user.tab();
    const style = screen.getByLabelText('Ray-march reconstruction style');
    expect(style).toHaveFocus();
    await user.selectOptions(style, 'iso');
    expect(style).toHaveValue('iso');
    await user.tab();
    expect(screen.getByLabelText('Ray-march iso threshold')).toHaveFocus();

    parentKeyDown.mockClear();
    fireEvent.keyDown(screen.getByLabelText('Ray-march iso threshold'), { key: 'ArrowRight' });
    expect(parentKeyDown).not.toHaveBeenCalled();
  });

  test('shows only the parameters used by the selected reconstruction style', async () => {
    enableMockRayMarchRenderer();
    render(<RayMarchControlsHarness initialSettings={{ ...DEFAULT_RAY_MARCH_SETTINGS }} />);
    await waitForActiveRayMarchControls();

    const style = screen.getByLabelText('Ray-march reconstruction style');
    const boundaryToggle = screen.getByLabelText('Ray-march boundary enhancement');
    const boundaryStrength = screen.getByLabelText('Ray-march boundary strength');
    expect(screen.queryByTestId('ray-march-window-controls')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ray-march-iso-controls')).not.toBeInTheDocument();
    expect(boundaryToggle).toBeEnabled();
    expect(boundaryStrength).toBeDisabled();

    fireEvent.change(style, { target: { value: 'window' } });
    expect(screen.getByTestId('ray-march-window-controls')).toBeInTheDocument();
    expect(screen.getByLabelText('Ray-march window center')).toHaveValue('0.45');
    expect(screen.getByLabelText('Ray-march window width')).toHaveValue('0.18');
    expect(screen.queryByTestId('ray-march-iso-controls')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Ray-march opacity ramp width')).toBeInTheDocument();
    expect(screen.queryByLabelText('Ray-march intensity threshold')).not.toBeInTheDocument();

    fireEvent.change(style, { target: { value: 'iso' } });
    expect(screen.getByTestId('ray-march-iso-controls')).toBeInTheDocument();
    expect(screen.getByLabelText('Ray-march iso threshold')).toHaveValue('0.45');
    expect(screen.getByLabelText('Ray-march iso width')).toHaveValue('0.04');
    expect(screen.queryByTestId('ray-march-window-controls')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Ray-march opacity ramp width')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Ray-march intensity threshold')).not.toBeInTheDocument();

    fireEvent.change(style, { target: { value: 'mip' } });
    expect(screen.getByTestId('ray-march-transfer-summary')).toHaveTextContent('MIP is a projection');
    expect(screen.getByLabelText('Ray-march opacity ramp width')).toBeInTheDocument();
    expect(screen.getByLabelText('Ray-march intensity threshold')).toBeInTheDocument();
    expect(boundaryToggle).toBeDisabled();
    expect(boundaryStrength).toBeDisabled();

    fireEvent.change(style, { target: { value: 'xray' } });
    expect(screen.getByTestId('ray-march-transfer-summary')).toHaveTextContent('average-intensity projection');
    expect(screen.getByTestId('ray-march-transfer-summary')).toHaveTextContent('not a depth-resolved surface');
  });

  test('enables boundary strength only when enhancement is active in a supported style', async () => {
    enableMockRayMarchRenderer();
    const onSettingsChange = jest.fn();
    render(<RayMarchControlsHarness
      initialSettings={{ ...DEFAULT_RAY_MARCH_SETTINGS }}
      onSettingsChange={onSettingsChange}
    />);
    await waitForActiveRayMarchControls();

    const toggle = screen.getByLabelText('Ray-march boundary enhancement');
    const strength = screen.getByLabelText('Ray-march boundary strength');
    expect(toggle).not.toBeChecked();
    expect(strength).toBeDisabled();

    fireEvent.click(toggle);
    expect(toggle).toBeChecked();
    expect(strength).toBeEnabled();
    fireEvent.change(strength, { target: { value: '0.8' } });
    expect(strength).toHaveValue('0.8');
    expect(onSettingsChange).toHaveBeenLastCalledWith(expect.objectContaining({
      boundaryEnhancement: true,
      boundaryStrength: 0.8,
    }));

    fireEvent.change(screen.getByLabelText('Ray-march reconstruction style'), { target: { value: 'xray' } });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(strength).toBeDisabled();
    expect(screen.getByText('Saved on; inactive in X-ray')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Ray-march reconstruction style'), { target: { value: 'iso' } });
    expect(toggle).toBeChecked();
    expect(toggle).toBeEnabled();
    expect(strength).toBeEnabled();
  });

  test('fills new reconstruction options for old partial settings', async () => {
    enableMockRayMarchRenderer();
    const onSettingsChange = jest.fn();
    render(<Pt3GaussianSplatViewer
      part={part}
      mode="volume"
      showRayMarchControls
      rayMarchSettings={{ quality: 'quality' }}
      onRayMarchSettingsChange={onSettingsChange}
    />);
    await waitForActiveRayMarchControls();

    expect(screen.getByLabelText('Ray-march reconstruction style')).toHaveValue('composite');
    expect(screen.getByLabelText('Ray-march boundary enhancement')).not.toBeChecked();
    expect(screen.getByLabelText('Ray-march boundary strength')).toHaveValue('0.45');
    fireEvent.change(screen.getByLabelText('Ray-march reconstruction style'), { target: { value: 'window' } });
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({
      quality: 'quality',
      reconstructionStyle: 'window',
      windowCenter: 0.45,
      windowWidth: 0.18,
      isoThreshold: 0.45,
      boundaryBandWidth: 0.08,
    }));
  });

  test('passes every reconstruction and boundary option to the Three.js renderer', async () => {
    const renderer = makeRenderer();
    createThreeMechanicalRenderer.mockResolvedValue(renderer);
    const reconstructionSettings = {
      ...DEFAULT_RAY_MARCH_SETTINGS,
      reconstructionStyle: 'window',
      windowCenter: 0.37,
      windowWidth: 0.11,
      isoThreshold: 0.62,
      isoWidth: 0.025,
      boundaryEnhancement: true,
      boundaryStrength: 0.85,
      boundaryBandWidth: 0.06,
    };

    render(<Pt3GaussianSplatViewer
      part={part}
      mode="volume"
      volumeImageStack={[{ id: 'slice-1', url: '/slice.png', sliceIndex: 0 }]}
      rayMarchSettings={reconstructionSettings}
    />);

    await waitFor(() => expect(renderer.render).toHaveBeenCalled());
    expect(renderer.render.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({
      reconstructionStyle: 'window',
      windowCenter: 0.37,
      windowWidth: 0.11,
      isoThreshold: 0.62,
      isoWidth: 0.025,
      boundaryEnhancement: true,
      boundaryStrength: 0.85,
      boundaryBandWidth: 0.06,
    }));
  });

  test('renders malformed legacy settings with normalized RAF arguments', async () => {
    const renderer = makeRenderer();
    createThreeMechanicalRenderer.mockResolvedValue(renderer);
    render(<Pt3GaussianSplatViewer
      part={part}
      mode="volume"
      volumeImageStack={[{ id: 'slice-1', url: '/slice.png', sliceIndex: 0 }]}
      rayMarchSettings={{
        quality: 'not-a-profile',
        volumeOpacity: '9',
        intensityThreshold: null,
        colorLow: 'invalid',
        reconstructionStyle: 'average',
        boundaryEnhancement: 'false',
      }}
    />);

    await waitFor(() => expect(renderer.render).toHaveBeenCalled());
    expect(renderer.render.mock.calls.at(-1)[0]).toEqual(expect.objectContaining({
      sampleStep: 1.25,
      volumeOpacity: 2.5,
      intensityThreshold: DEFAULT_RAY_MARCH_SETTINGS.intensityThreshold,
      reconstructionStyle: 'xray',
      boundaryEnhancement: false,
      transferFunction: expect.objectContaining({ colorLow: DEFAULT_RAY_MARCH_SETTINGS.colorLow }),
    }));
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
