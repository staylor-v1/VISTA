"""Example Anomalib segmentation adapter for VISTA local_import placeholders."""

from __future__ import annotations

from backend import imglib

from ._shared import (
    decode_request_image,
    options_from_payload,
    payload_from_request,
)


def run(request):
    """Decode VISTA input, run anomaly segmentation, and return masks.

    Replace the luminance-difference heuristic with your deployed Anomalib
    inferencer and convert anomaly masks/boxes to the shared VISTA output shape.
    """

    payload = payload_from_request(request)
    image = decode_request_image(payload)
    options = options_from_payload(payload)

    return imglib.anomalib(image, **options)
