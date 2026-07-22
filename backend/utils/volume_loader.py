"""Lightweight 3D volume fixture inspection helpers.

The production app can add richer readers later, but tests should be able to
verify core stack/cube behavior without pulling in heavy scientific packages.
"""

from __future__ import annotations

import ast
import math
import struct
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterable

import numpy as np
from PIL import Image


SLICE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"}
IMPLICIT_VOLUME_EXTENSIONS = {".npy", ".npz", ".tif", ".tiff"}
MAX_NPY_HEADER_BYTES = 64 * 1024
MAX_VOLUME_LOAD_BYTES = int(2.5 * 1024 * 1024 * 1024)
MAX_VOLUME_LOAD_VOXELS = MAX_VOLUME_LOAD_BYTES
MAX_ZIP_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024

_ZIP_EOCD_SIGNATURE = b"PK\x05\x06"
_ZIP64_EOCD_SIGNATURE = b"PK\x06\x06"
_ZIP64_LOCATOR_SIGNATURE = b"PK\x06\x07"
_ZIP_CENTRAL_FILE_SIGNATURE = b"PK\x01\x02"
_ZIP_CENTRAL_DIGITAL_SIGNATURE = b"PK\x05\x05"
_ZIP_ARCHIVE_EXTRA_DATA_SIGNATURE = b"PK\x06\x08"
_ZIP_MAX_COMMENT_BYTES = 65_535


@dataclass(frozen=True)
class VolumeReadLimits:
    """Resource limits applied before compressed or decoded volume reads.

    ``max_decoded_bytes`` covers NumPy array payloads and the float64 scalar
    working volume used by the reference image/TIFF readers.  Container-member
    limits also bound archives with many tiny entries or TIFF frames.
    """

    max_voxels: int
    max_decoded_bytes: int
    max_source_bytes: int
    max_container_members: int

    def __post_init__(self) -> None:
        for field_name in (
            "max_voxels",
            "max_decoded_bytes",
            "max_source_bytes",
            "max_container_members",
        ):
            value = getattr(self, field_name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{field_name} must be a positive integer")


REFERENCE_VOLUME_READ_LIMITS = VolumeReadLimits(
    max_voxels=MAX_VOLUME_LOAD_VOXELS,
    max_decoded_bytes=MAX_VOLUME_LOAD_BYTES,
    max_source_bytes=MAX_VOLUME_LOAD_BYTES,
    max_container_members=4_096,
)
COMMON_VOLUME_FORMATS = {
    "slice_stack": {
        "extensions": sorted(SLICE_EXTENSIONS),
        "supported": True,
        "notes": "One 2D image per slice, sorted by filename.",
    },
    "numpy": {
        "extensions": [".npy", ".npz"],
        "supported": True,
        "notes": "Python voxel arrays; shape is read directly from the NumPy header.",
    },
    "multipage_tiff": {
        "extensions": [".tif", ".tiff"],
        "supported": True,
        "notes": "Implicit stack stored as frames in one TIFF.",
    },
    "dicom": {
        "extensions": [".dcm", ".dicom"],
        "supported": False,
        "notes": "Common clinical series format; requires a DICOM reader such as pydicom/SimpleITK.",
    },
    "nifti": {
        "extensions": [".nii", ".nii.gz"],
        "supported": False,
        "notes": "Common neuroimaging volume format; requires nibabel/SimpleITK.",
    },
    "nrrd": {
        "extensions": [".nrrd", ".nhdr"],
        "supported": False,
        "notes": "General 3D/4D research volume format; requires pynrrd/SimpleITK.",
    },
    "metaimage": {
        "extensions": [".mha", ".mhd"],
        "supported": False,
        "notes": "ITK MetaImage format, often paired with raw voxel data.",
    },
    "matlab": {
        "extensions": [".mat"],
        "supported": False,
        "notes": "MATLAB voxel arrays; requires scipy or hdf5 tooling depending on MAT version.",
    },
    "hdf5": {
        "extensions": [".h5", ".hdf5"],
        "supported": False,
        "notes": "Container format used for scientific volumes; requires h5py.",
    },
}


@dataclass(frozen=True)
class VolumeInfo:
    format: str
    shape: tuple[int, int, int]
    source_files: tuple[str, ...]
    dtype: str | None = None


@dataclass(frozen=True)
class _NpyHeader:
    shape: tuple[int, int, int]
    dtype_text: str
    dtype: np.dtype
    data_offset: int
    payload_bytes: int


def _checked_voxel_count(shape: tuple[int, int, int]) -> int:
    if any(isinstance(value, bool) or value < 0 for value in shape):
        raise ValueError("Volume dimensions must be non-negative integers")
    return math.prod(shape)


def _enforce_source_size(path: Path, limits: VolumeReadLimits | None) -> None:
    if limits is None:
        return
    try:
        source_bytes = path.stat().st_size
    except OSError as exc:
        raise ValueError(f"Could not inspect volume source {path.name}") from exc
    if source_bytes > limits.max_source_bytes:
        raise ValueError(
            f"Volume source exceeds the {limits.max_source_bytes}-byte materialized-file limit"
        )


def _enforce_decoded_limits(
    *,
    shape: tuple[int, int, int],
    decoded_bytes: int,
    limits: VolumeReadLimits | None,
) -> None:
    if limits is None:
        return
    voxel_count = _checked_voxel_count(shape)
    if voxel_count > limits.max_voxels:
        raise ValueError(
            f"Volume declares {voxel_count} voxels, exceeding the {limits.max_voxels}-voxel limit"
        )
    if decoded_bytes > limits.max_decoded_bytes:
        raise ValueError(
            "Volume declares "
            f"{decoded_bytes} decoded bytes, exceeding the {limits.max_decoded_bytes}-byte limit"
        )


def _candidate_slices(path: Path) -> list[Path]:
    return sorted(
        item
        for item in path.iterdir()
        if item.is_file() and item.suffix.lower() in SLICE_EXTENSIONS
    )


def load_slice_stack(
    path: str | Path, *, limits: VolumeReadLimits | None = None
) -> VolumeInfo:
    stack_path = Path(path)
    if not stack_path.is_dir():
        raise ValueError(f"Slice stack path is not a directory: {stack_path}")
    slices = _candidate_slices(stack_path)
    if not slices:
        raise ValueError(f"No supported image slices found in {stack_path}")
    if limits is not None and len(slices) > limits.max_container_members:
        raise ValueError(
            "Slice stack contains "
            f"{len(slices)} files, exceeding the {limits.max_container_members}-member limit"
        )

    width = height = None
    source_bytes = 0
    for slice_path in slices:
        if limits is not None:
            source_bytes += slice_path.stat().st_size
            if source_bytes > limits.max_source_bytes:
                raise ValueError(
                    "Slice stack exceeds the "
                    f"{limits.max_source_bytes}-byte materialized-source limit"
                )
        with Image.open(slice_path) as image:
            if width is None or height is None:
                width, height = image.size
            elif image.size != (width, height):
                raise ValueError("All image slices must share the same dimensions")

    shape = (len(slices), int(height), int(width))
    _enforce_decoded_limits(
        shape=shape,
        decoded_bytes=math.prod(shape) * np.dtype(np.float64).itemsize,
        limits=limits,
    )

    return VolumeInfo(
        format="slice_stack",
        shape=shape,
        source_files=tuple(str(item) for item in slices),
        dtype="image",
    )


def _read_exact(file_obj: BinaryIO, length: int, *, field: str) -> bytes:
    payload = file_obj.read(length)
    if len(payload) != length:
        raise ValueError(f"Truncated NumPy {field}")
    return payload


def _read_zip_bytes_at(
    file_obj: BinaryIO,
    offset: int,
    length: int,
    *,
    field: str,
) -> bytes:
    try:
        file_obj.seek(offset)
    except (AttributeError, OSError) as exc:
        raise ValueError("ZIP archive source must be seekable") from exc
    payload = file_obj.read(length)
    if len(payload) != length:
        raise ValueError(f"Truncated ZIP {field}")
    return payload


def preflight_zip_archive(
    file_obj: BinaryIO,
    *,
    limits: VolumeReadLimits,
    available_bytes: int | None = None,
) -> tuple[int, int]:
    """Bound ZIP metadata before ``zipfile.ZipFile`` allocates ``ZipInfo`` objects.

    ``ZipFile`` eagerly materializes the entire central directory.  Checking
    ``infolist()`` afterwards is therefore too late for an archive containing
    millions of empty entries.  This preflight reads the small end record and
    then walks central-directory records without retaining filenames or entry
    objects in memory.
    """

    try:
        original_offset = int(file_obj.tell())
        file_obj.seek(0, 2)
        source_bytes = int(file_obj.tell())
    except (AttributeError, OSError, TypeError, ValueError) as exc:
        raise ValueError("ZIP archive source must be seekable") from exc

    try:
        if available_bytes is not None and available_bytes != source_bytes:
            raise ValueError(
                "ZIP archive size changed during preflight: "
                f"expected {available_bytes} bytes, found {source_bytes}"
            )
        if source_bytes > limits.max_source_bytes:
            raise ValueError(
                "ZIP archive source exceeds the configured/built-in "
                f"{limits.max_source_bytes}-byte materialized-file limit"
            )
        if source_bytes < 22:
            raise ValueError("Truncated ZIP end-of-central-directory record")

        tail_length = min(source_bytes, 22 + _ZIP_MAX_COMMENT_BYTES)
        tail_offset = source_bytes - tail_length
        tail = _read_zip_bytes_at(
            file_obj,
            tail_offset,
            tail_length,
            field="end-of-central-directory search window",
        )
        candidate_end = len(tail)
        eocd_index = -1
        while candidate_end > 0:
            candidate = tail.rfind(_ZIP_EOCD_SIGNATURE, 0, candidate_end)
            if candidate < 0:
                break
            if candidate + 22 <= len(tail):
                comment_length = struct.unpack_from("<H", tail, candidate + 20)[0]
                if candidate + 22 + comment_length == len(tail):
                    eocd_index = candidate
                    break
            candidate_end = candidate
        if eocd_index < 0:
            raise ValueError("ZIP end-of-central-directory record is missing")

        eocd_offset = tail_offset + eocd_index
        (
            _signature,
            disk_number,
            central_disk_number,
            entries_on_disk,
            total_entries,
            central_size,
            central_offset,
            _comment_length,
        ) = struct.unpack_from("<4s4H2LH", tail, eocd_index)
        if disk_number != 0 or central_disk_number != 0:
            raise ValueError("Multi-disk ZIP archives are not supported")

        locator_offset = eocd_offset - 20
        locator = (
            _read_zip_bytes_at(file_obj, locator_offset, 20, field="ZIP64 locator")
            if locator_offset >= 0
            else b""
        )
        has_zip64_locator = locator.startswith(_ZIP64_LOCATOR_SIGNATURE)
        has_zip64_sentinel = (
            entries_on_disk == 0xFFFF
            or total_entries == 0xFFFF
            or central_size == 0xFFFFFFFF
            or central_offset == 0xFFFFFFFF
        )
        central_end = eocd_offset
        if has_zip64_sentinel or has_zip64_locator:
            if not has_zip64_locator:
                raise ValueError("ZIP64 locator is missing")
            (
                _locator_signature,
                zip64_disk_number,
                zip64_eocd_offset,
                zip64_disk_count,
            ) = struct.unpack("<4sLQL", locator)
            if zip64_disk_number != 0 or zip64_disk_count != 1:
                raise ValueError("Multi-disk ZIP64 archives are not supported")
            zip64_fixed = _read_zip_bytes_at(
                file_obj,
                int(zip64_eocd_offset),
                56,
                field="ZIP64 end-of-central-directory record",
            )
            (
                zip64_signature,
                zip64_record_size,
                _creator_version,
                _extractor_version,
                zip64_disk,
                zip64_central_disk,
                entries_on_disk,
                total_entries,
                central_size,
                central_offset,
            ) = struct.unpack("<4sQ2H2L4Q", zip64_fixed)
            if zip64_signature != _ZIP64_EOCD_SIGNATURE or zip64_record_size < 44:
                raise ValueError("Invalid ZIP64 end-of-central-directory record")
            if zip64_disk != 0 or zip64_central_disk != 0:
                raise ValueError("Multi-disk ZIP64 archives are not supported")
            if int(zip64_eocd_offset) + 12 + int(zip64_record_size) != locator_offset:
                raise ValueError("Invalid ZIP64 end-of-central-directory bounds")
            central_end = int(zip64_eocd_offset)

        total_entries = int(total_entries)
        entries_on_disk = int(entries_on_disk)
        central_size = int(central_size)
        central_offset = int(central_offset)
        if entries_on_disk != total_entries:
            raise ValueError("Multi-disk ZIP archives are not supported")
        if total_entries > limits.max_container_members:
            raise ValueError(
                "ZIP archive declares "
                f"{total_entries} members, exceeding the configured/built-in "
                f"{limits.max_container_members}-member limit"
            )
        central_metadata_limit = min(
            MAX_ZIP_CENTRAL_DIRECTORY_BYTES,
            limits.max_source_bytes,
        )
        if central_size > central_metadata_limit:
            raise ValueError(
                "ZIP central directory declares "
                f"{central_size} bytes, exceeding the built-in "
                f"{central_metadata_limit}-byte metadata limit"
            )
        if central_offset < 0 or central_size < 0:
            raise ValueError("Invalid ZIP central-directory bounds")
        if central_offset + central_size != central_end:
            raise ValueError("Invalid ZIP central-directory bounds")

        # Verify the declared entry count without constructing any ZipInfo
        # objects.  Variable-length names, extras, and comments are skipped.
        cursor = central_offset
        actual_entries = 0
        while cursor < central_end:
            signature = _read_zip_bytes_at(
                file_obj,
                cursor,
                4,
                field="central-directory signature",
            )
            if signature == _ZIP_CENTRAL_FILE_SIGNATURE:
                fixed = _read_zip_bytes_at(
                    file_obj,
                    cursor,
                    46,
                    field="central-directory entry",
                )
                filename_length, extra_length, comment_length = struct.unpack_from(
                    "<HHH", fixed, 28
                )
                record_length = 46 + filename_length + extra_length + comment_length
                actual_entries += 1
                if actual_entries > limits.max_container_members:
                    raise ValueError(
                        "ZIP central directory contains more than the configured/built-in "
                        f"{limits.max_container_members}-member limit"
                    )
            elif signature == _ZIP_CENTRAL_DIGITAL_SIGNATURE:
                record_length = 6 + struct.unpack(
                    "<H",
                    _read_zip_bytes_at(
                        file_obj,
                        cursor + 4,
                        2,
                        field="central-directory digital-signature length",
                    ),
                )[0]
            elif signature == _ZIP_ARCHIVE_EXTRA_DATA_SIGNATURE:
                record_length = 8 + struct.unpack(
                    "<L",
                    _read_zip_bytes_at(
                        file_obj,
                        cursor + 4,
                        4,
                        field="central-directory extra-data length",
                    ),
                )[0]
            else:
                raise ValueError("Invalid ZIP central-directory record")
            if record_length < 1 or cursor + record_length > central_end:
                raise ValueError("Truncated ZIP central-directory record")
            cursor += record_length

        if actual_entries != total_entries:
            raise ValueError(
                "ZIP central-directory entry count does not match its end record"
            )
        return actual_entries, central_size
    finally:
        try:
            file_obj.seek(original_offset)
        except (AttributeError, OSError):
            pass


def _inspect_npy_header(
    file_obj: BinaryIO,
    *,
    limits: VolumeReadLimits | None = None,
    available_bytes: int | None = None,
) -> _NpyHeader:
    magic = file_obj.read(6)
    if magic != b"\x93NUMPY":
        raise ValueError("Not a NumPy .npy file")
    major, minor = struct.unpack("BB", _read_exact(file_obj, 2, field="version"))
    if (major, minor) == (1, 0):
        header_len = struct.unpack("<H", _read_exact(file_obj, 2, field="header length"))[0]
    elif major in {2, 3}:
        header_len = struct.unpack("<I", _read_exact(file_obj, 4, field="header length"))[0]
    else:
        raise ValueError(f"Unsupported NumPy format version {major}.{minor}")
    if header_len > MAX_NPY_HEADER_BYTES:
        raise ValueError(
            f"NumPy header exceeds the {MAX_NPY_HEADER_BYTES}-byte metadata limit"
        )
    encoding = "utf-8" if major == 3 else "latin1"
    try:
        header = _read_exact(file_obj, header_len, field="header").decode(encoding).strip()
        metadata = ast.literal_eval(header)
    except (SyntaxError, UnicodeDecodeError, ValueError, MemoryError, RecursionError) as exc:
        raise ValueError("Invalid NumPy array header") from exc
    if not isinstance(metadata, dict):
        raise ValueError("Invalid NumPy array header")
    shape = metadata.get("shape")
    descr = metadata.get("descr")
    if (
        not isinstance(shape, tuple)
        or len(shape) != 3
        or any(isinstance(value, bool) or not isinstance(value, int) for value in shape)
    ):
        raise ValueError("NumPy volume must have exactly three dimensions")
    if descr is None:
        raise ValueError("NumPy volume header is missing a dtype")
    if not isinstance(metadata.get("fortran_order"), bool):
        raise ValueError("NumPy volume header has an invalid fortran_order value")
    normalized_shape = tuple(int(value) for value in shape)
    _checked_voxel_count(normalized_shape)
    try:
        dtype = np.dtype(descr)
    except (TypeError, ValueError, MemoryError) as exc:
        raise ValueError("NumPy volume has an invalid dtype") from exc
    if dtype.hasobject or dtype.fields is not None or dtype.subdtype is not None:
        raise ValueError("NumPy volume must use a scalar, non-object dtype")
    if dtype.kind not in {"b", "u", "i", "f"}:
        raise ValueError("NumPy volume dtype must be real numeric or boolean")
    payload_bytes = _checked_voxel_count(normalized_shape) * int(dtype.itemsize)
    _enforce_decoded_limits(
        shape=normalized_shape,
        decoded_bytes=payload_bytes,
        limits=limits,
    )
    try:
        data_offset = int(file_obj.tell())
    except (AttributeError, OSError):
        data_offset = 6 + 2 + (2 if major == 1 else 4) + header_len
    if available_bytes is not None and data_offset + payload_bytes > available_bytes:
        raise ValueError("NumPy array payload is truncated")
    return _NpyHeader(
        shape=normalized_shape,
        dtype_text=str(descr or "unknown"),
        dtype=dtype,
        data_offset=data_offset,
        payload_bytes=payload_bytes,
    )


def read_npy_header(file_obj: BinaryIO) -> tuple[tuple[int, ...], str]:
    header = _inspect_npy_header(file_obj)
    return header.shape, header.dtype_text


def _inspect_npz_archive(
    archive: zipfile.ZipFile, *, limits: VolumeReadLimits | None
) -> tuple[zipfile.ZipInfo, _NpyHeader]:
    members = [member for member in archive.infolist() if not member.is_dir()]
    if limits is not None and len(members) > limits.max_container_members:
        raise ValueError(
            "NumPy archive contains "
            f"{len(members)} members, exceeding the {limits.max_container_members}-member limit"
        )
    names = [member.filename for member in members]
    if len(names) != len(set(names)):
        raise ValueError("NumPy archive contains duplicate member names")
    if any(member.flag_bits & 0x1 for member in members):
        raise ValueError("Encrypted NumPy archive members are not supported")
    if limits is not None:
        total_uncompressed = sum(int(member.file_size) for member in members)
        if total_uncompressed > limits.max_decoded_bytes:
            raise ValueError(
                "NumPy archive declares "
                f"{total_uncompressed} uncompressed bytes, exceeding the "
                f"{limits.max_decoded_bytes}-byte archive limit"
            )
        if any(member.file_size > limits.max_decoded_bytes for member in members):
            raise ValueError("NumPy archive member exceeds the decoded-byte limit")

    npy_members = sorted(
        (member for member in members if member.filename.lower().endswith(".npy")),
        key=lambda member: member.filename,
    )
    if not npy_members:
        raise ValueError("NumPy .npz archive does not contain a .npy array")
    selected = npy_members[0]
    with archive.open(selected) as member:
        header = _inspect_npy_header(
            member,
            limits=limits,
            available_bytes=int(selected.file_size),
        )
    return selected, header


def load_numpy_volume(
    path: str | Path, *, limits: VolumeReadLimits | None = None
) -> VolumeInfo:
    volume_path = Path(path)
    _enforce_source_size(volume_path, limits)
    if volume_path.suffix.lower() == ".npz":
        try:
            with volume_path.open("rb") as file_obj:
                preflight_zip_archive(
                    file_obj,
                    limits=limits or REFERENCE_VOLUME_READ_LIMITS,
                )
                with zipfile.ZipFile(file_obj) as archive:
                    _member, header = _inspect_npz_archive(archive, limits=limits)
        except zipfile.BadZipFile as exc:
            raise ValueError("Invalid NumPy .npz archive") from exc
    else:
        with volume_path.open("rb") as file_obj:
            header = _inspect_npy_header(
                file_obj,
                limits=limits,
                available_bytes=volume_path.stat().st_size,
            )
    return VolumeInfo(
        format="numpy",
        shape=header.shape,
        source_files=(str(volume_path),),
        dtype=header.dtype_text,
    )


def read_numpy_volume_array(
    path: str | Path, *, limits: VolumeReadLimits
) -> np.ndarray:
    """Load one preflighted scalar NumPy volume without inflating an NPZ first."""

    volume_path = Path(path)
    _enforce_source_size(volume_path, limits)
    try:
        if volume_path.suffix.lower() == ".npz":
            with volume_path.open("rb") as file_obj:
                preflight_zip_archive(file_obj, limits=limits)
                with zipfile.ZipFile(file_obj) as archive:
                    selected, expected = _inspect_npz_archive(archive, limits=limits)
                    with archive.open(selected) as member:
                        loaded = np.lib.format.read_array(member, allow_pickle=False)
        else:
            with volume_path.open("rb") as file_obj:
                expected = _inspect_npy_header(
                    file_obj,
                    limits=limits,
                    available_bytes=volume_path.stat().st_size,
                )
                file_obj.seek(0)
                loaded = np.load(file_obj, allow_pickle=False)
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        raise ValueError(f"Could not safely read NumPy voxel source {volume_path.name}: {exc}") from exc
    array = np.asarray(loaded)
    if array.shape != expected.shape or array.dtype != expected.dtype:
        raise ValueError("NumPy volume changed between preflight and decode")
    return array


def load_multipage_tiff(
    path: str | Path, *, limits: VolumeReadLimits | None = None
) -> VolumeInfo:
    volume_path = Path(path)
    _enforce_source_size(volume_path, limits)
    with Image.open(volume_path) as image:
        frame_count = int(getattr(image, "n_frames", 1) or 0)
        if frame_count < 1:
            raise ValueError("TIFF volume does not contain frames")
        if limits is not None and frame_count > limits.max_container_members:
            raise ValueError(
                "TIFF contains "
                f"{frame_count} frames, exceeding the {limits.max_container_members}-member limit"
            )
        width, height = image.size
        shape = (frame_count, int(height), int(width))
        _enforce_decoded_limits(
            shape=shape,
            decoded_bytes=math.prod(shape) * np.dtype(np.float64).itemsize,
            limits=limits,
        )
        for frame_index in range(frame_count):
            image.seek(frame_index)
            if image.size != (width, height):
                raise ValueError("All TIFF frames must share the same dimensions")
    return VolumeInfo(
        format="multipage_tiff",
        shape=shape,
        source_files=(str(volume_path),),
        dtype="image",
    )


def load_volume(
    path: str | Path, *, limits: VolumeReadLimits | None = None
) -> VolumeInfo:
    volume_path = Path(path)
    if volume_path.is_dir():
        return load_slice_stack(volume_path, limits=limits)
    suffix = volume_path.suffix.lower()
    if suffix in {".npy", ".npz"}:
        return load_numpy_volume(volume_path, limits=limits)
    if suffix in {".tif", ".tiff"}:
        return load_multipage_tiff(volume_path, limits=limits)
    raise ValueError(f"Unsupported volume format: {volume_path.name}")


def supported_volume_extensions() -> Iterable[str]:
    return sorted(
        extension
        for metadata in COMMON_VOLUME_FORMATS.values()
        if metadata["supported"]
        for extension in metadata["extensions"]
    )
