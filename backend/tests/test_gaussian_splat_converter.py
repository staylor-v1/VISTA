import json
from pathlib import Path

from PIL import Image

from utils.gaussian_splat_converter import (
    SplatConversionParams,
    TransferFunction,
    build_splat_cache_key,
    convert_volume_to_splat_asset,
)
from utils.volume_loader import load_volume


def test_converts_slice_stack_pixels_to_ply_splats(tmp_path):
    stack_dir = tmp_path / "stack"
    stack_dir.mkdir()
    Image.new("L", (3, 2), color=0).save(stack_dir / "z000.png")
    image = Image.new("L", (3, 2), color=0)
    image.putpixel((1, 0), 200)
    image.putpixel((2, 1), 255)
    image.save(stack_dir / "z001.png")
    volume = load_volume(stack_dir)
    params = SplatConversionParams(transfer_function=TransferFunction(threshold=180), output_format="ply")

    asset = convert_volume_to_splat_asset(
        volume,
        volume_stack_id="stack-a",
        source_image_ids=["img-2", "img-1"],
        params=params,
        output_dir=tmp_path / "assets",
    )

    assert asset.splat_count == 2
    assert Path(asset.path).read_text(encoding="utf-8").splitlines()[2] == "element vertex 2"
    assert asset.cache_key == build_splat_cache_key(
        volume,
        volume_stack_id="stack-a",
        source_image_ids=["img-1", "img-2"],
        params=params,
    )


def test_converts_decoded_voxel_data_to_splat_json(tmp_path):
    volume = load_volume(_stack(tmp_path))
    params = SplatConversionParams(
        transfer_function=TransferFunction(threshold=10, intensity_max=20),
        output_format="splat",
        max_splats=1,
    )

    asset = convert_volume_to_splat_asset(
        volume,
        volume_stack_id="decoded-stack",
        voxel_data=[[[0, 12], [15, 20]]],
        params=params,
        output_dir=tmp_path / "assets",
    )

    payload = json.loads(Path(asset.path).read_text(encoding="utf-8"))
    assert asset.splat_count == 1
    assert len(payload["splats"]) == 1
    assert payload["metadata"]["conversion_parameters"]["max_splats"] == 1


def _stack(tmp_path):
    stack_dir = tmp_path / "placeholder"
    stack_dir.mkdir()
    Image.new("L", (2, 2), color=0).save(stack_dir / "z000.png")
    return stack_dir
