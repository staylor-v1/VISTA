"""Tests for the Excel export endpoint."""
import io
import uuid
import json as _json
import pytest
from unittest.mock import patch

from routers.export import _extract_meta, _build_workbook


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def _seed_project_with_images(client):
    """Create a project with images, classifications, and comments for export testing."""
    resp = client.post("/api/projects/", json={
        "name": "Export Test Project",
        "description": "Project for testing Excel export",
        "meta_group_id": "test-group",
    })
    assert resp.status_code == 201, resp.text
    project = resp.json()

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

    image_ids = []
    for i in range(3):
        metadata = {
            "lot_number": f"LOT-{100 + i}",
            "part_serial_number": f"SN-{2000 + i}",
            "inspection_status": ["Not Reviewed", "Pass", "Reject"][i],
            "inspector_name": f"Inspector {i + 1}",
            "secondary_inspector_name": f"Secondary {i + 1}" if i > 0 else "",
        }
        files = {"file": (f"test_image_{i}.png", b"fake-png-data", "image/png")}
        data = {"metadata": _json.dumps(metadata)}
        img_resp = client.post(
            f"/api/projects/{project['id']}/images",
            files=files,
            data=data,
        )
        assert img_resp.status_code == 201, img_resp.text
        image_ids.append(img_resp.json()["id"])

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


# ---------------------------------------------------------------------------
# Endpoint integration tests
# ---------------------------------------------------------------------------

def test_export_excel_returns_xlsx(client, _seed_project_with_images):
    """Verify the export endpoint returns a valid Excel file."""
    project = _seed_project_with_images["project"]
    resp = client.get(f"/api/projects/{project['id']}/export-excel")
    assert resp.status_code == 200
    assert "spreadsheetml" in resp.headers["content-type"]
    assert "attachment" in resp.headers["content-disposition"]
    assert ".xlsx" in resp.headers["content-disposition"]

    from openpyxl import load_workbook
    wb = load_workbook(io.BytesIO(resp.content))
    ws = wb.active
    assert ws.title == "Image Data"

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
    assert ws.max_row == 1


def test_export_excel_comments_concatenated(client, _seed_project_with_images):
    """Verify multiple comments on a single image are pipe-separated."""
    project = _seed_project_with_images["project"]
    img_id = _seed_project_with_images["image_ids"][0]

    # Add a second comment to the first image
    cmt_resp = client.post(f"/api/images/{img_id}/comments", json={
        "image_id": img_id,
        "text": "Second comment on image 0",
    })
    assert cmt_resp.status_code == 201

    resp = client.get(f"/api/projects/{project['id']}/export-excel")
    assert resp.status_code == 200

    from openpyxl import load_workbook
    ws = load_workbook(io.BytesIO(resp.content)).active

    comment_cell = ws.cell(row=2, column=8).value
    assert "|" in comment_cell
    assert "Test comment for image 0" in comment_cell
    assert "Second comment on image 0" in comment_cell


def test_export_excel_deleted_images_excluded(client):
    """Verify that soft-deleted images are not included in the export."""
    resp = client.post("/api/projects/", json={
        "name": "Deletion Test",
        "description": "Test deleted images",
        "meta_group_id": "test-group",
    })
    project = resp.json()
    pid = project["id"]

    # Upload two images
    for i in range(2):
        files = {"file": (f"del_test_{i}.png", b"data", "image/png")}
        img_resp = client.post(f"/api/projects/{pid}/images", files=files)
        assert img_resp.status_code == 201

    # Soft-delete the first image via the correct endpoint
    images_resp = client.get(f"/api/projects/{pid}/images")
    images = images_resp.json()
    first_id = images[0]["id"]
    del_resp = client.request(
        "DELETE",
        f"/api/projects/{pid}/images/{first_id}",
        json={"reason": "test deletion"},
    )
    assert del_resp.status_code == 200, del_resp.text

    # Export should only contain the non-deleted image
    resp = client.get(f"/api/projects/{pid}/export-excel")
    assert resp.status_code == 200

    from openpyxl import load_workbook
    ws = load_workbook(io.BytesIO(resp.content)).active
    assert ws.max_row == 2  # 1 header + 1 data row


def test_export_excel_no_metadata_defaults(client):
    """Verify images with no metadata get sensible defaults."""
    resp = client.post("/api/projects/", json={
        "name": "No Metadata",
        "description": "Images without metadata",
        "meta_group_id": "test-group",
    })
    project = resp.json()

    files = {"file": ("bare_image.png", b"data", "image/png")}
    client.post(f"/api/projects/{project['id']}/images", files=files)

    resp = client.get(f"/api/projects/{project['id']}/export-excel")
    assert resp.status_code == 200

    from openpyxl import load_workbook
    ws = load_workbook(io.BytesIO(resp.content)).active

    # Lot number, serial number, secondary inspector should be empty
    assert ws.cell(row=2, column=1).value in (None, "")  # lot_number
    assert ws.cell(row=2, column=2).value in (None, "")  # part_serial_number
    assert ws.cell(row=2, column=6).value in (None, "")  # secondary_inspector

    # Filename should still be present
    assert ws.cell(row=2, column=3).value == "bare_image.png"

    # Inspection status should default to "Not Reviewed"
    assert ws.cell(row=2, column=4).value == "Not Reviewed"

    # Inspector should fall back to uploaded_by_user_id
    inspector = ws.cell(row=2, column=5).value
    assert inspector is not None and inspector != ""


def test_export_excel_filename_sanitization(client):
    """Verify special characters in project name are sanitized in the filename."""
    resp = client.post("/api/projects/", json={
        "name": "Test/Project <with> special&chars!",
        "description": "Special chars test",
        "meta_group_id": "test-group",
    })
    project = resp.json()

    resp = client.get(f"/api/projects/{project['id']}/export-excel")
    assert resp.status_code == 200

    disposition = resp.headers["content-disposition"]
    # Should not contain path separators or angle brackets
    assert "/" not in disposition.split("filename=")[1]
    assert "<" not in disposition.split("filename=")[1]
    assert ">" not in disposition.split("filename=")[1]
    assert ".xlsx" in disposition


def test_export_excel_image_no_classifications(client):
    """Verify images with no classifications have empty class column."""
    resp = client.post("/api/projects/", json={
        "name": "No Classes Assigned",
        "description": "Test",
        "meta_group_id": "test-group",
    })
    project = resp.json()

    files = {"file": ("unclassified.png", b"data", "image/png")}
    client.post(f"/api/projects/{project['id']}/images", files=files)

    resp = client.get(f"/api/projects/{project['id']}/export-excel")

    from openpyxl import load_workbook
    ws = load_workbook(io.BytesIO(resp.content)).active
    classes_val = ws.cell(row=2, column=7).value
    assert classes_val in (None, "")


def test_export_excel_image_no_comments(client):
    """Verify images with no comments have empty comment column."""
    resp = client.post("/api/projects/", json={
        "name": "No Comments",
        "description": "Test",
        "meta_group_id": "test-group",
    })
    project = resp.json()

    files = {"file": ("silent.png", b"data", "image/png")}
    client.post(f"/api/projects/{project['id']}/images", files=files)

    resp = client.get(f"/api/projects/{project['id']}/export-excel")

    from openpyxl import load_workbook
    ws = load_workbook(io.BytesIO(resp.content)).active
    comment_val = ws.cell(row=2, column=8).value
    assert comment_val in (None, "")


def test_export_excel_forbidden_for_non_group_member(client):
    """Verify 403 when user is not a member of the project's group."""
    resp = client.post("/api/projects/", json={
        "name": "Restricted Project",
        "description": "Not for everyone",
        "meta_group_id": "restricted-group",
    })
    assert resp.status_code == 201
    project = resp.json()

    with patch("routers.export.is_user_in_group", return_value=False):
        resp = client.get(f"/api/projects/{project['id']}/export-excel")

    assert resp.status_code == 403
    assert "access" in resp.json()["detail"].lower()


def test_export_excel_alternate_metadata_keys(client):
    """Verify the export recognizes alternate key names for metadata fields."""
    resp = client.post("/api/projects/", json={
        "name": "Alternate Keys",
        "description": "Test alternate metadata key names",
        "meta_group_id": "test-group",
    })
    project = resp.json()

    # Use alternate key names (lotNumber, serial, inspectionStatus, etc.)
    metadata = {
        "lotNumber": "ALT-LOT-1",
        "serial": "ALT-SN-1",
        "inspectionStatus": "Pass",
        "inspectorName": "Alt Inspector",
        "secondaryInspectorName": "Alt Secondary",
    }
    files = {"file": ("alt_keys.png", b"data", "image/png")}
    data = {"metadata": _json.dumps(metadata)}
    client.post(f"/api/projects/{project['id']}/images", files=files, data=data)

    resp = client.get(f"/api/projects/{project['id']}/export-excel")
    assert resp.status_code == 200

    from openpyxl import load_workbook
    ws = load_workbook(io.BytesIO(resp.content)).active

    assert ws.cell(row=2, column=1).value == "ALT-LOT-1"
    assert ws.cell(row=2, column=2).value == "ALT-SN-1"
    assert ws.cell(row=2, column=4).value == "Pass"
    assert ws.cell(row=2, column=5).value == "Alt Inspector"
    assert ws.cell(row=2, column=6).value == "Alt Secondary"


# ---------------------------------------------------------------------------
# Unit tests for _extract_meta helper
# ---------------------------------------------------------------------------

class TestExtractMeta:
    """Tests for the _extract_meta helper function."""

    def test_returns_first_matching_key(self):
        meta = {"lot_number": "LOT-1", "lot": "LOT-2"}
        assert _extract_meta(meta, "lot_number", "lot") == "LOT-1"

    def test_falls_through_to_second_key(self):
        meta = {"lot": "LOT-2"}
        assert _extract_meta(meta, "lot_number", "lot") == "LOT-2"

    def test_returns_empty_for_no_match(self):
        meta = {"other_key": "value"}
        assert _extract_meta(meta, "lot_number", "lot") == ""

    def test_returns_empty_for_empty_dict(self):
        assert _extract_meta({}, "lot_number") == ""

    def test_skips_none_values(self):
        meta = {"lot_number": None, "lot": "LOT-2"}
        assert _extract_meta(meta, "lot_number", "lot") == "LOT-2"

    def test_skips_whitespace_only_values(self):
        meta = {"lot_number": "   ", "lot": "LOT-2"}
        assert _extract_meta(meta, "lot_number", "lot") == "LOT-2"

    def test_strips_whitespace(self):
        meta = {"lot_number": "  LOT-1  "}
        assert _extract_meta(meta, "lot_number") == "LOT-1"

    def test_converts_non_string_values(self):
        meta = {"lot_number": 12345}
        assert _extract_meta(meta, "lot_number") == "12345"

    def test_skips_empty_string(self):
        meta = {"lot_number": "", "lot": "LOT-2"}
        assert _extract_meta(meta, "lot_number", "lot") == "LOT-2"

    def test_all_keys_empty_returns_empty(self):
        meta = {"lot_number": "", "lot": None, "lotNumber": "  "}
        assert _extract_meta(meta, "lot_number", "lot", "lotNumber") == ""


# ---------------------------------------------------------------------------
# Unit tests for _build_workbook helper
# ---------------------------------------------------------------------------

class TestBuildWorkbook:
    """Tests for the _build_workbook helper function."""

    def _load(self, wb):
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        from openpyxl import load_workbook
        return load_workbook(buf)

    def test_empty_rows_produces_header_only(self):
        wb = _build_workbook("Test", [])
        ws = self._load(wb).active
        assert ws.max_row == 1
        assert ws.cell(row=1, column=1).value == "Lot Number"

    def test_freeze_panes_set(self):
        wb = _build_workbook("Test", [{"lot_number": "L1"}])
        ws = self._load(wb).active
        assert ws.freeze_panes == "A2"

    def test_autofilter_set_with_data(self):
        rows = [{"lot_number": f"L{i}"} for i in range(3)]
        wb = _build_workbook("Test", rows)
        ws = self._load(wb).active
        assert ws.auto_filter.ref is not None
        assert "A1" in ws.auto_filter.ref
        assert "H4" in ws.auto_filter.ref  # 8 columns, 3 data rows + 1 header

    def test_autofilter_not_set_for_empty(self):
        wb = _build_workbook("Test", [])
        ws = self._load(wb).active
        assert ws.auto_filter.ref is None

    def test_header_styling(self):
        wb = _build_workbook("Test", [])
        ws = self._load(wb).active
        header_cell = ws.cell(row=1, column=1)
        assert header_cell.font.bold is True
        assert header_cell.fill.start_color.rgb is not None

    def test_status_coloring_pass(self):
        rows = [{"inspection_status": "Pass"}]
        wb = _build_workbook("Test", rows)
        ws = self._load(wb).active
        status_cell = ws.cell(row=2, column=4)
        # Pass = green fill (C6EFCE)
        assert status_cell.fill.start_color.rgb == "00C6EFCE"

    def test_status_coloring_reject(self):
        rows = [{"inspection_status": "Reject"}]
        wb = _build_workbook("Test", rows)
        ws = self._load(wb).active
        status_cell = ws.cell(row=2, column=4)
        # Reject = red fill (FFC7CE)
        assert status_cell.fill.start_color.rgb == "00FFC7CE"

    def test_status_coloring_not_reviewed(self):
        rows = [{"inspection_status": "Not Reviewed"}]
        wb = _build_workbook("Test", rows)
        ws = self._load(wb).active
        status_cell = ws.cell(row=2, column=4)
        # Not Reviewed = blue fill (D9E2F3)
        assert status_cell.fill.start_color.rgb == "00D9E2F3"

    def test_status_coloring_reject_not_confirmed(self):
        rows = [{"inspection_status": "Reject but not confirmed"}]
        wb = _build_workbook("Test", rows)
        ws = self._load(wb).active
        status_cell = ws.cell(row=2, column=4)
        # Reject but not confirmed = yellow fill (FFEB9C)
        assert status_cell.fill.start_color.rgb == "00FFEB9C"

    def test_status_coloring_case_insensitive(self):
        rows = [{"inspection_status": "PASS"}]
        wb = _build_workbook("Test", rows)
        ws = self._load(wb).active
        status_cell = ws.cell(row=2, column=4)
        assert status_cell.fill.start_color.rgb == "00C6EFCE"

    def test_unknown_status_no_special_coloring(self):
        rows = [{"inspection_status": "In Progress"}]
        wb = _build_workbook("Test", rows)
        ws = self._load(wb).active
        status_cell = ws.cell(row=2, column=4)
        # No special fill applied (default or alt-row fill only)
        rgb = status_cell.fill.start_color.rgb
        assert rgb not in ("00C6EFCE", "00FFC7CE", "00FFEB9C", "00D9E2F3")

    def test_column_count(self):
        wb = _build_workbook("Test", [])
        ws = self._load(wb).active
        assert ws.max_column == 8

    def test_sheet_title(self):
        wb = _build_workbook("My Project", [])
        ws = self._load(wb).active
        assert ws.title == "Image Data"

    def test_multiple_rows_written(self):
        rows = [
            {"lot_number": "L1", "image_identifier": "img1.png"},
            {"lot_number": "L2", "image_identifier": "img2.png"},
            {"lot_number": "L3", "image_identifier": "img3.png"},
        ]
        wb = _build_workbook("Test", rows)
        ws = self._load(wb).active
        assert ws.max_row == 4
        assert ws.cell(row=2, column=1).value == "L1"
        assert ws.cell(row=3, column=1).value == "L2"
        assert ws.cell(row=4, column=1).value == "L3"

    def test_missing_keys_default_to_empty(self):
        """Row dicts missing some keys should produce empty cells."""
        rows = [{"lot_number": "L1"}]  # missing all other keys
        wb = _build_workbook("Test", rows)
        ws = self._load(wb).active
        # image_identifier (col 3) should be empty
        assert ws.cell(row=2, column=3).value in (None, "")
