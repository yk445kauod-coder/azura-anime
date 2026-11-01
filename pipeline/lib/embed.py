"""Local embedding model wrapper (fastembed / ONNX, no API key required)."""
from __future__ import annotations

import threading
from functools import lru_cache

from . import config


@lru_cache(maxsize=1)
def _model():
    from fastembed import TextEmbedding

    return TextEmbedding(model_name=config.EMBED_MODEL, threads=config.EMBED_THREADS)


class Embedder:
    """Thread-safe batched embedder producing L2-normalized 384-d vectors."""

    def __init__(self, model_name: str | None = None, dim: int | None = None):
        self.model_name = model_name or config.EMBED_MODEL
        self.dim = dim or config.EMBED_DIM
        self._lock = threading.Lock()

    def embed(self, texts: list[str], batch_size: int = 64) -> list[list[float]]:
        if not texts:
            return []
        with self._lock:
            vectors = list(_model().embed(texts, batch_size=batch_size))
        return [self._normalize(v.tolist()) for v in vectors]

    def embed_one(self, text: str) -> list[float]:
        return self.embed([text])[0]

    @staticmethod
    def _normalize(vec: list[float]) -> list[float]:
        import math

        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [x / norm for x in vec]


def to_pgvector(vec: list[float]) -> str:
    """Serialize a vector for pgvector literals."""
    return "[" + ",".join(f"{x:.7f}" for x in vec) + "]"
