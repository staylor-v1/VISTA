# Test Directory

This directory contains test scripts and utilities for VISTA.

## Backend Tests

### Running Tests

To run backend and frontend tests concurrently:

```bash
./test/run_tests.sh
```

This script will:
- Validate the environment
- Run the independent backend and frontend suites at the same time
- Provide a summary of test results
- Exit with appropriate codes for CI/CD integration

Use `./test/run_tests.sh --sequential` on a constrained host. Run one lane with
`--backend` or `--frontend`. Worker budgets can be adjusted without changing
coverage:

```bash
PYTEST_XDIST_WORKERS=2 FRONTEND_JEST_WORKERS=1 ./test/run_tests.sh
```

GitLab uses four deterministic whole-file shards for each fast suite and keeps
one worker inside each job:

```bash
./test/backend_tests.sh --shard-index 1 --shard-total 4
./test/frontend_tests.sh --jest-only --shard-index 1 --shard-total 4
./test/frontend_tests.sh --custom-only
```

Shard arguments must be supplied together. Empty shards fail instead of
silently passing, and `TEST_SHARD_MANIFEST_PATH` writes the exact selected
files for CI auditing. Totals above 64 and a sharded worker override other
than one are rejected. Backend discovery is recursive for `test_*.py` and
`*_test.py`; Jest discovery follows its `.test`/`.spec` and `__tests__`
defaults, with overlapping matches de-duplicated. PostgreSQL and scheduled
load tests remain serial.

### Test Coverage

The backend test suite includes:

- **Configuration Tests** (`test_config.py`, `test_config_extras.py`)
  - Settings validation and environment variable parsing
  - Boolean parsing with whitespace handling
  - Mock user groups configuration

- **Database Tests** (`test_database.py`)
  - Database connection and table creation
  - Error handling for various connection failures
  - Async session management

- **Authentication & Dependencies** (`test_dependencies.py`)
  - API key authentication
  - Mock user authentication (DEBUG mode)
  - Trusted proxy header authentication
  - Group membership validation

- **API Router Tests**
  - Users (`test_users_router.py`)
  - Projects (`test_projects_router.py`)
  - Images (`test_images_router.py`)
  - API Keys (`test_api_keys.py`)

- **CRUD Operations** 
  - Project metadata (`test_project_metadata_crud.py`)
  - Image classes (`test_image_classes_crud.py`)
  - Classifications and comments (`test_classifications_and_comments_crud.py`)

- **Schema Validation** (`test_schemas.py`)
  - Pydantic model validation
  - Field validators and aliases
  - Data type conversions

- **Content Delivery** (`test_images_content_edge.py`)
  - Image content proxying
  - Header sanitization
  - Error handling for HTTP requests

- **Metadata Management** (`test_images_metadata_endpoints.py`)
  - Metadata updates and deletions
  - JSON handling and validation

### Requirements

- Python 3.11+
- pytest
- pytest-asyncio
- All backend dependencies (see `pyproject.toml`)

### Exit Codes

- `0`: All tests passed
- `1`: Some tests failed
- `2`: Test discovery or setup error

### Development

When adding new tests:
1. Place test files in `backend/tests/`
2. Follow a pytest naming convention: `test_*.py` or `*_test.py`
3. Use pytest fixtures and async test patterns as shown in existing tests
4. Update this README if adding new test categories

### CI/CD Integration

This script is designed to be easily integrated into CI/CD pipelines:

```bash
# A bounded same-host run
PYTEST_XDIST_WORKERS=2 FRONTEND_JEST_WORKERS=1 ./test/run_tests.sh
```

The committed `.gitlab-ci.yml` fans backend and Jest into four jobs, critical
Playwright into two test-level shards, builds the frontend once for browser and
container reuse, and publishes `latest` only after all required jobs pass.
