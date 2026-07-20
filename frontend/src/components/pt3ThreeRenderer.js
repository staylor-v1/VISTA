let threeModulePromise = null;

export function loadThree() {
  if (!threeModulePromise) {
    threeModulePromise = import('three');
  }
  return threeModulePromise;
}

export async function createThreeMechanicalRenderer(canvas, { metadata, mode }) {
  if (!canvas) return null;
  const THREE = await loadThree();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 10000);
  camera.position.set(0, 0, 260);
  scene.add(new THREE.AmbientLight(0xffffff, 0.72));
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.85);
  keyLight.position.set(1, 1, 2);
  scene.add(keyLight);

  const dimensions = metadata?.dimensions || [1, 1, 1];
  const spacing = metadata?.spacing || [1, 1, 1];
  const size = dimensions.map((value, axis) => Math.max(1, value * spacing[axis]));
  const geometry = new THREE.BoxGeometry(size[0], size[1], size[2]);
  const material = new THREE.MeshStandardMaterial({ color: mode === 'volume' ? 0x94a3b8 : 0x60a5fa, metalness: 0.55, roughness: 0.36, transparent: true, opacity: mode === 'splat' ? 0.18 : 0.42 });
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);

  return {
    rendererType: 'three-webgl',
    render({ width, height, rotation, zoom }) {
      const safeWidth = Math.max(1, width || canvas.clientWidth || 1);
      const safeHeight = Math.max(1, height || canvas.clientHeight || 1);
      renderer.setSize(safeWidth, safeHeight, false);
      camera.aspect = safeWidth / safeHeight;
      camera.updateProjectionMatrix();
      mesh.rotation.x = (rotation?.x || 0) * Math.PI / 180;
      mesh.rotation.y = (rotation?.y || 0) * Math.PI / 180;
      const maxSize = Math.max(...size, 1);
      camera.position.z = (maxSize * 2.2) / Math.max(0.2, zoom || 1);
      renderer.render(scene, camera);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    },
  };
}
