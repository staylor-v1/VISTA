import asyncio
import copy
import uuid
import json
import hashlib
import mimetypes
import re
import base64
import os
import stat
import shutil
import sys
import tempfile
import threading
import time
import httpx
import numpy as np
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, List, Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, status
from fastapi.responses import FileResponse
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from core import models, schemas
from core.database import get_db
from core.group_auth_helper import is_user_in_group
from utils.dependencies import get_current_user, get_project_or_403_writable
import utils.crud as crud
from core.config import settings
from core.project_types import DEFAULT_PROJECT_TYPE, normalize_project_type
from utils.boto3_client import get_presigned_download_url, upload_file_to_s3
from utils.cache_manager import get_cache
from utils.volume_loader import (
    REFERENCE_VOLUME_READ_LIMITS,
    load_slice_stack,
    load_volume,
)
from utils.gaussian_splat_converter import (
    SplatConversionParams,
    TransferFunction,
    convert_volume_to_splat_asset,
)
from utils.real_gaussian_splat_optimizer import (
    RealGaussianSplatOptimizationError,
    optimize_real_gaussian_splat_asset,
)
from utils.pt3_test_fixtures import (
    DEFAULT_PT3_FIXTURE_ID,
    NIST_COCR_FIXTURE_ID,
    get_pt3_test_fixture,
    resolve_pt3_test_fixture_file,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.append(str(REPO_ROOT))

from backend.analyze_toolbox import WorkflowGraph, WorkflowImageInput, execute_image_workflow
from backend.metadata.nsipro_fields import (
    NsiproField,
    NsiproFieldError,
    NsiproFieldLimitError,
    NsiproMetadataSource,
    collect_active_nsipro_source_refs,
    collect_indexable_nsipro_sources,
    flatten_nsipro_metadata,
)
from backend.metadata.nsipro_parsers import get_nsipro_parser, parse_nsipro_text


router = APIRouter(tags=["Inspection Workbench"])

WORKSPACE_STATE_KEY_PREFIX = "inspection_workbench.workspace_state"
PROJECT_CONFIGURATION_KEY = "inspection_workbench.project_configuration"
PROJECT_TYPE_INTERFACE_LAYOUT_KEY_PREFIX = "inspection_workbench.project_type_interface_layout_default"
ANNOTATIONS_METADATA_KEY = "annotations"
MAX_NSIPRO_FIELD_ROWS_PER_PART = 20_000
MAX_NSIPRO_FIELD_ROWS_PER_INGEST = 1_000_000
WORKSPACE_PANEL_LAYOUT_DEFAULTS = {
    "part_list": {
        "is_open": True,
        "width_px": 320,
        "height_px": 420,
        "orientation": "vertical",
    },
    "inspector": {
        "is_open": True,
        "width_px": 360,
        "height_px": 420,
        "orientation": "vertical",
    },
    "mpr_controls": {
        "is_open": True,
        "width_px": 360,
        "height_px": 360,
        "orientation": "vertical",
    },
}
WORKSPACE_INSPECTOR_DEFAULTS = {
    "shortcut_help_visible": False,
    "normalization_triage_field": "",
    "image_enabled": True,
    "modalities": [],
    "view_name": "",
    "viewport_transform": {"zoom": 1.0, "panX": 0, "panY": 0},
    "measurements": [],
}
TEST_DATA_ROOT = Path(__file__).resolve().parents[2] / "test" / "data"
PT3_TEST_STACK_ROOT = TEST_DATA_ROOT / "3D" / "geometric"
TEST_DATA_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".txt"}
FALLBACK_HIERARCHY_KEYS = [
    "design_number",
    "lot_number",
    "set_number",
    "serial_number",
    "side",
    "modality",
    "overlay",
]
SLICE_SEGMENTATION_METHOD_IDS = {
    "segmentation.yolo.placeholder",
    "segmentation.anomalib.placeholder",
    "segmentation.sam.placeholder",
    "segmentation.opencv.placeholder",
}
PT3_REAL_3DGS_MATERIALIZATION_LIMIT_BYTES = int(2.5 * 1024 * 1024 * 1024)
PT3_MAX_MATERIALIZED_FILE_BYTES = PT3_REAL_3DGS_MATERIALIZATION_LIMIT_BYTES
PT3_MAX_MATERIALIZED_STACK_BYTES = PT3_REAL_3DGS_MATERIALIZATION_LIMIT_BYTES
PT3_DOWNLOAD_CHUNK_BYTES = 64 * 1024
PT3_REAL_SPLAT_PROGRESS_TIMEOUT_SECONDS = 15.0
# Both bundled splat fitters are CPU- and memory-intensive. Keep one PT3 splat
# compute in flight per backend worker; deployments can scale workers
# deliberately instead of allowing an unbounded request burst in one process.
_PT3_SPLAT_COMPUTE_SEMAPHORE = threading.BoundedSemaphore(value=1)
# Backward-compatible alias retained for focused Real 3DGS tests and callers.
_PT3_REAL_SPLAT_COMPUTE_SEMAPHORE = _PT3_SPLAT_COMPUTE_SEMAPHORE


class _PT3RealSplatJobSuperseded(RuntimeError):
    """Internal cancellation signal for a Real 3DGS job that lost ownership."""


async def _acquire_pt3_splat_compute_slot() -> None:
    """Acquire the process-local compute slot without blocking an event loop."""

    while not _PT3_SPLAT_COMPUTE_SEMAPHORE.acquire(blocking=False):
        await asyncio.sleep(0.05)


async def _acquire_pt3_real_splat_compute_slot() -> None:
    """Compatibility wrapper for the shared PT3 compute slot."""

    await _acquire_pt3_splat_compute_slot()
PT3_SIMPLIFIED_SPLAT_EXTENSIONS = {".json", ".ply", ".splat"}
PT3_CACHE_NAMESPACES = (
    "pt3_volume_stacks",
    "pt3_splat_assets",
    "pt3_real_splat_assets",
)


class _PT3CacheUnavailableError(RuntimeError):
    """Raised when neither configured nor temporary PT3 cache is writable."""


def _prepare_pt3_cache_root(root: Path) -> Path:
    """Create and verify every namespace used by PT3 fitting jobs."""

    if root.is_symlink():
        raise OSError("PT3 cache root must not be a symbolic link")
    root = root.resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)

    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    directory_flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    root_fd = os.open(root, directory_flags)
    try:
        root_stat = os.fstat(root_fd)
        if not stat.S_ISDIR(root_stat.st_mode) or root_stat.st_uid != os.geteuid():
            raise OSError("PT3 cache root must be a directory owned by the service user")
        os.fchmod(root_fd, 0o700)

        for namespace in PT3_CACHE_NAMESPACES:
            try:
                os.mkdir(namespace, mode=0o700, dir_fd=root_fd)
            except FileExistsError:
                pass
            namespace_fd = os.open(namespace, directory_flags, dir_fd=root_fd)
            try:
                namespace_stat = os.fstat(namespace_fd)
                if (
                    not stat.S_ISDIR(namespace_stat.st_mode)
                    or namespace_stat.st_uid != os.geteuid()
                ):
                    raise OSError(
                        "PT3 cache namespaces must be directories owned by the service user"
                    )
                os.fchmod(namespace_fd, 0o700)

                # Use an exclusive, no-follow probe relative to the already-open
                # namespace. Concurrent callers cannot collide or redirect it.
                probe_name = f".pt3-write-probe-{uuid.uuid4().hex}"
                probe_flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                probe_flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
                probe_fd = os.open(
                    probe_name,
                    probe_flags,
                    0o600,
                    dir_fd=namespace_fd,
                )
                os.close(probe_fd)
                os.unlink(probe_name, dir_fd=namespace_fd)
            finally:
                os.close(namespace_fd)
    finally:
        os.close(root_fd)
    return root


def _prepare_pt3_cache_candidate(candidate: Path) -> Path:
    """Resolve one cache candidate without accepting a link at its root."""

    if candidate.is_symlink():
        raise OSError("PT3 cache root must not be a symbolic link")
    return _prepare_pt3_cache_root(candidate.resolve())


def _pt3_cache_root() -> Path:
    """Return a cache whose concrete PT3 namespaces are all writable."""
    configured = os.getenv("CACHE_DIR", "").strip()
    root = Path(configured).expanduser() if configured else REPO_ROOT / ".cache"
    if not root.is_absolute():
        root = REPO_ROOT / root
    try:
        return _prepare_pt3_cache_candidate(root)
    except (OSError, RuntimeError):
        fallback = Path(tempfile.gettempdir()) / f"vista-pt3-cache-{os.getuid()}"
        try:
            return _prepare_pt3_cache_candidate(fallback)
        except (OSError, RuntimeError) as fallback_error:
            raise _PT3CacheUnavailableError(
                "PT3 fitting cache is unavailable because its job directories are not writable"
            ) from fallback_error


def _pt3_cache_component(value: object) -> str:
    """Return one safe cache path component without accepting traversal."""

    component = str(value).strip()
    separators = {os.sep}
    if os.altsep:
        separators.add(os.altsep)
    if (
        not component
        or component in {".", ".."}
        or "\x00" in component
        or any(separator in component for separator in separators)
    ):
        raise OSError("PT3 cache path contains an invalid component")
    return component


def _pt3_cache_directory(
    namespace: str,
    *components: object,
    create: bool,
    repair_mode: bool,
) -> Path:
    """Open a cache descendant one component at a time without following links.

    Persistent cache volumes can contain directories created by an older root
    process. Privileged startup repairs their ownership and mode; this runtime
    check also repairs service-owned read-only directories and refuses any
    symbolic-link or foreign-owned descendant before returning a path.
    """

    if namespace not in PT3_CACHE_NAMESPACES:
        raise OSError("Unknown PT3 cache namespace")
    safe_components = [_pt3_cache_component(value) for value in components]
    root = _pt3_cache_root()
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    directory_flags |= getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    root_fd = os.open(root, directory_flags)
    current_fd: Optional[int] = None
    try:
        current_fd = os.open(namespace, directory_flags, dir_fd=root_fd)
        current_path = root / namespace
        for component in safe_components:
            if create:
                try:
                    os.mkdir(component, mode=0o700, dir_fd=current_fd)
                except FileExistsError:
                    pass
            child_fd = os.open(component, directory_flags, dir_fd=current_fd)
            try:
                child_stat = os.fstat(child_fd)
                if (
                    not stat.S_ISDIR(child_stat.st_mode)
                    or child_stat.st_uid != os.geteuid()
                ):
                    raise OSError(
                        "PT3 cache descendants must be directories owned by the service user"
                    )
                if repair_mode:
                    os.fchmod(child_fd, 0o700)
            except Exception:
                os.close(child_fd)
                raise
            os.close(current_fd)
            current_fd = child_fd
            current_path = current_path / component
        return current_path
    finally:
        if current_fd is not None:
            os.close(current_fd)
        os.close(root_fd)


def _prepare_pt3_cache_directory(namespace: str, *components: object) -> Path:
    return _pt3_cache_directory(
        namespace,
        *components,
        create=True,
        repair_mode=True,
    )


def _existing_pt3_cache_directory(namespace: str, *components: object) -> Path:
    return _pt3_cache_directory(
        namespace,
        *components,
        create=False,
        repair_mode=False,
    )


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


def _part_image_display_identities(metadata: dict) -> tuple[list[str], set[str], dict[str, set[str]]]:
    """Return natural display order plus the aliases accepted by its API."""

    display_records: list[dict[str, str]] = []
    backing_records: list[dict[str, object]] = []
    for collection_key in ("source_images", "analysis_outputs"):
        records = metadata.get(collection_key)
        if not isinstance(records, list):
            continue
        for record in records:
            if not isinstance(record, dict):
                continue
            image_id = str(record.get("image_id") or "").strip()
            filename = str(record.get("filename") or "").strip()
            if image_id or filename:
                backing_records.append(
                    {
                        "image_id": image_id,
                        "filename": filename,
                        "delete_candidate": bool(
                            record.get("overlay_delete_candidate")
                            or record.get("delete_candidate")
                        ),
                    }
                )

    view_images = metadata.get("view_images")
    if isinstance(view_images, dict):
        for image_ref in view_images.values():
            if isinstance(image_ref, dict):
                image_id = str(image_ref.get("image_id") or "").strip()
                filename = str(image_ref.get("filename") or "").strip()
            else:
                image_id = ""
                filename = str(image_ref or "").strip()
            if not image_id and not filename:
                continue
            matching_backing_records = [
                record
                for record in backing_records
                if (
                    record["image_id"] == image_id
                    if image_id
                    else bool(filename and record["filename"] == filename)
                )
            ]
            if (
                matching_backing_records
                and all(record["delete_candidate"] for record in matching_backing_records)
            ):
                continue
            display_records.append({"image_id": image_id, "filename": filename})

    for record in backing_records:
        if record["delete_candidate"]:
            continue
        display_records.append(
            {
                "image_id": str(record["image_id"]),
                "filename": str(record["filename"]),
            }
        )

    image_ids = {
        record["image_id"]
        for record in display_records
        if record["image_id"]
    }
    filename_to_ids: dict[str, set[str]] = {}
    for record in display_records:
        if record["filename"] and record["image_id"]:
            filename_to_ids.setdefault(record["filename"], set()).add(record["image_id"])

    natural_order: list[str] = []
    seen_identities: set[str] = set()
    filename_aliases: dict[str, set[str]] = {}
    for record in display_records:
        image_id = record["image_id"]
        filename = record["filename"]
        candidate_ids = filename_to_ids.get(filename, set()) if filename else set()
        if image_id:
            canonical_ref = image_id
        elif len(candidate_ids) == 1:
            canonical_ref = next(iter(candidate_ids))
        elif len(candidate_ids) > 1:
            # A filename shared by multiple IDs cannot identify another image.
            # The concrete ID records are added when their collections are read.
            continue
        else:
            canonical_ref = filename
        if not canonical_ref:
            continue
        if canonical_ref not in seen_identities:
            natural_order.append(canonical_ref)
            seen_identities.add(canonical_ref)
        if filename:
            filename_aliases.setdefault(filename, set()).add(canonical_ref)

    # Preserve the full ID ambiguity of a shared filename even if one record was
    # de-duplicated earlier in natural-order construction.
    for filename, candidate_ids in filename_to_ids.items():
        filename_aliases.setdefault(filename, set()).update(candidate_ids)
    return natural_order, image_ids, filename_aliases


INSPECTION_MAX_ANNOTATIONS_PER_PART = 2_048
INSPECTION_MAX_VISTA_SEGMENTS_PER_PART = 64
INSPECTION_MAX_ANNOTATIONS_JSON_BYTES = 32 * 1024 * 1024


async def _get_locked_inspection_part(
    *,
    db: AsyncSession,
    project_id: uuid.UUID,
    part_id: uuid.UUID,
):
    return await crud.get_inspection_part_for_update(
        db=db,
        project_id=project_id,
        part_id=part_id,
    )


def _validate_annotation_collection_limits(annotations: list[dict]) -> None:
    if len(annotations) > INSPECTION_MAX_ANNOTATIONS_PER_PART:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                "A part may contain at most "
                f"{INSPECTION_MAX_ANNOTATIONS_PER_PART} annotations"
            ),
        )
    if any(not isinstance(annotation, dict) for annotation in annotations):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Part annotations must contain only JSON objects",
        )
    vista_segment_count = sum(
        1
        for annotation in annotations
        if (
            annotation.get("annotation_kind") == "vista_segment"
            or (
                isinstance(annotation.get("geometry"), dict)
                and "segment" in annotation["geometry"]
            )
        )
    )
    if vista_segment_count > INSPECTION_MAX_VISTA_SEGMENTS_PER_PART:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                "A part may contain at most "
                f"{INSPECTION_MAX_VISTA_SEGMENTS_PER_PART} VISTA segment annotations"
            ),
        )
    try:
        serialized_size = len(
            json.dumps(annotations, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
        )
    except (TypeError, ValueError, OverflowError, RecursionError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="Annotations must contain JSON-compatible finite values",
        ) from exc
    if serialized_size > INSPECTION_MAX_ANNOTATIONS_JSON_BYTES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                "Part annotations must contain at most "
                f"{INSPECTION_MAX_ANNOTATIONS_JSON_BYTES} serialized bytes"
            ),
        )


def _normalize_panel_dimension(value: object, *, fallback: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, min(maximum, parsed))


def _normalize_workspace_state(raw_state: object) -> dict:
    safe_state = raw_state.copy() if isinstance(raw_state, dict) else {}
    raw_layout = safe_state.get("panel_layout")
    normalized_layout = {}
    for panel_key, defaults in WORKSPACE_PANEL_LAYOUT_DEFAULTS.items():
        candidate = raw_layout.get(panel_key) if isinstance(raw_layout, dict) else {}
        if not isinstance(candidate, dict):
            candidate = {}
        orientation = str(candidate.get("orientation", defaults["orientation"])).lower()
        if orientation not in {"vertical", "horizontal"}:
            orientation = defaults["orientation"]
        normalized_layout[panel_key] = {
            "is_open": bool(candidate.get("is_open", defaults["is_open"])),
            "width_px": _normalize_panel_dimension(
                candidate.get("width_px"),
                fallback=defaults["width_px"],
                minimum=220,
                maximum=1200,
            ),
            "height_px": _normalize_panel_dimension(
                candidate.get("height_px"),
                fallback=defaults["height_px"],
                minimum=220,
                maximum=1400,
            ),
            "orientation": orientation,
        }
    safe_state["panel_layout"] = normalized_layout

    raw_inspector = safe_state.get("inspector")
    inspector_candidate = raw_inspector if isinstance(raw_inspector, dict) else {}
    shortcut_help_visible = inspector_candidate.get("shortcut_help_visible")
    normalized_shortcut_help_visible = (
        shortcut_help_visible
        if isinstance(shortcut_help_visible, bool)
        else WORKSPACE_INSPECTOR_DEFAULTS["shortcut_help_visible"]
    )
    normalization_triage_field = inspector_candidate.get("normalization_triage_field")
    normalized_triage_field = (
        str(normalization_triage_field).strip()
        if isinstance(normalization_triage_field, str)
        else WORKSPACE_INSPECTOR_DEFAULTS["normalization_triage_field"]
    )
    image_enabled = inspector_candidate.get("image_enabled")
    normalized_image_enabled = (
        image_enabled
        if isinstance(image_enabled, bool)
        else WORKSPACE_INSPECTOR_DEFAULTS["image_enabled"]
    )
    modalities = inspector_candidate.get("modalities")
    normalized_modalities = (
        [str(value) for value in modalities]
        if isinstance(modalities, list)
        else list(WORKSPACE_INSPECTOR_DEFAULTS["modalities"])
    )
    view_name = inspector_candidate.get("view_name")
    normalized_view_name = (
        str(view_name).strip()
        if isinstance(view_name, str)
        else WORKSPACE_INSPECTOR_DEFAULTS["view_name"]
    )
    viewport_transform = inspector_candidate.get("viewport_transform")
    viewport_candidate = viewport_transform if isinstance(viewport_transform, dict) else {}
    default_viewport = WORKSPACE_INSPECTOR_DEFAULTS["viewport_transform"]
    normalized_viewport_transform = {
        "zoom": max(
            0.5,
            min(
                4.0,
                float(viewport_candidate.get("zoom", default_viewport["zoom"]))
                if isinstance(viewport_candidate.get("zoom", default_viewport["zoom"]), (int, float))
                else float(default_viewport["zoom"]),
            ),
        ),
        "panX": _normalize_panel_dimension(
            viewport_candidate.get("panX"),
            fallback=default_viewport["panX"],
            minimum=-200,
            maximum=200,
        ),
        "panY": _normalize_panel_dimension(
            viewport_candidate.get("panY"),
            fallback=default_viewport["panY"],
            minimum=-200,
            maximum=200,
        ),
    }
    measurements = inspector_candidate.get("measurements")
    normalized_measurements = []
    if isinstance(measurements, list):
        for entry in measurements:
            if not isinstance(entry, dict):
                continue
            label_raw = entry.get("label")
            value_raw = entry.get("value")
            label = str(label_raw).strip() if isinstance(label_raw, str) else ""
            if isinstance(value_raw, (int, float)):
                value = str(value_raw)
            elif isinstance(value_raw, str):
                value = value_raw.strip()
            else:
                value = ""
            if not label or not value:
                continue
            measurement_id = str(entry.get("id") or "").strip()
            normalized_measurements.append({
                "id": measurement_id,
                "label": label,
                "value": value,
            })
    safe_state["inspector"] = {
        **inspector_candidate,
        "shortcut_help_visible": normalized_shortcut_help_visible,
        "normalization_triage_field": normalized_triage_field,
        "image_enabled": normalized_image_enabled,
        "modalities": normalized_modalities,
        "view_name": normalized_view_name,
        "viewport_transform": normalized_viewport_transform,
        "measurements": normalized_measurements,
    }
    return safe_state


DEFAULT_DEFECT_TYPE_COLORS = ("#ef4444", "#f59e0b", "#3b82f6")


def _normalize_project_type(project_type: Optional[str]) -> str:
    return normalize_project_type(project_type)


def _default_defect_types(project_type: Optional[str]) -> List[dict]:
    project_type_suffix = _normalize_project_type(project_type)
    return [
        {
            "name": f"DefectType{index + 1}_{project_type_suffix}",
            "color": color,
            "definition": "",
        }
        for index, color in enumerate(DEFAULT_DEFECT_TYPE_COLORS)
    ]


def _default_project_configuration(project_type: Optional[str] = DEFAULT_PROJECT_TYPE) -> dict:
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
        "defect_types": _default_defect_types(project_type),
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
            "pt3_3d_guides": {
                "crosshair_transparency_percent": 50,
                "crosshair_line_width_px": 1.25,
                "plane_outline_transparency_percent": 0,
                "plane_outline_line_width_px": 1.25,
            },
        },
        "phase_settings": {
            "manual_phase_selection_enabled": False,
            "manual_phase": "data_ingestion",
        },
        "metadata_parsers": {
            "nsipro": {
                "parser_id": "default",
            },
        },
        "project_owner": {
            "name": "",
            "email": "",
        },
        "current_user": {
            "username": "",
            "sso_authenticated": False,
        },
        "interface_layout": {
            "default_model": None,
        },
        "file_naming_scheme": {
            "use_filename_convention": True,
            "hierarchy_levels": [
                {"id": "drawing_number", "label": "Drawing Number", "abbreviation": "D"},
                {"id": "part_number", "label": "Part Number", "abbreviation": "P"},
                {"id": "lot_number", "label": "Lot Number", "abbreviation": "L"},
                {"id": "serial_number", "label": "Serial Number", "abbreviation": "S"},
                {"id": "revision", "label": "Revision", "abbreviation": "R"},
            ],
            "image_descriptors": [
                {"id": "view", "label": "View", "abbreviation": "V"},
                {"id": "modality", "label": "Modality", "abbreviation": "M"},
            ],
        },
    }


def _decode_slice_image_payload(value: str) -> bytes:
    encoded = str(value or "").strip()
    if "," in encoded and encoded.lower().startswith("data:"):
        encoded = encoded.split(",", 1)[1]
    try:
        return base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid slice image payload") from exc


def _slice_segmentation_workflow(method_id: str, parameters: dict):
    return WorkflowGraph(
        name=f"Inspection slice segmentation {method_id}",
        source={"kind": "manual_selection", "image_count": 1, "part_count": 1},
        output={"mode": "metadata_only", "artifact_policy": "metadata_only"},
        nodes=[
            {"id": "input", "method_id": "source.project_part_images"},
            {"id": "segment", "method_id": method_id, "parameters": parameters or {}},
        ],
        edges=[
            {"source_node": "input", "target_node": "segment"},
        ],
    )


def _normalize_segment_region(entry: object, index: int) -> Optional[dict]:
    if not isinstance(entry, dict):
        return None
    bbox = entry.get("bbox")
    if not isinstance(bbox, list) or len(bbox) < 4:
        detection_bbox = entry.get("bbox") if isinstance(entry.get("bbox"), dict) else None
        if detection_bbox:
            x = float(detection_bbox.get("x", 0) or 0)
            y = float(detection_bbox.get("y", 0) or 0)
            width = float(detection_bbox.get("width", 0) or 0)
            height = float(detection_bbox.get("height", 0) or 0)
            bbox = [x, y, x + width, y + height]
    if not isinstance(bbox, list) or len(bbox) < 4:
        return None
    try:
        x1, y1, x2, y2 = [float(value) for value in bbox[:4]]
    except (TypeError, ValueError):
        return None
    if x2 <= x1 or y2 <= y1:
        return None
    raw_centroid = entry.get("centroid")
    centroid = None
    if isinstance(raw_centroid, list) and len(raw_centroid) >= 2:
        try:
            centroid = [float(raw_centroid[0]), float(raw_centroid[1])]
        except (TypeError, ValueError):
            centroid = None
    raw_label = entry.get("label", index + 1)
    try:
        label = int(raw_label)
    except (TypeError, ValueError):
        label = index + 1
    area = entry.get("area_px", (x2 - x1) * (y2 - y1))
    try:
        area_px = float(area)
    except (TypeError, ValueError):
        area_px = float((x2 - x1) * (y2 - y1))
    confidence = entry.get("confidence")
    try:
        confidence_value = float(confidence) if confidence is not None else None
    except (TypeError, ValueError):
        confidence_value = None
    return {
        "label": label,
        "area_px": area_px,
        "bbox": [x1, y1, x2, y2],
        "centroid": centroid,
        "confidence": confidence_value,
        "class_name": str(entry.get("class_name")) if entry.get("class_name") is not None else None,
    }


def _regions_from_toolbox_result(result) -> List[dict]:
    regions: List[dict] = []
    for node_result in result.node_results:
        summary = node_result.summary if isinstance(node_result.summary, dict) else {}
        for key in ("measurements", "detections"):
            values = summary.get(key)
            if not isinstance(values, list):
                continue
            for entry in values:
                region = _normalize_segment_region(entry, len(regions))
                if region:
                    regions.append(region)
    deduped = {}
    for region in regions:
        key = tuple(round(value, 3) for value in region["bbox"])
        deduped[key] = region
    return list(deduped.values())


def _select_clicked_region(regions: List[dict], click_x: float, click_y: float) -> Optional[dict]:
    containing = []
    for region in regions:
        x1, y1, x2, y2 = region["bbox"]
        if x1 <= click_x <= x2 and y1 <= click_y <= y2:
            containing.append(region)
    if not containing:
        return None
    return min(containing, key=lambda region: region.get("area_px") or float("inf"))


def _prune_config_to_source_shape(*, persisted_config: dict, source_config: dict) -> dict:
    """Trim optional top-level config keys that were absent in source payloads."""
    if not isinstance(persisted_config, dict):
        return {}
    if not isinstance(source_config, dict):
        return persisted_config
    pruned = dict(persisted_config)
    for optional_key in ("phase_settings", "metadata_parsers", "project_owner", "current_user", "interface_layout"):
        if optional_key not in source_config:
            pruned.pop(optional_key, None)
    return pruned



def _dump_project_configuration_payload(config: schemas.InspectionProjectConfiguration) -> dict:
    dumped = config.model_dump(exclude_unset=True)
    metadata_parsers = dumped.get("metadata_parsers")
    nsipro_dump = metadata_parsers.get("nsipro") if isinstance(metadata_parsers, dict) else None
    nsipro_config = getattr(getattr(config, "metadata_parsers", None), "nsipro", None)
    fields_set = getattr(nsipro_config, "model_fields_set", set())
    if isinstance(nsipro_dump, dict):
        for optional_key, default_value in (
            ("parser_version", None),
            ("parser_hash", None),
            ("strict_version_match", False),
        ):
            if optional_key not in fields_set and nsipro_dump.get(optional_key) == default_value:
                nsipro_dump.pop(optional_key, None)
    return dumped

def _strip_optional_default_sections(config: dict) -> dict:
    if not isinstance(config, dict):
        return {}
    pruned = dict(config)
    if pruned.get("phase_settings") == {
        "manual_phase_selection_enabled": False,
        "manual_phase": "data_ingestion",
    }:
        pruned.pop("phase_settings", None)
    if pruned.get("metadata_parsers") == {"nsipro": {"parser_id": "default"}}:
        pruned.pop("metadata_parsers", None)
    if pruned.get("project_owner") == {"name": "", "email": ""}:
        pruned.pop("project_owner", None)
    if pruned.get("current_user") == {"username": "", "sso_authenticated": False}:
        pruned.pop("current_user", None)
    if pruned.get("interface_layout") == {"default_model": None}:
        pruned.pop("interface_layout", None)
    return pruned


def _project_type_interface_layout_metadata_key(project_type: str) -> str:
    return f"{PROJECT_TYPE_INTERFACE_LAYOUT_KEY_PREFIX}:{project_type}"



def _load_nsipro_metadata_fixture(root: Path) -> Optional[dict]:
    nsipro_files = sorted(root.glob("*.nsipro"))
    if not nsipro_files:
        return None
    nsipro_path = nsipro_files[0]
    return parse_nsipro_text(nsipro_path.read_text(encoding="utf-8"), nsipro_path.name)

def _metadata_from_hierarchy_filename(path: Path) -> Optional[dict]:
    tokens = path.stem.split("_")
    if len(tokens) != 7:
        return None
    design_number, lot_number, part_set_or_batch, serial_number, side, modality, overlay = tokens
    metadata = {
        "design_number": design_number,
        "lot_number": lot_number,
        "serial_number": serial_number,
        "side": side.lower(),
        "modality": modality.lower(),
        "overlay": overlay.lower() in {"true", "1", "yes"},
        "source": "vista-test-data",
    }
    if part_set_or_batch.upper().startswith("BATCH"):
        metadata["batch_number"] = part_set_or_batch
    else:
        metadata["set_number"] = part_set_or_batch
    return metadata




def _coerce_filename_metadata(metadata: dict) -> dict:
    coerced = dict(metadata)
    for key in ("side", "modality"):
        if key in coerced and coerced[key] is not None:
            coerced[key] = str(coerced[key]).strip().lower()
    if "overlay" in coerced:
        coerced["overlay"] = str(coerced["overlay"]).strip().lower() in {"true", "1", "yes", "overlay", "ov", "mask", "heatmap"}
    part_set_or_batch = coerced.pop("part_set_or_batch", None)
    if part_set_or_batch and not (coerced.get("set_number") or coerced.get("batch_number")):
        part_set_or_batch = str(part_set_or_batch).strip()
        if part_set_or_batch.upper().startswith("BATCH"):
            coerced["batch_number"] = part_set_or_batch
        else:
            coerced["set_number"] = part_set_or_batch
    coerced.setdefault("source", "vista-test-data")
    return coerced


def _metadata_from_regex_file(path: Path, regex_path: Path) -> Optional[dict]:
    pattern = regex_path.read_text(encoding="utf-8").strip()
    if not pattern:
        return None
    match = re.search(pattern, path.stem)
    if not match:
        return None
    if match.groupdict():
        metadata = {key: value for key, value in match.groupdict().items() if value is not None}
    else:
        metadata = {key: value for key, value in zip(FALLBACK_HIERARCHY_KEYS, match.groups())}
    return _coerce_filename_metadata(metadata)


def _nearest_regex_file(path: Path, root: Path) -> Optional[Path]:
    current = path.parent
    root = root.resolve()
    while True:
        candidate = current / "regex.txt"
        if candidate.exists() and candidate.is_file():
            return candidate
        if current.resolve() == root:
            return None
        current = current.parent


def _metadata_from_test_data_file(path: Path, root: Path) -> Optional[dict]:
    regex_path = _nearest_regex_file(path, root)
    if regex_path:
        return _metadata_from_regex_file(path, regex_path)
    return _metadata_from_hierarchy_filename(path)

def _build_hierarchy_ingest_records(uploaded_records: List[dict]) -> schemas.InspectionBulkIngestPayload:
    parts_by_key: dict[str, dict] = {}
    for record in uploaded_records:
        metadata = record.get("metadata") or {}
        part_set_number = metadata.get("set_number")
        batch_number = metadata.get("batch_number")
        required = ["design_number", "lot_number", "serial_number", "side", "modality"]
        if any(not metadata.get(key) for key in required):
            continue
        if not (part_set_number or batch_number):
            continue
        part_group_number = part_set_number or batch_number
        part_key = "_".join([
            metadata["design_number"],
            metadata["lot_number"],
            part_group_number,
            metadata["serial_number"],
        ])
        batch_name = "_".join([metadata["design_number"], metadata["lot_number"], batch_number]) if batch_number else None
        part = parts_by_key.setdefault(
            part_key,
            {
                "batch_name": batch_name,
                "batch_description": (
                    f"Design {metadata['design_number']}, lot {metadata['lot_number']}, "
                    f"batch {batch_number}"
                ) if batch_number else None,
                "serial_number": metadata["serial_number"],
                "display_name": " ".join([
                    metadata["design_number"],
                    metadata["lot_number"],
                    part_group_number,
                    metadata["serial_number"],
                ]),
                "metadata": {
                    "design_number": metadata["design_number"],
                    "lot_number": metadata["lot_number"],
                    "serial_number": metadata["serial_number"],
                    "configured_views": [],
                    "modalities": [],
                    "view_images": {},
                    "overlay_images": {},
                    "source_images": [],
                    "source": "vista-test-data",
                },
            },
        )
        if part_set_number:
            part["metadata"]["set_number"] = part_set_number
        if batch_number:
            part["metadata"]["batch_number"] = batch_number
        side = metadata["side"]
        modality = metadata["modality"]
        if side not in part["metadata"]["configured_views"]:
            part["metadata"]["configured_views"].append(side)
        if modality not in part["metadata"]["modalities"]:
            part["metadata"]["modalities"].append(modality)
        part["metadata"]["source_images"].append({
            "filename": record["filename"],
            "side": side,
            "modality": modality,
            "overlay": metadata["overlay"],
            "image_id": str(record["image_id"]),
        })
        if metadata["overlay"]:
            part["metadata"]["overlay_images"].setdefault(side, {})[modality] = record["filename"]
        elif side not in part["metadata"]["view_images"]:
            part["metadata"]["view_images"][side] = record["filename"]

    batches_by_name: dict[str, schemas.InspectionIngestBatchRecord] = {}
    unassigned_parts: list[schemas.InspectionIngestPartRecord] = []
    for part in parts_by_key.values():
        part["metadata"]["configured_views"].sort()
        part["metadata"]["modalities"].sort()
        ingest_part = schemas.InspectionIngestPartRecord(
            serial_number=part["serial_number"],
            display_name=part["display_name"],
            metadata=part["metadata"],
        )
        if part["batch_name"]:
            batch = batches_by_name.setdefault(
                part["batch_name"],
                schemas.InspectionIngestBatchRecord(
                    name=part["batch_name"],
                    description=part["batch_description"],
                    parts=[],
                ),
            )
            batch.parts.append(ingest_part)
        else:
            unassigned_parts.append(ingest_part)
    for batch in batches_by_name.values():
        batch.parts.sort(key=lambda item: item.serial_number)
    unassigned_parts.sort(key=lambda item: item.serial_number)
    return schemas.InspectionBulkIngestPayload(
        batches=list(batches_by_name.values()),
        unassigned_parts=unassigned_parts,
    )


def _rebuild_part_image_maps(metadata: dict) -> dict:
    source_images = metadata.get("source_images")
    if not isinstance(source_images, list):
        source_images = []
    configured_views: set[str] = set()
    modalities: set[str] = set()
    view_images: dict[str, str] = {}
    overlay_images: dict[str, dict[str, str]] = {}
    normalized_source_images: list[dict] = []

    for record in source_images:
        if not isinstance(record, dict):
            continue
        filename = str(record.get("filename") or "").strip()
        if not filename:
            continue
        side = str(record.get("side") or "").strip().lower()
        modality = str(record.get("modality") or "").strip().lower()
        overlay = bool(record.get("overlay"))
        normalized_record = {
            **record,
            "filename": filename,
            "side": side,
            "modality": modality,
            "overlay": overlay,
        }
        normalized_source_images.append(normalized_record)
        if side:
            configured_views.add(side)
        if modality:
            modalities.add(modality)
        if side and overlay and modality:
            overlay_images.setdefault(side, {})[modality] = filename
        elif side and not overlay and side not in view_images:
            view_images[side] = filename

    return {
        **metadata,
        "source_images": normalized_source_images,
        "configured_views": sorted(configured_views),
        "modalities": sorted(modalities),
        "view_images": view_images,
        "overlay_images": overlay_images,
    }


_PART_IMAGE_MAP_METADATA_KEYS = (
    "source_images",
    "configured_views",
    "modalities",
    "view_images",
    "overlay_images",
)


def _part_image_map_metadata_patch(metadata: dict) -> dict:
    """Return only fields derived from source_images for a locked metadata merge.

    Assignment routes discover source records from a project-wide snapshot. A
    concurrent annotation save can commit after that snapshot but before the
    assignment writes. Replaying the entire snapshot here would overwrite the
    fresh annotations (and any other unrelated metadata), even though the CRUD
    helper reloads the row under a lock. Keeping this patch key-scoped lets the
    locked merge retain the authoritative non-image fields.
    """

    normalized = _rebuild_part_image_maps(metadata)
    return {
        key: normalized[key]
        for key in _PART_IMAGE_MAP_METADATA_KEYS
    }


async def _mutate_part_source_images_locked(
    *,
    db: AsyncSession,
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    transform: Callable[[list], tuple[list, Any]],
    updated_by: str,
):
    """Transform source_images from the authoritative row-lock snapshot."""

    def mutate_metadata(metadata: dict) -> tuple[dict, Any]:
        source_images = metadata.get("source_images")
        current_source_images = list(source_images) if isinstance(source_images, list) else []
        transformed_source_images, mutation_result = transform(current_source_images)
        if transformed_source_images == current_source_images:
            return {}, mutation_result
        return (
            _part_image_map_metadata_patch(
                {**metadata, "source_images": transformed_source_images}
            ),
            mutation_result,
        )

    return await crud.mutate_inspection_part_metadata_locked(
        db=db,
        project_id=project_id,
        part_id=part_id,
        metadata_mutator=mutate_metadata,
        updated_by=updated_by,
    )


def _remove_source_image_records(
    source_images: list,
    *,
    filename: str,
    image_id: uuid.UUID | str | None,
    fallback_image_id: uuid.UUID | str | None = None,
) -> tuple[list, Optional[dict]]:
    retained = []
    removed_entry = None
    for record in source_images:
        if _record_matches_image_identity(record, filename=filename, image_id=image_id):
            removed_entry = {
                **record,
                "filename": str(record.get("filename") or filename).strip(),
                "image_id": record.get("image_id") or (
                    str(fallback_image_id) if fallback_image_id else None
                ),
            }
            continue
        retained.append(record)
    return retained, removed_entry


def _replace_source_image_record(
    source_images: list,
    *,
    entry: dict,
    filename: str,
    image_id: uuid.UUID | str | None,
) -> list:
    retained = [
        record
        for record in source_images
        if not _record_matches_image_identity(
            record,
            filename=filename,
            image_id=image_id,
        )
    ]
    return [*retained, dict(entry)]


_ASSIGNED_SOURCE_IMAGE_METADATA_FIELDS = (
    "load_mode",
    "tiff_dimensionality",
    "frame_count",
    "volume_shape",
    "pixel_dtype",
    "voxel_dtype",
    "bit_depth",
    "bits_per_sample",
    "pixel_value_range",
    "data_value_range",
    "voxel_value_range",
    "scalar_range",
    "value_range",
    "intensity_range",
    "display_range",
    "signed",
    "channel_count",
    "color_mode",
)


def _assigned_source_image_metadata(image_metadata: dict) -> dict:
    """Keep persisted volume/layout fields self-contained on part assignments."""

    copied = {
        key: image_metadata[key]
        for key in _ASSIGNED_SOURCE_IMAGE_METADATA_FIELDS
        if key in image_metadata
    }
    if not copied:
        return {}
    return {**copied, "metadata": dict(copied)}


def _metadata_for_overlay_assignment(image: models.DataInstance) -> dict:
    image_metadata = image.metadata_json if isinstance(image.metadata_json, dict) else {}
    return {
        "filename": image.filename,
        "image_id": str(image.id),
        "side": str(image_metadata.get("side") or "").strip().lower(),
        "modality": str(image_metadata.get("modality") or "overlay").strip().lower() or "overlay",
        "overlay": True,
        "content_type": image.content_type,
        "slice_axis": image_metadata.get("slice_axis"),
        "slice_index": image_metadata.get("slice_index"),
        **_assigned_source_image_metadata(image_metadata),
    }


_ASSIGNED_SOURCE_IMAGE_RECORD_FIELDS = (
    "filename",
    "image_id",
    "side",
    "modality",
    "overlay",
    "content_type",
    "slice_axis",
    "slice_index",
    *_ASSIGNED_SOURCE_IMAGE_METADATA_FIELDS,
)


def _metadata_for_source_assignment(image: models.DataInstance) -> dict:
    image_metadata = image.metadata_json if isinstance(image.metadata_json, dict) else {}
    entry = {
        "filename": image.filename,
        "image_id": str(image.id),
        "side": str(image_metadata.get("side") or "").strip().lower(),
        "modality": str(image_metadata.get("modality") or "").strip().lower(),
        "overlay": bool(image_metadata.get("overlay")),
        "content_type": image.content_type,
        "slice_axis": image_metadata.get("slice_axis"),
        "slice_index": image_metadata.get("slice_index"),
    }
    for metadata_key in (
        "crop_child_image",
        "parent_image_id",
        "parent_image_filename",
        "crop_annotation_id",
        "crop_title",
        "crop_subtitle",
        "crop_bbox",
    ):
        if metadata_key in image_metadata:
            entry[metadata_key] = image_metadata.get(metadata_key)
    entry.update(_assigned_source_image_metadata(image_metadata))
    return entry


def _refresh_assigned_source_image_record(existing: Optional[dict], authoritative: dict) -> dict:
    """Refresh file metadata while retaining assignment and visibility state."""

    refreshed = dict(existing) if isinstance(existing, dict) else {}
    for key in _ASSIGNED_SOURCE_IMAGE_RECORD_FIELDS:
        if key not in authoritative:
            refreshed.pop(key, None)
    refreshed.update(authoritative)

    existing_metadata = (
        existing.get("metadata")
        if isinstance(existing, dict) and isinstance(existing.get("metadata"), dict)
        else {}
    )
    authoritative_metadata = (
        authoritative.get("metadata")
        if isinstance(authoritative.get("metadata"), dict)
        else {}
    )
    merged_metadata = {
        key: value
        for key, value in existing_metadata.items()
        if key not in _ASSIGNED_SOURCE_IMAGE_METADATA_FIELDS
    }
    merged_metadata.update(authoritative_metadata)
    if merged_metadata:
        refreshed["metadata"] = merged_metadata
    else:
        refreshed.pop("metadata", None)
    return refreshed


def _record_matches_filename(record: object, filename: str) -> bool:
    return isinstance(record, dict) and str(record.get("filename") or "").strip() == filename


def _record_matches_image_identity(record: object, *, filename: str = "", image_id: uuid.UUID | str | None = None) -> bool:
    if not isinstance(record, dict):
        return False
    if image_id and str(record.get("image_id") or "").strip() == str(image_id):
        return True
    if image_id:
        return False
    return str(record.get("filename") or "").strip() == filename


async def _get_active_project_image_by_id(
    *,
    db: AsyncSession,
    project_id: uuid.UUID,
    image_id: uuid.UUID,
) -> models.DataInstance | None:
    result = await db.execute(
        select(models.DataInstance).where(
            models.DataInstance.project_id == project_id,
            models.DataInstance.id == image_id,
            models.DataInstance.deleted_at.is_(None),
        )
    )
    return result.scalars().first()


async def _get_active_project_image_by_filename(
    *,
    db: AsyncSession,
    project_id: uuid.UUID,
    filename: str,
) -> models.DataInstance | None:
    result = await db.execute(
        select(models.DataInstance).where(
            models.DataInstance.project_id == project_id,
            models.DataInstance.filename == filename,
            models.DataInstance.deleted_at.is_(None),
        )
    )
    return result.scalars().first()


NIST_FIXTURE_REUSE_FIELDS = (
    "source",
    "project_type",
    "builtin_fixture_id",
    "fixture_id",
    "builtin_fixture_filename",
    "fixture_role",
    "volume_stack_id",
    "volume_shape",
    "axis_labels",
    "load_mode",
    "frame_count",
    "voxel_dtype",
    "pixel_dtype",
    "bit_depth",
    "overlay",
    "modality",
    "overlay_base_filename",
    "overlay_base_image_id",
)


def _nist_fixture_reuse_conflicts(
    *,
    image: models.DataInstance,
    expected_metadata: dict,
    project_id: uuid.UUID,
    filename: str,
) -> list[str]:
    existing_metadata = image.metadata_json if isinstance(image.metadata_json, dict) else {}
    conflicts = [
        field
        for field in NIST_FIXTURE_REUSE_FIELDS
        if existing_metadata.get(field) != expected_metadata.get(field)
    ]
    if image.object_storage_key != f"{project_id}/test-data/{filename}":
        conflicts.append("object_storage_key")
    return conflicts


async def _create_test_image_if_missing(
    *,
    project_id: uuid.UUID,
    file_path: Path,
    metadata: dict,
    db: AsyncSession,
    current_user: schemas.User,
    allow_metadata_only: bool = False,
) -> tuple[models.DataInstance, bool]:
    existing = await db.execute(
        select(models.DataInstance).where(
            models.DataInstance.project_id == project_id,
            models.DataInstance.filename == file_path.name,
            models.DataInstance.deleted_at.is_(None),
        )
    )
    image = existing.scalars().first()
    if image:
        if metadata.get("builtin_fixture_id") == NIST_COCR_FIXTURE_ID:
            conflicts = _nist_fixture_reuse_conflicts(
                image=image,
                expected_metadata=metadata,
                project_id=project_id,
                filename=file_path.name,
            )
            if conflicts:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        f"Existing image conflicts with built-in NIST fixture {file_path.name}: "
                        f"{', '.join(conflicts)}"
                    ),
                )
        return image, False

    object_storage_key = f"{project_id}/test-data/{file_path.name}"
    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    try:
        with file_path.open("rb") as file_obj:
            uploaded = await upload_file_to_s3(
                bucket_name=settings.S3_BUCKET,
                object_name=object_storage_key,
                file_data=file_obj,
                length=file_path.stat().st_size,
                content_type=content_type,
            )
    except Exception as exc:
        if not allow_metadata_only:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to upload test data image",
            ) from exc
        uploaded = False
    if not uploaded:
        if allow_metadata_only:
            metadata = {
                **metadata,
                "storage_status": "metadata_only",
                "storage_warning": "Test data image object could not be uploaded.",
            }
        else:
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to upload test data image")

    image = await crud.create_data_instance(
        db=db,
        data_instance=schemas.DataInstanceCreate(
            project_id=project_id,
            filename=file_path.name,
            object_storage_key=object_storage_key,
            content_type=content_type,
            size_bytes=file_path.stat().st_size,
            metadata=metadata,
            uploaded_by_user_id=current_user.email,
        ),
        created_by=current_user.email,
    )
    return image, True


def _validated_nist_fixture_shape(raw_spec, overlay_spec) -> tuple[int, int, int]:
    """Read only NPY headers and reject a malformed or misaligned fixture pair."""

    headers: list[tuple[tuple[int, ...], np.dtype]] = []
    for file_spec in (raw_spec, overlay_spec):
        try:
            volume = np.load(file_spec.path, mmap_mode="r", allow_pickle=False)
            shape = tuple(int(value) for value in volume.shape)
            dtype = np.dtype(volume.dtype)
            del volume
        except (OSError, ValueError, TypeError) as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Invalid NIST CoCr fixture NPY header: {file_spec.filename}",
            ) from exc
        expected_dtype = np.dtype(file_spec.dtype)
        if len(shape) != 3 or dtype != expected_dtype:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=(
                    f"Invalid NIST CoCr fixture header for {file_spec.filename}: "
                    f"expected a 3D {expected_dtype.name} array"
                ),
            )
        headers.append((shape, dtype))

    if headers[0][0] != headers[1][0]:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="NIST CoCr raw and segmentation fixture volumes are not aligned",
        )
    return headers[0][0]



def _dict_or_empty(candidate: object) -> dict:
    return candidate if isinstance(candidate, dict) else {}


def _metadata_field_values_for_sources(
    sources: list[NsiproMetadataSource],
    *,
    field_cache: dict[tuple[str, str], list[NsiproField]],
) -> list[dict]:
    """Build ORM-ready values while flattening shared source payloads once."""

    values: list[dict] = []
    for source in sources:
        if len(source.source_ref) > 255:
            raise NsiproFieldLimitError(
                ".nsipro metadata source reference exceeds the 255-character limit"
            )
        if source.source_filename and len(source.source_filename) > 1024:
            raise NsiproFieldLimitError(
                ".nsipro metadata source filename exceeds the 1024-character limit"
            )

        try:
            serialized_metadata = json.dumps(
                source.metadata,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            )
            metadata_fingerprint = hashlib.sha256(
                serialized_metadata.encode("utf-8")
            ).hexdigest()
        except (TypeError, ValueError, OverflowError, RecursionError):
            # Let the flattener produce the domain-specific validation error.
            # Invalid trees are not shared through the cache.
            metadata_fingerprint = f"invalid:{id(source.metadata)}"

        cache_key = (source.source_ref, metadata_fingerprint)
        fields = field_cache.get(cache_key)
        if fields is None:
            fields = flatten_nsipro_metadata(source.metadata)
            field_cache[cache_key] = fields

        if len(values) + len(fields) > MAX_NSIPRO_FIELD_ROWS_PER_PART:
            raise NsiproFieldLimitError(
                ".nsipro metadata exceeds the aggregate field-row limit "
                f"of {MAX_NSIPRO_FIELD_ROWS_PER_PART} for one part"
            )
        values.extend(
            {
                "source_ref": source.source_ref,
                "source_filename": source.source_filename,
                "field_path": field.field_path,
                "field_path_hash": field.field_path_hash,
                "field_name": field.field_name,
                "ordinal": field.ordinal,
                "value_type": field.value_type,
                "value_json": field.value_json,
                "value_text": field.value_text,
                "value_text_hash": field.value_text_hash,
                "value_number": field.value_number,
                "value_boolean": field.value_boolean,
            }
            for field in fields
        )
    return values


def _has_explicit_nsipro_metadata_sync_intent(metadata: object) -> bool:
    """Return whether an ingest payload explicitly supplies ``nsipro_*`` data."""

    if not isinstance(metadata, dict):
        return False
    nsipro_keys = {
        "nsipro_metadata",
        "nsipro_metadata_sources",
        "nsipro_payload",
        "nsipro_payload_ref",
        "nsipro_payloads_by_ref",
    }
    if nsipro_keys.intersection(metadata):
        return True
    source_images = metadata.get("source_images")
    if not isinstance(source_images, list):
        return False
    return any(
        isinstance(source_image, dict)
        and bool(nsipro_keys.intersection(source_image))
        for source_image in source_images
    )


def _resolve_configured_nsipro_parser(project_config: dict):
    nsipro_config = _dict_or_empty(_dict_or_empty(project_config.get("metadata_parsers")).get("nsipro"))
    parser = get_nsipro_parser(nsipro_config.get("parser_id"))
    expected_version = str(nsipro_config.get("parser_version") or parser.version).strip()
    expected_hash = str(nsipro_config.get("parser_hash") or parser.parser_hash).strip()
    strict = bool(
        nsipro_config.get("strict")
        or nsipro_config.get("strict_mode")
        or nsipro_config.get("strict_version_match")
        or nsipro_config.get("strict_parser_match")
    )
    return parser, expected_version, expected_hash, strict


async def _load_project_configuration_for_ingest(*, db: AsyncSession, project_id: uuid.UUID, project_type: str | None) -> dict:
    metadata = await crud.get_project_metadata_by_key(
        db=db,
        project_id=project_id,
        key=PROJECT_CONFIGURATION_KEY,
    )
    default_config = _default_project_configuration(project_type)
    raw_config = metadata.value if metadata and isinstance(metadata.value, dict) else {}
    return {**default_config, **raw_config}


def _candidate_metadata_reference_keys(metadata: dict) -> list[str]:
    keys: list[str] = []
    raw_ref = metadata.get("associated_metadata_ref")
    if isinstance(raw_ref, str) and raw_ref.strip():
        keys.append(raw_ref.strip())
    associated = metadata.get("associated_metadata")
    if isinstance(associated, dict):
        for candidate_key in ("project_metadata_key", "key"):
            value = associated.get(candidate_key)
            if isinstance(value, str) and value.strip():
                keys.append(value.strip())
    return list(dict.fromkeys(keys))


def _extract_stored_nsipro_text(bundle: dict) -> str:
    for key in ("text", "raw_text", "raw", "raw_payload", "raw_content", "file_content", "content"):
        value = bundle.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _validate_nsipro_parser_contract(
    *,
    bundle: dict,
    reference: dict,
    configured_parser,
    expected_version: str,
    expected_hash: str,
    strict: bool,
) -> None:
    if not strict:
        return
    observed_parser_id = str(
        reference.get("parser_id")
        or bundle.get("parser_id")
        or configured_parser.id
    ).strip()
    observed_version = str(
        reference.get("parser_version")
        or bundle.get("parser_version")
        or expected_version
    ).strip()
    observed_hash = str(
        reference.get("parser_hash")
        or bundle.get("parser_hash")
        or expected_hash
    ).strip()
    mismatches = []
    if observed_parser_id != configured_parser.id:
        mismatches.append(f"parser_id expected {configured_parser.id!r} got {observed_parser_id!r}")
    if observed_version != expected_version:
        mismatches.append(f"parser_version expected {expected_version!r} got {observed_version!r}")
    if observed_hash != expected_hash:
        mismatches.append("parser_hash mismatch")
    if mismatches:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=".nsipro parser contract mismatch: " + "; ".join(mismatches),
        )


def _normalize_nsipro_bundle_payload(
    *,
    bundle: dict,
    reference: dict,
    configured_parser,
    expected_version: str,
    expected_hash: str,
    strict: bool,
) -> dict | None:
    if str(bundle.get("file_type") or "").strip().lower() not in {"nsipro", ".nsipro"}:
        return None
    _validate_nsipro_parser_contract(
        bundle=bundle,
        reference=reference,
        configured_parser=configured_parser,
        expected_version=expected_version,
        expected_hash=expected_hash,
        strict=strict,
    )

    raw_text = _extract_stored_nsipro_text(bundle)
    if raw_text:
        parsed = parse_nsipro_text(raw_text, str(bundle.get("source_filename") or bundle.get("filename") or ""), configured_parser.id)
    else:
        metadata = bundle.get("metadata")
        if not isinstance(metadata, dict):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="Associated .nsipro metadata does not contain parsed metadata or raw text.",
            )
        parsed = {
            "parser": bundle.get("parser") or reference.get("parser") or "nsipro-stored-metadata",
            "parser_id": configured_parser.id,
            "parser_version": expected_version,
            "parser_hash": expected_hash,
            "source_filename": bundle.get("source_filename") or bundle.get("filename") or reference.get("source_filename"),
            "metadata": metadata,
            "warnings": list(bundle.get("warnings") or []),
        }
    return {
        "parser": parsed.get("parser"),
        "parser_id": parsed.get("parser_id") or configured_parser.id,
        "parser_version": parsed.get("parser_version") or expected_version,
        "parser_hash": parsed.get("parser_hash") or expected_hash,
        "source_filename": parsed.get("source_filename") or bundle.get("source_filename") or bundle.get("filename"),
        "content_hash": bundle.get("content_hash") or reference.get("content_hash"),
        "metadata": parsed.get("metadata") if isinstance(parsed.get("metadata"), dict) else {},
        "warnings": list(parsed.get("warnings") or []),
    }


async def _resolve_associated_nsipro_payload(
    *,
    db: AsyncSession,
    project_id: uuid.UUID,
    metadata: dict,
    configured_parser,
    expected_version: str,
    expected_hash: str,
    strict: bool,
    project_metadata_by_key: dict[str, models.ProjectMetadata] | None = None,
    nsipro_payload_by_ref: dict[str, dict] | None = None,
) -> tuple[str, dict] | None:
    for metadata_key in _candidate_metadata_reference_keys(metadata):
        if project_metadata_by_key is None:
            project_metadata = await crud.get_project_metadata_by_key(db=db, project_id=project_id, key=metadata_key)
        else:
            project_metadata = project_metadata_by_key.get(metadata_key)
        bundle = project_metadata.value if project_metadata and isinstance(project_metadata.value, dict) else None
        if not bundle:
            continue
        reference = _dict_or_empty(metadata.get("associated_metadata"))
        cached_payload = (
            nsipro_payload_by_ref.get(metadata_key)
            if nsipro_payload_by_ref is not None
            else None
        )
        if cached_payload is not None:
            # The parsed payload is canonical for a project-metadata key, but
            # strict parser declarations belong to each individual reference.
            # Validate every occurrence even when parsing is request-cached.
            _validate_nsipro_parser_contract(
                bundle=bundle,
                reference=reference,
                configured_parser=configured_parser,
                expected_version=expected_version,
                expected_hash=expected_hash,
                strict=strict,
            )
            return metadata_key, cached_payload
        payload = _normalize_nsipro_bundle_payload(
            bundle=bundle,
            reference=reference,
            configured_parser=configured_parser,
            expected_version=expected_version,
            expected_hash=expected_hash,
            strict=strict,
        )
        if payload:
            if nsipro_payload_by_ref is not None:
                nsipro_payload_by_ref[metadata_key] = payload
            return metadata_key, payload
    return None


def _combine_metadata_source_values(source_payloads: list[dict]) -> dict:
    combined: dict = {}
    collisions: dict = {}
    for source in source_payloads:
        source_key = str(source.get("key") or "").strip()
        metadata = source.get("metadata") if isinstance(source.get("metadata"), dict) else {}
        for key, value in metadata.items():
            if key in combined and combined[key] != value:
                collisions.setdefault(key, []).append({"source_key": source_key, "value": value})
                continue
            combined[key] = value
    if collisions:
        combined["metadata_source_collisions"] = collisions
    return combined


async def _normalize_ingest_part_metadata(
    *,
    db: AsyncSession,
    project_id: uuid.UUID,
    metadata: dict | None,
    configured_parser,
    expected_version: str,
    expected_hash: str,
    strict: bool,
    project_metadata_by_key: dict[str, models.ProjectMetadata] | None = None,
    nsipro_payload_by_ref: dict[str, dict] | None = None,
) -> dict | None:
    if metadata is None:
        return None
    if not isinstance(metadata, dict):
        return metadata

    normalized = {**metadata}
    resolved_payloads: dict[str, dict] = {}
    top_level_resolution = await _resolve_associated_nsipro_payload(
        db=db,
        project_id=project_id,
        metadata=normalized,
        configured_parser=configured_parser,
        expected_version=expected_version,
        expected_hash=expected_hash,
        strict=strict,
        project_metadata_by_key=project_metadata_by_key,
        nsipro_payload_by_ref=nsipro_payload_by_ref,
    )
    primary_reference: str | None = None
    if top_level_resolution:
        primary_reference, top_level_payload = top_level_resolution
        resolved_payloads[primary_reference] = top_level_payload

    source_images = normalized.get("source_images")
    if isinstance(source_images, list):
        normalized_source_images = []
        for record in source_images:
            if not isinstance(record, dict):
                normalized_source_images.append(record)
                continue
            normalized_record = {**record}
            record_resolution = await _resolve_associated_nsipro_payload(
                db=db,
                project_id=project_id,
                metadata=normalized_record,
                configured_parser=configured_parser,
                expected_version=expected_version,
                expected_hash=expected_hash,
                strict=strict,
                project_metadata_by_key=project_metadata_by_key,
                nsipro_payload_by_ref=nsipro_payload_by_ref,
            )
            if record_resolution:
                record_reference, record_payload = record_resolution
                resolved_payloads.setdefault(record_reference, record_payload)
                primary_reference = primary_reference or record_reference
                # Source-image records stay compact. Keep an explicitly
                # supplied legacy inline ``nsipro_payload`` untouched, but do
                # not create another full copy while resolving references.
                normalized_record["associated_metadata_ref"] = record_reference
                normalized_record["nsipro_payload_ref"] = record_reference
            normalized_source_images.append(normalized_record)
        normalized["source_images"] = normalized_source_images

    if primary_reference:
        primary_payload = resolved_payloads[primary_reference]
        normalized["nsipro_payload_ref"] = primary_reference
        normalized["nsipro_payload"] = primary_payload
        normalized["nsipro_metadata"] = primary_payload["metadata"]

        additional_payloads = {
            str(reference): payload
            for reference, payload in _dict_or_empty(normalized.get("nsipro_payloads_by_ref")).items()
            if str(reference) != primary_reference and isinstance(payload, dict)
        }
        additional_payloads.update(
            {
                reference: payload
                for reference, payload in resolved_payloads.items()
                if reference != primary_reference
            }
        )
        if additional_payloads:
            normalized["nsipro_payloads_by_ref"] = additional_payloads
        else:
            normalized.pop("nsipro_payloads_by_ref", None)
    return normalized


def _source_image_identity(record: dict) -> tuple[str, str]:
    return (
        str(record.get("image_id") or "").strip(),
        str(record.get("filename") or "").strip(),
    )


def _merge_existing_part_ingest_metadata(existing_metadata: object, incoming_metadata: object) -> dict:
    current = existing_metadata if isinstance(existing_metadata, dict) else {}
    incoming = incoming_metadata if isinstance(incoming_metadata, dict) else {}
    patch: dict = {}
    for key in (
        "nsipro_metadata",
        "nsipro_payload",
        "nsipro_payload_ref",
        "nsipro_payloads_by_ref",
        "associated_metadata_ref",
        "associated_metadata",
    ):
        if key in incoming:
            patch[key] = incoming[key]

    current_primary_ref = str(current.get("nsipro_payload_ref") or "").strip()
    incoming_primary_ref = str(incoming.get("nsipro_payload_ref") or "").strip()
    current_primary_payload = current.get("nsipro_payload")
    incoming_primary_payload = incoming.get("nsipro_payload")
    if incoming_primary_ref and isinstance(incoming_primary_payload, dict):
        combined_payloads = {
            str(reference): payload
            for reference, payload in _dict_or_empty(current.get("nsipro_payloads_by_ref")).items()
            if isinstance(payload, dict)
        }
        if current_primary_ref and isinstance(current_primary_payload, dict):
            combined_payloads[current_primary_ref] = current_primary_payload
        combined_payloads.update(
            {
                str(reference): payload
                for reference, payload in _dict_or_empty(incoming.get("nsipro_payloads_by_ref")).items()
                if isinstance(payload, dict)
            }
        )
        combined_payloads.pop(incoming_primary_ref, None)
        if combined_payloads:
            patch["nsipro_payloads_by_ref"] = combined_payloads
        elif "nsipro_payloads_by_ref" in current or "nsipro_payloads_by_ref" in incoming:
            patch["nsipro_payloads_by_ref"] = {}

    incoming_source_images = incoming.get("source_images")
    if isinstance(incoming_source_images, list):
        current_source_images = current.get("source_images") if isinstance(current.get("source_images"), list) else []
        merged_source_images = [dict(record) if isinstance(record, dict) else record for record in current_source_images]

        # Keep separate indexes for durable image IDs and the legacy filename
        # fallback. A filename may legitimately refer to multiple identified
        # images, so it must not become an alias between two different IDs.
        indexes_by_image_id: dict[str, dict[int, None]] = {}
        indexes_by_filename: dict[str, dict[int, None]] = {}
        legacy_indexes_by_filename: dict[str, dict[int, None]] = {}

        def add_to_index(index_map: dict[str, dict[int, None]], key: str, index: int) -> None:
            if key:
                index_map.setdefault(key, {})[index] = None

        def remove_from_index(index_map: dict[str, dict[int, None]], key: str, index: int) -> None:
            if not key:
                return
            candidates = index_map.get(key)
            if candidates is None:
                return
            candidates.pop(index, None)
            if not candidates:
                index_map.pop(key, None)

        def index_record(index: int, record: dict) -> None:
            image_id, filename = _source_image_identity(record)
            add_to_index(indexes_by_image_id, image_id, index)
            add_to_index(indexes_by_filename, filename, index)
            if not image_id:
                add_to_index(legacy_indexes_by_filename, filename, index)

        def unindex_record(index: int, record: dict) -> None:
            image_id, filename = _source_image_identity(record)
            remove_from_index(indexes_by_image_id, image_id, index)
            remove_from_index(indexes_by_filename, filename, index)
            if not image_id:
                remove_from_index(legacy_indexes_by_filename, filename, index)

        def first_index(index_map: dict[str, dict[int, None]], key: str) -> int | None:
            candidates = index_map.get(key)
            return next(iter(candidates)) if candidates else None

        for index, record in enumerate(merged_source_images):
            if isinstance(record, dict):
                index_record(index, record)
        changed = False
        for incoming_record in incoming_source_images:
            if not isinstance(incoming_record, dict):
                continue
            incoming_image_id, incoming_filename = _source_image_identity(incoming_record)
            matching_index = first_index(indexes_by_image_id, incoming_image_id) if incoming_image_id else None
            if matching_index is None and incoming_filename:
                # Identified records may fall back only to a legacy record with
                # no ID. A legacy incoming record may fall back to any record
                # with the same filename because one side of that comparison
                # lacks a durable identity.
                filename_index = legacy_indexes_by_filename if incoming_image_id else indexes_by_filename
                matching_index = first_index(filename_index, incoming_filename)
            if matching_index is not None and isinstance(merged_source_images[matching_index], dict):
                existing_record = merged_source_images[matching_index]
                next_record = {**existing_record, **incoming_record}
                existing_image_id, _ = _source_image_identity(existing_record)
                if existing_image_id and not incoming_image_id:
                    # Legacy payloads must not erase an identity already known
                    # by the project merely because they omit it.
                    next_record["image_id"] = existing_record.get("image_id")
                if next_record != existing_record:
                    unindex_record(matching_index, existing_record)
                    merged_source_images[matching_index] = next_record
                    index_record(matching_index, next_record)
                    changed = True
            else:
                merged_source_images.append(incoming_record)
                appended_index = len(merged_source_images) - 1
                index_record(appended_index, incoming_record)
                changed = True
        if changed:
            patch["source_images"] = merged_source_images
    return patch


def _synchronize_authoritative_nsipro_payloads(
    metadata: object,
    *,
    authoritative_payloads_by_ref: dict[str, dict],
) -> dict:
    """Refresh active canonical payload snapshots before deriving field rows."""

    current = metadata if isinstance(metadata, dict) else {}
    active_refs = collect_active_nsipro_source_refs(current)
    canonical_refs = [
        source_ref
        for source_ref in active_refs
        if source_ref in authoritative_payloads_by_ref
    ]
    if not canonical_refs:
        return current

    synchronized = {**current}
    primary_ref = str(current.get("nsipro_payload_ref") or "").strip()
    metadata_sources = current.get("nsipro_metadata_sources")
    if primary_ref and primary_ref in authoritative_payloads_by_ref:
        primary_payload = authoritative_payloads_by_ref[primary_ref]
        synchronized["nsipro_payload"] = primary_payload
        synchronized["nsipro_metadata"] = primary_payload.get("metadata", {})

        metadata_source_refs = {
            str(source.get("key") or source.get("project_metadata_key") or "").strip()
            for source in metadata_sources
            if isinstance(source, dict)
        } if isinstance(metadata_sources, list) else set()
        additional_payloads = {
            str(source_ref): payload
            for source_ref, payload in _dict_or_empty(
                current.get("nsipro_payloads_by_ref")
            ).items()
            if (
                str(source_ref) != primary_ref
                and str(source_ref) in active_refs
                and str(source_ref) not in metadata_source_refs
                and isinstance(payload, dict)
            )
        }
        additional_payloads.update(
            {
                source_ref: authoritative_payloads_by_ref[source_ref]
                for source_ref in canonical_refs
                if (
                    source_ref != primary_ref
                    and source_ref not in metadata_source_refs
                )
            }
        )
        if additional_payloads:
            synchronized["nsipro_payloads_by_ref"] = additional_payloads
        else:
            synchronized.pop("nsipro_payloads_by_ref", None)

    if isinstance(metadata_sources, list):
        synchronized_sources = []
        for source in metadata_sources:
            if not isinstance(source, dict):
                synchronized_sources.append(source)
                continue
            source_ref = str(
                source.get("key") or source.get("project_metadata_key") or ""
            ).strip()
            canonical_payload = authoritative_payloads_by_ref.get(source_ref)
            synchronized_sources.append(
                {**source, **canonical_payload}
                if isinstance(canonical_payload, dict)
                else source
            )
        synchronized["nsipro_metadata_sources"] = synchronized_sources
        if not primary_ref:
            synchronized["nsipro_metadata"] = _combine_metadata_source_values(
                [
                    source
                    for source in synchronized_sources
                    if isinstance(source, dict)
                ]
            )

    return synchronized


def _collect_ingest_metadata_reference_keys(payload: schemas.InspectionBulkIngestPayload) -> list[str]:
    """Collect every project-metadata reference used by a bulk ingest request."""

    reference_keys: set[str] = set()
    ingest_parts = [part for batch in payload.batches for part in batch.parts]
    ingest_parts.extend(payload.unassigned_parts)
    for ingest_part in ingest_parts:
        metadata = ingest_part.metadata_json
        if not isinstance(metadata, dict):
            continue
        reference_keys.update(_candidate_metadata_reference_keys(metadata))
        source_images = metadata.get("source_images")
        if not isinstance(source_images, list):
            continue
        for record in source_images:
            if isinstance(record, dict):
                reference_keys.update(_candidate_metadata_reference_keys(record))
    return sorted(reference_keys)


async def _load_ingest_project_metadata_references(
    *,
    db: AsyncSession,
    project_id: uuid.UUID,
    payload: schemas.InspectionBulkIngestPayload,
) -> dict[str, models.ProjectMetadata]:
    reference_keys = _collect_ingest_metadata_reference_keys(payload)
    if not reference_keys:
        return {}
    result = await db.execute(
        select(models.ProjectMetadata).where(
            models.ProjectMetadata.project_id == project_id,
            models.ProjectMetadata.key.in_(reference_keys),
        )
    )
    return {metadata.key: metadata for metadata in result.scalars().all()}

async def _bulk_ingest_project_parts(
    *,
    project_id: uuid.UUID,
    payload: schemas.InspectionBulkIngestPayload,
    db: AsyncSession,
    current_user: schemas.User,
    project_type: str | None = None,
):
    ingest_started = time.perf_counter()
    counters = {
        "batches_received": len(payload.batches),
        "parts_received": sum(len(batch.parts) for batch in payload.batches) + len(payload.unassigned_parts),
        "batches_created": 0,
        "parts_created": 0,
        "parts_skipped_existing": 0,
        "parts_skipped_discrepancy": 0,
    }
    discrepancies: List[dict] = []
    payload_seen_serials: set[str] = set()
    try:
        project_config = await _load_project_configuration_for_ingest(
            db=db,
            project_id=project_id,
            project_type=project_type,
        )
        configured_parser, expected_version, expected_hash, strict_parser_match = _resolve_configured_nsipro_parser(project_config)
        project_metadata_by_key = await _load_ingest_project_metadata_references(
            db=db,
            project_id=project_id,
            payload=payload,
        )
        nsipro_payload_by_ref: dict[str, dict] = {}
        parts_needing_metadata_field_sync: dict[uuid.UUID, models.InspectionPart] = {}

        existing_batches = await crud.list_inspection_batches(db=db, project_id=project_id)
        batches_by_name = {batch.name: batch for batch in existing_batches}
        payload_parts = [
            part
            for batch in payload.batches
            for part in batch.parts
        ]
        payload_parts.extend(payload.unassigned_parts)
        existing_parts = (
            await crud.list_inspection_parts_for_update_by_serial_numbers(
                db=db,
                project_id=project_id,
                serial_numbers=[part.serial_number for part in payload_parts],
            )
        )
        parts_by_serial = {part.serial_number: part for part in existing_parts}

        async def ingest_parts(
            ingest_parts_list: List[schemas.InspectionIngestPartRecord],
            *,
            ingest_batch_name: Optional[str],
            target_batch_id: Optional[uuid.UUID],
        ) -> None:
            for ingest_part in ingest_parts_list:
                serial_number = ingest_part.serial_number.strip()
                if serial_number in payload_seen_serials:
                    counters["parts_skipped_discrepancy"] += 1
                    discrepancies.append(
                        {
                            "code": "duplicate_serial_in_payload",
                            "batch_name": ingest_batch_name or "unassigned",
                            "serial_number": serial_number,
                            "message": "Serial number appears more than once in ingest payload",
                        }
                    )
                    continue
                payload_seen_serials.add(serial_number)

                existing_part = parts_by_serial.get(serial_number)
                if existing_part:
                    if target_batch_id and existing_part.batch_id and existing_part.batch_id != target_batch_id:
                        counters["parts_skipped_discrepancy"] += 1
                        discrepancies.append(
                            {
                                "code": "serial_already_assigned_to_other_batch",
                                "batch_name": ingest_batch_name or "unassigned",
                                "serial_number": serial_number,
                                "message": "Serial number already belongs to a different batch in this project",
                            }
                        )
                        continue
                    metadata_field_sync_requested = (
                        _has_explicit_nsipro_metadata_sync_intent(
                            ingest_part.metadata_json
                        )
                    )
                    normalized_existing_metadata = await _normalize_ingest_part_metadata(
                        db=db,
                        project_id=project_id,
                        metadata=ingest_part.metadata_json,
                        configured_parser=configured_parser,
                        expected_version=expected_version,
                        expected_hash=expected_hash,
                        strict=strict_parser_match,
                        project_metadata_by_key=project_metadata_by_key,
                        nsipro_payload_by_ref=nsipro_payload_by_ref,
                    )
                    if collect_indexable_nsipro_sources(
                        normalized_existing_metadata,
                        authoritative_payloads_by_ref=nsipro_payload_by_ref,
                    ):
                        metadata_field_sync_requested = True
                    if isinstance(normalized_existing_metadata, dict):
                        metadata_patch = _merge_existing_part_ingest_metadata(existing_part.metadata_json, normalized_existing_metadata)
                        if metadata_patch:
                            # ``existing_part`` was loaded into the request-local
                            # serial map above. Mutate that tracked ORM row
                            # directly instead of re-selecting every existing
                            # part through the CRUD helper (an O(n) query loop
                            # for multi-view imports).
                            current_metadata = (
                                existing_part.metadata_json
                                if isinstance(existing_part.metadata_json, dict)
                                else {}
                            )
                            existing_part.metadata_json = {
                                **current_metadata,
                                **metadata_patch,
                            }
                    if metadata_field_sync_requested:
                        # Rebuild from post-merge metadata. This also deletes
                        # stale derived rows when an ingest explicitly clears
                        # its .nsipro association.
                        parts_needing_metadata_field_sync[existing_part.id] = existing_part
                    counters["parts_skipped_existing"] += 1
                    continue

                normalized_metadata = await _normalize_ingest_part_metadata(
                    db=db,
                    project_id=project_id,
                    metadata=ingest_part.metadata_json,
                    configured_parser=configured_parser,
                    expected_version=expected_version,
                    expected_hash=expected_hash,
                    strict=strict_parser_match,
                    project_metadata_by_key=project_metadata_by_key,
                    nsipro_payload_by_ref=nsipro_payload_by_ref,
                )
                created_part = await crud.create_inspection_part(
                    db=db,
                    project_id=project_id,
                    part=schemas.InspectionPartCreate(
                        batch_id=target_batch_id,
                        serial_number=serial_number,
                        display_name=ingest_part.display_name,
                        metadata=normalized_metadata,
                        review_state=ingest_part.review_state,
                    ),
                    created_by=current_user.email,
                    commit=False,
                )
                if created_part.id is None:
                    created_part.id = uuid.uuid4()
                parts_by_serial[serial_number] = created_part
                if collect_active_nsipro_source_refs(normalized_metadata):
                    parts_needing_metadata_field_sync[created_part.id] = created_part
                counters["parts_created"] += 1

        resolved_ingest_batches: list[
            tuple[schemas.InspectionIngestBatchRecord, models.InspectionBatch]
        ] = []
        for ingest_batch in payload.batches:
            target_batch = batches_by_name.get(ingest_batch.name)
            if target_batch is None:
                target_batch = await crud.create_inspection_batch(
                    db=db,
                    project_id=project_id,
                    batch=schemas.InspectionBatchCreate(
                        name=ingest_batch.name,
                        description=ingest_batch.description,
                    ),
                    created_by=current_user.email,
                    commit=False,
                )
                # SQLAlchemy's UUID default is normally materialized during a
                # flush. Assign it now so every missing batch can be staged
                # before its parts without issuing one flush per batch. The
                # final unit-of-work flush orders batch inserts ahead of their
                # part foreign keys.
                if target_batch.id is None:
                    target_batch.id = uuid.uuid4()
                batches_by_name[ingest_batch.name] = target_batch
                counters["batches_created"] += 1
            resolved_ingest_batches.append((ingest_batch, target_batch))

        for ingest_batch, target_batch in resolved_ingest_batches:
            await ingest_parts(
                ingest_batch.parts,
                ingest_batch_name=ingest_batch.name,
                target_batch_id=target_batch.id,
            )

        await ingest_parts(
            payload.unassigned_parts,
            ingest_batch_name=None,
            target_batch_id=None,
        )
        active_source_refs_by_part = {
            part_id: collect_active_nsipro_source_refs(part.metadata_json)
            for part_id, part in parts_needing_metadata_field_sync.items()
        }
        active_source_refs = {
            source_ref
            for source_refs in active_source_refs_by_part.values()
            for source_ref in source_refs
        }
        missing_source_refs = sorted(
            active_source_refs.difference(project_metadata_by_key)
        )
        if missing_source_refs:
            result = await db.execute(
                select(models.ProjectMetadata).where(
                    models.ProjectMetadata.project_id == project_id,
                    models.ProjectMetadata.key.in_(missing_source_refs),
                )
            )
            project_metadata_by_key.update(
                {
                    metadata.key: metadata
                    for metadata in result.scalars().all()
                }
            )
        for source_ref in sorted(active_source_refs):
            if source_ref in nsipro_payload_by_ref:
                continue
            project_metadata = project_metadata_by_key.get(source_ref)
            bundle = (
                project_metadata.value
                if project_metadata and isinstance(project_metadata.value, dict)
                else None
            )
            if not bundle:
                continue
            canonical_payload = _normalize_nsipro_bundle_payload(
                bundle=bundle,
                reference={"project_metadata_key": source_ref},
                configured_parser=configured_parser,
                expected_version=expected_version,
                expected_hash=expected_hash,
                strict=strict_parser_match,
            )
            if canonical_payload:
                nsipro_payload_by_ref[source_ref] = canonical_payload

        for part in parts_needing_metadata_field_sync.values():
            synchronized_metadata = _synchronize_authoritative_nsipro_payloads(
                part.metadata_json,
                authoritative_payloads_by_ref=nsipro_payload_by_ref,
            )
            if synchronized_metadata is not part.metadata_json:
                part.metadata_json = synchronized_metadata

        metadata_field_cache: dict[tuple[str, str], list[NsiproField]] = {}
        fields_by_part: dict[uuid.UUID, list[dict]] = {}
        total_metadata_field_rows = 0
        for part_id, part in parts_needing_metadata_field_sync.items():
            field_values = _metadata_field_values_for_sources(
                collect_indexable_nsipro_sources(
                    part.metadata_json,
                    authoritative_payloads_by_ref=nsipro_payload_by_ref,
                ),
                field_cache=metadata_field_cache,
            )
            total_metadata_field_rows += len(field_values)
            if total_metadata_field_rows > MAX_NSIPRO_FIELD_ROWS_PER_INGEST:
                raise NsiproFieldLimitError(
                    ".nsipro metadata exceeds the aggregate field-row limit "
                    f"of {MAX_NSIPRO_FIELD_ROWS_PER_INGEST} for one ingest"
                )
            fields_by_part[part_id] = field_values
        await crud.replace_inspection_part_metadata_fields(
            db=db,
            project_id=project_id,
            fields_by_part=fields_by_part,
        )
        await db.flush()
        await db.commit()
    except NsiproFieldError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    except Exception:
        await db.rollback()
        raise

    crud.log_db_operation(
        "BULK_INGEST",
        "inspection_parts",
        project_id,
        current_user.email,
        {
            **counters,
            "elapsed_ms": round((time.perf_counter() - ingest_started) * 1000, 3),
        },
    )

    return {
        "project_id": project_id,
        "counters": counters,
        "discrepancies": discrepancies,
    }


def _normalize_layout_model(candidate: object) -> dict:
    if not isinstance(candidate, dict):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="layout_model must be an object")
    layout_node = candidate.get("layout")
    if not isinstance(layout_node, dict) or layout_node.get("type") not in {"row", "tabset"}:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="layout_model must include a valid layout root")
    return candidate


async def _resolve_project_type_interface_layout_default(
    db: AsyncSession,
    *,
    project_type: str,
) -> Optional[dict]:
    normalized_project_type = _normalize_project_type(project_type)
    metadata_key = _project_type_interface_layout_metadata_key(normalized_project_type)
    stmt = (
        select(models.ProjectMetadata.value)
        .join(models.Project, models.Project.id == models.ProjectMetadata.project_id)
        .where(
            models.Project.project_type == normalized_project_type,
            models.ProjectMetadata.key == metadata_key,
        )
        .order_by(models.ProjectMetadata.updated_at.desc())
        .limit(1)
    )
    result = await db.execute(stmt)
    value = result.scalar_one_or_none()
    return value if isinstance(value, dict) else None


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


@router.delete("/projects/{project_id}/batches/{batch_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_inspection_batch(
    project_id: uuid.UUID,
    batch_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    deleted = await crud.delete_inspection_batch(
        db=db,
        project_id=project_id,
        batch_id=batch_id,
        deleted_by=current_user.email,
    )
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection batch not found")
    return None


@router.patch("/projects/{project_id}/batches/{batch_id}", response_model=schemas.InspectionBatch)
async def update_inspection_batch(
    project_id: uuid.UUID,
    batch_id: uuid.UUID,
    payload: schemas.InspectionBatchUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    try:
        updated = await crud.update_inspection_batch(
            db=db,
            project_id=project_id,
            batch_id=batch_id,
            patch=payload,
            updated_by=current_user.email,
        )
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Batch name already exists in this project")
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection batch not found")
    return updated


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


@router.delete("/projects/{project_id}/parts", status_code=status.HTTP_204_NO_CONTENT)
async def delete_all_inspection_parts(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(
        project_id=project_id,
        db=db,
        current_user=current_user,
    )
    await crud.delete_all_inspection_parts(
        db=db,
        project_id=project_id,
        deleted_by=current_user.email,
    )
    return None


@router.put(
    "/projects/{project_id}/parts/{part_id}/image-display-order",
    response_model=schemas.InspectionPart,
)
async def update_inspection_part_image_display_order(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    payload: schemas.InspectionPartImageDisplayOrderUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await get_project_or_403_writable(project_id, db, current_user)
    part = await _get_locked_inspection_part(
        db=db,
        project_id=project_id,
        part_id=part_id,
    )
    if not part:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Inspection part not found",
        )

    metadata = part.metadata_json if isinstance(part.metadata_json, dict) else {}
    natural_order, image_ids, filename_aliases = _part_image_display_identities(metadata)
    requested_order: list[str] = []
    requested_identities: set[str] = set()
    for image_ref in payload.image_refs:
        if image_ref in image_ids:
            canonical_ref = image_ref
        else:
            candidates = filename_aliases.get(image_ref)
            if not candidates:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail=f"Unknown image reference '{image_ref}'",
                )
            if len(candidates) > 1:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail=f"Ambiguous image filename '{image_ref}'; use an image ID",
                )
            canonical_ref = next(iter(candidates))
        if canonical_ref in requested_identities:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail=(
                    f"Image reference '{image_ref}' duplicates another image "
                    "in image_refs"
                ),
            )
        requested_identities.add(canonical_ref)
        requested_order.append(canonical_ref)

    complete_order = requested_order + [
        image_ref
        for image_ref in natural_order
        if image_ref not in requested_identities
    ]
    updated = await crud.update_inspection_part_metadata(
        db=db,
        project_id=project_id,
        part_id=part_id,
        metadata_patch={"image_display_order": complete_order},
        updated_by=current_user.email,
    )
    if not updated:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Inspection part not found",
        )
    return _serialize_inspection_part(updated)


@router.put("/projects/{project_id}/parts/{part_id}/metadata-sources", response_model=schemas.InspectionPart)
async def update_inspection_part_metadata_sources(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    payload: schemas.InspectionPartMetadataSourcesUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    project = await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    part = await _get_locked_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")

    parser, expected_version, expected_hash, strict_parser_match = _resolve_configured_nsipro_parser(
        await _load_project_configuration_for_ingest(db=db, project_id=project_id, project_type=project.project_type)
    )
    source_refs: list[dict] = []
    source_payloads: list[dict] = []
    nsipro_sources: list[dict] = []
    project_metadata_by_key: dict[str, models.ProjectMetadata] = {}
    authoritative_payloads_by_ref: dict[str, dict] = {}
    for key in payload.metadata_source_keys:
        project_metadata = await crud.get_project_metadata_by_key(db=db, project_id=project_id, key=key)
        if project_metadata is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Metadata source '{key}' not found")
        project_metadata_by_key[key] = project_metadata
        value = project_metadata.value if isinstance(project_metadata.value, dict) else {"value": project_metadata.value}
        reference = {"project_metadata_key": key, "key": key}
        nsipro_payload = _normalize_nsipro_bundle_payload(
            bundle=value,
            reference=reference,
            configured_parser=parser,
            expected_version=expected_version,
            expected_hash=expected_hash,
            strict=strict_parser_match,
        )
        source_refs.append({
            "project_metadata_key": key,
            "filename": value.get("filename") or value.get("source_filename"),
            "file_type": value.get("file_type"),
            "parser": value.get("parser"),
            "parser_id": value.get("parser_id"),
        })
        source_payloads.append({
            "key": key,
            "metadata": (
                nsipro_payload.get("metadata")
                if nsipro_payload
                else value.get("metadata") if isinstance(value.get("metadata"), dict)
                else value
            ),
        })
        if nsipro_payload:
            nsipro_sources.append({"key": key, **nsipro_payload})
            authoritative_payloads_by_ref[key] = nsipro_payload

    current_metadata = part.metadata_json if isinstance(part.metadata_json, dict) else {}
    metadata_patch = {
        "associated_metadata_refs": payload.metadata_source_keys,
        "associated_metadata_sources": source_refs,
        "project_metadata_source_values": source_payloads,
        "project_metadata_combined": _combine_metadata_source_values(source_payloads) if source_payloads else {},
        "nsipro_metadata_sources": nsipro_sources,
        "nsipro_metadata": _combine_metadata_source_values(nsipro_sources) if nsipro_sources else {},
    }
    if payload.metadata_source_keys:
        metadata_patch["associated_metadata_ref"] = payload.metadata_source_keys[0]
        metadata_patch["associated_metadata"] = source_refs[0] if source_refs else {}
    elif "associated_metadata_ref" in current_metadata or "associated_metadata" in current_metadata:
        metadata_patch["associated_metadata_ref"] = None
        metadata_patch["associated_metadata"] = None

    post_patch_metadata = {**current_metadata, **metadata_patch}
    for source_ref in collect_active_nsipro_source_refs(post_patch_metadata):
        if source_ref in authoritative_payloads_by_ref:
            continue
        project_metadata = project_metadata_by_key.get(source_ref)
        if project_metadata is None:
            project_metadata = await crud.get_project_metadata_by_key(
                db=db,
                project_id=project_id,
                key=source_ref,
            )
        if project_metadata is None or not isinstance(project_metadata.value, dict):
            continue
        nsipro_payload = _normalize_nsipro_bundle_payload(
            bundle=project_metadata.value,
            reference={"project_metadata_key": source_ref, "key": source_ref},
            configured_parser=parser,
            expected_version=expected_version,
            expected_hash=expected_hash,
            strict=strict_parser_match,
        )
        if nsipro_payload:
            authoritative_payloads_by_ref[source_ref] = nsipro_payload

    synchronized_metadata = _synchronize_authoritative_nsipro_payloads(
        post_patch_metadata,
        authoritative_payloads_by_ref=authoritative_payloads_by_ref,
    )
    metadata_patch = {
        key: value
        for key, value in synchronized_metadata.items()
        if key not in current_metadata or current_metadata[key] != value
    }
    if (
        "nsipro_payloads_by_ref" in current_metadata
        and "nsipro_payloads_by_ref" not in synchronized_metadata
    ):
        metadata_patch["nsipro_payloads_by_ref"] = {}
    index_sources = collect_indexable_nsipro_sources(
        synchronized_metadata,
        authoritative_payloads_by_ref=authoritative_payloads_by_ref,
    )
    try:
        field_values = _metadata_field_values_for_sources(
            index_sources,
            field_cache={},
        )
        updated = await crud.update_inspection_part_metadata(
            db=db,
            project_id=project_id,
            part_id=part_id,
            metadata_patch=metadata_patch,
            updated_by=current_user.email,
            commit=False,
        )
        if not updated:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Inspection part not found",
            )
        await crud.replace_inspection_part_metadata_fields(
            db=db,
            project_id=project_id,
            fields_by_part={part_id: field_values},
        )
        await db.commit()
        await db.refresh(updated)
    except NsiproFieldError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=str(exc),
        ) from exc
    except Exception:
        await db.rollback()
        raise

    crud.log_db_operation(
        "UPDATE",
        "inspection_parts",
        updated.id,
        current_user.email,
        {
            "project_id": str(project_id),
            "metadata_keys": sorted(metadata_patch),
        },
    )
    return _serialize_inspection_part(updated)


def _safe_stack_filename(filename: object, index: int) -> str:
    """Return a safe materialized name from the authoritative image record."""

    raw_name = str(filename or f"slice-{index:04d}.png").strip()
    name = Path(raw_name).name or f"slice-{index:04d}.png"
    return f"{index:04d}-{name}"


async def _write_image_record_to_stack_dir(
    image: models.DataInstance,
    destination: Path,
    *,
    max_bytes: Optional[int] = None,
) -> int:
    """Materialize one source with a hard byte limit and atomic publication."""

    byte_limit = min(
        PT3_MAX_MATERIALIZED_FILE_BYTES,
        max_bytes if max_bytes is not None else PT3_MAX_MATERIALIZED_FILE_BYTES,
    )
    if byte_limit < 1:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="PT3 source stack exceeds the materialization limit",
        )
    partial = destination.with_name(f".{destination.name}.part")
    partial.unlink(missing_ok=True)

    def publish_bytes(payload: bytes) -> int:
        if len(payload) > byte_limit:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail=(
                    f"PT3 source {image.filename} exceeds the "
                    f"{byte_limit}-byte materialization limit"
                ),
            )
        partial.write_bytes(payload)
        partial.replace(destination)
        return len(payload)

    metadata = image.metadata_json if isinstance(image.metadata_json, dict) else {}
    encoded = metadata.get("analysis_inline_image_base64")
    if isinstance(encoded, str) and encoded:
        max_encoded_length = 4 * ((byte_limit + 2) // 3)
        if len(encoded) > max_encoded_length:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail=(
                    f"PT3 source {image.filename} exceeds the "
                    f"{byte_limit}-byte materialization limit"
                ),
            )
        try:
            inline_data = base64.b64decode(encoded, validate=True)
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Inline image data for {image.filename} is invalid",
            ) from exc
        return publish_bytes(inline_data)

    # Built-in PT3 fixtures may intentionally be metadata-only when object storage is
    # unavailable. Persisted provenance is untrusted; resolve it through the central
    # server-owned allowlist rather than joining a metadata-derived path.
    if metadata.get("source") == "vista-test-data" and metadata.get("project_type") == "PT3":
        fixture_path = resolve_pt3_test_fixture_file(
            fixture_id=metadata.get("builtin_fixture_id"),
            fixture_filename=metadata.get("builtin_fixture_filename") or image.filename,
            image_filename=image.filename,
            object_storage_key=image.object_storage_key,
            project_id=image.project_id,
        )
        if fixture_path is not None:
            if fixture_path.stat().st_size > byte_limit:
                raise HTTPException(
                    status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                    detail=(
                        f"PT3 source {image.filename} exceeds the "
                        f"{byte_limit}-byte materialization limit"
                    ),
                )
            written = 0
            try:
                with fixture_path.open("rb") as source, partial.open("wb") as target:
                    while chunk := source.read(PT3_DOWNLOAD_CHUNK_BYTES):
                        written += len(chunk)
                        if written > byte_limit:
                            raise HTTPException(
                                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                                detail="PT3 fixture exceeds the materialization limit",
                            )
                        target.write(chunk)
                partial.replace(destination)
                return written
            except Exception:
                partial.unlink(missing_ok=True)
                raise

    presigned_url = get_presigned_download_url(
        bucket_name=settings.S3_BUCKET,
        object_name=image.object_storage_key,
    )
    if not presigned_url:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Could not read image stack slice {image.filename} from object storage",
        )
    try:
        async with httpx.AsyncClient() as client:
            async with client.stream("GET", presigned_url) as response:
                response.raise_for_status()
                raw_content_length = (getattr(response, "headers", {}) or {}).get(
                    "content-length"
                )
                if raw_content_length is not None:
                    try:
                        content_length = int(raw_content_length)
                    except (TypeError, ValueError) as exc:
                        raise HTTPException(
                            status_code=status.HTTP_502_BAD_GATEWAY,
                            detail="Object storage returned an invalid content length",
                        ) from exc
                    if content_length < 0:
                        raise HTTPException(
                            status_code=status.HTTP_502_BAD_GATEWAY,
                            detail="Object storage returned an invalid content length",
                        )
                    if content_length > byte_limit:
                        raise HTTPException(
                            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                            detail=(
                                f"PT3 source {image.filename} exceeds the "
                                f"{byte_limit}-byte materialization limit"
                            ),
                        )
                written = 0
                with partial.open("wb") as target:
                    async for chunk in response.aiter_bytes(
                        chunk_size=PT3_DOWNLOAD_CHUNK_BYTES
                    ):
                        written += len(chunk)
                        if written > byte_limit:
                            raise HTTPException(
                                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                                detail=(
                                    f"PT3 source {image.filename} exceeds the "
                                    f"{byte_limit}-byte materialization limit"
                                ),
                            )
                        target.write(chunk)
                partial.replace(destination)
                return written
    except HTTPException:
        partial.unlink(missing_ok=True)
        raise
    except Exception as exc:
        partial.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Could not materialize image stack slice {image.filename}",
        ) from exc


async def _materialize_part_volume_stack(
    *,
    project_id: uuid.UUID,
    part: models.InspectionPart,
    db: AsyncSession,
    materialization_key: Optional[str] = None,
) -> tuple[str, list[str]]:
    metadata = part.metadata_json if isinstance(part.metadata_json, dict) else {}
    source_images = [record for record in metadata.get("source_images") or [] if isinstance(record, dict)]
    stack_records = [record for record in source_images if record.get("image_id") and str(record.get("overlay") or "").lower() != "true"]
    if not stack_records:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No image stack slices are attached to this part for Gaussian splat generation")
    if len(stack_records) > REFERENCE_VOLUME_READ_LIMITS.max_container_members:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="PT3 source stack contains too many files",
        )

    def sort_key(item: dict):
        raw_index = item.get("slice_index")
        try:
            index = int(raw_index)
        except (TypeError, ValueError):
            index = 10**9
        return (index, str(item.get("filename") or ""))

    stack_records = sorted(stack_records, key=sort_key)
    try:
        cache_components: list[object] = [project_id, part.id]
        if materialization_key:
            cache_components.append(materialization_key)
        stack_dir = _prepare_pt3_cache_directory(
            "pt3_volume_stacks",
            *cache_components,
        )
        for existing in stack_dir.iterdir():
            if existing.is_file():
                existing.unlink()
    except (_PT3CacheUnavailableError, OSError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "PT3 fitting cache is unavailable because a writable job "
                "directory could not be prepared"
            ),
        ) from exc

    source_image_ids: list[str] = []
    materialized_paths: list[Path] = []
    materialized_bytes = 0
    try:
        for index, record in enumerate(stack_records):
            image_id = uuid.UUID(str(record.get("image_id")))
            image = await _get_active_project_image_by_id(db=db, project_id=project_id, image_id=image_id)
            if not image:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Image stack slice {record.get('image_id')} was not found")
            source_image_ids.append(str(image.id))
            # The part metadata filename is display metadata and can be stale or
            # attacker-controlled. Preserve the storage object's actual format by
            # deriving the suffix from the authoritative DataInstance instead.
            destination = stack_dir / _safe_stack_filename(image.filename, index)
            remaining_bytes = PT3_MAX_MATERIALIZED_STACK_BYTES - materialized_bytes
            written = await _write_image_record_to_stack_dir(
                image,
                destination,
                max_bytes=remaining_bytes,
            )
            materialized_bytes += written
            materialized_paths.append(destination)
    except Exception:
        for path in materialized_paths:
            path.unlink(missing_ok=True)
        for partial in stack_dir.glob(".*.part"):
            partial.unlink(missing_ok=True)
        raise

    # A single implicit volume container must remain a file so load_volume can
    # distinguish NumPy arrays and multi-page TIFFs from a directory of slices.
    # A one-frame TIFF is still a valid depth-one volume. Multiple image files
    # retain the historical slice-stack interpretation.
    if len(materialized_paths) == 1 and materialized_paths[0].suffix.lower() in {".npy", ".npz", ".tif", ".tiff"}:
        return str(materialized_paths[0]), source_image_ids
    if any(path.suffix.lower() in {".npy", ".npz"} for path in materialized_paths):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="A NumPy voxel volume must be the part's only source volume",
        )
    return str(stack_dir), source_image_ids


def _pt3_provider_camera_view_binding(
    *,
    source_image_ids: List[str],
    camera_image_ids: set[str],
) -> str:
    """Classify provider cameras without letting their IDs select voxel inputs.

    Every PT3 source format is an authoritative voxel volume, including an
    image-slice directory. Independently generated/calibrated exterior views
    therefore may use their own IDs. Exact identity remains classified for
    backward compatibility, but camera IDs never select the source files.
    """

    expected_image_ids = set(source_image_ids)
    if camera_image_ids == expected_image_ids:
        return "server_inferred_source_views"
    return "generated_from_voxel_volume"


def _pt3_real_splat_job_cache_paths(
    *, project_id: uuid.UUID, part_id: uuid.UUID, job_id: str
) -> tuple[Path, Path]:
    input_path = _pt3_cache_root() / "pt3_volume_stacks" / str(project_id) / str(part_id) / job_id
    output_path = _pt3_cache_root() / "pt3_real_splat_assets" / str(project_id) / str(part_id) / job_id
    return input_path, output_path


def _remove_direct_child_cache_path(path: Path, *, parent: Path) -> None:
    """Remove only one resolved job directory immediately below a known root."""

    safe_parent = parent.resolve()
    safe_path = path.resolve()
    if safe_path.parent != safe_parent or safe_path == safe_parent:
        return
    if safe_path.is_dir():
        shutil.rmtree(safe_path, ignore_errors=True)


def _pt3_simplified_splat_job_input_path(
    *, project_id: uuid.UUID, part_id: uuid.UUID, job_id: str
) -> Path:
    return (
        _pt3_cache_root()
        / "pt3_volume_stacks"
        / str(project_id)
        / str(part_id)
        / job_id
    )


def _cleanup_pt3_simplified_splat_job_input(
    *, project_id: uuid.UUID, part_id: uuid.UUID, job_id: str
) -> None:
    try:
        input_parent = _existing_pt3_cache_directory(
            "pt3_volume_stacks",
            project_id,
            part_id,
        )
        input_path = input_parent / _pt3_cache_component(job_id)
        _remove_direct_child_cache_path(input_path, parent=input_parent)
    except (OSError, RuntimeError):
        # Cleanup is best effort and must never replace the request/job error
        # that caused it, especially a sanitized cache-unavailable response.
        return


def _prune_stale_pt3_simplified_splat_output(
    asset_path: Optional[Path],
    *,
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    latest_asset: object,
) -> None:
    """Remove a stale output only when no active/latest job can reference it."""

    if asset_path is None:
        return
    current_asset = latest_asset if isinstance(latest_asset, dict) else {}
    # A pending successor may be computing the same content key and about to
    # publish this exact shared file, so pruning during that state is unsafe.
    if current_asset.get("status") == "pending":
        return
    try:
        expected_root = _existing_pt3_cache_directory(
            "pt3_splat_assets",
            project_id,
            part_id,
        )
        candidate = asset_path.resolve()
        referenced_path_text = str(current_asset.get("asset_path") or "").strip()
        referenced_path = (
            Path(referenced_path_text).expanduser().resolve()
            if referenced_path_text
            else None
        )
    except (OSError, RuntimeError):
        return
    if (
        candidate.parent == expected_root
        and candidate.suffix.lower() in PT3_SIMPLIFIED_SPLAT_EXTENSIONS
        and candidate != referenced_path
        and candidate.is_file()
    ):
        try:
            candidate.unlink(missing_ok=True)
        except OSError:
            pass


def _prune_pt3_simplified_splat_outputs(
    *,
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    keep_asset_path: Path,
) -> None:
    """Prune prior content keys after publishing the sole current part asset."""

    try:
        output_root = _existing_pt3_cache_directory(
            "pt3_splat_assets",
            project_id,
            part_id,
        )
        keep_path = keep_asset_path.resolve()
    except (OSError, RuntimeError):
        return
    if keep_path.parent != output_root or not output_root.is_dir():
        return
    for candidate in output_root.iterdir():
        try:
            resolved_candidate = candidate.resolve()
            if (
                resolved_candidate.parent == output_root
                and resolved_candidate != keep_path
                and resolved_candidate.suffix.lower()
                in PT3_SIMPLIFIED_SPLAT_EXTENSIONS
                and resolved_candidate.is_file()
            ):
                resolved_candidate.unlink(missing_ok=True)
        except (OSError, RuntimeError):
            continue


def _cleanup_pt3_real_splat_job_cache(
    *,
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    job_id: str,
    remove_input: bool = True,
    remove_output: bool = True,
) -> None:
    cache_targets = (
        (remove_input, "pt3_volume_stacks"),
        (remove_output, "pt3_real_splat_assets"),
    )
    for should_remove, namespace in cache_targets:
        if not should_remove:
            continue
        try:
            parent = _existing_pt3_cache_directory(
                namespace,
                project_id,
                part_id,
            )
            _remove_direct_child_cache_path(
                parent / _pt3_cache_component(job_id),
                parent=parent,
            )
        except (OSError, RuntimeError):
            # Preserve the original API/provider failure if one cache namespace
            # disappeared or became unsafe while this job was being cleaned up.
            continue


def _prune_pt3_real_splat_job_cache(
    *, project_id: uuid.UUID, part_id: uuid.UUID, keep_output_job_id: Optional[str]
) -> None:
    """Prune superseded outputs while retaining the published asset."""

    output_root = _existing_pt3_cache_directory(
        "pt3_real_splat_assets",
        project_id,
        part_id,
    )
    if output_root.is_dir():
        for candidate in output_root.iterdir():
            if candidate.is_dir() and candidate.name != keep_output_job_id:
                _remove_direct_child_cache_path(candidate, parent=output_root)


def _contained_pt3_real_splat_asset_path(
    asset: object,
    *,
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    cache_key: Optional[str] = None,
) -> Optional[Path]:
    """Return a readable Real asset only from this part's server cache."""

    if not isinstance(asset, dict):
        return None
    declared_cache_key = str(asset.get("cache_key") or "").strip()
    if (
        not declared_cache_key
        or len(declared_cache_key) > 255
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", declared_cache_key) is None
        or (cache_key is not None and declared_cache_key != cache_key)
    ):
        return None
    raw_path = str(asset.get("asset_path") or "").strip()
    if not raw_path:
        return None
    job_id = str(asset.get("job_id") or "").strip()
    if job_id and (
        len(job_id) > 255
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", job_id) is None
    ):
        return None
    try:
        expected_root = _existing_pt3_cache_directory(
            "pt3_real_splat_assets",
            project_id,
            part_id,
        )
        asset_path = Path(raw_path).expanduser().resolve()
        expected_job_root = (
            _existing_pt3_cache_directory(
                "pt3_real_splat_assets",
                project_id,
                part_id,
                job_id,
            )
            if job_id
            else None
        )
    except (OSError, RuntimeError):
        return None
    if (
        expected_root not in asset_path.parents
        or (
            expected_job_root is not None
            and expected_job_root not in asset_path.parents
        )
        or asset_path.suffix.lower() != ".json"
        or not asset_path.is_file()
    ):
        return None
    return asset_path


def _usable_previous_pt3_real_splat_asset(
    asset: object,
    *,
    project_id: uuid.UUID,
    part_id: uuid.UUID,
) -> Optional[dict]:
    """Return a contained, still-readable published asset for recompute fallback."""

    if not isinstance(asset, dict):
        return None
    candidate = asset
    if candidate.get("status") != "ready":
        nested = candidate.get("previous_ready_asset")
        candidate = nested if isinstance(nested, dict) else {}
    if (
        candidate.get("status") != "ready"
        or not candidate.get("cache_key")
        or not candidate.get("asset_path")
    ):
        return None
    asset_path = _contained_pt3_real_splat_asset_path(
        candidate,
        project_id=project_id,
        part_id=part_id,
    )
    if asset_path is None:
        return None
    # Do not recursively retain prior attempts inside the fallback record.
    retained_asset = {
        key: value
        for key, value in candidate.items()
        if key != "previous_ready_asset"
    }
    retained_asset["asset_path"] = str(asset_path)
    retained_asset["asset_url"] = (
        f"/api/projects/{project_id}/parts/{part_id}/"
        f"real-gaussian-splat-assets/{candidate.get('cache_key')}"
    )
    return retained_asset


def _pt3_real_splat_asset_for_cache(asset: object, cache_key: str) -> dict:
    """Resolve the current asset, or the last good asset during recompute."""

    if not isinstance(asset, dict):
        return {}
    if (
        str(asset.get("status") or "").strip().lower() in {"", "ready"}
        and asset.get("cache_key") == cache_key
    ):
        return asset
    previous = asset.get("previous_ready_asset")
    if (
        asset.get("status") == "pending"
        and isinstance(previous, dict)
        and str(previous.get("status") or "").strip().lower() in {"", "ready"}
        and previous.get("cache_key") == cache_key
    ):
        return previous
    return {}


def _public_pt3_real_splat_error(exc: Exception) -> str:
    message = str(exc).strip() or exc.__class__.__name__
    replacements = [(str(REPO_ROOT.resolve()), "<repository>")]
    try:
        replacements.insert(0, (str(_pt3_cache_root().resolve()), "<cache>"))
    except (_PT3CacheUnavailableError, OSError, RuntimeError):
        pass
    for private_path, label in replacements:
        message = message.replace(private_path, label)

    # Trusted providers can still raise an OSError or validation error naming
    # a model/data path outside VISTA's repository and cache. Keep the useful
    # error text while removing quoted and tokenized POSIX, Windows, and UNC
    # absolute paths before it reaches status polling clients.
    message = re.sub(
        r"(?P<quote>['\"])(?:/|[A-Za-z]:[\\/]|\\\\)[^'\"]+(?P=quote)",
        lambda match: f"{match.group('quote')}<path>{match.group('quote')}",
        message,
    )
    message = re.sub(
        r"(^|[\s(=\"'])(?:/[^\s'\"<>]+|[A-Za-z]:[\\/][^\s'\"<>]+|\\\\[^\s'\"<>]+)",
        lambda match: f"{match.group(1)}<path>",
        message,
    )
    return message[:1000]


def _contained_pt3_simplified_splat_asset_path(
    asset: object,
    *,
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    cache_key: Optional[str] = None,
) -> Optional[Path]:
    """Return a readable Simplified asset only when its metadata is cache-contained."""

    if not isinstance(asset, dict):
        return None
    declared_cache_key = str(asset.get("cache_key") or "").strip()
    if (
        not declared_cache_key
        or len(declared_cache_key) > 255
        or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", declared_cache_key) is None
        or (cache_key is not None and declared_cache_key != cache_key)
    ):
        return None
    raw_path = str(asset.get("asset_path") or "").strip()
    if not raw_path:
        return None
    try:
        expected_root = _existing_pt3_cache_directory(
            "pt3_splat_assets",
            project_id,
            part_id,
        )
        asset_path = Path(raw_path).expanduser().resolve()
    except (OSError, RuntimeError):
        return None
    if (
        asset_path.parent != expected_root
        or asset_path.suffix.lower() not in PT3_SIMPLIFIED_SPLAT_EXTENSIONS
        or asset_path.stem != declared_cache_key
        or not asset_path.is_file()
    ):
        return None
    return asset_path


def _public_pt3_simplified_splat_asset(asset: object) -> dict:
    """Strip server filesystem locations from Simplified asset responses."""

    if not isinstance(asset, dict):
        return {}
    public_asset = {
        key: value
        for key, value in asset.items()
        if key not in {"asset_path", "source_files"}
    }
    conversion_parameters = public_asset.get("conversion_parameters")
    if isinstance(conversion_parameters, dict):
        public_parameters = dict(conversion_parameters)
        public_parameters.pop("source_path", None)
        public_asset["conversion_parameters"] = public_parameters
    return public_asset


def _splat_status_from_metadata(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    metadata: object,
    *,
    volume_stack_id: Optional[str] = None,
) -> schemas.PT3SplatGenerationStatus:
    safe_metadata = metadata if isinstance(metadata, dict) else {}
    asset = safe_metadata.get("pt3_splat_asset") if isinstance(safe_metadata.get("pt3_splat_asset"), dict) else {}
    requested_stack = str(volume_stack_id).strip() if volume_stack_id else ""
    asset_stack = str(asset.get("volume_stack_id") or safe_metadata.get("volume_stack_id") or "").strip()
    if requested_stack and asset_stack and requested_stack != asset_stack:
        return schemas.PT3SplatGenerationStatus(status="missing", part_id=part_id, volume_stack_id=requested_stack)
    raw_status = str(asset.get("status") or "").strip().lower()
    asset_path = _contained_pt3_simplified_splat_asset_path(
        asset,
        project_id=project_id,
        part_id=part_id,
    )
    if raw_status in {"pending", "failed"}:
        status_value = raw_status
    elif raw_status in {"", "ready"} and asset_path is not None:
        status_value = "ready"
    else:
        status_value = "missing"
    public_asset = _public_pt3_simplified_splat_asset(asset)
    asset_url = None
    if status_value == "ready":
        asset_url = (
            f"/api/projects/{project_id}/parts/{part_id}/volume-splat-assets/"
            f"{asset.get('cache_key')}"
        )
        public_asset["asset_url"] = asset_url
    else:
        public_asset.pop("asset_url", None)
    return schemas.PT3SplatGenerationStatus(
        status=status_value,
        part_id=part_id,
        volume_stack_id=requested_stack or asset_stack or None,
        asset_url=asset_url,
        cache_key=asset.get("cache_key"),
        output_format=asset.get("output_format"),
        splat_count=asset.get("splat_count") if status_value == "ready" else None,
        error=asset.get("error") if status_value == "failed" else None,
        metadata=public_asset,
    )


async def _run_pt3_splat_generation_job(
    *,
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    source_path_text: str,
    payload_data: dict,
    job_id: str,
    requested_by: str,
    job_db: AsyncSession,
):
    compute_slot_acquired = False
    generated_asset_path: Optional[Path] = None
    try:
        # Refresh under a row lock before doing any CPU work. The task-owned
        # session retains identity-mapped rows, so populate_existing is required
        # to observe a newer recompute that superseded this background task.
        await job_db.rollback()
        admission_result = await job_db.execute(
            select(models.InspectionPart)
            .where(
                models.InspectionPart.project_id == project_id,
                models.InspectionPart.id == part_id,
            )
            .execution_options(populate_existing=True)
            .with_for_update()
        )
        part = admission_result.scalar_one_or_none()
        if not part:
            await job_db.rollback()
            return
        metadata = part.metadata_json if isinstance(part.metadata_json, dict) else {}
        admitted_asset = metadata.get("pt3_splat_asset")
        if not isinstance(admitted_asset, dict) or admitted_asset.get("job_id") != job_id:
            await job_db.rollback()
            return
        await job_db.rollback()

        await _acquire_pt3_splat_compute_slot()
        compute_slot_acquired = True

        # This job may have waited behind another Real or Simplified fit. Check
        # ownership again before decoding the volume or allocating splat state.
        await job_db.rollback()
        compute_result = await job_db.execute(
            select(models.InspectionPart)
            .where(
                models.InspectionPart.project_id == project_id,
                models.InspectionPart.id == part_id,
            )
            .execution_options(populate_existing=True)
            .with_for_update()
        )
        part = compute_result.scalar_one_or_none()
        if not part:
            await job_db.rollback()
            return
        metadata = part.metadata_json if isinstance(part.metadata_json, dict) else {}
        compute_asset = metadata.get("pt3_splat_asset")
        if not isinstance(compute_asset, dict) or compute_asset.get("job_id") != job_id:
            await job_db.rollback()
            return
        metadata = copy.deepcopy(metadata)
        await job_db.rollback()

        try:
            payload = schemas.PT3SplatConversionRequest(**payload_data)
            source_path = Path(source_path_text).expanduser().resolve()
            volume_info = load_volume(
                source_path,
                limits=REFERENCE_VOLUME_READ_LIMITS,
            )
            params = SplatConversionParams(
                transfer_function=TransferFunction(
                    **payload.transfer_function.model_dump()
                ),
                downsample=payload.downsample,
                max_splats=payload.max_splats,
                output_format=payload.output_format,
            )
            volume_stack_id = (
                payload.volume_stack_id
                or metadata.get("volume_stack_id")
                # rollback() expires ORM instances even when the session uses
                # expire_on_commit=False. Keep background work on the immutable
                # function argument instead of triggering an async lazy load.
                or str(part_id)
            )
            output_dir = _prepare_pt3_cache_directory(
                "pt3_splat_assets",
                project_id,
                part_id,
            )
            asset = await asyncio.to_thread(
                convert_volume_to_splat_asset,
                volume_info,
                volume_stack_id=str(volume_stack_id),
                source_image_ids=payload.source_image_ids,
                params=params,
                output_dir=output_dir,
                segmentation=metadata.get("pt3_segmentation")
                if isinstance(metadata.get("pt3_segmentation"), dict)
                else None,
            )
            generated_asset_path = Path(asset.path)
            asset_url = (
                f"/api/projects/{project_id}/parts/{part_id}/"
                f"volume-splat-assets/{asset.cache_key}"
            )
            asset_metadata = {
                **asset.metadata,
                "job_id": job_id,
                "status": "ready",
                "stage": "ready",
                "progress_percent": 100,
                "asset_path": asset.path,
                "asset_url": asset_url,
                "output_format": asset.output_format,
                "splat_count": asset.splat_count,
                "conversion_parameters": payload.model_dump(mode="json"),
            }
        except Exception as exc:  # failures remain visible to polling clients
            asset_metadata = {
                "job_id": job_id,
                "status": "failed",
                "stage": "failed",
                "progress_percent": 0,
                "volume_stack_id": payload_data.get("volume_stack_id"),
                "source_image_ids": payload_data.get("source_image_ids") or [],
                "error": _public_pt3_real_splat_error(exc),
                "failed_at": datetime.now(timezone.utc).isoformat(),
            }

        # Compare-and-swap at publication so an older completion or failure can
        # never replace metadata owned by a newer configuration request.
        await job_db.rollback()
        latest_result = await job_db.execute(
            select(models.InspectionPart)
            .where(
                models.InspectionPart.project_id == project_id,
                models.InspectionPart.id == part_id,
            )
            .execution_options(populate_existing=True)
            .with_for_update()
        )
        latest_part = latest_result.scalar_one_or_none()
        if not latest_part:
            await job_db.rollback()
            _prune_stale_pt3_simplified_splat_output(
                generated_asset_path,
                project_id=project_id,
                part_id=part_id,
                latest_asset={},
            )
            return
        latest_metadata = (
            latest_part.metadata_json
            if isinstance(latest_part.metadata_json, dict)
            else {}
        )
        latest_asset = latest_metadata.get("pt3_splat_asset")
        if not isinstance(latest_asset, dict) or latest_asset.get("job_id") != job_id:
            _prune_stale_pt3_simplified_splat_output(
                generated_asset_path,
                project_id=project_id,
                part_id=part_id,
                latest_asset=latest_asset,
            )
            await job_db.rollback()
            return
        published_part = await crud.update_inspection_part_metadata(
            db=job_db,
            project_id=project_id,
            part_id=part_id,
            metadata_patch={"pt3_splat_asset": asset_metadata},
            updated_by=requested_by,
        )
        if (
            published_part is not None
            and asset_metadata.get("status") == "ready"
            and generated_asset_path is not None
        ):
            # The shared semaphore is still held, so no other splat converter
            # can be creating a not-yet-published file while prior keys are
            # pruned for this one-asset-per-part lifecycle.
            _prune_pt3_simplified_splat_outputs(
                project_id=project_id,
                part_id=part_id,
                keep_asset_path=generated_asset_path,
            )
    finally:
        if compute_slot_acquired:
            _PT3_SPLAT_COMPUTE_SEMAPHORE.release()
        _cleanup_pt3_simplified_splat_job_input(
            project_id=project_id,
            part_id=part_id,
            job_id=job_id,
        )


async def _run_pt3_splat_generation_job_in_session(
    *,
    session_bind: Any,
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    source_path_text: str,
    payload_data: dict,
    job_id: str,
    requested_by: str,
) -> None:
    """Run a Simplified fit in a session owned by the background task."""

    async with AsyncSession(
        bind=session_bind,
        expire_on_commit=False,
        autoflush=False,
    ) as job_db:
        await _run_pt3_splat_generation_job(
            project_id=project_id,
            part_id=part_id,
            source_path_text=source_path_text,
            payload_data=payload_data,
            job_id=job_id,
            requested_by=requested_by,
            job_db=job_db,
        )


@router.post(
    "/projects/{project_id}/parts/{part_id}/volume-splat-assets",
    response_model=schemas.PT3SplatGenerationStatus,
)
async def create_pt3_volume_splat_asset(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    payload: schemas.PT3SplatConversionRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    project = await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    if project.project_type != "PT3":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Volume splat assets are only supported for PT3 projects")

    part = await crud.get_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")

    if payload.source_path is not None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                "source_path is not accepted for project-part conversion; "
                "attach source images to the part and let the server materialize them"
            ),
        )
    materialization_part = SimpleNamespace(
        id=part.id,
        metadata_json=copy.deepcopy(
            part.metadata_json if isinstance(part.metadata_json, dict) else {}
        ),
    )
    await db.rollback()
    job_id = str(uuid.uuid4())
    try:
        source_path, inferred_source_image_ids = await _materialize_part_volume_stack(
            project_id=project_id,
            part=materialization_part,
            db=db,
            materialization_key=job_id,
        )
        await db.rollback()
        source_image_ids = list(inferred_source_image_ids)
        if payload.source_image_ids and payload.source_image_ids != source_image_ids:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="source_image_ids must exactly match the server-inferred image stack",
            )

        locked_result = await db.execute(
            select(models.InspectionPart)
            .where(
                models.InspectionPart.project_id == project_id,
                models.InspectionPart.id == part_id,
            )
            .execution_options(populate_existing=True)
            .with_for_update()
        )
        current_part = locked_result.scalar_one_or_none()
        if not current_part:
            await db.rollback()
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Inspection part not found",
            )
        current_metadata = (
            current_part.metadata_json
            if isinstance(current_part.metadata_json, dict)
            else {}
        )
        volume_stack_id = (
            payload.volume_stack_id
            or current_metadata.get("volume_stack_id")
            or str(current_part.id)
        )
        conversion_parameters = payload.model_dump(mode="json")
        conversion_parameters["source_path"] = None
        conversion_parameters["source_image_ids"] = source_image_ids
        pending_metadata = {
            "job_id": job_id,
            "status": "pending",
            "stage": "queued",
            "progress_percent": 0,
            "volume_stack_id": str(volume_stack_id),
            "source_image_ids": source_image_ids,
            "requested_at": datetime.now(timezone.utc).isoformat(),
            "conversion_parameters": conversion_parameters,
        }
        updated_part = await crud.update_inspection_part_metadata(
            db=db,
            project_id=project_id,
            part_id=part_id,
            metadata_patch={"pt3_splat_asset": pending_metadata},
            updated_by=current_user.email,
        )
        if not updated_part:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Inspection part not found",
            )
    except Exception:
        await db.rollback()
        _cleanup_pt3_simplified_splat_job_input(
            project_id=project_id,
            part_id=part_id,
            job_id=job_id,
        )
        raise

    background_tasks.add_task(
        _run_pt3_splat_generation_job_in_session,
        session_bind=db.bind,
        project_id=project_id,
        part_id=part_id,
        source_path_text=source_path,
        payload_data=conversion_parameters,
        job_id=job_id,
        requested_by=current_user.email,
    )
    return _splat_status_from_metadata(
        project_id,
        part_id,
        {"pt3_splat_asset": pending_metadata},
        volume_stack_id=str(volume_stack_id),
    )


@router.get(
    "/projects/{project_id}/parts/{part_id}/volume-splat-assets/status",
    response_model=schemas.PT3SplatGenerationStatus,
)
async def get_pt3_part_volume_splat_status(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    part = await crud.get_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")
    return _splat_status_from_metadata(project_id, part.id, part.metadata_json)


def _real_splat_status_from_metadata(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    metadata: object,
    *,
    volume_stack_id: Optional[str] = None,
) -> schemas.PT3RealSplatGenerationStatus:
    safe_metadata = metadata if isinstance(metadata, dict) else {}
    asset = safe_metadata.get("pt3_real_splat_asset") if isinstance(safe_metadata.get("pt3_real_splat_asset"), dict) else {}
    requested_stack = str(volume_stack_id).strip() if volume_stack_id else ""
    asset_stack = str(asset.get("volume_stack_id") or safe_metadata.get("volume_stack_id") or "").strip()
    if requested_stack and asset_stack and requested_stack != asset_stack:
        return schemas.PT3RealSplatGenerationStatus(status="missing", part_id=part_id, volume_stack_id=requested_stack)
    raw_status = str(asset.get("status") or "").strip().lower()
    asset_path = _contained_pt3_real_splat_asset_path(
        asset,
        project_id=project_id,
        part_id=part_id,
    )
    if raw_status in {"pending", "failed"}:
        status_value = raw_status
    elif raw_status in {"", "ready"} and asset_path is not None:
        status_value = "ready"
    else:
        status_value = "missing"
    # The nested fallback is an internal lifecycle record and contains the
    # server cache path. Keep it out of both POST and polling responses.
    public_asset = {
        key: value
        for key, value in asset.items()
        if key
        not in {"asset_path", "asset_url", "previous_ready_asset", "source_files"}
    }
    asset_url = None
    if status_value == "ready":
        asset_url = (
            f"/api/projects/{project_id}/parts/{part_id}/"
            f"real-gaussian-splat-assets/{asset.get('cache_key')}"
        )
        public_asset["asset_url"] = asset_url
    return schemas.PT3RealSplatGenerationStatus(
        status=status_value,
        job_id=asset.get("job_id"),
        part_id=part_id,
        volume_stack_id=requested_stack or asset_stack or None,
        asset_url=asset_url,
        cache_key=asset.get("cache_key"),
        splat_count=asset.get("splat_count") if status_value == "ready" else None,
        progress_percent=float(asset.get("progress_percent") or (100 if status_value == "ready" else 0)),
        stage=str(asset.get("stage") or status_value),
        error=(asset.get("error") if status_value == "failed" else None),
        metadata={
            **public_asset,
            "provider_configured": bool(str(settings.PT3_REAL_3DGS_PROVIDER or "").strip()),
            "voxel_direct_available": True,
        },
    )


def _pt3_voxel_geometry(volume_info, metadata: dict) -> dict:
    declared = metadata.get("pt3_volume_geometry") if isinstance(metadata.get("pt3_volume_geometry"), dict) else {}
    spacing = declared.get("spacing") or metadata.get("spacing") or metadata.get("voxel_spacing") or [1.0, 1.0, 1.0]
    origin = declared.get("origin") or metadata.get("origin") or [0.0, 0.0, 0.0]
    direction = declared.get("direction") or metadata.get("direction") or [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]
    scalar_range = declared.get("scalar_range") or metadata.get("scalar_range") or metadata.get("scalarRange")
    return {
        "format": volume_info.format,
        "shape_zyx": list(volume_info.shape),
        "dtype": volume_info.dtype,
        "channel_count": volume_info.channel_count,
        "color_mode": volume_info.color_mode,
        "spacing_xyz": list(spacing),
        "origin_xyz": list(origin),
        "direction": list(direction),
        "scalar_range": list(scalar_range) if isinstance(scalar_range, (list, tuple)) else None,
    }


async def _update_pt3_real_splat_job_progress(
    *,
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    job_id: str,
    progress_percent: float,
    stage: str,
    job_db: AsyncSession,
) -> bool:
    try:
        safe_progress = min(99.0, max(0.0, float(progress_percent)))
    except (TypeError, ValueError):
        return False
    # Progress sessions use expire_on_commit=False. End any earlier transaction
    # and force the locked SELECT to overwrite its identity-mapped InspectionPart;
    # otherwise an older worker can keep seeing its own stale job_id after a
    # newer recompute has already published pending metadata.
    await job_db.rollback()
    result = await job_db.execute(
        select(models.InspectionPart)
        .where(models.InspectionPart.project_id == project_id, models.InspectionPart.id == part_id)
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    part = result.scalar_one_or_none()
    if not part:
        await job_db.rollback()
        return False
    metadata = part.metadata_json if isinstance(part.metadata_json, dict) else {}
    asset = metadata.get("pt3_real_splat_asset")
    if (
        not isinstance(asset, dict)
        or asset.get("job_id") != job_id
        or str(asset.get("status") or "").strip().lower() != "pending"
    ):
        await job_db.rollback()
        return False
    part.metadata_json = {
        **metadata,
        "pt3_real_splat_asset": {
            **asset,
            "status": "pending",
            "stage": str(stage or "optimizing")[:120],
            "progress_percent": safe_progress,
            "progress_updated_at": datetime.now(timezone.utc).isoformat(),
        },
    }
    await job_db.commit()
    return True


async def _update_pt3_real_splat_job_progress_in_session(
    *,
    session_bind: Any,
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    job_id: str,
    progress_percent: float,
    stage: str,
) -> bool:
    """Publish one progress update in an independent, short-lived session."""

    async with AsyncSession(
        bind=session_bind,
        expire_on_commit=False,
        autoflush=False,
    ) as progress_db:
        return await _update_pt3_real_splat_job_progress(
            project_id=project_id,
            part_id=part_id,
            job_id=job_id,
            progress_percent=progress_percent,
            stage=stage,
            job_db=progress_db,
        )


async def _run_pt3_real_splat_optimization_job(
    *,
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    source_path_text: str,
    payload_data: dict,
    job_id: str,
    requested_by: str,
    job_db: AsyncSession,
):
    compute_slot_acquired = False
    try:
        part = await crud.get_inspection_part(db=job_db, project_id=project_id, part_id=part_id)
        if not part:
            _cleanup_pt3_real_splat_job_cache(
                project_id=project_id,
                part_id=part_id,
                job_id=job_id,
            )
            return
        initial_metadata = part.metadata_json if isinstance(part.metadata_json, dict) else {}
        initial_asset = initial_metadata.get("pt3_real_splat_asset")
        if not isinstance(initial_asset, dict) or initial_asset.get("job_id") != job_id:
            await job_db.rollback()
            _cleanup_pt3_real_splat_job_cache(
                project_id=project_id,
                part_id=part_id,
                job_id=job_id,
            )
            return
        await job_db.rollback()

        await _acquire_pt3_real_splat_compute_slot()
        compute_slot_acquired = True

        # A newer request may have superseded this job while it waited for the
        # process-local CPU slot. Refresh under lock before any volume decode or
        # optimization work begins.
        admission_result = await job_db.execute(
            select(models.InspectionPart)
            .where(
                models.InspectionPart.project_id == project_id,
                models.InspectionPart.id == part_id,
            )
            .execution_options(populate_existing=True)
            .with_for_update()
        )
        part = admission_result.scalar_one_or_none()
        if not part:
            await job_db.rollback()
            _cleanup_pt3_real_splat_job_cache(
                project_id=project_id,
                part_id=part_id,
                job_id=job_id,
            )
            return
        metadata = part.metadata_json if isinstance(part.metadata_json, dict) else {}
        admitted_asset = metadata.get("pt3_real_splat_asset")
        if not isinstance(admitted_asset, dict) or admitted_asset.get("job_id") != job_id:
            await job_db.rollback()
            _cleanup_pt3_real_splat_job_cache(
                project_id=project_id,
                part_id=part_id,
                job_id=job_id,
            )
            return
        # Keep only plain metadata after releasing the admission lock.
        metadata = copy.deepcopy(metadata)
        await job_db.rollback()

        payload = schemas.PT3RealSplatOptimizationRequest(**payload_data)
        volume_info = load_volume(
            Path(source_path_text).expanduser().resolve(),
            limits=REFERENCE_VOLUME_READ_LIMITS,
        )
        volume_geometry = _pt3_voxel_geometry(volume_info, metadata)
        # The admission rollback expires ``part``. Reading its ORM attributes
        # here can attempt async IO outside SQLAlchemy's greenlet bridge, so use
        # the immutable task argument as the canonical fallback identifier.
        volume_stack_id = (
            payload.volume_stack_id
            or metadata.get("volume_stack_id")
            or str(part_id)
        )
        output_dir = _prepare_pt3_cache_directory(
            "pt3_real_splat_assets",
            project_id,
            part_id,
            job_id,
        )
        loop = asyncio.get_running_loop()
        session_bind = job_db.bind

        def report_progress(progress_percent: float, stage: str = "optimizing") -> None:
            future = asyncio.run_coroutine_threadsafe(
                _update_pt3_real_splat_job_progress_in_session(
                    session_bind=session_bind,
                    project_id=project_id,
                    part_id=part_id,
                    job_id=job_id,
                    progress_percent=progress_percent,
                    stage=stage,
                ),
                loop,
            )
            try:
                progress_published = future.result(
                    timeout=PT3_REAL_SPLAT_PROGRESS_TIMEOUT_SECONDS
                )
            except TimeoutError:
                # Do not leave a timed-out update running after the optimizer
                # unwinds into final publication. Its independent session makes
                # cancellation safe even if the database call is slow to stop.
                future.cancel()
                raise
            if progress_published is not True:
                raise _PT3RealSplatJobSuperseded()

        asset = await asyncio.to_thread(
            optimize_real_gaussian_splat_asset,
            provider_path=str(settings.PT3_REAL_3DGS_PROVIDER or ""),
            volume_stack_id=str(volume_stack_id),
            source_image_ids=payload.source_image_ids,
            source_files=volume_info.source_files,
            cameras=[camera.model_dump(mode="json") for camera in payload.cameras],
            parameters=payload.parameters.model_dump(mode="json"),
            fit_mode=payload.fit_mode,
            volume_geometry=volume_geometry,
            # Preserve malformed declarations so the shared strict normalizer
            # rejects them instead of silently treating them as unsegmented.
            segmentation=metadata.get("pt3_segmentation"),
            output_dir=output_dir,
            progress_callback=report_progress,
        )
        asset_url = f"/api/projects/{project_id}/parts/{part_id}/real-gaussian-splat-assets/{asset.cache_key}"
        asset_metadata = {
            **asset.metadata,
            "job_id": job_id,
            "status": "ready",
            "stage": "ready",
            "progress_percent": 100,
            "asset_path": asset.path,
            "asset_url": asset_url,
            "volume_stack_id": str(volume_stack_id),
            "source_image_ids": list(payload.source_image_ids),
            "splat_count": asset.splat_count,
            "request_parameters": payload.parameters.model_dump(mode="json"),
            "fit_mode": payload.fit_mode,
            "camera_view_binding": payload_data.get("camera_view_binding") or "none",
        }
        if payload.fit_mode != "voxel_direct":
            asset_metadata["optimization_parameters"] = payload.parameters.model_dump(mode="json")
    except _PT3RealSplatJobSuperseded:
        # Supersession is a normal internal cancellation path. Do not publish a
        # failure or expose implementation details to the polling client.
        _cleanup_pt3_real_splat_job_cache(
            project_id=project_id,
            part_id=part_id,
            job_id=job_id,
        )
        return
    except Exception as exc:  # provider failures must remain visible to polling clients
        asset_metadata = {
            "job_id": job_id,
            "status": "failed",
            "stage": "failed",
            "progress_percent": 0,
            "representation": "real_3dgs",
            "fit_mode": payload_data.get("fit_mode") or "voxel_direct",
            "camera_view_binding": payload_data.get("camera_view_binding") or "none",
            "volume_stack_id": payload_data.get("volume_stack_id"),
            "source_image_ids": payload_data.get("source_image_ids") or [],
            "error": _public_pt3_real_splat_error(exc),
            "failed_at": datetime.now(timezone.utc).isoformat(),
        }
    finally:
        if compute_slot_acquired:
            _PT3_REAL_SPLAT_COMPUTE_SEMAPHORE.release()
    # The optimizer may not report progress, and a failed preflight can leave
    # the initial read transaction open. Always begin publication from a fresh
    # transaction and refresh the identity-mapped row while taking its lock.
    await job_db.rollback()
    latest_result = await job_db.execute(
        select(models.InspectionPart)
        .where(models.InspectionPart.project_id == project_id, models.InspectionPart.id == part_id)
        .execution_options(populate_existing=True)
        .with_for_update()
    )
    latest_part = latest_result.scalar_one_or_none()
    if not latest_part:
        await job_db.rollback()
        _cleanup_pt3_real_splat_job_cache(
            project_id=project_id, part_id=part_id, job_id=job_id
        )
        return
    latest_metadata = latest_part.metadata_json if isinstance(latest_part.metadata_json, dict) else {}
    latest_asset = latest_metadata.get("pt3_real_splat_asset")
    if not isinstance(latest_asset, dict) or latest_asset.get("job_id") != job_id:
        await job_db.rollback()
        _cleanup_pt3_real_splat_job_cache(
            project_id=project_id, part_id=part_id, job_id=job_id
        )
        return
    job_succeeded = asset_metadata.get("status") == "ready"
    if not job_succeeded:
        previous_ready_asset = _usable_previous_pt3_real_splat_asset(
            latest_asset,
            project_id=project_id,
            part_id=part_id,
        )
        if previous_ready_asset:
            # A recompute is replace-on-success. If it fails, keep serving the
            # last published canonical asset and expose the failed attempt as
            # diagnostic metadata rather than turning a good asset into a 404.
            asset_metadata = {
                **previous_ready_asset,
                "last_recompute_status": "failed",
                "last_recompute_job_id": job_id,
                "last_recompute_error": asset_metadata.get("error"),
                "last_recompute_failed_at": asset_metadata.get("failed_at"),
            }
    await crud.update_inspection_part_metadata(
        db=job_db,
        project_id=project_id,
        part_id=part_id,
        metadata_patch={"pt3_real_splat_asset": asset_metadata},
        updated_by=requested_by,
    )
    if job_succeeded:
        _cleanup_pt3_real_splat_job_cache(
            project_id=project_id,
            part_id=part_id,
            job_id=job_id,
            remove_output=False,
        )
        _prune_pt3_real_splat_job_cache(
            project_id=project_id,
            part_id=part_id,
            keep_output_job_id=job_id,
        )
    else:
        _cleanup_pt3_real_splat_job_cache(
            project_id=project_id, part_id=part_id, job_id=job_id
        )


async def _run_pt3_real_splat_optimization_job_in_session(
    *,
    session_bind: Any,
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    source_path_text: str,
    payload_data: dict,
    job_id: str,
    requested_by: str,
) -> None:
    """Run a Real 3DGS fit in a session owned by the background task."""

    async with AsyncSession(
        bind=session_bind,
        expire_on_commit=False,
        autoflush=False,
    ) as job_db:
        await _run_pt3_real_splat_optimization_job(
            project_id=project_id,
            part_id=part_id,
            source_path_text=source_path_text,
            payload_data=payload_data,
            job_id=job_id,
            requested_by=requested_by,
            job_db=job_db,
        )


@router.post(
    "/projects/{project_id}/parts/{part_id}/real-gaussian-splat-assets",
    response_model=schemas.PT3RealSplatGenerationStatus,
    status_code=status.HTTP_202_ACCEPTED,
)
async def create_pt3_real_gaussian_splat_asset(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    payload: schemas.PT3RealSplatOptimizationRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    project = await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    if project.project_type != "PT3":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Real Gaussian splat assets are only supported for PT3 projects")
    if payload.fit_mode != "voxel_direct" and not str(settings.PT3_REAL_3DGS_PROVIDER or "").strip():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"{payload.fit_mode} requires a configured Real 3DGS provider",
        )

    part = await crud.get_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")

    # Release the request's initial read transaction before object-store I/O.
    # Keep only an immutable JSON snapshot for locating the server-owned inputs;
    # the authoritative part row is reloaded and locked after materialization.
    materialization_part = SimpleNamespace(
        id=part.id,
        metadata_json=copy.deepcopy(
            part.metadata_json if isinstance(part.metadata_json, dict) else {}
        ),
    )
    await db.rollback()
    job_id = str(uuid.uuid4())
    try:
        source_path, inferred_source_image_ids = await _materialize_part_volume_stack(
            project_id=project_id,
            part=materialization_part,
            db=db,
            materialization_key=job_id,
        )
        # Image lookups during materialization opened a new read transaction.
        # End it so the following lock observes a job that may have published
        # while the object-store copy was in flight.
        await db.rollback()
        source_image_ids = list(inferred_source_image_ids)
        if payload.source_image_ids and payload.source_image_ids != source_image_ids:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                detail="source_image_ids must exactly match the server-inferred image stack",
            )
        camera_view_binding = "none"
        if payload.fit_mode != "voxel_direct":
            camera_image_ids = {camera.image_id for camera in payload.cameras}
            camera_view_binding = _pt3_provider_camera_view_binding(
                source_image_ids=source_image_ids,
                camera_image_ids=camera_image_ids,
            )

        locked_result = await db.execute(
            select(models.InspectionPart)
            .where(
                models.InspectionPart.project_id == project_id,
                models.InspectionPart.id == part_id,
            )
            .execution_options(populate_existing=True)
            .with_for_update()
        )
        current_part = locked_result.scalar_one_or_none()
        if not current_part:
            await db.rollback()
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Inspection part not found",
            )

        current_metadata = (
            current_part.metadata_json
            if isinstance(current_part.metadata_json, dict)
            else {}
        )
        volume_stack_id = (
            payload.volume_stack_id
            or current_metadata.get("volume_stack_id")
            or str(current_part.id)
        )
        payload_data = payload.model_dump(mode="json")
        payload_data["source_image_ids"] = source_image_ids
        payload_data["camera_view_binding"] = camera_view_binding
        pending_metadata = {
            "job_id": job_id,
            "status": "pending",
            "stage": "queued",
            "progress_percent": 0,
            "representation": "real_3dgs",
            "fit_mode": payload.fit_mode,
            "camera_view_binding": camera_view_binding,
            "volume_stack_id": str(volume_stack_id),
            "source_image_ids": source_image_ids,
            "requested_at": datetime.now(timezone.utc).isoformat(),
            "request_parameters": payload.parameters.model_dump(mode="json"),
        }
        previous_ready_asset = _usable_previous_pt3_real_splat_asset(
            current_metadata.get("pt3_real_splat_asset"),
            project_id=project_id,
            part_id=part_id,
        )
        if previous_ready_asset:
            pending_metadata["previous_ready_asset"] = previous_ready_asset
        updated_part = await crud.update_inspection_part_metadata(
            db=db,
            project_id=project_id,
            part_id=part_id,
            metadata_patch={"pt3_real_splat_asset": pending_metadata},
            updated_by=current_user.email,
        )
        if not updated_part:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Inspection part not found",
            )
    except Exception:
        await db.rollback()
        _cleanup_pt3_real_splat_job_cache(
            project_id=project_id,
            part_id=part_id,
            job_id=job_id,
            remove_output=False,
        )
        raise
    background_tasks.add_task(
        _run_pt3_real_splat_optimization_job_in_session,
        session_bind=db.bind,
        project_id=project_id,
        part_id=part_id,
        source_path_text=source_path,
        payload_data=payload_data,
        job_id=job_id,
        requested_by=current_user.email,
    )
    return _real_splat_status_from_metadata(
        project_id,
        part_id,
        {"pt3_real_splat_asset": pending_metadata},
        volume_stack_id=str(volume_stack_id),
    )


@router.get(
    "/projects/{project_id}/parts/{part_id}/real-gaussian-splat-assets/status",
    response_model=schemas.PT3RealSplatGenerationStatus,
)
async def get_pt3_real_gaussian_splat_status(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    part = await crud.get_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")
    return _real_splat_status_from_metadata(project_id, part.id, part.metadata_json)


@router.get("/projects/{project_id}/parts/{part_id}/real-gaussian-splat-assets/{cache_key}")
async def get_pt3_real_gaussian_splat_asset(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    cache_key: str,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    part = await crud.get_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")
    metadata = part.metadata_json if isinstance(part.metadata_json, dict) else {}
    lifecycle_asset = metadata.get("pt3_real_splat_asset") if isinstance(metadata.get("pt3_real_splat_asset"), dict) else {}
    asset = _pt3_real_splat_asset_for_cache(lifecycle_asset, cache_key)
    asset_path = _contained_pt3_real_splat_asset_path(
        asset,
        project_id=project_id,
        part_id=part_id,
        cache_key=cache_key,
    )
    if asset_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Real Gaussian splat asset file not found")
    return FileResponse(asset_path, media_type="application/json", filename=asset_path.name)


@router.get(
    "/projects/{project_id}/volume-stacks/{volume_stack_id}/splat-status",
    response_model=schemas.PT3SplatGenerationStatus,
)
async def get_pt3_volume_stack_splat_status(
    project_id: uuid.UUID,
    volume_stack_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    result = await db.execute(select(models.InspectionPart).where(models.InspectionPart.project_id == project_id))
    for part in result.scalars().all():
        status_payload = _splat_status_from_metadata(
            project_id,
            part.id,
            part.metadata_json,
            volume_stack_id=volume_stack_id,
        )
        if status_payload.status != "missing":
            return status_payload
        metadata = part.metadata_json if isinstance(part.metadata_json, dict) else {}
        if str(metadata.get("volume_stack_id") or "").strip() == volume_stack_id:
            return status_payload
    return schemas.PT3SplatGenerationStatus(status="missing", volume_stack_id=volume_stack_id)


@router.get("/projects/{project_id}/parts/{part_id}/volume-splat-assets/{cache_key}")
async def get_pt3_volume_splat_asset(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    cache_key: str,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    part = await crud.get_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")
    metadata = part.metadata_json if isinstance(part.metadata_json, dict) else {}
    asset = metadata.get("pt3_splat_asset") if isinstance(metadata.get("pt3_splat_asset"), dict) else {}
    raw_status = str(asset.get("status") or "").strip().lower()
    if raw_status not in {"", "ready"}:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Volume splat asset not found")
    asset_path = _contained_pt3_simplified_splat_asset_path(
        asset,
        project_id=project_id,
        part_id=part_id,
        cache_key=cache_key,
    )
    if asset_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Volume splat asset file not found")
    media_type = "application/json" if asset_path.suffix.lower() in {".json", ".splat"} else "application/octet-stream"
    return FileResponse(asset_path, media_type=media_type, filename=asset_path.name)


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


@router.delete("/projects/{project_id}/parts/{part_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_inspection_part(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    deleted = await crud.delete_inspection_part(
        db=db,
        project_id=project_id,
        part_id=part_id,
        deleted_by=current_user.email,
    )
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")
    return None


@router.post(
    "/projects/{project_id}/parts/image-assignments",
    response_model=schemas.InspectionPartImageAssignmentResponse,
)
async def assign_image_to_part(
    project_id: uuid.UUID,
    payload: schemas.InspectionPartImageAssignmentRequest,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    target_part = None
    if payload.to_part_id:
        target_part = await crud.get_inspection_part(db=db, project_id=project_id, part_id=payload.to_part_id)
        if not target_part:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Target part not found")

    all_parts = await crud.list_inspection_parts(db=db, project_id=project_id)
    filename = payload.filename.strip()
    payload_image_id = payload.image_id
    if payload_image_id:
        image = await _get_active_project_image_by_id(
            db=db,
            project_id=project_id,
            image_id=payload_image_id,
        )
    else:
        image = await _get_active_project_image_by_filename(
            db=db,
            project_id=project_id,
            filename=filename,
        )
    if not image:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image not found")
    filename = image.filename
    source_entry = None
    from_part_id = None

    for part in all_parts:
        metadata = part.metadata_json if isinstance(part.metadata_json, dict) else {}
        source_images = metadata.get("source_images")
        if not isinstance(source_images, list):
            continue
        if any(
            _record_matches_image_identity(
                record,
                filename=filename,
                image_id=payload_image_id,
            )
            for record in source_images
        ):
            _, removed_entry = await _mutate_part_source_images_locked(
                db=db,
                project_id=project_id,
                part_id=part.id,
                transform=lambda fresh_records: _remove_source_image_records(
                    fresh_records,
                    filename=filename,
                    image_id=payload_image_id,
                    fallback_image_id=payload_image_id,
                ),
                updated_by=current_user.email,
            )
            if removed_entry is not None:
                source_entry = removed_entry
                from_part_id = part.id

    source_entry = _refresh_assigned_source_image_record(
        source_entry,
        _metadata_for_source_assignment(image),
    )

    if target_part:
        persisted_target, _ = await _mutate_part_source_images_locked(
            db=db,
            project_id=project_id,
            part_id=target_part.id,
            transform=lambda fresh_records: (
                _replace_source_image_record(
                    fresh_records,
                    entry=source_entry,
                    filename=filename,
                    image_id=payload_image_id,
                ),
                source_entry,
            ),
            updated_by=current_user.email,
        )
        if not persisted_target:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Target part not found",
            )

    return schemas.InspectionPartImageAssignmentResponse(
        project_id=project_id,
        filename=filename,
        from_part_id=from_part_id,
        to_part_id=payload.to_part_id,
    )


@router.post(
    "/projects/{project_id}/parts/overlay-assignments",
    response_model=schemas.InspectionOverlayAssignmentResponse,
)
async def assign_overlay_to_base_image(
    project_id: uuid.UUID,
    payload: schemas.InspectionOverlayAssignmentRequest,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    overlay_filename = payload.overlay_filename.strip()
    overlay_image_id = payload.overlay_image_id
    base_filename = payload.base_filename.strip() if payload.base_filename else None
    base_image_id = payload.base_image_id
    if base_filename == "":
        base_filename = None
    if base_filename and overlay_filename == base_filename and (not overlay_image_id or not base_image_id or overlay_image_id == base_image_id):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Overlay image cannot be assigned to itself")

    if overlay_image_id:
        overlay_image = await _get_active_project_image_by_id(db=db, project_id=project_id, image_id=overlay_image_id)
    else:
        overlay_image = await _get_active_project_image_by_filename(db=db, project_id=project_id, filename=overlay_filename)
    if not overlay_image:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Overlay image not found")
    overlay_filename = overlay_image.filename

    all_parts = await crud.list_inspection_parts(db=db, project_id=project_id)
    from_part_id = None
    overlay_entry = None

    for part in all_parts:
        metadata = part.metadata_json if isinstance(part.metadata_json, dict) else {}
        source_images = metadata.get("source_images")
        if not isinstance(source_images, list):
            continue
        if any(
            _record_matches_image_identity(
                record,
                filename=overlay_filename,
                image_id=overlay_image_id,
            )
            for record in source_images
        ):
            _, removed_entry = await _mutate_part_source_images_locked(
                db=db,
                project_id=project_id,
                part_id=part.id,
                transform=lambda fresh_records: _remove_source_image_records(
                    fresh_records,
                    filename=overlay_filename,
                    image_id=overlay_image_id,
                    fallback_image_id=overlay_image.id,
                ),
                updated_by=current_user.email,
            )
            if removed_entry is not None:
                overlay_entry = removed_entry
                from_part_id = part.id

    overlay_entry = _refresh_assigned_source_image_record(
        overlay_entry,
        _metadata_for_overlay_assignment(overlay_image),
    )
    overlay_entry = {**overlay_entry, "overlay": True}

    target_part = None
    base_entry = None
    if base_filename:
        if base_image_id:
            base_image = await _get_active_project_image_by_id(db=db, project_id=project_id, image_id=base_image_id)
        else:
            base_image = await _get_active_project_image_by_filename(db=db, project_id=project_id, filename=base_filename)
        if not base_image:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Base image not found")
        base_filename = base_image.filename
        for part in all_parts:
            metadata = part.metadata_json if isinstance(part.metadata_json, dict) else {}
            source_images = metadata.get("source_images")
            if not isinstance(source_images, list):
                continue
            for record in source_images:
                if _record_matches_image_identity(record, filename=base_filename, image_id=base_image_id) and not bool(record.get("overlay")):
                    target_part = part
                    base_entry = record
                    break
            if target_part:
                break
        if not target_part:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Base image is not assigned to an inspection part")

        def attach_overlay_to_fresh_base(fresh_records):
            fresh_base_entry = next(
                (
                    record
                    for record in fresh_records
                    if _record_matches_image_identity(
                        record,
                        filename=base_filename,
                        image_id=base_image_id,
                    )
                    and not bool(record.get("overlay"))
                ),
                None,
            )
            if fresh_base_entry is None:
                return fresh_records, None
            attached_overlay = {
                **overlay_entry,
                "overlay": True,
                "side": str(
                    fresh_base_entry.get("side")
                    or overlay_entry.get("side")
                    or ""
                ).strip().lower(),
                "modality": str(
                    overlay_entry.get("modality") or "overlay"
                ).strip().lower() or "overlay",
                "overlay_base_filename": base_filename,
                "overlay_base_image_id": str(
                    fresh_base_entry.get("image_id") or base_image.id
                ),
            }
            return (
                _replace_source_image_record(
                    fresh_records,
                    entry=attached_overlay,
                    filename=overlay_filename,
                    image_id=overlay_image_id,
                ),
                attached_overlay,
            )

        persisted_target, attached_overlay = await _mutate_part_source_images_locked(
            db=db,
            project_id=project_id,
            part_id=target_part.id,
            transform=attach_overlay_to_fresh_base,
            updated_by=current_user.email,
        )
        if not persisted_target:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Target part not found",
            )
        if attached_overlay is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Base image is no longer assigned to the inspection part",
            )
        overlay_entry = attached_overlay

    return schemas.InspectionOverlayAssignmentResponse(
        project_id=project_id,
        overlay_filename=overlay_filename,
        base_filename=base_filename,
        from_part_id=from_part_id,
        to_part_id=target_part.id if target_part else None,
    )


@router.post(
    "/projects/{project_id}/parts/batch-assignments",
    response_model=schemas.InspectionPartBatchAssignmentResponse,
)
async def assign_part_to_batch(
    project_id: uuid.UUID,
    payload: schemas.InspectionPartBatchAssignmentRequest,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    if payload.to_batch_id:
        batch = await crud.get_inspection_batch(db=db, batch_id=payload.to_batch_id)
        if not batch or batch.project_id != project_id:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="to_batch_id does not belong to this project")

    updated = await crud.update_inspection_part_batch_assignment(
        db=db,
        project_id=project_id,
        part_id=payload.part_id,
        to_batch_id=payload.to_batch_id,
        updated_by=current_user.email,
    )
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")
    return schemas.InspectionPartBatchAssignmentResponse(
        project_id=project_id,
        part_id=payload.part_id,
        to_batch_id=payload.to_batch_id,
    )


@router.patch("/projects/{project_id}/parts/{part_id}/source-images/{image_ref:path}", response_model=schemas.InspectionPart)
async def update_inspection_part_source_image(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    image_ref: str,
    payload: schemas.InspectionPartSourceImageUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    part = await _get_locked_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")
    metadata = part.metadata_json if isinstance(part.metadata_json, dict) else {}
    target_ref = str(image_ref or "").strip()
    found = False
    updated_collections: dict[str, list] = {}
    for collection_key in ("source_images", "analysis_outputs"):
        records = metadata.get(collection_key)
        if not isinstance(records, list):
            continue
        updated_records = []
        for record in records:
            if not isinstance(record, dict):
                updated_records.append(record)
                continue
            record_refs = {
                str(record.get("image_id") or "").strip(),
                str(record.get("filename") or "").strip(),
            }
            if target_ref and target_ref in record_refs:
                found = True
                next_record = dict(record)
                if payload.crop_subtitle is not None:
                    next_record["crop_subtitle"] = payload.crop_subtitle.strip()
                if payload.hidden is not None:
                    next_record["hidden"] = payload.hidden
                updated_records.append(next_record)
            else:
                updated_records.append(record)
        updated_collections[collection_key] = updated_records
    if not found:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Source image not found")
    updated_metadata = {**metadata, **updated_collections}
    normalized = (
        _rebuild_part_image_maps(updated_metadata)
        if "source_images" in updated_collections
        else updated_metadata
    )
    metadata_patch = {
        key: normalized[key]
        for key in (
            "source_images",
            "analysis_outputs",
            "configured_views",
            "modalities",
            "view_images",
            "overlay_images",
        )
        if key in updated_collections or (
            "source_images" in updated_collections
            and key in normalized
            and key != "analysis_outputs"
        )
    }
    updated = await crud.update_inspection_part_metadata(
        db=db,
        project_id=project_id,
        part_id=part_id,
        metadata_patch=metadata_patch,
        updated_by=current_user.email,
    )
    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")
    return _serialize_inspection_part(updated)

@router.patch("/projects/{project_id}/parts/{part_id}/manual-flag", response_model=schemas.InspectionPart)
async def update_inspection_part_manual_flag(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    payload: schemas.InspectionPartManualFlagUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    updated = await crud.update_inspection_part_metadata(
        db=db,
        project_id=project_id,
        part_id=part_id,
        metadata_patch={"manual_flagged": bool(payload.manual_flagged)},
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

    part = await _get_locked_inspection_part(db=db, project_id=project_id, part_id=part_id)
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
    "/projects/{project_id}/parts/{part_id}/slice-segmentation",
    response_model=schemas.InspectionSliceSegmentationResponse,
)
async def segment_inspection_slice(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    payload: schemas.InspectionSliceSegmentationRequest,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)

    part = await crud.get_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")
    if payload.method_id not in SLICE_SEGMENTATION_METHOD_IDS:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported slice segmentation method")

    image_bytes = _decode_slice_image_payload(payload.image_data_base64)
    workflow = _slice_segmentation_workflow(payload.method_id, payload.parameters)
    image_input = WorkflowImageInput(
        image_id=uuid.uuid4(),
        filename=payload.filename,
        content_type="image/png",
        data=image_bytes,
        metadata={
            "part_id": str(part_id),
            "axis": payload.axis,
            "slice_index": payload.slice_index,
        },
    )

    try:
        result = execute_image_workflow(workflow, [image_input])
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Slice segmentation failed: {exc}") from exc

    regions = _regions_from_toolbox_result(result)
    selected_region = _select_clicked_region(regions, payload.click_x, payload.click_y)
    summary = {
        "workflow_name": result.workflow_name,
        "image_count": result.image_count,
        "region_count": len(regions),
        "click": {"x": payload.click_x, "y": payload.click_y},
    }
    for node_result in result.node_results:
        if node_result.method_id == payload.method_id and isinstance(node_result.summary, dict):
            summary.update({key: value for key, value in node_result.summary.items() if key not in {"measurements", "detections"}})

    return {
        "run_id": result.run_id,
        "part_id": part_id,
        "axis": payload.axis,
        "slice_index": payload.slice_index,
        "method_id": payload.method_id,
        "status": result.status,
        "cached": False,
        "regions": regions,
        "selected_region": selected_region,
        "summary": summary,
        "warnings": result.warnings,
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
    part = await _get_locked_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")

    now = datetime.now(timezone.utc)
    attribution_owner = ""
    if part.batch_id:
        batch = await crud.get_inspection_batch(db=db, batch_id=part.batch_id)
        attribution_owner = str(batch.owner or "").strip() if batch else ""
    if not attribution_owner:
        config_metadata = await crud.get_project_metadata_by_key(db=db, project_id=project_id, key=PROJECT_CONFIGURATION_KEY)
        config_value = config_metadata.value if config_metadata and isinstance(config_metadata.value, dict) else {}
        project_owner = config_value.get("project_owner") if isinstance(config_value.get("project_owner"), dict) else {}
        attribution_owner = str(project_owner.get("email") or project_owner.get("name") or "").strip()
        if not attribution_owner:
            current_config_user = config_value.get("current_user") if isinstance(config_value.get("current_user"), dict) else {}
            username = str(current_config_user.get("username") or "").strip()
            if username:
                sso_authenticated = bool(current_config_user.get("sso_authenticated"))
                attribution_owner = username if sso_authenticated else f"{username} (manual)"

    annotation_entry = {
        "id": str(uuid.uuid4()),
        **payload.model_dump(),
        "created_at": now.isoformat(),
        "created_by": attribution_owner or current_user.email,
        "updated_at": now.isoformat(),
        "updated_by": current_user.email,
    }
    annotations = _part_annotations(part)
    annotations.append(annotation_entry)
    _validate_annotation_collection_limits(annotations)
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
    part = await _get_locked_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")

    existing_annotations = _part_annotations(part)
    _validate_annotation_collection_limits(existing_annotations)
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
            try:
                validated_annotation = schemas.InspectionAnnotation.model_validate(annotation)
            except ValidationError as exc:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
                    detail=[
                        {
                            "loc": list(error.get("loc", ())),
                            "msg": error.get("msg", "Invalid annotation"),
                            "type": error.get("type", "value_error"),
                        }
                        for error in exc.errors(include_url=False)
                    ],
                ) from exc
            annotation = validated_annotation.model_dump(mode="json")
            updated_annotation = annotation
        updated_annotations.append(annotation)

    if not updated_annotation:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Annotation not found")

    _validate_annotation_collection_limits(updated_annotations)

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


@router.delete(
    "/projects/{project_id}/parts/{part_id}/annotations/{annotation_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_part_annotation(
    project_id: uuid.UUID,
    part_id: uuid.UUID,
    annotation_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    part = await _get_locked_inspection_part(db=db, project_id=project_id, part_id=part_id)
    if not part:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inspection part not found")

    existing_annotations = _part_annotations(part)
    updated_annotations = [
        annotation for annotation in existing_annotations
        if annotation.get("id") != str(annotation_id)
    ]
    if len(updated_annotations) == len(existing_annotations):
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
    safe_state = _normalize_workspace_state(raw_state)
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
            value=_normalize_workspace_state(payload.state),
        ),
        created_by=current_user.email,
    )
    safe_state = _normalize_workspace_state(updated.value)
    return {
        "project_id": project_id,
        "user_email": current_user.email,
        "state": safe_state,
        "updated_at": updated.updated_at,
    }


@router.get(
    "/projects/{project_id}/configuration",
)
async def get_project_configuration(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    project = await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    metadata = await crud.get_project_metadata_by_key(
        db=db,
        project_id=project_id,
        key=PROJECT_CONFIGURATION_KEY,
    )
    default_config = _default_project_configuration(project.project_type)
    raw_config = metadata.value if metadata and isinstance(metadata.value, dict) else default_config
    resolved_config = dict(raw_config)
    interface_layout = resolved_config.get("interface_layout")
    has_project_default_layout = (
        isinstance(interface_layout, dict)
        and isinstance(interface_layout.get("default_model"), dict)
    )
    if not has_project_default_layout:
        project_type_default = await _resolve_project_type_interface_layout_default(
            db,
            project_type=project.project_type or "PT1",
        )
        if project_type_default:
            resolved_config["interface_layout"] = {
                "default_model": project_type_default,
            }
    return {
        "project_id": project_id,
        "config": resolved_config,
        "updated_at": metadata.updated_at if metadata else None,
    }


@router.put(
    "/projects/{project_id}/configuration",
    response_model=schemas.InspectionProjectConfigurationResponse,
    response_model_exclude_unset=True,
)
async def update_project_configuration(
    project_id: uuid.UUID,
    payload: schemas.InspectionProjectConfigurationPayload,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    project = await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    updated = await crud.create_or_update_project_metadata(
        db=db,
        metadata=schemas.ProjectMetadataCreate(
            project_id=project_id,
            key=PROJECT_CONFIGURATION_KEY,
            value=_dump_project_configuration_payload(payload.config),
        ),
        created_by=current_user.email,
    )
    persisted = updated.value if isinstance(updated.value, dict) else _default_project_configuration(project.project_type)
    return {
        "project_id": project_id,
        "config": persisted,
        "updated_at": updated.updated_at,
    }


@router.post(
    "/projects/{project_id}/configuration/interface-layout/default",
    response_model=schemas.InspectionProjectConfigurationResponse,
)
async def save_project_default_interface_layout(
    project_id: uuid.UUID,
    payload: schemas.InspectionInterfaceLayoutDefaultPayload,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    project = await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    metadata = await crud.get_project_metadata_by_key(
        db=db,
        project_id=project_id,
        key=PROJECT_CONFIGURATION_KEY,
    )
    default_config = _default_project_configuration(project.project_type)
    raw_config = metadata.value if metadata and isinstance(metadata.value, dict) else default_config
    config = {
        **default_config,
        **raw_config,
    }
    config["interface_layout"] = {
        "default_model": _normalize_layout_model(payload.layout_model),
    }
    updated = await crud.create_or_update_project_metadata(
        db=db,
        metadata=schemas.ProjectMetadataCreate(
            project_id=project_id,
            key=PROJECT_CONFIGURATION_KEY,
            value=config,
        ),
        created_by=current_user.email,
    )
    persisted = updated.value if isinstance(updated.value, dict) else _default_project_configuration(project.project_type)
    return {
        "project_id": project_id,
        "config": persisted,
        "updated_at": updated.updated_at,
    }


@router.post(
    "/projects/{project_id}/configuration/interface-layout/project-type-default",
    response_model=schemas.InspectionProjectConfigurationResponse,
)
async def save_project_type_default_interface_layout(
    project_id: uuid.UUID,
    payload: schemas.InspectionInterfaceLayoutDefaultPayload,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    project = await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    raw_groups_header = request.headers.get("X-User-Groups", "[]")
    try:
        parsed_groups = json.loads(raw_groups_header) if isinstance(raw_groups_header, str) else []
    except json.JSONDecodeError:
        parsed_groups = []
    normalized_groups = {str(group).strip().lower() for group in parsed_groups if isinstance(group, str)}
    if not ({"admin", "admins"} & normalized_groups):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required to save project type defaults")
    normalized_layout = _normalize_layout_model(payload.layout_model)
    metadata_key = _project_type_interface_layout_metadata_key(project.project_type or "PT1")
    await crud.create_or_update_project_metadata(
        db=db,
        metadata=schemas.ProjectMetadataCreate(
            project_id=project_id,
            key=metadata_key,
            value=normalized_layout,
        ),
        created_by=current_user.email,
    )
    return await get_project_configuration(project_id=project_id, db=db, current_user=current_user)


@router.post(
    "/projects/{project_id}/configuration/clone",
)
async def clone_project_configuration(
    project_id: uuid.UUID,
    payload: schemas.InspectionProjectConfigurationCloneRequest,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    target_project = await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    if payload.source_project_id == project_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="source_project_id must be different from project_id",
        )
    source_project = await _get_project_with_access_check(
        project_id=payload.source_project_id,
        db=db,
        current_user=current_user,
    )
    if source_project.project_type != target_project.project_type:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "source_project_id must belong to a project with the same project_type "
                "as the target project"
            ),
        )

    source_metadata = await crud.get_project_metadata_by_key(
        db=db,
        project_id=payload.source_project_id,
        key=PROJECT_CONFIGURATION_KEY,
    )
    source_config = (
        source_metadata.value
        if source_metadata and isinstance(source_metadata.value, dict)
        else _default_project_configuration(source_project.project_type)
    )
    updated = await crud.create_or_update_project_metadata(
        db=db,
        metadata=schemas.ProjectMetadataCreate(
            project_id=project_id,
            key=PROJECT_CONFIGURATION_KEY,
            value=source_config,
        ),
        created_by=current_user.email,
    )
    return {
        "project_id": project_id,
        "source_project_id": payload.source_project_id,
        "config": _strip_optional_default_sections(source_config),
        "updated_at": updated.updated_at,
    }


@router.post(
    "/projects/{project_id}/load-test-data",
)
async def load_project_test_data(
    project_id: uuid.UUID,
    fixture: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    project = await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    project_type = (project.project_type or "PT1").upper()
    fixture_id = fixture or DEFAULT_PT3_FIXTURE_ID
    if get_pt3_test_fixture(fixture_id) is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unknown test-data fixture")
    if fixture_id == NIST_COCR_FIXTURE_ID and project_type != "PT3":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The nist-cocr fixture is only available for PT3 projects",
        )
    uploaded_records: List[dict] = []
    images_created = 0

    if project_type == "PT3" and fixture_id == NIST_COCR_FIXTURE_ID:
        nist_fixture = get_pt3_test_fixture(NIST_COCR_FIXTURE_ID)
        assert nist_fixture is not None
        raw_spec = next(item for item in nist_fixture.files if item.role == "base")
        overlay_spec = next(item for item in nist_fixture.files if item.role == "overlay")
        if not raw_spec.path.is_file() or not overlay_spec.path.is_file():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="NIST CoCr test volumes not found")

        axial, coronal, sagittal = _validated_nist_fixture_shape(raw_spec, overlay_spec)
        volume_shape = {"axial": axial, "coronal": coronal, "sagittal": sagittal}
        common_metadata = {
            "source": "vista-test-data",
            "project_type": "PT3",
            "builtin_fixture_id": NIST_COCR_FIXTURE_ID,
            "fixture_id": NIST_COCR_FIXTURE_ID,
            "volume_stack_id": "PT3_NIST_COCR_SET1SAMPLE5_001",
            "volume_shape": volume_shape,
            "axis_labels": ["XY", "XZ", "YZ"],
            "load_mode": "volume",
            "frame_count": axial,
        }
        raw_metadata = {
            **common_metadata,
            "builtin_fixture_filename": raw_spec.filename,
            "fixture_role": raw_spec.role,
            "overlay": False,
            "modality": "volume",
            "voxel_dtype": raw_spec.dtype,
            "pixel_dtype": raw_spec.dtype,
            "bit_depth": 16,
        }
        raw_image, raw_created = await _create_test_image_if_missing(
            project_id=project_id,
            file_path=raw_spec.path,
            metadata=raw_metadata,
            db=db,
            current_user=current_user,
            allow_metadata_only=True,
        )
        images_created += 1 if raw_created else 0
        raw_record = {
            "filename": raw_spec.filename,
            "image_id": str(raw_image.id),
            "metadata": raw_metadata,
            **raw_metadata,
        }

        overlay_metadata = {
            **common_metadata,
            "builtin_fixture_filename": overlay_spec.filename,
            "fixture_role": overlay_spec.role,
            "overlay": True,
            "modality": "segmentation",
            "voxel_dtype": overlay_spec.dtype,
            "pixel_dtype": overlay_spec.dtype,
            "bit_depth": 8,
            "overlay_base_filename": raw_spec.filename,
            "overlay_base_image_id": str(raw_image.id),
        }
        overlay_image, overlay_created = await _create_test_image_if_missing(
            project_id=project_id,
            file_path=overlay_spec.path,
            metadata=overlay_metadata,
            db=db,
            current_user=current_user,
            allow_metadata_only=True,
        )
        images_created += 1 if overlay_created else 0
        overlay_record = {
            "filename": overlay_spec.filename,
            "image_id": str(overlay_image.id),
            "metadata": overlay_metadata,
            **overlay_metadata,
        }
        uploaded_records.extend([raw_record, overlay_record])

        part_metadata = {
            **common_metadata,
            "volume_shape": volume_shape,
            "voxel_dtype": raw_spec.dtype,
            "bit_depth": 16,
            "mpr": {"volume_shape": volume_shape, "axis_labels": ["XY", "XZ", "YZ"]},
            "source_images": uploaded_records,
            "view_images": {"volume": raw_spec.filename},
            "overlay_images": {"volume": {"segmentation": overlay_spec.filename}},
        }
        ingest_payload = schemas.InspectionBulkIngestPayload(
            batches=[
                schemas.InspectionIngestBatchRecord(
                    name="PT3_NIST_COCR_SET1SAMPLE5_BATCH",
                    description="NIST CoCr set1sample5 paired volume test data",
                    parts=[
                        schemas.InspectionIngestPartRecord(
                            serial_number="NIST-COCR-SET1SAMPLE5",
                            display_name="NIST CoCr set1sample5 center cylinder",
                            metadata=part_metadata,
                        )
                    ],
                )
            ]
        )
    elif project_type == "PT3":
        if not PT3_TEST_STACK_ROOT.exists():
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PT3 test stack not found")
        volume_info = load_slice_stack(PT3_TEST_STACK_ROOT)
        nsipro_metadata = _load_nsipro_metadata_fixture(PT3_TEST_STACK_ROOT)
        for index, file_path in enumerate(sorted(PT3_TEST_STACK_ROOT.glob("*.png"))):
            metadata = {
                "source": "vista-test-data",
                "project_type": "PT3",
                "builtin_fixture_filename": file_path.name,
                "volume_stack_id": "PT3_SYNTH_MPR_001",
                "slice_index": index,
                "slice_axis": "Z",
                "axis_labels": ["XY", "XZ", "YZ"],
                "overlay": False,
                "modality": "volume-slice",
            }
            if nsipro_metadata:
                metadata["selected_metadata_file"] = nsipro_metadata["source_filename"]
            image, created = await _create_test_image_if_missing(
                project_id=project_id,
                file_path=file_path,
                metadata=metadata,
                db=db,
                current_user=current_user,
                allow_metadata_only=True,
            )
            images_created += 1 if created else 0
            uploaded_records.append({
                "filename": file_path.name,
                "image_id": str(image.id),
                "metadata": metadata,
                **metadata,
            })

            overlay_path = PT3_TEST_STACK_ROOT / "overlays" / f"{file_path.stem}_overlay.png"
            if overlay_path.exists():
                overlay_metadata = {
                    "source": "vista-test-data",
                    "project_type": "PT3",
                    "builtin_fixture_filename": overlay_path.name,
                    "volume_stack_id": "PT3_SYNTH_MPR_001",
                    "slice_index": index,
                    "slice_axis": "Z",
                    "axis_labels": ["XY", "XZ", "YZ"],
                    "overlay": True,
                    "modality": "segmentation",
                    "overlay_base_filename": file_path.name,
                    "overlay_base_image_id": str(image.id),
                }
                if nsipro_metadata:
                    overlay_metadata["selected_metadata_file"] = nsipro_metadata["source_filename"]
                overlay_image, overlay_created = await _create_test_image_if_missing(
                    project_id=project_id,
                    file_path=overlay_path,
                    metadata=overlay_metadata,
                    db=db,
                    current_user=current_user,
                    allow_metadata_only=True,
                )
                images_created += 1 if overlay_created else 0
                uploaded_records.append({
                    "filename": overlay_path.name,
                    "image_id": str(overlay_image.id),
                    "metadata": overlay_metadata,
                    **overlay_metadata,
                })

        part_metadata = {
            "source": "vista-test-data",
            "volume_stack_id": "PT3_SYNTH_MPR_001",
            "volume_shape": {
                "axial": volume_info.shape[0],
                "coronal": volume_info.shape[1],
                "sagittal": volume_info.shape[2],
            },
            "mpr": {
                "volume_shape": {
                    "axial": volume_info.shape[0],
                    "coronal": volume_info.shape[1],
                    "sagittal": volume_info.shape[2],
                },
                "axis_labels": ["XY", "XZ", "YZ"],
            },
            "source_images": uploaded_records,
        }
        if nsipro_metadata:
            part_metadata["nsipro_metadata"] = nsipro_metadata
        ingest_payload = schemas.InspectionBulkIngestPayload(
            batches=[
                schemas.InspectionIngestBatchRecord(
                    name="PT3_SYNTH_MPR_BATCH01",
                    description="Synthetic PT3 3D stack test data",
                    parts=[
                        schemas.InspectionIngestPartRecord(
                            serial_number="SN3D0001",
                            display_name="PT3 synthetic MPR stack",
                            metadata=part_metadata,
                        )
                    ],
                )
            ]
        )
    else:
        fixture_root = TEST_DATA_ROOT / project_type
        if not fixture_root.exists() and project_type == "PT2":
            fixture_root = TEST_DATA_ROOT / "PT1"
        fixture_paths = sorted(
            path
            for path in fixture_root.rglob("*")
            if path.is_file() and path.name != "regex.txt" and path.suffix.lower() in TEST_DATA_EXTENSIONS
        ) if fixture_root.exists() else []
        if not fixture_paths:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"{project_type} test data not found")
        for file_path in fixture_paths:
            metadata = _metadata_from_test_data_file(file_path, fixture_root)
            if metadata is None:
                continue
            metadata = {**metadata, "project_type": project_type}
            image, created = await _create_test_image_if_missing(
                project_id=project_id,
                file_path=file_path,
                metadata=metadata,
                db=db,
                current_user=current_user,
            )
            images_created += 1 if created else 0
            uploaded_records.append({"filename": file_path.name, "image_id": str(image.id), "metadata": metadata})
        ingest_payload = _build_hierarchy_ingest_records(uploaded_records)

    ingest_result = await _bulk_ingest_project_parts(
        project_id=project_id,
        payload=ingest_payload,
        db=db,
        current_user=current_user,
        project_type=project.project_type,
    )
    get_cache().clear_pattern(f"project_images:{project_id}")
    return {
        "project_id": project_id,
        "project_type": project_type,
        "images_received": len(uploaded_records),
        "images_created": images_created,
        "ingest": ingest_result,
    }


@router.post(
    "/projects/{project_id}/ingest",
    response_model=schemas.InspectionBulkIngestResponse,
)
async def bulk_ingest_project_parts(
    project_id: uuid.UUID,
    payload: schemas.InspectionBulkIngestPayload,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    project = await _get_project_with_access_check(project_id=project_id, db=db, current_user=current_user)
    return await _bulk_ingest_project_parts(
        project_id=project_id,
        payload=payload,
        db=db,
        current_user=current_user,
        project_type=project.project_type,
    )
