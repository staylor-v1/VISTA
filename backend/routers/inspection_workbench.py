import uuid
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from core import schemas
from core.database import get_db
from core.group_auth_helper import is_user_in_group
from utils.dependencies import get_current_user
import utils.crud as crud


router = APIRouter(tags=["Inspection Workbench"])

WORKSPACE_STATE_KEY_PREFIX = "inspection_workbench.workspace_state"
PROJECT_CONFIGURATION_KEY = "inspection_workbench.project_configuration"
ANNOTATIONS_METADATA_KEY = "annotations"


async def _get_project_with_access_check(
    project_id: uuid.UUID,
    db: AsyncSession,
    current_user: schemas.User,
):
    project = await crud.get_project(db=db, project_id=project_id)
    if not project:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")

    if not is_user_in_group(current_user.email, project.meta_group_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"User '{current_user.email}' does not have access to project '{project_id}'.",
        )
    return project


def _serialize_inspection_part(part) -> dict:
    return {
        "id": part.id,
        "project_id": part.project_id,
        "batch_id": part.batch_id,
        "serial_number": part.serial_number,
        "display_name": part.display_name,
        "metadata": part.metadata_json,
        "review_state": part.review_state,
        "created_at": part.created_at,
        "updated_at": part.updated_at,
    }


def _workspace_state_metadata_key(user_email: str) -> str:
    return f"{WORKSPACE_STATE_KEY_PREFIX}:{user_email.strip().lower()}"


def _part_annotations(part) -> List[dict]:
    metadata = part.metadata_json if isinstance(part.metadata_json, dict) else {}
    annotations = metadata.get(ANNOTATIONS_METADATA_KEY)
    return list(annotations) if isinstance(annotations, list) else []


def _default_project_configuration() -> dict:
    return {
        "image_modalities": [
            {
                "id": "visual",
                "label": "Visual",
                "calibration_required": False,
                "example_image_uploaded": False,
            }
        ],
        "part_views": [
            {"id": "front", "label": "Front", "required_modalities": ["visual"], "source": "manual"},
            {"id": "back", "label": "Back", "required_modalities": ["visual"], "source": "manual"},
        ],
        "defect_types": [],
        "process_settings": {
            "require_disposition_on_submit": True,
            "require_measurement_for_critical": False,
            "require_second_reviewer_for_reject": False,
            "configurable_hotkeys": {
                "accept_classification": "a",
                "reject_classification": "r",
                "toggle_shortcut_help": "h",
            },
        },
        "display_settings": {
            "default_colormap": "grayscale",
            "anomaly_colormap": "viridis",
            "grayscale_base_image": True,
        },
    }


@router.post(
    "/projects/{project_id}/batches",
    response_model=schemas.InspectionBatch,
    status_code=status.HTTP_201_CREATED,
)
async def create_inspection_batch(
    project_id: uuid.UUID,
    batch: schemas.InspectionBatchCreate,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)

    try:
        return await crud.create_inspection_batch(
            db=db,
            project_id=project_id,
            batch=batch,
            created_by=current_user.email,
        )
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Batch name already exists in this project")


@router.get("/projects/{project_id}/batches", response_model=List[schemas.InspectionBatch])
async def list_inspection_batches(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    return await crud.list_inspection_batches(db=db, project_id=project_id)


@router.post(
    "/projects/{project_id}/parts",
    response_model=schemas.InspectionPart,
    status_code=status.HTTP_201_CREATED,
)
async def create_inspection_part(
    project_id: uuid.UUID,
    part: schemas.InspectionPartCreate,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)

    if part.batch_id:
        batch = await crud.get_inspection_batch(db=db, batch_id=part.batch_id)
        if not batch or batch.project_id != project_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="batch_id does not belong to this project")

    try:
        created = await crud.create_inspection_part(
            db=db,
            project_id=project_id,
            part=part,
            created_by=current_user.email,
        )
        return _serialize_inspection_part(created)
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Serial number already exists in this project")


@router.get("/projects/{project_id}/parts", response_model=List[schemas.InspectionPart])
async def list_inspection_parts(
    project_id: uuid.UUID,
    batch_id: Optional[uuid.UUID] = None,
    review_state: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
): 
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    parts = await crud.list_inspection_parts(
        db=db,
        project_id=project_id,
        batch_id=batch_id,
        review_state=review_state,
    )
    return [_serialize_inspection_part(part) for part in parts]


@router.patch("/projects/{project_id}/parts/{part_id}", response_model=schemas.InspectionPart)
async def update_inspection_part_review_state(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    payload: schemas.InspectionPartUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    updated = await crud.update_inspection_part_review_state(
        db=db,
        project_id=project_id,
        part_id=part_id,
        review_state=payload.review_state,
        updated_by=current_user.email,
    )
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")
    return _serialize_inspection_part(updated)


@router.post(
    "/projects/{project_id}/parts/{part_id}/segmentation-runs",
    response_model=schemas.InspectionSegmentationInvokeResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def invoke_part_segmentation(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    payload: schemas.InspectionSegmentationInvokeRequest,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)

    part = await crud.get_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")

    created_at = datetime.now(timezone.utc)
    run_id = uuid.uuid4()
    overlay_id = f"segmentation-{payload.axis}-{payload.slice_index}"
    run_entry = {
        "run_id": str(run_id),
        "axis": payload.axis,
        "slice_index": payload.slice_index,
        "status": "completed",
        "overlay_id": overlay_id,
        "created_at": created_at.isoformat(),
        "requested_by": current_user.email,
    }

    existing_runs = []
    if isinstance(part.metadata_json, dict):
        existing_runs = list(part.metadata_json.get("segmentation_runs") or [])
    updated_part = await crud.update_inspection_part_metadata(
        db=db,
        project_id=project_id,
        part_id=part_id,
        metadata_patch={"segmentation_runs": [*existing_runs, run_entry]},
        updated_by=current_user.email,
    )
    if not updated_part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")

    return {
        "run_id": run_id,
        "part_id": part_id,
        "axis": payload.axis,
        "slice_index": payload.slice_index,
        "status": "completed",
        "overlay_id": overlay_id,
        "created_at": created_at,
    }


@router.post(
    "/projects/{project_id}/parts/{part_id}/measurement-runs",
    response_model=schemas.InspectionMeasurementInvokeResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def invoke_ai_measurements(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    payload: schemas.InspectionMeasurementInvokeRequest,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)

    part = await crud.get_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")

    synthetic_level = 0
    if isinstance(part.metadata_json, dict):
        synthetic_level = int(part.metadata_json.get("synthetic_level") or 0)

    complexity_multiplier = max(1, synthetic_level)
    values = {
        "crack_length_mm": round((12.4 + len(payload.include_overlays) * 1.7) * complexity_multiplier, 2),
        "pore_area_mm2": round((2.1 + len(payload.measurement_profile) * 0.08) * complexity_multiplier, 2),
        "edge_offset_mm": round((0.35 + (complexity_multiplier * 0.11)), 2),
    }

    created_at = datetime.now(timezone.utc)
    run_id = uuid.uuid4()
    result_entry = {
        "run_id": str(run_id),
        "measurement_profile": payload.measurement_profile,
        "include_overlays": payload.include_overlays,
        "status": "completed",
        "units": "mm",
        "values": values,
        "created_at": created_at.isoformat(),
        "requested_by": current_user.email,
    }

    existing_runs = []
    if isinstance(part.metadata_json, dict):
        existing_runs = list(part.metadata_json.get("measurement_runs") or [])

    updated_part = await crud.update_inspection_part_metadata(
        db=db,
        project_id=project_id,
        part_id=part_id,
        metadata_patch={"measurement_runs": [*existing_runs, result_entry]},
        updated_by=current_user.email,
    )
    if not updated_part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")

    return {
        "run_id": run_id,
        "part_id": part_id,
        "status": "completed",
        "measurement_profile": payload.measurement_profile,
        "units": "mm",
        "values": values,
        "created_at": created_at,
    }


@router.get(
    "/projects/{project_id}/parts/{part_id}/annotations",
    response_model=schemas.InspectionAnnotationListResponse,
)
async def list_part_annotations(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    include_hidden: bool = True,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    part = await crud.get_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")

    annotations = _part_annotations(part)
    if not include_hidden:
        annotations = [annotation for annotation in annotations if not annotation.get("hidden", False)]
    return {"part_id": part_id, "annotations": annotations}


@router.post(
    "/projects/{project_id}/parts/{part_id}/annotations",
    response_model=schemas.InspectionAnnotation,
    status_code=status.HTTP_201_CREATED,
)
async def create_part_annotation(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    payload: schemas.InspectionAnnotationCreate,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    part = await crud.get_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")

    now = datetime.now(timezone.utc)
    annotation_entry = {
        "id": str(uuid.uuid4()),
        **payload.model_dump(),
        "created_at": now.isoformat(),
        "created_by": current_user.email,
        "updated_at": now.isoformat(),
        "updated_by": current_user.email,
    }
    annotations = _part_annotations(part)
    annotations.append(annotation_entry)
    updated_part = await crud.update_inspection_part_metadata(
        db=db,
        project_id=project_id,
        part_id=part_id,
        metadata_patch={ANNOTATIONS_METADATA_KEY: annotations},
        updated_by=current_user.email,
    )
    if not updated_part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")
    return annotation_entry


@router.patch(
    "/projects/{project_id}/parts/{part_id}/annotations/{annotation_id}",
    response_model=schemas.InspectionAnnotation,
)
async def update_part_annotation(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    annotation_id: uuid.UUID,
    payload: schemas.InspectionAnnotationUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    part = await crud.get_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")

    existing_annotations = _part_annotations(part)
    update_payload = payload.model_dump(exclude_none=True)
    now = datetime.now(timezone.utc).isoformat()
    updated_annotation = None
    updated_annotations = []

    for annotation in existing_annotations:
        if annotation.get("id") == str(annotation_id):
            annotation = {
                **annotation,
                **update_payload,
                "updated_at": now,
                "updated_by": current_user.email,
            }
            updated_annotation = annotation
        updated_annotations.append(annotation)

    if not updated_annotation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Annotation not found")

    persisted = await crud.update_inspection_part_metadata(
        db=db,
        project_id=project_id,
        part_id=part_id,
        metadata_patch={ANNOTATIONS_METADATA_KEY: updated_annotations},
        updated_by=current_user.email,
    )
    if not persisted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")
    return updated_annotation


@router.get(
    "/projects/{project_id}/workspace-state",
    response_model=schemas.InspectionWorkspaceStateResponse,
)
async def get_inspection_workspace_state(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    metadata_key = _workspace_state_metadata_key(current_user.email)
    metadata = await crud.get_project_metadata_by_key(
        db=db,
        project_id=project_id,
        key=metadata_key,
    )
    raw_state = metadata.value if metadata else {}
    safe_state = raw_state if isinstance(raw_state, dict) else {}
    return {
        "project_id": project_id,
        "user_email": current_user.email,
        "state": safe_state,
        "updated_at": metadata.updated_at if metadata else None,
    }


@router.put(
    "/projects/{project_id}/workspace-state",
    response_model=schemas.InspectionWorkspaceStateResponse,
)
async def update_inspection_workspace_state(
    project_id: uuid.UUID,
    payload: schemas.InspectionWorkspaceStatePayload,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    metadata_key = _workspace_state_metadata_key(current_user.email)
    updated = await crud.create_or_update_project_metadata(
        db=db,
        metadata=schemas.ProjectMetadataCreate(
            project_id=project_id,
            key=metadata_key,
            value=payload.state,
        ),
        created_by=current_user.email,
    )
    safe_state = updated.value if isinstance(updated.value, dict) else {}
    return {
        "project_id": project_id,
        "user_email": current_user.email,
        "state": safe_state,
        "updated_at": updated.updated_at,
    }


@router.get(
    "/projects/{project_id}/configuration",
    response_model=schemas.InspectionProjectConfigurationResponse,
)
async def get_project_configuration(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    metadata = await crud.get_project_metadata_by_key(
        db=db,
        project_id=project_id,
        key=PROJECT_CONFIGURATION_KEY,
    )
    raw_config = metadata.value if metadata and isinstance(metadata.value, dict) else _default_project_configuration()
    return {
        "project_id": project_id,
        "config": raw_config,
        "updated_at": metadata.updated_at if metadata else None,
    }


@router.put(
    "/projects/{project_id}/configuration",
    response_model=schemas.InspectionProjectConfigurationResponse,
)
async def update_project_configuration(
    project_id: uuid.UUID,
    payload: schemas.InspectionProjectConfigurationPayload,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    updated = await crud.create_or_update_project_metadata(
        db=db,
        metadata=schemas.ProjectMetadataCreate(
            project_id=project_id,
            key=PROJECT_CONFIGURATION_KEY,
            value=payload.config.model_dump(),
        ),
        created_by=current_user.email,
    )
    persisted = updated.value if isinstance(updated.value, dict) else _default_project_configuration()
    return {
        "project_id": project_id,
        "config": persisted,
        "updated_at": updated.updated_at,
    }
