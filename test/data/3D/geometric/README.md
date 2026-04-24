# PT3 geometric dual-label volume

This directory contains a synthetic geometric 3D stack designed to verify MPR orientation. The volume is stored as one axial PNG file per Z slice.

- Shape: 64 x 96 x 128 (`Z x Y x X`)
- `XY` is embedded on axial plane `Z=16`
- `XZ` is embedded on coronal plane `Y=48`
- `YZ` is embedded on sagittal plane `X=64`

When slicing through the matching plane in each orthographic view, the corresponding two-letter block should become visible.
