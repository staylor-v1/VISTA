# PT3 local CT 3D viewer

Vista's PT3 3D pane now uses one shared patient-space model for Volume, 3DGS, and Hybrid modes. The original scalar volume remains authoritative; Gaussian splats are a derived acceleration/visualization asset.

```text
medical source
  -> local preprocessing
  -> authoritative scalar volume bundle
  -> GPU-style volume renderer

medical source or volume bundle
  -> adaptive sampling/reference rendering
  -> layered or scalar-aware Gaussian asset
  -> 3DGS renderer

volume renderer + 3DGS renderer
  -> shared camera, transforms, clipping, and UI
  -> local web viewer
```

## Running locally

```bash
cd frontend
npm install
npm start
```

Open a PT3 inspection workbench and select **GPU volume renderer**, **3DGS renderer**, or **Hybrid volume + 3DGS** in the 3D view selector. The 2D MPR slice panes continue to display the same source 2D slices.

## Geometry and data contract

Viewer metadata is normalized as `dimensions`, `spacing`, `origin`, `direction`, `scalarType`, `scalarRange`, `modality`, `rescaleSlope`, `rescaleIntercept`, and a non-PHI `sourceId`. Index coordinates are transformed to physical patient coordinates by scaling with voxel spacing, applying the 3x3 direction matrix, and then adding origin. This keeps anisotropic spacing and orientation consistent across volume, splat, clipping, camera, and hybrid composition.

## Rendering paths

- **Volume** uses the shared CT transfer-function controls, window/level presets (bone, soft tissue, lung), opacity, quality profiles, bounding box, orientation labels, and crop/clipping state. The current implementation is a browser-local renderer scaffold that preserves geometry and UI contracts while avoiding new large dependencies.
- **3DGS** extends the existing PT3 Gaussian splat asset path. PLY and JSON `.splat` assets are parsed in a Web Worker so asset decoding does not block the main UI. Assets may contain baked colors today; scalar-aware JSON splats are versioned through metadata and should apply active transfer functions when exported with scalar attributes.
- **Hybrid** draws the translucent volume first and derived splats second in the same coordinate frame. This is a documented approximation rather than full order-independent transparency.

## Preprocessing and privacy

Backend PT3 splat generation remains local and cache-backed. Do not upload patient data or commit PHI. Local CT source folders, generated bundles, and cached assets should stay in `.cache/` or ignored local data directories. Use synthetic PT3 fixtures for tests when medical data cannot be committed.

## Performance profiles

Performance, Balanced, and Quality profiles adjust render resolution and volume sample-step estimates. The diagnostics overlay reports dimensions, physical size, FPS, and rendered splat count. Browser/GPU limits should be surfaced as user-visible errors instead of silently distorting volume geometry.

## Known limitations

- Existing baked 3DGS assets do not support arbitrary CT window/level remapping; use scalar-aware exports for that.
- Hybrid composition is volume-then-splat alpha blending, not exact order-independent transparency.
- Direct DICOM browser import is not added here; use the existing local backend/synthetic fixtures and future preprocessing to produce browser-ready bundles.

## Checks

```bash
cd frontend
npm run build
npm test -- --watchAll=false --runInBand pt3VolumeGeometry.test.js
```
