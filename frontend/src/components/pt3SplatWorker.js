/* eslint-env worker */
/* eslint-disable no-restricted-globals */
function parsePly(text) {
  const lines = text.split(/\r?\n/);
  const end = lines.findIndex((line) => line.trim() === 'end_header');
  const countLine = lines.find((line) => line.startsWith('element vertex '));
  const count = Number(countLine?.split(/\s+/).pop() || 0);
  const positions = [];
  const scales = [];
  const colors = [];
  for (let index = end + 1; index < lines.length && positions.length / 3 < count; index += 1) {
    const values = lines[index].trim().split(/\s+/).map(Number);
    if (values.length >= 8 && values.slice(0, 8).every(Number.isFinite)) {
      positions.push(values[0], values[1], values[2]);
      scales.push(values[3]);
      colors.push(values[5] / 255, values[6] / 255, values[7] / 255, Math.max(0, Math.min(1, values[4])));
    }
  }
  return { positions: new Float32Array(positions), scales: new Float32Array(scales), colors: new Float32Array(colors), layers: [{ id: 'baked', label: 'Baked splats', count: positions.length / 3, visible: true, opacity: 1 }] };
}

function parseJson(text) {
  const payload = JSON.parse(text);
  const splats = Array.isArray(payload.splats) ? payload.splats : [];
  const positions = new Float32Array(splats.length * 3);
  const scales = new Float32Array(splats.length);
  const colors = new Float32Array(splats.length * 4);
  const layerCounts = new Map();
  splats.forEach((splat, index) => {
    positions.set([Number(splat.x) || 0, Number(splat.y) || 0, Number(splat.z) || 0], index * 3);
    scales[index] = Number.isFinite(Number(splat.scale)) ? Number(splat.scale) : 1;
    colors.set([(Number(splat.red) || 0) / 255, (Number(splat.green) || 0) / 255, (Number(splat.blue) || 0) / 255, Number(splat.opacity) || 0.5], index * 4);
    const layer = String(splat.layer || (Number(splat.intensity) > 180 ? 'bone' : Number(splat.intensity) < 80 ? 'lung' : 'soft'));
    layerCounts.set(layer, (layerCounts.get(layer) || 0) + 1);
  });
  return { positions, scales, colors, layers: [...layerCounts].map(([id, count]) => ({ id, label: id, count, visible: true, opacity: 1 })), metadata: payload.metadata || {} };
}

self.onmessage = async (event) => {
  const { id, url } = event.data || {};
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const parsed = text.trim().startsWith('{') ? parseJson(text) : parsePly(text);
    self.postMessage({ id, ok: true, ...parsed }, [parsed.positions.buffer, parsed.scales.buffer, parsed.colors.buffer]);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error.message || 'Failed to parse splat asset' });
  }
};
