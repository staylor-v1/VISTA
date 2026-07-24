import pytest
import pytest_asyncio
import asyncio
import os
from contextlib import contextmanager
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from unittest.mock import Mock, patch
import uuid

if os.name != "nt":
    try:
        import uvloop

        asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())
    except ImportError:
        pass

# Set test environment variables before importing app components
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["FAST_TEST_MODE"] = "true"
os.environ["S3_ENDPOINT"] = "localhost:9000"
os.environ["S3_ACCESS_KEY"] = "test-key"
os.environ["S3_SECRET_KEY"] = "test-secret"
os.environ["S3_BUCKET"] = "test-bucket"
os.environ["SKIP_HEADER_CHECK"] = "true"
os.environ["DEBUG"] = "true"
from main import app
from core import group_auth_helper
from core.database import Base, get_db
from core.schemas import User
from routers import images as images_router
from utils import cache_manager, volume_cache

SMOKE_TEST_NODE_SUFFIXES = {
    "test_unified_auth.py::TestRequireProxyUser::test_api_key_create_rejected_with_bearer",
    "test_unified_auth.py::TestApiKeyEndToEnd::test_api_key_authenticates_to_me_endpoint",
}


def pytest_collection_modifyitems(items):
    """Tag focused auth journeys without rewriting the legacy CRLF test module."""
    for item in items:
        if any(item.nodeid.endswith(suffix) for suffix in SMOKE_TEST_NODE_SUFFIXES):
            item.add_marker(pytest.mark.smoke)


# Test database setup
SQLALCHEMY_DATABASE_URL = "sqlite+aiosqlite:///:memory:"

engine = create_async_engine(
    SQLALCHEMY_DATABASE_URL,
    echo=False,
)

TestingSessionLocal = sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)

async def override_get_db():
    async with TestingSessionLocal() as session:
        yield session

app.dependency_overrides[get_db] = override_get_db


def _clear_safe_process_caches():
    """Clear completed process-local cache state without disturbing live work."""
    group_auth_helper._group_membership_cache.clear()

    # Do not call get_cache(): most tests never need a CacheManager, and cleanup
    # must not create a disk cache merely to clear it.
    with cache_manager._cache_lock:
        if cache_manager._cache_manager is not None:
            cache_manager._cache_manager.clear()

    # In-flight render futures intentionally remain registered. Removing them
    # could duplicate active work or strand waiters on a still-running render.
    with images_router._volume_slice_png_cache_lock:
        images_router._volume_slice_png_cache.clear()
    with images_router._volume_render_summary_cache_lock:
        images_router._volume_render_summary_cache.clear()

    # This helper locks the memmap/signature registries, drops their entries,
    # and closes only the process-local handles it removed. Materialization
    # tasks and persistent cache files are deliberately left alone.
    volume_cache._reset_volume_cache_for_tests()


@contextmanager
def _isolated_backend_process_state():
    """Restore dependency overrides and safe caches after one test body."""
    original_overrides = app.dependency_overrides
    overrides_snapshot = dict(original_overrides)
    try:
        yield
    finally:
        try:
            _clear_safe_process_caches()
        finally:
            # Restore both mapping identity and contents in case a test replaced
            # app.dependency_overrides instead of mutating it in place.
            app.dependency_overrides = original_overrides
            original_overrides.clear()
            original_overrides.update(overrides_snapshot)


@pytest.fixture(autouse=True)
def isolate_backend_process_state():
    """Prevent safe process-local test mutations from leaking across tests."""
    with _isolated_backend_process_state():
        yield


@pytest.fixture
def backend_process_state_isolation_context():
    """Expose the autouse fixture's context for single-test teardown assertions."""
    return _isolated_backend_process_state


@pytest.fixture
def client():
    """Create test client with fresh database"""
    async def setup_db():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    async def teardown_db():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.drop_all)

    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    loop.run_until_complete(setup_db())
    # Patch S3 helpers to avoid external calls during tests
    # Important: Patch where they are used (routers.images.*), not the module defining them
    from unittest.mock import patch
    with patch('routers.images.upload_file_to_s3', return_value=True), \
         patch('routers.images.get_presigned_download_url', return_value='http://example/presigned'):
        with TestClient(app) as c:
            yield c
    loop.run_until_complete(teardown_db())

@pytest_asyncio.fixture
async def db_session():
    """Create a test database session"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    
    async with TestingSessionLocal() as session:
        yield session

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


@pytest.fixture
def mock_s3_client():
    """Mock S3 client for testing"""
    with patch('boto3_client.boto3_client') as mock_client:
        mock_client.upload_fileobj = Mock(return_value=True)
        mock_client.head_bucket = Mock(return_value=True)
        mock_client.create_bucket = Mock(return_value=True)
        mock_client.generate_presigned_url = Mock(return_value="http://test-url")
        yield mock_client

@pytest.fixture
def sample_user():
    """Sample user data for testing"""
    return {
        "id": str(uuid.uuid4()),
        "email": "test@example.com",
        "username": "testuser",
        "is_active": True,
        "groups": ["admin-group", "data-scientists"]
    }

@pytest.fixture
def sample_project():
    """Sample project data for testing"""
    return {
        "name": "Test Project",
        "description": "A test project",
        "meta_group_id": "test-group"
    }

@pytest.fixture
def auth_headers():
    """Sample authentication headers"""
    return {
        "X-User-Id": "test@example.com",
        "X-User-Groups": '["admin-group", "data-scientists"]'
    }
