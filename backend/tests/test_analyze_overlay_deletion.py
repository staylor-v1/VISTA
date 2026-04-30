from datetime import datetime, timedelta, timezone

from routers.analyze import (
    _mark_overlay_deleted_in_metadata,
    _purge_expired_deleted_overlays_from_metadata,
    _restore_overlay_in_metadata,
)


def _metadata():
    return {
        "source_images": [
            {"filename": "source.png", "image_id": "source-image", "side": "front"},
            {
                "filename": "overlay.png",
                "image_id": "overlay-image",
                "label": "Segmentation Overlay :: Watershed From Seeds",
                "overlay": True,
                "analysis_output": True,
                "side": "front",
                "modality": "analyze-overlay",
            },
        ],
        "analysis_outputs": [
            {
                "filename": "overlay.png",
                "image_id": "overlay-image",
                "label": "Segmentation Overlay :: Watershed From Seeds",
            },
        ],
        "overlay_layers": [
            {
                "id": "analyze-overlay-image",
                "image_id": "overlay-image",
                "label": "Segmentation Overlay :: Watershed From Seeds",
            },
        ],
        "view_images": {"front": "source.png"},
        "overlay_images": {"front": {"analyze-overlay": "overlay.png"}},
    }


def test_mark_overlay_metadata_as_delete_candidate_hides_active_overlay_maps():
    now = datetime(2026, 4, 30, 12, 0, tzinfo=timezone.utc)

    metadata, deleted = _mark_overlay_deleted_in_metadata(
        _metadata(),
        "overlay-image",
        now=now,
        actor_email="operator@example.com",
    )

    assert deleted["label"] == "Segmentation Overlay :: Watershed From Seeds"
    overlay_record = metadata["source_images"][1]
    assert overlay_record["overlay_delete_candidate"] is True
    assert overlay_record["pending_hard_delete_at"] == (now + timedelta(hours=48)).isoformat()
    assert overlay_record["overlay_deleted_by"] == "operator@example.com"
    assert metadata["overlay_images"] == {}


def test_restore_overlay_metadata_clears_delete_candidate_and_rebuilds_maps():
    now = datetime(2026, 4, 30, 12, 0, tzinfo=timezone.utc)
    deleted_metadata, _ = _mark_overlay_deleted_in_metadata(
        _metadata(),
        "overlay-image",
        now=now,
        actor_email="operator@example.com",
    )

    restored_metadata, restored = _restore_overlay_in_metadata(deleted_metadata, "overlay-image")

    assert restored is True
    assert "overlay_delete_candidate" not in restored_metadata["source_images"][1]
    assert restored_metadata["overlay_images"] == {"front": {"analyze-overlay": "overlay.png"}}


def test_purge_expired_overlay_metadata_removes_records_after_retention():
    now = datetime(2026, 4, 30, 12, 0, tzinfo=timezone.utc)
    deleted_metadata, _ = _mark_overlay_deleted_in_metadata(
        _metadata(),
        "overlay-image",
        now=now,
        actor_email="operator@example.com",
    )

    purged_metadata, purged_records = _purge_expired_deleted_overlays_from_metadata(
        deleted_metadata,
        now=now + timedelta(hours=49),
    )

    assert {record["image_id"] for record in purged_records} == {"overlay-image"}
    assert [record["image_id"] for record in purged_metadata["source_images"]] == ["source-image"]
    assert purged_metadata["analysis_outputs"] == []
    assert purged_metadata["overlay_layers"] == []
