import json
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from core import models, schemas
import routers.inspection_workbench as inspection_workbench
from routers.inspection_workbench import _bulk_ingest_project_parts, _merge_existing_part_ingest_metadata
import utils.crud as crud


async def _create_project(db: AsyncSession, *, name: str) -> models.Project:
    project = models.Project(
        name=name,
        description="bulk ingest transaction test",
        meta_group_id=f"{name}-group",
        created_by="transaction-test@example.com",
        project_type="PT1",
    )
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return project


def _test_user() -> schemas.User:
    return schemas.User(email="transaction-test@example.com", username="transaction-test")


async def _project_row_count(db: AsyncSession, model, project_id) -> int:
    result = await db.execute(select(func.count()).select_from(model).where(model.project_id == project_id))
    return result.scalar_one()


def test_source_image_merge_keeps_different_ids_with_the_same_filename_distinct():
    first_image_id = "11111111-1111-1111-1111-111111111111"
    second_image_id = "22222222-2222-2222-2222-222222222222"

    patch = _merge_existing_part_ingest_metadata(
        {
            "source_images": [
                {
                    "image_id": first_image_id,
                    "filename": "shared-name.png",
                    "note": "first image",
                }
            ]
        },
        {
            "source_images": [
                {
                    "image_id": second_image_id,
                    "filename": "shared-name.png",
                    "note": "second image",
                }
            ]
        },
    )

    assert patch["source_images"] == [
        {
            "image_id": first_image_id,
            "filename": "shared-name.png",
            "note": "first image",
        },
        {
            "image_id": second_image_id,
            "filename": "shared-name.png",
            "note": "second image",
        },
    ]


def test_source_image_merge_uses_image_id_across_filename_changes():
    image_id = "11111111-1111-1111-1111-111111111111"

    patch = _merge_existing_part_ingest_metadata(
        {
            "source_images": [
                {
                    "image_id": image_id,
                    "filename": "before-rename.png",
                    "note": "preserved",
                }
            ]
        },
        {
            "source_images": [
                {
                    "image_id": image_id,
                    "filename": "after-rename.png",
                    "exposure": 2,
                }
            ]
        },
    )

    assert patch["source_images"] == [
        {
            "image_id": image_id,
            "filename": "after-rename.png",
            "note": "preserved",
            "exposure": 2,
        }
    ]


def test_source_image_merge_falls_back_to_filename_when_a_record_lacks_an_id():
    image_id = "11111111-1111-1111-1111-111111111111"

    patch = _merge_existing_part_ingest_metadata(
        {
            "source_images": [
                {
                    "filename": "legacy.png",
                    "legacy_note": "preserved",
                }
            ]
        },
        {
            "source_images": [
                {
                    "image_id": image_id,
                    "filename": "legacy.png",
                    "side": "front",
                },
                {
                    "filename": "legacy.png",
                    "modality": "visible",
                },
            ]
        },
    )

    assert patch["source_images"] == [
        {
            "image_id": image_id,
            "filename": "legacy.png",
            "legacy_note": "preserved",
            "side": "front",
            "modality": "visible",
        }
    ]


@pytest.mark.asyncio
async def test_bulk_ingest_commits_two_thousand_parts_once(db_session: AsyncSession):
    project = await _create_project(db_session, name="bulk-two-thousand")
    payload = schemas.InspectionBulkIngestPayload(
        batches=[
            schemas.InspectionIngestBatchRecord(
                name=f"batch-{batch_index}",
                parts=[
                    schemas.InspectionIngestPartRecord(
                        serial_number=f"SN-{batch_index:02d}-{part_index:04d}",
                        display_name=f"Part {batch_index}-{part_index}",
                    )
                    for part_index in range(1000)
                ],
            )
            for batch_index in range(2)
        ]
    )

    with (
        patch.object(db_session, "commit", wraps=db_session.commit) as commit_spy,
        patch.object(db_session, "flush", wraps=db_session.flush) as flush_spy,
    ):
        result = await _bulk_ingest_project_parts(
            project_id=project.id,
            payload=payload,
            db=db_session,
            current_user=_test_user(),
            project_type=project.project_type,
        )

    assert commit_spy.await_count == 1
    # Explicit batch UUIDs let the unit of work persist all batches and all
    # 2,000 parts in a single ordered flush.
    assert flush_spy.await_count == 1
    assert result["counters"] == {
        "batches_received": 2,
        "parts_received": 2000,
        "batches_created": 2,
        "parts_created": 2000,
        "parts_skipped_existing": 0,
        "parts_skipped_discrepancy": 0,
    }
    assert await _project_row_count(db_session, models.InspectionBatch, project.id) == 2
    assert await _project_row_count(db_session, models.InspectionPart, project.id) == 2000


@pytest.mark.asyncio
async def test_bulk_ingest_many_distinct_batches_has_bounded_database_work(db_session: AsyncSession):
    project = await _create_project(db_session, name="bulk-many-distinct-batches")
    existing_batch = await crud.create_inspection_batch(
        db=db_session,
        project_id=project.id,
        batch=schemas.InspectionBatchCreate(name="existing-batch", description="keep existing"),
    )
    new_batch_count = 500
    payload = schemas.InspectionBulkIngestPayload(
        batches=[
            schemas.InspectionIngestBatchRecord(
                name="existing-batch",
                description="must not replace existing",
                parts=[schemas.InspectionIngestPartRecord(serial_number="SN-EXISTING-BATCH")],
            ),
            *[
                schemas.InspectionIngestBatchRecord(
                    name=f"batch-{batch_index:04d}",
                    description=f"Batch {batch_index}",
                    parts=[
                        schemas.InspectionIngestPartRecord(
                            serial_number=f"SN-BATCH-{batch_index:04d}",
                        )
                    ],
                )
                for batch_index in range(new_batch_count)
            ],
            # Repeating a name must reuse the first staged batch, just as it
            # did when batches were flushed one at a time.
            schemas.InspectionIngestBatchRecord(
                name="batch-0000",
                description="must not replace first payload description",
                parts=[schemas.InspectionIngestPartRecord(serial_number="SN-BATCH-0000-SECOND")],
            ),
        ]
    )

    with (
        patch.object(db_session, "execute", wraps=db_session.execute) as execute_spy,
        patch.object(db_session, "flush", wraps=db_session.flush) as flush_spy,
        patch.object(db_session, "commit", wraps=db_session.commit) as commit_spy,
    ):
        result = await _bulk_ingest_project_parts(
            project_id=project.id,
            payload=payload,
            db=db_session,
            current_user=_test_user(),
            project_type=project.project_type,
        )

    # Configuration, existing batches, and existing parts are each loaded
    # once. Counts do not grow with the number of distinct incoming batches.
    assert execute_spy.await_count == 3
    assert flush_spy.await_count == 1
    assert commit_spy.await_count == 1
    assert result["counters"] == {
        "batches_received": new_batch_count + 2,
        "parts_received": new_batch_count + 2,
        "batches_created": new_batch_count,
        "parts_created": new_batch_count + 2,
        "parts_skipped_existing": 0,
        "parts_skipped_discrepancy": 0,
    }

    stored_associations = dict(
        (
            await db_session.execute(
                select(models.InspectionPart.serial_number, models.InspectionBatch.name)
                .join(models.InspectionBatch, models.InspectionPart.batch_id == models.InspectionBatch.id)
                .where(models.InspectionPart.project_id == project.id)
            )
        ).all()
    )
    assert stored_associations["SN-EXISTING-BATCH"] == "existing-batch"
    assert stored_associations["SN-BATCH-0000"] == "batch-0000"
    assert stored_associations["SN-BATCH-0000-SECOND"] == "batch-0000"
    assert stored_associations["SN-BATCH-0499"] == "batch-0499"

    stored_batches = {
        batch.name: batch
        for batch in (
            await db_session.execute(
                select(models.InspectionBatch).where(models.InspectionBatch.project_id == project.id)
            )
        ).scalars()
    }
    assert len(stored_batches) == new_batch_count + 1
    assert stored_batches["existing-batch"].id == existing_batch.id
    assert stored_batches["existing-batch"].description == "keep existing"
    assert stored_batches["batch-0000"].description == "Batch 0"


@pytest.mark.asyncio
async def test_bulk_ingest_stores_one_shared_payload_for_two_thousand_source_references(db_session: AsyncSession):
    project = await _create_project(db_session, name="bulk-shared-metadata-reference")
    metadata_key = "associated_upload_metadata:shared.nsipro"
    large_warning = "W" * (64 * 1024)
    db_session.add(
        models.ProjectMetadata(
            project_id=project.id,
            key=metadata_key,
            value={
                "file_type": "nsipro",
                "source_filename": "shared.nsipro",
                "metadata": {"capture": {"operator": "shared-operator"}},
                "warnings": [large_warning],
            },
        )
    )
    await db_session.commit()
    payload = schemas.InspectionBulkIngestPayload(
        unassigned_parts=[
            schemas.InspectionIngestPartRecord(
                serial_number="SN-REF-2000-SOURCES",
                metadata={
                    "source_images": [
                        {
                            "image_id": f"00000000-0000-0000-0000-{source_index:012d}",
                            "filename": f"view-{source_index:04d}.png",
                            "associated_metadata_ref": metadata_key,
                        }
                        for source_index in range(2000)
                    ],
                },
            )
        ]
    )

    project_metadata_selects = 0

    def count_project_metadata_selects(_conn, _cursor, statement, _parameters, _context, _executemany):
        nonlocal project_metadata_selects
        normalized_statement = " ".join(statement.lower().split())
        if normalized_statement.startswith("select ") and " from project_metadata " in normalized_statement:
            project_metadata_selects += 1

    sync_engine = db_session.bind.sync_engine
    event.listen(sync_engine, "before_cursor_execute", count_project_metadata_selects)
    try:
        with patch.object(
            inspection_workbench,
            "_normalize_nsipro_bundle_payload",
            wraps=inspection_workbench._normalize_nsipro_bundle_payload,
        ) as normalize_payload_spy:
            result = await _bulk_ingest_project_parts(
                project_id=project.id,
                payload=payload,
                db=db_session,
                current_user=_test_user(),
                project_type=project.project_type,
            )
    finally:
        event.remove(sync_engine, "before_cursor_execute", count_project_metadata_selects)

    # One lookup loads project parser configuration; one IN query preloads all
    # referenced metadata. Per-part and per-source-image normalization is then
    # served from the request-local mapping.
    assert project_metadata_selects == 2
    assert normalize_payload_spy.call_count == 1
    assert result["counters"]["parts_created"] == 1
    stored_part = (
        await db_session.execute(
            select(models.InspectionPart).where(
                models.InspectionPart.project_id == project.id,
                models.InspectionPart.serial_number == "SN-REF-2000-SOURCES",
            )
        )
    ).scalar_one()
    stored_metadata = stored_part.metadata_json
    assert stored_metadata["nsipro_payload_ref"] == metadata_key
    assert stored_metadata["nsipro_metadata"] == {
        "capture": {"operator": "shared-operator"}
    }
    assert stored_metadata["nsipro_payload"]["warnings"] == [large_warning]
    assert "nsipro_payloads_by_ref" not in stored_metadata
    assert len(stored_metadata["source_images"]) == 2000
    assert all(
        record["associated_metadata_ref"] == metadata_key
        and record["nsipro_payload_ref"] == metadata_key
        and "nsipro_payload" not in record
        for record in stored_metadata["source_images"]
    )

    payloads_by_ref = {
        stored_metadata["nsipro_payload_ref"]: stored_metadata["nsipro_payload"],
        **stored_metadata.get("nsipro_payloads_by_ref", {}),
    }
    assert {
        record["nsipro_payload_ref"]
        for record in stored_metadata["source_images"]
    } <= payloads_by_ref.keys()
    compact_json = json.dumps(stored_metadata, separators=(",", ":"))
    assert compact_json.count(large_warning) == 1
    assert len(compact_json) < 1_000_000


@pytest.mark.asyncio
async def test_bulk_ingest_stores_each_distinct_nsipro_reference_once(db_session: AsyncSession):
    project = await _create_project(db_session, name="bulk-distinct-metadata-references")
    primary_key = "associated_upload_metadata:primary.nsipro"
    secondary_key = "associated_upload_metadata:secondary.nsipro"
    primary_warning = "primary-payload-marker"
    secondary_warning = "secondary-payload-marker"
    db_session.add_all(
        [
            models.ProjectMetadata(
                project_id=project.id,
                key=primary_key,
                value={
                    "file_type": "nsipro",
                    "source_filename": "primary.nsipro",
                    "metadata": {"capture": {"operator": "primary"}},
                    "warnings": [primary_warning],
                },
            ),
            models.ProjectMetadata(
                project_id=project.id,
                key=secondary_key,
                value={
                    "file_type": "nsipro",
                    "source_filename": "secondary.nsipro",
                    "metadata": {"capture": {"operator": "secondary"}},
                    "warnings": [secondary_warning],
                },
            ),
        ]
    )
    await db_session.commit()
    payload = schemas.InspectionBulkIngestPayload(
        unassigned_parts=[
            schemas.InspectionIngestPartRecord(
                serial_number="SN-MULTI-REF",
                metadata={
                    "source_images": [
                        {"filename": "primary-a.png", "associated_metadata_ref": primary_key},
                        {"filename": "secondary-a.png", "associated_metadata_ref": secondary_key},
                        {"filename": "secondary-b.png", "associated_metadata_ref": secondary_key},
                        {"filename": "primary-b.png", "associated_metadata_ref": primary_key},
                    ]
                },
            )
        ]
    )

    await _bulk_ingest_project_parts(
        project_id=project.id,
        payload=payload,
        db=db_session,
        current_user=_test_user(),
        project_type=project.project_type,
    )

    stored_part = (
        await db_session.execute(
            select(models.InspectionPart).where(
                models.InspectionPart.project_id == project.id,
                models.InspectionPart.serial_number == "SN-MULTI-REF",
            )
        )
    ).scalar_one()
    metadata = stored_part.metadata_json
    assert metadata["nsipro_payload_ref"] == primary_key
    assert metadata["nsipro_payload"]["warnings"] == [primary_warning]
    assert metadata["nsipro_payloads_by_ref"] == {
        secondary_key: {
            "parser": "nsipro-stored-metadata",
            "parser_id": "default",
            "parser_version": inspection_workbench.get_nsipro_parser("default").version,
            "parser_hash": inspection_workbench.get_nsipro_parser("default").parser_hash,
            "source_filename": "secondary.nsipro",
            "content_hash": None,
            "metadata": {"capture": {"operator": "secondary"}},
            "warnings": [secondary_warning],
        }
    }
    assert [record["nsipro_payload_ref"] for record in metadata["source_images"]] == [
        primary_key,
        secondary_key,
        secondary_key,
        primary_key,
    ]
    assert all("nsipro_payload" not in record for record in metadata["source_images"])
    compact_json = json.dumps(metadata, separators=(",", ":"))
    assert compact_json.count(primary_warning) == 1
    assert compact_json.count(secondary_warning) == 1


@pytest.mark.asyncio
async def test_bulk_ingest_preserves_stored_legacy_inline_source_payload(db_session: AsyncSession):
    project = await _create_project(db_session, name="bulk-legacy-inline-source-payload")
    metadata_key = "associated_upload_metadata:canonical.nsipro"
    legacy_payload = {
        "parser_id": "legacy-inline",
        "metadata": {"capture": {"operator": "legacy"}},
    }
    existing = await crud.create_inspection_part(
        db=db_session,
        project_id=project.id,
        part=schemas.InspectionPartCreate(
            serial_number="SN-LEGACY-INLINE",
            metadata={
                "source_images": [
                    {
                        "image_id": "11111111-1111-1111-1111-111111111111",
                        "filename": "legacy.png",
                        "nsipro_payload": legacy_payload,
                    }
                ]
            },
        ),
    )
    db_session.add(
        models.ProjectMetadata(
            project_id=project.id,
            key=metadata_key,
            value={
                "file_type": "nsipro",
                "source_filename": "canonical.nsipro",
                "metadata": {"capture": {"operator": "canonical"}},
            },
        )
    )
    await db_session.commit()

    await _bulk_ingest_project_parts(
        project_id=project.id,
        payload=schemas.InspectionBulkIngestPayload(
            unassigned_parts=[
                schemas.InspectionIngestPartRecord(
                    serial_number="SN-LEGACY-INLINE",
                    metadata={
                        "source_images": [
                            {
                                "image_id": "11111111-1111-1111-1111-111111111111",
                                "filename": "legacy.png",
                                "associated_metadata_ref": metadata_key,
                            }
                        ]
                    },
                )
            ]
        ),
        db=db_session,
        current_user=_test_user(),
        project_type=project.project_type,
    )

    await db_session.refresh(existing)
    source = existing.metadata_json["source_images"][0]
    assert source["nsipro_payload"] == legacy_payload
    assert source["associated_metadata_ref"] == metadata_key
    assert source["nsipro_payload_ref"] == metadata_key
    assert existing.metadata_json["nsipro_payload_ref"] == metadata_key
    assert existing.metadata_json["nsipro_payload"]["metadata"] == {
        "capture": {"operator": "canonical"}
    }


@pytest.mark.asyncio
async def test_bulk_ingest_strict_nsipro_contract_still_rejects_mismatch(db_session: AsyncSession):
    project = await _create_project(db_session, name="bulk-strict-reference-mismatch")
    project_id = project.id
    metadata_key = "associated_upload_metadata:strict.nsipro"
    db_session.add_all(
        [
            models.ProjectMetadata(
                project_id=project.id,
                key="inspection_workbench.project_configuration",
                value={
                    "metadata_parsers": {
                        "nsipro": {
                            "parser_id": "default",
                            "strict": True,
                        }
                    }
                },
            ),
            models.ProjectMetadata(
                project_id=project.id,
                key=metadata_key,
                value={
                    "file_type": "nsipro",
                    "source_filename": "strict.nsipro",
                    "parser_id": "wrong-parser",
                    "metadata": {"capture": {"operator": "strict"}},
                },
            ),
        ]
    )
    await db_session.commit()

    with pytest.raises(HTTPException, match="parser contract mismatch") as exc_info:
        await _bulk_ingest_project_parts(
            project_id=project.id,
            payload=schemas.InspectionBulkIngestPayload(
                unassigned_parts=[
                    schemas.InspectionIngestPartRecord(
                        serial_number="SN-STRICT-MISMATCH",
                        metadata={
                            "source_images": [
                                {
                                    "filename": "strict.png",
                                    "associated_metadata_ref": metadata_key,
                                }
                            ]
                        },
                    )
                ]
            ),
            db=db_session,
            current_user=_test_user(),
            project_type=project.project_type,
        )

    assert exc_info.value.status_code == 422
    assert await _project_row_count(db_session, models.InspectionPart, project_id) == 0


@pytest.mark.asyncio
async def test_bulk_ingest_existing_part_metadata_merge_is_preserved(db_session: AsyncSession):
    project = await _create_project(db_session, name="bulk-existing-merge")
    existing = await crud.create_inspection_part(
        db=db_session,
        project_id=project.id,
        part=schemas.InspectionPartCreate(
            serial_number="SN-EXISTING",
            metadata={
                "keep": "unchanged",
                "source_images": [{"filename": "front.png", "note": "keep this too"}],
            },
        ),
    )
    incoming_nsipro = {
        "parser_id": "default",
        "metadata": {"capture": {"operator": "bob"}},
    }
    payload = schemas.InspectionBulkIngestPayload(
        unassigned_parts=[
            schemas.InspectionIngestPartRecord(
                serial_number="SN-EXISTING",
                metadata={
                    "nsipro_metadata": incoming_nsipro["metadata"],
                    "nsipro_payload": incoming_nsipro,
                    "source_images": [
                        {
                            "filename": "front.png",
                            "side": "front",
                            "nsipro_payload": incoming_nsipro,
                        }
                    ],
                },
            )
        ]
    )

    with patch.object(db_session, "commit", wraps=db_session.commit) as commit_spy:
        result = await _bulk_ingest_project_parts(
            project_id=project.id,
            payload=payload,
            db=db_session,
            current_user=_test_user(),
            project_type=project.project_type,
        )

    assert commit_spy.await_count == 1
    assert result["counters"]["parts_created"] == 0
    assert result["counters"]["parts_skipped_existing"] == 1
    await db_session.refresh(existing)
    assert existing.metadata_json == {
        "keep": "unchanged",
        "nsipro_metadata": {"capture": {"operator": "bob"}},
        "nsipro_payload": incoming_nsipro,
        "source_images": [
            {
                "filename": "front.png",
                "note": "keep this too",
                "side": "front",
                "nsipro_payload": incoming_nsipro,
            }
        ],
    }


@pytest.mark.asyncio
async def test_bulk_ingest_existing_part_merges_ordinary_new_views_without_nsipro(db_session: AsyncSession):
    project = await _create_project(db_session, name="bulk-existing-ordinary-views")
    front_image_id = "11111111-1111-1111-1111-111111111111"
    back_image_id = "22222222-2222-2222-2222-222222222222"
    existing = await crud.create_inspection_part(
        db=db_session,
        project_id=project.id,
        part=schemas.InspectionPartCreate(
            serial_number="SN-EXISTING-VIEWS",
            metadata={
                "keep": {"reviewer_note": "preserve me"},
                "source_images": [
                    {
                        "image_id": front_image_id,
                        "filename": "front-original.png",
                        "side": "front",
                        "note": "preserve this too",
                    }
                ],
            },
        ),
    )
    payload = schemas.InspectionBulkIngestPayload(
        unassigned_parts=[
            schemas.InspectionIngestPartRecord(
                serial_number="SN-EXISTING-VIEWS",
                metadata={
                    "ignored_top_level_field": "existing metadata remains authoritative",
                    "source_images": [
                        {
                            "image_id": front_image_id,
                            "filename": "front-renamed.png",
                            "exposure": 2,
                        },
                        {
                            "image_id": back_image_id,
                            "filename": "back.png",
                            "side": "back",
                        },
                        {
                            "filename": "back.png",
                            "modality": "visible",
                        },
                    ],
                },
            )
        ]
    )

    with (
        patch.object(db_session, "commit", wraps=db_session.commit) as commit_spy,
        patch.object(crud, "get_inspection_part", wraps=crud.get_inspection_part) as get_part_spy,
    ):
        result = await _bulk_ingest_project_parts(
            project_id=project.id,
            payload=payload,
            db=db_session,
            current_user=_test_user(),
            project_type=project.project_type,
        )

    assert commit_spy.await_count == 1
    assert get_part_spy.await_count == 0
    assert result["counters"]["parts_skipped_existing"] == 1
    await db_session.refresh(existing)
    assert existing.metadata_json == {
        "keep": {"reviewer_note": "preserve me"},
        "source_images": [
            {
                "image_id": front_image_id,
                "filename": "front-renamed.png",
                "side": "front",
                "note": "preserve this too",
                "exposure": 2,
            },
            {
                "image_id": back_image_id,
                "filename": "back.png",
                "side": "back",
                "modality": "visible",
            },
        ],
    }


@pytest.mark.asyncio
async def test_bulk_ingest_rolls_back_all_parts_and_batches_on_late_failure(db_session: AsyncSession):
    project = await _create_project(db_session, name="bulk-atomic-rollback")
    project_id = project.id
    payload = schemas.InspectionBulkIngestPayload(
        batches=[
            schemas.InspectionIngestBatchRecord(
                name="batch-that-must-rollback",
                parts=[
                    schemas.InspectionIngestPartRecord(serial_number="SN-FIRST"),
                    schemas.InspectionIngestPartRecord(serial_number="SN-FAIL-LATE"),
                ],
            )
        ]
    )
    real_create_part = crud.create_inspection_part
    create_calls = 0

    async def fail_on_second_part(*args, **kwargs):
        nonlocal create_calls
        create_calls += 1
        if create_calls == 2:
            raise RuntimeError("forced late ingest failure")
        return await real_create_part(*args, **kwargs)

    with (
        patch("routers.inspection_workbench.crud.create_inspection_part", side_effect=fail_on_second_part),
        patch.object(db_session, "commit", wraps=db_session.commit) as commit_spy,
        patch.object(db_session, "rollback", wraps=db_session.rollback) as rollback_spy,
        pytest.raises(RuntimeError, match="forced late ingest failure"),
    ):
        await _bulk_ingest_project_parts(
            project_id=project_id,
            payload=payload,
            db=db_session,
            current_user=_test_user(),
            project_type=project.project_type,
        )

    assert commit_spy.await_count == 0
    assert rollback_spy.await_count == 1
    assert await _project_row_count(db_session, models.InspectionBatch, project_id) == 0
    assert await _project_row_count(db_session, models.InspectionPart, project_id) == 0


@pytest.mark.asyncio
async def test_inspection_crud_defaults_still_commit_each_operation(db_session: AsyncSession):
    project = await _create_project(db_session, name="crud-default-commit")

    with patch.object(db_session, "commit", wraps=db_session.commit) as commit_spy:
        batch = await crud.create_inspection_batch(
            db=db_session,
            project_id=project.id,
            batch=schemas.InspectionBatchCreate(name="default-commit-batch"),
        )
        part = await crud.create_inspection_part(
            db=db_session,
            project_id=project.id,
            part=schemas.InspectionPartCreate(
                batch_id=batch.id,
                serial_number="SN-DEFAULT-COMMIT",
                metadata={"original": True},
            ),
        )
        updated = await crud.update_inspection_part_metadata(
            db=db_session,
            project_id=project.id,
            part_id=part.id,
            metadata_patch={"added": True},
        )

    assert commit_spy.await_count == 3
    assert updated is not None
    assert updated.metadata_json == {"original": True, "added": True}
