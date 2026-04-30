import uuid
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core import models, schemas
from core.database import get_db

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.append(str(REPO_ROOT))

from test_toolbox import (
    ToolboxExecutionResult,
    ToolboxManifest,
    WorkflowGraph,
    WorkflowInputSource,
    execute_workflow,
    get_manifest,
    validate_workflow,
)
from utils.dependencies import get_current_user, get_project_or_403
import utils.crud as crud


router = APIRouter(tags=["Analyze"])


class AnalyzeImageSourceRecord(BaseModel):
    image_id: Optional[uuid.UUID] = None
    filename: str
    part_id: uuid.UUID
    part_serial_number: str
    part_display_name: Optional[str] = None
    modality: Optional[str] = None
    side: Optional[str] = None
    overlay: bool = False
    slice_axis: Optional[str] = None
    slice_index: Optional[int] = None
    content_type: Optional[str] = None
    size_bytes: Optional[int] = None
    metadata: Dict[str, Any] = Field(default_factory=dict)


class AnalyzePartSourceRecord(BaseModel):
    part_id: uuid.UUID
    serial_number: str
    display_name: Optional[str] = None
    image_count: int = 0


class AnalyzeInputSourceResponse(BaseModel):
    project_id: uuid.UUID
    source: WorkflowInputSource
    parts: List[AnalyzePartSourceRecord] = Field(default_factory=list)
    images: List[AnalyzeImageSourceRecord] = Field(default_factory=list)


def _metadata_dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _source_images_for_part(part: models.InspectionPart) -> List[Dict[str, Any]]:
    source_images = _metadata_dict(part.metadata_json).get("source_images")
    if not isinstance(source_images, list):
        return []
    return [record for record in source_images if isinstance(record, dict)]


def _safe_uuid(value: Any) -> Optional[uuid.UUID]:
    if value in (None, ""):
        return None
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError):
        return None


async def _load_default_part_images(
    db: AsyncSession,
    project_id: uuid.UUID,
) -> AnalyzeInputSourceResponse:
    parts = await crud.list_inspection_parts(db=db, project_id=project_id)
    image_ids = set()
    filenames = set()
    part_sources: Dict[uuid.UUID, List[Dict[str, Any]]] = {}

    for part in parts:
        records = _source_images_for_part(part)
        part_sources[part.id] = records
        for record in records:
            record_image_id = _safe_uuid(record.get("image_id"))
            if record_image_id:
                image_ids.add(record_image_id)
            filename = str(record.get("filename") or "").strip()
            if filename:
                filenames.add(filename)

    image_lookup: Dict[str, models.DataInstance] = {}
    if image_ids or filenames:
        conditions = [models.DataInstance.project_id == project_id, models.DataInstance.deleted_at.is_(None)]
        image_filters = []
        if image_ids:
            image_filters.append(models.DataInstance.id.in_(image_ids))
        if filenames:
            image_filters.append(models.DataInstance.filename.in_(filenames))
        result = await db.execute(
            select(models.DataInstance).where(*conditions).where(image_filters[0] if len(image_filters) == 1 else image_filters[0] | image_filters[1])
        )
        for image in result.scalars().all():
            image_lookup[str(image.id)] = image
            image_lookup[image.filename] = image

    deduped_images: Dict[str, AnalyzeImageSourceRecord] = {}
    part_records: List[AnalyzePartSourceRecord] = []

    for part in parts:
        image_count = 0
        for record in part_sources.get(part.id, []):
            filename = str(record.get("filename") or "").strip()
            record_image_id = _safe_uuid(record.get("image_id"))
            image = image_lookup.get(str(record_image_id)) if record_image_id else None
            image = image or image_lookup.get(filename)
            if not image and record_image_id:
                continue
            if not image:
                continue
            image_count += 1
            image_metadata = _metadata_dict(image.metadata_json) if image else {}
            source_key = str(image.id) if image else f"{part.id}:{filename}"
            deduped_images[source_key] = AnalyzeImageSourceRecord(
                image_id=image.id if image else record_image_id,
                filename=image.filename if image else filename,
                part_id=part.id,
                part_serial_number=part.serial_number,
                part_display_name=part.display_name,
                modality=record.get("modality") or image_metadata.get("modality"),
                side=record.get("side") or image_metadata.get("side"),
                overlay=bool(record.get("overlay") or image_metadata.get("overlay")),
                slice_axis=record.get("slice_axis") or image_metadata.get("slice_axis"),
                slice_index=record.get("slice_index") if record.get("slice_index") is not None else image_metadata.get("slice_index"),
                content_type=image.content_type if image else None,
                size_bytes=image.size_bytes if image else None,
                metadata=record,
            )
        part_records.append(
            AnalyzePartSourceRecord(
                part_id=part.id,
                serial_number=part.serial_number,
                display_name=part.display_name,
                image_count=image_count,
            )
        )

    images = sorted(
        deduped_images.values(),
        key=lambda item: (
            item.part_serial_number,
            item.slice_index is None,
            item.slice_index if item.slice_index is not None else 0,
            item.filename,
        ),
    )
    return AnalyzeInputSourceResponse(
        project_id=project_id,
        source=WorkflowInputSource(
            project_id=project_id,
            image_count=len(images),
            part_count=len(parts),
        ),
        parts=part_records,
        images=images,
    )


async def _workflow_with_server_source(
    *,
    project_id: uuid.UUID,
    workflow: WorkflowGraph,
    db: AsyncSession,
) -> WorkflowGraph:
    if workflow.source.project_id and workflow.source.project_id != project_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Workflow source project_id does not match route project_id",
        )
    input_source = await _load_default_part_images(db, project_id)
    server_source = input_source.source
    if workflow.source.kind == "manual_selection":
        selected_image_ids = set(workflow.source.selected_image_ids)
        selected_part_ids = set(workflow.source.selected_part_ids)
        selected_images = [
            image for image in input_source.images
            if (image.image_id and image.image_id in selected_image_ids) or image.part_id in selected_part_ids
        ]
        selected_parts = {image.part_id for image in selected_images}
        server_source = workflow.source.model_copy(update={
            "project_id": project_id,
            "image_count": len(selected_images),
            "part_count": len(selected_parts),
        })
    return workflow.model_copy(update={"source": server_source})


@router.get("/analyze/toolbox", response_model=ToolboxManifest)
async def get_analyze_toolbox(
    current_user: schemas.User = Depends(get_current_user),
):
    _ = current_user
    return get_manifest()


@router.get("/projects/{project_id}/analyze/input-source", response_model=AnalyzeInputSourceResponse)
async def get_analyze_input_source(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await get_project_or_403(project_id, db, current_user)
    return await _load_default_part_images(db, project_id)


@router.post("/projects/{project_id}/analyze/workflows/validate", response_model=ToolboxExecutionResult)
async def validate_analyze_workflow(
    project_id: uuid.UUID,
    workflow: WorkflowGraph,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await get_project_or_403(project_id, db, current_user)
    workflow = await _workflow_with_server_source(project_id=project_id, workflow=workflow, db=db)
    try:
        return validate_workflow(workflow)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc


@router.post("/projects/{project_id}/analyze/workflows/execute", response_model=ToolboxExecutionResult)
async def execute_analyze_workflow(
    project_id: uuid.UUID,
    workflow: WorkflowGraph,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await get_project_or_403(project_id, db, current_user)
    workflow = await _workflow_with_server_source(project_id=project_id, workflow=workflow, db=db)
    try:
        return execute_workflow(workflow)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
