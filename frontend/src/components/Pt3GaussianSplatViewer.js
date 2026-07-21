import React, { useEffect, useMemo, useRef, useState } from 'react';
import { generateTransferFunctionLut } from './pt3TransferFunctions';
import { getPhysicalBounds, pointInsideCropBox } from './pt3VolumeGeometry';
import { createThreeMechanicalRenderer } from './pt3ThreeRenderer';
import { MECHANICAL_TRANSFER_PRESETS, getMechanicalCropBox, getMechanicalVolumeMetadata, makeMechanicalFallbackSplats } from './pt3MechanicalVisualization';
import { DEFAULT_SPLAT_VIEW_SETTINGS, getCanvasSplatStride, prepareSplatAssetForRendering } from './pt3SplatRendering';

export { DEFAULT_SPLAT_VIEW_SETTINGS } from './pt3SplatRendering';

const SPLAT_METADATA_KEYS = ['gaussian_splat_url', 'gaussian_splat_asset_url', 'splat_url', 'splat_asset_url', 'point_cloud_url'];
const VIEWER_MODES = { volume: 'volume', splat: 'splat', hybrid: 'hybrid' };
const QUALITY_PROFILES = { performance: { sampleStep: 2.5, scale: 0.65 }, balanced: { sampleStep: 1.25, scale: 0.85 }, quality: { sampleStep: 0.75, scale: 1 } };
const SPLAT_FALLBACK_NOTE = 'Generated 3DGS asset unavailable. Showing deterministic mechanical fallback splats.';
export const DEFAULT_RAY_MARCH_SETTINGS = Object.freeze({
  presetKey: 'machinedMetal',
  volumeOpacity: 1.25,
  intensityThreshold: 0.08,
  quality: 'balanced',
  showSliceGuides: true,
});

function disposeThreeRenderer(rendererRef, canvas) {
  const activeRenderer = rendererRef.current;
  rendererRef.current = null;
  activeRenderer?.dispose?.();
  if (!canvas) return;
  // Resetting the backing store guarantees that a disposed WebGL context cannot
  // leave its last volume frame visible while the 2D splat/fallback takes over.
  canvas.width = Math.max(1, canvas.width || 1);
  canvas.height = Math.max(1, canvas.height || 1);
}

function isPlainObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function firstString(...values) { return values.find((value) => typeof value === 'string' && value.trim())?.trim() || ''; }
function getNestedSplatAsset(metadata) {
  for (const candidate of [metadata?.gaussian_splat, metadata?.splat, metadata?.point_cloud]) {
    if (typeof candidate === 'string' && candidate.trim()) return { url: candidate.trim(), assetRecord: metadata };
    if (isPlainObject(candidate)) {
      const url = firstString(candidate.url, candidate.asset_url, candidate.href, candidate.path);
      if (url) return { url, assetRecord: candidate };
    }
  }
  return null;
}

export function getPt3GaussianSplatAsset(part) {
  const metadata = isPlainObject(part?.metadata) ? part.metadata : {};
  const generatedAsset = isPlainObject(metadata.pt3_splat_asset) ? metadata.pt3_splat_asset : null;
  if (generatedAsset?.status === 'ready') {
    const generatedUrl = firstString(generatedAsset.asset_url, generatedAsset.url);
    if (generatedUrl) return {
      url: generatedUrl,
      label: 'preprocessed splat asset',
      assetRecord: generatedAsset,
      legacyPt3SplatAsset: generatedAsset,
    };
  }
  const directUrl = firstString(...SPLAT_METADATA_KEYS.map((key) => metadata[key]));
  if (directUrl) return { url: directUrl, label: 'part metadata', assetRecord: metadata };
  const nestedAsset = getNestedSplatAsset(metadata);
  if (nestedAsset?.url) return { ...nestedAsset, label: 'part metadata' };
  const splatRecord = (Array.isArray(metadata.source_images) ? metadata.source_images : []).find((record) => {
    const filename = String(record?.filename || '').toLowerCase();
    const kind = String(record?.kind || record?.asset_type || record?.metadata?.kind || record?.metadata?.asset_type || '').toLowerCase();
    return kind.includes('splat') || kind.includes('point_cloud') || /\.(splat|ply|ksplat|spz)(\?|$)/i.test(filename);
  });
  if (!splatRecord) return null;
  const recordUrl = firstString(splatRecord.url, splatRecord.asset_url, splatRecord.href, splatRecord.metadata?.url, splatRecord.metadata?.asset_url);
  return recordUrl ? { url: recordUrl, label: splatRecord.filename || 'splat source image', assetRecord: splatRecord } : null;
}


function createSplatWorker() {
  const source = `
    function parsePly(text){const lines=text.split(/\\r?\\n/);const end=lines.findIndex((line)=>line.trim()==='end_header');const countLine=lines.find((line)=>line.startsWith('element vertex '));const count=Number((countLine||'').split(/\\s+/).pop()||0);const positions=[];const scales=[];const colors=[];for(let index=end+1;index<lines.length&&positions.length/3<count;index+=1){const values=lines[index].trim().split(/\\s+/).map(Number);if(values.length>=8&&values.slice(0,8).every(Number.isFinite)){positions.push(values[0],values[1],values[2]);scales.push(values[3]);colors.push(values[5]/255,values[6]/255,values[7]/255,Math.max(0,Math.min(1,values[4])));}}return {positions:new Float32Array(positions),scales:new Float32Array(scales),colors:new Float32Array(colors),layers:[{id:'baked',label:'Baked splats',count:positions.length/3,visible:true,opacity:1}]};}
    function parseJson(text){const payload=JSON.parse(text);const splats=Array.isArray(payload.splats)?payload.splats:[];const positions=new Float32Array(splats.length*3);const scales=new Float32Array(splats.length);const colors=new Float32Array(splats.length*4);const layerCounts=new Map();splats.forEach((splat,index)=>{positions.set([Number(splat.x)||0,Number(splat.y)||0,Number(splat.z)||0],index*3);scales[index]=Number.isFinite(Number(splat.scale))?Number(splat.scale):1;colors.set([(Number(splat.red)||0)/255,(Number(splat.green)||0)/255,(Number(splat.blue)||0)/255,Number(splat.opacity)||0.5],index*4);const layer=String(splat.layer||(Number(splat.intensity)>180?'surface':Number(splat.intensity)<80?'void':'core'));layerCounts.set(layer,(layerCounts.get(layer)||0)+1);});return {positions,scales,colors,layers:[...layerCounts].map(([id,count])=>({id,label:id,count,visible:true,opacity:1})),metadata:payload.metadata||{}};}
    self.onmessage=async(event)=>{const {id,url}=event.data||{};try{const response=await fetch(url);if(!response.ok)throw new Error('HTTP '+response.status);const text=await response.text();const parsed=text.trim().startsWith('{')?parseJson(text):parsePly(text);self.postMessage({id,ok:true,...parsed},[parsed.positions.buffer,parsed.scales.buffer,parsed.colors.buffer]);}catch(error){self.postMessage({id,ok:false,error:error.message||'Failed to parse splat asset'});}};
  `;
  return new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
}

function buildMetadata(part) {
  return getMechanicalVolumeMetadata(part);
}

function renderPreview(ctx, {
  mode,
  metadata,
  splats,
  rotation,
  zoom,
  preset,
  crop,
  volumeOpacity,
  splatOpacity,
  splatPointSize,
  splatContrast,
  slicePosition,
  showSliceGuides,
  tunedSplatView,
  statsRef,
}) {
  if (!ctx?.canvas) return;
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  const cx = width / 2; const cy = height / 2;
  const bounds = getPhysicalBounds(metadata);
  const scale = Math.min(width, height) / Math.max(...bounds.size, 1) * 0.72 * zoom;
  const maxBoundsSize = Math.max(...bounds.size, 1);
  const lut = generateTransferFunctionLut({ preset, scalarRange: metadata.scalarRange, opacityMultiplier: volumeOpacity });
  const ry = rotation.y * Math.PI / 180;
  const rx = rotation.x * Math.PI / 180;
  const cosRy = Math.cos(ry);
  const sinRy = Math.sin(ry);
  const cosRx = Math.cos(rx);
  const sinRx = Math.sin(rx);
  const tuneColor = (value, fallback) => Math.round(Math.max(0, Math.min(1, ((value ?? fallback) - 0.5) * splatContrast + 0.5)) * 255);
  const project = (p) => {
    const x = p[0] - bounds.min[0] - bounds.size[0] / 2;
    const y = p[1] - bounds.min[1] - bounds.size[1] / 2;
    const z = p[2] - bounds.min[2] - bounds.size[2] / 2;
    // Match Three.js' positive Y-axis rotation so hybrid splats and the
    // ray-marched volume remain locked together while orbiting.
    const xz = x * cosRy + z * sinRy;
    const zz = -x * sinRy + z * cosRy;
    const yz = y * cosRx - zz * sinRx;
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
    const splatCount = Math.floor(splats.positions.length / 3);
    const stride = getCanvasSplatStride(splatCount);
    for (let splatIndex = 0; splatIndex < splatCount; splatIndex += stride) {
      const i = splatIndex * 3;
      const point = [splats.positions[i], splats.positions[i + 1], splats.positions[i + 2]];
      if (!pointInsideCropBox(point, crop)) continue;
      const [x, y, z] = project(point); const ci = splatIndex * 4;
      const alpha = Math.max(0, Math.min(1, (splats.colors?.[ci + 3] ?? 0.7) * splatOpacity));
      const authoredScale = Math.max(0.1, Number(splats.scales?.[splatIndex]) || 1);
      const depthScale = Math.max(0.78, Math.min(1.22, 1 - z / maxBoundsSize * 0.08));
      const radius = tunedSplatView
        ? Math.max(0.9, Math.min(18, authoredScale * splatPointSize * 1.4 * depthScale))
        : Math.max(1.4, 4 - z * 0.003);
      ctx.fillStyle = `rgba(${tuneColor(splats.colors?.[ci], 0.4)},${tuneColor(splats.colors?.[ci + 1], 0.8)},${tuneColor(splats.colors?.[ci + 2], 1)},${alpha})`;
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); rendered += 1;
    }
    statsRef.current.renderedSplats = rendered;
  }
  if (tunedSplatView) {
    const drawLoop = (points, color, lineWidth = 1, dash = []) => {
      const projected = points.map(project);
      ctx.beginPath();
      ctx.moveTo(projected[0][0], projected[0][1]);
      projected.slice(1).forEach((point) => ctx.lineTo(point[0], point[1]));
      ctx.closePath();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash(dash);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const [x0, y0, z0] = bounds.min;
    const [x1, y1, z1] = bounds.max;
    const corners = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].forEach(([from, to]) => {
      const a = project(corners[from]); const b = project(corners[to]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      ctx.strokeStyle = 'rgba(226,232,240,0.58)'; ctx.lineWidth = 1; ctx.stroke();
    });
    const positionOnAxis = (axis, value) => {
      const upper = Math.max(1, Number(metadata.dimensions?.[axis]) - 1);
      return bounds.min[axis] + Math.max(0, Math.min(1, (Number(value) || 0) / upper)) * bounds.size[axis];
    };
    if (showSliceGuides) {
      const sliceX = positionOnAxis(0, slicePosition?.sagittal);
      const sliceY = positionOnAxis(1, slicePosition?.coronal);
      const sliceZ = positionOnAxis(2, slicePosition?.axial);
      drawLoop([[x0, y0, sliceZ], [x1, y0, sliceZ], [x1, y1, sliceZ], [x0, y1, sliceZ]], 'rgba(59,130,246,0.9)', 1.2, [4, 3]);
      drawLoop([[x0, sliceY, z0], [x1, sliceY, z0], [x1, sliceY, z1], [x0, sliceY, z1]], 'rgba(245,158,11,0.9)', 1.2, [4, 3]);
      drawLoop([[sliceX, y0, z0], [sliceX, y1, z0], [sliceX, y1, z1], [sliceX, y0, z1]], 'rgba(16,185,129,0.9)', 1.2, [4, 3]);
    }
    ctx.fillStyle = '#bae6fd'; ctx.fillText('R', width - 24, cy); ctx.fillText('S', cx, 18); ctx.fillText('A', cx + 22, cy + 24);
  } else {
    ctx.strokeStyle = 'rgba(226,232,240,0.72)'; ctx.lineWidth = 1; ctx.strokeRect(cx - bounds.size[0] * scale / 2, cy - bounds.size[1] * scale / 2, bounds.size[0] * scale, bounds.size[1] * scale);
    ctx.fillStyle = '#bae6fd'; ctx.fillText('R', width - 24, cy); ctx.fillText('S', cx, 18); ctx.fillText('A', cx + 22, cy + 24);
  }
}

export default function Pt3GaussianSplatViewer({
  part,
  projectId,
  volumeImageStack = [],
  splatParameters,
  mode = VIEWER_MODES.hybrid,
  rotation = { x: -18, y: 32 },
  zoom = 1,
  slicePosition = { axial: 0, coronal: 0, sagittal: 0 },
  rayMarchSettings = DEFAULT_RAY_MARCH_SETTINGS,
  splatViewSettings = DEFAULT_SPLAT_VIEW_SETTINGS,
  onRayMarchSettingsChange,
  onSplatViewSettingsChange,
  onRotationChange,
  onZoomChange,
  onResetView,
  showRayMarchControls = false,
  showSplatControls = false,
}) {
  const canvasRef = useRef(null);
  const webglCanvasRef = useRef(null);
  const threeRendererRef = useRef(null);
  const workerRef = useRef(null);
  const statsRef = useRef({ frames: 0, fps: 0, renderedSplats: 0 });
  const activeRayMarchSettings = { ...DEFAULT_RAY_MARCH_SETTINGS, ...(rayMarchSettings || {}) };
  const { presetKey, quality, volumeOpacity, intensityThreshold, showSliceGuides } = activeRayMarchSettings;
  const activeSplatViewSettings = { ...DEFAULT_SPLAT_VIEW_SETTINGS, ...(splatViewSettings || {}) };
  const {
    opacity: configuredSplatOpacity,
    pointSize: configuredSplatPointSize,
    contrast: configuredSplatContrast,
    showSliceGuides: configuredSplatGuides,
  } = activeSplatViewSettings;
  const [status, setStatus] = useState('initializing');
  const [statusDetail, setStatusDetail] = useState(null);
  const [rendererType, setRendererType] = useState('canvas2d-fallback');
  const [splats, setSplats] = useState(null);
  const cropEnabled = false;
  const splatOpacity = mode === VIEWER_MODES.splat ? configuredSplatOpacity : 0.9;
  const splatPointSize = mode === VIEWER_MODES.splat ? configuredSplatPointSize : 1;
  const splatContrast = mode === VIEWER_MODES.splat ? configuredSplatContrast : 1;
  const splatGuidesVisible = mode === VIEWER_MODES.splat ? configuredSplatGuides : showSliceGuides;
  const metadata = useMemo(() => buildMetadata(part), [part]);
  const asset = useMemo(() => getPt3GaussianSplatAsset(part), [part]);

  useEffect(() => {
    let cancelled = false;
    let pollTimer = null;
    if (mode === VIEWER_MODES.volume) {
      workerRef.current?.terminate();
      workerRef.current = null;
      setSplats(null);
      setStatus(volumeImageStack.length > 0 ? 'loading' : 'fallback');
      setStatusDetail(volumeImageStack.length > 0 ? null : {
        note: 'No volume stack images are attached to this part. Showing deterministic volume bounds fallback.',
      });
      return () => { cancelled = true; };
    }
    const requestId = `${Date.now()}-${Math.random()}`;
    const showDeterministicSplatFallback = () => {
      if (cancelled) return;
      setSplats(makeMechanicalFallbackSplats(metadata));
      setStatus('ready');
      setStatusDetail({ note: SPLAT_FALLBACK_NOTE });
    };
    const loadSplatAsset = (url, coordinateContext = {}) => {
      workerRef.current?.terminate();
      let worker;
      try {
        worker = createSplatWorker();
      } catch {
        showDeterministicSplatFallback();
        return;
      }
      workerRef.current = worker;
      worker.onmessage = (event) => {
        if (cancelled || event.data?.id !== requestId) return;
        if (!event.data.ok) { showDeterministicSplatFallback(); return; }
        const parsedSplats = {
          positions: event.data.positions,
          scales: event.data.scales,
          colors: event.data.colors,
          layers: event.data.layers || [],
          metadata: event.data.metadata || {},
        };
        setSplats(prepareSplatAssetForRendering(parsedSplats, metadata, {
          ...coordinateContext,
          assetUrl: url,
          parsedMetadata: parsedSplats.metadata,
        })); setStatus('ready'); setStatusDetail(null);
      };
      worker.onerror = () => showDeterministicSplatFallback();
      try {
        worker.postMessage({ id: requestId, url: new URL(url, window.location.origin).href });
      } catch {
        showDeterministicSplatFallback();
      }
    };
    setStatus('loading'); setStatusDetail(null);
    if (!asset?.url) {
      if (projectId && part?.id) {
        const statusUrl = `/api/projects/${encodeURIComponent(projectId)}/parts/${encodeURIComponent(part.id)}/volume-splat-assets/status`;
        const pollStatus = () => fetch(statusUrl)
          .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
          .then((payload) => {
            if (cancelled) return;
            if (payload.status === 'pending') { setStatusDetail(null); setStatus('pending'); pollTimer = window.setTimeout(pollStatus, 750); return; }
            if (payload.status === 'failed') { showDeterministicSplatFallback(); return; }
            if (payload.status === 'ready' && payload.asset_url) { loadSplatAsset(payload.asset_url, { sourceMetadata: payload }); return; }
            return fetch(`/api/projects/${encodeURIComponent(projectId)}/parts/${encodeURIComponent(part.id)}/volume-splat-assets`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ source_image_ids: [], transfer_function: { threshold: Number(splatParameters?.threshold) || 1, intensity_min: Number(splatParameters?.intensityMin) || 0, intensity_max: Number(splatParameters?.intensityMax) || 255, opacity_min: Number(splatParameters?.opacityMin) || 0.05, opacity_max: Number(splatParameters?.opacityMax) || 1, color_map: 'grayscale' }, downsample: Number(splatParameters?.downsample) || 1, max_splats: Number(splatParameters?.maxSplats) || 100000, output_format: splatParameters?.outputFormat || 'json' }),
            }).then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }).then((payload2) => {
              if (cancelled) return;
              if (payload2.status === 'failed') { showDeterministicSplatFallback(); return; }
              if (payload2.status === 'ready' && payload2.asset_url) { loadSplatAsset(payload2.asset_url, { sourceMetadata: payload2 }); return; }
              setStatusDetail(null);
              setStatus('pending');
              pollTimer = window.setTimeout(pollStatus, 750);
            });
          })
          .catch(() => showDeterministicSplatFallback());
        pollStatus();
        return () => { cancelled = true; if (pollTimer) window.clearTimeout(pollTimer); workerRef.current?.terminate(); };
      }
      setSplats(makeMechanicalFallbackSplats(metadata)); setStatus('ready'); setStatusDetail({ note: 'Using deterministic mechanical part fallback splats until a PT3 asset is generated.' }); return undefined;
    }
    loadSplatAsset(asset.url, asset);
    return () => { cancelled = true; workerRef.current?.terminate(); };
  }, [asset, metadata, mode, part?.id, projectId, splatParameters?.downsample, splatParameters?.intensityMax, splatParameters?.intensityMin, splatParameters?.maxSplats, splatParameters?.opacityMax, splatParameters?.opacityMin, splatParameters?.outputFormat, splatParameters?.threshold, volumeImageStack.length]);


  useEffect(() => {
    const canvas = webglCanvasRef.current;
    let cancelled = false;
    if (!canvas || mode === VIEWER_MODES.splat) {
      disposeThreeRenderer(threeRendererRef, canvas);
      setRendererType('canvas2d-fallback');
      return undefined;
    }
    createThreeMechanicalRenderer(canvas, { metadata, mode, volumeImageStack })
      .then((renderer) => {
        if (cancelled || !renderer) {
          renderer?.dispose?.();
          return;
        }
        threeRendererRef.current?.dispose?.();
        threeRendererRef.current = renderer;
        setRendererType(renderer.rendererType || 'three-webgl');
        if (mode === VIEWER_MODES.volume) setStatus('ready');
      })
      .catch((error) => {
        if (!cancelled) {
          disposeThreeRenderer(threeRendererRef, canvas);
          setRendererType('canvas2d-fallback');
          if (mode === VIEWER_MODES.volume) {
            setStatus('fallback');
            setStatusDetail({
              error: error.message || 'Could not initialize ray-marched volume',
              note: 'Ray-marched volume unavailable. Showing deterministic volume bounds fallback.',
            });
          }
        }
      });
    return () => {
      cancelled = true;
      disposeThreeRenderer(threeRendererRef, canvas);
    };
  }, [metadata, mode, volumeImageStack]);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return undefined;
    let frameId = 0; let last = performance.now(); let frames = 0;
    const render = (time) => {
      const ratio = window.devicePixelRatio || 1; const profile = QUALITY_PROFILES[quality];
      const width = Math.max(1, Math.floor(canvas.clientWidth * ratio * profile.scale)); const height = Math.max(1, Math.floor(canvas.clientHeight * ratio * profile.scale));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      threeRendererRef.current?.render?.({
        width,
        height,
        rotation,
        zoom,
        volumeOpacity,
        presetKey,
        intensityThreshold,
        sampleStep: profile.sampleStep,
        slicePosition,
        showSliceGuides,
      });
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, width, height);
      if (rendererType === 'canvas2d-fallback' || mode !== VIEWER_MODES.volume) {
        renderPreview(ctx, {
          mode: rendererType !== 'canvas2d-fallback' && mode === VIEWER_MODES.hybrid ? VIEWER_MODES.splat : mode,
          metadata,
          splats,
          rotation,
          zoom,
          preset: MECHANICAL_TRANSFER_PRESETS[presetKey],
          crop: getMechanicalCropBox(metadata, cropEnabled),
          volumeOpacity,
          splatOpacity,
          splatPointSize,
          splatContrast,
          slicePosition,
          showSliceGuides: splatGuidesVisible,
          tunedSplatView: mode === VIEWER_MODES.splat,
          statsRef,
        });
      }
      frames += 1; if (time - last > 500) { statsRef.current.fps = Math.round((frames * 1000) / (time - last)); frames = 0; last = time; }
      frameId = window.requestAnimationFrame(render);
    };
    frameId = window.requestAnimationFrame(render); return () => window.cancelAnimationFrame(frameId);
  }, [cropEnabled, intensityThreshold, metadata, mode, presetKey, quality, rendererType, rotation, showSliceGuides, slicePosition, splatContrast, splatGuidesVisible, splatOpacity, splatPointSize, splats, volumeOpacity, zoom]);

  const updateRayMarchSetting = (key, value) => {
    onRayMarchSettingsChange?.({ ...activeRayMarchSettings, [key]: value });
  };

  const updateSplatViewSetting = (key, value) => {
    onSplatViewSettingsChange?.({ ...activeSplatViewSettings, [key]: value });
  };

  const stats = statsRef.current; const bounds = getPhysicalBounds(metadata);
  return <div className="pt3-gaussian-splat-viewer" data-testid="pt3-gaussian-splat-viewer">
    <canvas
      ref={webglCanvasRef}
      className="pt3-gaussian-splat-webgl"
      aria-label="Three.js mechanical volume renderer"
      hidden={mode === VIEWER_MODES.splat || rendererType === 'canvas2d-fallback'}
    />
    <canvas ref={canvasRef} className="pt3-gaussian-splat-canvas" aria-label="Mechanical 3DGS preview" />
    {showRayMarchControls && mode === VIEWER_MODES.volume && (
      <fieldset
        className="pt3-ray-march-controls"
        aria-label="Ray-march controls"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (!['Tab', 'Escape'].includes(event.key)) event.stopPropagation(); }}
      >
        <legend>Ray march</legend>
        <label>
          Transfer function preset
          <select value={presetKey} onChange={(event) => updateRayMarchSetting('presetKey', event.target.value)}>
            {Object.entries(MECHANICAL_TRANSFER_PRESETS).map(([key, preset]) => <option key={key} value={key}>{preset.label}</option>)}
          </select>
        </label>
        <label>
          Density <output aria-hidden="true">{volumeOpacity.toFixed(2)}×</output>
          <input aria-label="Ray-march density" type="range" min="0.25" max="2.5" step="0.05" value={volumeOpacity} onChange={(event) => updateRayMarchSetting('volumeOpacity', Number(event.target.value))} />
        </label>
        <label>
          Threshold <output aria-hidden="true">{intensityThreshold.toFixed(2)}</output>
          <input aria-label="Ray-march intensity threshold" type="range" min="0" max="0.6" step="0.01" value={intensityThreshold} onChange={(event) => updateRayMarchSetting('intensityThreshold', Number(event.target.value))} />
        </label>
        <label>
          Quality profile
          <select value={quality} onChange={(event) => updateRayMarchSetting('quality', event.target.value)}>
            <option value="performance">Performance</option>
            <option value="balanced">Balanced</option>
            <option value="quality">Quality</option>
          </select>
        </label>
        <label className="pt3-ray-march-checkbox">
          <input type="checkbox" checked={showSliceGuides} onChange={(event) => updateRayMarchSetting('showSliceGuides', event.target.checked)} />
          Show slice guides
        </label>
        <button type="button" onClick={() => onRayMarchSettingsChange?.({ ...DEFAULT_RAY_MARCH_SETTINGS })}>Reset ray-march settings</button>
        <label>
          Orbit X <output aria-hidden="true">{Math.round(rotation.x)}°</output>
          <input aria-label="Orbit X" type="range" min="-72" max="72" step="1" value={rotation.x} onChange={(event) => onRotationChange?.({ ...rotation, x: Number(event.target.value) })} />
        </label>
        <label>
          Orbit Y <output aria-hidden="true">{Math.round(rotation.y)}°</output>
          <input aria-label="Orbit Y" type="range" min="-180" max="180" step="1" value={rotation.y} onChange={(event) => onRotationChange?.({ ...rotation, y: Number(event.target.value) })} />
        </label>
        <div className="pt3-ray-march-view-actions">
          <button type="button" aria-label="Zoom -" onClick={() => onZoomChange?.(Math.max(0.5, Number((zoom - 0.12).toFixed(2))))}>−</button>
          <button type="button" aria-label="Reset view" onClick={() => onResetView?.()}>Reset view</button>
          <button type="button" aria-label="Zoom +" onClick={() => onZoomChange?.(Math.min(4, Number((zoom + 0.12).toFixed(2))))}>+</button>
        </div>
      </fieldset>
    )}
    {showSplatControls && mode === VIEWER_MODES.splat && (
      <fieldset
        className="pt3-ray-march-controls pt3-splat-controls"
        aria-label="3DGS controls"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (!['Tab', 'Escape'].includes(event.key)) event.stopPropagation(); }}
      >
        <legend>3DGS visibility</legend>
        <label>
          Opacity <output aria-hidden="true">{configuredSplatOpacity.toFixed(2)}×</output>
          <input aria-label="3DGS opacity" type="range" min="0.25" max="2.5" step="0.05" value={configuredSplatOpacity} onChange={(event) => updateSplatViewSetting('opacity', Number(event.target.value))} />
        </label>
        <label>
          Point size <output aria-hidden="true">{configuredSplatPointSize.toFixed(2)}×</output>
          <input aria-label="3DGS point size" type="range" min="0.5" max="3" step="0.05" value={configuredSplatPointSize} onChange={(event) => updateSplatViewSetting('pointSize', Number(event.target.value))} />
        </label>
        <label>
          Contrast <output aria-hidden="true">{configuredSplatContrast.toFixed(2)}×</output>
          <input aria-label="3DGS contrast" type="range" min="0.5" max="2" step="0.05" value={configuredSplatContrast} onChange={(event) => updateSplatViewSetting('contrast', Number(event.target.value))} />
        </label>
        <label className="pt3-ray-march-checkbox">
          <input type="checkbox" checked={configuredSplatGuides} onChange={(event) => updateSplatViewSetting('showSliceGuides', event.target.checked)} />
          Show slice guides
        </label>
        <button type="button" onClick={() => onSplatViewSettingsChange?.({ ...DEFAULT_SPLAT_VIEW_SETTINGS })}>Reset 3DGS settings</button>
        <label>
          Orbit X <output aria-hidden="true">{Math.round(rotation.x)}°</output>
          <input aria-label="3DGS Orbit X" type="range" min="-72" max="72" step="1" value={rotation.x} onChange={(event) => onRotationChange?.({ ...rotation, x: Number(event.target.value) })} />
        </label>
        <label>
          Orbit Y <output aria-hidden="true">{Math.round(rotation.y)}°</output>
          <input aria-label="3DGS Orbit Y" type="range" min="-180" max="180" step="1" value={rotation.y} onChange={(event) => onRotationChange?.({ ...rotation, y: Number(event.target.value) })} />
        </label>
        <div className="pt3-ray-march-view-actions">
          <button type="button" aria-label="3DGS Zoom -" onClick={() => onZoomChange?.(Math.max(0.5, Number((zoom - 0.12).toFixed(2))))}>−</button>
          <button type="button" aria-label="Reset 3DGS view" onClick={() => onResetView?.()}>Reset view</button>
          <button type="button" aria-label="3DGS Zoom +" onClick={() => onZoomChange?.(Math.min(4, Number((zoom + 0.12).toFixed(2))))}>+</button>
        </div>
      </fieldset>
    )}
    <span className="pt3-gaussian-splat-status">{status === 'ready' ? `${mode.toUpperCase()} ready${mode === VIEWER_MODES.volume ? '' : ` • threshold ${splatParameters?.threshold ?? 'n/a'}`} • ${metadata.dimensions.join('×')} voxels • ${bounds.size.map((v) => v.toFixed(1)).join('×')} mm • ${rendererType} • FPS ${stats.fps || '…'}${mode === VIEWER_MODES.volume ? ` • slices ${volumeImageStack.length}` : ` • splats ${stats.renderedSplats || splats?.positions?.length / 3 || 0}`}` : status === 'pending' ? `Mechanical 3DGS preprocessing is still running • threshold ${splatParameters?.threshold ?? 'n/a'}` : `Mechanical 3D viewer ${status}${mode === VIEWER_MODES.volume ? '' : ` • threshold ${splatParameters?.threshold ?? 'n/a'}`}${statusDetail?.error ? `: ${statusDetail.error}` : ''}`}</span>
    {statusDetail?.note && <span className="pt3-viewer-note">{statusDetail.note}</span>}
  </div>;
}
