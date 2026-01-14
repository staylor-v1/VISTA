"""Tests for thumbnail conversion of non-web image formats (TIFF, CMYK, etc.)."""

import io
import pytest
from PIL import Image
from unittest.mock import patch, AsyncMock, MagicMock
from utils.cache_manager import get_cache


@pytest.fixture(autouse=True)
def clear_test_cache():
    """Clear cache before and after each test."""
    cache = get_cache()
    cache.clear()
    yield
    cache.clear()


def _make_tiff_bytes(mode="RGB", size=(100, 100)):
    """Create test TIFF image bytes in specified mode."""
    if mode == "CMYK":
        img = Image.new("CMYK", size, (0, 255, 255, 0))  # Cyan
    elif mode == "RGBA":
        img = Image.new("RGBA", size, (255, 0, 0, 128))  # Semi-transparent red
    elif mode == "I;16":
        # 16-bit grayscale
        img = Image.new("I;16", size)
    else:
        img = Image.new("RGB", size, (255, 0, 0))  # Red

    buf = io.BytesIO()
    img.save(buf, format="TIFF")
    buf.seek(0)
    return buf.getvalue()


class TestThumbnailConversion:
    """Test thumbnail generation converts non-web formats correctly."""

    def test_tiff_rgb_converts_to_jpeg(self, client):
        """Test that RGB TIFF images are converted to JPEG thumbnails."""
        # Create project
        pr = client.post("/api/projects/", json={
            "name": "TiffTest",
            "description": None,
            "meta_group_id": "test-group"
        })
        assert pr.status_code == 201
        pid = pr.json()["id"]

        # Upload TIFF image
        tiff_bytes = _make_tiff_bytes(mode="RGB")
        files = {"file": ("test.tiff", io.BytesIO(tiff_bytes), "image/tiff")}
        ur = client.post(f"/api/projects/{pid}/images", files=files)
        assert ur.status_code == 201
        image_id = ur.json()["id"]

        # Mock httpx to return our TIFF bytes when thumbnail fetches from "S3"
        mock_response = AsyncMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.aread = AsyncMock(return_value=tiff_bytes)

        with patch("routers.images.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            # Request thumbnail
            r = client.get(f"/api/images/{image_id}/thumbnail?width=50&height=50")
            assert r.status_code == 200

            # Verify it was converted to JPEG
            assert r.headers["content-type"] == "image/jpeg"

            # Verify it's a valid JPEG image
            result_img = Image.open(io.BytesIO(r.content))
            assert result_img.format == "JPEG"

    def test_tiff_rgba_converts_to_png(self, client):
        """Test that RGBA TIFF images are converted to PNG to preserve transparency."""
        # Create project
        pr = client.post("/api/projects/", json={
            "name": "TiffRgbaTest",
            "description": None,
            "meta_group_id": "test-group"
        })
        assert pr.status_code == 201
        pid = pr.json()["id"]

        # Upload RGBA TIFF image
        tiff_bytes = _make_tiff_bytes(mode="RGBA")
        files = {"file": ("test_rgba.tiff", io.BytesIO(tiff_bytes), "image/tiff")}
        ur = client.post(f"/api/projects/{pid}/images", files=files)
        assert ur.status_code == 201
        image_id = ur.json()["id"]

        # Mock httpx
        mock_response = AsyncMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.aread = AsyncMock(return_value=tiff_bytes)

        with patch("routers.images.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            # Request thumbnail
            r = client.get(f"/api/images/{image_id}/thumbnail?width=50&height=50")
            assert r.status_code == 200

            # Verify it was converted to PNG (preserves transparency)
            assert r.headers["content-type"] == "image/png"

            # Verify it's a valid PNG image
            result_img = Image.open(io.BytesIO(r.content))
            assert result_img.format == "PNG"

    def test_tiff_cmyk_converts_to_jpeg(self, client):
        """Test that CMYK TIFF images are converted to RGB JPEG."""
        # Create project
        pr = client.post("/api/projects/", json={
            "name": "TiffCmykTest",
            "description": None,
            "meta_group_id": "test-group"
        })
        assert pr.status_code == 201
        pid = pr.json()["id"]

        # Upload CMYK TIFF image
        tiff_bytes = _make_tiff_bytes(mode="CMYK")
        files = {"file": ("test_cmyk.tiff", io.BytesIO(tiff_bytes), "image/tiff")}
        ur = client.post(f"/api/projects/{pid}/images", files=files)
        assert ur.status_code == 201
        image_id = ur.json()["id"]

        # Mock httpx
        mock_response = AsyncMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.aread = AsyncMock(return_value=tiff_bytes)

        with patch("routers.images.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            # Request thumbnail
            r = client.get(f"/api/images/{image_id}/thumbnail?width=50&height=50")
            assert r.status_code == 200

            # Verify it was converted to JPEG
            assert r.headers["content-type"] == "image/jpeg"

            # Verify it's a valid JPEG image with RGB mode
            result_img = Image.open(io.BytesIO(r.content))
            assert result_img.format == "JPEG"
            assert result_img.mode == "RGB"

    def test_tiff_16bit_grayscale_converts_to_jpeg(self, client):
        """Test that 16-bit grayscale TIFF images are converted to JPEG."""
        # Create project
        pr = client.post("/api/projects/", json={
            "name": "Tiff16bitTest",
            "description": None,
            "meta_group_id": "test-group"
        })
        assert pr.status_code == 201
        pid = pr.json()["id"]

        # Upload 16-bit grayscale TIFF image
        tiff_bytes = _make_tiff_bytes(mode="I;16")
        files = {"file": ("test_16bit.tiff", io.BytesIO(tiff_bytes), "image/tiff")}
        ur = client.post(f"/api/projects/{pid}/images", files=files)
        assert ur.status_code == 201
        image_id = ur.json()["id"]

        # Mock httpx
        mock_response = AsyncMock()
        mock_response.raise_for_status = MagicMock()
        mock_response.aread = AsyncMock(return_value=tiff_bytes)

        with patch("routers.images.httpx.AsyncClient") as mock_client:
            mock_client.return_value.__aenter__.return_value.get = AsyncMock(
                return_value=mock_response
            )

            # Request thumbnail
            r = client.get(f"/api/images/{image_id}/thumbnail?width=50&height=50")
            assert r.status_code == 200

            # Verify it was converted to JPEG
            assert r.headers["content-type"] == "image/jpeg"

            # Verify it's a valid JPEG image
            result_img = Image.open(io.BytesIO(r.content))
            assert result_img.format == "JPEG"
