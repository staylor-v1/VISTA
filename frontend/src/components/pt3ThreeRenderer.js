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

export async function createThreeMechanicalRenderer(canvas, { metadata, mode, volumeImageStack = [] }) {
  if (!canvas || mode === 'splat') return null;
  const THREE = await loadThree();
  const volumeTexture = await createVolumeTexture(THREE, volumeImageStack);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 10000);
  camera.position.set(0, 0, 260);
  const dimensions = metadata?.dimensions || [1, 1, 1];
  const spacing = metadata?.spacing || [1, 1, 1];
  const size = dimensions.map((value, axis) => Math.max(1, value * spacing[axis]));
  const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
  const material = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      volumeMap: { value: volumeTexture },
      cameraLocal: { value: new THREE.Vector3() },
      stepSize: { value: 1 / Math.max(...dimensions, 1) },
      opacityMultiplier: { value: 0.68 },
      intensityThreshold: { value: 0.10 },
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
      uniform vec3 cameraLocal;
      uniform float stepSize;
      uniform float opacityMultiplier;
      uniform float intensityThreshold;
      in vec3 localPosition;
      out vec4 outputColor;
      void main() {
        vec3 ray = normalize(cameraLocal - localPosition);
        vec3 samplePoint = localPosition + vec3(0.5);
        vec4 accumulated = vec4(0.0);
        for (int i = 0; i < 512; i++) {
          if (any(lessThan(samplePoint, vec3(0.0))) || any(greaterThan(samplePoint, vec3(1.0))) || accumulated.a > 0.98) break;
          float value = texture(volumeMap, samplePoint).r;
          float alpha = smoothstep(intensityThreshold, 0.72, value) * 0.055 * opacityMultiplier;
          vec3 color = mix(vec3(0.08, 0.32, 0.55), vec3(0.94, 0.97, 1.0), value);
          accumulated.rgb += (1.0 - accumulated.a) * alpha * color;
          accumulated.a += (1.0 - accumulated.a) * alpha;
          samplePoint += ray * stepSize;
        }
        outputColor = accumulated;
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  const inverseMatrix = new THREE.Matrix4();

  return {
    rendererType: 'three-webgl-raymarch',
    render({ width, height, rotation, zoom, volumeOpacity, presetKey }) {
      const safeWidth = Math.max(1, width || canvas.clientWidth || 1);
      const safeHeight = Math.max(1, height || canvas.clientHeight || 1);
      renderer.setSize(safeWidth, safeHeight, false);
      camera.aspect = safeWidth / safeHeight;
      camera.updateProjectionMatrix();
      mesh.rotation.x = (rotation?.x || 0) * Math.PI / 180;
      mesh.rotation.y = (rotation?.y || 0) * Math.PI / 180;
      camera.position.z = (Math.max(...size, 1) * 2.2) / Math.max(0.2, zoom || 1);
      mesh.updateMatrixWorld();
      inverseMatrix.copy(mesh.matrixWorld).invert();
      material.uniforms.cameraLocal.value.copy(camera.position).applyMatrix4(inverseMatrix).divide(new THREE.Vector3(...size));
      material.uniforms.opacityMultiplier.value = Math.max(0, Number(volumeOpacity) || 0);
      material.uniforms.intensityThreshold.value = ({ machinedMetal: 0.10, composite: 0.18, defect: 0.32 })[presetKey] ?? 0.10;
      renderer.render(scene, camera);
    },
    dispose() {
      volumeTexture.dispose(); geometry.dispose(); material.dispose(); renderer.dispose();
    },
  };
}
