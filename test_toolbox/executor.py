import io
import math
import base64
from collections import deque
from dataclasses import dataclass, field
from importlib.util import find_spec
from typing import Any, Dict, Iterable, List, Optional, Tuple

from PIL import Image, ImageFilter, ImageOps

from .contracts import ToolboxExecutionResult, WorkflowGraph, WorkflowImageInput, WorkflowNodeResult
from .registry import _method_map, validate_workflow


@dataclass
class ImageState:
    source_image: Image.Image
    image: Image.Image
    mask: Optional[Image.Image] = None
    labels: Optional[Image.Image] = None
    overlay_label: str = "Analyze Overlay"
    overlay_method_id: Optional[str] = None
    overlay_method_name: Optional[str] = None
    detections: List[Dict[str, Any]] = field(default_factory=list)
    measurements: List[Dict[str, Any]] = field(default_factory=list)
    artifacts: List[Dict[str, Any]] = field(default_factory=list)


def _node_parameters(node, method) -> Dict[str, Any]:
    params = {parameter.name: parameter.default for parameter in method.parameters}
    params.update(node.parameters or {})
    return params


def _chains(workflow: WorkflowGraph) -> List[List[Any]]:
    children: Dict[str, List[str]] = {node.id: [] for node in workflow.nodes}
    nodes_by_id = {node.id: node for node in workflow.nodes}
    for edge in workflow.edges:
        children.setdefault(edge.source_node, []).append(edge.target_node)

    chains = []
    source_nodes = [node for node in workflow.nodes if node.method_id == "source.project_part_images"]
    for source_node in source_nodes:
        chain = [source_node]
        current = source_node
        seen = {source_node.id}
        while children.get(current.id):
            next_id = children[current.id][0]
            if next_id in seen:
                break
            current = nodes_by_id[next_id]
            chain.append(current)
            seen.add(current.id)
        chains.append(chain)
    return chains


def _grayscale(image: Image.Image) -> Image.Image:
    return ImageOps.grayscale(image)


def _window_level(image: Image.Image, window: float, level: float, clip: bool) -> Image.Image:
    gray = _grayscale(image)
    low = level - (window / 2.0)
    high = level + (window / 2.0)
    scale = 255.0 / max(high - low, 1.0)

    def map_pixel(value: int) -> int:
        mapped = int(round((float(value) - low) * scale))
        if clip:
            return max(0, min(255, mapped))
        return mapped % 256

    return gray.point(map_pixel)


def _minmax(image: Image.Image, output_min: float, output_max: float) -> Image.Image:
    gray = _grayscale(image)
    min_value, max_value = gray.getextrema()
    if max_value <= min_value:
        return Image.new("L", gray.size, int(max(0, min(255, output_min * 255))))
    scale = (output_max - output_min) / float(max_value - min_value)

    def map_pixel(value: int) -> int:
        mapped = (output_min + ((value - min_value) * scale)) * 255.0
        return max(0, min(255, int(round(mapped))))

    return gray.point(map_pixel)


def _otsu_threshold(image: Image.Image) -> Tuple[Image.Image, int]:
    gray = _grayscale(image)
    hist = gray.histogram()
    total = sum(hist)
    sum_total = sum(level * count for level, count in enumerate(hist))
    sum_background = 0.0
    weight_background = 0
    best_variance = -1.0
    threshold = 0
    for level, count in enumerate(hist):
        weight_background += count
        if weight_background == 0:
            continue
        weight_foreground = total - weight_background
        if weight_foreground == 0:
            break
        sum_background += level * count
        mean_background = sum_background / weight_background
        mean_foreground = (sum_total - sum_background) / weight_foreground
        variance = weight_background * weight_foreground * ((mean_background - mean_foreground) ** 2)
        if variance > best_variance:
            best_variance = variance
            threshold = level
    return gray.point(lambda value: 255 if value >= threshold else 0), threshold


def _manual_threshold(image: Image.Image, threshold: float, invert: bool) -> Image.Image:
    gray = _grayscale(image)
    cutoff = threshold * 255.0 if threshold <= 1.0 else threshold
    if invert:
        return gray.point(lambda value: 255 if value < cutoff else 0)
    return gray.point(lambda value: 255 if value >= cutoff else 0)


def _connected_components(mask: Image.Image, min_area_px: int = 0) -> Tuple[Image.Image, List[Dict[str, Any]]]:
    binary = _grayscale(mask).point(lambda value: 1 if value > 0 else 0)
    width, height = binary.size
    pixels = binary.load()
    labels = Image.new("L", binary.size, 0)
    label_pixels = labels.load()
    visited = set()
    measurements: List[Dict[str, Any]] = []
    label_value = 1

    for y in range(height):
        for x in range(width):
            if (x, y) in visited or pixels[x, y] == 0:
                continue
            queue = deque([(x, y)])
            visited.add((x, y))
            points = []
            while queue:
                px, py = queue.popleft()
                points.append((px, py))
                for nx, ny in ((px - 1, py), (px + 1, py), (px, py - 1), (px, py + 1)):
                    if nx < 0 or ny < 0 or nx >= width or ny >= height:
                        continue
                    if (nx, ny) in visited or pixels[nx, ny] == 0:
                        continue
                    visited.add((nx, ny))
                    queue.append((nx, ny))
            if len(points) < min_area_px:
                continue
            xs = [point[0] for point in points]
            ys = [point[1] for point in points]
            stored_label = ((label_value - 1) % 254) + 1
            for px, py in points:
                label_pixels[px, py] = stored_label
            measurements.append({
                "label": label_value,
                "area_px": len(points),
                "bbox": [min(xs), min(ys), max(xs) + 1, max(ys) + 1],
                "centroid": [sum(xs) / len(points), sum(ys) / len(points)],
            })
            label_value += 1
    return labels, measurements


def _seeded_regions(image: Image.Image, seed_spacing_px: int) -> Image.Image:
    gray = _grayscale(image)
    width, height = gray.size
    spacing = max(1, int(seed_spacing_px))
    labels = Image.new("L", gray.size, 0)
    label_pixels = labels.load()
    for y in range(height):
        for x in range(width):
            grid_x = x // spacing
            grid_y = y // spacing
            label_pixels[x, y] = ((grid_y * max(1, math.ceil(width / spacing)) + grid_x) % 254) + 1
    return labels


def _edge_mask(image: Image.Image, low_threshold: float, high_threshold: float) -> Image.Image:
    edges = _grayscale(image).filter(ImageFilter.FIND_EDGES)
    cutoff = max(low_threshold, high_threshold)
    cutoff = cutoff * 255.0 if cutoff <= 1.0 else cutoff
    return edges.point(lambda value: 255 if value >= cutoff else 0)


def _morphology(mask: Image.Image, radius: int, operation: str) -> Image.Image:
    size = max(3, (int(radius) * 2) + 1)
    source = _grayscale(mask)
    if operation == "open":
        return source.filter(ImageFilter.MinFilter(size)).filter(ImageFilter.MaxFilter(size))
    return source.filter(ImageFilter.MaxFilter(size)).filter(ImageFilter.MinFilter(size))


def _summarize_image(image: Image.Image) -> Dict[str, Any]:
    extrema = _grayscale(image).getextrema()
    return {"size": list(image.size), "mode": image.mode, "intensity_range": list(extrema)}


def _analysis_overlay_png(state: ImageState) -> Optional[Dict[str, Any]]:
    overlay_source = state.labels or state.mask
    if overlay_source is None:
        return None
    mask = _grayscale(overlay_source).point(lambda value: 150 if value > 0 else 0)
    color = Image.new("RGBA", state.source_image.size, (34, 197, 94, 0))
    if mask.size != state.source_image.size:
        mask = mask.resize(state.source_image.size)
    color.putalpha(mask)
    buffer = io.BytesIO()
    color.save(buffer, format="PNG")
    return {
        "kind": "overlay_image",
        "label": state.overlay_label,
        "method_id": state.overlay_method_id,
        "method_name": state.overlay_method_name,
        "content_type": "image/png",
        "filename_suffix": "analyze-overlay.png",
        "data_base64": base64.b64encode(buffer.getvalue()).decode("ascii"),
        "width": state.source_image.width,
        "height": state.source_image.height,
    }


def _overlay_label(prefix: str, method) -> str:
    return f"{prefix} Overlay :: {method.name}"


def _apply_node(state: ImageState, node, method) -> Tuple[ImageState, str, Dict[str, Any], List[Dict[str, Any]]]:
    params = _node_parameters(node, method)
    artifacts: List[Dict[str, Any]] = []
    if node.method_id == "source.project_part_images":
        return state, "Loaded source image bytes.", _summarize_image(state.image), artifacts
    if node.method_id == "preprocess.window_level_normalization":
        state.image = _window_level(state.image, float(params["window"]), float(params["level"]), bool(params["clip"]))
        return state, "Applied window/level normalization.", _summarize_image(state.image), artifacts
    if node.method_id == "preprocess.minmax_normalization":
        state.image = _minmax(state.image, float(params["output_min"]), float(params["output_max"]))
        return state, "Applied min-max normalization.", _summarize_image(state.image), artifacts
    if node.method_id == "filter.gaussian_blur":
        state.image = state.image.filter(ImageFilter.GaussianBlur(float(params["sigma"])))
        return state, "Applied Gaussian blur.", _summarize_image(state.image), artifacts
    if node.method_id == "filter.median":
        size = max(3, (int(params["radius"]) * 2) + 1)
        state.image = state.image.filter(ImageFilter.MedianFilter(size))
        return state, "Applied median filter.", _summarize_image(state.image), artifacts
    if node.method_id == "threshold.otsu":
        state.mask, threshold = _otsu_threshold(state.image)
        state.overlay_label = _overlay_label("Segmentation", method)
        state.overlay_method_id = method.id
        state.overlay_method_name = method.name
        return state, "Applied Otsu threshold.", {"threshold": threshold, **_summarize_image(state.mask)}, artifacts
    if node.method_id == "threshold.manual":
        state.mask = _manual_threshold(state.image, float(params["threshold"]), bool(params["invert"]))
        state.overlay_label = _overlay_label("Segmentation", method)
        state.overlay_method_id = method.id
        state.overlay_method_name = method.name
        return state, "Applied manual threshold.", _summarize_image(state.mask), artifacts
    if node.method_id == "segmentation.connected_components":
        source_mask = state.mask or _otsu_threshold(state.image)[0]
        state.labels, state.measurements = _connected_components(source_mask, int(params["min_area_px"]))
        state.overlay_label = _overlay_label("Segmentation", method)
        state.overlay_method_id = method.id
        state.overlay_method_name = method.name
        return state, "Labeled connected components.", {"region_count": len(state.measurements)}, artifacts
    if node.method_id == "segmentation.watershed_seeds":
        state.labels = _seeded_regions(state.mask or state.image, int(params["seed_spacing_px"]))
        state.overlay_label = _overlay_label("Segmentation", method)
        state.overlay_method_id = method.id
        state.overlay_method_name = method.name
        artifacts.append({"kind": "overlay", "label": "seeded_regions", "size": list(state.labels.size)})
        return state, "Computed seeded segmentation labels.", {"label_image": _summarize_image(state.labels)}, artifacts
    if node.method_id == "edge.canny":
        state.mask = _edge_mask(state.image, float(params["low_threshold"]), float(params["high_threshold"]))
        state.overlay_label = _overlay_label("Feature Detection", method)
        state.overlay_method_id = method.id
        state.overlay_method_name = method.name
        return state, "Computed edge mask.", _summarize_image(state.mask), artifacts
    if node.method_id == "morphology.open":
        state.mask = _morphology(state.mask or _otsu_threshold(state.image)[0], int(params["radius"]), "open")
        state.overlay_label = _overlay_label("Morphology", method)
        state.overlay_method_id = method.id
        state.overlay_method_name = method.name
        return state, "Applied morphological open.", _summarize_image(state.mask), artifacts
    if node.method_id == "morphology.close":
        state.mask = _morphology(state.mask or _otsu_threshold(state.image)[0], int(params["radius"]), "close")
        state.overlay_label = _overlay_label("Morphology", method)
        state.overlay_method_id = method.id
        state.overlay_method_name = method.name
        return state, "Applied morphological close.", _summarize_image(state.mask), artifacts
    if node.method_id == "measure.region_properties":
        if not state.measurements:
            _, state.measurements = _connected_components(state.labels or state.mask or _otsu_threshold(state.image)[0], 0)
        return state, "Measured region properties.", {"measurement_count": len(state.measurements)}, artifacts
    if node.method_id in ("ml.yolov8.detect", "ml.yolov8.segment"):
        if not find_spec("ultralytics"):
            raise RuntimeError("YOLOv8 execution requires the optional 'ultralytics' package and model weights.")
        raise RuntimeError("YOLOv8 runtime binding is available only after a model runner is configured.")
    if node.method_id == "output.versioned_image_artifact":
        artifacts.extend(state.artifacts)
        overlay_artifact = _analysis_overlay_png(state)
        if overlay_artifact:
            artifacts.append(overlay_artifact)
        artifacts.append({
            "kind": "recipe",
            "mode": params.get("mode"),
            "detections": len(state.detections),
            "measurements": len(state.measurements),
            "has_overlay": state.labels is not None or state.mask is not None,
        })
        return state, "Prepared recipe/artifact output metadata.", {"artifact_count": len(artifacts)}, artifacts
    return state, "No runtime operation registered for this method.", {}, artifacts


def _decode_image(image_input: WorkflowImageInput) -> Image.Image:
    image = Image.open(io.BytesIO(image_input.data))
    image.load()
    return image


def execute_image_workflow(workflow: WorkflowGraph, images: Iterable[WorkflowImageInput]) -> ToolboxExecutionResult:
    validation = validate_workflow(workflow)
    methods = _method_map()
    chains = _chains(workflow)
    image_inputs = list(images)
    node_results: List[WorkflowNodeResult] = []
    warnings = list(validation.warnings)
    failed = False

    for image_input in image_inputs:
        for chain in chains:
            decoded = _decode_image(image_input).copy()
            state = ImageState(source_image=decoded.copy(), image=decoded.copy())
            for node in chain:
                method = methods[node.method_id]
                try:
                    state, message, summary, artifacts = _apply_node(state, node, method)
                    state.artifacts.extend(artifacts)
                    node_results.append(WorkflowNodeResult(
                        node_id=node.id,
                        method_id=node.method_id,
                        status="completed",
                        output_types=method.output_types,
                        message=f"{message} ({image_input.filename})",
                        summary={"image_id": str(image_input.image_id), **summary},
                        artifacts=artifacts,
                    ))
                except Exception as exc:
                    failed = True
                    node_results.append(WorkflowNodeResult(
                        node_id=node.id,
                        method_id=node.method_id,
                        status="failed",
                        output_types=method.output_types,
                        message=f"{exc} ({image_input.filename})",
                        summary={"image_id": str(image_input.image_id)},
                    ))
                    break

    if not image_inputs:
        warnings.append("No image bytes were provided for execution.")

    return ToolboxExecutionResult(
        workflow_name=workflow.name,
        status="failed" if failed else "completed",
        execution_mode="execution",
        image_count=len(image_inputs),
        node_results=node_results,
        warnings=warnings,
    )
