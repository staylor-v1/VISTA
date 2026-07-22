import struct
import zipfile
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from utils.volume_loader import (
    COMMON_VOLUME_FORMATS,
    VolumeReadLimits,
    load_slice_stack,
    load_volume,
    read_numpy_volume_array,
    supported_volume_extensions,
)


def _write_minimal_npy(path: Path, shape=(3, 4, 5), dtype="|u1"):
    header = {"descr": dtype, "fortran_order": False, "shape": tuple(shape)}
    header_text = repr(header)
    padding = 16 - ((10 + len(header_text) + 1) % 16)
    header_bytes = (header_text + (" " * padding) + "\n").encode("latin1")
    payload_size = 1
    for value in shape:
        payload_size *= value
    path.write_bytes(
        b"\x93NUMPY"
        + bytes([1, 0])
        + struct.pack("<H", len(header_bytes))
        + header_bytes
        + bytes(payload_size)
    )


def _npy_header_bytes(shape=(3, 4, 5), dtype="|u1"):
    header = {"descr": dtype, "fortran_order": False, "shape": tuple(shape)}
    header_text = repr(header)
    padding = 16 - ((10 + len(header_text) + 1) % 16)
    header_bytes = (header_text + (" " * padding) + "\n").encode("latin1")
    return (
        b"\x93NUMPY"
        + bytes([1, 0])
        + struct.pack("<H", len(header_bytes))
        + header_bytes
    )


def _limits(**overrides):
    values = {
        "max_voxels": 100,
        "max_decoded_bytes": 1024,
        "max_source_bytes": 4096,
        "max_container_members": 4,
    }
    values.update(overrides)
    return VolumeReadLimits(**values)


def test_loads_one_image_file_per_slice_stack(tmp_path):
    stack_dir = tmp_path / "stack"
    stack_dir.mkdir()
    for index in range(4):
        Image.new("L", (7, 5), color=index * 20).save(stack_dir / f"slice_{index:03d}.png")

    volume = load_slice_stack(stack_dir)

    assert volume.format == "slice_stack"
    assert volume.shape == (4, 5, 7)
    assert len(volume.source_files) == 4


def test_loads_repository_pt3_synthetic_slice_stack():
    volume = load_volume(Path(__file__).resolve().parents[2] / "test" / "data" / "3D" / "anatomical")

    assert volume.format == "slice_stack"
    assert volume.shape == (24, 96, 128)


def test_loads_repository_pt3_geometric_dual_label_stack():
    geometric_dir = Path(__file__).resolve().parents[2] / "test" / "data" / "3D" / "geometric"
    volume = load_volume(geometric_dir)
    files = sorted(geometric_dir.glob("PT3_GEOMETRIC_DUAL_LABEL_Z*.png"))

    xy_slice = Image.open(files[16]).convert("L")
    xy_bright = sum(1 for value in xy_slice.getdata() if value >= 180)

    xz_bright = 0
    yz_bright = 0
    for file_path in files:
        image = Image.open(file_path).convert("L")
        width, height = image.size
        xz_bright += sum(1 for x in range(width) if image.getpixel((x, 48)) >= 180)
        yz_bright += sum(1 for y in range(height) if image.getpixel((64, y)) >= 180)

    assert volume.format == "slice_stack"
    assert volume.shape == (64, 96, 128)
    assert xy_bright > 700
    assert xz_bright > 500
    assert yz_bright > 350


def test_loads_implicit_python_voxel_array_npy(tmp_path):
    npy_path = tmp_path / "volume.npy"
    _write_minimal_npy(npy_path, shape=(6, 8, 10))

    volume = load_volume(npy_path)

    assert volume.format == "numpy"
    assert volume.shape == (6, 8, 10)
    assert volume.dtype == "|u1"


def test_common_3d_cube_formats_are_documented():
    assert ".npy" in supported_volume_extensions()
    assert ".tiff" in supported_volume_extensions()
    assert COMMON_VOLUME_FORMATS["dicom"]["extensions"] == [".dcm", ".dicom"]
    assert COMMON_VOLUME_FORMATS["matlab"]["extensions"] == [".mat"]
    assert COMMON_VOLUME_FORMATS["nifti"]["extensions"] == [".nii", ".nii.gz"]


def test_loads_implicit_python_voxel_array_npz(tmp_path):
    npy_path = tmp_path / "volume.npy"
    _write_minimal_npy(npy_path, shape=(5, 6, 7))

    import zipfile

    archive_path = tmp_path / "volume.npz"
    with zipfile.ZipFile(archive_path, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.write(npy_path, arcname="voxels.npy")

    volume = load_volume(archive_path)

    assert volume.format == "numpy"
    assert volume.shape == (5, 6, 7)


def test_loads_multipage_tiff_volume(tmp_path):
    tiff_path = tmp_path / "stack.tiff"
    frames = [Image.new("L", (9, 11), color=i * 20) for i in range(3)]
    frames[0].save(tiff_path, save_all=True, append_images=frames[1:])

    volume = load_volume(tiff_path)

    assert volume.format == "multipage_tiff"
    assert volume.shape == (3, 11, 9)


def test_loads_300_slice_300px_multipage_tiff_volume(tmp_path):
    tiff_path = tmp_path / "stack_300x300x300.tif"
    frames = [Image.new("L", (300, 300), color=index % 256) for index in range(300)]
    frames[0].save(tiff_path, save_all=True, append_images=frames[1:])

    volume = load_volume(tiff_path)

    assert volume.format == "multipage_tiff"
    assert volume.shape == (300, 300, 300)
    assert len(volume.source_files) == 1


def test_tif_2d_vs_3d_classification_by_frame_count(tmp_path):
    single_slice_tif = tmp_path / "single_slice.tif"
    Image.new("L", (10, 12), color=90).save(single_slice_tif)

    multi_slice_tif = tmp_path / "multi_slice.tif"
    frames = [Image.new("L", (10, 12), color=v) for v in (10, 40, 70, 100)]
    frames[0].save(multi_slice_tif, save_all=True, append_images=frames[1:])

    single_volume = load_volume(single_slice_tif)
    multi_volume = load_volume(multi_slice_tif)

    assert single_volume.format == "multipage_tiff"
    assert single_volume.shape == (1, 12, 10)
    assert multi_volume.format == "multipage_tiff"
    assert multi_volume.shape == (4, 12, 10)



def test_reference_volume_limits_allow_2_5_gib_sources_and_decoded_numpy_payloads(tmp_path):
    from utils.volume_loader import MAX_VOLUME_LOAD_BYTES, REFERENCE_VOLUME_READ_LIMITS

    assert MAX_VOLUME_LOAD_BYTES == int(2.5 * 1024 * 1024 * 1024)
    assert REFERENCE_VOLUME_READ_LIMITS.max_source_bytes == MAX_VOLUME_LOAD_BYTES
    assert REFERENCE_VOLUME_READ_LIMITS.max_decoded_bytes == MAX_VOLUME_LOAD_BYTES
    assert REFERENCE_VOLUME_READ_LIMITS.max_voxels == MAX_VOLUME_LOAD_BYTES

    npy_path = tmp_path / "declared-large-but-allowed.npy"
    header = _npy_header_bytes(shape=(1, 1, 400 * 1024 * 1024), dtype="|u1")
    npy_path.write_bytes(header)
    with npy_path.open("ab") as file_obj:
        file_obj.truncate(len(header) + (400 * 1024 * 1024))

    volume = load_volume(npy_path, limits=REFERENCE_VOLUME_READ_LIMITS)

    assert volume.shape == (1, 1, 400 * 1024 * 1024)
    assert volume.format == "numpy"


def test_rejects_oversized_declared_npy_shape_before_payload_read(tmp_path):
    npy_path = tmp_path / "declared-too-large.npy"
    npy_path.write_bytes(_npy_header_bytes(shape=(1, 1, 101)))

    with pytest.raises(ValueError, match="101 voxels.*100-voxel limit"):
        load_volume(npy_path, limits=_limits())


def test_rejects_npy_decoded_byte_limit_before_array_allocation(tmp_path):
    npy_path = tmp_path / "wide-dtype.npy"
    npy_path.write_bytes(_npy_header_bytes(shape=(1, 1, 2), dtype="<f8"))

    with pytest.raises(ValueError, match="16 decoded bytes.*8-byte limit"):
        load_volume(npy_path, limits=_limits(max_decoded_bytes=8))


def test_npz_preflight_bounds_total_uncompressed_members_without_inflating_them(tmp_path):
    archive_path = tmp_path / "archive-bomb-like.npz"
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("voxels.npy", _npy_header_bytes(shape=(1, 1, 1)) + b"\x01")
        archive.writestr("ignored-padding.bin", b"0" * 256)

    with pytest.raises(ValueError, match="uncompressed bytes.*128-byte archive limit"):
        load_volume(
            archive_path,
            limits=_limits(max_decoded_bytes=128),
        )


def test_npz_preflight_rejects_compressed_member_with_oversized_declared_array(tmp_path):
    archive_path = tmp_path / "declared-array-bomb.npz"
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("voxels.npy", _npy_header_bytes(shape=(1, 1, 10_000_000)))

    assert archive_path.stat().st_size < 1024
    with pytest.raises(ValueError, match="10000000 voxels.*100-voxel limit"):
        load_volume(archive_path, limits=_limits())


def test_npz_member_count_is_bounded_before_selected_array_decode(tmp_path):
    archive_path = tmp_path / "too-many-members.npz"
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("voxels.npy", _npy_header_bytes(shape=(1, 1, 1)) + b"\x01")
        archive.writestr("one.txt", b"1")
        archive.writestr("two.txt", b"2")

    with pytest.raises(ValueError, match="3 members.*2-member limit"):
        load_volume(archive_path, limits=_limits(max_container_members=2))


def test_preflighted_npz_array_reader_decodes_only_selected_bounded_array(tmp_path):
    archive_path = tmp_path / "safe.npz"
    expected = np.arange(8, dtype=np.uint16).reshape((2, 2, 2))
    with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        import io

        payload = io.BytesIO()
        np.save(payload, expected)
        archive.writestr("voxels.npy", payload.getvalue())

    actual = read_numpy_volume_array(archive_path, limits=_limits())

    assert np.array_equal(actual, expected)


def test_tiff_shape_is_rejected_before_frame_decode_allocation(tmp_path):
    tiff_path = tmp_path / "too-many-voxels.tiff"
    frames = [Image.new("L", (2, 2), color=index) for index in range(3)]
    frames[0].save(tiff_path, save_all=True, append_images=frames[1:])

    with pytest.raises(ValueError, match="12 voxels.*10-voxel limit"):
        load_volume(tiff_path, limits=_limits(max_voxels=10))


def test_tiff_frame_count_is_bounded_as_container_members(tmp_path):
    tiff_path = tmp_path / "too-many-frames.tiff"
    frames = [Image.new("L", (1, 1), color=index) for index in range(3)]
    frames[0].save(tiff_path, save_all=True, append_images=frames[1:])

    with pytest.raises(ValueError, match="3 frames.*2-member limit"):
        load_volume(tiff_path, limits=_limits(max_container_members=2))
