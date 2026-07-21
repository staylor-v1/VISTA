"""Trusted adapter contract for calibrated, optimized Gaussian splatting.

VISTA's built-in volume converter is intentionally *not* routed through this
module. A real provider must optimize the canonical 3DGS parameter families
and return an asset produced from calibrated multi-view images. Deployments can
connect CUDA/PyTorch or a service-specific trainer without making it a core
dependency of the lightweight VISTA API.
"""

from __future__ import annotations

import hashlib
import importlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence


REQUIRED_OPTIMIZED_PARAMETERS = frozenset(
    {
        "means",
        "covariance",
        "rotation",
        "opacity",
        "spherical_harmonics",
    }
)


class RealGaussianSplatOptimizationError(RuntimeError):
    """Raised when a configured provider violates the real-3DGS contract."""


@dataclass(frozen=True)
class RealGaussianSplatAsset:
    path: str
    cache_key: str
    splat_count: int
    metadata: dict[str, Any]


def build_real_splat_cache_key(
    *,
    volume_stack_id: str,
    source_image_ids: Sequence[str],
    source_files: Sequence[str],
    cameras: Sequence[Mapping[str, Any]],
    parameters: Mapping[str, Any],
) -> str:
    payload = {
        "version": 1,
        "representation": "real_3dgs",
        "volume_stack_id": volume_stack_id,
        "source_image_ids": list(source_image_ids),
        "source_files": list(source_files),
        "cameras": list(cameras),
        "parameters": dict(parameters),
    }
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return f"pt3-real-3dgs-{digest}"


def optimize_real_gaussian_splat_asset(
    *,
    provider_path: str,
    volume_stack_id: str,
    source_image_ids: Sequence[str],
    source_files: Sequence[str],
    cameras: Sequence[Mapping[str, Any]],
    parameters: Mapping[str, Any],
    output_dir: str | Path,
    segmentation: Mapping[str, Any] | None = None,
) -> RealGaussianSplatAsset:
    """Invoke a trusted provider and validate its optimized-asset result.

    The provider receives one JSON-compatible dictionary and may return either
    a mapping or an object exposing ``model_dump``. Client requests never
    choose the import path.
    """
    safe_provider_path = str(provider_path or "").strip()
    if "." not in safe_provider_path:
        raise RealGaussianSplatOptimizationError("Real 3DGS optimizer is not configured")
    if len(cameras) < 2:
        raise RealGaussianSplatOptimizationError("Real 3DGS requires at least two calibrated camera views")

    cache_key = build_real_splat_cache_key(
        volume_stack_id=volume_stack_id,
        source_image_ids=source_image_ids,
        source_files=source_files,
        cameras=cameras,
        parameters=parameters,
    )
    safe_output_dir = Path(output_dir).resolve()
    safe_output_dir.mkdir(parents=True, exist_ok=True)
    module_name, function_name = safe_provider_path.rsplit(".", 1)
    try:
        provider = getattr(importlib.import_module(module_name), function_name)
    except (AttributeError, ImportError) as exc:
        raise RealGaussianSplatOptimizationError(f"Could not load real 3DGS provider {safe_provider_path}") from exc

    request = {
        "contract_version": "pt3_real_3dgs/v1",
        "representation": "real_3dgs",
        "cache_key": cache_key,
        "volume_stack_id": volume_stack_id,
        "source_image_ids": list(source_image_ids),
        "source_files": list(source_files),
        "cameras": list(cameras),
        "parameters": dict(parameters),
        "segmentation": dict(segmentation or {}),
        "output_dir": str(safe_output_dir),
    }
    result = provider(request)
    if hasattr(result, "model_dump"):
        result = result.model_dump(mode="python")
    if not isinstance(result, Mapping):
        raise RealGaussianSplatOptimizationError("Real 3DGS provider must return a mapping")

    asset_path = Path(str(result.get("asset_path") or "")).resolve()
    if safe_output_dir not in asset_path.parents:
        raise RealGaussianSplatOptimizationError("Real 3DGS provider returned an asset outside its output directory")
    if not asset_path.is_file() or asset_path.suffix.lower() not in {".ply", ".splat", ".json"}:
        raise RealGaussianSplatOptimizationError("Real 3DGS provider did not produce a supported asset")

    metadata = dict(result.get("metadata") or {})
    optimized = {str(item) for item in metadata.get("optimized_parameters") or []}
    missing = REQUIRED_OPTIMIZED_PARAMETERS - optimized
    if bool(parameters.get("optimize_camera_poses", True)):
        missing -= {"camera_poses"}
        if "camera_poses" not in optimized:
            missing = set(missing) | {"camera_poses"}
    if missing:
        raise RealGaussianSplatOptimizationError(
            "Real 3DGS provider did not confirm optimization of: " + ", ".join(sorted(missing))
        )

    splat_count = int(result.get("splat_count") or metadata.get("splat_count") or 0)
    if splat_count < 1:
        raise RealGaussianSplatOptimizationError("Real 3DGS provider returned an empty asset")
    return RealGaussianSplatAsset(
        path=str(asset_path),
        cache_key=cache_key,
        splat_count=splat_count,
        metadata={
            **metadata,
            "contract_version": "pt3_real_3dgs/v1",
            "representation": "real_3dgs",
            "cache_key": cache_key,
            "splat_count": splat_count,
        },
    )
