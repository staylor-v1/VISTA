import uuid
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
