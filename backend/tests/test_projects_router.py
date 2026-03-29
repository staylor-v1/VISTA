import uuid
import pytest


def test_projects_list_initially_empty(client):
    r = client.get("/api/projects/")
    assert r.status_code == 200
    assert r.json() == []


def test_create_and_read_project(client):
    payload = {"name": "P1", "description": "d", "meta_group_id": "g1"}
    r = client.post("/api/projects/", json=payload)
    assert r.status_code == 201
    proj = r.json()
    pid = proj["id"]
    r2 = client.get(f"/api/projects/{pid}")
    assert r2.status_code == 200
    assert r2.json()["name"] == "P1"
    assert r2.json()["project_type"] == "PT1"


@pytest.mark.parametrize("project_type", ["PT1", "PT2", "PT3"])
def test_project_type_supports_three_simulated_users_with_progressive_workflows(client, project_type):
    """
    Simulate three users for each project type.
    Each simulated user uses progressively richer synthetic project payloads.
    """
    user_scenarios = [
        {
            "email": f"basic-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-basic-group",
            "name": f"{project_type} Basic Intake",
            "description": "Minimal setup",
        },
        {
            "email": f"intermediate-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-intermediate-group",
            "name": f"{project_type} Intermediate Review",
            "description": "Includes synthetic serials and checkpoints",
        },
        {
            "email": f"advanced-{project_type.lower()}@example.com",
            "group": f"{project_type.lower()}-advanced-group",
            "name": f"{project_type} Advanced Adversarial",
            "description": "High-complexity synthetic payload with edge-case labels",
        },
    ]

    created_ids = []
    for idx, scenario in enumerate(user_scenarios, start=1):
        headers = {
            "X-User-Id": scenario["email"],
            "X-User-Groups": f"[\"{scenario['group']}\"]",
        }
        payload = {
            "name": scenario["name"],
            "description": f"{scenario['description']} :: step-{idx}",
            "meta_group_id": scenario["group"],
            "project_type": project_type,
        }
        create_resp = client.post("/api/projects/", json=payload, headers=headers)
        assert create_resp.status_code == 201, create_resp.text
        project = create_resp.json()
        created_ids.append(project["id"])
        assert project["project_type"] == project_type
        assert project["meta_group_id"] == scenario["group"]

        read_resp = client.get(f"/api/projects/{project['id']}", headers=headers)
        assert read_resp.status_code == 200
        assert read_resp.json()["project_type"] == project_type

    for scenario in user_scenarios:
        headers = {
            "X-User-Id": scenario["email"],
            "X-User-Groups": f"[\"{scenario['group']}\"]",
        }
        list_resp = client.get("/api/projects/", headers=headers)
        assert list_resp.status_code == 200
        listed_types = {proj["project_type"] for proj in list_resp.json()}
        assert project_type in listed_types


def test_project_type_validation_rejects_unknown_values(client):
    payload = {
        "name": "Bad Type",
        "description": "invalid",
        "meta_group_id": "bad-group",
        "project_type": "PT9",
    }
    resp = client.post("/api/projects/", json=payload)
    assert resp.status_code == 422


def test_update_project_allows_editing_name_and_project_type(client):
    create_payload = {
        "name": "Test PT2",
        "description": "before",
        "meta_group_id": "g-edit",
        "project_type": "PT2",
    }
    create_resp = client.post("/api/projects/", json=create_payload)
    assert create_resp.status_code == 201, create_resp.text
    project = create_resp.json()
    assert project["project_type"] == "PT2"

    update_resp = client.put(
        f"/api/projects/{project['id']}",
        json={"name": "Test PT2 Edited", "project_type": "PT3"},
    )
    assert update_resp.status_code == 200, update_resp.text
    updated = update_resp.json()
    assert updated["name"] == "Test PT2 Edited"
    assert updated["project_type"] == "PT3"

    read_resp = client.get(f"/api/projects/{project['id']}")
    assert read_resp.status_code == 200
    assert read_resp.json()["project_type"] == "PT3"
