import React, { useEffect, useMemo, useRef, useState } from 'react';

const SPLAT_METADATA_KEYS = [
  'gaussian_splat_url',
  'gaussian_splat_asset_url',
  'splat_url',
  'splat_asset_url',
  'point_cloud_url',
];

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() || '';
}

function getNestedSplatUrl(metadata) {
  const candidates = [metadata?.gaussian_splat, metadata?.splat, metadata?.point_cloud];
  for (const candidate of candidates) {
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

  const sourceImages = Array.isArray(metadata.source_images) ? metadata.source_images : [];
  const splatRecord = sourceImages.find((record) => {
    const filename = String(record?.filename || '').toLowerCase();
    const kind = String(record?.kind || record?.asset_type || record?.metadata?.kind || record?.metadata?.asset_type || '').toLowerCase();
    return kind.includes('splat') || kind.includes('point_cloud') || /\.(splat|ply|ksplat|spz)(\?|$)/i.test(filename);
  });
  if (splatRecord) {
    const recordUrl = firstString(
      splatRecord.url,
      splatRecord.asset_url,
      splatRecord.href,
      splatRecord.metadata?.url,
      splatRecord.metadata?.asset_url,
    );
    if (recordUrl) return { url: recordUrl, label: splatRecord.filename || 'splat source image' };
    if (splatRecord.image_id) {
      return {
        url: `/api/images/${encodeURIComponent(String(splatRecord.image_id))}/content`,
        label: splatRecord.filename || 'splat source image',
      };
    }
  }

  return null;
}

function makePreviewPoints(seedText) {
  let seed = Array.from(seedText || 'pt3-splat').reduce((acc, char) => acc + char.charCodeAt(0), 0) || 1;
  const points = [];
  for (let index = 0; index < 96; index += 1) {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    const angle = (index / 96) * Math.PI * 2;
    const radius = 0.2 + ((seed >>> 8) % 70) / 100;
    const z = (((seed >>> 16) % 200) / 100) - 1;
    points.push(Math.cos(angle) * radius, Math.sin(angle) * radius, z * 0.65);
  }
  return new Float32Array(points);
}

function parseAsciiPointCloud(text) {
  const points = [];
  text.split(/\r?\n/).forEach((line) => {
    const values = line.trim().split(/[\s,]+/).slice(0, 3).map(Number);
    if (values.length === 3 && values.every(Number.isFinite)) points.push(...values);
  });
  if (points.length < 9) return null;
  const maxAbs = points.reduce((max, value) => Math.max(max, Math.abs(value)), 1);
  return new Float32Array(points.map((value) => value / maxAbs));
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(message || 'Unable to compile WebGL shader');
  }
  return shader;
}

function createProgram(gl) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, `
    attribute vec3 a_position;
    uniform float u_time;
    void main() {
      float c = cos(u_time * 0.0002);
      float s = sin(u_time * 0.0002);
      vec3 rotated = vec3(
        a_position.x * c - a_position.z * s,
        a_position.y,
        a_position.x * s + a_position.z * c
      );
      gl_Position = vec4(rotated.xy * 0.78, 0.0, 1.0);
      gl_PointSize = 5.0 + (1.0 - rotated.z) * 2.0;
    }
  `);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    void main() {
      vec2 delta = gl_PointCoord - vec2(0.5);
      float alpha = smoothstep(0.5, 0.05, length(delta));
      gl_FragColor = vec4(0.34, 0.83, 1.0, alpha * 0.88);
    }
  `);
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(message || 'Unable to link WebGL program');
  }
  return program;
}

export default function Pt3GaussianSplatViewer({ part, projectId, splatParameters }) {
  const canvasRef = useRef(null);
  const [status, setStatus] = useState('initializing');
  const [statusDetail, setStatusDetail] = useState(null);
  const [pointData, setPointData] = useState(null);
  const generationRequestedRef = useRef(null);
  const asset = useMemo(() => getPt3GaussianSplatAsset(part), [part]);

  useEffect(() => {
    let cancelled = false;
    async function loadAsset() {
      setStatusDetail(null);
      if (!asset?.url) {
        if (projectId && part?.id) {
          setStatus('loading');
          try {
            const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/parts/${encodeURIComponent(part.id)}/volume-splat-assets/status`);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            if (cancelled) return;
            setStatusDetail(payload);
            if (payload.status === 'pending') {
              setStatus('pending');
              setPointData(null);
              return;
            }
            if (payload.status === 'failed') {
              setStatus('failed');
              setPointData(null);
              return;
            }
            if (payload.status === 'ready' && payload.asset_url) {
              setPointData(makePreviewPoints(payload.asset_url));
              setStatus('ready');
              return;
            }
          } catch (error) {
            if (cancelled) return;
            setStatusDetail({ error: error.message });
            setStatus('failed');
            setPointData(null);
            return;
          }
        }
        const requestKey = `${projectId || ''}:${part?.id || ''}`;
        if (projectId && part?.id && generationRequestedRef.current !== requestKey) {
          generationRequestedRef.current = requestKey;
          setStatus('generating');
          try {
            const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/parts/${encodeURIComponent(part.id)}/volume-splat-assets`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                source_image_ids: [],
                transfer_function: {
                  threshold: Number(splatParameters?.threshold) || 1,
                  intensity_min: Number(splatParameters?.intensityMin) || 0,
                  intensity_max: Number(splatParameters?.intensityMax) || 255,
                  opacity_min: Number(splatParameters?.opacityMin) || 0.05,
                  opacity_max: Number(splatParameters?.opacityMax) || 1,
                  color_map: 'grayscale',
                },
                downsample: Number(splatParameters?.downsample) || 1,
                max_splats: Number(splatParameters?.maxSplats) || 100000,
                output_format: splatParameters?.outputFormat || 'json',
              }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            if (cancelled) return;
            setStatusDetail(payload);
            setStatus(payload.status === 'pending' ? 'pending' : payload.status || 'pending');
            return;
          } catch (error) {
            if (cancelled) return;
            setStatusDetail({ error: error.message });
            setStatus('failed');
            setPointData(null);
            return;
          }
        }
        setStatus('missing');
        setPointData(null);
        return;
      }
      setStatus('loading');
      try {
        const response = await fetch(asset.url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (cancelled) return;
        setPointData(parseAsciiPointCloud(text) || makePreviewPoints(asset.url));
        setStatus('ready');
      } catch (error) {
        if (cancelled) return;
        setStatusDetail({ error: error.message });
        setPointData(null);
        setStatus('failed');
      }
    }
    loadAsset();
    return () => { cancelled = true; };
  }, [asset, part?.id, projectId, splatParameters]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pointData) return undefined;
    const gl = canvas.getContext('webgl', { alpha: true, antialias: true });
    if (!gl || typeof gl.createShader !== 'function') {
      setStatus('webgl-unavailable');
      return undefined;
    }

    let frameId = 0;
    let program;
    try {
      program = createProgram(gl);
    } catch (error) {
      setStatus('webgl-unavailable');
      return undefined;
    }
    const buffer = gl.createBuffer();
    const positionLocation = gl.getAttribLocation(program, 'a_position');
    const timeLocation = gl.getUniformLocation(program, 'u_time');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, pointData, gl.STATIC_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const render = (time) => {
      const { clientWidth, clientHeight } = canvas;
      const width = Math.max(1, Math.floor(clientWidth * window.devicePixelRatio));
      const height = Math.max(1, Math.floor(clientHeight * window.devicePixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniform1f(timeLocation, time);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, pointData.length / 3);
      frameId = window.requestAnimationFrame(render);
    };
    frameId = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(frameId);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, [pointData]);

  const thresholdLabel = Number.isFinite(Number(splatParameters?.threshold))
    ? ` • threshold ${splatParameters.threshold}`
    : '';
  const statusText = status === 'ready'
    ? `Gaussian splat loaded from ${asset?.label || 'metadata'}${thresholdLabel}`
    : status === 'pending'
      ? `Gaussian splat preprocessing is still running${thresholdLabel}`
      : status === 'generating'
        ? `Creating Gaussian splat preview from image stack${thresholdLabel}`
        : status === 'loading'
        ? `Loading Gaussian splat preview${thresholdLabel}`
        : status === 'failed'
          ? `Gaussian splat preview unavailable${statusDetail?.error ? `: ${statusDetail.error}` : ''}${thresholdLabel}`
          : status === 'missing'
            ? `No Gaussian splat asset is available${thresholdLabel}`
            : status === 'webgl-unavailable'
              ? `WebGL unavailable for Gaussian splat preview${thresholdLabel}`
              : `Loading Gaussian splat preview${thresholdLabel}`;

  return (
    <div className="pt3-gaussian-splat-viewer" data-testid="pt3-gaussian-splat-viewer">
      <canvas ref={canvasRef} className="pt3-gaussian-splat-canvas" aria-label="Gaussian splat preview" />
      <span className="pt3-gaussian-splat-status">{statusText}</span>
    </div>
  );
}
