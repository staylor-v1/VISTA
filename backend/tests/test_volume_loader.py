import struct
from pathlib import Path

from PIL import Image

from utils.volume_loader import COMMON_VOLUME_FORMATS, load_slice_stack, load_volume, supported_volume_extensions


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
