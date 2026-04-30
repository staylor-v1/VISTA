import io

from PIL import Image


def _png_bytes(color=(180, 20, 20)):
    image = Image.new("RGB", (12, 12), color)
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    buf.seek(0)
    return buf


def _create_project_with_part_image(client):
    headers = {"X-User-Id": "analyze-user@example.com", "X-User-Groups": '["analyze-group"]'}
    project_resp = client.post(
        "/api/projects/",
        json={
            "name": "Analyze Project",
            "description": "typed toolbox contract",
            "meta_group_id": "analyze-group",
            "project_type": "PT3",
        },
        headers=headers,
    )
    assert project_resp.status_code == 201, project_resp.text
    project_id = project_resp.json()["id"]

    image_resp = client.post(
        f"/api/projects/{project_id}/images",
        files={"file": ("slice-002.png", _png_bytes(), "image/png")},
        data={"metadata": '{"modality":"ct","slice_index":2,"slice_axis":"axial"}'},
        headers=headers,
    )
    assert image_resp.status_code == 201, image_resp.text
    image = image_resp.json()

    part_resp = client.post(
        f"/api/projects/{project_id}/parts",
        json={
            "serial_number": "AN-001",
            "display_name": "Analyze Part",
            "metadata": {
                "source_images": [
                    {
                        "filename": image["filename"],
                        "image_id": image["id"],
                        "modality": "ct",
                        "slice_axis": "axial",
                        "slice_index": 2,
                    }
                ]
            },
        },
        headers=headers,
    )
    assert part_resp.status_code == 201, part_resp.text
    return headers, project_id, image


def test_analyze_toolbox_manifest_contains_yolov8_and_core_image_methods(client):
    resp = client.get("/api/analyze/toolbox")
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    method_ids = {method["id"] for method in payload["methods"]}
    assert payload["contract_version"] == "vista-analyze.v1"
    assert "ml.yolov8.detect" in method_ids
    assert "ml.yolov8.segment" in method_ids
    assert "output.versioned_image_artifact" in method_ids
    assert "preprocess.window_level_normalization" in method_ids
    assert "segmentation.watershed_seeds" in method_ids
    assert "measure.region_properties" in method_ids


def test_analyze_input_source_defaults_to_loaded_part_images(client):
    headers, project_id, image = _create_project_with_part_image(client)

    resp = client.get(f"/api/projects/{project_id}/analyze/input-source", headers=headers)
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["source"]["kind"] == "project_parts"
    assert payload["source"]["part_count"] == 1
    assert payload["source"]["image_count"] == 1
    assert payload["parts"][0]["serial_number"] == "AN-001"
    assert payload["images"][0]["image_id"] == image["id"]
    assert payload["images"][0]["slice_index"] == 2


def test_analyze_workflow_validation_and_execution_use_pydantic_contract(client):
    headers, project_id, _image = _create_project_with_part_image(client)
    source_resp = client.get(f"/api/projects/{project_id}/analyze/input-source", headers=headers)
    source = source_resp.json()["source"]
    workflow = {
        "name": "QA workflow",
        "source": source,
        "nodes": [
            {"id": "input", "method_id": "source.project_part_images", "label": "Input", "parameters": {}},
            {
                "id": "window",
                "method_id": "preprocess.window_level_normalization",
                "label": "Window",
                "parameters": {"window": 300, "level": 30, "clip": True},
            },
            {
                "id": "yolo",
                "method_id": "ml.yolov8.detect",
                "label": "YOLOv8",
                "parameters": {"model": "yolov8n.pt", "confidence": 0.25},
            },
            {
                "id": "output",
                "method_id": "output.versioned_image_artifact",
                "label": "Versioned Output",
                "parameters": {
                    "mode": "versioned_image",
                    "version_strategy": "append_vn",
                    "preserve_original": True,
                    "overlay_metadata": True,
                    "measurement_table": True,
                },
            },
        ],
        "edges": [
            {"source_node": "input", "target_node": "window"},
            {"source_node": "window", "target_node": "yolo"},
            {"source_node": "yolo", "target_node": "output"},
        ],
        "output": {
            "mode": "versioned_image",
            "version_strategy": "append_vn",
            "preserve_original": True,
            "overlay_metadata": True,
            "measurement_table": True,
        },
    }

    validate_resp = client.post(f"/api/projects/{project_id}/analyze/workflows/validate", json=workflow, headers=headers)
    assert validate_resp.status_code == 200, validate_resp.text
    assert validate_resp.json()["status"] == "validated"
    assert len(validate_resp.json()["node_results"]) == 4

    execute_resp = client.post(f"/api/projects/{project_id}/analyze/workflows/execute", json=workflow, headers=headers)
    assert execute_resp.status_code == 200, execute_resp.text
    assert execute_resp.json()["status"] == "simulated"
    assert execute_resp.json()["execution_mode"] == "simulation"
    assert execute_resp.json()["image_count"] == 1

    workflow["nodes"][1]["method_id"] = "missing.method"
    reject_resp = client.post(f"/api/projects/{project_id}/analyze/workflows/validate", json=workflow, headers=headers)
    assert reject_resp.status_code == 400
    assert "Unknown toolbox method" in reject_resp.json()["detail"]


def test_analyze_workflow_manual_selection_counts_selected_images(client):
    headers, project_id, image = _create_project_with_part_image(client)
    workflow = {
        "name": "Example workflow",
        "source": {
            "id": "example-selection",
            "label": "Example image",
            "kind": "manual_selection",
            "project_id": project_id,
            "selected_image_ids": [image["id"]],
            "example_image_id": image["id"],
            "image_count": 99,
            "part_count": 99,
        },
        "nodes": [
            {
                "id": "input",
                "method_id": "source.project_part_images",
                "label": "Input",
                "parameters": {"example_image_id": image["id"]},
            },
            {
                "id": "output",
                "method_id": "output.versioned_image_artifact",
                "label": "Versioned Output",
                "parameters": {"mode": "overlay_metadata", "version_strategy": "append_vn"},
            },
        ],
        "edges": [{"source_node": "input", "target_node": "output"}],
        "output": {"mode": "overlay_metadata", "version_strategy": "append_vn"},
    }
    resp = client.post(f"/api/projects/{project_id}/analyze/workflows/execute", json=workflow, headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "simulated"
    assert resp.json()["image_count"] == 1


def test_analyze_workflow_uses_server_source_counts_and_rejects_cross_project_source(client):
    headers, project_id, _image = _create_project_with_part_image(client)
    workflow = {
        "name": "Mismatched source workflow",
        "source": {
            "id": "all-loaded-part-images",
            "label": "All images from loaded parts",
            "kind": "project_parts",
            "project_id": project_id,
            "image_count": 9999,
            "part_count": 9999,
        },
        "nodes": [{"id": "input", "method_id": "source.project_part_images", "label": "Input", "parameters": {}}],
        "edges": [],
    }
    resp = client.post(f"/api/projects/{project_id}/analyze/workflows/validate", json=workflow, headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["image_count"] == 1

    workflow["source"]["project_id"] = "00000000-0000-0000-0000-000000000000"
    mismatch_resp = client.post(f"/api/projects/{project_id}/analyze/workflows/validate", json=workflow, headers=headers)
    assert mismatch_resp.status_code == 400
    assert "does not match" in mismatch_resp.json()["detail"]


def test_analyze_input_source_skips_stale_filename_only_sources(client):
    headers = {"X-User-Id": "analyze-stale@example.com", "X-User-Groups": '["analyze-stale"]'}
    project_resp = client.post(
        "/api/projects/",
        json={
            "name": "Analyze Stale Project",
            "description": "stale source refs",
            "meta_group_id": "analyze-stale",
            "project_type": "PT1",
        },
        headers=headers,
    )
    assert project_resp.status_code == 201, project_resp.text
    project_id = project_resp.json()["id"]
    part_resp = client.post(
        f"/api/projects/{project_id}/parts",
        json={
            "serial_number": "STALE-001",
            "metadata": {"source_images": [{"filename": "missing.png", "modality": "visible"}]},
        },
        headers=headers,
    )
    assert part_resp.status_code == 201, part_resp.text

    source_resp = client.get(f"/api/projects/{project_id}/analyze/input-source", headers=headers)
    assert source_resp.status_code == 200, source_resp.text
    assert source_resp.json()["source"]["part_count"] == 1
    assert source_resp.json()["source"]["image_count"] == 0
    assert source_resp.json()["images"] == []
