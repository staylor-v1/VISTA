import uuid
import io
import json
import logging
import zipfile
from collections import defaultdict

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse, StreamingResponse, Response
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func as _func

from core import models, schemas
from core.database import get_db
from core.group_auth_helper import is_user_in_group
from utils.dependencies import get_current_user
import utils.crud as crud

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Export"])


async def _get_project_with_export_access(
    project_id: uuid.UUID,
    db: AsyncSession,
    current_user: schemas.User,
) -> models.Project:
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
    return db_project


@router.get("/projects/{project_id}/export-excel")
async def export_project_excel(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """
    Export all project image data as a Microsoft Excel (.xlsx) file.

    Each image corresponds to one row. Columns are dynamic:
    - Filename (always first)
    - One column per unique metadata key found across all project images
    - Review Status, Reviewer, Review Date (most recent review for the image)
    - Image Classes (derived from classifications)
    - Comment (derived from comments)
    """
    db_project = await _get_project_with_export_access(
        project_id=project_id,
        db=db,
        current_user=current_user,
    )

    # Fetch all non-deleted images for the project
    result = await db.execute(
        select(models.DataInstance)
        .where(models.DataInstance.project_id == project_id)
        .where(models.DataInstance.deleted_at.is_(None))
        .order_by(models.DataInstance.created_at.asc())
    )
    images = result.scalars().all()
    image_ids = [img.id for img in images]

    # Build a class_id -> class_name lookup
    project_classes = await crud.get_image_classes_for_project(db, project_id)
    class_lookup = {str(c.id): c.name for c in project_classes}

    # Bulk-fetch all classifications for project images (avoids N+1 queries)
    classifications_by_image: dict[str, list] = defaultdict(list)
    if image_ids:
        cls_result = await db.execute(
            select(models.ImageClassification)
            .where(models.ImageClassification.image_id.in_(image_ids))
        )
        for c in cls_result.scalars().all():
            classifications_by_image[str(c.image_id)].append(c)

    # Bulk-fetch all comments for project images (avoids N+1 queries)
    comments_by_image: dict[str, list] = defaultdict(list)
    if image_ids:
        cmt_result = await db.execute(
            select(models.ImageComment)
            .where(models.ImageComment.image_id.in_(image_ids))
            .order_by(models.ImageComment.created_at.asc())
        )
        for c in cmt_result.scalars().all():
            comments_by_image[str(c.image_id)].append(c)

    # Collect unique author IDs for batch user lookup
    author_ids = set()
    for comments in comments_by_image.values():
        for c in comments:
            if c.author_id:
                author_ids.add(c.author_id)
    for img in images:
        if img.uploader_id:
            author_ids.add(img.uploader_id)

    # Bulk-fetch the most recent review per image (status, reviewer_id, created_at)
    latest_review_by_image: dict[str, models.ImageReview] = {}
    if image_ids:
        latest_review_subq = (
            select(
                models.ImageReview.image_id,
                models.ImageReview.status,
                models.ImageReview.reviewer_id,
                models.ImageReview.created_at,
                _func.row_number().over(
                    partition_by=models.ImageReview.image_id,
                    order_by=models.ImageReview.created_at.desc(),
                ).label("rn"),
            )
            .where(models.ImageReview.image_id.in_(image_ids))
            .subquery()
        )
        rev_result = await db.execute(
            select(
                latest_review_subq.c.image_id,
                latest_review_subq.c.status,
                latest_review_subq.c.reviewer_id,
                latest_review_subq.c.created_at,
            ).where(latest_review_subq.c.rn == 1)
        )
        for row in rev_result:
            latest_review_by_image[str(row.image_id)] = row
            if row.reviewer_id:
                author_ids.add(row.reviewer_id)

    # Batch-fetch all referenced users
    user_cache: dict[str, models.User] = {}
    if author_ids:
        user_result = await db.execute(
            select(models.User)
            .where(models.User.id.in_(list(author_ids)))
        )
        for u in user_result.scalars().all():
            user_cache[str(u.id)] = u

    def get_user_display(user_id) -> str:
        if user_id is None:
            return ""
        user = user_cache.get(str(user_id))
        if user is None:
            return ""
        return user.username or user.email or ""

    # Collect all unique metadata keys across all images (in order of first appearance).
    # The "measurements" key stores internal pixel-measurement overlays and is excluded.
    _EXCLUDED_META_KEYS = {"measurements"}
    all_meta_keys: list[str] = []
    seen_keys: set[str] = set()
    for image in images:
        for key in (image.metadata_json or {}).keys():
            if key not in seen_keys and key not in _EXCLUDED_META_KEYS:
                seen_keys.add(key)
                all_meta_keys.append(key)

    # Build rows from the bulk-fetched data
    rows = []
    for image in images:
        meta = image.metadata_json or {}

        # Classifications
        class_names = []
        for c in classifications_by_image.get(str(image.id), []):
            name = class_lookup.get(str(c.class_id), "Unknown")
            class_names.append(name)

        # Comments
        comment_texts = []
        for c in comments_by_image.get(str(image.id), []):
            author = get_user_display(c.author_id)
            prefix = f"[{author}] " if author else ""
            comment_texts.append(f"{prefix}{c.text}")

        row: dict[str, str] = {"filename": image.filename or ""}
        for key in all_meta_keys:
            val = meta.get(key)
            if val is None:
                row[key] = ""
            elif isinstance(val, (dict, list)):
                row[key] = json.dumps(val)
            else:
                row[key] = str(val).strip()

        # Review fields from the most recent review
        review = latest_review_by_image.get(str(image.id))
        if review:
            row["review_status"] = review.status or ""
            row["reviewer"] = get_user_display(review.reviewer_id)
            if review.created_at:
                dt = review.created_at
                row["review_date"] = dt.strftime("%Y-%m-%d %H:%M UTC")
            else:
                row["review_date"] = ""
        else:
            row["review_status"] = ""
            row["reviewer"] = ""
            row["review_date"] = ""

        row["image_classes"] = ", ".join(class_names) if class_names else ""
        row["comment"] = " | ".join(comment_texts) if comment_texts else ""
        rows.append(row)

    # Generate Excel workbook
    wb = _build_workbook(db_project.name, rows, all_meta_keys)

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
        "Excel export generated for project",
        extra={
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


def _normalize_part_artifact_records(part_id, serial_number, annotations, overlay_layers, measurement_runs):
    annotation_records = []
    overlay_records = []
    measurement_records = []
    incomplete_annotations = 0
    missing_measurement_ids = 0

    for annotation in annotations:
        annotation_obj = annotation if isinstance(annotation, dict) else {}
        if not annotation_obj.get("defect_class") or not annotation_obj.get("modality"):
            incomplete_annotations += 1
        annotation_records.append(
            {
                "part_id": str(part_id),
                "part_serial_number": serial_number,
                "annotation_id": annotation_obj.get("id"),
                "defect_class": annotation_obj.get("defect_class"),
                "modality": annotation_obj.get("modality"),
                "disposition": annotation_obj.get("disposition"),
                "hidden": bool(annotation_obj.get("hidden", False)),
            }
        )

    for overlay in overlay_layers:
        overlay_obj = overlay if isinstance(overlay, dict) else {}
        overlay_records.append(
            {
                "part_id": str(part_id),
                "part_serial_number": serial_number,
                "overlay_id": overlay_obj.get("id"),
                "label": overlay_obj.get("label"),
                "color": overlay_obj.get("color"),
            }
        )

    for measurement in measurement_runs:
        measurement_obj = measurement if isinstance(measurement, dict) else {}
        if not measurement_obj.get("run_id"):
            missing_measurement_ids += 1
        measurement_records.append(
            {
                "part_id": str(part_id),
                "part_serial_number": serial_number,
                "run_id": measurement_obj.get("run_id"),
                "status": measurement_obj.get("status"),
            }
        )

    return {
        "annotation_records": annotation_records,
        "overlay_records": overlay_records,
        "measurement_records": measurement_records,
        "incomplete_annotations": incomplete_annotations,
        "missing_measurement_ids": missing_measurement_ids,
    }


def _normalize_metadata_dict_list(metadata_obj, key):
    candidate = metadata_obj.get(key)
    if not isinstance(candidate, list):
        return [], 0
    normalized = []
    dropped_count = 0
    for item in candidate:
        if isinstance(item, dict):
            normalized.append(item)
        elif key == "overlay_layers" and isinstance(item, str) and item.strip():
            normalized.append({"id": item, "label": item})
        else:
            dropped_count += 1
    return normalized, dropped_count


async def _build_project_report_payload(project_id: uuid.UUID, db: AsyncSession, db_project: models.Project) -> dict:
    image_count_result = await db.execute(
        select(_func.count())
        .select_from(models.DataInstance)
        .where(models.DataInstance.project_id == project_id)
        .where(models.DataInstance.deleted_at.is_(None))
    )
    total_images = image_count_result.scalar_one()

    part_count_result = await db.execute(
        select(_func.count())
        .select_from(models.InspectionPart)
        .where(models.InspectionPart.project_id == project_id)
    )
    total_parts = part_count_result.scalar_one()

    batch_count_result = await db.execute(
        select(_func.count())
        .select_from(models.InspectionBatch)
        .where(models.InspectionBatch.project_id == project_id)
    )
    total_batches = batch_count_result.scalar_one()

    reviewed_states = ("pass", "reject_pending", "reject_confirmed")
    reviewed_parts_result = await db.execute(
        select(_func.count())
        .select_from(models.InspectionPart)
        .where(models.InspectionPart.project_id == project_id)
        .where(models.InspectionPart.review_state.in_(reviewed_states))
    )
    reviewed_parts = reviewed_parts_result.scalar_one()

    part_metadata_result = await db.execute(
        select(models.InspectionPart.metadata_json)
        .where(models.InspectionPart.project_id == project_id)
    )
    metadata_drop_counts = {
        "annotations": 0,
        "overlay_layers": 0,
        "segmentation_runs": 0,
        "measurement_runs": 0,
    }
    for (metadata,) in part_metadata_result:
        metadata_obj = metadata if isinstance(metadata, dict) else {}
        for key in metadata_drop_counts:
            _, dropped = _normalize_metadata_dict_list(metadata_obj, key)
            metadata_drop_counts[key] += dropped

    return {
        "project": {
            "id": str(db_project.id),
            "name": db_project.name,
            "project_type": db_project.project_type,
            "meta_group_id": db_project.meta_group_id,
        },
        "summary": {
            "total_images": total_images,
            "total_batches": total_batches,
            "total_parts": total_parts,
            "reviewed_parts": reviewed_parts,
            "unreviewed_parts": max(total_parts - reviewed_parts, 0),
            "metadata_normalization": {
                "dropped_non_object_items": metadata_drop_counts,
            },
        },
    }


def _build_simple_report_pdf(report_payload: dict) -> bytes:
    project = report_payload.get("project", {})
    summary = report_payload.get("summary", {})
    dropped = summary.get("metadata_normalization", {}).get("dropped_non_object_items", {})
    lines = [
        "VISTA Inspection Report",
        f"Project: {project.get('name', 'Unknown')}",
        f"Project ID: {project.get('id', 'Unknown')}",
        f"Project Type: {project.get('project_type', 'PT1')}",
        f"Total Images: {summary.get('total_images', 0)}",
        f"Total Batches: {summary.get('total_batches', 0)}",
        f"Total Parts: {summary.get('total_parts', 0)}",
        f"Reviewed Parts: {summary.get('reviewed_parts', 0)}",
        f"Unreviewed Parts: {summary.get('unreviewed_parts', 0)}",
        "Dropped Metadata Items:",
    ]
    for field, count in dropped.items():
        lines.append(f"- {field or 'unknown_field'}: {count}")

    safe_lines = [str(line).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)") for line in lines]
    text_lines = ["BT", "/F1 12 Tf", "72 760 Td", "14 TL"]
    for index, line in enumerate(safe_lines):
        if index > 0:
            text_lines.append("T*")
        text_lines.append(f"({line}) Tj")
    text_lines.append("ET")
    content_stream = "\n".join(text_lines).encode("latin-1", errors="replace")

    objects = []
    objects.append(b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n")
    objects.append(b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n")
    objects.append(
        b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj\n"
    )
    objects.append(b"4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n")
    objects.append(
        b"5 0 obj << /Length " + str(len(content_stream)).encode("ascii") + b" >> stream\n"
        + content_stream
        + b"\nendstream endobj\n"
    )

    pdf = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for obj in objects:
        offsets.append(len(pdf))
        pdf.extend(obj)
    xref_offset = len(pdf)
    pdf.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    pdf.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        pdf.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    pdf.extend(
        f"trailer << /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF".encode("ascii")
    )
    return bytes(pdf)


@router.get("/projects/{project_id}/report-json")
async def export_project_report_json(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    db_project = await _get_project_with_export_access(
        project_id=project_id,
        db=db,
        current_user=current_user,
    )

    report_payload = await _build_project_report_payload(project_id=project_id, db=db, db_project=db_project)
    return JSONResponse(content=report_payload)


@router.get("/projects/{project_id}/report-pdf")
async def export_project_report_pdf(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    db_project = await _get_project_with_export_access(
        project_id=project_id,
        db=db,
        current_user=current_user,
    )
    report_payload = await _build_project_report_payload(project_id=project_id, db=db, db_project=db_project)
    pdf_bytes = _build_simple_report_pdf(report_payload)
    filename = f"{db_project.name.replace(' ', '_') or 'project'}-report.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/projects/{project_id}/export-bundle-json")
async def export_project_bundle_json(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    db_project = await _get_project_with_export_access(
        project_id=project_id,
        db=db,
        current_user=current_user,
    )

    image_totals_result = await db.execute(
        select(
            _func.count().label("total_images"),
            _func.coalesce(_func.sum(models.DataInstance.size_bytes), 0).label("total_image_bytes"),
        )
        .select_from(models.DataInstance)
        .where(models.DataInstance.project_id == project_id)
        .where(models.DataInstance.deleted_at.is_(None))
    )
    image_totals = image_totals_result.one()

    part_metadata_result = await db.execute(
        select(
            models.InspectionPart.id,
            models.InspectionPart.serial_number,
            models.InspectionPart.display_name,
            models.InspectionPart.metadata_json,
        )
        .where(models.InspectionPart.project_id == project_id)
    )
    part_metadata_rows = part_metadata_result.all()

    annotations_count = 0
    overlay_layer_count = 0
    segmentation_run_count = 0
    measurement_run_count = 0
    annotation_records = []
    overlay_records = []
    measurement_records = []
    part_discrepancy_summaries = []

    for part_id, serial_number, display_name, metadata in part_metadata_rows:
        metadata_obj = metadata if isinstance(metadata, dict) else {}
        annotations, dropped_annotations = _normalize_metadata_dict_list(metadata_obj, "annotations")
        overlay_layers, dropped_overlay_layers = _normalize_metadata_dict_list(metadata_obj, "overlay_layers")
        segmentation_runs, dropped_segmentation_runs = _normalize_metadata_dict_list(metadata_obj, "segmentation_runs")
        measurement_runs, dropped_measurement_runs = _normalize_metadata_dict_list(metadata_obj, "measurement_runs")

        annotations_count += len(annotations)
        overlay_layer_count += len(overlay_layers)
        segmentation_run_count += len(segmentation_runs)
        measurement_run_count += len(measurement_runs)

        normalized_records = _normalize_part_artifact_records(
            part_id=part_id,
            serial_number=serial_number,
            annotations=annotations,
            overlay_layers=overlay_layers,
            measurement_runs=measurement_runs,
        )
        annotation_records.extend(normalized_records["annotation_records"])
        overlay_records.extend(normalized_records["overlay_records"])
        measurement_records.extend(normalized_records["measurement_records"])

        incomplete_annotations = normalized_records["incomplete_annotations"]
        missing_measurement_ids = normalized_records["missing_measurement_ids"]
        dropped_metadata_items = (
            dropped_annotations
            + dropped_overlay_layers
            + dropped_segmentation_runs
            + dropped_measurement_runs
        )

        discrepancy_codes = []
        if segmentation_runs and not overlay_layers:
            discrepancy_codes.append("missing_overlay_layers")
        if incomplete_annotations:
            discrepancy_codes.append("incomplete_annotation_fields")
        if missing_measurement_ids:
            discrepancy_codes.append("measurement_run_missing_run_id")
        if dropped_metadata_items:
            discrepancy_codes.append("metadata_items_dropped_non_object")

        part_discrepancy_summaries.append(
            {
                "part_id": str(part_id),
                "serial_number": serial_number,
                "display_name": display_name,
                "counts": {
                    "annotations": len(annotations),
                    "overlay_layers": len(overlay_layers),
                    "segmentation_runs": len(segmentation_runs),
                    "measurement_runs": len(measurement_runs),
                    "incomplete_annotations": incomplete_annotations,
                    "measurement_runs_missing_run_id": missing_measurement_ids,
                    "dropped_non_object_metadata_items": dropped_metadata_items,
                },
                "discrepancy_codes": discrepancy_codes,
            }
        )

    discrepancy_total = sum(1 for summary in part_discrepancy_summaries if summary["discrepancy_codes"])

    bundle_payload = {
        "project": {
            "id": str(db_project.id),
            "name": db_project.name,
            "project_type": db_project.project_type,
            "meta_group_id": db_project.meta_group_id,
        },
        "bundle_summary": {
            "images": {
                "total": image_totals.total_images,
                "total_bytes": image_totals.total_image_bytes,
            },
            "parts": {
                "total": len(part_metadata_rows),
            },
            "annotations": {
                "total": annotations_count,
                "records": annotation_records,
            },
            "overlays": {
                "configured_layers": overlay_layer_count,
                "segmentation_runs": segmentation_run_count,
                "records": overlay_records,
            },
            "measurements": {
                "ai_runs": measurement_run_count,
                "records": measurement_records,
            },
            "discrepancies": {
                "parts_with_discrepancies": discrepancy_total,
                "per_part": part_discrepancy_summaries,
            },
        },
    }
    return JSONResponse(content=bundle_payload)


@router.get("/projects/{project_id}/export-bundle")
async def export_project_bundle_archive(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    db_project = await _get_project_with_export_access(
        project_id=project_id,
        db=db,
        current_user=current_user,
    )

    bundle_json_response = await export_project_bundle_json(
        project_id=project_id,
        db=db,
        current_user=current_user,
    )
    bundle_payload = json.loads(bundle_json_response.body.decode("utf-8"))

    image_refs_result = await db.execute(
        select(
            models.DataInstance.id,
            models.DataInstance.filename,
            models.DataInstance.object_storage_key,
            models.DataInstance.size_bytes,
        )
        .where(models.DataInstance.project_id == project_id)
        .where(models.DataInstance.deleted_at.is_(None))
        .order_by(models.DataInstance.created_at.asc())
    )
    image_refs = [
        {
            "image_id": str(row.id),
            "filename": row.filename,
            "object_storage_key": row.object_storage_key,
            "size_bytes": row.size_bytes,
        }
        for row in image_refs_result
    ]

    manifest_payload = {
        "project": bundle_payload["project"],
        "bundle_summary": bundle_payload["bundle_summary"],
        "image_references": image_refs,
    }

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "export-manifest.json",
            json.dumps(manifest_payload, indent=2, sort_keys=True),
        )
    buffer.seek(0)

    safe_name = "".join(
        c if c.isalnum() or c in (" ", "-", "_") else "_"
        for c in db_project.name
    ).strip()
    filename = f"{safe_name}_export_bundle.zip"

    return StreamingResponse(
        buffer,
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


def _build_workbook(project_name: str, rows: list[dict], meta_keys: list[str]):
    """Build an openpyxl Workbook from the collected row data.

    Columns are dynamic:
    - Filename (always first)
    - One column per unique metadata key
    - Review Status, Reviewer, Review Date
    - Image Classes
    - Comment
    """
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    ws = wb.active
    ws.title = "Image Data"

    # Dynamic column definitions: (header_label, width)
    columns = [("Filename", 35)]
    for key in meta_keys:
        columns.append((key, 20))
    columns.append(("Review Status", 20))
    columns.append(("Reviewer", 25))
    columns.append(("Review Date", 22))
    columns.append(("Image Classes", 30))
    columns.append(("Comment", 50))

    # The dict keys used to retrieve values from each row
    row_keys = (
        ["filename"]
        + list(meta_keys)
        + ["review_status", "reviewer", "review_date", "image_classes", "comment"]
    )

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

    # Characters that trigger formula evaluation in Excel
    _FORMULA_CHARS = frozenset("=+-@")

    # Write headers
    for col_idx, (header, width) in enumerate(columns, start=1):
        cell = ws.cell(row=1, column=col_idx, value=header)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = header_alignment
        cell.border = thin_border
        if isinstance(header, str) and header and header[0] in _FORMULA_CHARS:
            cell.quotePrefix = True
        ws.column_dimensions[cell.column_letter].width = width

    # Data styling
    data_alignment = Alignment(vertical="top", wrap_text=True)
    alt_fill = PatternFill(start_color="F2F2F2", end_color="F2F2F2", fill_type="solid")

    for row_idx, row_data in enumerate(rows, start=2):
        for col_idx, key in enumerate(row_keys, start=1):
            value = row_data.get(key, "") or ""
            cell = ws.cell(row=row_idx, column=col_idx, value=value)
            cell.alignment = data_alignment
            # Prevent formula injection: values starting with formula characters
            # are marked as text-prefixed so Excel does not evaluate them.
            if isinstance(value, str) and value and value[0] in _FORMULA_CHARS:
                cell.quotePrefix = True
            cell.border = thin_border

            # Alternate row shading
            if row_idx % 2 == 0:
                cell.fill = alt_fill

    # Freeze the header row
    ws.freeze_panes = "A2"

    # Add autofilter
    if rows and columns:
        ws.auto_filter.ref = f"A1:{get_column_letter(len(columns))}{len(rows) + 1}"

    return wb
