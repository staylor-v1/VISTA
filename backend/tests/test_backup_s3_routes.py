import pytest
from fastapi import HTTPException

from routers import export


def test_parse_backup_s3_url_accepts_bucket_key_styles():
    assert export._parse_backup_s3_url("s3://my-bucket/path/to/dashboard.vistabundle") == (
        "my-bucket",
        "path/to/dashboard.vistabundle",
    )
    assert export._parse_backup_s3_url("http://localhost:9000/my-bucket/path/to/project.zip") == (
        "my-bucket",
        "path/to/project.zip",
    )
    assert export._parse_backup_s3_url("https://my-bucket.s3.amazonaws.com/path/project.zip") == (
        "my-bucket",
        "path/project.zip",
    )


def test_parse_backup_s3_url_rejects_non_s3_schemes():
    with pytest.raises(HTTPException):
        export._parse_backup_s3_url("file:///tmp/dashboard.vistabundle")


def test_s3_bundle_location_requires_object_key():
    with pytest.raises(ValueError):
        export.S3BundleLocation(s3_url="s3://bucket/prefix/")
    assert export.S3BundleLocation(s3_url="s3://bucket/prefix/dashboard.vistabundle").s3_url == "s3://bucket/prefix/dashboard.vistabundle"
