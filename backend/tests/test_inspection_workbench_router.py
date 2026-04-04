import pytest


@pytest.mark.parametrize("project_type", ["PT1", "PT2", "PT3"])
def test_batches_and_parts_support_three_simulated_users_with_progressive_workflows(client, project_type):
    """
    For each project type, simulate three users with progressively more complex synthetic
    workflows that create batches and parts, then verify filtered list behavior.
    """
    scenarios = [
        {
            "email": f"basic-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-ops-basic",
            "project_name": f"{project_type} basic project",
            "batches": [{"name": "batch-basic", "description": "single intake batch"}],
            "parts": [
                {
                    "serial_number": f"{project_type}-BASIC-0001",
                    "display_name": "basic-part",
                    "metadata": {"angle": "front", "synthetic_level": 1},
                }
            ],
        },
        {
            "email": f"intermediate-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-ops-intermediate",
            "project_name": f"{project_type} intermediate project",
            "batches": [
                {"name": "batch-incoming", "description": "incoming line"},
                {"name": "batch-recheck", "description": "follow-up checks"},
            ],
            "parts": [
                {
                    "serial_number": f"{project_type}-MID-0101",
                    "display_name": "mid-front",
                    "metadata": {"angle": "front", "synthetic_level": 2, "defect_hint": "scratch"},
                },
                {
                    "serial_number": f"{project_type}-MID-0102",
                    "display_name": "mid-back",
                    "metadata": {"angle": "back", "synthetic_level": 2, "checkpoint": "qa-pass-1"},
                },
            ],
        },
        {
            "email": f"advanced-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-ops-advanced",
            "project_name": f"{project_type} advanced project",
            "batches": [
                {"name": "batch-stress-a", "description": "high-volume synthetic set"},
                {"name": "batch-stress-b", "description": "adversarial synthetic set"},
            ],
            "parts": [
                {
                    "serial_number": f"{project_type}-ADV-9001",
                    "display_name": "adv-left",
                    "metadata": {"angle": "left", "synthetic_level": 3, "nested": {"severity": "high"}},
                },
                {
                    "serial_number": f"{project_type}-ADV-9002",
                    "display_name": "adv-right",
                    "metadata": {"angle": "right", "synthetic_level": 3, "workflow_stage": "triage"},
                },
                {
                    "serial_number": f"{project_type}-ADV-9003",
                    "display_name": "adv-top",
                    "metadata": {"angle": "top", "synthetic_level": 3, "workflow_stage": "review"},
                },
            ],
        },
    ]

    for scenario in scenarios:
        headers = {
            "X-User-Id": scenario["email"],
            "X-User-Groups": f"[\"{scenario['group']}\"]",
        }

        project_payload = {
            "name": scenario["project_name"],
            "description": "inspection workbench synthetic workflow",
            "meta_group_id": scenario["group"],
            "project_type": project_type,
        }
        project_resp = client.post("/api/projects/", json=project_payload, headers=headers)
        assert project_resp.status_code == 201, project_resp.text
        project_id = project_resp.json()["id"]

        created_batches = []
        for batch_payload in scenario["batches"]:
            batch_resp = client.post(
                f"/api/projects/{project_id}/batches",
                json=batch_payload,
                headers=headers,
            )
            assert batch_resp.status_code == 201, batch_resp.text
            created_batches.append(batch_resp.json())

        list_batches_resp = client.get(f"/api/projects/{project_id}/batches", headers=headers)
        assert list_batches_resp.status_code == 200
        assert len(list_batches_resp.json()) == len(scenario["batches"])

        first_batch_id = created_batches[0]["id"]
        for idx, part_payload in enumerate(scenario["parts"]):
            payload = {
                **part_payload,
                "batch_id": first_batch_id,
                "review_state": "in_review" if idx else "unreviewed",
            }
            part_resp = client.post(
                f"/api/projects/{project_id}/parts",
                json=payload,
                headers=headers,
            )
            assert part_resp.status_code == 201, part_resp.text
            assert part_resp.json()["serial_number"] == part_payload["serial_number"]
            assert part_resp.json()["batch_id"] == first_batch_id

        list_parts_resp = client.get(f"/api/projects/{project_id}/parts", headers=headers)
        assert list_parts_resp.status_code == 200
        assert len(list_parts_resp.json()) == len(scenario["parts"])

        filtered_parts_resp = client.get(
            f"/api/projects/{project_id}/parts?batch_id={first_batch_id}",
            headers=headers,
        )
        assert filtered_parts_resp.status_code == 200
        assert len(filtered_parts_resp.json()) == len(scenario["parts"])


def test_create_part_rejects_batch_from_other_project(client):
    headers = {"X-User-Id": "cross-project@example.com", "X-User-Groups": '["cross-group"]'}

    project_payload = {
        "name": "Cross project parent",
        "description": "parent",
        "meta_group_id": "cross-group",
        "project_type": "PT1",
    }
    project_a = client.post("/api/projects/", json=project_payload, headers=headers)
    assert project_a.status_code == 201

    project_payload["name"] = "Cross project child"
    project_b = client.post("/api/projects/", json=project_payload, headers=headers)
    assert project_b.status_code == 201

    batch_resp = client.post(
        f"/api/projects/{project_a.json()['id']}/batches",
        json={"name": "batch-a", "description": "owned by project A"},
        headers=headers,
    )
    assert batch_resp.status_code == 201

    part_resp = client.post(
        f"/api/projects/{project_b.json()['id']}/parts",
        json={
            "serial_number": "PT1-CROSS-0001",
            "display_name": "invalid-link",
            "batch_id": batch_resp.json()["id"],
        },
        headers=headers,
    )
    assert part_resp.status_code == 400
    assert "does not belong" in part_resp.json()["detail"]


@pytest.mark.parametrize("project_type", ["PT1", "PT2", "PT3"])
def test_part_review_workflow_supports_three_simulated_users_with_progressive_data(client, project_type):
    scenarios = [
        {
            "email": f"review-basic-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-review-basic",
            "parts": [{"serial_number": f"{project_type}-RB-0001", "display_name": "rb-1"}],
            "target_state": "in_review",
        },
        {
            "email": f"review-intermediate-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-review-intermediate",
            "parts": [
                {"serial_number": f"{project_type}-RI-0101", "display_name": "ri-1"},
                {"serial_number": f"{project_type}-RI-0102", "display_name": "ri-2"},
            ],
            "target_state": "reject_pending",
        },
        {
            "email": f"review-advanced-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-review-advanced",
            "parts": [
                {"serial_number": f"{project_type}-RA-9001", "display_name": "ra-1"},
                {"serial_number": f"{project_type}-RA-9002", "display_name": "ra-2"},
                {"serial_number": f"{project_type}-RA-9003", "display_name": "ra-3"},
            ],
            "target_state": "pass",
        },
    ]

    for scenario in scenarios:
        headers = {
            "X-User-Id": scenario["email"],
            "X-User-Groups": f"[\"{scenario['group']}\"]",
        }
        project_resp = client.post(
            "/api/projects/",
            json={
                "name": f"{project_type} review workflow {scenario['group']}",
                "description": "workflow project",
                "meta_group_id": scenario["group"],
                "project_type": project_type,
            },
            headers=headers,
        )
        assert project_resp.status_code == 201, project_resp.text
        project_id = project_resp.json()["id"]

        batch_resp = client.post(
            f"/api/projects/{project_id}/batches",
            json={"name": "review-batch", "description": "review batch"},
            headers=headers,
        )
        assert batch_resp.status_code == 201
        batch_id = batch_resp.json()["id"]

        created_parts = []
        for part in scenario["parts"]:
            part_resp = client.post(
                f"/api/projects/{project_id}/parts",
                json={**part, "batch_id": batch_id, "review_state": "unreviewed"},
                headers=headers,
            )
            assert part_resp.status_code == 201, part_resp.text
            created_parts.append(part_resp.json())

        target_part = created_parts[-1]
        update_resp = client.patch(
            f"/api/projects/{project_id}/parts/{target_part['id']}",
            json={"review_state": scenario["target_state"]},
            headers=headers,
        )
        assert update_resp.status_code == 200, update_resp.text
        assert update_resp.json()["review_state"] == scenario["target_state"]

        filtered_resp = client.get(
            f"/api/projects/{project_id}/parts?review_state={scenario['target_state']}",
            headers=headers,
        )
        assert filtered_resp.status_code == 200
        filtered = filtered_resp.json()
        assert len(filtered) == 1
        assert filtered[0]["id"] == target_part["id"]


@pytest.mark.parametrize("project_type", ["PT1", "PT2", "PT3"])
def test_segmentation_and_measurement_invocation_supports_progressive_users(client, project_type):
    scenarios = [
        {"email": f"ml-basic-{project_type.lower()}@example.com", "group": f"{project_type.lower()}-ml-basic", "synthetic_level": 1},
        {"email": f"ml-intermediate-{project_type.lower()}@example.com", "group": f"{project_type.lower()}-ml-intermediate", "synthetic_level": 2},
        {"email": f"ml-advanced-{project_type.lower()}@example.com", "group": f"{project_type.lower()}-ml-advanced", "synthetic_level": 3},
    ]

    for scenario in scenarios:
        headers = {
            "X-User-Id": scenario["email"],
            "X-User-Groups": f"[\"{scenario['group']}\"]",
        }
        project_resp = client.post(
            "/api/projects/",
            json={
                "name": f"{project_type} ml workflow {scenario['group']}",
                "description": "ml invocation workflow",
                "meta_group_id": scenario["group"],
                "project_type": project_type,
            },
            headers=headers,
        )
        assert project_resp.status_code == 201, project_resp.text
        project_id = project_resp.json()["id"]

        batch_resp = client.post(
            f"/api/projects/{project_id}/batches",
            json={"name": "ml-batch", "description": "ml test batch"},
            headers=headers,
        )
        assert batch_resp.status_code == 201, batch_resp.text

        part_resp = client.post(
            f"/api/projects/{project_id}/parts",
            json={
                "serial_number": f"{project_type}-ML-{scenario['synthetic_level']}",
                "display_name": f"ml-part-{scenario['synthetic_level']}",
                "batch_id": batch_resp.json()["id"],
                "metadata": {"synthetic_level": scenario["synthetic_level"]},
            },
            headers=headers,
        )
        assert part_resp.status_code == 201, part_resp.text
        part_id = part_resp.json()["id"]

        segmentation_resp = client.post(
            f"/api/projects/{project_id}/parts/{part_id}/segmentation-runs",
            json={"axis": "axial", "slice_index": scenario["synthetic_level"]},
            headers=headers,
        )
        assert segmentation_resp.status_code == 202, segmentation_resp.text
        segmentation = segmentation_resp.json()
        assert segmentation["status"] == "completed"
        assert segmentation["axis"] == "axial"
        assert segmentation["overlay_id"] == f"segmentation-axial-{scenario['synthetic_level']}"

        measurement_resp = client.post(
            f"/api/projects/{project_id}/parts/{part_id}/measurement-runs",
            json={"measurement_profile": "workbench-default", "include_overlays": [segmentation["overlay_id"]]},
            headers=headers,
        )
        assert measurement_resp.status_code == 202, measurement_resp.text
        measurement = measurement_resp.json()
        assert measurement["status"] == "completed"
        assert measurement["measurement_profile"] == "workbench-default"
        assert measurement["units"] == "mm"
        assert measurement["values"]["crack_length_mm"] > 0

        listed_parts = client.get(f"/api/projects/{project_id}/parts", headers=headers)
        assert listed_parts.status_code == 200, listed_parts.text
        persisted_part = listed_parts.json()[0]
        assert len(persisted_part["metadata"]["segmentation_runs"]) == 1
        assert len(persisted_part["metadata"]["measurement_runs"]) == 1


@pytest.mark.parametrize("project_type", ["PT1", "PT2", "PT3"])
def test_workspace_state_persistence_supports_progressive_users(client, project_type):
    scenarios = [
        {
            "email": f"workspace-basic-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-workspace-basic",
            "state": {
                "selected_batch_id": "batch-basic",
                "defect_filter": "all",
                "sort_mode": "defect_desc",
                "inspector": {
                    "shortcut_help_visible": False,
                    "normalization_triage_field": "",
                    "image_enabled": True,
                    "modalities": ["visual"],
                    "view_name": "front",
                    "viewport_transform": {"zoom": 1.2, "panX": 14, "panY": -10},
                },
                "panel_layout": {
                    "part_list": {"is_open": True, "width_px": 310, "height_px": 420, "orientation": "vertical"},
                    "inspector": {"is_open": True, "width_px": 355, "height_px": 420, "orientation": "horizontal"},
                    "mpr_controls": {"is_open": False, "width_px": 330, "height_px": 350, "orientation": "vertical"},
                },
            },
        },
        {
            "email": f"workspace-intermediate-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-workspace-intermediate",
            "state": {
                "selected_batch_id": "batch-mid-a",
                "defect_filter": "has_defects",
                "sort_mode": "serial_asc",
                "selected_part_id": "part-mid-1",
                "inspector": {
                    "shortcut_help_visible": True,
                    "normalization_triage_field": "segmentation_runs",
                    "image_enabled": False,
                    "modalities": ["infrared", "uv"],
                    "view_name": "left",
                    "viewport_transform": {"zoom": 2.6, "panX": -40, "panY": 85},
                },
                "panel_layout": {
                    "part_list": {"is_open": True, "width_px": 360, "height_px": 500, "orientation": "vertical"},
                    "inspector": {"is_open": False, "width_px": 420, "height_px": 510, "orientation": "horizontal"},
                    "mpr_controls": {"is_open": True, "width_px": 400, "height_px": 380, "orientation": "horizontal"},
                },
            },
        },
        {
            "email": f"workspace-advanced-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-workspace-advanced",
            "state": {
                "selected_batch_id": "batch-adv-a",
                "defect_filter": "critical_only",
                "sort_mode": "defect_desc",
                "selected_part_id": "part-adv-1",
                "mpr": {
                    "slice_position": {"axial": 9, "coronal": 7, "sagittal": 5},
                    "viewport_transform": {"zoom": 1.3, "panX": 12, "panY": -8},
                    "contrast_percent": 112,
                    "active_overlay_ids": ["segmentation", "porosity"],
                    "cursor_probe": {"x": 67, "y": 42},
                },
                "inspector": {
                    "shortcut_help_visible": "yes",
                    "normalization_triage_field": 42,
                    "image_enabled": "no",
                    "modalities": "not-a-list",
                    "view_name": 99,
                    "viewport_transform": {"zoom": "fast", "panX": 999, "panY": -999},
                },
                "panel_layout": {
                    "part_list": {"is_open": "yes", "width_px": -15, "height_px": 9999, "orientation": "diagonal"},
                    "inspector": {"is_open": True, "width_px": 260, "height_px": 460, "orientation": "vertical"},
                    "mpr_controls": {"is_open": True, "width_px": "400", "height_px": "420", "orientation": "horizontal"},
                },
            },
            "expected_panel_layout": {
                "part_list": {"is_open": True, "width_px": 220, "height_px": 1400, "orientation": "vertical"},
                "inspector": {"is_open": True, "width_px": 260, "height_px": 460, "orientation": "vertical"},
                "mpr_controls": {"is_open": True, "width_px": 400, "height_px": 420, "orientation": "horizontal"},
            },
            "expected_shortcut_help_visible": False,
            "expected_normalization_triage_field": "",
            "expected_image_enabled": True,
            "expected_modalities": [],
            "expected_view_name": "",
            "expected_viewport_transform": {"zoom": 1.0, "panX": 200, "panY": -200},
        },
    ]

    for scenario in scenarios:
        headers = {
            "X-User-Id": scenario["email"],
            "X-User-Groups": f"[\"{scenario['group']}\"]",
        }
        project_resp = client.post(
            "/api/projects/",
            json={
                "name": f"{project_type} workspace {scenario['group']}",
                "description": "workspace persistence workflow",
                "meta_group_id": scenario["group"],
                "project_type": project_type,
            },
            headers=headers,
        )
        assert project_resp.status_code == 201, project_resp.text
        project_id = project_resp.json()["id"]

        initial_resp = client.get(f"/api/projects/{project_id}/workspace-state", headers=headers)
        assert initial_resp.status_code == 200, initial_resp.text
        assert initial_resp.json()["state"]["panel_layout"] == {
            "part_list": {"is_open": True, "width_px": 320, "height_px": 420, "orientation": "vertical"},
            "inspector": {"is_open": True, "width_px": 360, "height_px": 420, "orientation": "vertical"},
            "mpr_controls": {"is_open": True, "width_px": 360, "height_px": 360, "orientation": "vertical"},
        }

        save_resp = client.put(
            f"/api/projects/{project_id}/workspace-state",
            json={"state": scenario["state"]},
            headers=headers,
        )
        assert save_resp.status_code == 200, save_resp.text
        expected_panel_layout = scenario.get("expected_panel_layout", scenario["state"]["panel_layout"])
        assert save_resp.json()["state"]["panel_layout"] == expected_panel_layout
        expected_shortcut_help_visible = scenario.get(
            "expected_shortcut_help_visible",
            scenario["state"].get("inspector", {}).get("shortcut_help_visible"),
        )
        expected_normalization_triage_field = scenario.get(
            "expected_normalization_triage_field",
            scenario["state"].get("inspector", {}).get("normalization_triage_field", ""),
        )
        expected_image_enabled = scenario.get(
            "expected_image_enabled",
            scenario["state"].get("inspector", {}).get("image_enabled", True),
        )
        assert save_resp.json()["state"]["inspector"]["shortcut_help_visible"] == expected_shortcut_help_visible
        assert save_resp.json()["state"]["inspector"]["normalization_triage_field"] == expected_normalization_triage_field
        assert save_resp.json()["state"]["inspector"]["image_enabled"] == expected_image_enabled
        expected_modalities = scenario.get(
            "expected_modalities",
            scenario["state"].get("inspector", {}).get("modalities", []),
        )
        expected_view_name = scenario.get(
            "expected_view_name",
            scenario["state"].get("inspector", {}).get("view_name", ""),
        )
        expected_viewport_transform = scenario.get(
            "expected_viewport_transform",
            scenario["state"].get("inspector", {}).get("viewport_transform", {"zoom": 1.0, "panX": 0, "panY": 0}),
        )
        assert save_resp.json()["state"]["inspector"]["modalities"] == expected_modalities
        assert save_resp.json()["state"]["inspector"]["view_name"] == expected_view_name
        assert save_resp.json()["state"]["inspector"]["viewport_transform"] == expected_viewport_transform

        reload_resp = client.get(f"/api/projects/{project_id}/workspace-state", headers=headers)
        assert reload_resp.status_code == 200, reload_resp.text
        assert reload_resp.json()["state"]["panel_layout"] == expected_panel_layout
        assert reload_resp.json()["state"]["inspector"]["shortcut_help_visible"] == expected_shortcut_help_visible
        assert reload_resp.json()["state"]["inspector"]["normalization_triage_field"] == expected_normalization_triage_field
        assert reload_resp.json()["state"]["inspector"]["image_enabled"] == expected_image_enabled
        assert reload_resp.json()["state"]["inspector"]["modalities"] == expected_modalities
        assert reload_resp.json()["state"]["inspector"]["view_name"] == expected_view_name
        assert reload_resp.json()["state"]["inspector"]["viewport_transform"] == expected_viewport_transform

        update_payload = {**scenario["state"], "sort_mode": "serial_asc"}
        overwrite_resp = client.put(
            f"/api/projects/{project_id}/workspace-state",
            json={"state": update_payload},
            headers=headers,
        )
        assert overwrite_resp.status_code == 200, overwrite_resp.text
        assert overwrite_resp.json()["state"]["sort_mode"] == "serial_asc"
        assert overwrite_resp.json()["state"]["panel_layout"] == expected_panel_layout


@pytest.mark.parametrize("project_type", ["PT1", "PT2", "PT3"])
def test_part_annotations_support_progressive_users_with_audit_trail(client, project_type):
    scenarios = [
        {
            "email": f"annot-basic-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-annot-basic",
            "part_suffix": "001",
            "annotation": {
                "defect_class": "scratch",
                "modality": "visual",
                "comment": "baseline visible scratch",
                "disposition": "open",
                "measurements": {"length_mm": 3.2},
                "bbox": {"x": 10.0, "y": 14.0, "width": 22.0, "height": 8.0},
            },
        },
        {
            "email": f"annot-intermediate-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-annot-intermediate",
            "part_suffix": "010",
            "annotation": {
                "defect_class": "void_cluster",
                "modality": "infrared",
                "comment": "cluster detected in two adjacent regions",
                "disposition": "needs_info",
                "measurements": {"area_mm2": 5.5, "diameter_mm": 2.1},
                "bbox": {"x": 20.0, "y": 26.0, "width": 35.0, "height": 16.0},
            },
        },
        {
            "email": f"annot-advanced-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-annot-advanced",
            "part_suffix": "900",
            "annotation": {
                "defect_class": "delamination",
                "modality": "uv",
                "comment": "multi-zone delamination requiring disposition update",
                "disposition": "open",
                "measurements": {"length_mm": 19.4, "depth_mm": 1.8, "area_mm2": 22.0},
                "bbox": {"x": 45.0, "y": 52.0, "width": 60.0, "height": 24.0},
            },
        },
    ]

    for scenario in scenarios:
        headers = {
            "X-User-Id": scenario["email"],
            "X-User-Groups": f"[\"{scenario['group']}\"]",
        }
        project_resp = client.post(
            "/api/projects/",
            json={
                "name": f"{project_type} annotation workflow {scenario['group']}",
                "description": "annotation + audit metadata workflow",
                "meta_group_id": scenario["group"],
                "project_type": project_type,
            },
            headers=headers,
        )
        assert project_resp.status_code == 201, project_resp.text
        project_id = project_resp.json()["id"]

        batch_resp = client.post(
            f"/api/projects/{project_id}/batches",
            json={"name": "annotation-batch", "description": "annotation test batch"},
            headers=headers,
        )
        assert batch_resp.status_code == 201, batch_resp.text

        part_resp = client.post(
            f"/api/projects/{project_id}/parts",
            json={
                "serial_number": f"{project_type}-ANNOT-{scenario['part_suffix']}",
                "display_name": f"annot-part-{scenario['part_suffix']}",
                "batch_id": batch_resp.json()["id"],
            },
            headers=headers,
        )
        assert part_resp.status_code == 201, part_resp.text
        part_id = part_resp.json()["id"]

        create_resp = client.post(
            f"/api/projects/{project_id}/parts/{part_id}/annotations",
            json=scenario["annotation"],
            headers=headers,
        )
        assert create_resp.status_code == 201, create_resp.text
        created_annotation = create_resp.json()
        assert created_annotation["defect_class"] == scenario["annotation"]["defect_class"]
        assert created_annotation["modality"] == scenario["annotation"]["modality"]
        assert created_annotation["hidden"] is False
        assert isinstance(created_annotation["created_by"], str)
        assert "@" in created_annotation["created_by"]
        assert created_annotation["updated_by"] == created_annotation["created_by"]
        assert created_annotation["created_at"]
        assert created_annotation["updated_at"]

        annotation_id = created_annotation["id"]
        update_resp = client.patch(
            f"/api/projects/{project_id}/parts/{part_id}/annotations/{annotation_id}",
            json={
                "disposition": "accepted",
                "comment": f"{scenario['annotation']['comment']} [reviewed]",
                "hidden": True,
            },
            headers=headers,
        )
        assert update_resp.status_code == 200, update_resp.text
        updated_annotation = update_resp.json()
        assert updated_annotation["disposition"] == "accepted"
        assert updated_annotation["hidden"] is True
        assert updated_annotation["updated_by"] == created_annotation["created_by"]
        assert updated_annotation["updated_at"] >= updated_annotation["created_at"]

        visible_list_resp = client.get(
            f"/api/projects/{project_id}/parts/{part_id}/annotations?include_hidden=false",
            headers=headers,
        )
        assert visible_list_resp.status_code == 200, visible_list_resp.text
        assert visible_list_resp.json()["annotations"] == []

        full_list_resp = client.get(
            f"/api/projects/{project_id}/parts/{part_id}/annotations",
            headers=headers,
        )
        assert full_list_resp.status_code == 200, full_list_resp.text
        returned_annotations = full_list_resp.json()["annotations"]
        assert len(returned_annotations) == 1
        assert returned_annotations[0]["id"] == annotation_id
        assert returned_annotations[0]["hidden"] is True


@pytest.mark.parametrize("project_type", ["PT1", "PT2", "PT3"])
def test_project_configuration_round_trip_supports_progressive_users(client, project_type):
    scenarios = [
        {
            "email": f"config-basic-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-config-basic",
            "payload": {
                "image_modalities": [
                    {
                        "id": "visual",
                        "label": "Visual",
                        "calibration_required": False,
                        "example_image_uploaded": False,
                    }
                ],
                "part_views": [
                    {"id": "front", "label": "Front", "required_modalities": ["visual"], "source": "manual"}
                ],
                "defect_types": [
                    {"name": "scratch", "color": "#ef4444", "definition": "Linear visible surface scratch"}
                ],
                "process_settings": {
                    "require_disposition_on_submit": True,
                    "require_measurement_for_critical": False,
                    "require_second_reviewer_for_reject": False,
                    "configurable_hotkeys": {
                        "accept_classification": "a",
                        "reject_classification": "r",
                        "toggle_shortcut_help": "h",
                    },
                },
                "display_settings": {
                    "default_colormap": "grayscale",
                    "anomaly_colormap": "viridis",
                    "grayscale_base_image": True,
                },
            },
        },
        {
            "email": f"config-intermediate-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-config-intermediate",
            "payload": {
                "image_modalities": [
                    {
                        "id": "visual",
                        "label": "Visual",
                        "calibration_required": False,
                        "example_image_uploaded": True,
                    },
                    {
                        "id": "infrared",
                        "label": "Infrared",
                        "calibration_required": True,
                        "example_image_uploaded": False,
                    },
                ],
                "part_views": [
                    {
                        "id": "front",
                        "label": "Front",
                        "required_modalities": ["visual", "infrared"],
                        "source": "manual",
                    },
                    {"id": "top", "label": "Top", "required_modalities": ["visual"], "source": "auto"},
                ],
                "defect_types": [
                    {"name": "void_cluster", "color": "#8b5cf6", "definition": "Cluster of internal voids"},
                    {"name": "inclusion", "color": "#f59e0b", "definition": "Foreign inclusion in substrate"},
                ],
                "process_settings": {
                    "require_disposition_on_submit": True,
                    "require_measurement_for_critical": True,
                    "require_second_reviewer_for_reject": False,
                    "configurable_hotkeys": {
                        "accept_classification": "s",
                        "reject_classification": "d",
                        "toggle_shortcut_help": "f",
                    },
                },
                "display_settings": {
                    "default_colormap": "grayscale",
                    "anomaly_colormap": "magma",
                    "grayscale_base_image": True,
                },
            },
        },
        {
            "email": f"config-advanced-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-config-advanced",
            "payload": {
                "image_modalities": [
                    {
                        "id": "visual",
                        "label": "Visual",
                        "calibration_required": False,
                        "example_image_uploaded": True,
                    },
                    {
                        "id": "infrared",
                        "label": "Infrared",
                        "calibration_required": True,
                        "example_image_uploaded": True,
                    },
                    {
                        "id": "uv",
                        "label": "UV",
                        "calibration_required": True,
                        "example_image_uploaded": True,
                    },
                ],
                "part_views": [
                    {
                        "id": "front",
                        "label": "Front",
                        "required_modalities": ["visual", "infrared", "uv"],
                        "source": "manual",
                    },
                    {
                        "id": "sagittal",
                        "label": "Sagittal",
                        "required_modalities": ["infrared", "uv"],
                        "source": "auto",
                    },
                    {"id": "axial", "label": "Axial", "required_modalities": ["uv"], "source": "auto"},
                ],
                "defect_types": [
                    {"name": "delamination", "color": "#dc2626", "definition": "Layer separation"},
                    {"name": "porosity", "color": "#0284c7", "definition": "Distributed pore network"},
                    {"name": "burn_through", "color": "#7c3aed", "definition": "Material burn-through"},
                ],
                "process_settings": {
                    "require_disposition_on_submit": True,
                    "require_measurement_for_critical": True,
                    "require_second_reviewer_for_reject": True,
                    "configurable_hotkeys": {
                        "accept_classification": "z",
                        "reject_classification": "x",
                        "toggle_shortcut_help": "c",
                    },
                },
                "display_settings": {
                    "default_colormap": "grayscale",
                    "anomaly_colormap": "turbo",
                    "grayscale_base_image": False,
                },
            },
        },
    ]

    for scenario in scenarios:
        headers = {
            "X-User-Id": scenario["email"],
            "X-User-Groups": f"[\"{scenario['group']}\"]",
        }
        project_resp = client.post(
            "/api/projects/",
            json={
                "name": f"{project_type} config workflow {scenario['group']}",
                "description": "project configuration workflow",
                "meta_group_id": scenario["group"],
                "project_type": project_type,
            },
            headers=headers,
        )
        assert project_resp.status_code == 201, project_resp.text
        project_id = project_resp.json()["id"]

        initial_resp = client.get(f"/api/projects/{project_id}/configuration", headers=headers)
        assert initial_resp.status_code == 200, initial_resp.text
        initial_config = initial_resp.json()["config"]
        assert "image_modalities" in initial_config
        assert "part_views" in initial_config
        assert "defect_types" in initial_config

        save_resp = client.put(
            f"/api/projects/{project_id}/configuration",
            json={"config": scenario["payload"]},
            headers=headers,
        )
        assert save_resp.status_code == 200, save_resp.text
        assert save_resp.json()["config"] == scenario["payload"]

        reload_resp = client.get(f"/api/projects/{project_id}/configuration", headers=headers)
        assert reload_resp.status_code == 200, reload_resp.text
        assert reload_resp.json()["config"] == scenario["payload"]


@pytest.mark.parametrize("project_type", ["PT1", "PT2", "PT3"])
def test_project_configuration_rejects_invalid_hotkeys(client, project_type):
    headers = {
        "X-User-Id": f"config-hotkey-invalid-{project_type.lower()}@example.com",
        "X-User-Groups": f"[\"{project_type.lower()}-config-hotkey-invalid\"]",
    }
    project_resp = client.post(
        "/api/projects/",
        json={
            "name": f"{project_type} config hotkey invalid",
            "description": "project configuration hotkey validation",
            "meta_group_id": f"{project_type.lower()}-config-hotkey-invalid",
            "project_type": project_type,
        },
        headers=headers,
    )
    assert project_resp.status_code == 201, project_resp.text
    project_id = project_resp.json()["id"]

    invalid_payload = {
        "image_modalities": [],
        "part_views": [],
        "defect_types": [],
        "process_settings": {
            "require_disposition_on_submit": True,
            "require_measurement_for_critical": False,
            "require_second_reviewer_for_reject": False,
            "configurable_hotkeys": {
                "accept_classification": "ab",
                "reject_classification": "r",
                "toggle_shortcut_help": "h",
            },
        },
        "display_settings": {
            "default_colormap": "grayscale",
            "anomaly_colormap": "viridis",
            "grayscale_base_image": True,
        },
    }

    save_resp = client.put(
        f"/api/projects/{project_id}/configuration",
        json={"config": invalid_payload},
        headers=headers,
    )
    assert save_resp.status_code == 422, save_resp.text


@pytest.mark.parametrize("project_type", ["PT1", "PT2", "PT3"])
def test_bulk_ingest_supports_progressive_users_with_discrepancy_counters(client, project_type):
    scenarios = [
        {
            "name": "basic",
            "group": f"{project_type.lower()}-ingest-basic",
            "payload": {
                "batches": [
                    {
                        "name": "batch-basic-a",
                        "description": "Basic ingest",
                        "parts": [
                            {"serial_number": "SN-BASIC-001", "display_name": "Basic Housing 1"},
                        ],
                    }
                ]
            },
            "expected": {
                "batches_received": 1,
                "parts_received": 1,
                "batches_created": 1,
                "parts_created": 1,
                "parts_skipped_existing": 0,
                "parts_skipped_discrepancy": 0,
            },
        },
        {
            "name": "intermediate",
            "group": f"{project_type.lower()}-ingest-intermediate",
            "payload": {
                "batches": [
                    {
                        "name": "batch-mid-a",
                        "description": "Mid ingest A",
                        "parts": [
                            {"serial_number": "SN-MID-001", "display_name": "Mid Housing 1"},
                            {"serial_number": "SN-MID-002", "display_name": "Mid Housing 2"},
                        ],
                    },
                    {
                        "name": "batch-mid-b",
                        "description": "Mid ingest B",
                        "parts": [
                            {"serial_number": "SN-MID-001", "display_name": "Mid Housing Duplicate"},
                        ],
                    },
                ]
            },
            "expected": {
                "batches_received": 2,
                "parts_received": 3,
                "batches_created": 2,
                "parts_created": 2,
                "parts_skipped_existing": 0,
                "parts_skipped_discrepancy": 1,
            },
            "expected_discrepancy_codes": {"duplicate_serial_in_payload"},
        },
        {
            "name": "advanced",
            "group": f"{project_type.lower()}-ingest-advanced",
            "seed_first": {
                "batches": [
                    {
                        "name": "batch-seed",
                        "description": "Seed",
                        "parts": [
                            {"serial_number": "SN-ADV-EXISTING", "display_name": "Existing Seed Part"},
                            {"serial_number": "SN-ADV-CONFLICT", "display_name": "Conflict Seed Part"},
                        ],
                    }
                ]
            },
            "payload": {
                "batches": [
                    {
                        "name": "batch-seed",
                        "description": "Seed",
                        "parts": [
                            {"serial_number": "SN-ADV-EXISTING", "display_name": "Existing Same Batch"},
                        ],
                    },
                    {
                        "name": "batch-adv-b",
                        "description": "Advanced ingest",
                        "parts": [
                            {"serial_number": "SN-ADV-CONFLICT", "display_name": "Cross-Batch Conflict"},
                            {"serial_number": "SN-ADV-NEW-001", "display_name": "Advanced New Part"},
                        ],
                    },
                ]
            },
            "expected": {
                "batches_received": 2,
                "parts_received": 3,
                "batches_created": 1,
                "parts_created": 1,
                "parts_skipped_existing": 1,
                "parts_skipped_discrepancy": 1,
            },
            "expected_discrepancy_codes": {"serial_already_assigned_to_other_batch"},
        },
    ]

    for scenario in scenarios:
        headers = {
            "X-User-Id": f"{scenario['name']}-{project_type.lower()}@example.com",
            "X-User-Groups": f"[\"{scenario['group']}\"]",
        }
        project_resp = client.post(
            "/api/projects/",
            json={
                "name": f"{project_type} ingest workflow {scenario['name']}",
                "description": "bulk ingest discrepancy workflow",
                "meta_group_id": scenario["group"],
                "project_type": project_type,
            },
            headers=headers,
        )
        assert project_resp.status_code == 201, project_resp.text
        project_id = project_resp.json()["id"]

        if scenario.get("seed_first"):
            seed_resp = client.post(
                f"/api/projects/{project_id}/ingest",
                json=scenario["seed_first"],
                headers=headers,
            )
            assert seed_resp.status_code == 200, seed_resp.text

        ingest_resp = client.post(
            f"/api/projects/{project_id}/ingest",
            json=scenario["payload"],
            headers=headers,
        )
        assert ingest_resp.status_code == 200, ingest_resp.text
        payload = ingest_resp.json()
        assert payload["project_id"] == project_id
        assert payload["counters"] == scenario["expected"]

        expected_codes = scenario.get("expected_discrepancy_codes", set())
        discrepancy_codes = {entry["code"] for entry in payload["discrepancies"]}
        assert discrepancy_codes == expected_codes
