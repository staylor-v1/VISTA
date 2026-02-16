# Scripts

Utility scripts for testing, development, and ML pipeline integration.

## Available Scripts

### YOLOv8 ML Pipeline (`yolov8_ml_pipeline.py`)

End-to-end integration test for the ML analysis feature using real YOLOv8 object detection.

**Quick Start:**
```bash
# Run pipeline on a project (auto-installs dependencies)
./run_yolov8_pipeline.sh <project_id> --install-deps --limit 50

# With API key authentication
./run_yolov8_pipeline.sh <project_id> --api-key YOUR_KEY --limit 50

# View results at http://localhost:3000 in the ML Analyses panel
```

**What it does:**
- Fetches images from a project via API
- Runs YOLOv8 object detection (80 COCO classes: person, car, dog, etc.)
- Creates bounding box + heatmap visualizations
- Uploads artifacts to S3/MinIO
- Submits annotations via the unified `/api` endpoint
- Completes full analysis lifecycle (queued -> processing -> completed)

**Model sizes:** `n` (nano/fast), `s` (small), `m` (medium), `l` (large), `x` (xlarge)

**Full documentation:** [README_YOLOV8.md](./README_YOLOV8.md)

---

### Heatmap Pipeline (`heatmap_ml_pipeline.py`)

Generates random/synthetic heatmaps for UI testing.

```bash
./run_heatmap_pipeline.sh <project_id> --limit 50
./run_heatmap_pipeline.sh <project_id> --api-key YOUR_KEY --output-dir ./heatmaps
```

---

### Test ML Pipeline (`test_ml_pipeline.py`)

Mock ML pipeline for testing without running real models.

```bash
python test_ml_pipeline.py --image-id <image_uuid>
python test_ml_pipeline.py --image-id <image_uuid> --api-key YOUR_KEY
```

Simulates external ML pipeline behavior with mock annotations.

---

### Mock ML Generator (`mock_ml/`)

Generates a synthetic image with geometric shapes, uploads it, and creates mock analyses.

```bash
cd mock_ml
./run_mock_ml.sh <project_id> http://localhost:8000 YOUR_API_KEY
```

---

## Requirements

**For YOLOv8 pipeline:**
```bash
pip install -r ml_requirements.txt
```

**For heatmap pipeline:**
```bash
pip install -r heatmap_ml_requirements.txt
```

**For test pipeline:**
- Standard Python 3.8+ (requests, Pillow)

## Authentication

All scripts authenticate via one of two methods:

1. **API key (Bearer token)** -- recommended for production and automation:
   ```bash
   --api-key YOUR_KEY
   # or set the API_KEY environment variable
   ```

2. **Debug mode (X-User-Email header)** -- for local development with `DEBUG=true`:
   No API key needed; scripts automatically send the mock user header.

## Environment Variables

- `API_KEY` -- API key for Bearer token authentication
- `MOCK_USER_EMAIL` -- Email for debug-mode auth (default: test@example.com)

These are normally loaded from the project root `.env` file by the Python and shell scripts.

## Usage Examples

```bash
# YOLOv8 pipeline with nano model (CPU-friendly)
./run_yolov8_pipeline.sh abc-123-def --model-size n --limit 50

# YOLOv8 with GPU-optimized large model
./run_yolov8_pipeline.sh abc-123-def --model-size l --limit 20

# Mock pipeline for quick testing
python test_ml_pipeline.py --image-id abc-123-def

# Custom API endpoint
./run_yolov8_pipeline.sh abc-123 --api-url https://api.example.com --api-key KEY
```

## File Structure

```
scripts/
├── README.md                    # This file
├── README_YOLOV8.md            # Detailed YOLOv8 documentation
├── yolov8_ml_pipeline.py       # YOLOv8 integration script
├── run_yolov8_pipeline.sh      # Bash wrapper for YOLOv8
├── heatmap_ml_pipeline.py      # Heatmap generation script
├── run_heatmap_pipeline.sh     # Bash wrapper for heatmap
├── ml_requirements.txt         # ML dependencies (YOLOv8)
├── heatmap_ml_requirements.txt # ML dependencies (heatmap)
├── test_ml_pipeline.py         # Mock pipeline tester
└── mock_ml/                    # Mock ML generator
    ├── generate_and_upload_ml.py
    └── run_mock_ml.sh
```

## Troubleshooting

**Authentication errors (401):**
```bash
# Use an API key
export API_KEY='your-api-key'
# Or ensure DEBUG=true on the backend for development
```

**Dependencies not installed:**
```bash
./run_yolov8_pipeline.sh <project_id> --install-deps
```

**No images found:**
Upload images to your project first via the web UI.

**API not running:**
```bash
cd ../backend && ./run.sh
```

## Next Steps

1. Run YOLOv8 pipeline on test project
2. View results in ML Analyses panel
3. Export annotations as JSON/CSV
4. Integrate into CI/CD for automated testing
5. Deploy as containerized ML service
