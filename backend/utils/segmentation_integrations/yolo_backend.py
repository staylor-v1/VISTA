"""Example YOLO segmentation adapter for VISTA local_import placeholders."""

from __future__ import annotations

from backend import imglib

from ._shared import (
    decode_request_image,
    options_from_payload,
    payload_from_request,
)


def run(request):
    """Decode VISTA input, run YOLO-like inference, and return mask metadata.

    Replace the foreground-bbox heuristic below with your deployed YOLO segmenter
    while preserving the returned shared output shape.
    """

    payload = payload_from_request(request)
    image = decode_request_image(payload)
    options = options_from_payload(payload)

    return imglib.Yolo(image, **options)
