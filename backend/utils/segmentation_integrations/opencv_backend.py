"""Example OpenCV/classical segmentation adapter for VISTA placeholders."""

from __future__ import annotations

from types import SimpleNamespace

import numpy as np

from backend import imglib

from ._shared import (
    decode_request_image,
    options_from_payload,
    payload_from_request,
)


def run(request):
    """Bridge VISTA input to the deployable OpenCV component contract."""

    payload = payload_from_request(request)
    options = options_from_payload(payload)
    config_names = {
        "min_mask_area_px",
        "min_peak_distance_px",
        "mean_shift_sp",
        "mean_shift_sr",
    }
    config = {name: options[name] for name in config_names if name in options}
    segmenter = imglib.OpenCVSegmentation(**config)

    if payload.get("file") is not None:
        data = SimpleNamespace(
            file=payload["file"], image=None, run_mode=payload.get("mode", "default")
        )
    else:
        rgb_image = np.asarray(decode_request_image(payload))
        data = SimpleNamespace(
            file=None,
            image=rgb_image[:, :, ::-1].copy(),
            run_mode=payload.get("mode", "default"),
        )
    return segmenter.run(data)
