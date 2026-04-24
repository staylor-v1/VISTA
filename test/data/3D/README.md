# PT3 3D fixture volumes

This directory contains small one-file-per-slice synthetic volumes for PT3 MPR testing.

- `anatomical/` simulates a thoracic stack with lungs, ribs, heart, sternum, and spine cues.
- `geometric/` is the default PT3 load-test-data fixture. It embeds `XY`, `XZ`, and `YZ` letter blocks on the corresponding orthographic planes.

Both volumes are intentionally compact so backend and browser tests can load them quickly.
