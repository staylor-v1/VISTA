import io
import uuid
import zipfile
import pytest
import numpy as np
from PIL import Image


def _make_png_bytes(size=(10, 10), color=(255, 0, 0)):
    img = Image.new("RGB", size, color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf


def test_list_images_nonexistent_project_returns_empty(client):
    pid = uuid.uuid4()
    r = client.get(f"/api/projects/{pid}/images")
    assert r.status_code == 200
    assert r.json() == []


def test_upload_image_and_list(client):
    # Create project
    pr = client.post("/api/projects/", json={"name": "P", "description": None, "meta_group_id": "g"})
    assert pr.status_code == 201
    pid = pr.json()["id"]

    # Upload image
    img_bytes = _make_png_bytes()
    files = {
        "file": ("test.png", img_bytes, "image/png"),
    }
    data = {"metadata": '{"a":1}'}
    ur = client.post(f"/api/projects/{pid}/images", files=files, data=data)
    assert ur.status_code == 201
    body = ur.json()
    assert body["filename"] == "test.png"
    assert body["project_id"] == pid
    # List
    lr = client.get(f"/api/projects/{pid}/images")
    assert lr.status_code == 200
    items = lr.json()
    assert len(items) == 1


def test_upload_image_bad_metadata(client):
    pr = client.post("/api/projects/", json={"name": "P2", "description": None, "meta_group_id": "g"})
    pid = pr.json()["id"]
    img_bytes = _make_png_bytes()
    files = {"file": ("x.png", img_bytes, "image/png")}
    data = {"metadata": "{not-json}"}
    r = client.post(f"/api/projects/{pid}/images", files=files, data=data)
    assert r.status_code == 400


def test_upload_numpy_voxel_data_accepts_3d_arrays(client):
    pr = client.post("/api/projects/", json={"name": "P5", "description": None, "meta_group_id": "g"})
    pid = pr.json()["id"]

    voxel_array = np.zeros((8, 16, 16), dtype=np.float32)
    payload = io.BytesIO()
    np.save(payload, voxel_array)
    payload.seek(0)

    r = client.post(
        f"/api/projects/{pid}/images",
        files={"file": ("volume.npy", payload, "application/octet-stream")},
    )
    assert r.status_code == 201
    assert r.json()["filename"] == "volume.npy"


def test_upload_numpy_voxel_data_rejects_non_3d_arrays(client):
    pr = client.post("/api/projects/", json={"name": "P6", "description": None, "meta_group_id": "g"})
    pid = pr.json()["id"]

    voxel_array = np.zeros((16, 16), dtype=np.float32)
    payload = io.BytesIO()
    np.save(payload, voxel_array)
    payload.seek(0)

    r = client.post(
        f"/api/projects/{pid}/images",
        files={"file": ("invalid_volume.npy", payload, "application/octet-stream")},
    )
    assert r.status_code == 400
    assert "Invalid 3D voxel data" in str(r.json())


def test_upload_inspiro_voxel_data_accepts_3d_arrays(client):
    pr = client.post("/api/projects/", json={"name": "P7", "description": None, "meta_group_id": "g"})
    pid = pr.json()["id"]

    npy_bytes = io.BytesIO()
    np.save(npy_bytes, np.zeros((4, 8, 8), dtype=np.uint16))
    npy_bytes.seek(0)

    payload = io.BytesIO()
    with zipfile.ZipFile(payload, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("voxels.npy", npy_bytes.getvalue())
    payload.seek(0)

    r = client.post(
        f"/api/projects/{pid}/images",
        files={"file": ("scan.inspiro", payload, "application/octet-stream")},
    )
    assert r.status_code == 201
    assert r.json()["filename"] == "scan.inspiro"


def test_get_download_url_and_content_and_thumbnail(client, monkeypatch):
    # Create project and upload image
    pr = client.post("/api/projects/", json={"name": "P3", "description": None, "meta_group_id": "g"})
    pid = pr.json()["id"]
    img_bytes = _make_png_bytes((20, 20))
    files = {"file": ("a.png", img_bytes, "image/png")}
    ur = client.post(f"/api/projects/{pid}/images", files=files)
    assert ur.status_code == 201
    image_id = ur.json()["id"]

    # Download URL uses proxy path
    dr = client.get(f"/api/images/{image_id}/download")
    assert dr.status_code == 200
    assert dr.json()["url"].endswith(f"/images/{image_id}/content")

    # Mock httpx client to return our bytes for content and thumbnail
    class Resp:
        def __init__(self, data, ctype="image/png"):
            self._data = data
            self.headers = {"content-type": ctype}
            self.status_code = 200

        def raise_for_status(self):
            return None

        async def aread(self):
            return self._data

        def iter_bytes(self):
            # Simple iterator over bytes
            yield self._data

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url):
            # Return fixed PNG
            return Resp(_make_png_bytes().getvalue())

    monkeypatch.setattr("routers.images.httpx.AsyncClient", Client)

    # Proxy content
    cr = client.get(f"/api/images/{image_id}/content")
    assert cr.status_code == 200
    assert cr.headers["content-type"].startswith("image/")

    # Thumbnail
    tr = client.get(f"/api/images/{image_id}/thumbnail?width=8&height=8")
    assert tr.status_code == 200
    assert tr.headers["content-type"].startswith("image/")


def test_thumbnail_bad_dimensions(client):
    # Create project and upload image
    pr = client.post("/api/projects/", json={"name": "P4", "description": None, "meta_group_id": "g"})
    pid = pr.json()["id"]
    img_bytes = _make_png_bytes()
    ur = client.post(f"/api/projects/{pid}/images", files={"file": ("b.png", img_bytes, "image/png")})
    image_id = ur.json()["id"]
    r = client.get(f"/api/images/{image_id}/thumbnail?width=0&height=10")
    assert r.status_code == 400
