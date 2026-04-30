import io
import uuid
import base64
from importlib.util import find_spec

from PIL import Image

from test_toolbox import WorkflowGraph, WorkflowImageInput, execute_image_workflow, get_manifest, validate_workflow


def _png_bytes() -> bytes:
    image = Image.new("L", (4, 4), 0)
    pixels = image.load()
    for y in range(4):
        for x in range(2, 4):
            pixels[x, y] = 220
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_output_toolbox_exposes_only_operator_level_parameters():
    manifest = get_manifest()
    output_method = next(method for method in manifest.methods if method.id == "output.versioned_image_artifact")

    assert [parameter.name for parameter in output_method.parameters] == [
        "mode",
        "export_policy",
        "materialize_processed_images",
    ]


def test_workflow_contract_accepts_multiple_input_rooted_processing_chains():
    workflow = WorkflowGraph(
        name="Parallel chains",
        nodes=[
            {
                "id": "input-1",
                "method_id": "source.project_part_images",
                "label": "Input",
                "chain_id": "chain-1",
                "parameters": {},
            },
            {
                "id": "yolo",
                "method_id": "ml.yolov8.detect",
                "label": "YOLOv8",
                "chain_id": "chain-1",
                "parameters": {"model": "yolov8n.pt", "confidence": 0.25},
            },
            {
                "id": "input-2",
                "method_id": "source.project_part_images",
                "label": "Input 2",
                "chain_id": "chain-2",
                "parameters": {},
            },
            {
                "id": "segment",
                "method_id": "segmentation.watershed_seeds",
                "label": "Segmentation",
                "chain_id": "chain-2",
                "parameters": {"seed_spacing_px": 18, "compactness": 0.01},
            },
        ],
        edges=[
            {"source_node": "input-1", "target_node": "yolo"},
            {"source_node": "input-2", "target_node": "segment"},
        ],
    )

    result = validate_workflow(workflow)

    assert result.status == "validated"
    assert [node.node_id for node in result.node_results] == ["input-1", "yolo", "input-2", "segment"]


def test_execute_image_workflow_runs_actual_image_algorithms_on_image_bytes():
    image_id = uuid.uuid4()
    workflow = WorkflowGraph(
        name="Actual execution",
        source={"kind": "manual_selection", "selected_image_ids": [image_id], "image_count": 1},
        nodes=[
            {"id": "input", "method_id": "source.project_part_images", "parameters": {}},
            {
                "id": "window",
                "method_id": "preprocess.window_level_normalization",
                "parameters": {"window": 255, "level": 128, "clip": True},
            },
            {"id": "threshold", "method_id": "threshold.otsu", "parameters": {}},
            {
                "id": "components",
                "method_id": "segmentation.connected_components",
                "parameters": {"min_area_px": 1},
            },
            {"id": "output", "method_id": "output.versioned_image_artifact", "parameters": {"mode": "overlay_artifact"}},
        ],
        edges=[
            {"source_node": "input", "target_node": "window"},
            {"source_node": "window", "target_node": "threshold"},
            {"source_node": "threshold", "target_node": "components"},
            {"source_node": "components", "target_node": "output"},
        ],
    )

    result = execute_image_workflow(
        workflow,
        [
            WorkflowImageInput(
                image_id=image_id,
                filename="two-tone.png",
                content_type="image/png",
                data=_png_bytes(),
            )
        ],
    )

    assert result.status == "completed"
    assert result.execution_mode == "execution"
    assert result.image_count == 1
    component_result = next(node for node in result.node_results if node.node_id == "components")
    assert component_result.summary["region_count"] == 1
    output_result = next(node for node in result.node_results if node.node_id == "output")
    assert {artifact["kind"] for artifact in output_result.artifacts} >= {"overlay_image", "recipe"}
    overlay_artifact = next(artifact for artifact in output_result.artifacts if artifact["kind"] == "overlay_image")
    assert overlay_artifact["label"] == "Segmentation Overlay :: Connected Components"
    assert overlay_artifact["method_id"] == "segmentation.connected_components"


def test_yolov8_node_reports_dependency_or_runner_contract():
    image_id = uuid.uuid4()
    workflow = WorkflowGraph(
        name="YOLO contract execution",
        source={"kind": "manual_selection", "selected_image_ids": [image_id], "image_count": 1},
        nodes=[
            {"id": "input", "method_id": "source.project_part_images", "parameters": {}},
            {"id": "yolo", "method_id": "ml.yolov8.detect", "parameters": {"model": "yolov8n.pt", "confidence": 0.25}},
        ],
        edges=[{"source_node": "input", "target_node": "yolo"}],
    )

    result = execute_image_workflow(
        workflow,
        [WorkflowImageInput(image_id=image_id, filename="tiny.png", content_type="image/png", data=_png_bytes())],
    )

    assert result.status == "failed"
    yolo_node = next(node for node in result.node_results if node.node_id == "yolo")
    if find_spec("ultralytics"):
        assert "model runner is configured" in yolo_node.message
    else:
        assert "optional 'ultralytics' package" in yolo_node.message


def test_asphalt_anomaly_detector_emits_red_overlay_artifact():
    image_id = uuid.uuid4()
    workflow = WorkflowGraph(
        name="Asphalt anomaly heatmap",
        source={"kind": "manual_selection", "selected_image_ids": [image_id], "image_count": 1},
        nodes=[
            {"id": "input", "method_id": "source.project_part_images", "parameters": {}},
            {
                "id": "anomaly",
                "method_id": "anomaly.asphalt_defects_heatmap",
                "parameters": {"sensitivity": 0.6, "blur_radius": 1},
            },
            {"id": "output", "method_id": "output.versioned_image_artifact", "parameters": {"mode": "overlay_artifact"}},
        ],
        edges=[
            {"source_node": "input", "target_node": "anomaly"},
            {"source_node": "anomaly", "target_node": "output"},
        ],
    )

    result = execute_image_workflow(
        workflow,
        [WorkflowImageInput(image_id=image_id, filename="asphalt.png", content_type="image/png", data=_png_bytes())],
    )

    assert result.status == "completed"
    output_result = next(node for node in result.node_results if node.node_id == "output")
    overlay_artifact = next(artifact for artifact in output_result.artifacts if artifact["kind"] == "overlay_image")
    assert overlay_artifact["method_id"] == "anomaly.asphalt_defects_heatmap"
    overlay_image = Image.open(io.BytesIO(base64.b64decode(overlay_artifact["data_base64"]))).convert("RGBA")
    red_pixel_count = sum(1 for r, g, b, a in overlay_image.getdata() if a > 0 and r > g and r > b)
    assert red_pixel_count > 0
