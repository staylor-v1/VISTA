"""Tests for the Excel export endpoint."""
import io
import uuid
import pytest
from unittest.mock import patch


@pytest.fixture
def _seed_project_with_images(client):
    """Create a project with images, classifications, and comments for export testing."""
    # Create project
    resp = client.post("/api/projects/", json={
        "name": "Export Test Project",
        "description": "Project for testing Excel export",
        "meta_group_id": "test-group",
    })
    assert resp.status_code == 201, resp.text
    project = resp.json()

    # Create image classes
    class_resp = client.post(f"/api/projects/{project['id']}/classes", json={
        "name": "Defect",
        "description": "Visual defect detected",
        "project_id": project["id"],
    })
    assert class_resp.status_code == 201, class_resp.text
    defect_class = class_resp.json()

    class_resp2 = client.post(f"/api/projects/{project['id']}/classes", json={
        "name": "Scratch",
        "description": "Surface scratch",
        "project_id": project["id"],
    })
    assert class_resp2.status_code == 201, class_resp2.text
    scratch_class = class_resp2.json()

    # Upload images with metadata
    image_ids = []
    for i in range(3):
        metadata = {
            "lot_number": f"LOT-{100 + i}",
            "part_serial_number": f"SN-{2000 + i}",
            "inspection_status": ["Not Reviewed", "Pass", "Reject"][i],
            "inspector_name": f"Inspector {i + 1}",
            "secondary_inspector_name": f"Secondary {i + 1}" if i > 0 else "",
        }
        import json as _json
        files = {"file": (f"test_image_{i}.png", b"fake-png-data", "image/png")}
        data = {"metadata": _json.dumps(metadata)}
        img_resp = client.post(
            f"/api/projects/{project['id']}/images",
            files=files,
            data=data,
        )
        assert img_resp.status_code == 201, img_resp.text
        image = img_resp.json()
        image_ids.append(image["id"])

    # Add classifications to first and second images
    for img_id in image_ids[:2]:
        cl_resp = client.post(f"/api/images/{img_id}/classifications", json={
            "image_id": img_id,
            "class_id": defect_class["id"],
        })
        assert cl_resp.status_code == 201, cl_resp.text

    cl_resp2 = client.post(f"/api/images/{image_ids[1]}/classifications", json={
        "image_id": image_ids[1],
        "class_id": scratch_class["id"],
    })
    assert cl_resp2.status_code == 201, cl_resp2.text

    # Add comments
    for idx, img_id in enumerate(image_ids):
        cmt_resp = client.post(f"/api/images/{img_id}/comments", json={
            "image_id": img_id,
            "text": f"Test comment for image {idx}",
        })
        assert cmt_resp.status_code == 201, cmt_resp.text

    return {
        "project": project,
        "image_ids": image_ids,
        "classes": [defect_class, scratch_class],
    }


def test_export_excel_returns_xlsx(client, _seed_project_with_images):
    """Verify the export endpoint returns a valid Excel file."""
    project = _seed_project_with_images["project"]
    resp = client.get(f"/api/projects/{project['id']}/export-excel")
    assert resp.status_code == 200
    assert "spreadsheetml" in resp.headers["content-type"]
    assert "attachment" in resp.headers["content-disposition"]
    assert ".xlsx" in resp.headers["content-disposition"]

    # Parse the workbook to verify content
    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(resp.content))
    ws = wb.active
    assert ws.title == "Image Data"

    # Verify headers
    headers = [ws.cell(row=1, column=c).value for c in range(1, 9)]
    assert headers == [
        "Lot Number",
        "Part Serial Number",
        "Image Identifier",
        "Image Inspection Status",
        "Inspector Name",
        "Secondary Inspector Name",
        "Image Classes",
        "Comment",
    ]

    # Verify 3 data rows
    assert ws.max_row == 4  # 1 header + 3 data rows


def test_export_excel_data_content(client, _seed_project_with_images):
    """Verify the actual data content in the exported Excel file."""
    project = _seed_project_with_images["project"]
    resp = client.get(f"/api/projects/{project['id']}/export-excel")
    assert resp.status_code == 200

    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(resp.content))
    ws = wb.active

    # Row 2 = first image
    assert ws.cell(row=2, column=1).value == "LOT-100"
    assert ws.cell(row=2, column=2).value == "SN-2000"
    assert ws.cell(row=2, column=3).value == "test_image_0.png"
    assert ws.cell(row=2, column=4).value == "Not Reviewed"
    assert ws.cell(row=2, column=5).value == "Inspector 1"

    # Row 3 = second image (has two classifications)
    assert ws.cell(row=3, column=1).value == "LOT-101"
    classes_val = ws.cell(row=3, column=7).value
    assert "Defect" in classes_val
    assert "Scratch" in classes_val

    # Row 4 = third image (Reject status)
    assert ws.cell(row=4, column=4).value == "Reject"


def test_export_excel_project_not_found(client):
    """Verify 404 for non-existent project."""
    fake_id = str(uuid.uuid4())
    resp = client.get(f"/api/projects/{fake_id}/export-excel")
    assert resp.status_code == 404


def test_export_excel_empty_project(client):
    """Verify export works for a project with no images."""
    resp = client.post("/api/projects/", json={
        "name": "Empty Project",
        "description": "No images",
        "meta_group_id": "test-group",
    })
    assert resp.status_code == 201
    project = resp.json()

    resp = client.get(f"/api/projects/{project['id']}/export-excel")
    assert resp.status_code == 200

    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(resp.content))
    ws = wb.active
    # Only header row, no data
    assert ws.max_row == 1
