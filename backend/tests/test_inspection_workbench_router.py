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
