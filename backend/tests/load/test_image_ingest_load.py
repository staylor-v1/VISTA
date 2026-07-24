"""Scheduled backend load contracts.

These tests intentionally exercise request volume beyond the pull-request
feedback budget. Run them explicitly with ``pytest -m load -n 0 tests/load``.
"""

from __future__ import annotations

import io

import pytest
from PIL import Image


def _make_encoded_index_png(index: int) -> io.BytesIO:
    """Return a one-pixel PNG whose RGB value losslessly encodes ``index``."""

    image = Image.new(
        "RGB",
        (1, 1),
        ((index >> 16) & 0xFF, (index >> 8) & 0xFF, index & 0xFF),
    )
    payload = io.BytesIO()
    image.save(payload, format="PNG")
    payload.seek(0)
    return payload


def _decode_encoded_index_png(payload: bytes) -> int:
    with Image.open(io.BytesIO(payload)) as image:
        red, green, blue = image.convert("RGB").getpixel((0, 0))
    return (red << 16) | (green << 8) | blue


@pytest.mark.load
def test_upload_and_list_1000_tiny_encoded_images(client, monkeypatch):
    """Ingest and list 1,000 distinguishable images without dropping records."""

    image_count = 1_000
    project_response = client.post(
        "/api/projects/",
        json={
            "name": "1000-image-load",
            "description": "scheduled image-ingest load contract",
            "meta_group_id": "load-tests",
        },
    )
    assert project_response.status_code == 201, project_response.text
    project_id = project_response.json()["id"]
    uploaded_indices: set[int] = set()

    async def validate_and_capture_upload(
        *, bucket_name, object_name, file_data, length, content_type
    ):
        del bucket_name, length
        payload = file_data.read()
        file_data.seek(0)
        decoded_index = _decode_encoded_index_png(payload)
        assert object_name.endswith(f"encoded-{decoded_index:04d}.png")
        assert content_type == "image/png"
        uploaded_indices.add(decoded_index)
        return True

    monkeypatch.setattr(
        "routers.images.upload_file_to_s3",
        validate_and_capture_upload,
    )

    for index in range(1, image_count + 1):
        response = client.post(
            f"/api/projects/{project_id}/images",
            files={
                "file": (
                    f"encoded-{index:04d}.png",
                    _make_encoded_index_png(index),
                    "image/png",
                )
            },
        )
        assert response.status_code == 201, response.text
        assert response.json()["filename"] == f"encoded-{index:04d}.png"

    expected_indices = set(range(1, image_count + 1))
    assert uploaded_indices == expected_indices

    listed_response = client.get(
        f"/api/projects/{project_id}/images?limit={image_count}"
    )
    assert listed_response.status_code == 200, listed_response.text
    listed_images = listed_response.json()
    assert len(listed_images) == image_count
    assert {item["filename"] for item in listed_images} == {
        f"encoded-{index:04d}.png" for index in expected_indices
    }
