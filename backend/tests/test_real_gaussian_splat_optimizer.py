from pathlib import Path

import pytest

from utils.real_gaussian_splat_optimizer import (
    RealGaussianSplatOptimizationError,
    optimize_real_gaussian_splat_asset,
)


def _provider_request(request):
    asset_path = Path(request["output_dir"]) / "optimized.ply"
    asset_path.write_text("ply\nformat ascii 1.0\nelement vertex 1\nend_header\n0 0 0\n", encoding="utf-8")
    return {
        "asset_path": str(asset_path),
        "splat_count": 1,
        "metadata": {
            "optimized_parameters": [
                "means",
                "covariance",
                "rotation",
                "opacity",
                "spherical_harmonics",
                "camera_poses",
            ],
        },
    }


def _incomplete_provider(request):
    result = _provider_request(request)
    result["metadata"]["optimized_parameters"] = ["means", "opacity"]
    return result


def _camera(image_id):
    return {
        "image_id": image_id,
        "width": 16,
        "height": 16,
        "intrinsics": [1, 0, 8, 0, 1, 8, 0, 0, 1],
        "rotation_quaternion": [1, 0, 0, 0],
        "translation": [0, 0, 0],
    }


def test_real_optimizer_invokes_trusted_provider_and_validates_canonical_parameters(tmp_path):
    asset = optimize_real_gaussian_splat_asset(
        provider_path=f"{__name__}._provider_request",
        volume_stack_id="stack-a",
        source_image_ids=["a", "b"],
        source_files=["a.png", "b.png"],
        cameras=[_camera("a"), _camera("b")],
        parameters={"optimize_camera_poses": True, "sh_degree": 3},
        output_dir=tmp_path,
        segmentation={"segments": []},
    )

    assert asset.splat_count == 1
    assert asset.cache_key.startswith("pt3-real-3dgs-")
    assert asset.metadata["representation"] == "real_3dgs"


def test_real_optimizer_rejects_missing_camera_views(tmp_path):
    with pytest.raises(RealGaussianSplatOptimizationError, match="at least two calibrated"):
        optimize_real_gaussian_splat_asset(
            provider_path=f"{__name__}._provider_request",
            volume_stack_id="stack-a",
            source_image_ids=["a"],
            source_files=["a.png"],
            cameras=[_camera("a")],
            parameters={"optimize_camera_poses": True},
            output_dir=tmp_path,
        )


def test_real_optimizer_rejects_provider_that_does_not_optimize_real_3dgs_fields(tmp_path):
    with pytest.raises(RealGaussianSplatOptimizationError, match="covariance"):
        optimize_real_gaussian_splat_asset(
            provider_path=f"{__name__}._incomplete_provider",
            volume_stack_id="stack-a",
            source_image_ids=["a", "b"],
            source_files=["a.png", "b.png"],
            cameras=[_camera("a"), _camera("b")],
            parameters={"optimize_camera_poses": True},
            output_dir=tmp_path,
        )
