import uuid
import io
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from core import models, schemas
from core.database import get_db
from core.group_auth_helper import is_user_in_group
from utils.dependencies import get_current_user
import utils.crud as crud

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Export"])


@router.get("/projects/{project_id}/export-excel")
async def export_project_excel(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """
    Export all project image data as a Microsoft Excel (.xlsx) file.

    Each image corresponds to one row. Columns:
    - Lot Number
    - Part Serial Number
    - Image Identifier (filename)
    - Image Inspection Status
    - Inspector Name
    - Secondary Inspector Name
    - Image Classes
    - Comment
    """
    # Verify project exists and user has access
    db_project = await crud.get_project(db=db, project_id=project_id)
    if db_project is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )

    if not is_user_in_group(current_user.email, db_project.meta_group_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"User does not have access to project '{project_id}'.",
        )

    # Fetch all non-deleted images for the project
    result = await db.execute(
        select(models.DataInstance)
        .where(models.DataInstance.project_id == project_id)
        .where(models.DataInstance.deleted_at.is_(None))
        .order_by(models.DataInstance.created_at.asc())
    )
    images = result.scalars().all()

    # Build a class_id -> class_name lookup
    project_classes = await crud.get_image_classes_for_project(db, project_id)
    class_lookup = {str(c.id): c.name for c in project_classes}

    # Build a user_id -> email/username lookup for inspector names
    user_cache: dict[str, models.User] = {}

    async def get_user_display(user_id: uuid.UUID | None) -> str:
        if user_id is None:
            return ""
        key = str(user_id)
        if key not in user_cache:
            user = await crud.get_user_by_id(db, user_id)
            user_cache[key] = user
        user = user_cache.get(key)
        if user is None:
            return ""
        return user.username or user.email or ""

    # Collect rows: for each image, fetch classifications and comments
    rows = []
    for image in images:
        meta = image.metadata_json or {}

        # Classifications
        classifications = await crud.get_classifications_for_image(db, image.id)
        class_names = []
        for c in classifications:
            name = class_lookup.get(str(c.class_id))
            if name is None and c.image_class:
                name = c.image_class.name
            class_names.append(name or "Unknown")

        # Comments (concatenate all comments for the image)
        comments = await crud.get_comments_for_image(db, image.id)
        comment_texts = []
        for c in comments:
            author = await get_user_display(c.author_id)
            prefix = f"[{author}] " if author else ""
            comment_texts.append(f"{prefix}{c.text}")

        # Extract metadata fields - try common key variations
        lot_number = _extract_meta(meta, "lot_number", "lot", "lotNumber")
        part_serial = _extract_meta(
            meta, "part_serial_number", "serial_number", "serial",
            "partSerialNumber", "part_serial",
        )
        inspection_status = _extract_meta(
            meta, "inspection_status", "status", "inspectionStatus",
            "review_status",
        )
        inspector_name = _extract_meta(
            meta, "inspector_name", "inspector", "inspectorName",
            "reviewed_by",
        )
        secondary_inspector = _extract_meta(
            meta, "secondary_inspector_name", "secondary_inspector",
            "secondaryInspectorName", "secondary_reviewed_by",
        )

        # Fallback: if no inspector in metadata, use the uploader
        if not inspector_name and image.uploaded_by_user_id:
            inspector_name = image.uploaded_by_user_id

        rows.append({
            "lot_number": lot_number,
            "part_serial_number": part_serial,
            "image_identifier": image.filename or "",
            "inspection_status": inspection_status or "Not Reviewed",
            "inspector_name": inspector_name,
            "secondary_inspector_name": secondary_inspector,
            "image_classes": ", ".join(class_names) if class_names else "",
            "comment": " | ".join(comment_texts) if comment_texts else "",
        })

    # Generate Excel workbook
    wb = _build_workbook(db_project.name, rows)

    # Stream response
    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)

    safe_name = "".join(
        c if c.isalnum() or c in (" ", "-", "_") else "_"
        for c in db_project.name
    ).strip()
    filename = f"{safe_name}_export.xlsx"

    logger.info(
        "Excel export generated",
        extra={
            "project_id": str(project_id),
            "row_count": len(rows),
        },
    )

    return StreamingResponse(
        buffer,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


def _extract_meta(meta: dict, *keys: str) -> str:
    """Try multiple key names to extract a value from the metadata dict."""
    for key in keys:
        val = meta.get(key)
        if val is not None and str(val).strip():
            return str(val).strip()
    return ""


def _build_workbook(project_name: str, rows: list[dict]):
    """Build an openpyxl Workbook from the collected row data."""
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

    wb = Workbook()
    ws = wb.active
    ws.title = "Image Data"

    # Define columns matching the issue requirements
    columns = [
        ("Lot Number", 20),
        ("Part Serial Number", 25),
        ("Image Identifier", 35),
        ("Image Inspection Status", 25),
        ("Inspector Name", 25),
        ("Secondary Inspector Name", 25),
        ("Image Classes", 30),
        ("Comment", 50),
    ]

    # Header styling
    header_font = Font(bold=True, color="FFFFFF", size=11)
    header_fill = PatternFill(start_color="2F5496", end_color="2F5496", fill_type="solid")
    header_alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
    thin_border = Border(
        left=Side(style="thin"),
        right=Side(style="thin"),
        top=Side(style="thin"),
        bottom=Side(style="thin"),
    )

    # Write headers
    for col_idx, (header, width) in enumerate(columns, start=1):
        cell = ws.cell(row=1, column=col_idx, value=header)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = header_alignment
        cell.border = thin_border
        ws.column_dimensions[cell.column_letter].width = width

    # Data styling
    data_alignment = Alignment(vertical="top", wrap_text=True)
    row_keys = [
        "lot_number",
        "part_serial_number",
        "image_identifier",
        "inspection_status",
        "inspector_name",
        "secondary_inspector_name",
        "image_classes",
        "comment",
    ]

    # Status colors for conditional formatting
    status_fills = {
        "pass": PatternFill(start_color="C6EFCE", end_color="C6EFCE", fill_type="solid"),
        "reject": PatternFill(start_color="FFC7CE", end_color="FFC7CE", fill_type="solid"),
        "reject but not confirmed": PatternFill(
            start_color="FFEB9C", end_color="FFEB9C", fill_type="solid"
        ),
        "not reviewed": PatternFill(
            start_color="D9E2F3", end_color="D9E2F3", fill_type="solid"
        ),
    }

    # Alternate row fill for readability
    alt_fill = PatternFill(start_color="F2F2F2", end_color="F2F2F2", fill_type="solid")

    for row_idx, row_data in enumerate(rows, start=2):
        for col_idx, key in enumerate(row_keys, start=1):
            value = row_data.get(key, "") or ""
            cell = ws.cell(row=row_idx, column=col_idx, value=value)
            cell.alignment = data_alignment
            cell.border = thin_border

            # Alternate row shading
            if row_idx % 2 == 0:
                cell.fill = alt_fill

        # Apply status-based coloring to the inspection status cell (column 4)
        status_cell = ws.cell(row=row_idx, column=4)
        status_lower = (status_cell.value or "").lower().strip()
        if status_lower in status_fills:
            status_cell.fill = status_fills[status_lower]

    # Freeze the header row
    ws.freeze_panes = "A2"

    # Add autofilter
    if rows:
        ws.auto_filter.ref = f"A1:{chr(64 + len(columns))}{len(rows) + 1}"

    return wb
