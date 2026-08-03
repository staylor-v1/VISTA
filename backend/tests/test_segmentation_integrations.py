import base64
import io

import uuid

import pytest
import numpy as np
from PIL import Image, ImageDraw
from pydantic import BaseModel

from backend import imglib
from backend.analyze_toolbox import WorkflowGraph, WorkflowImageInput, execute_image_workflow
from backend.analyze_toolbox.segmentation import SegmentationComponent, SegmentationInput
from backend.utils.segmentation_integrations import opencv_backend


def _encoded_test_image() -> str:
    image = Image.new("RGB", (20, 16), "black")
    draw = ImageDraw.Draw(image)
    draw.rectangle([3, 4, 7, 9], fill="white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


@pytest.mark.parametrize(
    ("backend", "function_path", "expected_label"),
    [
        ("yolo", "utils.segmentation_integrations.yolo_backend.run", "object"),
        ("opencv", "utils.segmentation_integrations.opencv_backend.run", "foreground"),
        ("anomalib", "utils.segmentation_integrations.anomalib_backend.run", "anomaly"),
    ],
)
def test_local_import_segmentation_adapters_return_shared_output_shape(backend, function_path, expected_label):
    request = SegmentationInput(
        image_data_base64=_encoded_test_image(),
        backend=backend,
        mode="default",
        options={
            "integration_mode": "local_import",
            "function_path": function_path,
            "model": f"{backend}-example-model",
        },
    )

    result = SegmentationComponent().run(request)

    assert result.backend == backend
    assert result.mode == ("watershed" if backend == "opencv" else "default")
    assert result.metrics["runtime"] == f"{backend}_placeholder"
    assert len(result.masks) == 1
    mask = result.masks[0]
    assert mask.label == expected_label
    assert mask.score is not None
    assert mask.bbox == [7.5, 6.0, 5.0, 4.0]
    assert mask.area == 20.0


def test_sam_local_import_adapter_has_same_placeholder_contract():
    request = SegmentationInput(
        image_data_base64=_encoded_test_image(),
        backend="sam",
        mode="prompted",
        prompts={"box": [2, 3, 12, 13]},
        options={
            "integration_mode": "local_import",
            "function_path": "utils.segmentation_integrations.sam_backend.run",
            "model": "sam-example-model",
        },
    )

    result = SegmentationComponent().run(request)

    assert result.backend == "sam"
    assert result.mode == "prompted"
    assert result.metrics["runtime"] == "sam_placeholder"
    assert len(result.masks) == 1
    mask = result.masks[0]
    assert mask.label == "sam-region"
    assert mask.bbox == [7.5, 6.0, 5.0, 4.0]
    assert mask.area == 20.0


@pytest.mark.parametrize("backend", ["opencv", "yolo", "anomalib", "sam"])
def test_default_placeholder_dispatches_to_replaceable_imglib(backend):
    result = SegmentationComponent().run(
        SegmentationInput(image_data_base64=_encoded_test_image(), backend=backend)
    )

    assert len(result.masks) == 1
    assert result.masks[0].bbox == [7.5, 6.0, 5.0, 4.0]


@pytest.mark.parametrize("source", ["image", "file", "data_uri"])
def test_placeholder_accepts_every_supported_image_source(source, tmp_path):
    image = Image.open(io.BytesIO(base64.b64decode(_encoded_test_image())))
    kwargs = {"image": image}
    if source == "file":
        path = tmp_path / "source.png"
        image.save(path)
        kwargs = {"file": str(path)}
    elif source == "data_uri":
        kwargs = {"image_data_base64": f"data:image/png;base64,{_encoded_test_image()}"}

    result = SegmentationComponent().run(SegmentationInput(backend="opencv", **kwargs))

    assert result.masks[0].bbox == [7.5, 6.0, 5.0, 4.0]


def test_sam_option_overrides_duplicate_prompt_without_crashing():
    result = SegmentationComponent().run(
        SegmentationInput(
            image_data_base64=_encoded_test_image(),
            backend="sam",
            prompts={"box": [1, 1, 2, 2]},
            options={"box": [3, 3, 4, 4]},
        )
    )
    assert len(result.masks) == 1


def test_opencv_placeholder_matches_deployment_class_contract():
    config = imglib.OpenCVSegmentationConfig(
        min_mask_area_px=2.5,
        min_peak_distance_px=4,
        mean_shift_sp=5,
        mean_shift_sr=6,
    )
    segmenter = imglib.OpenCVSegmentation.from_config(config)
    data = type("Input", (), {"file": None, "image": np.zeros((16, 20, 3)), "run_mode": "default"})()

    result = segmenter.run(data)

    assert segmenter.config == config
    assert result["backend"] == "opencv"
    assert result["mode"] == "watershed"
    assert result["masks"][0]["bbox"] == [7.5, 6.0, 5.0, 4.0]


def test_opencv_placeholder_rejects_mode_not_supported_by_deployment():
    data = type("Input", (), {"file": None, "image": np.zeros((4, 4, 3)), "run_mode": "other"})()
    with pytest.raises(ValueError, match="Unsupported OpenCV segmentation mode: other"):
        imglib.OpenCVSegmentation().run(data)


def test_opencv_adapter_is_drop_in_for_strict_deployment_class(monkeypatch):
    calls = {}

    class ExternalOutput(BaseModel):
        backend: str = "external-opencv"
        mode: str = "watershed"
        masks: list = []

    class StrictExternalOpenCV:
        def __init__(
            self,
            *,
            min_mask_area_px=1.0,
            min_peak_distance_px=20,
            mean_shift_sp=21,
            mean_shift_sr=51,
        ):
            calls["config"] = {
                "min_mask_area_px": min_mask_area_px,
                "min_peak_distance_px": min_peak_distance_px,
                "mean_shift_sp": mean_shift_sp,
                "mean_shift_sr": mean_shift_sr,
            }

        def run(self, data):
            calls["data"] = data
            return ExternalOutput()

    monkeypatch.setattr(opencv_backend.imglib, "OpenCVSegmentation", StrictExternalOpenCV)
    output = opencv_backend.run(
        {
            "image_data_base64": _encoded_test_image(),
            "mode": "default",
            "options": {"min_mask_area_px": 8, "model": "must-not-be-forwarded"},
        }
    )

    assert output.backend == "external-opencv"
    assert calls["config"] == {
        "min_mask_area_px": 8,
        "min_peak_distance_px": 20,
        "mean_shift_sp": 21,
        "mean_shift_sr": 51,
    }
    assert calls["data"].file is None
    assert calls["data"].run_mode == "default"
    assert calls["data"].image.shape == (16, 20, 3)
    # The source's black RGB pixel remains black; verify RGB red becomes BGR.
    red = Image.new("RGB", (1, 1), "red")
    buffer = io.BytesIO()
    red.save(buffer, format="PNG")
    opencv_backend.run(
        {"image_data_base64": base64.b64encode(buffer.getvalue()).decode(), "options": {}}
    )
    assert calls["data"].image[0, 0].tolist() == [0, 0, 255]


def test_normalization_preserves_external_backend_and_mode():
    class ExternalOutput(BaseModel):
        backend: str = "opencv-deployment"
        mode: str = "watershed"
        masks: list = []
        metrics: dict = {"implementation": "external"}
        raw_output: str = "painted-image"

    result = SegmentationComponent()._normalize_result(ExternalOutput(), "opencv", "default")

    assert result.backend == "opencv-deployment"
    assert result.mode == "watershed"
    assert result.metrics == {"implementation": "external"}
    assert result.raw_output == "painted-image"


def test_loaded_image_placeholder_analysis_produces_inspection_overlay_artifact():
    image_bytes = base64.b64decode(_encoded_test_image())
    image_id = uuid.uuid4()
    workflow = WorkflowGraph(
        name="Placeholder overlay",
        nodes=[
            {"id": "input", "method_id": "source.project_part_images", "parameters": {}},
            {"id": "segment", "method_id": "segmentation.opencv.placeholder", "parameters": {}},
            {
                "id": "output",
                "method_id": "output.versioned_image_artifact",
                "parameters": {"mode": "overlay_artifact"},
            },
        ],
        edges=[
            {"source_node": "input", "target_node": "segment"},
            {"source_node": "segment", "target_node": "output"},
        ],
    )

    result = execute_image_workflow(
        workflow,
        [WorkflowImageInput(image_id=image_id, filename="loaded.png", content_type="image/png", data=image_bytes)],
    )

    segment = next(node for node in result.node_results if node.node_id == "segment")
    output = next(node for node in result.node_results if node.node_id == "output")
    assert result.status == "completed"
    assert segment.summary["detections"][0]["bbox"] == {"x": 7.5, "y": 6.0, "width": 5.0, "height": 4.0}
    overlay = next(artifact for artifact in output.artifacts if artifact["kind"] == "overlay_image")
    assert overlay["content_type"] == "image/png"
    assert overlay["data_base64"]
    overlay_image = Image.open(io.BytesIO(base64.b64decode(overlay["data_base64"]))).convert("RGBA")
    alpha = overlay_image.getchannel("A")
    assert alpha.getbbox() == (8, 6, 13, 10)
    assert sum(value > 0 for value in alpha.get_flattened_data()) == 20
