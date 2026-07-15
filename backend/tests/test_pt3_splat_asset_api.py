import json
from pathlib import Path

from PIL import Image


def test_pt3_part_volume_splat_asset_route_updates_metadata(client, tmp_path):
    headers = {"X-User-Id": "pt3-splat@example.com", "X-User-Groups": '["pt3-splat-group"]'}
    project = client.post(
        "/api/projects",
        headers=headers,
        json={"name": "PT3 splat", "description": "", "meta_group_id": "pt3-splat-group", "project_type": "PT3"},
    ).json()
    part = client.post(
        f"/api/projects/{project['id']}/parts",
        headers=headers,
        json={"serial_number": "PT3-SPLAT-001", "metadata": {"volume_stack_id": "stack-from-part"}},
    ).json()
    stack_dir = tmp_path / "stack"
    stack_dir.mkdir()
    image = Image.new("L", (2, 2), color=0)
    image.putpixel((0, 1), 250)
    image.save(stack_dir / "z000.png")

    response = client.post(
        f"/api/projects/{project['id']}/parts/{part['id']}/volume-splat-assets",
        headers=headers,
        json={
            "source_path": str(stack_dir),
            "source_image_ids": ["slice-image-1"],
            "transfer_function": {"threshold": 200},
            "output_format": "json",
        },
    )

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["splat_count"] == 1
    assert Path(payload["asset_path"]).exists()
    assert payload["asset_url"].endswith(payload["cache_key"])

    parts = client.get(f"/api/projects/{project['id']}/parts", headers=headers).json()
    metadata = parts[0]["metadata"]["pt3_splat_asset"]
    assert metadata["volume_stack_id"] == "stack-from-part"
    assert metadata["source_image_ids"] == ["slice-image-1"]
    assert metadata["asset_path"] == payload["asset_path"]

    download = client.get(payload["asset_url"], headers=headers)
    assert download.status_code == 200
    assert download.json()["metadata"]["cache_key"] == payload["cache_key"]
