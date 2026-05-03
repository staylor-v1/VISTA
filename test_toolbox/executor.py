import io
import math
import base64
from collections import deque
from dataclasses import dataclass, field
from importlib import import_module
from typing import Any, Dict, Iterable, List, Optional, Tuple

from PIL import Image, ImageChops, ImageFilter, ImageOps

from .contracts import ToolboxExecutionResult, WorkflowGraph, WorkflowImageInput, WorkflowNodeResult
from .registry import _method_map, validate_workflow

_YOLO_MODEL_CACHE: Dict[str, Any] = {}


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
    low = level - (window / 2.0)
    high = level + (window / 2.0)
    scale = 255.0 / max(high - low, 1.0)

    def map_pixel(value: int) -> int:
        mapped = int(round((float(value) - low) * scale))
        if clip:
            return max(0, min(255, mapped))
        return mapped % 256

    if image.mode in ("RGB", "RGBA"):
        channels = image.split()
        normalized_channels = [channels[idx].point(map_pixel) for idx in range(3)]
        if image.mode == "RGBA":
            normalized_channels.append(channels[3])
        return Image.merge(image.mode, tuple(normalized_channels))

    gray = _grayscale(image)
    return gray.point(map_pixel)


def _minmax(image: Image.Image, output_min: float, output_max: float) -> Image.Image:
    def normalize_channel(channel: Image.Image) -> Image.Image:
        min_value, max_value = channel.getextrema()
        if max_value <= min_value:
            return Image.new("L", channel.size, int(max(0, min(255, output_min * 255))))
        scale = (output_max - output_min) / float(max_value - min_value)

        def map_pixel(value: int) -> int:
            mapped = (output_min + ((value - min_value) * scale)) * 255.0
            return max(0, min(255, int(round(mapped))))

        return channel.point(map_pixel)

    if image.mode in ("RGB", "RGBA"):
        channels = image.split()
        normalized_channels = [normalize_channel(channels[idx]) for idx in range(3)]
        if image.mode == "RGBA":
            normalized_channels.append(channels[3])
        return Image.merge(image.mode, tuple(normalized_channels))

    gray = _grayscale(image)
    return normalize_channel(gray)


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


def _asphalt_anomaly_heatmap(image: Image.Image, sensitivity: float, blur_radius: int) -> Image.Image:
    gray = _grayscale(image)
    blurred = gray.filter(ImageFilter.GaussianBlur(radius=max(0, int(blur_radius))))
    edges = blurred.filter(ImageFilter.FIND_EDGES)
    hist = edges.histogram()
    total = sum(hist)
    target_ratio = 0.03 + ((1.0 - max(0.0, min(1.0, sensitivity))) * 0.2)
    target_pixels = max(1, int(total * target_ratio))
    running = 0
    threshold = 255
    for level in range(255, -1, -1):
        running += hist[level]
        if running >= target_pixels:
            threshold = level
            break
    binary = edges.point(lambda value: 255 if value >= threshold else 0)
    return binary.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MaxFilter(3))


def _frangi_ridge_heatmap(image: Image.Image, sensitivity: float, blur_radius: int) -> Image.Image:
    gray = _grayscale(image).filter(ImageFilter.GaussianBlur(radius=max(0, int(blur_radius))))
    inverted = ImageOps.invert(gray)
    fine = inverted.filter(ImageFilter.FIND_EDGES)
    coarse = inverted.filter(ImageFilter.GaussianBlur(radius=2)).filter(ImageFilter.FIND_EDGES)
    enhanced = Image.blend(coarse, fine, alpha=0.65)
    cutoff = int(255 * (0.75 - (max(0.0, min(1.0, sensitivity)) * 0.45)))
    return enhanced.point(lambda value: 255 if value >= cutoff else 0).filter(ImageFilter.MaxFilter(3))


def _blackhat_crack_heatmap(image: Image.Image, kernel_radius: int, sensitivity: float) -> Image.Image:
    gray = _grayscale(image)
    size = max(3, (int(kernel_radius) * 2) + 1)
    closed = gray.filter(ImageFilter.MaxFilter(size)).filter(ImageFilter.MinFilter(size))
    blackhat = ImageChops.subtract(closed, gray)
    hist = blackhat.histogram()
    total = sum(hist)
    target_ratio = 0.025 + ((1.0 - max(0.0, min(1.0, sensitivity))) * 0.12)
    target_pixels = max(1, int(total * target_ratio))
    running = 0
    threshold = 255
    for level in range(255, -1, -1):
        running += hist[level]
        if running >= target_pixels:
            threshold = level
            break
    return blackhat.point(lambda value: 255 if value >= threshold else 0).filter(ImageFilter.MaxFilter(3))


def _yolov8_detection_records(
    image: Image.Image,
    measurements: List[Dict[str, Any]],
    confidence: float,
    *,
    include_mask_labels: bool = False,
) -> List[Dict[str, Any]]:
    detections: List[Dict[str, Any]] = []
    score = max(0.0, min(1.0, float(confidence)))
    for measurement in measurements:
        x1, y1, x2, y2 = measurement["bbox"]
        detection = {
            "class_id": 0,
            "class_name": "object",
            "confidence": score,
            "bbox": {
                "x": x1,
                "y": y1,
                "width": max(0, x2 - x1),
                "height": max(0, y2 - y1),
                "image_width": image.width,
                "image_height": image.height,
            },
        }
        if include_mask_labels:
            detection["class_name"] = "instance"
            detection["mask_label"] = measurement["label"]
        detections.append(detection)
    return detections


def _yolov8_detection_fallback(image: Image.Image, confidence: float) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    mask, _threshold = _otsu_threshold(image)
    _labels, measurements = _connected_components(mask, min_area_px=1)
    return _yolov8_detection_records(image, measurements, confidence), measurements


def _yolov8_instance_segmentation_fallback(image: Image.Image, confidence: float) -> Tuple[Image.Image, List[Dict[str, Any]], List[Dict[str, Any]]]:
    source_mask, _threshold = _otsu_threshold(image)
    mask = source_mask.filter(ImageFilter.MaxFilter(3))
    labels, measurements = _connected_components(mask, min_area_px=1)
    detections = _yolov8_detection_records(image, measurements, confidence, include_mask_labels=True)
    return labels, detections, measurements


def _as_list(value) -> list:
    if value is None:
        return []
    if hasattr(value, "detach"):
        value = value.detach()
    if hasattr(value, "cpu"):
        value = value.cpu()
    if hasattr(value, "numpy"):
        value = value.numpy()
    if hasattr(value, "tolist"):
        return value.tolist()
    return list(value)


def _run_ultralytics_yolo(image: Image.Image, model_name: str, confidence: float, *, segment: bool = False) -> Tuple[Optional[Image.Image], List[Dict[str, Any]], List[Dict[str, Any]]]:
    ultralytics = import_module("ultralytics")
    if model_name not in _YOLO_MODEL_CACHE:
        _YOLO_MODEL_CACHE[model_name] = ultralytics.YOLO(model_name)
    model = _YOLO_MODEL_CACHE[model_name]
    results = model(image.convert("RGB"), conf=max(0.0, min(1.0, float(confidence))), verbose=False)
    result = list(results)[0] if results else None
    if result is None:
        return None, [], []

    names = getattr(result, "names", {}) or getattr(model, "names", {}) or {}
    boxes = getattr(result, "boxes", None)
    xyxy_values = _as_list(getattr(boxes, "xyxy", []))
    confidence_values = _as_list(getattr(boxes, "conf", []))
    class_values = _as_list(getattr(boxes, "cls", []))
    detections: List[Dict[str, Any]] = []
    measurements: List[Dict[str, Any]] = []
    for index, coords in enumerate(xyxy_values):
        if len(coords) < 4:
            continue
        x1, y1, x2, y2 = [float(value) for value in coords[:4]]
        class_id = int(float(class_values[index])) if index < len(class_values) else 0
        score = float(confidence_values[index]) if index < len(confidence_values) else float(confidence)
        bbox = {
            "x": max(0.0, x1),
            "y": max(0.0, y1),
            "width": max(0.0, x2 - x1),
            "height": max(0.0, y2 - y1),
            "image_width": image.width,
            "image_height": image.height,
        }
        class_name = str(names.get(class_id, class_id)) if isinstance(names, dict) else str(class_id)
        detections.append({
            "class_id": class_id,
            "class_name": class_name,
            "confidence": score,
            "bbox": bbox,
        })
        measurements.append({
            "label": index + 1,
            "area_px": bbox["width"] * bbox["height"],
            "bbox": [bbox["x"], bbox["y"], bbox["x"] + bbox["width"], bbox["y"] + bbox["height"]],
            "centroid": [bbox["x"] + (bbox["width"] / 2), bbox["y"] + (bbox["height"] / 2)],
            "confidence": score,
            "class_name": class_name,
        })

    labels = None
    masks = getattr(result, "masks", None)
    mask_data = _as_list(getattr(masks, "data", [])) if segment and masks is not None else []
    if mask_data:
        labels = Image.new("L", image.size, 0)
        label_pixels = labels.load()
        for label_index, mask in enumerate(mask_data, start=1):
            mask_height = len(mask)
            mask_width = len(mask[0]) if mask_height else 0
            if mask_width <= 0:
                continue
            for y in range(image.height):
                source_y = min(mask_height - 1, int((y / max(1, image.height)) * mask_height))
                row = mask[source_y]
                for x in range(image.width):
                    source_x = min(mask_width - 1, int((x / max(1, image.width)) * mask_width))
                    if float(row[source_x]) > 0.5:
                        label_pixels[x, y] = ((label_index - 1) % 254) + 1
        if segment:
            for index, detection in enumerate(detections):
                detection["mask_label"] = index + 1
    return labels, detections, measurements


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
    overlay_color = (239, 68, 68, 0) if (state.overlay_method_id or "").startswith("anomaly.") else (34, 197, 94, 0)
    color = Image.new("RGBA", state.source_image.size, overlay_color)
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
    if node.method_id == "anomaly.edge_density_heatmap":
        state.mask = _asphalt_anomaly_heatmap(state.image, float(params["sensitivity"]), int(params["blur_radius"]))
        state.overlay_label = _overlay_label("Anomaly Detection", method)
        state.overlay_method_id = method.id
        state.overlay_method_name = method.name
        return state, "Detected crack/pothole anomaly regions.", _summarize_image(state.mask), artifacts
    if node.method_id == "anomaly.frangi_ridge":
        state.mask = _frangi_ridge_heatmap(state.image, float(params["sensitivity"]), int(params["blur_radius"]))
        state.overlay_label = _overlay_label("Anomaly Detection", method)
        state.overlay_method_id = method.id
        state.overlay_method_name = method.name
        return state, "Computed Frangi-style ridge anomaly response.", _summarize_image(state.mask), artifacts
    if node.method_id == "anomaly.blackhat_morphology":
        state.mask = _blackhat_crack_heatmap(state.image, int(params["kernel_radius"]), float(params["sensitivity"]))
        state.overlay_label = _overlay_label("Anomaly Detection", method)
        state.overlay_method_id = method.id
        state.overlay_method_name = method.name
        return state, "Computed black-hat morphological crack response.", _summarize_image(state.mask), artifacts
    if node.method_id == "measure.region_properties":
        if not state.measurements:
            _, state.measurements = _connected_components(state.labels or state.mask or _otsu_threshold(state.image)[0], 0)
        return state, "Measured region properties.", {"measurement_count": len(state.measurements)}, artifacts
    if node.method_id == "ml.yolov8.segment":
        model_name = str(params.get("model") or "yolov8n-seg.pt")
        confidence = float(params.get("confidence", 0.25))
        runtime = "ultralytics"
        runtime_warning = None
        try:
            labels, detections, measurements = _run_ultralytics_yolo(state.image, model_name, confidence, segment=True)
            state.labels = labels
            state.detections = detections
            state.measurements = measurements
        except Exception as exc:
            runtime = "fallback"
            runtime_warning = f"YOLOv8 model '{model_name}' was not used; deterministic fallback ran instead ({exc})."
            state.labels, state.detections, state.measurements = _yolov8_instance_segmentation_fallback(
                state.image,
                confidence,
            )
        state.overlay_label = _overlay_label("Instance Segmentation", method)
        state.overlay_method_id = method.id
        state.overlay_method_name = method.name
        return state, "Computed YOLOv8-compatible instance segmentation.", {
            "runtime": runtime,
            "model": model_name,
            "instance_count": len(state.measurements),
            "detection_count": len(state.detections),
            **({"runtime_warning": runtime_warning} if runtime_warning else {}),
        }, artifacts
    if node.method_id == "ml.yolov8.detect":
        model_name = str(params.get("model") or "yolov8n.pt")
        confidence = float(params.get("confidence", 0.25))
        runtime = "ultralytics"
        runtime_warning = None
        try:
            _labels, state.detections, state.measurements = _run_ultralytics_yolo(state.image, model_name, confidence, segment=False)
        except Exception as exc:
            runtime = "fallback"
            runtime_warning = f"YOLOv8 model '{model_name}' was not used; deterministic fallback ran instead ({exc})."
            state.detections, state.measurements = _yolov8_detection_fallback(
                state.image,
                confidence,
            )
        return state, "Computed YOLOv8-compatible object detections.", {
            "runtime": runtime,
            "model": model_name,
            "detection_count": len(state.detections),
            "measurement_count": len(state.measurements),
            **({"runtime_warning": runtime_warning} if runtime_warning else {}),
        }, artifacts
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
                    runtime_warning = summary.get("runtime_warning") if isinstance(summary, dict) else None
                    if runtime_warning and runtime_warning not in warnings:
                        warnings.append(str(runtime_warning))
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
