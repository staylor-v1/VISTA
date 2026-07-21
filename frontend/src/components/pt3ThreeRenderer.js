import {
  getPt3CameraClippingRange,
  getPt3CameraDistance,
  getPt3ViewSize,
  getPt3WorldScale,
  PT3_VIEW_CAMERA_FOV_DEGREES,
} from './pt3VolumeGeometry';
import { segmentColorToRgba } from './pt3Segmentation';

let threeModulePromise = null;

export function loadThree() {
  if (!threeModulePromise) threeModulePromise = import('three');
  return threeModulePromise;
}

function loadImage(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load volume slice ${source.filename || source.id || ''}`));
    image.src = source.url;
  });
}

async function createVolumeTexture(THREE, volumeImageStack) {
  const ordered = [...volumeImageStack].sort((a, b) => Number(a.sliceIndex || 0) - Number(b.sliceIndex || 0));
  if (ordered.length === 0) throw new Error('No volume stack images are available');
  const images = await Promise.all(ordered.map(loadImage));
  const width = images[0].naturalWidth || images[0].width;
  const height = images[0].naturalHeight || images[0].height;
  if (!width || !height) throw new Error('Volume slices have invalid dimensions');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas image decoding is unavailable');
  const voxels = new Uint8Array(width * height * images.length);
  images.forEach((image, z) => {
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const rgba = context.getImageData(0, 0, width, height).data;
    for (let index = 0; index < width * height; index += 1) {
      const offset = index * 4;
      voxels[z * width * height + index] = Math.round(rgba[offset] * 0.2126 + rgba[offset + 1] * 0.7152 + rgba[offset + 2] * 0.0722);
    }
  });
  const texture = new THREE.Data3DTexture(voxels, width, height, images.length);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

async function createSegmentationTexture(THREE, labelSlices, volumeImageStack, width, height, depth) {
  if (!Array.isArray(labelSlices) || labelSlices.length === 0) return null;
  const inlineLabelSlices = labelSlices.filter((slice) => Array.isArray(slice?.labels) || ArrayBuffer.isView(slice?.labels));
  if (inlineLabelSlices.length === 0) return null;
  const labels = new Uint8Array(width * height * depth);
  const orderedVolume = [...volumeImageStack].sort((a, b) => Number(a.sliceIndex || 0) - Number(b.sliceIndex || 0));
  const sliceIndexToDepth = new Map(orderedVolume.map((slice, index) => [String(slice.sliceIndex ?? index), index]));
  if (inlineLabelSlices.length !== depth) {
    throw new Error(`Segmentation label depth ${inlineLabelSlices.length} does not match volume depth ${depth}`);
  }
  const seenDepths = new Set();
  inlineLabelSlices.forEach((slice, fallbackIndex) => {
    const z = sliceIndexToDepth.get(String(slice?.sliceIndex)) ?? fallbackIndex;
    if (z < 0 || z >= depth || seenDepths.has(z)) {
      throw new Error(`Segmentation label slice ${slice?.sliceIndex ?? fallbackIndex} is duplicated or outside the volume`);
    }
    seenDepths.add(z);
    const targetOffset = z * width * height;
    if (slice.labels.length !== width * height) throw new Error(`Segmentation label slice ${z} has invalid dimensions`);
    for (let index = 0; index < width * height; index += 1) {
      const label = Number(slice.labels[index]);
      if (!Number.isInteger(label) || label < 0 || label > 255) throw new Error(`Segmentation label slice ${z} contains an invalid label`);
      labels[targetOffset + index] = label;
    }
  });
  const texture = new THREE.Data3DTexture(labels, width, height, depth);
  texture.format = THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

function createSegmentationPaletteTexture(THREE) {
  const data = new Uint8Array(256 * 4);
  const texture = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

function createSegmentationStateTexture(THREE) {
  const data = new Uint8Array(256);
  const texture = new THREE.DataTexture(data, 256, 1, THREE.RedFormat, THREE.UnsignedByteType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  return texture;
}

function updateSegmentationPalette(texture, stateTexture, segments = []) {
  const data = texture.image.data;
  const states = stateTexture.image.data;
  data.fill(0);
  states.fill(0);
  segments.forEach((segment) => {
    const id = Number(segment.id);
    if (!Number.isInteger(id) || id < 1 || id > 255) return;
    states[id] = segment.visible === false ? 2 : 1;
    if (segment.visible === false) return;
    const [red, green, blue, alpha] = segmentColorToRgba(segment.color, segment.opacity);
    const offset = id * 4;
    data[offset] = Math.round(red);
    data[offset + 1] = Math.round(green);
    data[offset + 2] = Math.round(blue);
    data[offset + 3] = Math.round(alpha * 255);
  });
  texture.needsUpdate = true;
  stateTexture.needsUpdate = true;
}

export async function createThreeMechanicalRenderer(canvas, {
  metadata,
  mode,
  volumeImageStack = [],
  segmentationLabelSlices = [],
}) {
  if (!canvas || mode === 'splat') return null;
  const THREE = await loadThree();
  const volumeTexture = await createVolumeTexture(THREE, volumeImageStack);
  const volumeWidth = volumeTexture.image?.width || 1;
  const volumeHeight = volumeTexture.image?.height || 1;
  const volumeDepth = volumeTexture.image?.depth || volumeImageStack.length || 1;
  const segmentationTexture = await createSegmentationTexture(
    THREE,
    segmentationLabelSlices,
    volumeImageStack,
    volumeWidth,
    volumeHeight,
    volumeDepth,
  );
  const segmentationPaletteTexture = createSegmentationPaletteTexture(THREE);
  const segmentationStateTexture = createSegmentationStateTexture(THREE);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  const scene = new THREE.Scene();
  const clipping = getPt3CameraClippingRange(metadata);
  const camera = new THREE.PerspectiveCamera(
    PT3_VIEW_CAMERA_FOV_DEGREES,
    1,
    clipping.near,
    clipping.far,
  );
  camera.position.set(0, 0, 260);
  const dimensions = metadata?.dimensions || [1, 1, 1];
  const spacing = metadata?.spacing || [1, 1, 1];
  const size = getPt3ViewSize(metadata);
  const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
  const presetColors = {
    machinedMetal: [[0.24, 0.36, 0.48], [0.96, 0.98, 1]],
    composite: [[0.06, 0.42, 0.4], [0.86, 1, 0.96]],
    defect: [[0.75, 0.2, 0.08], [1, 0.88, 0.72]],
  };
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      volumeMap: { value: volumeTexture },
      segmentationMap: { value: segmentationTexture || volumeTexture },
      segmentationPalette: { value: segmentationPaletteTexture },
      segmentationState: { value: segmentationStateTexture },
      hasSegmentation: { value: Boolean(segmentationTexture) },
      cameraLocal: { value: new THREE.Vector3() },
      stepSize: { value: 1 / Math.max(...dimensions, 1) },
      sampleStep: { value: 1.25 },
      opacityMultiplier: { value: 1.25 },
      intensityThreshold: { value: 0.08 },
      colorLow: { value: new THREE.Vector3(...presetColors.machinedMetal[0]) },
      colorHigh: { value: new THREE.Vector3(...presetColors.machinedMetal[1]) },
    },
    vertexShader: `
      out vec3 localPosition;
      void main() {
        localPosition = position / vec3(${size[0].toFixed(8)}, ${size[1].toFixed(8)}, ${size[2].toFixed(8)});
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      precision highp sampler3D;
      uniform sampler3D volumeMap;
      uniform sampler3D segmentationMap;
      uniform sampler2D segmentationPalette;
      uniform sampler2D segmentationState;
      uniform bool hasSegmentation;
      uniform vec3 cameraLocal;
      uniform float stepSize;
      uniform float sampleStep;
      uniform float opacityMultiplier;
      uniform float intensityThreshold;
      uniform vec3 colorLow;
      uniform vec3 colorHigh;
      in vec3 localPosition;
      out vec4 outputColor;
      void main() {
        vec3 ray = normalize(cameraLocal - localPosition);
        vec3 samplePoint = localPosition + vec3(0.5);
        vec4 accumulated = vec4(0.0);
        for (int i = 0; i < 512; i++) {
          if (any(lessThan(samplePoint, vec3(0.0))) || any(greaterThan(samplePoint, vec3(1.0))) || accumulated.a > 0.98) break;
          float value = texture(volumeMap, samplePoint).r;
          float alpha = smoothstep(intensityThreshold, min(1.0, intensityThreshold + 0.52), value)
            * 0.075 * opacityMultiplier * sampleStep;
          vec3 color = mix(colorLow, colorHigh, smoothstep(intensityThreshold, 1.0, value));
          if (hasSegmentation) {
            float label = floor(texture(segmentationMap, samplePoint).r * 255.0 + 0.5);
            if (label > 0.5) {
              vec2 palettePoint = vec2((label + 0.5) / 256.0, 0.5);
              float segmentState = floor(texture(segmentationState, palettePoint).r * 255.0 + 0.5);
              if (segmentState > 1.5) {
                samplePoint += ray * stepSize;
                continue;
              }
              if (segmentState > 0.5) {
                vec4 segmentColor = texture(segmentationPalette, palettePoint);
                color = segmentColor.rgb;
                alpha *= segmentColor.a;
              }
            }
          }
          accumulated.rgb += (1.0 - accumulated.a) * alpha * color;
          accumulated.a += (1.0 - accumulated.a) * alpha;
          samplePoint += ray * stepSize;
        }
        outputColor = accumulated;
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  const volumeGroup = new THREE.Group();
  volumeGroup.add(mesh);

  const boundsMaterial = new THREE.LineBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.34 });
  const boundsGeometry = new THREE.EdgesGeometry(geometry);
  volumeGroup.add(new THREE.LineSegments(boundsGeometry, boundsMaterial));

  const createSliceGuide = (color, points) => {
    const guideGeometry = new THREE.BufferGeometry().setFromPoints(points.map((point) => new THREE.Vector3(...point)));
    const guideMaterial = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.82, depthTest: false });
    const guide = new THREE.LineLoop(guideGeometry, guideMaterial);
    guide.renderOrder = 2;
    volumeGroup.add(guide);
    return { guide, guideGeometry, guideMaterial };
  };
  const sliceGuides = {
    axial: createSliceGuide(0x3b82f6, [[-size[0] / 2, -size[1] / 2, 0], [size[0] / 2, -size[1] / 2, 0], [size[0] / 2, size[1] / 2, 0], [-size[0] / 2, size[1] / 2, 0]]),
    coronal: createSliceGuide(0xf59e0b, [[-size[0] / 2, 0, -size[2] / 2], [size[0] / 2, 0, -size[2] / 2], [size[0] / 2, 0, size[2] / 2], [-size[0] / 2, 0, size[2] / 2]]),
    sagittal: createSliceGuide(0x10b981, [[0, -size[1] / 2, -size[2] / 2], [0, size[1] / 2, -size[2] / 2], [0, size[1] / 2, size[2] / 2], [0, -size[1] / 2, size[2] / 2]]),
  };
  scene.add(volumeGroup);
  const inverseMatrix = new THREE.Matrix4();
  const sizeVector = new THREE.Vector3(...size);

  const sliceOffset = (value, dimension, axisSpacing) => {
    const upper = Math.max(0, Number(dimension) - 1);
    const clamped = Math.min(upper, Math.max(0, Number(value) || 0));
    return (clamped - upper / 2) * axisSpacing;
  };

  return {
    rendererType: 'three-webgl-raymarch',
    render({ width, height, rotation, zoom, mirrorScale, volumeOpacity, presetKey, intensityThreshold, sampleStep, slicePosition, showSliceGuides, segmentationPalette }) {
      const safeWidth = Math.max(1, width || canvas.clientWidth || 1);
      const safeHeight = Math.max(1, height || canvas.clientHeight || 1);
      renderer.setSize(safeWidth, safeHeight, false);
      camera.aspect = safeWidth / safeHeight;
      camera.zoom = Math.min(4, Math.max(0.2, Number(zoom) || 1));
      camera.updateProjectionMatrix();
      volumeGroup.rotation.x = (rotation?.x || 0) * Math.PI / 180;
      volumeGroup.rotation.y = (rotation?.y || 0) * Math.PI / 180;
      const worldScale = getPt3WorldScale(mirrorScale);
      volumeGroup.scale.set(worldScale.x, worldScale.y, worldScale.z);
      // Keep the camera outside the rotated volume at every zoom level. Three's
      // optical zoom changes framing without dollying through the volume.
      camera.position.z = getPt3CameraDistance(metadata);
      sliceGuides.axial.guide.position.z = sliceOffset(slicePosition?.axial, dimensions[2], spacing[2]);
      sliceGuides.coronal.guide.position.y = sliceOffset(slicePosition?.coronal, dimensions[1], spacing[1]);
      sliceGuides.sagittal.guide.position.x = sliceOffset(slicePosition?.sagittal, dimensions[0], spacing[0]);
      Object.values(sliceGuides).forEach(({ guide }) => { guide.visible = Boolean(showSliceGuides); });
      volumeGroup.updateMatrixWorld();
      inverseMatrix.copy(volumeGroup.matrixWorld).invert();
      material.uniforms.cameraLocal.value.copy(camera.position).applyMatrix4(inverseMatrix).divide(sizeVector);
      material.uniforms.opacityMultiplier.value = Math.max(0, Number(volumeOpacity) || 0);
      material.uniforms.intensityThreshold.value = Math.min(0.95, Math.max(0, Number(intensityThreshold) || 0));
      const safeSampleStep = Math.min(3, Math.max(0.5, Number(sampleStep) || 1.25));
      material.uniforms.sampleStep.value = safeSampleStep;
      material.uniforms.stepSize.value = safeSampleStep / Math.max(...dimensions, 1);
      updateSegmentationPalette(segmentationPaletteTexture, segmentationStateTexture, segmentationPalette);
      const colors = presetColors[presetKey] || presetColors.machinedMetal;
      material.uniforms.colorLow.value.set(...colors[0]);
      material.uniforms.colorHigh.value.set(...colors[1]);
      renderer.render(scene, camera);
    },
    dispose() {
      volumeTexture.dispose();
      segmentationTexture?.dispose();
      segmentationPaletteTexture.dispose();
      segmentationStateTexture.dispose();
      geometry.dispose();
      material.dispose();
      boundsGeometry.dispose();
      boundsMaterial.dispose();
      Object.values(sliceGuides).forEach(({ guideGeometry, guideMaterial }) => {
        guideGeometry.dispose();
        guideMaterial.dispose();
      });
      renderer.dispose();
    },
  };
}
