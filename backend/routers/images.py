import uuid
import base64
import asyncio
import logging
import io
import math
import os
import mimetypes
import threading
import time
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import asynccontextmanager
from urllib.parse import urlparse, unquote
from pathlib import Path, PurePosixPath
from collections import OrderedDict, deque
import zipfile
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, status, UploadFile, File, Form, Query, Body
from sqlalchemy import insert, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from typing import List, Optional, Dict, Any
from pydantic import BaseModel, ValidationError
import utils.crud as crud
from core import schemas, models
from core.database import get_db
from core.config import settings
from core.group_auth_helper import is_user_in_group
from utils.dependencies import get_current_user
from utils.dependencies import get_project_or_403, get_project_or_403_writable, get_image_or_403_writable
from utils.boto3_client import (
    upload_file_to_s3,
    get_presigned_download_url,
    delete_file_from_s3,
    list_s3_objects,
    get_s3_object_info,
    copy_s3_object_to_s3,
)
from utils.serialization import (
    data_instance_schema_from_values,
    to_data_instance_schema,
)
from utils.transactions import (
    commit_database_transaction as _commit_database_transaction,
)
from utils.file_security import get_content_disposition_header
from utils.cache_manager import get_cache
from utils.metadata_values import parse_metadata_boolean
from services import image_deletion as image_deletion_service
import json as _json
import numpy as np
from PIL import Image, ImageSequence
from utils.volume_cache import (
    InvalidVolumeSourceError,
    VolumeCacheError,
    VolumeSourceReadError,
    VolumeSourceIdentity,
    build_volume_source_identity,
    get_materialized_npy_path,
    get_npy_volume_handle,
)
from utils.volume_loader import (
    MAX_NPY_HEADER_BYTES,
    MAX_VOLUME_LOAD_BYTES,
    REFERENCE_VOLUME_READ_LIMITS,
    VolumeReadLimits,
    _image_color_layout,
    _inspect_npy_header,
    _inspect_npz_archive,
    preflight_zip_archive,
    read_npy_header,
)
from utils.pt3_test_fixtures import resolve_pt3_test_fixture_file

router = APIRouter(
    tags=["Images"],
)

logger = logging.getLogger(__name__)


def _encode_image_page_cursor(created_at: datetime, image_id: uuid.UUID) -> str:
    normalized_created_at = (
        created_at.replace(tzinfo=timezone.utc)
        if created_at.tzinfo is None
        else created_at.astimezone(timezone.utc)
    )
    payload = _json.dumps(
        {"v": 1, "created_at": normalized_created_at.isoformat(), "id": str(image_id)},
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_image_page_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        if not cursor or len(cursor) > 512:
            raise ValueError("invalid cursor length")
        padded = cursor + ("=" * (-len(cursor) % 4))
        raw = base64.b64decode(padded.encode("ascii"), altchars=b"-_", validate=True)
        payload = _json.loads(raw.decode("utf-8"))
        if not isinstance(payload, dict) or set(payload) != {"v", "created_at", "id"} or payload.get("v") != 1:
            raise ValueError("invalid cursor payload")
        created_at = datetime.fromisoformat(payload["created_at"])
        if created_at.tzinfo is None or created_at.utcoffset() is None:
            raise ValueError("cursor timestamp must include a UTC offset")
        created_at = created_at.astimezone(timezone.utc)
        image_id = uuid.UUID(payload["id"])
    except (TypeError, ValueError, UnicodeError, _json.JSONDecodeError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid image page cursor") from exc
    return created_at, image_id


VOXEL_DATA_EXTENSIONS = {".npy", ".npz", ".inspiro"}
MAX_UPLOAD_BYTES = MAX_VOLUME_LOAD_BYTES
DEFAULT_BATCH_UPLOAD_MAX_FILES = 100
DEFAULT_BATCH_UPLOAD_MAX_BYTES = 256 * 1024 * 1024
DEFAULT_BATCH_UPLOAD_MAX_MANIFEST_BYTES = 8 * 1024 * 1024
DEFAULT_BATCH_UPLOAD_CONCURRENCY = 6
MAX_BATCH_UPLOAD_CONCURRENCY = 6
DEFAULT_BATCH_METADATA_MAX_BYTES = 1024 * 1024
DEFAULT_BATCH_METADATA_MAX_DEPTH = 32
DEFAULT_BATCH_METADATA_MAX_ITEMS = 10_000
DEFAULT_BATCH_METADATA_MAX_STRING_BYTES = 1024 * 1024
DEFAULT_BATCH_METADATA_MAX_KEY_BYTES = 4096
PROCESS_STORAGE_OPERATION_CONCURRENCY = 6
DEFAULT_S3_LIST_MAX_KEYS = 5000
DEFAULT_S3_IMPORT_CONCURRENCY = 6
MAX_S3_IMPORT_CONCURRENCY = 6


class _ProcessWideStorageLimiter:
    """Async facade over one process-wide semaphore, safe across event loops.

    Semaphore waits use a dedicated single worker. This avoids blocking an
    application event loop and avoids exhausting the default executor with
    waiting tasks while active S3 operations need that executor themselves.
    """

    def __init__(self, capacity: int) -> None:
        if capacity <= 0:
            raise ValueError("storage operation capacity must be positive")
        self.capacity = capacity
        self._semaphore = threading.BoundedSemaphore(capacity)
        self._wait_executor = ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="vista-storage-limit",
        )

    def _release_cancelled_wait(self, future: Future[bool]) -> None:
        if future.cancelled():
            return
        try:
            acquired = future.result()
        except BaseException:
            return
        if acquired:
            self._semaphore.release()

    @asynccontextmanager
    async def slot(self):
        wait_future = self._wait_executor.submit(self._semaphore.acquire)
        acquired = False
        try:
            await asyncio.shield(asyncio.wrap_future(wait_future))
            acquired = True
            yield
        except BaseException:
            if not acquired:
                # A cancelled coroutine must not leak the slot once its
                # already-running semaphore wait eventually succeeds.
                wait_future.add_done_callback(self._release_cancelled_wait)
            raise
        finally:
            if acquired:
                self._semaphore.release()

    def shutdown(self) -> None:
        """Release the dedicated waiter thread (used by focused tests)."""

        self._wait_executor.shutdown(wait=True, cancel_futures=True)


_PROCESS_STORAGE_LIMITER = _ProcessWideStorageLimiter(PROCESS_STORAGE_OPERATION_CONCURRENCY)


@asynccontextmanager
async def _storage_operation_slot():
    """Bound S3 operations across all requests handled by this worker."""

    async with _PROCESS_STORAGE_LIMITER.slot():
        yield


def _format_byte_limit(byte_count: int) -> str:
    gib = byte_count / (1024 ** 3)
    return f"{gib:.1f} GiB ({byte_count} bytes)"


def _upload_size_limit() -> int:
    return int(os.getenv("MAX_UPLOAD_BYTES", str(MAX_UPLOAD_BYTES)))


def _positive_env_int(name: str, default: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _batch_upload_file_limit() -> int:
    return _positive_env_int("MAX_BATCH_UPLOAD_FILES", DEFAULT_BATCH_UPLOAD_MAX_FILES)


def _batch_upload_byte_limit() -> int:
    return _positive_env_int("MAX_BATCH_UPLOAD_BYTES", DEFAULT_BATCH_UPLOAD_MAX_BYTES)


def _batch_upload_manifest_byte_limit() -> int:
    return _positive_env_int(
        "MAX_BATCH_UPLOAD_MANIFEST_BYTES",
        DEFAULT_BATCH_UPLOAD_MAX_MANIFEST_BYTES,
    )


def _batch_metadata_byte_limit() -> int:
    return _positive_env_int("MAX_BATCH_METADATA_BYTES", DEFAULT_BATCH_METADATA_MAX_BYTES)


def _batch_metadata_depth_limit() -> int:
    return _positive_env_int("MAX_BATCH_METADATA_DEPTH", DEFAULT_BATCH_METADATA_MAX_DEPTH)


def _batch_metadata_item_limit() -> int:
    return _positive_env_int("MAX_BATCH_METADATA_ITEMS", DEFAULT_BATCH_METADATA_MAX_ITEMS)


def _batch_metadata_string_byte_limit() -> int:
    return _positive_env_int(
        "MAX_BATCH_METADATA_STRING_BYTES",
        DEFAULT_BATCH_METADATA_MAX_STRING_BYTES,
    )


def _batch_metadata_key_byte_limit() -> int:
    return _positive_env_int(
        "MAX_BATCH_METADATA_KEY_BYTES",
        DEFAULT_BATCH_METADATA_MAX_KEY_BYTES,
    )


def _batch_upload_concurrency() -> int:
    configured = _positive_env_int("MAX_BATCH_UPLOAD_CONCURRENCY", DEFAULT_BATCH_UPLOAD_CONCURRENCY)
    return min(configured, MAX_BATCH_UPLOAD_CONCURRENCY)


def _s3_list_key_limit() -> int:
    return _positive_env_int("MAX_S3_LIST_KEYS", DEFAULT_S3_LIST_MAX_KEYS)


def _s3_import_concurrency() -> int:
    configured = _positive_env_int(
        "MAX_S3_IMPORT_CONCURRENCY",
        DEFAULT_S3_IMPORT_CONCURRENCY,
    )
    return min(configured, MAX_S3_IMPORT_CONCURRENCY)


def _file_too_large_detail(filename: str | None, file_size: int, max_size: int) -> str:
    name = filename or "Uploaded file"
    return (
        f"{name} is too large: {file_size} bytes exceeds the built-in "
        f"upload size limit of {_format_byte_limit(max_size)}. "
        "Set MAX_UPLOAD_BYTES to adjust this limit."
    )
TIFF_EXTENSIONS = {".tif", ".tiff"}
PNG_EXTENSIONS = {".png"}
SCALAR_INTENSITY_EXTENSIONS = TIFF_EXTENSIONS | PNG_EXTENSIONS
ORDINARY_IMAGE_EXTENSIONS = PNG_EXTENSIONS | TIFF_EXTENSIONS | {
    ".bmp",
    ".gif",
    ".jpeg",
    ".jpg",
    ".webp",
}


def _flatten_image_extrema(extrema: Any) -> list[tuple[float, float]]:
    if not isinstance(extrema, tuple):
        return []
    if len(extrema) == 2 and all(isinstance(value, (int, float)) for value in extrema):
        return [(float(extrema[0]), float(extrema[1]))]
    ranges: list[tuple[float, float]] = []
    for channel_range in extrema:
        if (
            isinstance(channel_range, tuple)
            and len(channel_range) == 2
            and all(isinstance(value, (int, float)) for value in channel_range)
        ):
            ranges.append((float(channel_range[0]), float(channel_range[1])))
    return ranges


def _dtype_from_pillow_mode(image: Image.Image) -> tuple[Optional[str], Optional[int], bool]:
    mode = str(image.mode or '')
    bits_per_sample = image.tag_v2.get(258) if hasattr(image, 'tag_v2') else None
    if isinstance(bits_per_sample, tuple) and bits_per_sample:
        bits_per_sample = bits_per_sample[0]
    try:
        bit_depth = int(bits_per_sample) if bits_per_sample is not None else None
    except (TypeError, ValueError):
        bit_depth = None

    if mode in {'I;16', 'I;16L', 'I;16B', 'I;16N'}:
        return 'uint16', bit_depth or 16, False
    if mode == 'I':
        return 'int32', bit_depth or 32, True
    if mode == 'F':
        return 'float32', bit_depth or 32, True
    if mode in {'L', 'P'}:
        return 'uint8', bit_depth or 8, False
    if mode == '1':
        return 'bool', 1, False
    if bit_depth and bit_depth > 8:
        return f'uint{bit_depth}', bit_depth, False
    if bit_depth:
        return f'uint{bit_depth}', bit_depth, False
    return None, None, False


def _should_scan_image_intensity(
    image: Image.Image,
    *,
    frame_count: int,
    bit_depth: Optional[int],
) -> bool:
    """Return whether exact extrema justify decoding the image payload.

    Exact intensity ranges are needed for scalar imagery, high-bit data, and
    multi-frame volumes.  A single-frame, ordinary 8-bit color image does not
    use scalar windowing, so decoding every pixel merely to compute channel
    extrema is wasted work during bulk upload.
    """

    if frame_count > 1:
        return True
    if bit_depth is not None and bit_depth > 8:
        return True
    return len(image.getbands()) <= 1


def _is_high_bit_scalar_image(image: Image.Image) -> bool:
    mode = str(image.mode or '')
    _pixel_dtype, bit_depth, _signed = _dtype_from_pillow_mode(image)
    high_bit_mode = mode in {'I;16', 'I;16L', 'I;16B', 'I;16N', 'I', 'F'}
    high_bit_tag = bit_depth and bit_depth > 8 and mode not in {'RGB', 'RGBA', 'CMYK'}
    return high_bit_mode or bool(high_bit_tag)


def _normalize_scalar_image_to_uint8(image: Image.Image) -> Optional[Image.Image]:
    if not _is_high_bit_scalar_image(image):
        return None
    extrema = _flatten_image_extrema(image.getextrema())
    if not extrema:
        return None
    minimum = min(item[0] for item in extrema)
    maximum = max(item[1] for item in extrema)
    if maximum <= minimum:
        return Image.new('L', image.size, 0)
    scaled = image.convert('F').point(lambda value: ((value - minimum) * 255.0) / (maximum - minimum))
    return scaled.convert('L')


def _prepare_thumbnail_image(image: Image.Image) -> tuple[Image.Image, str]:
    """Return an 8-bit browser-safe image and output format for thumbnails.

    Pillow cannot save high-bit-depth scalar modes such as I;16 directly as
    JPEG, and browsers are inconsistent when displaying 16-bit thumbnails.
    Normalize those scalar images into display-ready 8-bit luminance, then use
    the thumbnail endpoint's compact JPEG default for non-transparent imagery.
    """
    original_format = image.format

    normalized_scalar = _normalize_scalar_image_to_uint8(image)
    if normalized_scalar is not None:
        return normalized_scalar, 'JPEG'

    if image.mode in ('LA', 'PA'):
        return image.convert('RGBA'), 'PNG'
    if image.mode == 'RGBA':
        return image, 'PNG'
    if image.mode == 'P':
        if 'transparency' in image.info:
            return image.convert('RGBA'), 'PNG'
        return image.convert('RGB'), 'JPEG'
    if image.mode not in ('RGB', 'L'):
        return image.convert('RGB'), 'JPEG'
    if original_format in ('JPEG', 'PNG', 'GIF', 'WEBP'):
        return image, original_format
    return image, 'JPEG'


def _dtype_metadata_from_numpy_descr(dtype_descr: str) -> Dict[str, Any]:
    try:
        dtype = np.dtype(dtype_descr)
    except (TypeError, ValueError):
        return {}
    metadata: Dict[str, Any] = {
        "pixel_dtype": dtype.name,
        "voxel_dtype": dtype.name,
        "bit_depth": int(dtype.itemsize * 8),
        "bits_per_sample": int(dtype.itemsize * 8),
    }
    if np.issubdtype(dtype, np.signedinteger) or np.issubdtype(dtype, np.floating):
        metadata["signed"] = True
    return metadata


def _inspect_voxel_upload_metadata(
    file: UploadFile,
    *,
    file_size: Optional[int] = None,
) -> Dict[str, Any]:
    """Validate one voxel upload and return metadata from the same preflight.

    Archive validation reads only the selected NPY header.  Central-directory
    member counts and declared uncompressed sizes are checked before opening a
    member, preventing a compressed archive from forcing a full inflate during
    upload inspection.
    """

    filename = (file.filename or "").lower()
    if not any(filename.endswith(ext) for ext in VOXEL_DATA_EXTENSIONS):
        return {}

    try:
        file.file.seek(0)
        if (
            file_size is not None
            and file_size > REFERENCE_VOLUME_READ_LIMITS.max_source_bytes
        ):
            raise ValueError(
                "Volume source exceeds the "
                f"{REFERENCE_VOLUME_READ_LIMITS.max_source_bytes}-byte materialized-file limit"
            )
        if filename.endswith(".npy"):
            header = _inspect_npy_header(
                file.file,
                limits=REFERENCE_VOLUME_READ_LIMITS,
                available_bytes=file_size,
            )
        else:
            preflight_zip_archive(
                file.file,
                limits=REFERENCE_VOLUME_READ_LIMITS,
                available_bytes=file_size,
            )
            with zipfile.ZipFile(file.file) as archive:
                _selected, header = _inspect_npz_archive(
                    archive,
                    limits=REFERENCE_VOLUME_READ_LIMITS,
                )
    except zipfile.BadZipFile as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid 3D voxel data: invalid NumPy archive",
        ) from exc
    except ValueError as exc:
        detail = str(exc)
        if filename.endswith(".inspiro") and "does not contain a .npy array" in detail:
            detail = ".inspiro archive must contain at least one .npy voxel array"
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid 3D voxel data: {detail}",
        ) from exc
    finally:
        file.file.seek(0)

    metadata = _dtype_metadata_from_numpy_descr(header.dtype_text)
    metadata["volume_shape"] = {
        "axial": int(header.shape[0]),
        "coronal": int(header.shape[1]),
        "sagittal": int(header.shape[2]),
    }
    metadata["channel_count"] = header.channel_count
    metadata["color_mode"] = header.color_mode
    metadata["frame_count"] = int(header.shape[0])
    metadata["load_mode"] = "volume"
    return metadata


def _npy_voxel_metadata(file: UploadFile) -> Dict[str, Any]:
    """Compatibility wrapper for callers that only request voxel metadata."""

    try:
        file_size = _batch_upload_file_size(file)
        return _inspect_voxel_upload_metadata(file, file_size=file_size)
    except HTTPException:
        return {}


def _image_intensity_metadata_from_open_image(image: Image.Image) -> Dict[str, Any]:
    frame_ranges: list[tuple[float, float]] = []
    frame_count = max(1, int(getattr(image, 'n_frames', 1) or 1))
    pixel_dtype, bit_depth, signed = _dtype_from_pillow_mode(image)
    if not _should_scan_image_intensity(image, frame_count=frame_count, bit_depth=bit_depth):
        return {}

    for frame in ImageSequence.Iterator(image):
        if pixel_dtype is None or bit_depth is None:
            candidate_dtype, candidate_bit_depth, candidate_signed = _dtype_from_pillow_mode(frame)
            pixel_dtype = pixel_dtype or candidate_dtype
            bit_depth = bit_depth or candidate_bit_depth
            signed = signed or candidate_signed
        frame_ranges.extend(_flatten_image_extrema(frame.getextrema()))

    if not frame_ranges or (pixel_dtype is None and bit_depth is None):
        return {}

    minimum = min(item[0] for item in frame_ranges)
    maximum = max(item[1] for item in frame_ranges)

    def clean(value: float) -> int | float:
        return int(value) if float(value).is_integer() else value

    value_range = {'min': clean(minimum), 'max': clean(maximum)}
    metadata: Dict[str, Any] = {
        'pixel_value_range': value_range,
        'value_range': value_range,
        'intensity_range': value_range,
        'frame_count': frame_count,
    }
    if pixel_dtype:
        metadata['pixel_dtype'] = pixel_dtype
        metadata['voxel_dtype'] = pixel_dtype
    if bit_depth:
        metadata['bit_depth'] = bit_depth
        metadata['bits_per_sample'] = bit_depth
    if signed:
        metadata['signed'] = True
    return metadata


def _image_intensity_metadata(file: UploadFile) -> Dict[str, Any]:
    filename = (file.filename or '').lower()
    if not any(filename.endswith(ext) for ext in SCALAR_INTENSITY_EXTENSIONS):
        return {}

    try:
        file.file.seek(0)
        with Image.open(file.file) as image:
            return _image_intensity_metadata_from_open_image(image)
    except Exception:
        return {}
    finally:
        file.file.seek(0)


def _tiff_dimensionality_metadata_from_open_image(image: Image.Image) -> Dict[str, Any]:
    frame_count = max(1, int(getattr(image, "n_frames", 1) or 1))
    image.seek(0)
    width, height = image.size
    expected_mode = image.mode
    expected_bands = image.getbands()
    # Single-frame TIFFs remain ordinary images and may use Pillow-supported
    # modes such as CMYK. Multi-frame TIFFs are voxel volumes, for which the
    # scalar/RGB/RGBA channel contract must be enforced consistently.
    if frame_count > 1:
        _image_color_layout(image)
    for frame_index in range(1, frame_count):
        image.seek(frame_index)
        if image.size != (width, height):
            raise ValueError("All TIFF frames must share the same dimensions")
        if image.mode != expected_mode or image.getbands() != expected_bands:
            raise ValueError("All TIFF frames must share the same pixel mode")
        _image_color_layout(image)
    image.seek(0)
    metadata: Dict[str, Any] = {
        "tiff_dimensionality": "3d" if frame_count > 1 else "2d",
        "load_mode": "volume" if frame_count > 1 else "single_image",
        "frame_count": frame_count,
    }
    if frame_count > 1:
        metadata["volume_shape"] = {
            "axial": frame_count,
            "coronal": int(height),
            "sagittal": int(width),
        }
    return metadata


def _image_color_metadata_from_open_image(image: Image.Image) -> Dict[str, Any]:
    try:
        channel_count, color_mode = _image_color_layout(image)
    except ValueError:
        # Upload metadata must not narrow Pillow's established ordinary-image
        # support. Unsupported layouts are still rejected when they are used
        # as multi-frame/voxel volumes by the dimensionality validator above.
        channel_count = max(1, len(image.getbands()))
        color_mode = str(image.mode or "unknown").strip().lower()
    return {"channel_count": channel_count, "color_mode": color_mode}


def _tiff_dimensionality_metadata(file: UploadFile) -> Dict[str, Any]:
    filename = (file.filename or "").lower()
    if not (filename.endswith(".tif") or filename.endswith(".tiff")):
        return {}
    try:
        file.file.seek(0)
        with Image.open(file.file) as image:
            return _tiff_dimensionality_metadata_from_open_image(image)
    except Exception:
        return {}
    finally:
        file.file.seek(0)


def _inspect_upload_image_metadata(
    file: UploadFile,
    *,
    validate_ordinary_header: bool = False,
) -> Dict[str, Any]:
    """Inspect PNG/TIFF metadata with a single Pillow open per upload."""

    filename = (file.filename or '').lower()
    suffix = Path(filename).suffix
    is_tiff = any(filename.endswith(ext) for ext in TIFF_EXTENSIONS)
    is_png = any(filename.endswith(ext) for ext in PNG_EXTENSIONS)
    is_ordinary_image = suffix in ORDINARY_IMAGE_EXTENSIONS
    if not is_tiff and not is_png and not (validate_ordinary_header and is_ordinary_image):
        return {}

    try:
        file.file.seek(0)
        with Image.open(file.file) as image:
            metadata = _image_color_metadata_from_open_image(image) if (is_tiff or is_png) else {}
            if is_tiff:
                metadata.update(_tiff_dimensionality_metadata_from_open_image(image))
            if is_tiff or is_png:
                try:
                    metadata.update(_image_intensity_metadata_from_open_image(image))
                except Exception:
                    # Exact extrema are optional metadata.  Some otherwise valid
                    # Pillow modes (notably big-endian ``I;16B`` TIFFs) cannot run
                    # ``getextrema``; that must not turn a valid upload into a 400.
                    pass
            return metadata
    except Exception as exc:
        if is_tiff:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Invalid TIFF image data: {exc}",
            ) from exc
        if validate_ordinary_header and is_ordinary_image:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid image data: the file header could not be read",
            ) from exc
        return {}
    finally:
        file.file.seek(0)


def _validate_voxel_data(file: UploadFile) -> None:
    file_size = _batch_upload_file_size(file)
    _inspect_voxel_upload_metadata(file, file_size=file_size)


def _inline_image_bytes(db_image: models.DataInstance) -> Optional[bytes]:
    metadata = db_image.metadata_json if isinstance(db_image.metadata_json, dict) else {}
    encoded = metadata.get("analysis_inline_image_base64")
    if not isinstance(encoded, str) or not encoded:
        return None
    try:
        return base64.b64decode(encoded)
    except Exception:
        return None


def _inspect_tiff_dimensionality(file: UploadFile) -> Optional[str]:
    filename = (file.filename or "").lower()
    if not any(filename.endswith(ext) for ext in TIFF_EXTENSIONS):
        return None

    try:
        with Image.open(file.file) as tiff:
            frame_count = max(1, int(getattr(tiff, "n_frames", 1)))
            return "3d" if frame_count > 1 else "2d"
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid TIFF image data: {exc}",
        ) from exc
    finally:
        file.file.seek(0)


def _inspect_upload_file(
    file: UploadFile,
    *,
    validate_ordinary_header: bool = False,
) -> tuple[Dict[str, Any], Optional[int]]:
    """Run blocking upload inspection before the object-storage stream starts."""

    try:
        file.file.seek(0, io.SEEK_END)
        file_size = file.file.tell()
        file.file.seek(0)
    except Exception:
        # If the stream does not support sizing, leave validation to storage.
        file_size = None

    if (
        validate_ordinary_header
        and file_size == 0
        and Path(file.filename or "").suffix.lower() in ORDINARY_IMAGE_EXTENSIONS
    ):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Empty image file: at least one byte of image data is required",
        )

    metadata = _inspect_upload_image_metadata(
        file,
        validate_ordinary_header=validate_ordinary_header,
    )
    metadata.update(_inspect_voxel_upload_metadata(file, file_size=file_size))
    return metadata, file_size



def _is_volume_upload_metadata(metadata: Dict[str, Any]) -> bool:
    return metadata.get("load_mode") == "volume"


def _part_name_for_volume_filename(filename: str) -> str:
    trimmed_filename = filename.strip()
    lower_filename = trimmed_filename.lower()
    if lower_filename.endswith(".nii.gz"):
        return trimmed_filename[: -len(".nii.gz")]
    return Path(trimmed_filename).stem


def _source_image_entry_from_data_instance(image: models.DataInstance) -> Dict[str, Any]:
    image_metadata = image.metadata_json if isinstance(image.metadata_json, dict) else {}
    entry: Dict[str, Any] = {
        "filename": image.filename,
        "image_id": str(image.id),
        "side": str(image_metadata.get("side") or "").strip().lower(),
        "modality": str(image_metadata.get("modality") or "").strip().lower(),
        "overlay": parse_metadata_boolean(image_metadata.get("overlay")),
        "slice_axis": image_metadata.get("slice_axis"),
        "slice_index": image_metadata.get("slice_index"),
    }
    volume_keys = (
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
    for key in volume_keys:
        if key in image_metadata:
            entry[key] = image_metadata[key]
    entry["metadata"] = {key: image_metadata[key] for key in volume_keys if key in image_metadata}
    return entry


async def _autoassign_pt3_volume_upload_to_part(
    *,
    db: AsyncSession,
    project: models.Project,
    image: models.DataInstance,
    current_user: schemas.User,
    commit: bool = True,
) -> None:
    image_metadata = image.metadata_json if isinstance(image.metadata_json, dict) else {}
    if project.project_type != "PT3" or not _is_volume_upload_metadata(image_metadata):
        return

    filename = (image.filename or "").strip()
    if not filename:
        return

    part_name = _part_name_for_volume_filename(filename)
    if not part_name:
        return

    existing_parts = await crud.list_inspection_parts(db=db, project_id=project.id)
    existing_part = next((part for part in existing_parts if part.serial_number == part_name), None)
    source_entry = _source_image_entry_from_data_instance(image)

    if existing_part is None:
        await crud.create_inspection_part(
            db=db,
            project_id=project.id,
            part=schemas.InspectionPartCreate(
                serial_number=part_name,
                display_name=part_name,
                metadata={"source_images": [source_entry]},
            ),
            created_by=current_user.email,
            commit=commit,
        )
        return

    metadata = existing_part.metadata_json if isinstance(existing_part.metadata_json, dict) else {}
    source_images = metadata.get("source_images") if isinstance(metadata.get("source_images"), list) else []
    source_images = [
        record
        for record in source_images
        if not (
            isinstance(record, dict)
            and str(record.get("image_id") or "").strip() == str(image.id)
        )
    ]
    source_images.append(source_entry)
    await crud.update_inspection_part_metadata(
        db=db,
        project_id=project.id,
        part_id=existing_part.id,
        metadata_patch={**metadata, "source_images": source_images},
        updated_by=current_user.email,
        commit=commit,
    )


SUPPORTED_S3_IMPORT_EXTENSIONS = {
    ".bmp",
    ".gif",
    ".inspiro",
    ".jpeg",
    ".jpg",
    ".npy",
    ".npz",
    ".png",
    ".tif",
    ".tiff",
    ".webp",
}


class S3ListRequest(BaseModel):
    s3_url: str
    max_keys: int = DEFAULT_S3_LIST_MAX_KEYS


class S3ObjectSummary(BaseModel):
    key: str
    filename: str
    size: int
    content_type: Optional[str] = None
    last_modified: Optional[str] = None


class S3ListResponse(BaseModel):
    bucket: str
    prefix: str
    objects: List[S3ObjectSummary]
    truncated: bool = False


class S3ImportRequest(BaseModel):
    s3_url: str
    keys: List[str]
    metadata: Optional[Dict[str, Any]] = None
    per_file_metadata: Optional[Dict[str, Dict[str, Any]]] = None
    group_identifiers: Optional[Dict[str, str]] = None


class S3ImportResponse(BaseModel):
    imported: List[schemas.DataInstance]
    failed: List[Dict[str, str]]


def _parse_s3_url(raw_url: str) -> tuple[str, str]:
    value = (raw_url or "").strip()
    if not value:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="S3 URL is required")

    parsed = urlparse(value)
    if parsed.scheme == "s3":
        bucket = parsed.netloc.strip()
        prefix = unquote(parsed.path.lstrip("/"))
    elif parsed.scheme in {"http", "https"}:
        host_parts = parsed.netloc.split(".")
        path_parts = [unquote(part) for part in parsed.path.split("/") if part]
        if len(host_parts) >= 4 and host_parts[1] == "s3":
            bucket = host_parts[0]
            prefix = "/".join(path_parts)
        elif parsed.netloc.startswith("s3.") or ".amazonaws.com" in parsed.netloc or "localhost" in parsed.netloc or ":" in parsed.netloc:
            if not path_parts:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="S3 URL must include a bucket")
            bucket = path_parts[0]
            prefix = "/".join(path_parts[1:])
        else:
            if not path_parts:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="S3 URL must include a bucket")
            bucket = path_parts[0]
            prefix = "/".join(path_parts[1:])
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Use an s3://, http://, or https:// S3 URL")

    if not bucket:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="S3 URL must include a bucket")
    return bucket, prefix


def _filename_from_s3_key(key: str) -> str:
    filename = PurePosixPath(key).name
    if not filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="S3 object key must reference a file")
    return filename


def _is_supported_s3_file(key: str) -> bool:
    return PurePosixPath(key).suffix.lower() in SUPPORTED_S3_IMPORT_EXTENSIONS


def _ensure_key_under_prefix(key: str, prefix: str) -> None:
    if not prefix:
        return
    normalized_prefix = prefix if prefix.endswith("/") else f"{prefix}/"
    if key != prefix and not key.startswith(normalized_prefix):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Selected key is outside the requested S3 URL prefix: {key}")


def _validate_s3_import_request_metadata(request: S3ImportRequest) -> None:
    """Apply the batch upload resource bounds to JSON-only S3 imports."""

    try:
        serialized_request = _json.dumps(
            request.model_dump(),
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
        ).encode("utf-8")
    except (TypeError, ValueError, RecursionError, UnicodeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="S3 import metadata must be valid JSON",
        ) from exc

    metadata_limit = _batch_upload_manifest_byte_limit()
    if len(serialized_request) > metadata_limit:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=(
                f"S3 import request metadata is too large: {len(serialized_request)} bytes "
                f"exceeds the configured limit of {metadata_limit} bytes. "
                "Set MAX_BATCH_UPLOAD_MANIFEST_BYTES to adjust this limit."
            ),
        )

    _validate_batch_metadata_structure(request.metadata or {}, position=0)
    for position, metadata in enumerate((request.per_file_metadata or {}).values(), start=1):
        _validate_batch_metadata_structure(metadata, position=position)


def _s3_import_failure(key: str, error: Any) -> Dict[str, str]:
    cleaned_error = " ".join(str(error).replace("\x00", "").split())[:512]
    return {"key": key, "error": cleaned_error or "S3 object could not be imported"}


@router.post("/projects/{project_id}/s3/list", response_model=S3ListResponse)
async def list_project_s3_files(
    project_id: uuid.UUID,
    request: S3ListRequest,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """List supported files under an S3 URL so the user can choose imports."""
    await get_project_or_403(project_id, db, current_user)
    bucket, prefix = _parse_s3_url(request.s3_url)
    configured_limit = _s3_list_key_limit()
    max_keys = max(1, min(request.max_keys or configured_limit, configured_limit))

    try:
        objects = await list_s3_objects(
            bucket,
            prefix,
            max_keys=max_keys + 1,
            key_filter=lambda key: bool(key)
            and not key.endswith("/")
            and _is_supported_s3_file(key),
        )
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Unable to list S3 objects: {exc}") from exc

    summaries: List[S3ObjectSummary] = []
    for obj in objects[:max_keys]:
        key = str(obj.get("key") or "")
        if not key or key.endswith("/") or not _is_supported_s3_file(key):
            continue
        summaries.append(S3ObjectSummary(
            key=key,
            filename=_filename_from_s3_key(key),
            size=int(obj.get("size") or 0),
            content_type=mimetypes.guess_type(key)[0],
            last_modified=obj.get("last_modified").isoformat() if hasattr(obj.get("last_modified"), "isoformat") else None,
        ))

    return S3ListResponse(
        bucket=bucket,
        prefix=prefix,
        objects=summaries,
        truncated=(
            len(objects) > max_keys
            or bool(getattr(objects, "scan_truncated", False))
        ),
    )


@router.post("/projects/{project_id}/s3/import", response_model=S3ImportResponse, status_code=status.HTTP_201_CREATED)
async def import_project_s3_files(
    project_id: uuid.UUID,
    request: S3ImportRequest,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """Copy selected S3 objects with bounded storage work and one DB commit."""
    started_at = time.perf_counter()
    if not request.keys:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Select at least one S3 file to import")
    if len(request.keys) > 100:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Import at most 100 S3 files at a time")
    seen_keys: set[str] = set()
    duplicate_keys: set[str] = set()
    for key in request.keys:
        if key in seen_keys:
            duplicate_keys.add(key)
        seen_keys.add(key)
    if duplicate_keys:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "S3 import keys must be unique; duplicate keys: "
                + ", ".join(sorted(duplicate_keys))
            ),
        )

    db_project = await get_project_or_403_writable(project_id, db, current_user)
    db_project_id = db_project.id
    bucket, prefix = _parse_s3_url(request.s3_url)
    _validate_s3_import_request_metadata(request)
    max_size = _upload_size_limit()
    failures_by_position: Dict[int, Dict[str, str]] = {}
    validated_items: list[Dict[str, Any]] = []

    # Validate every key and all metadata before the first HEAD/COPY side
    # effect. In particular, an out-of-prefix key cannot arrive after valid
    # keys have already been copied.
    for position, key in enumerate(request.keys):
        _ensure_key_under_prefix(key, prefix)
        try:
            if not _is_supported_s3_file(key):
                raise ValueError("Unsupported file type")
            filename = _filename_from_s3_key(key)
            # Provenance is assigned last and cannot be overridden by shared
            # or per-file user metadata.
            merged_metadata = {
                **(request.metadata or {}),
                **((request.per_file_metadata or {}).get(key) or {}),
                "source": "s3_import",
                "source_s3_url": request.s3_url,
                "source_s3_bucket": bucket,
                "source_s3_key": key,
            }
            _validate_batch_metadata_structure(merged_metadata, position=position)
            validated_entry = schemas.BatchImageUploadManifestEntry(
                client_index=position,
                filename=filename,
                metadata=merged_metadata,
                group_identifier=(request.group_identifiers or {}).get(key),
            )
            validated_items.append(
                {
                    "position": position,
                    "key": key,
                    "filename": validated_entry.filename,
                    "metadata": validated_entry.metadata,
                    "group_identifier": validated_entry.group_identifier,
                }
            )
        except HTTPException:
            raise
        except (ValidationError, ValueError) as exc:
            failures_by_position[position] = _s3_import_failure(key, exc)

    validation_finished_at = time.perf_counter()
    request_semaphore = asyncio.Semaphore(_s3_import_concurrency())

    async def inspect_source(item: Dict[str, Any]) -> Dict[str, Any]:
        try:
            async with request_semaphore:
                async with _storage_operation_slot():
                    source_info = await get_s3_object_info(bucket, item["key"])
            if not source_info:
                raise ValueError("S3 object not found or inaccessible")
            size_bytes = int(source_info.get("size") or 0)
            if size_bytes < 0:
                raise ValueError("S3 object reported an invalid negative size")
            if size_bytes > max_size:
                raise ValueError(
                    _file_too_large_detail(item["filename"], size_bytes, max_size)
                )
            source_etag = str(source_info.get("etag") or "").strip()
            if not source_etag:
                raise ValueError(
                    "S3 object did not provide an ETag required for a size-safe conditional copy"
                )
            return {
                **item,
                "source_info": source_info,
                "source_etag": source_etag,
                "size_bytes": size_bytes,
            }
        except Exception as exc:
            return {**item, "failure": _s3_import_failure(item["key"], exc)}

    inspected_results = await asyncio.gather(
        *(inspect_source(item) for item in validated_items)
    )
    inspected_items: list[Dict[str, Any]] = []
    for item in inspected_results:
        if "failure" in item:
            failures_by_position[item["position"]] = item["failure"]
        else:
            inspected_items.append(item)

    inspection_finished_at = time.perf_counter()

    async def copy_source(item: Dict[str, Any]) -> Dict[str, Any]:
        image_id = uuid.uuid4()
        object_storage_key = f"{db_project_id}/{image_id}/{item['filename']}"
        try:
            async with request_semaphore:
                copied = await _copy_target_with_cleanup(
                    source_bucket=bucket,
                    source_key=item["key"],
                    source_etag=item["source_etag"],
                    object_storage_key=object_storage_key,
                )
            if not copied:
                raise ValueError("Failed to copy file to project storage")
            return {
                **item,
                "image_id": image_id,
                "object_storage_key": object_storage_key,
                "content_type": (
                    item["source_info"].get("content_type")
                    or mimetypes.guess_type(item["filename"])[0]
                ),
            }
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            return {**item, "failure": _s3_import_failure(item["key"], exc)}

    copied_target_keys: list[str] = []

    async def tracked_copy_source(item: Dict[str, Any]) -> Dict[str, Any]:
        result = await copy_source(item)
        if "object_storage_key" in result and "failure" not in result:
            copied_target_keys.append(result["object_storage_key"])
        return result

    try:
        copied_results = await asyncio.gather(
            *(tracked_copy_source(item) for item in inspected_items)
        )
    except asyncio.CancelledError:
        # Completed sibling tasks are not themselves cancelled, so clean their
        # successful copies here in addition to each interrupted task's target.
        await _cleanup_batch_upload_objects(copied_target_keys)
        raise
    copied_items: list[Dict[str, Any]] = []
    for item in copied_results:
        if "failure" in item:
            failures_by_position[item["position"]] = item["failure"]
        else:
            copied_items.append(item)

    copy_finished_at = time.perf_counter()
    imported_by_position: list[tuple[int, schemas.DataInstance]] = []
    if copied_items:
        object_storage_keys = [item["object_storage_key"] for item in copied_items]
        try:
            groups_by_identifier = await _resolve_batch_image_groups(
                db,
                project_id=db_project_id,
                identifiers=[
                    item["group_identifier"]
                    for item in copied_items
                    if item["group_identifier"]
                ],
            )
            imported_at = datetime.now(timezone.utc)
            for item in copied_items:
                group = (
                    groups_by_identifier.get(item["group_identifier"])
                    if item["group_identifier"]
                    else None
                )
                db_image = models.DataInstance(
                    id=item["image_id"],
                    project_id=db_project_id,
                    group_id=group.id if group else None,
                    filename=item["filename"],
                    object_storage_key=item["object_storage_key"],
                    content_type=item["content_type"],
                    size_bytes=item["size_bytes"],
                    metadata_json=item["metadata"],
                    uploaded_by_user_id=current_user.email,
                    created_at=imported_at,
                )
                db.add(db_image)
                imported_by_position.append(
                    (
                        item["position"],
                        data_instance_schema_from_values(
                            id=item["image_id"],
                            project_id=db_project_id,
                            group_id=group.id if group else None,
                            filename=item["filename"],
                            object_storage_key=item["object_storage_key"],
                            content_type=item["content_type"],
                            size_bytes=item["size_bytes"],
                            metadata=item["metadata"],
                            uploaded_by_user_id=current_user.email,
                            created_at=imported_at,
                        ),
                    )
                )

            await db.flush()
            await _commit_database_transaction(db)
        except asyncio.CancelledError as exc:
            if getattr(exc, "vista_commit_succeeded", False):
                _clear_project_images_cache_best_effort(project_id)
            else:
                try:
                    await db.rollback()
                except Exception:
                    pass
                await _cleanup_batch_upload_objects(object_storage_keys)
            raise
        except Exception as exc:
            try:
                await db.rollback()
            except Exception:
                pass
            await _cleanup_batch_upload_objects(object_storage_keys)
            logger.error(
                "S3 image import database transaction failed",
                extra={
                    "project_id": str(project_id),
                    "requested_count": len(request.keys),
                    "copied_count": len(copied_items),
                    "duration_ms": round((time.perf_counter() - started_at) * 1000, 1),
                },
                exc_info=True,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Unable to save imported image records",
            ) from exc

        _clear_project_images_cache_best_effort(project_id)

    finished_at = time.perf_counter()
    imported = [
        imported_schema
        for _, imported_schema in sorted(imported_by_position, key=lambda entry: entry[0])
    ]
    failed = [
        failure
        for _, failure in sorted(failures_by_position.items())
    ]
    logger.info(
        "S3 image import completed",
        extra={
            "project_id": str(project_id),
            "requested_count": len(request.keys),
            "validated_count": len(validated_items),
            "imported_count": len(imported),
            "failed_count": len(failed),
            "validation_ms": round((validation_finished_at - started_at) * 1000, 1),
            "inspection_ms": round((inspection_finished_at - validation_finished_at) * 1000, 1),
            "copy_ms": round((copy_finished_at - inspection_finished_at) * 1000, 1),
            "database_ms": round((finished_at - copy_finished_at) * 1000, 1),
            "duration_ms": round((finished_at - started_at) * 1000, 1),
        },
    )

    return S3ImportResponse(imported=imported, failed=failed)


def _batch_upload_file_size(file: UploadFile) -> int:
    """Return a seekable multipart file's exact size without retaining its bytes."""

    try:
        file.file.seek(0, io.SEEK_END)
        file_size = int(file.file.tell())
        if file_size < 0:
            raise ValueError("negative file size")
        return file_size
    except Exception as exc:
        raise ValueError("Unable to determine uploaded file size") from exc
    finally:
        try:
            file.file.seek(0)
        except Exception:
            pass


def _batch_manifest_size_bytes(manifest_json: str) -> int:
    try:
        manifest_size = len(manifest_json.encode("utf-8"))
    except (AttributeError, UnicodeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Batch upload manifest must be valid UTF-8 text",
        ) from exc

    manifest_limit = _batch_upload_manifest_byte_limit()
    if manifest_size > manifest_limit:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=(
                f"Batch upload manifest is too large: {manifest_size} bytes exceeds the "
                f"configured manifest limit of {manifest_limit} bytes. "
                "Set MAX_BATCH_UPLOAD_MANIFEST_BYTES to adjust this limit."
            ),
        )
    return manifest_size


async def _read_batch_upload_manifest(manifest_file: UploadFile) -> tuple[str, int]:
    """Read a multipart manifest with an application-level byte ceiling."""

    manifest_limit = _batch_upload_manifest_byte_limit()
    try:
        raw_manifest = await manifest_file.read(manifest_limit + 1)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unable to read batch upload manifest",
        ) from exc
    if len(raw_manifest) > manifest_limit:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=(
                f"Batch upload manifest is too large: more than {manifest_limit} bytes "
                f"exceeds the configured manifest limit of {manifest_limit} bytes. "
                "Set MAX_BATCH_UPLOAD_MANIFEST_BYTES to adjust this limit."
            ),
        )
    try:
        return raw_manifest.decode("utf-8"), len(raw_manifest)
    except UnicodeDecodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Batch upload manifest must be valid UTF-8 text",
        ) from exc


def _raise_batch_metadata_limit(
    *,
    position: int,
    resource: str,
    observed: int,
    limit: int,
    environment_name: str,
) -> None:
    raise HTTPException(
        status_code=status.HTTP_413_CONTENT_TOO_LARGE,
        detail=(
            f"Batch upload manifest entry {position} metadata {resource} is {observed}; "
            f"the configured limit is {limit}. Set {environment_name} to adjust this limit."
        ),
    )


def _validate_batch_metadata_structure(metadata: Any, *, position: int) -> None:
    """Bound metadata work before Pydantic or database JSON serialization."""

    if not isinstance(metadata, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Batch upload manifest entry {position} metadata must be a JSON object",
        )

    depth_limit = _batch_metadata_depth_limit()
    item_limit = _batch_metadata_item_limit()
    string_limit = _batch_metadata_string_byte_limit()
    key_limit = _batch_metadata_key_byte_limit()
    item_count = 0
    stack: list[tuple[Any, int]] = [(metadata, 1)]

    while stack:
        value, depth = stack.pop()
        if depth > depth_limit:
            _raise_batch_metadata_limit(
                position=position,
                resource="nesting depth",
                observed=depth,
                limit=depth_limit,
                environment_name="MAX_BATCH_METADATA_DEPTH",
            )

        if isinstance(value, dict):
            item_count += len(value)
            if item_count > item_limit:
                _raise_batch_metadata_limit(
                    position=position,
                    resource="item count",
                    observed=item_count,
                    limit=item_limit,
                    environment_name="MAX_BATCH_METADATA_ITEMS",
                )
            for key, child in value.items():
                key_size = len(key.encode("utf-8"))
                if key_size > key_limit:
                    _raise_batch_metadata_limit(
                        position=position,
                        resource="key size in bytes",
                        observed=key_size,
                        limit=key_limit,
                        environment_name="MAX_BATCH_METADATA_KEY_BYTES",
                    )
                if isinstance(child, (dict, list)):
                    stack.append((child, depth + 1))
                elif isinstance(child, str):
                    string_size = len(child.encode("utf-8"))
                    if string_size > string_limit:
                        _raise_batch_metadata_limit(
                            position=position,
                            resource="string size in bytes",
                            observed=string_size,
                            limit=string_limit,
                            environment_name="MAX_BATCH_METADATA_STRING_BYTES",
                        )
                elif isinstance(child, float) and not math.isfinite(child):
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=(
                            f"Batch upload manifest entry {position} metadata contains "
                            "a non-finite number"
                        ),
                    )
        elif isinstance(value, list):
            item_count += len(value)
            if item_count > item_limit:
                _raise_batch_metadata_limit(
                    position=position,
                    resource="item count",
                    observed=item_count,
                    limit=item_limit,
                    environment_name="MAX_BATCH_METADATA_ITEMS",
                )
            for child in value:
                if isinstance(child, (dict, list)):
                    stack.append((child, depth + 1))
                elif isinstance(child, str):
                    string_size = len(child.encode("utf-8"))
                    if string_size > string_limit:
                        _raise_batch_metadata_limit(
                            position=position,
                            resource="string size in bytes",
                            observed=string_size,
                            limit=string_limit,
                            environment_name="MAX_BATCH_METADATA_STRING_BYTES",
                        )
                elif isinstance(child, float) and not math.isfinite(child):
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=(
                            f"Batch upload manifest entry {position} metadata contains "
                            "a non-finite number"
                        ),
                    )

    try:
        metadata_size = len(
            _json.dumps(
                metadata,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            ).encode("utf-8")
        )
    except (TypeError, ValueError, RecursionError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Batch upload manifest entry {position} metadata is not valid JSON",
        ) from exc
    metadata_limit = _batch_metadata_byte_limit()
    if metadata_size > metadata_limit:
        _raise_batch_metadata_limit(
            position=position,
            resource="serialized size in bytes",
            observed=metadata_size,
            limit=metadata_limit,
            environment_name="MAX_BATCH_METADATA_BYTES",
        )


def _parse_batch_upload_manifest(
    manifest_json: str,
    *,
    file_count: int,
) -> tuple[list[schemas.BatchImageUploadManifestEntry], int]:
    manifest_size = _batch_manifest_size_bytes(manifest_json)
    try:
        raw_manifest = _json.loads(manifest_json)
    except RecursionError as exc:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=(
                "Batch upload manifest nesting exceeds the JSON parser's built-in limit; "
                "reduce its depth. MAX_BATCH_METADATA_DEPTH controls the application limit."
            ),
        ) from exc
    except (TypeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid JSON format for batch upload manifest",
        ) from exc

    if not isinstance(raw_manifest, list):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Batch upload manifest must be a JSON array",
        )
    if len(raw_manifest) != file_count:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Batch upload manifest must contain exactly one entry for each file",
        )

    entries: list[schemas.BatchImageUploadManifestEntry] = []
    for position, raw_entry in enumerate(raw_manifest):
        if not isinstance(raw_entry, dict):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Batch upload manifest entry {position} must be a JSON object",
            )
        _validate_batch_metadata_structure(raw_entry.get("metadata", {}), position=position)
        try:
            entries.append(schemas.BatchImageUploadManifestEntry.model_validate(raw_entry))
        except ValidationError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Batch upload manifest entry {position} is invalid",
            ) from exc

    client_indices = [entry.client_index for entry in entries]
    if len(client_indices) != len(set(client_indices)):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Batch upload manifest client_index values must be unique",
        )
    return entries, manifest_size


def _batch_item_failure(
    entry: schemas.BatchImageUploadManifestEntry,
    *,
    code: str,
    detail: str,
) -> schemas.BatchImageUploadFailure:
    cleaned_detail = " ".join(str(detail).replace("\x00", "").split())[:512]
    return schemas.BatchImageUploadFailure(
        client_index=entry.client_index,
        filename=entry.filename,
        code=code,
        detail=cleaned_detail or "File could not be uploaded",
    )


async def _cleanup_batch_upload_objects(object_storage_keys: list[str]) -> None:
    """Best-effort cleanup for objects uploaded before a database failure."""

    semaphore = asyncio.Semaphore(_batch_upload_concurrency())

    async def delete_one(object_storage_key: str) -> None:
        async with semaphore:
            try:
                async with _storage_operation_slot():
                    loop = asyncio.get_running_loop()
                    delete_future = loop.run_in_executor(
                        None,
                        delete_file_from_s3,
                        settings.S3_BUCKET,
                        object_storage_key,
                    )
                    try:
                        result = await asyncio.shield(delete_future)
                    except asyncio.CancelledError as cancelled:
                        while not delete_future.done():
                            try:
                                await asyncio.shield(delete_future)
                            except asyncio.CancelledError:
                                continue
                            except BaseException:
                                break
                        if delete_future.done():
                            try:
                                result = delete_future.result()
                            except BaseException:
                                result = False
                        raise cancelled
                if asyncio.iscoroutine(result):
                    await result
            except asyncio.CancelledError:
                raise
            except Exception:
                # The database error remains the primary failure. Storage
                # helpers log cleanup failures without exposing object keys.
                pass

    cleanup_task = asyncio.ensure_future(
        asyncio.gather(*(delete_one(key) for key in object_storage_keys))
    ) if object_storage_keys else None
    if cleanup_task is None:
        return
    try:
        await asyncio.shield(cleanup_task)
    except asyncio.CancelledError as cancelled:
        while not cleanup_task.done():
            try:
                await asyncio.shield(cleanup_task)
            except asyncio.CancelledError:
                continue
            except BaseException:
                break
        raise cancelled


async def _upload_target_with_cleanup(
    *,
    object_storage_key: str,
    file_data: Any,
    length: int,
    content_type: Optional[str],
) -> bool:
    """Upload one unique target and remove it on every non-success outcome."""

    try:
        async with _storage_operation_slot():
            uploaded = await upload_file_to_s3(
                bucket_name=settings.S3_BUCKET,
                object_name=object_storage_key,
                file_data=file_data,
                length=length,
                content_type=content_type or "application/octet-stream",
            )
    except asyncio.CancelledError:
        await _cleanup_batch_upload_objects([object_storage_key])
        raise
    except Exception:
        await _cleanup_batch_upload_objects([object_storage_key])
        return False
    if not uploaded:
        await _cleanup_batch_upload_objects([object_storage_key])
        return False
    return True


async def _copy_target_with_cleanup(
    *,
    source_bucket: str,
    source_key: str,
    source_etag: str,
    object_storage_key: str,
) -> bool:
    """Copy one unique target and remove ambiguous/failed destinations."""

    try:
        async with _storage_operation_slot():
            copied = await copy_s3_object_to_s3(
                source_bucket,
                source_key,
                settings.S3_BUCKET,
                object_storage_key,
                source_etag=source_etag,
            )
    except asyncio.CancelledError:
        await _cleanup_batch_upload_objects([object_storage_key])
        raise
    except Exception:
        await _cleanup_batch_upload_objects([object_storage_key])
        return False
    if not copied:
        await _cleanup_batch_upload_objects([object_storage_key])
        return False
    return True


async def _resolve_batch_image_groups(
    db: AsyncSession,
    *,
    project_id: uuid.UUID,
    identifiers: list[str],
) -> Dict[str, models.ImageGroup]:
    """Resolve groups with a unique-key upsert safe under concurrent batches."""

    unique_identifiers = sorted(set(identifiers))
    if not unique_identifiers:
        return {}

    # Always issue the idempotent insert first. Besides eliminating a query,
    # this closes the classic SELECT-then-INSERT race between two requests.
    values = [
        {
            "id": uuid.uuid4(),
            "project_id": project_id,
            "identifier": identifier,
        }
        for identifier in unique_identifiers
    ]
    dialect_name = db.get_bind().dialect.name
    if dialect_name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as dialect_insert

        statement = dialect_insert(models.ImageGroup).values(values).on_conflict_do_nothing(
            constraint="uix_image_groups_project_identifier"
        )
        await db.execute(statement)
    elif dialect_name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as dialect_insert

        statement = dialect_insert(models.ImageGroup).values(values).on_conflict_do_nothing(
            index_elements=["project_id", "identifier"]
        )
        await db.execute(statement)
    else:
        # Preserve support for other SQLAlchemy dialects. A savepoint keeps
        # the outer image transaction usable if another request wins the
        # unique-key race between our INSERT and INSERT.
        for value in values:
            try:
                async with db.begin_nested():
                    await db.execute(insert(models.ImageGroup).values(**value))
            except IntegrityError:
                pass

    # In PostgreSQL READ COMMITTED, an ON CONFLICT statement waits for the
    # winning transaction and this new statement snapshot sees its row.
    resolved_result = await db.execute(
        select(models.ImageGroup).where(
            models.ImageGroup.project_id == project_id,
            models.ImageGroup.identifier.in_(unique_identifiers),
        )
    )
    groups_by_identifier = {
        group.identifier: group for group in resolved_result.scalars().all()
    }

    unresolved = set(unique_identifiers) - set(groups_by_identifier)
    if unresolved:
        raise RuntimeError("Unable to resolve one or more image groups")
    return groups_by_identifier


def _clear_project_images_cache_best_effort(project_id: uuid.UUID) -> None:
    """Never report a committed upload as failed because cache eviction failed."""

    try:
        get_cache().clear_pattern(f"project_images:{project_id}")
    except Exception:
        logger.warning(
            "Image batch committed but project image cache invalidation failed",
            extra={"project_id": str(project_id)},
            exc_info=True,
        )


@router.post(
    "/projects/{project_id}/images/batch",
    response_model=schemas.BatchImageUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_images_to_project_batch(
    project_id: uuid.UUID,
    files: List[UploadFile] = File(...),
    manifest_file: UploadFile = File(..., alias="manifest"),
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """Upload a bounded batch with one authorization and one database commit.

    ``files`` and ``manifest`` are positional peers. ``client_index`` is the
    stable response identity and does not depend on filenames, so duplicate
    final filenames remain unambiguous.
    """
    started_at = time.perf_counter()

    db_project = await get_project_or_403_writable(project_id, db, current_user)
    db_project_id = db_project.id
    project_type = db_project.project_type

    if not files:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Select at least one image file to upload",
        )
    file_limit = _batch_upload_file_limit()
    if len(files) > file_limit:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=f"Batch contains {len(files)} files; the configured limit is {file_limit}",
        )

    manifest_json, manifest_size = await _read_batch_upload_manifest(manifest_file)
    manifest, _ = _parse_batch_upload_manifest(
        manifest_json,
        file_count=len(files),
    )
    for file, entry in zip(files, manifest):
        # Inspection and object naming must use the requested final filename,
        # rather than a possibly duplicated or browser-normalized source name.
        file.filename = entry.filename

    try:
        file_sizes = await asyncio.gather(
            *(asyncio.to_thread(_batch_upload_file_size, file) for file in files)
        )
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    per_file_limit = _upload_size_limit()
    for entry, file_size in zip(manifest, file_sizes):
        if file_size > per_file_limit:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail=_file_too_large_detail(entry.filename, file_size, per_file_limit),
            )

    aggregate_size = sum(file_sizes) + manifest_size
    aggregate_limit = _batch_upload_byte_limit()
    if aggregate_size > aggregate_limit:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=(
                f"Batch request is too large: {aggregate_size} file-and-manifest bytes "
                f"exceeds the configured batch upload limit of {_format_byte_limit(aggregate_limit)}. "
                "Set MAX_BATCH_UPLOAD_BYTES to adjust this limit."
            ),
        )
    preflight_finished_at = time.perf_counter()

    semaphore = asyncio.Semaphore(_batch_upload_concurrency())
    failures: list[schemas.BatchImageUploadFailure] = []

    async def inspect_one(
        position: int,
        file: UploadFile,
        entry: schemas.BatchImageUploadManifestEntry,
    ) -> Optional[Dict[str, Any]]:
        async with semaphore:
            try:
                inspected_metadata, inspected_size = await asyncio.to_thread(
                    _inspect_upload_file,
                    file,
                    validate_ordinary_header=True,
                )
            except HTTPException as exc:
                failures.append(
                    _batch_item_failure(
                        entry,
                        code="validation_failed",
                        detail=str(exc.detail),
                    )
                )
                return None
            except Exception:
                failures.append(
                    _batch_item_failure(
                        entry,
                        code="inspection_failed",
                        detail="File inspection failed",
                    )
                )
                return None

        merged_metadata = dict(entry.metadata)
        merged_metadata.update(inspected_metadata)
        if project_type == "PT3" and _is_volume_upload_metadata(merged_metadata):
            failures.append(
                _batch_item_failure(
                    entry,
                    code="legacy_route_required",
                    detail=(
                        "PT3 volume files must use the single-image upload endpoint "
                        "so inspection-part assignment remains atomic"
                    ),
                )
            )
            return None
        return {
            "position": position,
            "file": file,
            "entry": entry,
            "file_size": inspected_size if inspected_size is not None else file_sizes[position],
            "metadata": merged_metadata,
        }

    inspected = await asyncio.gather(
        *(inspect_one(position, file, entry) for position, (file, entry) in enumerate(zip(files, manifest)))
    )
    upload_candidates = [item for item in inspected if item is not None]
    inspection_finished_at = time.perf_counter()

    async def upload_one(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        entry = item["entry"]
        image_id = uuid.uuid4()
        object_storage_key = f"{db_project_id}/{image_id}/{entry.filename}"
        content_type = (
            item["file"].content_type
            or mimetypes.guess_type(entry.filename)[0]
            or "application/octet-stream"
        )
        async with semaphore:
            uploaded = await _upload_target_with_cleanup(
                object_storage_key=object_storage_key,
                file_data=item["file"].file,
                length=item["file_size"],
                content_type=content_type,
            )
        if not uploaded:
            failures.append(
                _batch_item_failure(
                    entry,
                    code="storage_upload_failed",
                    detail="Failed to upload file to object storage",
                )
            )
            return None
        return {
            **item,
            "image_id": image_id,
            "object_storage_key": object_storage_key,
            "content_type": content_type,
        }

    completed_upload_keys: list[str] = []

    async def tracked_upload_one(item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        result = await upload_one(item)
        if result is not None:
            completed_upload_keys.append(result["object_storage_key"])
        return result

    try:
        upload_results = await asyncio.gather(
            *(tracked_upload_one(item) for item in upload_candidates)
        )
    except asyncio.CancelledError:
        await _cleanup_batch_upload_objects(completed_upload_keys)
        raise
    uploaded_items = [item for item in upload_results if item is not None]
    storage_finished_at = time.perf_counter()

    if not uploaded_items:
        finished_at = time.perf_counter()
        logger.info(
            "Image batch upload completed",
            extra={
                "project_id": str(project_id),
                "requested_count": len(files),
                "uploaded_count": 0,
                "failed_count": len(failures),
                "request_bytes": aggregate_size,
                "preflight_ms": round((preflight_finished_at - started_at) * 1000, 1),
                "inspection_ms": round((inspection_finished_at - preflight_finished_at) * 1000, 1),
                "storage_ms": round((storage_finished_at - inspection_finished_at) * 1000, 1),
                "database_ms": 0.0,
                "duration_ms": round((finished_at - started_at) * 1000, 1),
            },
        )
        return schemas.BatchImageUploadResponse(
            uploaded=[],
            failed=sorted(failures, key=lambda item: item.client_index),
        )

    object_storage_keys = [item["object_storage_key"] for item in uploaded_items]
    uploaded_response: list[schemas.BatchImageUploadSuccess] = []
    try:
        requested_group_identifiers = sorted(
            {
                item["entry"].group_identifier
                for item in uploaded_items
                if item["entry"].group_identifier
            }
        )
        groups_by_identifier = await _resolve_batch_image_groups(
            db,
            project_id=db_project_id,
            identifiers=requested_group_identifiers,
        )

        uploaded_at = datetime.now(timezone.utc)
        for item in uploaded_items:
            entry = item["entry"]
            group = groups_by_identifier.get(entry.group_identifier) if entry.group_identifier else None
            group_id = group.id if group else None
            db_image = models.DataInstance(
                id=item["image_id"],
                project_id=db_project_id,
                group_id=group_id,
                filename=entry.filename,
                object_storage_key=item["object_storage_key"],
                content_type=item["content_type"],
                size_bytes=item["file_size"],
                metadata_json=item["metadata"],
                uploaded_by_user_id=current_user.email,
                created_at=uploaded_at,
            )
            db.add(db_image)
            uploaded_response.append(
                schemas.BatchImageUploadSuccess(
                    client_index=entry.client_index,
                    image=data_instance_schema_from_values(
                        id=item["image_id"],
                        project_id=db_project_id,
                        group_id=group_id,
                        filename=entry.filename,
                        object_storage_key=item["object_storage_key"],
                        content_type=item["content_type"],
                        size_bytes=item["file_size"],
                        metadata=item["metadata"],
                        uploaded_by_user_id=current_user.email,
                        created_at=uploaded_at,
                    ),
                )
            )

        await db.flush()
        await _commit_database_transaction(db)
    except asyncio.CancelledError as exc:
        if getattr(exc, "vista_commit_succeeded", False):
            _clear_project_images_cache_best_effort(project_id)
        else:
            try:
                await db.rollback()
            except Exception:
                pass
            await _cleanup_batch_upload_objects(object_storage_keys)
        raise
    except Exception as exc:
        try:
            await db.rollback()
        except Exception:
            pass
        await _cleanup_batch_upload_objects(object_storage_keys)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Unable to save uploaded image records",
        ) from exc

    # One invalidation covers every row committed above. It is deliberately
    # best-effort because the database and object-storage writes are durable.
    _clear_project_images_cache_best_effort(project_id)
    finished_at = time.perf_counter()
    logger.info(
        "Image batch upload completed",
        extra={
            "project_id": str(project_id),
            "requested_count": len(files),
            "uploaded_count": len(uploaded_response),
            "failed_count": len(failures),
            "request_bytes": aggregate_size,
            "preflight_ms": round((preflight_finished_at - started_at) * 1000, 1),
            "inspection_ms": round((inspection_finished_at - preflight_finished_at) * 1000, 1),
            "storage_ms": round((storage_finished_at - inspection_finished_at) * 1000, 1),
            "database_ms": round((finished_at - storage_finished_at) * 1000, 1),
            "duration_ms": round((finished_at - started_at) * 1000, 1),
        },
    )
    return schemas.BatchImageUploadResponse(
        uploaded=sorted(uploaded_response, key=lambda item: item.client_index),
        failed=sorted(failures, key=lambda item: item.client_index),
    )


@router.post("/projects/{project_id}/images", response_model=schemas.DataInstance, status_code=status.HTTP_201_CREATED)
async def upload_image_to_project(
    project_id: uuid.UUID,
    file: UploadFile = File(...),
    metadata_json: Optional[str] = Form(None, alias="metadata"),
    group_identifier: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """
    Uploads an image file to a specified project.
    It handles file validation, metadata parsing, and storage.
    The image is associated with the project and the uploading user.
    Optionally accepts group_identifier to assign the image to a group (find-or-create).
    """
    db_project = await get_project_or_403_writable(project_id, db, current_user)
    # Capture scalar values before any blocking IO to avoid MissingGreenlet
    # errors when SQLAlchemy tries to lazy-load expired attributes.
    db_project_id = db_project.id
    image_id = uuid.uuid4()
    object_storage_key = f"{db_project_id}/{image_id}/{file.filename}"
    parsed_metadata: Optional[Dict[str, Any]] = None
    if metadata_json:
        try:
            parsed_metadata = _json.loads(metadata_json)
        except _json.JSONDecodeError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid JSON format for metadata")
    if parsed_metadata is None:
        parsed_metadata = {}
    if not isinstance(parsed_metadata, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Image metadata must be a JSON object",
        )
    inspected_metadata, file_size = await asyncio.to_thread(_inspect_upload_file, file)
    parsed_metadata.update(inspected_metadata)
    max_size = _upload_size_limit()
    if file_size and file_size > max_size:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail=_file_too_large_detail(file.filename, file_size, max_size),
        )
    success = await _upload_target_with_cleanup(
        object_storage_key=object_storage_key,
        file_data=file.file,
        length=file_size or 0,
        content_type=file.content_type,
    )
    if not success:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to upload file to object storage")

    try:
        resolved_group_id: Optional[uuid.UUID] = None
        normalized_group_identifier = (group_identifier or "").strip()
        if normalized_group_identifier:
            groups = await _resolve_batch_image_groups(
                db,
                project_id=db_project_id,
                identifiers=[normalized_group_identifier],
            )
            resolved_group_id = groups[normalized_group_identifier].id

        uploaded_at = datetime.now(timezone.utc)
        db_data_instance = models.DataInstance(
            id=image_id,
            project_id=db_project_id,
            filename=file.filename,
            object_storage_key=object_storage_key,
            content_type=file.content_type,
            size_bytes=file_size,
            metadata_json=parsed_metadata,
            uploaded_by_user_id=current_user.email,
            group_id=resolved_group_id,
            created_at=uploaded_at,
        )
        db.add(db_data_instance)
        await db.flush()
        await _autoassign_pt3_volume_upload_to_part(
            db=db,
            project=db_project,
            image=db_data_instance,
            current_user=current_user,
            commit=False,
        )
        await db.flush()
        response_image = data_instance_schema_from_values(
            id=image_id,
            project_id=db_project_id,
            group_id=resolved_group_id,
            filename=file.filename,
            object_storage_key=object_storage_key,
            content_type=file.content_type,
            size_bytes=file_size,
            metadata=parsed_metadata,
            uploaded_by_user_id=current_user.email,
            created_at=uploaded_at,
        )
        await _commit_database_transaction(db)
    except asyncio.CancelledError as exc:
        if getattr(exc, "vista_commit_succeeded", False):
            _clear_project_images_cache_best_effort(project_id)
        else:
            try:
                await db.rollback()
            except Exception:
                pass
            await _cleanup_batch_upload_objects([object_storage_key])
        raise
    except Exception as exc:
        try:
            await db.rollback()
        except Exception:
            pass
        await _cleanup_batch_upload_objects([object_storage_key])
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Unable to save uploaded image record",
        ) from exc

    _clear_project_images_cache_best_effort(project_id)
    return response_image

@router.get("/projects/{project_id}/images", response_model=List[schemas.DataInstance])
async def list_images_in_project(
    project_id: uuid.UUID,
    skip: int = 0,
    limit: int = 100,
    include_deleted: bool = Query(False),
    deleted_only: bool = Query(False),
    search_field: Optional[str] = Query(None),
    search_value: Optional[str] = Query(None),
    group_id: Optional[uuid.UUID] = Query(None),
    ungrouped: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """
    Retrieves a list of images for a given project.
    It first verifies project existence and user access, then uses a per-user
    cache for performance before falling back to the database.
    Optionally filter by group_id, or pass ungrouped=true to get images with no group.
    These two filters are mutually exclusive.
    """
    if group_id is not None and ungrouped:
        raise HTTPException(status_code=400, detail="group_id and ungrouped=true are mutually exclusive")
    if deleted_only and (group_id is not None or ungrouped):
        raise HTTPException(status_code=400, detail="group_id and ungrouped filters cannot be combined with deleted_only")

    # Check project access BEFORE cache lookup to prevent cross-user data leakage
    try:
        await get_project_or_403(project_id, db, current_user)
    except HTTPException as e:
        if e.status_code == status.HTTP_404_NOT_FOUND:
            # If project doesn't exist, return empty list instead of 404
            return []
        # Re-raise other exceptions (like permission issues)
        raise

    # Check cache (keyed per-user to prevent cross-user leakage)
    cache = get_cache()
    cache_key = f"project_images:{project_id}:user:{current_user.email}:skip:{skip}:limit:{limit}:include_deleted:{include_deleted}:deleted_only:{deleted_only}:search_field:{search_field}:search_value:{search_value}:group_id:{group_id}:ungrouped:{ungrouped}"
    cached_images = cache.get(cache_key)

    if cached_images is not None:
        return cached_images

    # Get images for the project
    if deleted_only:
        images = await crud.get_deleted_images_for_project(db=db, project_id=project_id, skip=skip, limit=limit)
    else:
        images = await crud.get_data_instances_for_project(
            db=db,
            project_id=project_id,
            skip=skip,
            limit=limit,
            search_field=search_field,
            search_value=search_value,
            group_id=group_id,
            ungrouped=ungrouped,
            include_deleted=include_deleted,
        )

    # Process images using utility function for consistent serialization
    response_images = []
    if images:
        for img in images:
            try:
                # Skip deleted images unless explicitly requested
                if img.deleted_at is not None and not include_deleted and not deleted_only:
                    continue
                response_images.append(to_data_instance_schema(img))
            except Exception as e:
                print(f"Error serializing image {img.id}: {e}")
                # Skip this image but continue processing others
                continue

    # Cache the result (30 minutes) - cache even if empty list
    cache.set(cache_key, response_images, expire=30*60)

    return response_images


@router.get("/projects/{project_id}/images-page", response_model=schemas.DataInstancePage)
async def list_images_in_project_page(
    project_id: uuid.UUID,
    limit: int = Query(100, ge=1, le=500),
    cursor: Optional[str] = Query(None, max_length=512),
    include_deleted: bool = Query(False),
    deleted_only: bool = Query(False),
    search_field: Optional[str] = Query(None),
    search_value: Optional[str] = Query(None),
    group_id: Optional[uuid.UUID] = Query(None),
    ungrouped: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """Return an exact-count, stable keyset page of project images."""
    if group_id is not None and ungrouped:
        raise HTTPException(status_code=400, detail="group_id and ungrouped=true are mutually exclusive")
    if deleted_only and (group_id is not None or ungrouped):
        raise HTTPException(status_code=400, detail="group_id and ungrouped filters cannot be combined with deleted_only")

    await get_project_or_403(project_id, db, current_user)
    cursor_created_at: Optional[datetime] = None
    cursor_id: Optional[uuid.UUID] = None
    if cursor is not None:
        cursor_created_at, cursor_id = _decode_image_page_cursor(cursor)

    started = time.perf_counter()
    raw_items, total = await crud.get_data_instance_page(
        db,
        project_id=project_id,
        limit=limit,
        cursor_created_at=cursor_created_at,
        cursor_id=cursor_id,
        include_deleted=include_deleted,
        deleted_only=deleted_only,
        search_field=search_field,
        search_value=search_value,
        group_id=group_id,
        ungrouped=ungrouped,
    )
    has_more = len(raw_items) > limit
    page_items = raw_items[:limit]
    next_cursor = None
    if has_more and page_items:
        last_item = page_items[-1]
        next_cursor = _encode_image_page_cursor(last_item.created_at, last_item.id)

    logger.info(
        "PROJECT_IMAGES_PAGE",
        extra={
            "project_id": str(project_id),
            "returned": len(page_items),
            "total": total,
            "has_more": has_more,
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 3),
        },
    )
    return schemas.DataInstancePage(
        items=[to_data_instance_schema(item) for item in page_items],
        total=total,
        next_cursor=next_cursor,
        has_more=has_more,
    )

# Add trailing slash version to handle frontend requests
@router.get("/projects/{project_id}/images/", response_model=List[schemas.DataInstance])
async def list_images_in_project_with_slash(
    project_id: uuid.UUID,
    skip: int = 0,
    limit: int = 100,
    include_deleted: bool = Query(False),
    deleted_only: bool = Query(False),
    search_field: Optional[str] = Query(None),
    search_value: Optional[str] = Query(None),
    group_id: Optional[uuid.UUID] = Query(None),
    ungrouped: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """
    Provides an alternative endpoint for listing project images.
    This route handles requests with a trailing slash, redirecting to the main function.
    It ensures compatibility with various frontend routing configurations.
    """
    # Just call the main function to avoid code duplication
    return await list_images_in_project(project_id, skip, limit, include_deleted, deleted_only, search_field, search_value, group_id, ungrouped, db, current_user)


@router.get("/images/{image_id}", response_model=schemas.DataInstance)
async def get_image_metadata(
    image_id: uuid.UUID,
    include_deleted: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """
    Fetches metadata for a specific image using its ID.
    It verifies image existence and user access before checking the per-user
    cache, then falls back to serialization from the database record.
    """
    # Check image existence and access BEFORE cache lookup to prevent
    # serving stale data after permission revocation
    db_image = await crud.get_data_instance(db=db, image_id=image_id)
    if db_image is None or (db_image.deleted_at and not include_deleted):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image not found")
    is_member = is_user_in_group(current_user.email, db_image.project.meta_group_id)
    if not is_member:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"User '{current_user.email}' does not have access to image '{image_id}'",
        )

    # Check cache (keyed per-user) for serialized response
    cache = get_cache()
    cache_key = f"image:{image_id}:user:{current_user.email}:metadata"
    cached_metadata = cache.get(cache_key)

    if cached_metadata is not None:
        return cached_metadata

    # Use utility function for consistent metadata serialization
    result = to_data_instance_schema(db_image)

    # Cache the result (1 hour)
    cache.set(cache_key, result, expire=60*60)

    return result

import httpx
from fastapi.responses import StreamingResponse


def _storage_http_exception(exc: Exception) -> HTTPException:
    if isinstance(exc, httpx.TimeoutException) or getattr(exc, 'timed_out', False):
        return HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail="Object storage request timed out",
        )
    return HTTPException(
        status_code=status.HTTP_502_BAD_GATEWAY,
        detail="Unable to retrieve image data from object storage",
    )


def _volume_cache_http_exception() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail="Volume cache is temporarily unavailable",
    )

@router.get("/images/{image_id}/download", response_model=schemas.PresignedUrlResponse)
async def get_image_download_url(
    image_id: uuid.UUID,
    include_deleted: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """
    Generates a presigned URL for downloading a specific image.
    It retrieves the image details and checks user permissions.
    The URL allows direct download from the object storage.
    """
    db_image = await crud.get_data_instance(db=db, image_id=image_id)
    if db_image is None or (db_image.deleted_at and not include_deleted):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image not found")
    is_member = is_user_in_group(current_user.email, db_image.project.meta_group_id)
    if not is_member:
         raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"User '{current_user.email}' does not have access to image '{image_id}'",
        )

    # Get the presigned URL for internal use
    internal_url = get_presigned_download_url(
        bucket_name=settings.S3_BUCKET,
        object_name=db_image.object_storage_key
    )
    if not internal_url:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not generate download URL")

    # Create a proxy URL that goes through our API
    proxy_url = f"/images/{image_id}/content"

    return schemas.PresignedUrlResponse(url=proxy_url, object_key=db_image.object_storage_key)

# Content types that browsers can display natively
WEB_FRIENDLY_CONTENT_TYPES = {
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'
}


def convert_to_web_format(image_data: bytes, content_type: str) -> tuple[bytes, str]:
    """
    Convert non-web-friendly image formats to PNG/JPEG while preserving dimensions.
    Returns (converted_data, new_content_type) or (original_data, original_content_type).
    """
    if content_type in WEB_FRIENDLY_CONTENT_TYPES:
        return image_data, content_type

    try:
        img = Image.open(io.BytesIO(image_data))
        normalized_scalar = _normalize_scalar_image_to_uint8(img)
        if normalized_scalar is not None:
            output_buffer = io.BytesIO()
            normalized_scalar.save(output_buffer, format='PNG')
            output_buffer.seek(0)
            return output_buffer.getvalue(), 'image/png'

        # Determine output format based on image characteristics
        if img.mode in ('RGBA', 'LA', 'PA') or (img.mode == 'P' and 'transparency' in img.info):
            # Has transparency - use PNG
            if img.mode == 'P':
                img = img.convert('RGBA')
            elif img.mode in ('LA', 'PA'):
                img = img.convert('RGBA')
            output_format = 'PNG'
            output_content_type = 'image/png'
        else:
            # No transparency - use JPEG for efficiency
            if img.mode not in ('RGB', 'L'):
                img = img.convert('RGB')
            output_format = 'JPEG'
            output_content_type = 'image/jpeg'

        output_buffer = io.BytesIO()
        if output_format == 'JPEG':
            img.save(output_buffer, format=output_format, quality=95)
        else:
            img.save(output_buffer, format=output_format)
        output_buffer.seek(0)
        return output_buffer.getvalue(), output_content_type

    except Exception:
        # If conversion fails, return original data
        return image_data, content_type



_VOLUME_SLICE_CACHE_MAX_ITEMS = 256
_volume_slice_png_cache: "OrderedDict[tuple[str, str, int, str], bytes]" = OrderedDict()
_volume_slice_png_cache_lock = threading.RLock()
_volume_slice_render_futures: dict[
    tuple[str, str, int, str], Future[bytes]
] = {}
_VOLUME_RENDER_SUMMARY_VERSION = 1
_VOLUME_RENDER_SUMMARY_CACHE_MAX_ITEMS = 128
_VOLUME_RENDER_SUMMARY_SCAN_MAX_PIXELS = 256 * 1024
_VOLUME_RENDER_SUMMARY_SCAN_CONCURRENCY = 2
_VOLUME_CONNECTED_SELECTION_CONCURRENCY = 2
_VOLUME_CONNECTED_SELECTION_DECODE_CONCURRENCY = 1
_VOLUME_CONNECTED_SELECTION_MAX_SOURCE_BYTES = 128 * 1024 * 1024
_VOLUME_CONNECTED_SELECTION_MAX_VOXELS = 32 * 1024 * 1024
_VOLUME_CONNECTED_SELECTION_MAX_DECODED_BYTES = 256 * 1024 * 1024
_volume_render_summary_cache: "OrderedDict[tuple[str, str, int], Dict[str, Any]]" = OrderedDict()
_volume_render_summary_cache_lock = threading.RLock()
_volume_render_summary_futures: dict[
    tuple[str, str, int], Future[Dict[str, Any]]
] = {}
_PROCESS_VOLUME_RENDER_SUMMARY_SCAN_LIMITER = _ProcessWideStorageLimiter(
    _VOLUME_RENDER_SUMMARY_SCAN_CONCURRENCY
)
_PROCESS_VOLUME_CONNECTED_SELECTION_SEMAPHORE = threading.BoundedSemaphore(
    _VOLUME_CONNECTED_SELECTION_CONCURRENCY
)
_PROCESS_VOLUME_CONNECTED_SELECTION_DECODE_SEMAPHORE = threading.BoundedSemaphore(
    _VOLUME_CONNECTED_SELECTION_DECODE_CONCURRENCY
)
_VOLUME_CONNECTED_SELECTION_EXECUTOR = ThreadPoolExecutor(
    max_workers=_VOLUME_CONNECTED_SELECTION_CONCURRENCY,
    thread_name_prefix="vista-volume-connected",
)


class _VolumeConnectedSelectionLease:
    """Keep one admission permit until its submitted worker truly finishes."""

    def __init__(self, semaphore: threading.BoundedSemaphore) -> None:
        self._semaphore = semaphore
        self._release_on_exit = True

    def release_when_done(self, worker_future: Future[Any]) -> None:
        if not self._release_on_exit:
            raise RuntimeError("volume connected-selection lease was already transferred")
        self._release_on_exit = False
        worker_future.add_done_callback(lambda _future: self._semaphore.release())

    def release_if_owned(self) -> None:
        if self._release_on_exit:
            self._release_on_exit = False
            self._semaphore.release()


@asynccontextmanager
async def _volume_connected_selection_slot():
    """Reject excess flood-fill work instead of building an unbounded queue."""

    acquired = _PROCESS_VOLUME_CONNECTED_SELECTION_SEMAPHORE.acquire(blocking=False)
    if not acquired:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Volume connected-selection capacity is busy; retry shortly",
            headers={"Retry-After": "1"},
        )
    lease = _VolumeConnectedSelectionLease(
        _PROCESS_VOLUME_CONNECTED_SELECTION_SEMAPHORE
    )
    try:
        yield lease
    finally:
        lease.release_if_owned()


@asynccontextmanager
async def _volume_connected_selection_decode_slot():
    """Allow only one materialized TIFF/NPZ decode per process."""

    acquired = _PROCESS_VOLUME_CONNECTED_SELECTION_DECODE_SEMAPHORE.acquire(
        blocking=False
    )
    if not acquired:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Volume connected-selection decode capacity is busy; retry shortly",
            headers={"Retry-After": "1"},
        )
    lease = _VolumeConnectedSelectionLease(
        _PROCESS_VOLUME_CONNECTED_SELECTION_DECODE_SEMAPHORE
    )
    try:
        yield lease
    finally:
        lease.release_if_owned()


@asynccontextmanager
async def _volume_connected_selection_materialization_slot(kind: str):
    if kind == "npy":
        yield None
        return
    async with _volume_connected_selection_decode_slot() as lease:
        yield lease


def _volume_connected_selection_read_limits() -> VolumeReadLimits:
    """Return endpoint-local limits without changing shared volume readers."""

    return VolumeReadLimits(
        max_voxels=_VOLUME_CONNECTED_SELECTION_MAX_VOXELS,
        max_decoded_bytes=_VOLUME_CONNECTED_SELECTION_MAX_DECODED_BYTES,
        max_source_bytes=_VOLUME_CONNECTED_SELECTION_MAX_SOURCE_BYTES,
        max_container_members=REFERENCE_VOLUME_READ_LIMITS.max_container_members,
    )


def _volume_source_identity(db_image: models.DataInstance) -> VolumeSourceIdentity:
    metadata = db_image.metadata_json if isinstance(db_image.metadata_json, dict) else {}
    return build_volume_source_identity(
        image_id=db_image.id,
        storage_key=db_image.object_storage_key,
        size_bytes=db_image.size_bytes,
        metadata=metadata,
        created_at=db_image.created_at,
        updated_at=db_image.updated_at,
    )


def _volume_slice_cache_key(
    db_image: models.DataInstance,
    axis: str,
    index: int,
    identity: VolumeSourceIdentity | None = None,
) -> tuple[str, str, int, str]:
    source = identity or _volume_source_identity(db_image)
    return (str(db_image.id), axis, int(index), source.version)


def _get_cached_volume_slice_png(cache_key: tuple[str, str, int, str]) -> Optional[bytes]:
    with _volume_slice_png_cache_lock:
        cached = _volume_slice_png_cache.get(cache_key)
        if cached is not None:
            _volume_slice_png_cache.move_to_end(cache_key)
        return cached


def _set_cached_volume_slice_png(cache_key: tuple[str, str, int, str], png: bytes) -> None:
    with _volume_slice_png_cache_lock:
        _volume_slice_png_cache[cache_key] = png
        _volume_slice_png_cache.move_to_end(cache_key)
        while len(_volume_slice_png_cache) > _VOLUME_SLICE_CACHE_MAX_ITEMS:
            _volume_slice_png_cache.popitem(last=False)


def _summarize_rgba_volume_for_rendering(array: np.ndarray) -> Dict[str, Any]:
    """Find a bounded set of axial slices that represent active RGBA channels.

    The source may be a very large read-only memmap, so the scan never creates
    a full-volume boolean mask. Each temporary comparison is capped to a small
    pixel chunk and the result contains at most one slice per channel.
    """

    volume = np.asarray(array)
    if volume.ndim != 4 or volume.shape[-1] != 4:
        return {
            'summary_version': _VOLUME_RENDER_SUMMARY_VERSION,
            'kind': 'unsupported-layout',
            'active_channels': [],
            'channel_representatives': [],
            'representative_axial_indices': [],
        }
    if not (
        np.issubdtype(volume.dtype, np.bool_)
        or np.issubdtype(volume.dtype, np.integer)
        or np.issubdtype(volume.dtype, np.floating)
    ):
        return {
            'summary_version': _VOLUME_RENDER_SUMMARY_VERSION,
            'kind': 'unsupported-layout',
            'active_channels': [],
            'channel_representatives': [],
            'representative_axial_indices': [],
        }

    depth, height, width, _channels = (int(value) for value in volume.shape)
    representative_by_channel: dict[int, int] = {}
    max_chunk_pixels = _VOLUME_RENDER_SUMMARY_SCAN_MAX_PIXELS
    for axial_index in range(depth):
        plane = volume[axial_index]
        if width <= max_chunk_pixels:
            rows_per_chunk = max(1, max_chunk_pixels // max(1, width))
            chunks = (
                plane[row_start:row_start + rows_per_chunk, :, :]
                for row_start in range(0, height, rows_per_chunk)
            )
        else:
            chunks = (
                plane[row_index:row_index + 1, column_start:column_start + max_chunk_pixels, :]
                for row_index in range(height)
                for column_start in range(0, width, max_chunk_pixels)
            )
        for chunk in chunks:
            active_channels = np.any(np.asarray(chunk) != 0, axis=(0, 1))
            for channel_index in np.flatnonzero(active_channels):
                representative_by_channel.setdefault(int(channel_index), axial_index)
            if len(representative_by_channel) == 4:
                break
        if len(representative_by_channel) == 4:
            break

    channel_representatives = [
        {'channel': channel_index, 'axial_index': representative_by_channel[channel_index]}
        for channel_index in sorted(representative_by_channel)
    ]
    return {
        'summary_version': _VOLUME_RENDER_SUMMARY_VERSION,
        'kind': 'rgba-channel-presence',
        'active_channels': [entry['channel'] for entry in channel_representatives],
        'channel_representatives': channel_representatives,
        'representative_axial_indices': sorted({
            entry['axial_index'] for entry in channel_representatives
        }),
    }


async def _get_or_compute_volume_render_summary(
    cache_key: tuple[str, str, int],
    array: np.ndarray,
) -> Dict[str, Any]:
    """Coalesce and cache the optional sparse-volume renderer summary."""

    with _volume_render_summary_cache_lock:
        cached = _volume_render_summary_cache.get(cache_key)
        if cached is not None:
            _volume_render_summary_cache.move_to_end(cache_key)
            return cached
        summary_future = _volume_render_summary_futures.get(cache_key)
        owns_summary = summary_future is None
        if owns_summary:
            summary_future = Future()
            _volume_render_summary_futures[cache_key] = summary_future

    if not owns_summary:
        return await asyncio.shield(asyncio.wrap_future(summary_future))

    try:
        # Keep separate cache keys concurrent without allowing large memmap
        # scans to saturate every worker in this process. The limiter's async
        # facade is safe when requests originate from different event loops.
        async with _PROCESS_VOLUME_RENDER_SUMMARY_SCAN_LIMITER.slot():
            summary = await asyncio.to_thread(_summarize_rgba_volume_for_rendering, array)
        with _volume_render_summary_cache_lock:
            _volume_render_summary_cache[cache_key] = summary
            _volume_render_summary_cache.move_to_end(cache_key)
            while len(_volume_render_summary_cache) > _VOLUME_RENDER_SUMMARY_CACHE_MAX_ITEMS:
                _volume_render_summary_cache.popitem(last=False)
        summary_future.set_result(summary)
        return summary
    except BaseException as exc:
        summary_future.set_exception(exc)
        raise
    finally:
        with _volume_render_summary_cache_lock:
            if _volume_render_summary_futures.get(cache_key) is summary_future:
                _volume_render_summary_futures.pop(cache_key, None)


async def _get_or_render_volume_slice_png(
    cache_key: tuple[str, str, int, str],
    array: np.ndarray,
) -> bytes:
    """Coalesce one in-flight render per slice without serializing other keys."""

    with _volume_slice_png_cache_lock:
        cached = _volume_slice_png_cache.get(cache_key)
        if cached is not None:
            _volume_slice_png_cache.move_to_end(cache_key)
            return cached
        render_future = _volume_slice_render_futures.get(cache_key)
        owns_render = render_future is None
        if owns_render:
            render_future = Future()
            _volume_slice_render_futures[cache_key] = render_future

    if not owns_render:
        # A disconnected waiter must not cancel the shared render for the
        # owner or for other requests awaiting the same slice.
        return await asyncio.shield(asyncio.wrap_future(render_future))

    try:
        png = await asyncio.to_thread(_normalize_array_slice_to_png, array)
        _set_cached_volume_slice_png(cache_key, png)
        render_future.set_result(png)
        return png
    except BaseException as exc:
        render_future.set_exception(exc)
        raise
    finally:
        with _volume_slice_png_cache_lock:
            if _volume_slice_render_futures.get(cache_key) is render_future:
                _volume_slice_render_futures.pop(cache_key, None)


_SEGMENT_CHANNEL_PALETTE = np.asarray(
    [
        (239, 68, 68),
        (34, 197, 94),
        (59, 130, 246),
        (245, 158, 11),
    ],
    dtype=np.uint16,
)
_SEGMENT_CHANNEL_ALPHA = np.uint8(224)
_RGBA_SEGMENT_SLICE_MAX_CHUNK_PIXELS = 256 * 1024


def _iter_rgba_pixel_chunks(
    array: np.ndarray,
    max_chunk_pixels: int | None = None,
):
    """Yield spatially-addressed RGBA views capped to a pixel budget.

    Volume slices can be non-contiguous (for example, a coronal view into a
    memmap), so flattening the complete slice could silently allocate a copy.
    Row/column windows keep any copy made by a NumPy operation bounded to the
    configured chunk size.
    """

    arr = np.asarray(array)
    if arr.ndim != 3 or arr.shape[-1] != 4:
        raise ValueError("RGBA chunks require a channel-last four-channel array")

    pixel_limit = int(
        _RGBA_SEGMENT_SLICE_MAX_CHUNK_PIXELS
        if max_chunk_pixels is None
        else max_chunk_pixels
    )
    if pixel_limit <= 0:
        raise ValueError("RGBA chunk pixel limit must be positive")

    height, width, _channels = (int(value) for value in arr.shape)
    if height == 0 or width == 0:
        return

    if width <= pixel_limit:
        rows_per_chunk = max(1, pixel_limit // width)
        for row_start in range(0, height, rows_per_chunk):
            row_stop = min(height, row_start + rows_per_chunk)
            yield (
                slice(row_start, row_stop),
                slice(0, width),
                arr[row_start:row_stop, :, :],
            )
        return

    for row_index in range(height):
        for column_start in range(0, width, pixel_limit):
            column_stop = min(width, column_start + pixel_limit)
            yield (
                slice(row_index, row_index + 1),
                slice(column_start, column_stop),
                arr[row_index:row_index + 1, column_start:column_stop, :],
            )


def _is_binary_segment_channel_slice(array: np.ndarray) -> bool:
    """Identify four independent segment channels masquerading as literal RGBA."""

    arr = np.asarray(array)
    if arr.ndim != 3 or arr.shape[-1] != 4 or arr.size == 0:
        return False
    if np.issubdtype(arr.dtype, np.bool_):
        return True
    if not (
        np.issubdtype(arr.dtype, np.integer)
        or np.issubdtype(arr.dtype, np.floating)
    ):
        return False
    is_float = np.issubdtype(arr.dtype, np.floating)
    is_zero_or_one = True
    is_zero_or_255 = True
    is_one_hot_255 = True
    has_active_255 = False

    for _rows, _columns, chunk in _iter_rgba_pixel_chunks(arr):
        if is_float and not np.all(np.isfinite(chunk)):
            return False

        if is_zero_or_one:
            is_zero_or_one = bool(np.all((chunk == 0) | (chunk == 1)))

        if is_zero_or_255:
            chunk_is_zero_or_255 = bool(np.all((chunk == 0) | (chunk == 255)))
            if not chunk_is_zero_or_255:
                is_zero_or_255 = False
            else:
                active = chunk != 0
                has_active_255 = has_active_255 or bool(np.any(active))
                if is_one_hot_255:
                    is_one_hot_255 = bool(
                        np.all(np.count_nonzero(active, axis=-1) <= 1)
                    )

        if not is_zero_or_one and (not is_zero_or_255 or not is_one_hot_255):
            return False

    if is_zero_or_one:
        return True

    # A 0/255 RGBA image is normally literal color, so only treat it as a
    # channel mask when every pixel is one-hot (or empty). This also covers a
    # sparse slice on which only one semantic channel happens to be present,
    # while ordinary opaque RGBA such as [255, 0, 0, 255] stays literal.
    return is_zero_or_255 and is_one_hot_255 and has_active_255


def _render_binary_segment_channels(array: np.ndarray) -> np.ndarray:
    """Map four segment channels to visible RGBA, including channel index 3."""

    arr = np.asarray(array)
    if arr.ndim != 3 or arr.shape[-1] != 4:
        raise ValueError("Segment channels require a channel-last RGBA array")

    # The output necessarily spans the rendered image, but all masks, weights,
    # counts, and color sums remain bounded to one pixel chunk at a time.
    rendered = np.zeros(arr.shape, dtype=np.uint8)
    for rows, columns, chunk in _iter_rgba_pixel_chunks(arr):
        active = chunk != 0
        weights = active.astype(np.uint16)
        active_counts = np.sum(weights, axis=-1, dtype=np.uint16)
        color_sums = weights @ _SEGMENT_CHANNEL_PALETTE
        divisors = np.maximum(active_counts, 1)[..., np.newaxis]
        target = rendered[rows, columns, :]
        target[..., :3] = (
            (color_sums + (divisors // 2)) // divisors
        ).astype(np.uint8)
        target[..., 3] = np.where(
            active_counts > 0,
            _SEGMENT_CHANNEL_ALPHA,
            0,
        )
    return rendered


def _normalize_array_slice_to_png(array: np.ndarray) -> bytes:
    arr = np.asarray(array)
    if arr.ndim == 3 and arr.shape[-1] in (3, 4):
        if arr.shape[-1] == 4 and _is_binary_segment_channel_slice(arr):
            arr = _render_binary_segment_channels(arr)
        else:
            arr = _scale_color_array_to_uint8(arr)
        normalized = arr if arr.dtype == np.uint8 else arr.astype(np.uint8)
        img = Image.fromarray(normalized, 'RGBA' if arr.shape[-1] == 4 else 'RGB')
    else:
        arr = _scale_array_to_uint8(arr)
        img = Image.fromarray(arr.astype(np.uint8), 'L')
    output = io.BytesIO()
    img.save(output, format='PNG')
    return output.getvalue()


def _scale_color_component_to_uint8(array: np.ndarray) -> np.ndarray:
    """Convert color or alpha samples without borrowing the other channels' range."""

    arr = np.asarray(array)
    if arr.dtype == np.uint8:
        return arr
    if np.issubdtype(arr.dtype, np.bool_):
        return arr.astype(np.uint8) * 255
    if np.issubdtype(arr.dtype, np.integer):
        info = np.iinfo(arr.dtype)
        denominator = float(info.max) - float(info.min)
        scaled = (arr.astype(np.float64) - float(info.min)) * (255.0 / denominator)
        return np.rint(np.clip(scaled, 0, 255)).astype(np.uint8)
    if np.issubdtype(arr.dtype, np.floating):
        finite = np.isfinite(arr)
        finite_values = arr[finite]
        if finite_values.size and np.all((finite_values >= 0.0) & (finite_values <= 1.0)):
            scaled = np.where(finite, np.clip(arr, 0.0, 1.0) * 255.0, 0.0)
            return np.rint(scaled).astype(np.uint8)
    return _scale_array_to_uint8(arr)


def _scale_color_array_to_uint8(array: np.ndarray) -> np.ndarray:
    arr = np.asarray(array)
    if arr.ndim != 3 or arr.shape[-1] not in (3, 4):
        raise ValueError("Color volume slices must use channel-last RGB or RGBA layout")
    if arr.dtype == np.uint8:
        return arr
    scaled = np.empty(arr.shape, dtype=np.uint8)
    scaled[..., :3] = _scale_color_component_to_uint8(arr[..., :3])
    if arr.shape[-1] == 4:
        scaled[..., 3] = _scale_color_component_to_uint8(arr[..., 3])
    return scaled


def _scale_array_to_uint8(array: np.ndarray) -> np.ndarray:
    arr = np.asarray(array)
    if arr.dtype == np.uint8:
        return arr
    if np.issubdtype(arr.dtype, np.floating):
        finite_mask = np.isfinite(arr)
        finite = arr[finite_mask]
    else:
        finite_mask = None
        finite = arr.reshape(-1)
    if finite.size == 0:
        return np.zeros(arr.shape, dtype=np.uint8)
    lo = float(np.min(finite))
    hi = float(np.max(finite))
    if hi <= lo:
        fill = 0 if hi <= 0 else 255
        return np.full(arr.shape, fill, dtype=np.uint8)
    scaled = ((arr.astype(np.float32, copy=False) - lo) * 255.0) / (hi - lo)
    if finite_mask is not None:
        scaled = np.where(finite_mask, scaled, 0)
    return np.clip(scaled, 0, 255).astype(np.uint8)


def _axis_slice(array: np.ndarray, axis: str, index: int) -> np.ndarray:
    if axis == 'axial':
        return array[index, :, :, ...]
    if axis == 'coronal':
        return array[:, index, :, ...]
    if axis == 'sagittal':
        return array[:, :, index, ...]
    raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Axis must be axial, coronal, or sagittal')


def _volume_meta_from_shape(shape: tuple[int, ...], dtype: np.dtype, *, source_kind: str) -> Dict[str, Any]:
    if len(shape) == 3:
        spatial_shape = shape
        channel_count = 1
        color_mode = 'scalar'
    elif len(shape) == 4 and shape[-1] in {3, 4}:
        spatial_shape = shape[:3]
        channel_count = int(shape[-1])
        color_mode = 'rgb' if channel_count == 3 else 'rgba'
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Image is not a multi-image volume')
    depth, height, width = (int(value) for value in spatial_shape)
    return {
        'source_kind': source_kind,
        'interpretation': 'voxel_array' if source_kind in {'npy', 'npz', 'inspiro'} else 'stack_of_2d_images',
        'image_count': depth,
        'height': height,
        'width': width,
        'dimensions': {'axial': depth, 'coronal': height, 'sagittal': width},
        'pixel_dtype': np.dtype(dtype).name,
        'voxel_dtype': np.dtype(dtype).name,
        'bit_depth': int(np.dtype(dtype).itemsize * 8),
        'channel_count': channel_count,
        'color_mode': color_mode,
    }


def _connected_volume_comparison_value(
    value: Any,
    dtype: np.dtype,
    *,
    display_min: float | None,
    display_max: float | None,
) -> np.ndarray | None:
    channels = np.asarray(value).reshape(-1)
    if channels.size == 0:
        return None
    try:
        numeric = channels.astype(np.float64, copy=False)
    except (TypeError, ValueError):
        return None
    if not np.all(np.isfinite(numeric)):
        return None
    if display_min is not None and display_max is not None:
        scale = 255.0 / (display_max - display_min)
        return np.clip((numeric - display_min) * scale, 0.0, 255.0)
    resolved_dtype = np.dtype(dtype)
    if np.issubdtype(resolved_dtype, np.bool_):
        return numeric * 255.0
    if resolved_dtype == np.dtype(np.uint8):
        return numeric
    if np.issubdtype(resolved_dtype, np.integer):
        limits = np.iinfo(resolved_dtype)
        return (numeric - float(limits.min)) * (
            255.0 / (float(limits.max) - float(limits.min))
        )
    if np.issubdtype(resolved_dtype, np.floating):
        if np.all((numeric >= 0.0) & (numeric <= 1.0)):
            return numeric * 255.0
        return numeric
    return None


def _connected_volume_selection(
    volume: np.ndarray,
    *,
    seed: list[int],
    sensitivity: float,
    display_min: float | None,
    display_max: float | None,
    max_voxels: int,
    max_examined: int,
    max_runs: int,
) -> Dict[str, Any]:
    array = np.asarray(volume)
    meta = _volume_meta_from_shape(array.shape, array.dtype, source_kind="selection")
    width = int(meta["dimensions"]["sagittal"])
    height = int(meta["dimensions"]["coronal"])
    depth = int(meta["dimensions"]["axial"])
    x_seed, y_seed, z_seed = seed
    if (
        x_seed < 0
        or x_seed >= width
        or y_seed < 0
        or y_seed >= height
        or z_seed < 0
        or z_seed >= depth
    ):
        raise ValueError("Seed voxel is outside the volume")

    def comparison_value(x: int, y: int, z: int) -> np.ndarray | None:
        return _connected_volume_comparison_value(
            array[z, y, x, ...],
            array.dtype,
            display_min=display_min,
            display_max=display_max,
        )

    seed_value = comparison_value(x_seed, y_seed, z_seed)
    if seed_value is None:
        raise ValueError("Seed voxel does not contain a finite comparable value")
    plane_size = width * height
    to_index = lambda x, y, z: (z * plane_size) + (y * width) + x
    pending = deque([(x_seed, y_seed, z_seed)])
    visited: set[int] = set()
    selected_rows: dict[tuple[int, int], list[int]] = {}
    selected_count = 0
    truncation_reason = ""
    while pending:
        x, y, z = pending.popleft()
        flat_index = to_index(x, y, z)
        if flat_index in visited:
            continue
        if len(visited) >= max_examined:
            truncation_reason = "max-examined"
            break
        visited.add(flat_index)
        candidate = comparison_value(x, y, z)
        if candidate is None:
            continue
        channels = max(seed_value.size, candidate.size)
        seed_channels = np.resize(seed_value, channels)
        candidate_channels = np.resize(candidate, channels)
        if float(np.max(np.abs(candidate_channels - seed_channels))) > sensitivity:
            continue
        if selected_count >= max_voxels:
            truncation_reason = "max-voxels"
            break
        selected_rows.setdefault((z, y), []).append(x)
        selected_count += 1
        if x > 0:
            pending.append((x - 1, y, z))
        if x + 1 < width:
            pending.append((x + 1, y, z))
        if y > 0:
            pending.append((x, y - 1, z))
        if y + 1 < height:
            pending.append((x, y + 1, z))
        if z > 0:
            pending.append((x, y, z - 1))
        if z + 1 < depth:
            pending.append((x, y, z + 1))

    runs: list[list[int]] = []
    run_overflow = False
    run_detection_limit = max_runs + 1
    for (z, y), raw_x_values in sorted(selected_rows.items()):
        x_values = sorted(set(raw_x_values))
        if not x_values:
            continue
        start = x_values[0]
        previous = start
        for x in x_values[1:]:
            if x == previous + 1:
                previous = x
                continue
            runs.append([z, y, start, previous + 1])
            if len(runs) >= run_detection_limit:
                run_overflow = True
                break
            start = x
            previous = x
        if run_overflow:
            break
        runs.append([z, y, start, previous + 1])
        if len(runs) >= run_detection_limit:
            run_overflow = True
            break
    if run_overflow:
        runs = runs[:max_runs]
        truncation_reason = truncation_reason or "max-runs"

    represented_voxel_count = sum(run[3] - run[2] for run in runs)
    bounds = None
    if runs:
        bounds = {
            "min": [
                min(run[2] for run in runs),
                min(run[1] for run in runs),
                min(run[0] for run in runs),
            ],
            "max": [
                max(run[3] - 1 for run in runs),
                max(run[1] for run in runs),
                max(run[0] for run in runs),
            ],
        }
    return {
        "dimensions": [width, height, depth],
        "seed": [x_seed, y_seed, z_seed],
        "volume_runs": runs,
        "voxel_count": represented_voxel_count,
        "examined": len(visited),
        "bounds": bounds,
        "truncated": bool(truncation_reason),
        "truncation_reason": truncation_reason,
        "connectivity": 6,
    }


def _decode_and_select_connected_volume(
    *,
    kind: str,
    source: bytes | None,
    filename: str,
    volume: np.ndarray | None,
    seed: list[int],
    sensitivity: float,
    display_min: float | None,
    display_max: float | None,
    max_voxels: int,
    max_examined: int,
    max_runs: int,
) -> Dict[str, Any]:
    """Decode non-NPY sources and run flood-fill in one bounded worker job."""

    limits = _volume_connected_selection_read_limits()
    resolved_volume = volume
    materialized_in_worker = resolved_volume is None
    if resolved_volume is None:
        if source is None:
            raise ValueError("Volume source is unavailable")
        if len(source) > limits.max_source_bytes:
            raise ValueError(
                "Volume source exceeds the connected-selection "
                f"{limits.max_source_bytes}-byte source limit"
            )
        try:
            resolved_volume = (
                _load_tiff_volume(source, limits=limits)
                if kind == "tiff"
                else _load_numpy_volume(source, filename, limits=limits)
            )
        except (OSError, EOFError, zipfile.BadZipFile) as exc:
            raise ValueError(
                "Volume source is invalid or could not be decoded safely"
            ) from exc
    if materialized_in_worker:
        _enforce_connected_selection_decoded_volume_limits(
            resolved_volume,
            limits=limits,
        )
    return _connected_volume_selection(
        resolved_volume,
        seed=seed,
        sensitivity=sensitivity,
        display_min=display_min,
        display_max=display_max,
        max_voxels=max_voxels,
        max_examined=max_examined,
        max_runs=max_runs,
    )


def _enforce_connected_selection_decoded_volume_limits(
    volume: np.ndarray,
    *,
    limits: VolumeReadLimits | None = None,
) -> None:
    """Recheck actual decoded layout before flood-fill touches the array."""

    active_limits = limits or _volume_connected_selection_read_limits()
    array = np.asarray(volume)
    meta = _volume_meta_from_shape(
        array.shape,
        array.dtype,
        source_kind="selection",
    )
    dimensions = meta["dimensions"]
    spatial_voxels = (
        int(dimensions["axial"])
        * int(dimensions["coronal"])
        * int(dimensions["sagittal"])
    )
    decoded_bytes = int(array.size) * int(array.dtype.itemsize)
    if spatial_voxels > active_limits.max_voxels:
        raise ValueError(
            "Volume declares "
            f"{spatial_voxels} voxels, exceeding the connected-selection "
            f"{active_limits.max_voxels}-voxel limit"
        )
    if decoded_bytes > active_limits.max_decoded_bytes:
        raise ValueError(
            "Volume occupies "
            f"{decoded_bytes} decoded bytes, exceeding the connected-selection "
            f"{active_limits.max_decoded_bytes}-byte limit"
        )


def _load_numpy_volume(
    payload: bytes,
    filename: str,
    *,
    limits: VolumeReadLimits | None = None,
) -> np.ndarray:
    active_limits = limits or REFERENCE_VOLUME_READ_LIMITS
    if len(payload) > active_limits.max_source_bytes:
        raise ValueError(
            "NumPy volume source exceeds the configured/built-in "
            f"{active_limits.max_source_bytes}-byte materialized-file limit"
        )
    lower = filename.lower()
    if lower.endswith('.npy'):
        source = io.BytesIO(payload)
        expected = _inspect_npy_header(
            source,
            limits=active_limits,
            available_bytes=len(payload),
        )
        source.seek(0)
        loaded = np.lib.format.read_array(source, allow_pickle=False)
        array = np.asarray(loaded)
        if array.shape != expected.array_shape or array.dtype != expected.dtype:
            raise ValueError("NumPy volume changed between preflight and decode")
        return array
    source = io.BytesIO(payload)
    preflight_zip_archive(
        source,
        limits=active_limits,
        available_bytes=len(payload),
    )
    with zipfile.ZipFile(source) as archive:
        selected, expected = _inspect_npz_archive(archive, limits=active_limits)
        with archive.open(selected) as member:
            loaded = np.lib.format.read_array(member, allow_pickle=False)
    array = np.asarray(loaded)
    if array.shape != expected.array_shape or array.dtype != expected.dtype:
        raise ValueError("NumPy volume changed between preflight and decode")
    return array


def _load_tiff_volume(
    payload: bytes,
    *,
    limits: VolumeReadLimits | None = None,
) -> np.ndarray:
    active_limits = limits or REFERENCE_VOLUME_READ_LIMITS
    if len(payload) > active_limits.max_source_bytes:
        raise ValueError(
            "TIFF source exceeds the configured/built-in "
            f"{active_limits.max_source_bytes}-byte materialized-file limit"
        )
    with Image.open(io.BytesIO(payload)) as image:
        frame_count = int(getattr(image, 'n_frames', 1) or 0)
        if frame_count < 1:
            raise ValueError('TIFF has no frames')
        if frame_count > active_limits.max_container_members:
            raise ValueError(
                f"TIFF contains {frame_count} frames, exceeding the configured/built-in "
                f"{active_limits.max_container_members}-member limit"
            )
        image.seek(0)
        width, height = image.size
        expected_mode = image.mode
        expected_bands = image.getbands()
        band_count, _color_mode = _image_color_layout(image)
        voxel_count = frame_count * int(height) * int(width)
        if voxel_count > active_limits.max_voxels:
            raise ValueError(
                f"TIFF declares {voxel_count} voxels, exceeding the configured/built-in "
                f"{active_limits.max_voxels}-voxel limit"
            )
        # Match the reference TIFF reader's conservative float64 working-set
        # accounting, extended by channel count for color frames.
        decoded_bytes = voxel_count * band_count * np.dtype(np.float64).itemsize
        if decoded_bytes > active_limits.max_decoded_bytes:
            raise ValueError(
                f"TIFF declares {decoded_bytes} decoded bytes, exceeding the "
                f"configured/built-in {active_limits.max_decoded_bytes}-byte limit"
            )

        # ``n_frames`` and frame zero are not sufficient: TIFF permits later
        # IFDs with different dimensions or pixel modes. Walk metadata for all
        # frames before allocating or decoding any one of them so a tiny first
        # frame cannot hide an oversized later frame.
        for frame_index in range(1, frame_count):
            image.seek(frame_index)
            if image.size != (width, height):
                raise ValueError("All TIFF frames must share the same dimensions")
            if image.mode != expected_mode or image.getbands() != expected_bands:
                raise ValueError("All TIFF frames must share the same pixel mode")

        image.seek(0)
        first_frame = np.asarray(image.copy())
        volume = np.empty((frame_count, *first_frame.shape), dtype=first_frame.dtype)
        volume[0] = first_frame
        for frame_index in range(1, frame_count):
            image.seek(frame_index)
            frame = np.asarray(image.copy())
            if frame.shape != first_frame.shape or frame.dtype != first_frame.dtype:
                raise ValueError("All TIFF frames must share the same shape and dtype")
            volume[frame_index] = frame
    return volume


def _volume_source_kind(filename: str) -> Optional[str]:
    lower = filename.lower()
    if lower.endswith('.npy'):
        return 'npy'
    if lower.endswith('.npz'):
        return 'npz'
    if lower.endswith('.inspiro'):
        return 'inspiro'
    if lower.endswith(('.tif', '.tiff')):
        return 'tiff'
    return None


def _builtin_pt3_fixture_path(db_image: models.DataInstance) -> Path | None:
    """Resolve trusted built-in fixture provenance from an image record."""

    metadata = db_image.metadata_json if isinstance(db_image.metadata_json, dict) else {}
    if metadata.get("source") != "vista-test-data" or metadata.get("project_type") != "PT3":
        return None
    return resolve_pt3_test_fixture_file(
        fixture_id=metadata.get("builtin_fixture_id"),
        fixture_filename=metadata.get("builtin_fixture_filename") or db_image.filename,
        image_filename=db_image.filename,
        object_storage_key=db_image.object_storage_key,
        project_id=db_image.project_id,
    )


def _enforce_materialized_volume_source_limit(
    source_bytes: int,
    *,
    max_bytes: int,
) -> None:
    if source_bytes < 0 or source_bytes > max_bytes:
        raise ValueError(
            "Volume source exceeds the connected-selection "
            f"{max_bytes}-byte source limit"
        )


async def _read_authorized_image_bytes(
    db_image: models.DataInstance,
    *,
    max_bytes: int | None = None,
) -> bytes:
    if max_bytes is not None:
        metadata = (
            db_image.metadata_json
            if isinstance(db_image.metadata_json, dict)
            else {}
        )
        encoded = metadata.get("analysis_inline_image_base64")
        if isinstance(encoded, str) and encoded:
            # Base64 expands source bytes by roughly four thirds. Refuse an
            # obviously oversized inline object before allocating its decode.
            maximum_encoded_bytes = ((max_bytes + 2) // 3) * 4
            if len(encoded) > maximum_encoded_bytes:
                _enforce_materialized_volume_source_limit(
                    max_bytes + 1,
                    max_bytes=max_bytes,
                )
    inline_data = _inline_image_bytes(db_image)
    if inline_data is not None:
        if max_bytes is not None:
            _enforce_materialized_volume_source_limit(
                len(inline_data),
                max_bytes=max_bytes,
            )
        return inline_data
    fixture_path = _builtin_pt3_fixture_path(db_image)
    if fixture_path is not None:
        if max_bytes is not None:
            fixture_stat = await asyncio.to_thread(fixture_path.stat)
            _enforce_materialized_volume_source_limit(
                int(fixture_stat.st_size),
                max_bytes=max_bytes,
            )
        fixture_bytes = await asyncio.to_thread(fixture_path.read_bytes)
        if max_bytes is not None:
            _enforce_materialized_volume_source_limit(
                len(fixture_bytes),
                max_bytes=max_bytes,
            )
        return fixture_bytes
    internal_url = get_presigned_download_url(bucket_name=settings.S3_BUCKET, object_name=db_image.object_storage_key)
    if not internal_url:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail='Could not generate download URL')
    try:
        async with httpx.AsyncClient() as client:
            if max_bytes is not None:
                async with client.stream('GET', internal_url) as response:
                    response.raise_for_status()
                    content_length = response.headers.get("content-length")
                    if content_length is not None:
                        try:
                            declared_length = int(content_length)
                        except (TypeError, ValueError):
                            declared_length = None
                        if declared_length is not None:
                            _enforce_materialized_volume_source_limit(
                                declared_length,
                                max_bytes=max_bytes,
                            )
                    buffered = io.BytesIO()
                    source_bytes = 0
                    async for chunk in response.aiter_bytes(
                        chunk_size=8 * 1024 * 1024
                    ):
                        if not chunk:
                            continue
                        source_bytes += len(chunk)
                        _enforce_materialized_volume_source_limit(
                            source_bytes,
                            max_bytes=max_bytes,
                        )
                        buffered.write(chunk)
                    return buffered.getvalue()
            response = await client.get(internal_url)
            response.raise_for_status()
            return await response.aread()
    except httpx.HTTPError as exc:
        raise _storage_http_exception(exc) from exc


async def _iter_authorized_npy_bytes(db_image: models.DataInstance):
    """Stream one authorized NumPy object without buffering it in RAM."""

    inline_data = _inline_image_bytes(db_image)
    if inline_data is not None:
        yield inline_data
        return
    fixture_path = _builtin_pt3_fixture_path(db_image)
    if fixture_path is not None:
        with fixture_path.open('rb') as fixture_file:
            while chunk := await asyncio.to_thread(fixture_file.read, 8 * 1024 * 1024):
                yield chunk
        return
    internal_url = get_presigned_download_url(
        bucket_name=settings.S3_BUCKET,
        object_name=db_image.object_storage_key,
    )
    if not internal_url:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail='Could not generate download URL',
        )
    try:
        async with httpx.AsyncClient() as client:
            async with client.stream('GET', internal_url) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes(chunk_size=8 * 1024 * 1024):
                    if chunk:
                        yield chunk
    except httpx.HTTPError as exc:
        raise VolumeSourceReadError(timed_out=isinstance(exc, httpx.TimeoutException)) from exc


async def _read_authorized_npy_header(db_image: models.DataInstance) -> tuple[tuple[int, ...], str]:
    """Read at most the bounded NumPy header prefix from object storage."""

    max_prefix_bytes = MAX_NPY_HEADER_BYTES + 12
    inline_data = _inline_image_bytes(db_image)
    if inline_data is not None:
        return read_npy_header(io.BytesIO(inline_data[:max_prefix_bytes]))

    fixture_path = _builtin_pt3_fixture_path(db_image)
    if fixture_path is not None:
        return await asyncio.to_thread(_read_npy_header_from_path, fixture_path)

    internal_url = get_presigned_download_url(
        bucket_name=settings.S3_BUCKET,
        object_name=db_image.object_storage_key,
    )
    if not internal_url:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail='Could not generate download URL',
        )
    prefix = bytearray()
    try:
        async with httpx.AsyncClient() as client:
            async with client.stream(
                'GET',
                internal_url,
                headers={'Range': f'bytes=0-{max_prefix_bytes - 1}'},
            ) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes():
                    remaining = max_prefix_bytes - len(prefix)
                    if remaining <= 0:
                        break
                    prefix.extend(chunk[:remaining])
                    if len(prefix) >= max_prefix_bytes:
                        break
    except httpx.HTTPError as exc:
        raise _storage_http_exception(exc) from exc
    return read_npy_header(io.BytesIO(prefix))


def _validated_npy_shape_dtype(
    shape: tuple[int, ...], dtype: np.dtype
) -> tuple[tuple[int, int, int], np.dtype, int, str]:
    if len(shape) == 3:
        spatial_shape = shape
        channel_count = 1
        color_mode = 'scalar'
    elif len(shape) == 4 and shape[-1] in {3, 4}:
        spatial_shape = shape[:3]
        channel_count = int(shape[-1])
        color_mode = 'rgb' if channel_count == 3 else 'rgba'
    else:
        raise ValueError('NumPy volume must be scalar [z, y, x], RGB [z, y, x, 3], or RGBA [z, y, x, 4]')
    if any(
        isinstance(value, bool) or not isinstance(value, int) or value <= 0
        for value in spatial_shape
    ):
        raise ValueError('NumPy volume dimensions must be positive integers')
    safe_dtype = np.dtype(dtype)
    if (
        safe_dtype.hasobject
        or safe_dtype.fields is not None
        or safe_dtype.subdtype is not None
        or safe_dtype.kind not in {'b', 'u', 'i', 'f'}
    ):
        raise ValueError('NumPy volume must use a scalar real numeric or boolean dtype')
    safe_shape = tuple(int(value) for value in spatial_shape)
    voxel_count = math.prod(safe_shape)
    decoded_bytes = voxel_count * channel_count * int(safe_dtype.itemsize)
    if voxel_count > REFERENCE_VOLUME_READ_LIMITS.max_voxels:
        raise ValueError(
            f'NumPy volume exceeds the {REFERENCE_VOLUME_READ_LIMITS.max_voxels}-voxel limit'
        )
    if decoded_bytes > REFERENCE_VOLUME_READ_LIMITS.max_decoded_bytes:
        raise ValueError(
            f'NumPy volume exceeds the {REFERENCE_VOLUME_READ_LIMITS.max_decoded_bytes}-byte decoded limit'
        )
    return safe_shape, safe_dtype, channel_count, color_mode


def _persisted_npy_volume_meta(metadata: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    shape = metadata.get('volume_shape')
    if not isinstance(shape, dict):
        return None
    dimensions = []
    for axis in ('axial', 'coronal', 'sagittal'):
        value = shape.get(axis)
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            return None
        dimensions.append(value)
    dtype_text = metadata.get('voxel_dtype') or metadata.get('pixel_dtype')
    if not dtype_text:
        return None
    persisted_channel_count = metadata.get('channel_count')
    persisted_color_mode = metadata.get('color_mode')
    if persisted_channel_count is None and persisted_color_mode is None:
        # Legacy records cannot prove whether a 3D spatial shape came from a
        # scalar array or a channel-last RGB(A) array. Fall back to the bounded
        # NumPy header probe instead of silently treating an RGBA overlay as
        # scalar data.
        return None
    valid_layouts = {(1, 'scalar'), (3, 'rgb'), (4, 'rgba')}
    if (persisted_channel_count, persisted_color_mode) not in valid_layouts:
        return None
    try:
        dtype = np.dtype(dtype_text)
        array_shape = tuple(dimensions) + (
            (int(persisted_channel_count),) if persisted_channel_count != 1 else ()
        )
        safe_shape, dtype, channel_count, color_mode = _validated_npy_shape_dtype(array_shape, dtype)
    except (TypeError, ValueError):
        return None
    meta = _volume_meta_from_shape(
        safe_shape + ((channel_count,) if channel_count != 1 else ()),
        dtype,
        source_kind='npy',
    )
    if meta['color_mode'] != color_mode:
        return None
    return meta


def _read_npy_header_from_path(path: Path) -> tuple[tuple[int, ...], str]:
    with path.open('rb') as file_obj:
        return read_npy_header(file_obj)


async def _get_authorized_image(db: AsyncSession, image_id: uuid.UUID, current_user: schemas.User, include_deleted: bool = False) -> models.DataInstance:
    db_image = await crud.get_data_instance(db=db, image_id=image_id)
    if db_image is None or (db_image.deleted_at and not include_deleted):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail='Image not found')
    if not is_user_in_group(current_user.email, db_image.project.meta_group_id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=f"User '{current_user.email}' does not have access to image '{image_id}'")
    return db_image


@router.get("/images/{image_id}/volume-metadata")
async def get_image_volume_metadata(
    image_id: uuid.UUID,
    include_deleted: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    db_image = await _get_authorized_image(db, image_id, current_user, include_deleted)
    kind = _volume_source_kind(db_image.filename or '')
    if not kind:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Unsupported multi-image file type')
    metadata = db_image.metadata_json if isinstance(db_image.metadata_json, dict) else {}
    try:
        if kind == 'npy':
            meta = _persisted_npy_volume_meta(metadata)
            if meta is None:
                identity = _volume_source_identity(db_image)
                materialized_path = get_materialized_npy_path(identity)
                if materialized_path is not None:
                    try:
                        shape, dtype_text = await asyncio.to_thread(
                            _read_npy_header_from_path,
                            materialized_path,
                        )
                    except FileNotFoundError:
                        shape, dtype_text = await _read_authorized_npy_header(db_image)
                    except ValueError:
                        try:
                            await asyncio.to_thread(materialized_path.unlink, missing_ok=True)
                        except OSError as exc:
                            raise VolumeCacheError("Could not discard invalid cached volume metadata") from exc
                        shape, dtype_text = await _read_authorized_npy_header(db_image)
                    except OSError as exc:
                        raise VolumeCacheError("Could not read cached volume metadata") from exc
                else:
                    shape, dtype_text = await _read_authorized_npy_header(db_image)
                safe_shape, safe_dtype, channel_count, _color_mode = _validated_npy_shape_dtype(
                    shape, np.dtype(dtype_text)
                )
                array_shape = safe_shape + ((channel_count,) if channel_count != 1 else ())
                meta = _volume_meta_from_shape(array_shape, safe_dtype, source_kind=kind)
        else:
            payload = await _read_authorized_image_bytes(db_image)
            volume = _load_tiff_volume(payload) if kind == 'tiff' else _load_numpy_volume(payload, db_image.filename or '')
            meta = _volume_meta_from_shape(volume.shape, volume.dtype, source_kind=kind)
    except HTTPException:
        raise
    except VolumeSourceReadError as exc:
        raise _storage_http_exception(exc) from exc
    except InvalidVolumeSourceError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f'Unable to read volume: {exc}',
        ) from exc
    except VolumeCacheError as exc:
        raise _volume_cache_http_exception() from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f'Unable to read volume: {exc}') from exc
    meta.update({
        'filename': db_image.filename,
        'content_type': db_image.content_type,
        'metadata_bit_depth': metadata.get('bit_depth') or metadata.get('bits_per_sample'),
    })
    return meta


@router.get("/images/{image_id}/volume-render-summary")
async def get_image_volume_render_summary(
    image_id: uuid.UUID,
    include_deleted: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """Return optional, bounded slice hints for sparse NPY RGBA rendering."""

    db_image = await _get_authorized_image(db, image_id, current_user, include_deleted)
    kind = _volume_source_kind(db_image.filename or '')
    if kind != 'npy':
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail='Render summaries are available only for NumPy .npy volumes',
        )
    identity = _volume_source_identity(db_image)
    cache_key = (str(db_image.id), identity.version, _VOLUME_RENDER_SUMMARY_VERSION)
    try:
        handle = await get_npy_volume_handle(
            identity,
            lambda: _iter_authorized_npy_bytes(db_image),
        )
        summary = await _get_or_compute_volume_render_summary(cache_key, handle.array)
    except VolumeSourceReadError as exc:
        raise _storage_http_exception(exc) from exc
    except InvalidVolumeSourceError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f'Unable to summarize volume: {exc}',
        ) from exc
    except VolumeCacheError as exc:
        raise _volume_cache_http_exception() from exc
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f'Unable to summarize volume: {exc}',
        ) from exc
    return {
        **summary,
        'source_kind': kind,
        'dimensions': {
            'axial': int(handle.shape[0]),
            'coronal': int(handle.shape[1]),
            'sagittal': int(handle.shape[2]),
        },
    }


@router.get("/images/{image_id}/volume-slice", response_class=StreamingResponse)
async def get_image_volume_slice(
    image_id: uuid.UUID,
    axis: str = Query('axial'),
    index: int = Query(0, ge=0),
    include_deleted: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    db_image = await _get_authorized_image(db, image_id, current_user, include_deleted)
    kind = _volume_source_kind(db_image.filename or '')
    if not kind:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Unsupported multi-image file type')
    safe_axis = axis if axis in {'axial', 'coronal', 'sagittal'} else 'axial'
    identity = _volume_source_identity(db_image)
    cache_key = _volume_slice_cache_key(db_image, safe_axis, index, identity)
    png = _get_cached_volume_slice_png(cache_key)
    try:
        if png is None:
            if kind == 'npy':
                handle = await get_npy_volume_handle(
                    identity,
                    lambda: _iter_authorized_npy_bytes(db_image),
                )
                volume = handle.array
            else:
                payload = await _read_authorized_image_bytes(db_image)
                volume = _load_tiff_volume(payload) if kind == 'tiff' else _load_numpy_volume(payload, db_image.filename or '')
            meta = _volume_meta_from_shape(volume.shape, volume.dtype, source_kind=kind)
            dimensions = meta['dimensions']
            if index >= int(dimensions[safe_axis]):
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail='Slice index is outside the selected axis')
            png = await _get_or_render_volume_slice_png(
                cache_key,
                _axis_slice(volume, safe_axis, index),
            )
    except HTTPException:
        raise
    except VolumeSourceReadError as exc:
        raise _storage_http_exception(exc) from exc
    except InvalidVolumeSourceError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f'Unable to render volume slice: {exc}',
        ) from exc
    except VolumeCacheError as exc:
        raise _volume_cache_http_exception() from exc
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f'Unable to render volume slice: {exc}') from exc
    return StreamingResponse(
        content=io.BytesIO(png),
        media_type='image/png',
        headers={
            'Content-Disposition': get_content_disposition_header(f'{db_image.filename or "volume"}-{safe_axis}-{index}.png', 'inline'),
            'Cache-Control': 'private, max-age=3600',
        },
    )


@router.post(
    "/images/{image_id}/volume-connected-selection",
    response_model=schemas.VolumeConnectedSelectionResponse,
)
async def select_connected_image_volume(
    image_id: uuid.UUID,
    payload: schemas.VolumeConnectedSelectionRequest,
    include_deleted: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """Select a guarded 6-connected intensity region from an authorized volume."""

    db_image = await _get_authorized_image(db, image_id, current_user, include_deleted)
    kind = _volume_source_kind(db_image.filename or "")
    if not kind:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported multi-image file type",
        )
    try:
        limits = _volume_connected_selection_read_limits()
        if kind != "npy" and db_image.size_bytes is not None:
            try:
                materialized_source_bytes = int(db_image.size_bytes)
            except (TypeError, ValueError, OverflowError) as exc:
                raise ValueError("Volume source size metadata is invalid") from exc
            _enforce_materialized_volume_source_limit(
                materialized_source_bytes,
                max_bytes=limits.max_source_bytes,
            )
        async with _volume_connected_selection_slot() as selection_lease:
            async with _volume_connected_selection_materialization_slot(
                kind
            ) as decode_lease:
                identity = _volume_source_identity(db_image)
                source = None
                volume = None
                if kind == "npy":
                    handle = await get_npy_volume_handle(
                        identity,
                        lambda: _iter_authorized_npy_bytes(db_image),
                    )
                    volume = handle.array
                else:
                    source = await _read_authorized_image_bytes(
                        db_image,
                        max_bytes=limits.max_source_bytes,
                    )
                    _enforce_materialized_volume_source_limit(
                        len(source),
                        max_bytes=limits.max_source_bytes,
                    )
                worker_future = _VOLUME_CONNECTED_SELECTION_EXECUTOR.submit(
                    _decode_and_select_connected_volume,
                    kind=kind,
                    source=source,
                    filename=db_image.filename or "",
                    volume=volume,
                    seed=payload.seed,
                    sensitivity=payload.sensitivity,
                    display_min=payload.display_min,
                    display_max=payload.display_max,
                    max_voxels=payload.max_voxels,
                    max_examined=payload.max_examined,
                    max_runs=payload.max_runs,
                )
                selection_lease.release_when_done(worker_future)
                if decode_lease is not None:
                    decode_lease.release_when_done(worker_future)
                return await asyncio.wrap_future(worker_future)
    except HTTPException:
        raise
    except VolumeSourceReadError as exc:
        raise _storage_http_exception(exc) from exc
    except InvalidVolumeSourceError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unable to select volume: {exc}",
        ) from exc
    except VolumeCacheError as exc:
        raise _volume_cache_http_exception() from exc
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except Exception as exc:
        logger.exception(
            "Unexpected volume connected-selection failure for image %s (%s)",
            image_id,
            kind,
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Unable to select volume",
        ) from exc


@router.get("/images/{image_id}/content", response_class=StreamingResponse)
async def get_image_content(
    image_id: uuid.UUID,
    include_deleted: bool = Query(False),
    convert: bool = Query(True, description="Convert non-web formats (TIFF, BMP) to PNG/JPEG"),
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """
    Streams the content of an image from object storage.
    This endpoint acts as a proxy, ensuring proper access control.
    It returns the image data with appropriate headers for inline display.

    Non-web-friendly formats (TIFF, BMP, etc.) are automatically converted to
    PNG or JPEG to ensure browser compatibility while preserving original dimensions.
    Set convert=false to download the original file without conversion.
    """
    db_image = await crud.get_data_instance(db=db, image_id=image_id)
    if db_image is None or (db_image.deleted_at and not include_deleted):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image not found")

    # Check access permissions
    is_member = is_user_in_group(current_user.email, db_image.project.meta_group_id)
    if not is_member:
         raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"User '{current_user.email}' does not have access to image '{image_id}'",
        )

    inline_data = _inline_image_bytes(db_image)
    if inline_data is not None:
        return StreamingResponse(
            content=io.BytesIO(inline_data),
            media_type=db_image.content_type or "image/png",
            headers={
                "Content-Disposition": get_content_disposition_header(db_image.filename, "inline")
            }
        )

    fixture_path = _builtin_pt3_fixture_path(db_image)
    if fixture_path is not None:
        return StreamingResponse(
            content=fixture_path.open("rb"),
            media_type=db_image.content_type or "application/octet-stream",
            headers={"Content-Disposition": get_content_disposition_header(db_image.filename, "inline")},
        )

    # Get the presigned URL for internal use
    internal_url = get_presigned_download_url(
        bucket_name=settings.S3_BUCKET,
        object_name=db_image.object_storage_key
    )
    if not internal_url:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not generate download URL")

    # Use httpx to fetch the image from s3
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(internal_url)
            response.raise_for_status()

            content_type = db_image.content_type or "application/octet-stream"

            # Check if conversion is needed and requested
            if convert and content_type not in WEB_FRIENDLY_CONTENT_TYPES:
                # Need to read full content for conversion
                image_data = await response.aread()
                converted_data, converted_type = convert_to_web_format(image_data, content_type)
                return StreamingResponse(
                    content=io.BytesIO(converted_data),
                    media_type=converted_type,
                    headers={
                        "Content-Disposition": get_content_disposition_header(db_image.filename, "inline")
                    }
                )

            # Return original content for web-friendly formats or when convert=false
            return StreamingResponse(
                content=response.iter_bytes(),
                media_type=content_type,
                headers={
                    "Content-Disposition": get_content_disposition_header(db_image.filename, "inline")
                }
            )
        except httpx.HTTPError as exc:
            raise _storage_http_exception(exc) from exc
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Unexpected error while retrieving image data",
            ) from exc

@router.get("/images/{image_id}/thumbnail", response_class=StreamingResponse)
async def get_image_thumbnail(
    image_id: uuid.UUID,
    width: int = Query(200, description="Thumbnail width in pixels"),
    height: int = Query(200, description="Thumbnail height in pixels"),
    include_deleted: bool = Query(False),
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """
    Generates and returns a thumbnail for a given image.
    It resizes the image to specified dimensions while maintaining aspect ratio.
    The thumbnail is cached for subsequent requests.
    """
    if width <= 0 or height <= 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Width and height must be positive integers")

    # Check cache first
    cache = get_cache()
    cache_key = f"thumbnail:{image_id}:w:{width}:h:{height}"
    cached_thumbnail = cache.get(cache_key)

    if cached_thumbnail:
        thumbnail_data, content_type, filename = cached_thumbnail
        return StreamingResponse(
            content=io.BytesIO(thumbnail_data),
            media_type=content_type,
            headers={
                "Content-Disposition": get_content_disposition_header(filename, "inline")
            }
        )

    db_image = await crud.get_data_instance(db=db, image_id=image_id)
    if db_image is None or (db_image.deleted_at and not include_deleted):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image not found")

    # Check access permissions
    is_member = is_user_in_group(current_user.email, db_image.project.meta_group_id)
    if not is_member:
         raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"User '{current_user.email}' does not have access to image '{image_id}'",
        )

    inline_data = _inline_image_bytes(db_image)
    if inline_data is not None:
        try:
            img = Image.open(io.BytesIO(inline_data))
            img.thumbnail((width, height))
            img, img_format = _prepare_thumbnail_image(img)
            output_buffer = io.BytesIO()
            img.save(output_buffer, format=img_format)
            output_buffer.seek(0)
            thumbnail_filename = f"thumbnail_{db_image.filename}" if db_image.filename else "thumbnail"
            content_type = 'image/png' if img_format == 'PNG' else 'image/jpeg'
            cache.set(cache_key, (output_buffer.getvalue(), content_type, thumbnail_filename), expire=24*3600)
            output_buffer.seek(0)
            return StreamingResponse(
                content=output_buffer,
                media_type=content_type,
                headers={
                    "Content-Disposition": get_content_disposition_header(thumbnail_filename, "inline")
                }
            )
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"Error generating thumbnail: {str(e)}"
            )

    # Get the presigned URL for internal use
    internal_url = get_presigned_download_url(
        bucket_name=settings.S3_BUCKET,
        object_name=db_image.object_storage_key
    )
    if not internal_url:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Could not generate download URL")

    # Use httpx to fetch the image from Minio
    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(internal_url)
            response.raise_for_status()

            # Get the image data
            image_data = await response.aread()

            # Use PIL to resize the image
            try:
                img = Image.open(io.BytesIO(image_data))

                # Resize the image while maintaining aspect ratio
                img.thumbnail((width, height))

                # Convert to a web-friendly thumbnail format.
                # Handle TIFF, CMYK, 16-bit scalar, palette transparency, and
                # other non-web modes before saving.
                img, img_format = _prepare_thumbnail_image(img)

                # Save the resized image to a bytes buffer
                output_buffer = io.BytesIO()
                img.save(output_buffer, format=img_format)
                output_buffer.seek(0)

                # Determine the content type based on the image format
                content_type_map = {
                    'JPEG': 'image/jpeg',
                    'PNG': 'image/png',
                    'GIF': 'image/gif',
                    'WEBP': 'image/webp'
                }
                content_type = content_type_map.get(img_format, 'image/jpeg')

                # Cache the thumbnail (24 hours)
                thumbnail_filename = f"thumbnail_{db_image.filename}" if db_image.filename else "thumbnail"
                thumbnail_data = output_buffer.getvalue()
                cache.set(cache_key, (thumbnail_data, content_type, thumbnail_filename), expire=24*3600)

                # Return the thumbnail
                output_buffer.seek(0)
                return StreamingResponse(
                    content=output_buffer,
                    media_type=content_type,
                    headers={
                        "Content-Disposition": get_content_disposition_header(thumbnail_filename, "inline")
                    }
                )
            except Exception as e:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail=f"Error generating thumbnail: {str(e)}"
                )
        except httpx.HTTPError as exc:
            raise _storage_http_exception(exc) from exc

class MetadataUpdate(BaseModel):
    key: str
    value: Any

class ImageDeleteRequest(BaseModel):
    reason: str
    force: Optional[bool] = False


async def _delete_image_storage_object(
    bucket_name: str,
    object_storage_key: str,
) -> bool:
    """Run the legacy blocking boto3 deletion without blocking the event loop."""

    async with _storage_operation_slot():
        return await asyncio.to_thread(
            delete_file_from_s3,
            bucket_name,
            object_storage_key,
        )


def _clear_image_caches_best_effort(
    *,
    project_id: uuid.UUID,
    image_id: uuid.UUID,
) -> None:
    """Cache failures must not turn a committed mutation into an HTTP failure."""

    try:
        cache = get_cache()
    except Exception:
        logger.warning(
            "Image cache lookup failed after mutation attempt",
            extra={"project_id": str(project_id), "image_id": str(image_id)},
            exc_info=True,
        )
        return

    for pattern in (
        f"project_images:{project_id}",
        f"image:{image_id}:",
        f"thumbnail:{image_id}",
    ):
        try:
            cache.clear_pattern(pattern)
        except Exception:
            logger.warning(
                "Image cache invalidation failed after mutation attempt",
                extra={
                    "project_id": str(project_id),
                    "image_id": str(image_id),
                    "cache_pattern": pattern,
                },
                exc_info=True,
            )


async def _persist_image_metadata(
    *,
    db: AsyncSession,
    db_image: models.DataInstance,
    image_id: uuid.UUID,
    project_id: uuid.UUID,
    metadata: Dict[str, Any],
) -> schemas.DataInstance:
    """Commit metadata with a fully materialized pre-commit response.

    No ORM state or database I/O is touched after the shielded commit. Cache
    invalidation is best-effort and therefore cannot turn a durable mutation
    into an apparent request failure.
    """

    try:
        db_image.metadata_json = metadata
        await db.flush()
        await db.refresh(db_image)
        response_image = to_data_instance_schema(db_image)
        await _commit_database_transaction(db)
    except asyncio.CancelledError as exc:
        if getattr(exc, "vista_commit_succeeded", False):
            _clear_image_caches_best_effort(
                project_id=project_id,
                image_id=image_id,
            )
        else:
            await db.rollback()
        raise
    except Exception:
        await db.rollback()
        raise

    _clear_image_caches_best_effort(
        project_id=project_id,
        image_id=image_id,
    )
    return response_image


@router.delete("/projects/{project_id}/images/{image_id}", response_model=schemas.DataInstance)
async def delete_image(
    project_id: uuid.UUID,
    image_id: uuid.UUID,
    body: ImageDeleteRequest = Body(...),
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    normalized_reason = body.reason.strip()
    if len(normalized_reason) < settings.IMAGE_DELETE_REASON_MIN_CHARS:
        raise HTTPException(status_code=400, detail=f"Reason must be at least {settings.IMAGE_DELETE_REASON_MIN_CHARS} characters")
    db_image = await get_image_or_403_writable(image_id, db, current_user)
    if db_image.project_id != project_id:
        raise HTTPException(status_code=404, detail="Image not found")

    try:
        outcome = await image_deletion_service.delete_authorized_image(
            db=db,
            project_id=project_id,
            image_id=image_id,
            actor_user_id=current_user.id,
            actor_email=current_user.email,
            reason=normalized_reason,
            retention_days=settings.IMAGE_DELETE_RETENTION_DAYS,
            force=bool(body.force),
            storage_bucket=settings.S3_BUCKET,
            delete_storage=_delete_image_storage_object,
        )
    except image_deletion_service.ImageDeletionNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Image not found",
        ) from exc
    except image_deletion_service.ImageStorageDeletionFailed as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=(
                "Unable to permanently delete image from object storage; "
                "the storage outcome requires reconciliation before restore"
            ),
        ) from exc
    finally:
        _clear_image_caches_best_effort(
            project_id=project_id,
            image_id=image_id,
        )
    return outcome.image

@router.post("/projects/{project_id}/images/{image_id}/restore", response_model=schemas.DataInstance)
async def restore_deleted_image(
    project_id: uuid.UUID,
    image_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    db_image = await get_image_or_403_writable(image_id, db, current_user)
    if db_image.project_id != project_id:
        raise HTTPException(status_code=404, detail="Image not found")

    try:
        restored_image = (
            await image_deletion_service.restore_authorized_image(
                db=db,
                project_id=project_id,
                image_id=image_id,
                actor_user_id=current_user.id,
            )
        )
    except image_deletion_service.ImageDeletionNotFound as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Image not found",
        ) from exc
    except image_deletion_service.ImagePermanentlyDeleted as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Image permanently deleted",
        ) from exc
    except image_deletion_service.ImageStorageDeletionPending as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Image storage deletion is pending reconciliation",
        ) from exc
    except image_deletion_service.ImageRetentionExpired as exc:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="Retention expired",
        ) from exc
    finally:
        _clear_image_caches_best_effort(
            project_id=project_id,
            image_id=image_id,
        )
    return restored_image

@router.get("/projects/{project_id}/images/deletion-events", response_model=schemas.ImageDeletionEventList)
async def list_image_deletion_events(
    project_id: uuid.UUID,
    image_id: Optional[uuid.UUID] = Query(None),
    skip: int = 0,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    await get_project_or_403(project_id, db, current_user)
    events = await crud.list_image_deletion_events(db, project_id, image_id=image_id, skip=skip, limit=limit)
    total = await crud.count_image_deletion_events(db, project_id, image_id=image_id)
    return schemas.ImageDeletionEventList(events=events, total=total)

@router.put("/images/{image_id}/metadata", response_model=schemas.DataInstance, status_code=status.HTTP_200_OK)
async def update_image_metadata(
    image_id: uuid.UUID,
    metadata: MetadataUpdate = Body(...),
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """
    Updates the metadata for a specific image.
    It allows adding or modifying a key-value pair in the image's metadata.
    The changes are persisted to the database and caches are invalidated.
    """
    db_image = await get_image_or_403_writable(image_id, db, current_user)
    project_id = db_image.project_id

    current_metadata = dict(db_image.metadata_json or {})
    current_metadata[metadata.key] = metadata.value
    return await _persist_image_metadata(
        db=db,
        db_image=db_image,
        image_id=image_id,
        project_id=project_id,
        metadata=current_metadata,
    )

@router.delete("/images/{image_id}/metadata/{key}", response_model=schemas.DataInstance, status_code=status.HTTP_200_OK)
async def delete_image_metadata(
    image_id: uuid.UUID,
    key: str,
    db: AsyncSession = Depends(get_db),
    current_user: schemas.User = Depends(get_current_user),
):
    """
    Deletes a specific metadata key-value pair from an image.
    It first retrieves the image, checks permissions, and then removes the metadata.
    The database is updated, and relevant caches are cleared.
    """
    db_image = await get_image_or_403_writable(image_id, db, current_user)
    project_id = db_image.project_id

    current_metadata = dict(db_image.metadata_json or {})
    if key in current_metadata:
        del current_metadata[key]
    return await _persist_image_metadata(
        db=db,
        db_image=db_image,
        image_id=image_id,
        project_id=project_id,
        metadata=current_metadata,
    )
