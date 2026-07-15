"""Convert PT3 voxel volumes into deterministic Gaussian splat assets.

The converter is intentionally dependency-light: it consumes VolumeInfo from
``utils.volume_loader`` plus either decoded voxel data or readable source image
paths, then emits a small interchange asset (.ply, .splat JSON, or metadata
JSON) suitable for caching and downstream rendering pipelines.
"""

from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Literal, Sequence

from PIL import Image, ImageSequence

from utils.volume_loader import VolumeInfo

SplatOutputFormat = Literal["ply", "splat", "json"]


@dataclass(frozen=True)
class TransferFunction:
    threshold: float = 1.0
    intensity_min: float = 0.0
    intensity_max: float = 255.0
    opacity_min: float = 0.05
    opacity_max: float = 1.0
    color_map: str = "grayscale"


@dataclass(frozen=True)
class SplatConversionParams:
    transfer_function: TransferFunction = TransferFunction()
    downsample: int = 1
    max_splats: int | None = 100_000
    output_format: SplatOutputFormat = "ply"


@dataclass(frozen=True)
class SplatPrimitive:
    x: float
    y: float
    z: float
    scale: float
    opacity: float
    red: int
    green: int
    blue: int
    intensity: float


@dataclass(frozen=True)
class SplatAsset:
    path: str
    cache_key: str
    output_format: SplatOutputFormat
    splat_count: int
    metadata: dict[str, Any]


def build_splat_cache_key(
    volume_info: VolumeInfo,
    *,
    volume_stack_id: str,
    source_image_ids: Sequence[str] | None = None,
    params: SplatConversionParams | None = None,
) -> str:
    """Return a stable cache key for a PT3 volume conversion contract."""
    payload = {
        "version": 1,
        "volume_stack_id": volume_stack_id,
        "source_image_ids": sorted(str(item) for item in (source_image_ids or ())),
        "source_files": sorted(str(item) for item in volume_info.source_files),
        "dimensions": tuple(int(value) for value in volume_info.shape),
        "format": volume_info.format,
        "dtype": volume_info.dtype,
        "params": asdict(params or SplatConversionParams()),
    }
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return f"pt3-splat-{digest}"


def convert_volume_to_splat_asset(
    volume_info: VolumeInfo,
    *,
    volume_stack_id: str,
    output_dir: str | Path,
    source_image_ids: Sequence[str] | None = None,
    params: SplatConversionParams | None = None,
    voxel_data: Sequence[Sequence[Sequence[float]]] | None = None,
) -> SplatAsset:
    """Materialize a cached splat asset for a supported PT3 volume."""
    conversion_params = params or SplatConversionParams()
    _validate_params(conversion_params)
    cache_key = build_splat_cache_key(
        volume_info,
        volume_stack_id=volume_stack_id,
        source_image_ids=source_image_ids,
        params=conversion_params,
    )
    extension = "json" if conversion_params.output_format in {"json", "splat"} else conversion_params.output_format
    asset_dir = Path(output_dir)
    asset_dir.mkdir(parents=True, exist_ok=True)
    asset_path = asset_dir / f"{cache_key}.{extension}"

    if asset_path.exists():
        metadata = _metadata(volume_info, volume_stack_id, source_image_ids, conversion_params, cache_key, None)
        return SplatAsset(str(asset_path), cache_key, conversion_params.output_format, _cached_splat_count(asset_path), metadata)

    splats = list(_iter_splats(volume_info, conversion_params, voxel_data=voxel_data))
    if conversion_params.max_splats is not None and len(splats) > conversion_params.max_splats:
        stride = max(1, math.ceil(len(splats) / conversion_params.max_splats))
        splats = splats[::stride][: conversion_params.max_splats]

    metadata = _metadata(volume_info, volume_stack_id, source_image_ids, conversion_params, cache_key, len(splats))
    if conversion_params.output_format == "ply":
        _write_ply(asset_path, splats)
    else:
        _write_json(asset_path, splats, metadata, include_splats=conversion_params.output_format == "splat")
    return SplatAsset(str(asset_path), cache_key, conversion_params.output_format, len(splats), metadata)


def _validate_params(params: SplatConversionParams) -> None:
    if params.downsample < 1:
        raise ValueError("downsample must be at least 1")
    if params.max_splats is not None and params.max_splats < 1:
        raise ValueError("max_splats must be positive when provided")
    tf = params.transfer_function
    if tf.intensity_max <= tf.intensity_min:
        raise ValueError("intensity_max must be greater than intensity_min")
    if tf.threshold < tf.intensity_min or tf.threshold > tf.intensity_max:
        raise ValueError("threshold must be within the intensity range")


def _iter_splats(volume_info: VolumeInfo, params: SplatConversionParams, *, voxel_data=None) -> Iterable[SplatPrimitive]:
    source = _iter_decoded_voxels(voxel_data) if voxel_data is not None else _iter_source_voxels(volume_info)
    step = params.downsample
    for z, y, x, value in source:
        if z % step or y % step or x % step:
            continue
        splat = _splat_from_intensity(x, y, z, float(value), params)
        if splat is not None:
            yield splat


def _iter_decoded_voxels(voxel_data):
    for z, plane in enumerate(voxel_data):
        for y, row in enumerate(plane):
            for x, value in enumerate(row):
                yield z, y, x, value


def _iter_source_voxels(volume_info: VolumeInfo):
    if volume_info.format == "slice_stack":
        for z, source_file in enumerate(volume_info.source_files):
            with Image.open(source_file) as image:
                yield from _iter_image_pixels(z, image)
        return
    if volume_info.format == "multipage_tiff":
        with Image.open(volume_info.source_files[0]) as image:
            for z, frame in enumerate(ImageSequence.Iterator(image)):
                yield from _iter_image_pixels(z, frame)
        return
    raise ValueError("Decoded voxel_data is required for non-image volume formats")


def _iter_image_pixels(z: int, image: Image.Image):
    grayscale = image.convert("L")
    width, height = grayscale.size
    pixels = grayscale.load()
    for y in range(height):
        for x in range(width):
            yield z, y, x, pixels[x, y]


def _splat_from_intensity(x: int, y: int, z: int, intensity: float, params: SplatConversionParams) -> SplatPrimitive | None:
    tf = params.transfer_function
    if intensity < tf.threshold:
        return None
    normalized = max(0.0, min(1.0, (intensity - tf.intensity_min) / (tf.intensity_max - tf.intensity_min)))
    opacity = tf.opacity_min + normalized * (tf.opacity_max - tf.opacity_min)
    if tf.color_map == "hot":
        red, green, blue = 255, int(255 * normalized), int(96 * normalized)
    else:
        value = int(round(255 * normalized))
        red = green = blue = value
    return SplatPrimitive(float(x), float(y), float(z), float(params.downsample), float(opacity), red, green, blue, intensity)


def _write_ply(path: Path, splats: Sequence[SplatPrimitive]) -> None:
    with path.open("w", encoding="utf-8") as file_obj:
        file_obj.write("ply\nformat ascii 1.0\n")
        file_obj.write(f"element vertex {len(splats)}\n")
        for field in ("x", "y", "z", "scale", "opacity"):
            file_obj.write(f"property float {field}\n")
        for field in ("red", "green", "blue"):
            file_obj.write(f"property uchar {field}\n")
        file_obj.write("end_header\n")
        for splat in splats:
            file_obj.write(f"{splat.x} {splat.y} {splat.z} {splat.scale} {splat.opacity:.6f} {splat.red} {splat.green} {splat.blue}\n")


def _write_json(path: Path, splats: Sequence[SplatPrimitive], metadata: dict[str, Any], *, include_splats: bool) -> None:
    payload = {"metadata": metadata}
    if include_splats:
        payload["splats"] = [asdict(splat) for splat in splats]
    path.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")


def _cached_splat_count(path: Path) -> int:
    if path.suffix == ".ply":
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith("element vertex "):
                return int(line.rsplit(" ", 1)[-1])
    payload = json.loads(path.read_text(encoding="utf-8"))
    return int(payload.get("metadata", {}).get("splat_count") or len(payload.get("splats", [])))


def _metadata(volume_info, volume_stack_id, source_image_ids, params, cache_key, splat_count):
    return {
        "asset_type": "gaussian_splat",
        "volume_stack_id": volume_stack_id,
        "source_image_ids": list(source_image_ids or []),
        "dimensions": list(volume_info.shape),
        "source_files": list(volume_info.source_files),
        "cache_key": cache_key,
        "conversion_parameters": asdict(params),
        "splat_count": splat_count,
    }
