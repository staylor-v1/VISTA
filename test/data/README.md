# VISTA hierarchy upload fixtures

This directory contains test upload images sourced from the Hugging Face dataset
`Ryukijano/Pothole-detection-Yolov8`, starting with the upstream image whose
filename begins with `0001`.

The files are renamed into the VISTA inspection hierarchy format:

```text
design_number_lot_number_batch_number_serial_number_side_modality_overlay.jpg
```

Example:

```text
D1001_LOT01_BATCH01_SN0001_front_visual_false.jpg
```

When these files are selected in the image uploader, the filename metadata
extractor should auto-apply the delimiter `_` with keys:

```text
design_number, lot_number, batch_number, serial_number, side, modality, overlay
```

The upload flow then posts the raw images and creates inspection parts grouped by
design, lot, batch, and serial number.
