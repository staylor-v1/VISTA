import { readFileSync } from 'fs';
import path from 'path';
import {
  DEFAULT_PT3_RECONSTRUCTION_OPTIONS,
  getPt3AdaptiveMarchParameters,
  getPt3BoundedProjectionOpacity,
  getPt3ReconstructionUniformValues,
  getPt3TextureAllocationLimitError,
  getPt3TextureSizeLimitError,
  normalizePt3ReconstructionOptions,
  PT3_MAX_BROWSER_VOLUME_TEXTURE_BYTES,
  PT3_MAX_RAY_MARCH_SAMPLES,
  PT3_RECONSTRUCTION_STYLE_IDS,
  PT3_VOLUME_MATERIAL_OPTIONS,
  PT3_VOLUME_FRAGMENT_SHADER,
} from '../pt3ThreeRenderer';

const PT3_THREE_RENDERER_SOURCE = readFileSync(
  path.join(__dirname, '..', 'pt3ThreeRenderer.js'),
  'utf8',
);

describe('PT3 reconstruction renderer settings', () => {
  test('keeps legacy render calls on the composite defaults', () => {
    expect(normalizePt3ReconstructionOptions()).toEqual(DEFAULT_PT3_RECONSTRUCTION_OPTIONS);
    expect(normalizePt3ReconstructionOptions(null)).toEqual(DEFAULT_PT3_RECONSTRUCTION_OPTIONS);
    expect(getPt3ReconstructionUniformValues()).toEqual({
      renderStyle: 0,
      windowCenter: 0.45,
      windowWidth: 0.18,
      isoThreshold: 0.45,
      isoWidth: 0.04,
      boundaryEnhancement: false,
      boundaryStrength: 0.45,
      boundaryBandWidth: 0.08,
    });
  });

  test.each([
    ['composite', 0],
    ['mip', 1],
    ['xray', 2],
    ['average', 2],
    ['iso', 3],
    ['window', 4],
  ])('maps %s to its stable shader style id', (reconstructionStyle, renderStyle) => {
    expect(getPt3ReconstructionUniformValues({ reconstructionStyle }).renderStyle).toBe(renderStyle);
  });

  test('falls back from unknown styles and clamps unsafe numeric values', () => {
    expect(normalizePt3ReconstructionOptions({
      reconstructionStyle: 'not-a-style',
      windowCenter: -4,
      windowWidth: 0,
      isoThreshold: 7,
      isoWidth: -1,
      boundaryEnhancement: true,
      boundaryStrength: 99,
      boundaryBandWidth: Number.NaN,
    })).toEqual({
      reconstructionStyle: 'composite',
      windowCenter: 0,
      windowWidth: 0.01,
      isoThreshold: 1,
      isoWidth: 0.001,
      boundaryEnhancement: true,
      boundaryStrength: 2,
      boundaryBandWidth: 0.08,
    });
    expect(PT3_RECONSTRUCTION_STYLE_IDS).toEqual({
      composite: 0,
      mip: 1,
      xray: 2,
      iso: 3,
      window: 4,
    });
  });

  test('parses persisted boolean representations without enabling false strings', () => {
    expect(normalizePt3ReconstructionOptions({ boundaryEnhancement: 'true' }).boundaryEnhancement)
      .toBe(true);
    expect(normalizePt3ReconstructionOptions({ boundaryEnhancement: '1' }).boundaryEnhancement)
      .toBe(true);
    expect(normalizePt3ReconstructionOptions({ boundaryEnhancement: 'false' }).boundaryEnhancement)
      .toBe(false);
    expect(normalizePt3ReconstructionOptions({ boundaryEnhancement: '0' }).boundaryEnhancement)
      .toBe(false);
    expect(normalizePt3ReconstructionOptions({ boundaryEnhancement: 'invalid' }).boundaryEnhancement)
      .toBe(false);
  });

  test('adapts large-volume steps to cover the complete ray within the fixed sample budget', () => {
    const requestedStepSize = 0.75 / 1024;
    const parameters = getPt3AdaptiveMarchParameters({
      requestedStepSize,
      rayExitDistance: 1,
      sampleStep: 0.75,
    });

    expect(PT3_MAX_RAY_MARCH_SAMPLES).toBe(512);
    expect(parameters.marchStep).toBeCloseTo(1 / 511, 12);
    expect(parameters.marchStep * (PT3_MAX_RAY_MARCH_SAMPLES - 1)).toBeCloseTo(1, 12);
    expect(parameters.effectiveSampleStep).toBeCloseTo(1024 / 511, 12);
  });

  test('retains nominal sampling when it already reaches the box exit', () => {
    expect(getPt3AdaptiveMarchParameters({
      requestedStepSize: 0.01,
      rayExitDistance: 1,
      sampleStep: 1.25,
    })).toEqual({ marchStep: 0.01, effectiveSampleStep: 1.25 });
  });

  test('reports observed texture dimensions and the device limit only when exceeded', () => {
    expect(getPt3TextureSizeLimitError([2048, 128, 64], 2048)).toBeNull();
    expect(getPt3TextureSizeLimitError([4096, 512, 200], 2048)).toBe(
      "PT3 volume texture dimensions 4096×512×200 exceed this device's WebGL MAX_3D_TEXTURE_SIZE limit of 2048 voxels per axis",
    );
    expect(getPt3TextureSizeLimitError([4096, 512, 200], null)).toBeNull();
  });

  test('preflights the combined volume and segmentation texture budget', () => {
    expect(PT3_MAX_BROWSER_VOLUME_TEXTURE_BYTES).toBe(512 * 1024 * 1024);
    expect(getPt3TextureAllocationLimitError([512, 512, 512])).toBeNull();
    expect(getPt3TextureAllocationLimitError([512, 512, 512], {
      includeSegmentation: true,
      byteLimit: 128 * 1024 * 1024,
    })).toBe(
      'PT3 volume texture dimensions 512×512×512 require an estimated 518.0 MiB of browser decode, staging, and 3D-texture memory, exceeding the built-in 128.0 MiB browser volume budget',
    );
  });

  test('keeps projection density bounded and responsive across the complete UI range', () => {
    const lowDensity = getPt3BoundedProjectionOpacity(1, 0.25);
    const highDensity = getPt3BoundedProjectionOpacity(1, 2.5);
    expect(lowDensity).toBeCloseTo(1 - Math.exp(-0.25), 12);
    expect(highDensity).toBeCloseTo(1 - Math.exp(-2.5), 12);
    expect(lowDensity).toBeGreaterThan(0);
    expect(highDensity).toBeGreaterThan(lowDensity);
    expect(highDensity).toBeLessThan(1);
    expect(getPt3BoundedProjectionOpacity(4, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('PT3 reconstruction fragment shader', () => {
  test('marches from the camera-facing entry surface toward the far exit', () => {
    expect(PT3_THREE_RENDERER_SOURCE).toMatch(/side:\s*THREE\.FrontSide\b/);
    expect(PT3_VOLUME_FRAGMENT_SHADER).toMatch(
      /vec3\s+ray\s*=\s*normalize\(\s*localPosition\s*-\s*cameraLocal\s*\)\s*;/,
    );
    expect(PT3_VOLUME_FRAGMENT_SHADER).not.toMatch(
      /normalize\(\s*cameraLocal\s*-\s*localPosition\s*\)/,
    );
  });

  test('declares premultiplied blending for alpha-weighted shader output', () => {
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain(
      'accumulated.rgb += (1.0 - accumulated.a) * alpha * color',
    );
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('vec4(maximumColor * alpha, alpha)');
    expect(PT3_VOLUME_MATERIAL_OPTIONS).toEqual(expect.objectContaining({
      transparent: true,
      premultipliedAlpha: true,
    }));
    expect(PT3_THREE_RENDERER_SOURCE).toMatch(
      /new THREE\.ShaderMaterial\(\{[\s\S]*?\.\.\.PT3_VOLUME_MATERIAL_OPTIONS,[\s\S]*?fragmentShader:\s*PT3_VOLUME_FRAGMENT_SHADER/,
    );
  });

  test('contains bounded composite, MIP, X-ray, iso, and window paths', () => {
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('for (int i = 0; i < 512; i++)');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('renderStyle == 1');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('maximumValue = value');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('renderStyle == 2');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('averageValue = xrayValueTotal / xraySampleCount');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('renderStyle == 3');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('abs(value - isoThreshold)');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('renderStyle == 4');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('windowCenter - halfWindow');
  });

  test('adapts the march step to the per-fragment box exit and uses it for every increment', () => {
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('float rayBoxExitDistance');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('exitDistance / 511.0');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('float effectiveSampleStep = sampleStep * marchStep');
    expect(PT3_VOLUME_FRAGMENT_SHADER.match(/samplePoint \+= ray \* marchStep/g)).toHaveLength(2);
    expect(PT3_VOLUME_FRAGMENT_SHADER).not.toContain('samplePoint += ray * stepSize');
  });

  test('retains the legacy composite transfer and sample-step safeguards', () => {
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain(
      'smoothstep(intensityThreshold, min(1.0, intensityThreshold + opacityRampWidth), value)',
    );
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('* 0.075 * opacityMultiplier * effectiveSampleStep');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain(
      'accumulated.rgb += (1.0 - accumulated.a) * alpha * color',
    );
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('samplePoint += ray * marchStep');
  });

  test('uses central differences for opt-in boundary opacity/color and iso lighting', () => {
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('vec3 centralDifferenceGradient(vec3 point)');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('(forwardPoint - backwardPoint) * physicalSize');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('/ physicalSpan');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('normalize(ray * physicalSize)');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('alpha *= 1.0 + boost');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('color = mix(color, colorHigh');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('if (!boundaryEnhancement || alpha <= 0.0) return');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('if (boundaryEnhancement && alpha > 0.0)');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('boundaryStrength * 0.5');
  });

  test('bounds opacity before compositing and keeps projection density responsive', () => {
    expect(PT3_VOLUME_FRAGMENT_SHADER.match(/alpha = clamp\(alpha, 0\.0, 1\.0\)/g))
      .toHaveLength(3);
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('1.0 - exp(-opticalDepth)');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('boundedProjectionOpacity(transferResponse)');
  });

  test('continues to hide excluded segments and color visible segments in shared traversal', () => {
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('if (segmentState > 1.5)');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('continue;');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('segmentColor = texture(segmentationPalette, palettePoint)');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('color = segmentColor.rgb');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('vec4 segmentProjection = vec4(0.0)');
    expect(PT3_VOLUME_FRAGMENT_SHADER).toContain('addProjectionOverlay');
  });
});
