import React, { useEffect, useMemo, useRef, useState } from 'react';
import { generateTransferFunctionLut } from './pt3TransferFunctions';
import {
  createPt3PerspectiveProjector,
  getPhysicalBounds,
  normalizeVolumeMetadata,
  normalizeAxisMirrorScale,
  pointInsideCropBox,
  voxelToPhysical,
} from './pt3VolumeGeometry';
import { createThreeMechanicalRenderer } from './pt3ThreeRenderer';
import { MECHANICAL_TRANSFER_PRESETS, getMechanicalCropBox, getMechanicalVolumeMetadata, makeMechanicalFallbackSplats } from './pt3MechanicalVisualization';
import { getSegmentDisplayStyle, normalizePt3Segmentation, segmentColorToRgba } from './pt3Segmentation';
import {
  DEFAULT_SPLAT_VIEW_SETTINGS,
  evaluateGraphdecoSphericalHarmonics,
  getCanvasSplatSampleIndices,
  getPt3SplatViewDirection,
  MAX_CANVAS_GAUSSIANS,
  prepareSplatAssetForRendering,
  projectGaussianCovariance,
  sortSplatRenderEntriesBackToFront,
} from './pt3SplatRendering';

export { DEFAULT_SPLAT_VIEW_SETTINGS } from './pt3SplatRendering';

const SPLAT_METADATA_KEYS = ['gaussian_splat_url', 'gaussian_splat_asset_url', 'splat_url', 'splat_asset_url', 'point_cloud_url'];
const REAL_SPLAT_METADATA_KEYS = ['real_gaussian_splat_url', 'real_gaussian_splat_asset_url'];
const VIEWER_MODES = { volume: 'volume', splat: 'splat', realSplat: 'real-splat', hybrid: 'hybrid' };
const QUALITY_PROFILES = { performance: { sampleStep: 2.5, scale: 0.65 }, balanced: { sampleStep: 1.25, scale: 0.85 }, quality: { sampleStep: 0.75, scale: 1 } };
const SPLAT_FALLBACK_NOTE = 'Generated 3DGS asset unavailable. Showing deterministic mechanical fallback splats.';
const DEFAULT_AXIS_MIRROR_SCALE = Object.freeze({ x: 1, y: 1, z: 1 });
const EMPTY_VOLUME_IMAGE_STACK = Object.freeze([]);
export const REAL_SPLAT_BROWSER_MAX = 100000;
const DEFAULT_REAL_SPLAT_BUDGET = 50000;
export const DEFAULT_RAY_MARCH_SETTINGS = Object.freeze({
  opacityRampWidth: 0.52,
  colorLow: '#3d5c7a',
  colorHigh: '#f5faff',
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

export function getPt3RealGaussianSplatAsset(part) {
  const metadata = isPlainObject(part?.metadata) ? part.metadata : {};
  const declaredAsset = isPlainObject(metadata.pt3_real_splat_asset) ? metadata.pt3_real_splat_asset : null;
  if (declaredAsset?.status === 'ready') {
    const url = firstString(declaredAsset.asset_url, declaredAsset.url, declaredAsset.href, declaredAsset.path);
    if (url) return { url, label: 'canonical real 3DGS asset', assetRecord: declaredAsset };
  }
  const directUrl = firstString(...REAL_SPLAT_METADATA_KEYS.map((key) => metadata[key]));
  if (directUrl) return { url: directUrl, label: 'real 3DGS metadata', assetRecord: metadata };
  const explicitRealAsset = metadata.real_gaussian_splat;
  if (typeof explicitRealAsset === 'string' && explicitRealAsset.trim()) {
    return { url: explicitRealAsset.trim(), label: 'real 3DGS metadata', assetRecord: metadata };
  }
  if (isPlainObject(explicitRealAsset)) {
    const url = firstString(explicitRealAsset.url, explicitRealAsset.asset_url, explicitRealAsset.href, explicitRealAsset.path);
    if (url && (!explicitRealAsset.status || explicitRealAsset.status === 'ready')) {
      return { url, label: 'real 3DGS metadata', assetRecord: explicitRealAsset };
    }
  }
  return null;
}

export function getPt3RealSplatCameras(part) {
  const metadata = isPlainObject(part?.metadata) ? part.metadata : {};
  const candidates = [
    metadata.pt3_real_3dgs?.cameras,
    metadata.pt3_camera_calibrations,
    metadata.camera_calibrations,
  ];
  const cameras = candidates.find((candidate) => Array.isArray(candidate));
  if (!cameras) return [];
  const seenImageIds = new Set();
  const numericValue = (value) => {
    if (typeof value === 'boolean' || value === null || (typeof value === 'string' && !value.trim())) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  };
  const numericVector = (value, length) => {
    if (!Array.isArray(value) || value.length !== length) return null;
    const normalized = value.map(numericValue);
    return normalized.every((item) => item !== null) ? normalized : null;
  };
  return cameras.filter((camera) => {
    if (!isPlainObject(camera)) return false;
    const imageId = typeof camera.image_id === 'string' ? camera.image_id.trim() : '';
    const width = numericValue(camera.width);
    const height = numericValue(camera.height);
    const intrinsics = numericVector(camera.intrinsics, 9);
    const rotation = numericVector(camera.rotation_quaternion, 4);
    const translation = numericVector(camera.translation, 3);
    if (!imageId || imageId.length > 255 || seenImageIds.has(imageId)) return false;
    if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) return false;
    if (!intrinsics || !rotation || !translation) return false;
    if (intrinsics[0] <= 0 || intrinsics[4] <= 0) return false;
    if (intrinsics[2] < 0 || intrinsics[2] > width || intrinsics[5] < 0 || intrinsics[5] > height) return false;
    if (Math.abs(intrinsics[6]) > 1e-8 || Math.abs(intrinsics[7]) > 1e-8 || Math.abs(intrinsics[8] - 1) > 1e-8) return false;
    if (Math.hypot(...rotation) <= 1e-12) return false;
    seenImageIds.add(imageId);
    return true;
  });
}


function createSplatWorker() {
  const source = `
    function parsePly(text){const lines=text.split(/\\r?\\n/);const end=lines.findIndex((line)=>line.trim()==='end_header');const countLine=lines.find((line)=>line.startsWith('element vertex '));const count=Number((countLine||'').split(/\\s+/).pop()||0);const vertexLine=lines.findIndex((line)=>line.startsWith('element vertex '));const properties=lines.slice(vertexLine+1,end).filter((line)=>line.trim().startsWith('property ')).map((line)=>line.trim().split(/\\s+/).pop());const propertyIndex=(name,fallback)=>{const found=properties.indexOf(name);return found>=0?found:fallback;};const segmentIndex=['segment_id','segmentId','label_id','label'].reduce((found,name)=>found>=0?found:properties.indexOf(name),-1);const positions=[];const scales=[];const colors=[];const segmentIds=[];for(let index=end+1;index<lines.length&&positions.length/3<count;index+=1){const values=lines[index].trim().split(/\\s+/).map(Number);if(values.length>=8&&values.slice(0,8).every(Number.isFinite)){positions.push(values[propertyIndex('x',0)],values[propertyIndex('y',1)],values[propertyIndex('z',2)]);scales.push(values[propertyIndex('scale',3)]);colors.push(values[propertyIndex('red',5)]/255,values[propertyIndex('green',6)]/255,values[propertyIndex('blue',7)]/255,Math.max(0,Math.min(1,values[propertyIndex('opacity',4)])));segmentIds.push(segmentIndex>=0?values[segmentIndex]:null);}}return {positions:new Float32Array(positions),scales:new Float32Array(scales),colors:new Float32Array(colors),segmentIds,layers:[{id:'baked',label:'Baked splats',count:positions.length/3,visible:true,opacity:1}]};}
    function parseJson(text){
      const payload=JSON.parse(text);
      if(payload.contract_version==='pt3_real_3dgs/v1'&&payload.representation==='real_3dgs'){
        const count=payload.means.length;
        const shDegree=Math.max(0,Math.min(4,Number(payload.sh_degree)||0));
        const shValuesPerSplat=3*(shDegree+1)*(shDegree+1);
        const positions=new Float32Array(count*3);
        const scaleVectors=new Float32Array(count*3);
        const scales=new Float32Array(count);
        const rotations=new Float32Array(count*4);
        const colors=new Float32Array(count*4);
        const shCoefficients=new Float32Array(count*shValuesPerSplat);
        for(let index=0;index<count;index+=1){
          positions.set(payload.means[index],index*3);
          scaleVectors.set(payload.scales[index],index*3);
          scales[index]=Math.max(...payload.scales[index]);
          rotations.set(payload.rotations[index],index*4);
          shCoefficients.set(payload.sh_coefficients[index],index*shValuesPerSplat);
          const shOffset=index*shValuesPerSplat;
          colors.set([
            Math.max(0,Math.min(1,0.5+0.28209479177387814*shCoefficients[shOffset])),
            Math.max(0,Math.min(1,0.5+0.28209479177387814*shCoefficients[shOffset+1])),
            Math.max(0,Math.min(1,0.5+0.28209479177387814*shCoefficients[shOffset+2])),
            payload.opacities[index],
          ],index*4);
        }
        const metadata={...payload,splat_count:count};
        ['means','scales','rotations','opacities','sh_coefficients','covariances','scalar_values','group_sizes','segment_ids'].forEach((key)=>delete metadata[key]);
        return {positions,scales,scaleVectors,rotations,colors,shCoefficients,shDegree,shValuesPerSplat,segmentIds:Array.isArray(payload.segment_ids)?payload.segment_ids:new Array(count).fill(null),layers:[{id:'canonical',label:'Canonical Gaussians',count,visible:true,opacity:1}],metadata};
      }
      const splats=Array.isArray(payload.splats)?payload.splats:[];const positions=new Float32Array(splats.length*3);const scales=new Float32Array(splats.length);const colors=new Float32Array(splats.length*4);const segmentIds=new Array(splats.length);const layerCounts=new Map();splats.forEach((splat,index)=>{positions.set([Number(splat.x)||0,Number(splat.y)||0,Number(splat.z)||0],index*3);scales[index]=Number.isFinite(Number(splat.scale))?Number(splat.scale):1;colors.set([(Number(splat.red)||0)/255,(Number(splat.green)||0)/255,(Number(splat.blue)||0)/255,Number(splat.opacity)||0.5],index*4);segmentIds[index]=splat.segment_id??splat.segmentId??null;const layer=String(splat.layer||(Number(splat.intensity)>180?'surface':Number(splat.intensity)<80?'void':'core'));layerCounts.set(layer,(layerCounts.get(layer)||0)+1);});return {positions,scales,colors,segmentIds,layers:[...layerCounts].map(([id,count])=>({id,label:id,count,visible:true,opacity:1})),metadata:payload.metadata||{}};
    }
    self.onmessage=async(event)=>{const {id,url,requireCanonical}=event.data||{};try{const response=await fetch(url);if(!response.ok)throw new Error('HTTP '+response.status);const text=await response.text();if(requireCanonical&&!text.trim().startsWith('{'))throw new Error('Real 3DGS requires canonical JSON');const parsed=text.trim().startsWith('{')?parseJson(text):parsePly(text);if(requireCanonical&&parsed.metadata?.contract_version!=='pt3_real_3dgs/v1')throw new Error('Real 3DGS asset is not canonical v1 JSON');self.postMessage({id,ok:true,...parsed},[parsed.positions.buffer,parsed.scales.buffer,parsed.colors.buffer,...(parsed.scaleVectors?[parsed.scaleVectors.buffer,parsed.rotations.buffer]:[]),...(parsed.shCoefficients?[parsed.shCoefficients.buffer]:[])]);}catch(error){self.postMessage({id,ok:false,error:error.message||'Failed to parse splat asset'});}};
  `;
  return new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
}

function buildMetadata(part) {
  return getMechanicalVolumeMetadata(part);
}

function drawProjectedGaussian(ctx, { x, y, sigmaMajor, sigmaMinor, angle, color, alpha }) {
  const maximumRadius = Math.max(ctx.canvas.width, ctx.canvas.height);
  const major = Math.max(0.35, Math.min(maximumRadius, Number(sigmaMajor) || 0.35));
  const minor = Math.max(0.35, Math.min(maximumRadius, Number(sigmaMinor) || 0.35));
  const footprint = 3 * major;
  if (x + footprint < 0 || x - footprint > ctx.canvas.width || y + footprint < 0 || y - footprint > ctx.canvas.height) return false;
  const [red, green, blue] = color.map((value) => Math.round(Math.max(0, Math.min(255, value))));
  ctx.save?.();
  ctx.translate?.(x, y);
  ctx.rotate?.(Number(angle) || 0);
  ctx.scale?.(major, minor);
  if (typeof ctx.createRadialGradient === 'function') {
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 3);
    gradient.addColorStop(0, `rgba(${red},${green},${blue},${alpha})`);
    gradient.addColorStop(1 / 3, `rgba(${red},${green},${blue},${alpha * Math.exp(-0.5)})`);
    gradient.addColorStop(2 / 3, `rgba(${red},${green},${blue},${alpha * Math.exp(-2)})`);
    gradient.addColorStop(0.9, `rgba(${red},${green},${blue},${alpha * Math.exp(-3.645)})`);
    gradient.addColorStop(1, `rgba(${red},${green},${blue},0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle = `rgba(${red},${green},${blue},${alpha})`;
    ctx.beginPath();
    if (typeof ctx.ellipse === 'function') ctx.ellipse(0, 0, 1, 1, 0, 0, Math.PI * 2);
    else ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore?.();
  return true;
}

function renderPreview(ctx, {
  mode,
  metadata,
  splats,
  rotation,
  zoom,
  mirrorScale,
  preset,
  crop,
  volumeOpacity,
  splatOpacity,
  splatPointSize,
  splatContrast,
  slicePosition,
  showSliceGuides,
  tunedSplatView,
  showReferenceFrame,
  projectionCache,
  segmentationSegments,
  statsRef,
}) {
  if (!ctx?.canvas) return;
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  const cx = width / 2; const cy = height / 2;
  const bounds = getPhysicalBounds(metadata);
  const normalizedMetadata = normalizeVolumeMetadata(metadata);
  const project = createPt3PerspectiveProjector({ metadata, width, height, rotation, zoom, mirrorScale });
  const centerVoxel = normalizedMetadata.dimensions.map((dimension) => (dimension - 1) / 2);
  const referencePixelsPerUnit = project(voxelToPhysical(centerVoxel, normalizedMetadata))[3];
  const lut = generateTransferFunctionLut({ preset, scalarRange: metadata.scalarRange, opacityMultiplier: volumeOpacity });
  const tuneColor = (value, fallback) => Math.round(Math.max(0, Math.min(1, ((value ?? fallback) - 0.5) * splatContrast + 0.5)) * 255);
  if (mode === VIEWER_MODES.volume) {
    const fallbackScale = Math.min(width, height) / Math.max(...bounds.size, 1) * 0.72 * zoom;
    for (let i = 0; i < 56; i += 1) {
      const t = i / 55;
      const colorIndex = Math.min(255, Math.max(0, Math.round(t * 255))) * 4;
      ctx.fillStyle = `rgba(${lut[colorIndex]},${lut[colorIndex + 1]},${lut[colorIndex + 2]},${(lut[colorIndex + 3] / 255) * 0.16})`;
      const w = bounds.size[0] * fallbackScale * (0.25 + t * 0.7);
      const h = bounds.size[1] * fallbackScale * (0.18 + (1 - t) * 0.62);
      ctx.beginPath(); ctx.ellipse(cx, cy, w / 2, h / 2, rotation.y * Math.PI / 360, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (mode !== VIEWER_MODES.volume && splats?.positions) {
    const splatCount = Math.floor(splats.positions.length / 3);
    const hasCanonicalCovariance = Boolean(splats.covariances3d?.length >= splatCount * 9);
    const sampledSplatIndices = getCanvasSplatSampleIndices({
      splatCount,
      maxSplats: hasCanonicalCovariance ? MAX_CANVAS_GAUSSIANS : undefined,
      segmentIds: splats.segmentIds,
      segments: segmentationSegments,
    });
    let projectedSplats = projectionCache?.splats === splats
      && projectionCache.width === width
      && projectionCache.height === height
      ? projectionCache.entries
      : null;
    if (!projectedSplats) {
      projectedSplats = [];
      for (const splatIndex of sampledSplatIndices) {
        const i = splatIndex * 3;
        const point = [splats.positions[i], splats.positions[i + 1], splats.positions[i + 2]];
        if (!pointInsideCropBox(point, crop)) continue;
        if (hasCanonicalCovariance) {
          const projectedGaussian = projectGaussianCovariance({
            mean: point,
            covariance: splats.covariances3d.subarray(splatIndex * 9, splatIndex * 9 + 9),
            project,
          });
          if (!projectedGaussian) continue;
          const viewDirection = getPt3SplatViewDirection({ metadata, point, rotation, mirrorScale });
          const shValuesPerSplat = splats.shValuesPerSplat || 3 * ((splats.shDegree || 0) + 1) ** 2;
          const shColor = splats.shCoefficients
            ? evaluateGraphdecoSphericalHarmonics(
              splats.shCoefficients,
              splats.shDegree,
              viewDirection,
              splatIndex * shValuesPerSplat,
            )
            : null;
          projectedSplats.push({ splatIndex, ...projectedGaussian, shColor, gaussian: true });
        } else {
          const [x, y, viewZ, pixelsPerWorldUnit] = project(point);
          projectedSplats.push({ splatIndex, x, y, viewZ, pixelsPerWorldUnit });
        }
      }
      sortSplatRenderEntriesBackToFront(projectedSplats);
      if (projectionCache) Object.assign(projectionCache, {
        splats,
        width,
        height,
        entries: projectedSplats,
      });
    }
    let renderedSplatCount = 0;
    projectedSplats.forEach((entry) => {
      const {
        splatIndex, x, y, pixelsPerWorldUnit, gaussian, shColor, sigmaMajor, sigmaMinor, angle,
      } = entry;
      const ci = splatIndex * 4;
      const segment = getSegmentDisplayStyle(splats.segmentIds?.[splatIndex], segmentationSegments);
      if (segment && !segment.visible) return;
      const segmentRgba = segment ? segmentColorToRgba(segment.color, segment.opacity) : null;
      const alpha = Math.max(0, Math.min(1, (splats.colors?.[ci + 3] ?? 0.7) * splatOpacity * (segmentRgba?.[3] ?? 1)));
      const authoredScale = Math.max(0.1, Number(splats.scales?.[splatIndex]) || 1);
      const depthScale = Math.max(0.65, Math.min(1.8, pixelsPerWorldUnit / referencePixelsPerUnit));
      const radius = tunedSplatView
        ? Math.max(0.9, Math.min(18, authoredScale * splatPointSize * 1.4 * depthScale))
        : Math.max(1.4, 4 * depthScale);
      const red = segmentRgba ? segmentRgba[0] : tuneColor(shColor?.[0] ?? splats.colors?.[ci], 0.4);
      const green = segmentRgba ? segmentRgba[1] : tuneColor(shColor?.[1] ?? splats.colors?.[ci + 1], 0.8);
      const blue = segmentRgba ? segmentRgba[2] : tuneColor(shColor?.[2] ?? splats.colors?.[ci + 2], 1);
      if (gaussian) {
        if (drawProjectedGaussian(ctx, {
          x,
          y,
          sigmaMajor: sigmaMajor * splatPointSize,
          sigmaMinor: sigmaMinor * splatPointSize,
          angle,
          color: [red, green, blue],
          alpha,
        })) renderedSplatCount += 1;
        return;
      }
      ctx.fillStyle = `rgba(${red},${green},${blue},${alpha})`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      renderedSplatCount += 1;
    });
    statsRef.current.renderedSplats = renderedSplatCount;
  }
  if (showReferenceFrame && tunedSplatView) {
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
    const [dimensionX, dimensionY, dimensionZ] = normalizedMetadata.dimensions;
    const x0 = -0.5; const x1 = dimensionX - 0.5;
    const y0 = -0.5; const y1 = dimensionY - 0.5;
    const z0 = -0.5; const z1 = dimensionZ - 0.5;
    const framePoint = (x, y, z) => voxelToPhysical([x, y, z], normalizedMetadata);
    const corners = [
      framePoint(x0, y0, z0), framePoint(x1, y0, z0), framePoint(x1, y1, z0), framePoint(x0, y1, z0),
      framePoint(x0, y0, z1), framePoint(x1, y0, z1), framePoint(x1, y1, z1), framePoint(x0, y1, z1),
    ];
    [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].forEach(([from, to]) => {
      const a = project(corners[from]); const b = project(corners[to]);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
      ctx.strokeStyle = 'rgba(226,232,240,0.58)'; ctx.lineWidth = 1; ctx.stroke();
    });
    const positionOnAxis = (axis, value) => Math.max(
      0,
      Math.min(normalizedMetadata.dimensions[axis] - 1, Number(value) || 0),
    );
    if (showSliceGuides) {
      const sliceX = positionOnAxis(0, slicePosition?.sagittal);
      const sliceY = positionOnAxis(1, slicePosition?.coronal);
      const sliceZ = positionOnAxis(2, slicePosition?.axial);
      drawLoop([framePoint(x0, y0, sliceZ), framePoint(x1, y0, sliceZ), framePoint(x1, y1, sliceZ), framePoint(x0, y1, sliceZ)], 'rgba(59,130,246,0.9)', 1.2, [4, 3]);
      drawLoop([framePoint(x0, sliceY, z0), framePoint(x1, sliceY, z0), framePoint(x1, sliceY, z1), framePoint(x0, sliceY, z1)], 'rgba(245,158,11,0.9)', 1.2, [4, 3]);
      drawLoop([framePoint(sliceX, y0, z0), framePoint(sliceX, y1, z0), framePoint(sliceX, y1, z1), framePoint(sliceX, y0, z1)], 'rgba(16,185,129,0.9)', 1.2, [4, 3]);
    }
    ctx.fillStyle = '#bae6fd'; ctx.fillText('R', width - 24, cy); ctx.fillText('S', cx, 18); ctx.fillText('A', cx + 22, cy + 24);
  } else if (showReferenceFrame) {
    const fallbackScale = Math.min(width, height) / Math.max(...bounds.size, 1) * 0.72 * zoom;
    ctx.strokeStyle = 'rgba(226,232,240,0.72)'; ctx.lineWidth = 1; ctx.strokeRect(cx - bounds.size[0] * fallbackScale / 2, cy - bounds.size[1] * fallbackScale / 2, bounds.size[0] * fallbackScale, bounds.size[1] * fallbackScale);
    ctx.fillStyle = '#bae6fd'; ctx.fillText('R', width - 24, cy); ctx.fillText('S', cx, 18); ctx.fillText('A', cx + 22, cy + 24);
  }
}

export default function Pt3GaussianSplatViewer({
  part,
  projectId,
  volumeImageStack = EMPTY_VOLUME_IMAGE_STACK,
  splatParameters,
  mode = VIEWER_MODES.hybrid,
  rotation = { x: -18, y: 32 },
  zoom = 1,
  mirrorScale = DEFAULT_AXIS_MIRROR_SCALE,
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
  const activeMirrorScale = useMemo(
    () => normalizeAxisMirrorScale(mirrorScale),
    [mirrorScale],
  );
  const activeRayMarchSettings = { ...DEFAULT_RAY_MARCH_SETTINGS, ...(rayMarchSettings || {}) };
  const { quality, volumeOpacity, intensityThreshold, showSliceGuides, opacityRampWidth, colorLow, colorHigh } = activeRayMarchSettings;
  const activeSplatViewSettings = { ...DEFAULT_SPLAT_VIEW_SETTINGS, ...(splatViewSettings || {}) };
  const {
    opacity: configuredSplatOpacity,
    pointSize: configuredSplatPointSize,
    contrast: configuredSplatContrast,
    showSliceGuides: configuredSplatGuides,
  } = activeSplatViewSettings;
  const [status, setStatus] = useState('initializing');
  const [statusDetail, setStatusDetail] = useState(null);
  const [rendererState, setRendererState] = useState({ mode: null, type: 'canvas2d-fallback' });
  const rendererType = rendererState.mode === mode ? rendererState.type : 'canvas2d-fallback';
  const [rayRendererFallback, setRayRendererFallback] = useState(null);
  const [splats, setSplats] = useState(null);
  const [realMaxSplats, setRealMaxSplats] = useState(DEFAULT_REAL_SPLAT_BUDGET);
  const [realFitMode, setRealFitMode] = useState('voxel_direct');
  const [realGenerationVersion, setRealGenerationVersion] = useState(0);
  const cropEnabled = false;
  const isPureSplatMode = mode === VIEWER_MODES.splat || mode === VIEWER_MODES.realSplat;
  const splatOpacity = isPureSplatMode ? configuredSplatOpacity : 0.9;
  const splatPointSize = isPureSplatMode ? configuredSplatPointSize : 1;
  const splatContrast = isPureSplatMode ? configuredSplatContrast : 1;
  const splatGuidesVisible = isPureSplatMode ? configuredSplatGuides : showSliceGuides;
  const metadata = useMemo(() => buildMetadata(part), [part]);
  const segmentationContract = useMemo(() => normalizePt3Segmentation(part), [part]);
  const realSplatCameras = useMemo(() => getPt3RealSplatCameras(part), [part]);
  const [segmentationSegments, setSegmentationSegments] = useState(segmentationContract.segments);
  const asset = useMemo(() => (
    mode === VIEWER_MODES.realSplat ? getPt3RealGaussianSplatAsset(part) : getPt3GaussianSplatAsset(part)
  ), [mode, part]);

  useEffect(() => {
    setSegmentationSegments(segmentationContract.segments);
  }, [segmentationContract]);

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
    const handleSplatFailure = (error) => {
      if (mode !== VIEWER_MODES.realSplat) {
        showDeterministicSplatFallback();
        return;
      }
      if (cancelled) return;
      setSplats(null);
      setStatus('failed');
      setStatusDetail({
        error: error?.message || 'Could not load the canonical splat asset',
        note: 'Real 3DGS could not be loaded. No simplified fallback was used.',
      });
    };
    const loadSplatAsset = (url, coordinateContext = {}) => {
      workerRef.current?.terminate();
      let worker;
      try {
        worker = createSplatWorker();
      } catch {
        handleSplatFailure(new Error('3DGS asset worker is unavailable'));
        return;
      }
      workerRef.current = worker;
      worker.onmessage = (event) => {
        if (cancelled || event.data?.id !== requestId) return;
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
        if (!event.data.ok) { handleSplatFailure(new Error(event.data.error || 'Could not parse 3DGS asset')); return; }
        const parsedSplats = {
          positions: event.data.positions,
          scales: event.data.scales,
          colors: event.data.colors,
          scaleVectors: event.data.scaleVectors,
          rotations: event.data.rotations,
          shCoefficients: event.data.shCoefficients,
          shDegree: event.data.shDegree,
          shValuesPerSplat: event.data.shValuesPerSplat,
          segmentIds: event.data.segmentIds || [],
          layers: event.data.layers || [],
          metadata: event.data.metadata || {},
        };
        setSplats(prepareSplatAssetForRendering(parsedSplats, metadata, {
          ...coordinateContext,
          assetUrl: url,
          parsedMetadata: parsedSplats.metadata,
        })); setStatus('ready'); setStatusDetail(null);
      };
      worker.onerror = () => {
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
        handleSplatFailure(new Error('Could not load 3DGS asset'));
      };
      try {
        worker.postMessage({
          id: requestId,
          url: new URL(url, window.location.origin).href,
          requireCanonical: mode === VIEWER_MODES.realSplat,
        });
      } catch {
        handleSplatFailure(new Error('3DGS asset URL is invalid'));
      }
    };
    setStatus('loading'); setStatusDetail(null);
    if (mode === VIEWER_MODES.realSplat && (!asset?.url || realGenerationVersion > 0)) {
      workerRef.current?.terminate();
      workerRef.current = null;
      setSplats(null);
      if (!projectId || !part?.id) {
        setStatus('unavailable');
        setStatusDetail({ note: 'Real 3DGS unavailable. A saved PT3 part is required before fitting or training can run.' });
        return () => { cancelled = true; };
      }
      const statusUrl = `/api/projects/${encodeURIComponent(projectId)}/parts/${encodeURIComponent(part.id)}/real-gaussian-splat-assets/status`;
      const pollRealStatus = () => fetch(statusUrl)
        .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
        .then((payload) => {
          if (cancelled) return;
          const progress = Math.round(Number(payload.progress_percent) || 0);
          if (payload.status === 'pending') {
            setStatus('pending');
            setStatusDetail({ note: `${payload.stage || 'Optimizing'} • ${progress}% complete` });
            pollTimer = window.setTimeout(pollRealStatus, 750);
            return;
          }
          if (payload.status === 'ready' && payload.asset_url) {
            loadSplatAsset(payload.asset_url, { sourceMetadata: payload });
            return;
          }
          setStatus(payload.status || 'unavailable');
          setStatusDetail({
            error: payload.error || null,
            note: payload.status === 'missing' && realFitMode === 'voxel_direct'
              ? 'The voxel stack is ready for an analytic fit. Choose a splat budget, then fit voxel splats.'
              : 'Synthetic-view and hybrid fitting require a configured provider and calibrated or generated views. Simplified splats are never substituted.',
          });
        })
        .catch((error) => {
          if (cancelled) return;
          setStatus('failed');
          setStatusDetail({ error: error.message, note: 'Could not read Real 3DGS fitting or training status.' });
        });
      pollRealStatus();
      return () => { cancelled = true; if (pollTimer) window.clearTimeout(pollTimer); workerRef.current?.terminate(); };
    }
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
  }, [asset, metadata, mode, part?.id, projectId, realFitMode, realGenerationVersion, realSplatCameras.length, splatParameters?.downsample, splatParameters?.intensityMax, splatParameters?.intensityMin, splatParameters?.maxSplats, splatParameters?.opacityMax, splatParameters?.opacityMin, splatParameters?.outputFormat, splatParameters?.threshold, volumeImageStack.length]);


  useEffect(() => {
    const canvas = webglCanvasRef.current;
    let cancelled = false;
    if (!canvas || isPureSplatMode) {
      disposeThreeRenderer(threeRendererRef, canvas);
      setRendererState({ mode, type: 'canvas2d-fallback' });
      setRayRendererFallback(null);
      return undefined;
    }
    setRendererState({ mode, type: 'canvas2d-fallback' });
    setRayRendererFallback(null);
    createThreeMechanicalRenderer(canvas, {
      metadata,
      mode,
      volumeImageStack,
      segmentationLabelSlices: segmentationContract.labelSlices,
    })
      .then((renderer) => {
        if (cancelled || !renderer) {
          renderer?.dispose?.();
          return;
        }
        threeRendererRef.current?.dispose?.();
        threeRendererRef.current = renderer;
        setRendererState({ mode, type: renderer.rendererType || 'three-webgl' });
        setRayRendererFallback(null);
        if (mode === VIEWER_MODES.volume) setStatus('ready');
      })
      .catch((error) => {
        if (!cancelled) {
          disposeThreeRenderer(threeRendererRef, canvas);
          setRendererState({ mode, type: 'canvas2d-fallback' });
          if (mode === VIEWER_MODES.volume) {
            setStatus('fallback');
            setStatusDetail({
              error: error.message || 'Could not initialize ray-marched volume',
              note: 'Ray-marched volume unavailable. Showing deterministic volume bounds fallback.',
            });
          } else if (mode === VIEWER_MODES.hybrid) {
            setRayRendererFallback('Ray-marched layer unavailable. Showing the aligned 3DGS fallback only.');
          }
        }
      });
    return () => {
      cancelled = true;
      disposeThreeRenderer(threeRendererRef, canvas);
    };
  }, [isPureSplatMode, metadata, mode, segmentationContract.labelSlices, volumeImageStack]);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return undefined;
    let frameId = 0; let last = performance.now(); let frames = 0;
    const projectionCache = {};
    const render = (time) => {
      const ratio = window.devicePixelRatio || 1; const profile = QUALITY_PROFILES[quality];
      const width = Math.max(1, Math.floor(canvas.clientWidth * ratio * profile.scale)); const height = Math.max(1, Math.floor(canvas.clientHeight * ratio * profile.scale));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      threeRendererRef.current?.render?.({
        width,
        height,
        rotation,
        zoom,
        mirrorScale: activeMirrorScale,
        volumeOpacity,
        transferFunction: { opacityRampWidth, colorLow, colorHigh },
        intensityThreshold,
        sampleStep: profile.sampleStep,
        slicePosition,
        showSliceGuides,
        segmentationPalette: segmentationSegments,
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
          mirrorScale: activeMirrorScale,
          preset: MECHANICAL_TRANSFER_PRESETS.machinedMetal,
          crop: getMechanicalCropBox(metadata, cropEnabled),
          volumeOpacity,
          splatOpacity,
          splatPointSize,
          splatContrast,
          slicePosition,
          showSliceGuides: splatGuidesVisible,
          tunedSplatView: isPureSplatMode || rendererType === 'canvas2d-fallback',
          showReferenceFrame: mode !== VIEWER_MODES.hybrid || rendererType === 'canvas2d-fallback',
          projectionCache,
          segmentationSegments,
          statsRef,
        });
      }
      frames += 1; if (time - last > 500) { statsRef.current.fps = Math.round((frames * 1000) / (time - last)); frames = 0; last = time; }
      frameId = window.requestAnimationFrame(render);
    };
    frameId = window.requestAnimationFrame(render); return () => window.cancelAnimationFrame(frameId);
  }, [activeMirrorScale, colorHigh, colorLow, cropEnabled, intensityThreshold, isPureSplatMode, metadata, mode, opacityRampWidth, quality, rendererType, rotation, segmentationSegments, showSliceGuides, slicePosition, splatContrast, splatGuidesVisible, splatOpacity, splatPointSize, splats, volumeOpacity, zoom]);

  const updateRayMarchSetting = (key, value) => {
    onRayMarchSettingsChange?.({ ...activeRayMarchSettings, [key]: value });
  };

  const updateSplatViewSetting = (key, value) => {
    onSplatViewSettingsChange?.({ ...activeSplatViewSettings, [key]: value });
  };

  const updateSegmentDisplay = (segmentId, changes) => {
    setSegmentationSegments((current) => current.map((segment) => (
      segment.id === segmentId ? { ...segment, ...changes } : segment
    )));
  };

  const startRealOptimization = async () => {
    const requiresCameras = realFitMode !== 'voxel_direct';
    if (!projectId || !part?.id || (requiresCameras && realSplatCameras.length < 2) || status === 'pending') return;
    setStatus('pending');
    setStatusDetail({
      note: realFitMode === 'voxel_direct'
        ? 'Queueing analytic voxel fit • 0% complete'
        : 'Queueing calibrated 3DGS training • 0% complete',
    });
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/parts/${encodeURIComponent(part.id)}/real-gaussian-splat-assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fit_mode: realFitMode,
          cameras: requiresCameras ? realSplatCameras : [],
          parameters: {
            max_splats: Math.min(REAL_SPLAT_BROWSER_MAX, Math.max(1000, realMaxSplats)),
            sh_degree: requiresCameras ? 3 : 0,
            optimize_camera_poses: requiresCameras,
          },
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.detail || `HTTP ${response.status}`);
      setStatusDetail({ note: `${payload.stage || 'Queued'} • ${Math.round(Number(payload.progress_percent) || 0)}% complete` });
      setRealGenerationVersion((version) => version + 1);
    } catch (error) {
      setStatus('failed');
      setStatusDetail({
        error: error.message,
        note: realFitMode === 'voxel_direct'
          ? 'Voxel splat fitting was not started.'
          : 'Real 3DGS training was not started.',
      });
    }
  };

  const stats = statsRef.current; const bounds = getPhysicalBounds(metadata);
  const loadedSplatCount = splats?.positions
    ? Math.floor(splats.positions.length / 3)
    : (stats.renderedSplats ?? 0);
  const loadedVoxelFit = String(splats?.metadata?.optimization_method || '').startsWith('voxel_direct')
    || splats?.metadata?.optimization_domain === 'voxel_field';
  const modeLabel = mode === VIEWER_MODES.volume
    ? 'Ray march'
    : mode === VIEWER_MODES.realSplat
      ? loadedVoxelFit ? 'Voxel splats' : 'Real 3DGS'
      : mode === VIEWER_MODES.splat
        ? 'Simplified 3DGS'
        : 'HYBRID';
  const hasCanonicalRealAsset = asset?.url || splats?.metadata?.contract_version === 'pt3_real_3dgs/v1';
  const directFitSelected = realFitMode === 'voxel_direct';
  const realOptimizationButtonLabel = directFitSelected
    ? status === 'pending'
      ? 'Fitting voxel splats'
      : hasCanonicalRealAsset
        ? 'Recompute voxel splats'
        : 'Fit voxel splats'
    : status === 'pending'
      ? 'Training 3DGS splats'
      : hasCanonicalRealAsset
        ? 'Recompute trained splats'
        : 'Train 3DGS splats';
  const canonicalMarker = mode === VIEWER_MODES.realSplat
    && splats?.metadata?.contract_version === 'pt3_real_3dgs/v1' ? ' • canonical v1' : '';
  const readyLabel = mode === VIEWER_MODES.realSplat && loadedVoxelFit
    ? 'ready • analytic fit'
    : mode === VIEWER_MODES.realSplat
      ? 'trained'
      : mode === VIEWER_MODES.hybrid && rayRendererFallback ? 'degraded' : 'ready';
  const readyStatus = `${modeLabel} ${readyLabel}${canonicalMarker}${mode === VIEWER_MODES.hybrid ? ` • threshold ${splatParameters?.threshold ?? 'n/a'}` : ''} • ${metadata.dimensions.join('×')} voxels • ${bounds.size.map((v) => v.toFixed(1)).join('×')} mm • ${rendererType} • FPS ${stats.fps || '…'}${mode === VIEWER_MODES.volume ? ` • slices ${volumeImageStack.length}` : ` • splats ${loadedSplatCount}`}`;
  const pendingStatus = `${directFitSelected ? 'Voxel splat fitting is running' : 'Real 3DGS training is running'}${statusDetail?.note ? ` • ${statusDetail.note}` : ''}`;
  return <div
    className={`pt3-gaussian-splat-viewer${mode === VIEWER_MODES.realSplat ? ' pt3-real-splat-mode' : ''}${segmentationSegments.length > 0 ? ' pt3-has-segmentation' : ''}`}
    data-testid="pt3-gaussian-splat-viewer"
    data-mirror-x={activeMirrorScale.x}
    data-mirror-y={activeMirrorScale.y}
    data-mirror-z={activeMirrorScale.z}
  >
    <canvas
      ref={webglCanvasRef}
      className="pt3-gaussian-splat-webgl"
      aria-label="Three.js mechanical volume renderer"
      hidden={isPureSplatMode || rendererType === 'canvas2d-fallback'}
    />
    <canvas ref={canvasRef} className="pt3-gaussian-splat-canvas" aria-label="Mechanical 3DGS preview" />
    {mode === VIEWER_MODES.realSplat && (
      <fieldset
        className="pt3-real-optimization-controls"
        aria-label="Real 3DGS fitting"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (!['Tab', 'Escape'].includes(event.key)) event.stopPropagation(); }}
      >
        <legend>Real 3DGS fit</legend>
        <label className="pt3-real-fit-strategy">
          <span>Method</span>
          <select aria-label="Real 3DGS fitting strategy" value={realFitMode} onChange={(event) => setRealFitMode(event.target.value)}>
            <option value="voxel_direct">Direct voxel fit</option>
            <option value="synthetic_views">Synthetic/camera views</option>
            <option value="hybrid">Hybrid provider fit</option>
          </select>
        </label>
        <label className="pt3-real-fit-budget">
          <span>Budget</span><output>{realMaxSplats.toLocaleString()} / 100k</output>
          <input
            aria-label="Real 3DGS splat budget"
            type="range"
            min="1000"
            max={REAL_SPLAT_BROWSER_MAX}
            step="1000"
            value={realMaxSplats}
            onChange={(event) => setRealMaxSplats(Math.min(
              REAL_SPLAT_BROWSER_MAX,
              Math.max(1000, Number(event.target.value) || DEFAULT_REAL_SPLAT_BUDGET),
            ))}
          />
        </label>
        <div className="pt3-real-fit-action">
          <button type="button" aria-label={realOptimizationButtonLabel} disabled={!projectId || !part?.id || (realFitMode !== 'voxel_direct' && realSplatCameras.length < 2) || status === 'pending'} onClick={startRealOptimization}>
            {realOptimizationButtonLabel}
          </button>
          <small>{realFitMode === 'voxel_direct'
            ? 'Analytic voxel fit • no cameras'
            : realSplatCameras.length >= 2
              ? `${realSplatCameras.length} calibrated/generated views`
              : 'At least two calibrated or generated views are required'}</small>
        </div>
      </fieldset>
    )}
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
        <div className="pt3-ray-march-transfer-summary" data-testid="ray-march-transfer-summary">
          Transfer function: alpha = smoothstep(threshold, threshold + width, intensity) × density; color = mix(low, high, smoothstep(threshold, 1, intensity)).
        </div>
        <label>
          Opacity ramp width <output aria-hidden="true">{Number(opacityRampWidth).toFixed(2)}</output>
          <input aria-label="Ray-march opacity ramp width" type="range" min="0.05" max="1" step="0.01" value={opacityRampWidth} onChange={(event) => updateRayMarchSetting('opacityRampWidth', Number(event.target.value))} />
        </label>
        <label>
          Low color coefficient
          <input aria-label="Ray-march low color coefficient" type="color" value={colorLow} onChange={(event) => updateRayMarchSetting('colorLow', event.target.value)} />
        </label>
        <label>
          High color coefficient
          <input aria-label="Ray-march high color coefficient" type="color" value={colorHigh} onChange={(event) => updateRayMarchSetting('colorHigh', event.target.value)} />
        </label>
        <label>
          Density <output aria-hidden="true">{volumeOpacity.toFixed(2)}×</output>
          <input aria-label="Ray-march density" type="range" min="0.25" max="2.5" step="0.05" value={volumeOpacity} onChange={(event) => updateRayMarchSetting('volumeOpacity', Number(event.target.value))} />
        </label>
        <label>
          Threshold <output aria-hidden="true">{intensityThreshold.toFixed(2)}</output>
          <input aria-label="Ray-march intensity threshold" type="range" min="0" max="0.6" step="0.01" value={intensityThreshold} onChange={(event) => onRayMarchSettingsChange?.({ ...activeRayMarchSettings, intensityThreshold: Number(event.target.value) })} />
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
    {showSplatControls && isPureSplatMode && (
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
        <legend>{mode === VIEWER_MODES.realSplat ? 'Real 3DGS visibility' : 'Simplified 3DGS visibility'}</legend>
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
    {segmentationSegments.length > 0 && (
      <fieldset
        className="pt3-segmentation-controls"
        aria-label="Segmentation display"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerMove={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onWheel={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (!['Tab', 'Escape'].includes(event.key)) event.stopPropagation(); }}
      >
        <legend>Segments</legend>
        {segmentationSegments.map((segment) => (
          <div className="pt3-segment-row" key={segment.id}>
            <label className="pt3-segment-visibility">
              <input
                type="checkbox"
                aria-label={`Show ${segment.label}`}
                checked={segment.visible}
                onChange={(event) => updateSegmentDisplay(segment.id, { visible: event.target.checked })}
              />
              <span className="pt3-segment-swatch" style={{ '--segment-color': segment.color }} aria-hidden="true" />
              <span>{segment.label}</span>
            </label>
            <label className="pt3-segment-opacity">
              <span>Opacity</span>
              <output>{Math.round(segment.opacity * 100)}%</output>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                aria-label={`${segment.label} opacity`}
                value={segment.opacity}
                onChange={(event) => updateSegmentDisplay(segment.id, { opacity: Number(event.target.value) })}
              />
            </label>
          </div>
        ))}
      </fieldset>
    )}
    <span className="pt3-gaussian-splat-status">{status === 'ready' ? readyStatus : status === 'pending' ? pendingStatus : `${modeLabel} ${status}${statusDetail?.error ? `: ${statusDetail.error}` : ''}`}</span>
    {statusDetail?.note && mode !== VIEWER_MODES.realSplat && <span className="pt3-viewer-note">{statusDetail.note}</span>}
    {rayRendererFallback && <span className="pt3-viewer-note">{rayRendererFallback}</span>}
  </div>;
}
