"""Shared configuration + connection helpers for the IGNIS data pipeline."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
CLEAN_DIR = DATA_DIR / "clean"
MANIFEST_DIR = DATA_DIR / "manifests"

for _d in (RAW_DIR, CLEAN_DIR, MANIFEST_DIR):
    _d.mkdir(parents=True, exist_ok=True)


def _load_env() -> None:
    """Load .env / .env.local without clobbering real environment variables."""
    for name in (".env", ".env.local"):
        path = ROOT / name
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


_load_env()

DATABASE_URL = os.environ.get("DATABASE_URL", "")
DATABASE_URL_POOLED = os.environ.get("DATABASE_URL_POOLED", DATABASE_URL)

S3_ENDPOINT = os.environ.get("AWS_ENDPOINT_URL_S3", "")
S3_BUCKET = os.environ.get("S3_BUCKET", "uploads")
S3_PREFIX = os.environ.get("S3_PREFIX", "ignis")
AWS_ACCESS_KEY_ID = os.environ.get("AWS_ACCESS_KEY_ID", "")
AWS_SECRET_ACCESS_KEY = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")

NTRS_BASE = "https://ntrs.nasa.gov"
NTRS_API = f"{NTRS_BASE}/api"

EMBED_MODEL = os.environ.get("IGNIS_EMBED_MODEL", "BAAI/bge-small-en-v1.5")
EMBED_DIM = int(os.environ.get("IGNIS_EMBED_DIM", "384"))
EMBED_THREADS = int(os.environ.get("IGNIS_EMBED_THREADS", "0")) or None

# Retrieval / chunking defaults
CHUNK_TARGET_TOKENS = int(os.environ.get("IGNIS_CHUNK_TOKENS", "420"))
CHUNK_OVERLAP_TOKENS = int(os.environ.get("IGNIS_CHUNK_OVERLAP", "60"))

USER_AGENT = "IGNIS-research/0.1 (+https://github.com/yk445kauod-coder/project-08)"
