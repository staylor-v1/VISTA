import pytest
import pytest_asyncio
import asyncio
import os
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool
from unittest.mock import Mock, patch
import uuid
import re

if os.name != "nt":
    try:
        import uvloop

        asyncio.set_event_loop_policy(uvloop.EventLoopPolicy())
    except ImportError:
        pass

# Set test environment variables before importing app components.
# Prefer the CI/local PostgreSQL test database so backend tests exercise the
# same database dialect used in production. TEST_DATABASE_URL can override
# DATABASE_URL when a developer wants tests to target a separate database.
DEFAULT_TEST_DATABASE_URL = "postgresql+asyncpg://postgres:postgres@localhost:5432/postgres_test"


def _worker_database_name(database_name: str) -> str:
    worker_id = os.getenv("PYTEST_XDIST_WORKER")
    if not worker_id:
        return database_name
    sanitized_worker_id = re.sub(r"[^a-zA-Z0-9_]", "_", worker_id)
    return f"{database_name}_{sanitized_worker_id}"


def _ensure_postgres_database(database_url: str) -> str:
    url = make_url(database_url)
    database_name = _worker_database_name(url.database or "postgres_test")
    test_url = url.set(database=database_name)

    # PostgreSQL services in CI create the base database, but pytest-xdist
    # workers need their own databases to avoid cross-process table resets.
    import psycopg2
    from psycopg2 import sql

    admin_url = url.set(drivername="postgresql", database="postgres")
    conn = psycopg2.connect(admin_url.render_as_string(hide_password=False))
    conn.autocommit = True
    try:
        with conn.cursor() as cursor:
            cursor.execute("SELECT 1 FROM pg_database WHERE datname = %s", (database_name,))
            if cursor.fetchone() is None:
                cursor.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database_name)))
    finally:
        conn.close()

    return test_url.render_as_string(hide_password=False)


SQLALCHEMY_DATABASE_URL = os.getenv("TEST_DATABASE_URL") or os.getenv("DATABASE_URL") or DEFAULT_TEST_DATABASE_URL
if SQLALCHEMY_DATABASE_URL.startswith("postgresql://"):
    SQLALCHEMY_DATABASE_URL = SQLALCHEMY_DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)
if SQLALCHEMY_DATABASE_URL.startswith("postgresql"):
    SQLALCHEMY_DATABASE_URL = _ensure_postgres_database(SQLALCHEMY_DATABASE_URL)
os.environ["DATABASE_URL"] = SQLALCHEMY_DATABASE_URL
os.environ["FAST_TEST_MODE"] = "true"
os.environ["S3_ENDPOINT"] = "localhost:9000"
os.environ["S3_ACCESS_KEY"] = "test-key"
os.environ["S3_SECRET_KEY"] = "test-secret"
os.environ["S3_BUCKET"] = "test-bucket"
os.environ["SKIP_HEADER_CHECK"] = "true"
os.environ["DEBUG"] = "true"
from main import app
from core.database import Base, get_db
from core.schemas import User

# Test database setup
engine = create_async_engine(
    SQLALCHEMY_DATABASE_URL,
    echo=False,
    poolclass=NullPool,
)


async def _reset_test_database():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)


async def _drop_test_database():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)


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

@pytest.fixture
def client():
    """Create test client with fresh database"""
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    loop.run_until_complete(_reset_test_database())
    # Patch S3 helpers to avoid external calls during tests
    # Important: Patch where they are used (routers.images.*), not the module defining them
    from unittest.mock import patch
    with patch('routers.images.upload_file_to_s3', return_value=True), \
         patch('routers.images.get_presigned_download_url', return_value='http://example/presigned'):
        with TestClient(app) as c:
            yield c
    loop.run_until_complete(_drop_test_database())

@pytest_asyncio.fixture
async def db_session():
    """Create a test database session"""
    await _reset_test_database()

    async with TestingSessionLocal() as session:
        yield session

    await _drop_test_database()


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
