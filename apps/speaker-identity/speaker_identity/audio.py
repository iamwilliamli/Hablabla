"""Optional local pyannote embedding extraction.

This import is intentionally lazy so database and test operations do not need a
model download.  The Hugging Face model terms must be accepted by the enrolling
user before this function is used.
"""

from __future__ import annotations

from pathlib import Path


def embedding_from_audio(audio_file: str | Path, token: str | None) -> list[float]:
    try:
        import numpy as np
        from pyannote.audio import Inference, Model
    except ImportError as error:
        raise RuntimeError("Install this module's Python dependencies before extracting embeddings.") from error
    model = Model.from_pretrained("pyannote/embedding", token=token)
    if model is None:
        raise RuntimeError("Could not load the pyannote embedding model. Check token access and model terms.")
    raw = Inference(model)(str(audio_file))
    values = np.asarray(getattr(raw, "data", raw), dtype=float)
    if values.ndim > 1:
        values = values.mean(axis=0)
    return values.reshape(-1).tolist()
