import React, { useEffect, useMemo, useRef, useState } from 'react';
import { generateTransferFunctionLut } from './pt3TransferFunctions';
import { getPhysicalBounds, pointInsideCropBox } from './pt3VolumeGeometry';
import { createThreeMechanicalRenderer } from './pt3ThreeRenderer';
import { MECHANICAL_TRANSFER_PRESETS, getMechanicalCropBox, getMechanicalVolumeMetadata, makeMechanicalFallbackSplats } from './pt3MechanicalVisualization';

const SPLAT_METADATA_KEYS = ['gaussian_splat_url', 'gaussian_splat_asset_url', 'splat_url', 'splat_asset_url', 'point_cloud_url'];
const VIEWER_MODES = { volume: 'volume', splat: 'splat', hybrid: 'hybrid' };
const QUALITY_PROFILES = { performance: { sampleStep: 2.5, scale: 0.65 }, balanced: { sampleStep: 1.25, scale: 0.85 }, quality: { sampleStep: 0.75, scale: 1 } };

function isPlainObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function firstString(...values) { return values.find((value) => typeof value === 'string' && value.trim())?.trim() || ''; }
function getNestedSplatUrl(metadata) {
  for (const candidate of [metadata?.gaussian_splat, metadata?.splat, metadata?.point_cloud]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    if (isPlainObject(candidate)) {
      const url = firstString(candidate.url, candidate.asset_url, candidate.href, candidate.path);
      if (url) return url;
    }
  }
  return '';
}

export function getPt3GaussianSplatAsset(part) {
  const metadata = isPlainObject(part?.metadata) ? part.metadata : {};
  const generatedAsset = isPlainObject(metadata.pt3_splat_asset) ? metadata.pt3_splat_asset : null;
  if (generatedAsset?.status === 'ready') {
    const generatedUrl = firstString(generatedAsset.asset_url, generatedAsset.url);
    if (generatedUrl) return { url: generatedUrl, label: 'preprocessed splat asset' };
  }
  const directUrl = firstString(...SPLAT_METADATA_KEYS.map((key) => metadata[key]), getNestedSplatUrl(metadata));
  if (directUrl) return { url: directUrl, label: 'part metadata' };
  const splatRecord = (Array.isArray(metadata.source_images) ? metadata.source_images : []).find((record) => {
    const filename = String(record?.filename || '').toLowerCase();
    const kind = String(record?.kind || record?.asset_type || record?.metadata?.kind || record?.metadata?.asset_type || '').toLowerCase();
    return kind.includes('splat') || kind.includes('point_cloud') || /\.(splat|ply|ksplat|spz)(\?|$)/i.test(filename);
  });
  if (!splatRecord) return null;
  const recordUrl = firstString(splatRecord.url, splatRecord.asset_url, splatRecord.href, splatRecord.metadata?.url, splatRecord.metadata?.asset_url);
  return recordUrl ? { url: recordUrl, label: splatRecord.filename || 'splat source image' } : null;
}


function createSplatWorker() {
  const source = `
    function parsePly(text){const lines=text.split(/\\r?\\n/);const end=lines.findIndex((line)=>line.trim()==='end_header');const countLine=lines.find((line)=>line.startsWith('element vertex '));const count=Number((countLine||'').split(/\\s+/).pop()||0);const positions=[];const colors=[];for(let index=end+1;index<lines.length&&positions.length/3<count;index+=1){const values=lines[index].trim().split(/\\s+/).map(Number);if(values.length>=8&&values.slice(0,8).every(Number.isFinite)){positions.push(values[0],values[1],values[2]);colors.push(values[5]/255,values[6]/255,values[7]/255,Math.max(0,Math.min(1,values[4])));}}return {positions:new Float32Array(positions),colors:new Float32Array(colors),layers:[{id:'baked',label:'Baked splats',count:positions.length/3,visible:true,opacity:1}]};}
    function parseJson(text){const payload=JSON.parse(text);const splats=Array.isArray(payload.splats)?payload.splats:[];const positions=new Float32Array(splats.length*3);const colors=new Float32Array(splats.length*4);const layerCounts=new Map();splats.forEach((splat,index)=>{positions.set([Number(splat.x)||0,Number(splat.y)||0,Number(splat.z)||0],index*3);colors.set([(Number(splat.red)||0)/255,(Number(splat.green)||0)/255,(Number(splat.blue)||0)/255,Number(splat.opacity)||0.5],index*4);const layer=String(splat.layer||(Number(splat.intensity)>180?'surface':Number(splat.intensity)<80?'void':'core'));layerCounts.set(layer,(layerCounts.get(layer)||0)+1);});return {positions,colors,layers:[...layerCounts].map(([id,count])=>({id,label:id,count,visible:true,opacity:1})),metadata:payload.metadata||{}};}
    self.onmessage=async(event)=>{const {id,url}=event.data||{};try{const response=await fetch(url);if(!response.ok)throw new Error('HTTP '+response.status);const text=await response.text();const parsed=text.trim().startsWith('{')?parseJson(text):parsePly(text);self.postMessage({id,ok:true,...parsed},[parsed.positions.buffer,parsed.colors.buffer]);}catch(error){self.postMessage({id,ok:false,error:error.message||'Failed to parse splat asset'});}};
  `;
  return new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
}

function buildMetadata(part) {
  return getMechanicalVolumeMetadata(part);
}

function renderPreview(ctx, { mode, metadata, splats, rotation, zoom, preset, crop, volumeOpacity, splatOpacity, statsRef }) {
  if (!ctx?.canvas) return;
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  const cx = width / 2; const cy = height / 2;
  const bounds = getPhysicalBounds(metadata);
  const scale = Math.min(width, height) / Math.max(...bounds.size, 1) * 0.72 * zoom;
  const lut = generateTransferFunctionLut({ preset, scalarRange: metadata.scalarRange, opacityMultiplier: volumeOpacity });
  const project = (p) => {
    const x = p[0] - bounds.min[0] - bounds.size[0] / 2;
    const y = p[1] - bounds.min[1] - bounds.size[1] / 2;
    const z = p[2] - bounds.min[2] - bounds.size[2] / 2;
    const ry = rotation.y * Math.PI / 180; const rx = rotation.x * Math.PI / 180;
    const xz = x * Math.cos(ry) - z * Math.sin(ry);
    const zz = x * Math.sin(ry) + z * Math.cos(ry);
    const yz = y * Math.cos(rx) - zz * Math.sin(rx);
    return [cx + xz * scale, cy + yz * scale, zz];
  };
  if (mode !== VIEWER_MODES.splat) {
    for (let i = 0; i < 56; i += 1) {
      const t = i / 55;
      const colorIndex = Math.min(255, Math.max(0, Math.round(t * 255))) * 4;
      ctx.fillStyle = `rgba(${lut[colorIndex]},${lut[colorIndex + 1]},${lut[colorIndex + 2]},${(lut[colorIndex + 3] / 255) * 0.16})`;
      const w = bounds.size[0] * scale * (0.25 + t * 0.7);
      const h = bounds.size[1] * scale * (0.18 + (1 - t) * 0.62);
      ctx.beginPath(); ctx.ellipse(cx, cy, w / 2, h / 2, rotation.y * Math.PI / 360, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (mode !== VIEWER_MODES.volume && splats?.positions) {
    let rendered = 0;
    for (let i = 0; i < splats.positions.length; i += 3) {
      const point = [splats.positions[i], splats.positions[i + 1], splats.positions[i + 2]];
      if (!pointInsideCropBox(point, crop)) continue;
      const [x, y, z] = project(point); const ci = (i / 3) * 4;
      ctx.fillStyle = `rgba(${Math.round((splats.colors?.[ci] ?? 0.4) * 255)},${Math.round((splats.colors?.[ci + 1] ?? 0.8) * 255)},${Math.round((splats.colors?.[ci + 2] ?? 1) * 255)},${(splats.colors?.[ci + 3] ?? 0.7) * splatOpacity})`;
      ctx.beginPath(); ctx.arc(x, y, Math.max(1.4, 4 - z * 0.003), 0, Math.PI * 2); ctx.fill(); rendered += 1;
    }
    statsRef.current.renderedSplats = rendered;
  }
  ctx.strokeStyle = 'rgba(226,232,240,0.72)'; ctx.lineWidth = 1; ctx.strokeRect(cx - bounds.size[0] * scale / 2, cy - bounds.size[1] * scale / 2, bounds.size[0] * scale, bounds.size[1] * scale);
  ctx.fillStyle = '#bae6fd'; ctx.fillText('R', width - 24, cy); ctx.fillText('S', cx, 18); ctx.fillText('A', cx + 22, cy + 24);
}

export default function Pt3GaussianSplatViewer({ part, projectId, splatParameters, initialMode = VIEWER_MODES.hybrid }) {
  const canvasRef = useRef(null);
  const webglCanvasRef = useRef(null);
  const threeRendererRef = useRef(null);
  const workerRef = useRef(null);
  const statsRef = useRef({ frames: 0, fps: 0, renderedSplats: 0 });
  const [mode, setMode] = useState(initialMode);
  useEffect(() => { setMode(initialMode); }, [initialMode]);
  const [presetKey, setPresetKey] = useState('machinedMetal');
  const [quality, setQuality] = useState('balanced');
  const [status, setStatus] = useState('initializing');
  const [statusDetail, setStatusDetail] = useState(null);
  const [rendererType, setRendererType] = useState('canvas2d-fallback');
  const [splats, setSplats] = useState(null);
  const [rotation, setRotation] = useState({ x: -18, y: 32 });
  const [zoom, setZoom] = useState(1);
  const [cropEnabled, setCropEnabled] = useState(false);
  const [volumeOpacity, setVolumeOpacity] = useState(0.68);
  const [splatOpacity, setSplatOpacity] = useState(0.9);
  const metadata = useMemo(() => buildMetadata(part), [part]);
  const asset = useMemo(() => getPt3GaussianSplatAsset(part), [part]);

  useEffect(() => {
    let cancelled = false;
    const requestId = `${Date.now()}-${Math.random()}`;
    setStatus('loading'); setStatusDetail(null);
    if (!asset?.url) {
      if (projectId && part?.id) {
        fetch(`/api/projects/${encodeURIComponent(projectId)}/parts/${encodeURIComponent(part.id)}/volume-splat-assets/status`)
          .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
          .then((payload) => {
            if (cancelled) return;
            setStatusDetail(payload);
            if (payload.status === 'pending') { setStatus('pending'); return; }
            if (payload.status === 'failed') { setStatus('failed'); return; }
            if (payload.status === 'ready' && payload.asset_url) { setSplats(makeMechanicalFallbackSplats(metadata)); setStatus('ready'); return; }
            return fetch(`/api/projects/${encodeURIComponent(projectId)}/parts/${encodeURIComponent(part.id)}/volume-splat-assets`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ source_image_ids: [], transfer_function: { threshold: Number(splatParameters?.threshold) || 1, intensity_min: Number(splatParameters?.intensityMin) || 0, intensity_max: Number(splatParameters?.intensityMax) || 255, opacity_min: Number(splatParameters?.opacityMin) || 0.05, opacity_max: Number(splatParameters?.opacityMax) || 1, color_map: 'grayscale' }, downsample: Number(splatParameters?.downsample) || 1, max_splats: Number(splatParameters?.maxSplats) || 100000, output_format: splatParameters?.outputFormat || 'json' }),
            }).then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }).then((payload2) => { if (!cancelled) { setStatusDetail(payload2); setStatus(payload2.status === 'pending' ? 'pending' : payload2.status || 'pending'); } });
          })
          .catch((error) => { if (!cancelled) { setSplats(makeMechanicalFallbackSplats(metadata)); setStatus('ready'); setStatusDetail({ note: `Using deterministic mechanical fallback splats: ${error.message}` }); } });
        return () => { cancelled = true; };
      }
      setSplats(makeMechanicalFallbackSplats(metadata)); setStatus('ready'); setStatusDetail({ note: 'Using deterministic mechanical part fallback splats until a PT3 asset is generated.' }); return undefined;
    }
    workerRef.current?.terminate();
    const worker = createSplatWorker();
    workerRef.current = worker;
    worker.onmessage = (event) => {
      if (cancelled || event.data?.id !== requestId) return;
      if (!event.data.ok) { setStatus('failed'); setStatusDetail({ error: event.data.error }); return; }
      setSplats({ positions: event.data.positions, colors: event.data.colors, layers: event.data.layers || [] }); setStatus('ready');
    };
    worker.onerror = (event) => { if (!cancelled) { setStatus('failed'); setStatusDetail({ error: event.message }); } };
    worker.postMessage({ id: requestId, url: asset.url });
    return () => { cancelled = true; worker.terminate(); };
  }, [asset, metadata, part?.id, projectId, splatParameters?.downsample, splatParameters?.intensityMax, splatParameters?.intensityMin, splatParameters?.maxSplats, splatParameters?.opacityMax, splatParameters?.opacityMin, splatParameters?.outputFormat, splatParameters?.threshold]);


  useEffect(() => {
    const canvas = webglCanvasRef.current;
    let cancelled = false;
    if (!canvas || mode === VIEWER_MODES.splat) {
      threeRendererRef.current?.dispose?.();
      threeRendererRef.current = null;
      setRendererType('canvas2d-fallback');
      return undefined;
    }
    createThreeMechanicalRenderer(canvas, { metadata, mode })
      .then((renderer) => {
        if (cancelled || !renderer) {
          renderer?.dispose?.();
          return;
        }
        threeRendererRef.current?.dispose?.();
        threeRendererRef.current = renderer;
        setRendererType(renderer.rendererType || 'three-webgl');
      })
      .catch(() => {
        if (!cancelled) setRendererType('canvas2d-fallback');
      });
    return () => {
      cancelled = true;
      threeRendererRef.current?.dispose?.();
      threeRendererRef.current = null;
    };
  }, [metadata, mode]);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return undefined;
    let frameId = 0; let last = performance.now(); let frames = 0;
    const render = (time) => {
      const ratio = window.devicePixelRatio || 1; const profile = QUALITY_PROFILES[quality];
      const width = Math.max(1, Math.floor(canvas.clientWidth * ratio * profile.scale)); const height = Math.max(1, Math.floor(canvas.clientHeight * ratio * profile.scale));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      threeRendererRef.current?.render?.({ width, height, rotation, zoom });
      const ctx = canvas.getContext('2d');
      renderPreview(ctx, { mode, metadata, splats, rotation, zoom, preset: MECHANICAL_TRANSFER_PRESETS[presetKey], crop: getMechanicalCropBox(metadata, cropEnabled), volumeOpacity, splatOpacity, statsRef });
      frames += 1; if (time - last > 500) { statsRef.current.fps = Math.round((frames * 1000) / (time - last)); frames = 0; last = time; }
      frameId = window.requestAnimationFrame(render);
    };
    frameId = window.requestAnimationFrame(render); return () => window.cancelAnimationFrame(frameId);
  }, [cropEnabled, metadata, mode, presetKey, quality, rotation, splatOpacity, splats, volumeOpacity, zoom]);

  const stats = statsRef.current; const bounds = getPhysicalBounds(metadata);
  return <div className="pt3-gaussian-splat-viewer" data-testid="pt3-gaussian-splat-viewer">
    <canvas ref={webglCanvasRef} className="pt3-gaussian-splat-webgl" aria-label="Three.js mechanical volume renderer" />
    <canvas ref={canvasRef} className="pt3-gaussian-splat-canvas" aria-label="Mechanical 3DGS preview" />
    <div className="pt3-viewer-toolbar">
      <label>Mode <select aria-label="3D viewer mode" value={mode} onChange={(e) => setMode(e.target.value)}><option value="volume">Volume</option><option value="splat">3DGS</option><option value="hybrid">Hybrid</option></select></label>
      <label>Preset <select aria-label="Transfer function preset" value={presetKey} onChange={(e) => setPresetKey(e.target.value)}>{Object.entries(MECHANICAL_TRANSFER_PRESETS).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}</select></label>
      <label>Quality <select aria-label="Quality profile" value={quality} onChange={(e) => setQuality(e.target.value)}><option value="performance">Performance</option><option value="balanced">Balanced</option><option value="quality">Quality</option></select></label>
      <button type="button" onClick={() => { setRotation({ x: -18, y: 32 }); setZoom(1); }}>Reset view</button>
      <button type="button" onClick={() => setZoom((value) => Math.min(2.5, value + 0.15))}>Zoom +</button>
      <button type="button" onClick={() => setZoom((value) => Math.max(0.35, value - 0.15))}>Zoom -</button>
      <label><input type="checkbox" checked={cropEnabled} onChange={(e) => setCropEnabled(e.target.checked)} /> Clip/crop</label>
    </div>
    <div className="pt3-viewer-settings">
      <label>Volume opacity <input type="range" min="0" max="1" step="0.05" value={volumeOpacity} onChange={(e) => setVolumeOpacity(Number(e.target.value))} /></label>
      <label>3DGS opacity <input type="range" min="0" max="1" step="0.05" value={splatOpacity} onChange={(e) => setSplatOpacity(Number(e.target.value))} /></label>
      <label>Orbit X <input type="range" min="-80" max="80" value={rotation.x} onChange={(e) => setRotation((prev) => ({ ...prev, x: Number(e.target.value) }))} /></label>
      <label>Orbit Y <input type="range" min="-180" max="180" value={rotation.y} onChange={(e) => setRotation((prev) => ({ ...prev, y: Number(e.target.value) }))} /></label>
    </div>
    <span className="pt3-gaussian-splat-status">{status === 'ready' ? `${mode.toUpperCase()} ready • threshold ${splatParameters?.threshold ?? 'n/a'} • ${metadata.dimensions.join('×')} voxels • ${bounds.size.map((v) => v.toFixed(1)).join('×')} mm • ${rendererType} • FPS ${stats.fps || '…'} • splats ${stats.renderedSplats || splats?.positions?.length / 3 || 0}` : status === 'pending' ? `Mechanical 3DGS preprocessing is still running • threshold ${splatParameters?.threshold ?? 'n/a'}` : `Mechanical 3D viewer ${status} • threshold ${splatParameters?.threshold ?? 'n/a'}${statusDetail?.error ? `: ${statusDetail.error}` : ''}`}</span>
    {statusDetail?.note && <span className="pt3-viewer-note">{statusDetail.note}</span>}
  </div>;
}
