"""Example SAM segmentation adapter for VISTA local_import placeholders."""

from __future__ import annotations

from backend import imglib

from ._shared import (
    decode_request_image,
    options_from_payload,
    payload_from_request,
)


def run(request):
    """Decode VISTA input, apply SAM-like prompts, and return mask metadata.

    Replace the prompted bbox fallback with your Segment Anything predictor.
    VISTA passes prompt data in ``payload["prompts"]`` for SAM-like models.
    """

    payload = payload_from_request(request)
    image = decode_request_image(payload)
    options = options_from_payload(payload)
    prompts = payload.get("prompts") if isinstance(payload.get("prompts"), dict) else {}

    # Explicit operator options override prompt defaults without duplicate kwargs.
    return imglib.SAM(image, **{**prompts, **options})
