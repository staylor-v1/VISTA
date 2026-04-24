"""Lightweight 3D volume fixture inspection helpers.

The production app can add richer readers later, but tests should be able to
verify core stack/cube behavior without pulling in heavy scientific packages.
"""

from __future__ import annotations

import ast
import io
import struct
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Iterable

from PIL import Image, ImageSequence


SLICE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"}
IMPLICIT_VOLUME_EXTENSIONS = {".npy", ".npz", ".tif", ".tiff"}
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


def _candidate_slices(path: Path) -> list[Path]:
    return sorted(
        item
        for item in path.iterdir()
        if item.is_file() and item.suffix.lower() in SLICE_EXTENSIONS
    )


def load_slice_stack(path: str | Path) -> VolumeInfo:
    stack_path = Path(path)
    if not stack_path.is_dir():
        raise ValueError(f"Slice stack path is not a directory: {stack_path}")
    slices = _candidate_slices(stack_path)
    if not slices:
        raise ValueError(f"No supported image slices found in {stack_path}")

    width = height = None
    for slice_path in slices:
        with Image.open(slice_path) as image:
            if width is None or height is None:
                width, height = image.size
            elif image.size != (width, height):
                raise ValueError("All image slices must share the same dimensions")

    return VolumeInfo(
        format="slice_stack",
        shape=(len(slices), int(height), int(width)),
        source_files=tuple(str(item) for item in slices),
        dtype="image",
    )


def _read_npy_header(file_obj: BinaryIO) -> tuple[tuple[int, ...], str]:
    magic = file_obj.read(6)
    if magic != b"\x93NUMPY":
        raise ValueError("Not a NumPy .npy file")
    major, minor = struct.unpack("BB", file_obj.read(2))
    if (major, minor) == (1, 0):
        header_len = struct.unpack("<H", file_obj.read(2))[0]
    elif major in {2, 3}:
        header_len = struct.unpack("<I", file_obj.read(4))[0]
    else:
        raise ValueError(f"Unsupported NumPy format version {major}.{minor}")
    header = file_obj.read(header_len).decode("latin1").strip()
    metadata = ast.literal_eval(header)
    shape = metadata.get("shape")
    descr = metadata.get("descr")
    if not isinstance(shape, tuple) or len(shape) < 3:
        raise ValueError("NumPy volume must have at least three dimensions")
    return tuple(int(value) for value in shape[:3]), str(descr or "unknown")


def load_numpy_volume(path: str | Path) -> VolumeInfo:
    volume_path = Path(path)
    if volume_path.suffix.lower() == ".npz":
        with zipfile.ZipFile(volume_path) as archive:
            npy_members = sorted(name for name in archive.namelist() if name.endswith(".npy"))
            if not npy_members:
                raise ValueError("NumPy .npz archive does not contain a .npy array")
            with archive.open(npy_members[0]) as member:
                payload = io.BytesIO(member.read())
                shape, dtype = _read_npy_header(payload)
    else:
        with volume_path.open("rb") as file_obj:
            shape, dtype = _read_npy_header(file_obj)
    return VolumeInfo(
        format="numpy",
        shape=shape,
        source_files=(str(volume_path),),
        dtype=dtype,
    )


def load_multipage_tiff(path: str | Path) -> VolumeInfo:
    volume_path = Path(path)
    with Image.open(volume_path) as image:
        frames = list(ImageSequence.Iterator(image))
        if not frames:
            raise ValueError("TIFF volume does not contain frames")
        width, height = frames[0].size
        if any(frame.size != (width, height) for frame in frames):
            raise ValueError("All TIFF frames must share the same dimensions")
    return VolumeInfo(
        format="multipage_tiff",
        shape=(len(frames), int(height), int(width)),
        source_files=(str(volume_path),),
        dtype="image",
    )


def load_volume(path: str | Path) -> VolumeInfo:
    volume_path = Path(path)
    if volume_path.is_dir():
        return load_slice_stack(volume_path)
    suffix = volume_path.suffix.lower()
    if suffix in {".npy", ".npz"}:
        return load_numpy_volume(volume_path)
    if suffix in {".tif", ".tiff"}:
        return load_multipage_tiff(volume_path)
    raise ValueError(f"Unsupported volume format: {volume_path.name}")


def supported_volume_extensions() -> Iterable[str]:
    return sorted(
        extension
        for metadata in COMMON_VOLUME_FORMATS.values()
        if metadata["supported"]
        for extension in metadata["extensions"]
    )
