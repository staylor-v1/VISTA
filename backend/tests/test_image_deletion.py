import asyncio
import io
import json
import uuid
import pytest
from PIL import Image
from sqlalchemy import update

from core import models
from routers import images as images_router
from tests.conftest import TestingSessionLocal

# Helper to make png bytes

def _png():
    img = Image.new("RGB", (8, 8), (123, 45, 67))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return buf

def _create_project(client):
    r = client.post("/api/projects/", json={"name": "DelProj", "description": None, "meta_group_id": "g"})
    assert r.status_code == 201
    return r.json()["id"]


def _upload_image(client, project_id, filename="d.png", metadata=None):
    files = {"file": (filename, _png(), "image/png")}
    data = {"metadata": json.dumps(metadata)} if metadata is not None else None
    r = client.post(f"/api/projects/{project_id}/images", files=files, data=data)
    assert r.status_code == 201
    image = r.json()

    async def normalize_sqlite_boolean_default():
        async with TestingSessionLocal() as session:
            await session.execute(
                update(models.DataInstance)
                .where(models.DataInstance.id == uuid.UUID(image["id"]))
                .values(storage_deleted=False)
            )
            await session.commit()

    asyncio.get_event_loop().run_until_complete(normalize_sqlite_boolean_default())
    image["storage_deleted"] = False
    return image


@pytest.mark.smoke
def test_soft_delete_list_and_audit_lifecycle(client):
    pid = _create_project(client)
    img = _upload_image(client, pid)
    image_id = img["id"]

    deleted = client.request(
        "DELETE",
        f"/api/projects/{pid}/images/{image_id}",
        json={"reason": "cleanup test data"},
    )
    assert deleted.status_code == 200, deleted.text
    deleted_body = deleted.json()
    assert deleted_body["deleted_at"] is not None
    assert deleted_body["pending_hard_delete_at"] is not None
    assert deleted_body["storage_deleted"] is False

    active = client.get(f"/api/projects/{pid}/images")
    assert active.status_code == 200
    assert image_id not in {item["id"] for item in active.json()}

    with_deleted = client.get(f"/api/projects/{pid}/images?include_deleted=true")
    assert with_deleted.status_code == 200
    assert image_id in {item["id"] for item in with_deleted.json()}

    events = client.get(
        f"/api/projects/{pid}/images/deletion-events",
        params={"image_id": image_id},
    )
    assert events.status_code == 200
    assert [(event["action"], event["reason"]) for event in events.json()["events"]] == [
        ("soft_delete", "cleanup test data"),
    ]

def test_delete_requires_reason_min_length_and_leaves_image_active(client):
    pid = _create_project(client)
    img = _upload_image(client, pid, filename="r.png")
    image_id = img["id"]

    rejected = client.request(
        "DELETE",
        f"/api/projects/{pid}/images/{image_id}",
        json={"reason": "x"},
    )
    assert rejected.status_code == 400
    assert "Reason must be at least" in rejected.json()["detail"]

    active = client.get(f"/api/projects/{pid}/images")
    assert active.status_code == 200
    assert image_id in {item["id"] for item in active.json()}


def test_restore_soft_deleted_image_clears_deletion_state(client, monkeypatch):
    pid = _create_project(client)
    img = _upload_image(client, pid, filename="rest.png")
    image_id = img["id"]
    original_soft_delete = images_router.crud.soft_delete_image

    async def soft_delete_without_sqlite_timezone(*args, **kwargs):
        image = await original_soft_delete(*args, **kwargs)
        image.pending_hard_delete_at = None
        await args[0].flush()
        return image

    monkeypatch.setattr(
        images_router.crud,
        "soft_delete_image",
        soft_delete_without_sqlite_timezone,
    )

    deleted = client.request(
        "DELETE",
        f"/api/projects/{pid}/images/{image_id}",
        json={"reason": "restore check"},
    )
    assert deleted.status_code == 200, deleted.text

    restored = client.post(f"/api/projects/{pid}/images/{image_id}/restore")
    assert restored.status_code == 200, restored.text
    restored_body = restored.json()
    assert restored_body["deleted_at"] is None
    assert restored_body["pending_hard_delete_at"] is None
    assert restored_body["storage_deleted"] is False

    active = client.get(f"/api/projects/{pid}/images")
    assert active.status_code == 200
    assert image_id in {item["id"] for item in active.json()}

    events = client.get(
        f"/api/projects/{pid}/images/deletion-events",
        params={"image_id": image_id},
    )
    assert events.status_code == 200
    assert {event["action"] for event in events.json()["events"]} == {
        "soft_delete",
        "restore",
    }


def test_force_delete_is_permanent_and_audited(client, monkeypatch):
    pid = _create_project(client)
    img = _upload_image(client, pid, filename="f2.png")
    image_id = img["id"]
    deleted_storage_keys = []

    def delete_storage_file(bucket_name, object_name):
        deleted_storage_keys.append((bucket_name, object_name))
        return True

    monkeypatch.setattr("routers.images.delete_file_from_s3", delete_storage_file)
    deleted = client.request(
        "DELETE",
        f"/api/projects/{pid}/images/{image_id}",
        json={"reason": "force rm2", "force": True},
    )
    assert deleted.status_code == 200, deleted.text
    deleted_body = deleted.json()
    assert deleted_body["storage_deleted"] is True
    assert deleted_body["hard_deleted_at"] is not None
    assert deleted_storage_keys == [("test-bucket", img["object_storage_key"])]

    restore = client.post(f"/api/projects/{pid}/images/{image_id}/restore")
    assert restore.status_code == 409
    assert restore.json()["detail"] == "Image permanently deleted"

    events = client.get(
        f"/api/projects/{pid}/images/deletion-events",
        params={"image_id": image_id},
    )
    assert events.status_code == 200
    assert {
        (event["action"], event["storage_deleted"])
        for event in events.json()["events"]
    } == {
        ("force_delete", True),
        ("soft_delete", False),
    }


def test_soft_delete_image_removes_inspection_part_references(client):
    pid = _create_project(client)
    img = _upload_image(client, pid, filename="part-ref.png")
    part_r = client.post(
        f"/api/projects/{pid}/parts",
        json={"serial_number": "SN-IMG-DEL", "display_name": "Image delete part"},
    )
    assert part_r.status_code == 201, part_r.text
    part_id = part_r.json()["id"]
    assign_r = client.post(
        f"/api/projects/{pid}/parts/image-assignments",
        json={"filename": img["filename"], "to_part_id": part_id},
    )
    assert assign_r.status_code == 200, assign_r.text

    del_r = client.request("DELETE", f"/api/projects/{pid}/images/{img['id']}", json={"reason": "unload removes references"})
    assert del_r.status_code == 200, del_r.text

    parts_r = client.get(f"/api/projects/{pid}/parts")
    assert parts_r.status_code == 200
    metadata = parts_r.json()[0]["metadata"]
    assert metadata["source_images"] == []
    assert metadata["view_images"] == {}
    assert metadata["overlay_images"] == {}


def test_soft_delete_image_removes_unreferenced_associated_project_metadata(client):
    pid = _create_project(client)
    metadata_key = "associated:file-one.nsipro"
    meta_r = client.post(
        f"/api/projects/{pid}/metadata",
        json={"key": metadata_key, "value": {"source_filename": "file-one.nsipro"}},
    )
    assert meta_r.status_code == 201, meta_r.text
    img = _upload_image(
        client,
        pid,
        filename="with-associated.png",
        metadata={
            "associated_metadata_ref": metadata_key,
            "associated_metadata": {"project_metadata_key": metadata_key},
        },
    )

    del_r = client.request("DELETE", f"/api/projects/{pid}/images/{img['id']}", json={"reason": "unload associated metadata"})
    assert del_r.status_code == 200, del_r.text

    meta_after = client.get(f"/api/projects/{pid}/metadata/{metadata_key}")
    assert meta_after.status_code == 404


def test_soft_delete_image_keeps_project_metadata_still_used_by_another_image(client):
    pid = _create_project(client)
    metadata_key = "associated:shared.nsipro"
    meta_r = client.post(
        f"/api/projects/{pid}/metadata",
        json={"key": metadata_key, "value": {"source_filename": "shared.nsipro"}},
    )
    assert meta_r.status_code == 201, meta_r.text
    shared_metadata = {"associated_metadata_refs": [metadata_key]}
    first = _upload_image(client, pid, filename="shared-one.png", metadata=shared_metadata)
    _upload_image(client, pid, filename="shared-two.png", metadata=shared_metadata)

    del_r = client.request("DELETE", f"/api/projects/{pid}/images/{first['id']}", json={"reason": "unload one shared metadata"})
    assert del_r.status_code == 200, del_r.text

    meta_after = client.get(f"/api/projects/{pid}/metadata/{metadata_key}")
    assert meta_after.status_code == 200, meta_after.text
