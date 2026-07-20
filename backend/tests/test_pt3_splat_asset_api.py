import json
from pathlib import Path

from PIL import Image

from routers import inspection_workbench


def test_pt3_cache_root_honors_configured_cache_dir(monkeypatch, tmp_path):
    configured_root = tmp_path / "writable-cache"
    monkeypatch.setenv("CACHE_DIR", str(configured_root))

    assert inspection_workbench._pt3_cache_root() == configured_root.resolve()


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
    assert payload["status"] == "pending"

    status_response = client.get(
        f"/api/projects/{project['id']}/parts/{part['id']}/volume-splat-assets/status",
        headers=headers,
    )
    assert status_response.status_code == 200
    payload = status_response.json()
    assert payload["status"] == "ready"
    assert payload["splat_count"] == 1
    assert payload["asset_url"].endswith(payload["cache_key"])

    parts = client.get(f"/api/projects/{project['id']}/parts", headers=headers).json()
    metadata = parts[0]["metadata"]["pt3_splat_asset"]
    assert metadata["volume_stack_id"] == "stack-from-part"
    assert metadata["source_image_ids"] == ["slice-image-1"]
    assert Path(metadata["asset_path"]).exists()

    download = client.get(payload["asset_url"], headers=headers)
    assert download.status_code == 200
    assert download.json()["metadata"]["cache_key"] == payload["cache_key"]


def test_pt3_part_volume_splat_status_reports_missing_and_failed(client):
    headers = {"X-User-Id": "pt3-splat-status@example.com", "X-User-Groups": '["pt3-splat-status-group"]'}
    project = client.post(
        "/api/projects",
        headers=headers,
        json={"name": "PT3 splat status", "description": "", "meta_group_id": "pt3-splat-status-group", "project_type": "PT3"},
    ).json()
    part = client.post(
        f"/api/projects/{project['id']}/parts",
        headers=headers,
        json={"serial_number": "PT3-SPLAT-STATUS-001", "metadata": {"volume_stack_id": "stack-status"}},
    ).json()

    missing = client.get(
        f"/api/projects/{project['id']}/parts/{part['id']}/volume-splat-assets/status",
        headers=headers,
    )
    assert missing.status_code == 200
    assert missing.json()["status"] == "missing"

    response = client.post(
        f"/api/projects/{project['id']}/parts/{part['id']}/volume-splat-assets",
        headers=headers,
        json={"source_path": "/definitely/not/a/volume", "output_format": "json"},
    )
    assert response.status_code == 200
    failed = client.get(
        f"/api/projects/{project['id']}/volume-stacks/stack-status/splat-status",
        headers=headers,
    )
    assert failed.status_code == 200
    assert failed.json()["status"] == "failed"

def test_pt3_splat_creation_infers_source_path_from_part_image_stack(client):
    import base64
    import io

    headers = {"X-User-Id": "pt3-splat-stack@example.com", "X-User-Groups": '["pt3-splat-stack-group"]'}
    project = client.post(
        "/api/projects",
        headers=headers,
        json={"name": "PT3 inferred splat", "description": "", "meta_group_id": "pt3-splat-stack-group", "project_type": "PT3"},
    ).json()

    buffer = io.BytesIO()
    image = Image.new("L", (2, 2), color=0)
    image.putpixel((1, 1), 255)
    image.save(buffer, format="PNG")
    image_bytes = buffer.getvalue()
    encoded = base64.b64encode(image_bytes).decode("ascii")
    upload = client.post(
        f"/api/projects/{project['id']}/images",
        headers=headers,
        files={"file": ("stack-z000.png", io.BytesIO(image_bytes), "image/png")},
        data={"metadata": json.dumps({"volume_stack_id": "stack-inferred", "slice_index": 0, "analysis_inline_image_base64": encoded})},
    )
    assert upload.status_code == 201, upload.text
    image_record = upload.json()

    part = client.post(
        f"/api/projects/{project['id']}/parts",
        headers=headers,
        json={
            "serial_number": "PT3-SPLAT-INFERRED-001",
            "metadata": {
                "volume_stack_id": "stack-inferred",
                "source_images": [{"filename": "stack-z000.png", "image_id": image_record["id"], "slice_index": 0}],
            },
        },
    ).json()

    response = client.post(
        f"/api/projects/{project['id']}/parts/{part['id']}/volume-splat-assets",
        headers=headers,
        json={"transfer_function": {"threshold": 200}, "output_format": "json"},
    )

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "pending"
    status_response = client.get(
        f"/api/projects/{project['id']}/parts/{part['id']}/volume-splat-assets/status",
        headers=headers,
    )
    assert status_response.status_code == 200
    payload = status_response.json()
    assert payload["status"] == "ready"
    assert payload["splat_count"] == 1
    assert payload["metadata"]["source_image_ids"] == [image_record["id"]]
    assert "pt3_volume_stacks" in payload["metadata"]["conversion_parameters"]["source_path"]
