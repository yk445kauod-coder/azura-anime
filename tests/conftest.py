"""Shared fixtures. Tests exercise real code paths; DB tests need DATABASE_URL."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "pipeline"))

from lib import config  # noqa: E402


def _db_available() -> bool:
    try:
        import psycopg

        with psycopg.connect(config.DATABASE_URL, connect_timeout=8) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT count(*) FROM ignis.chunk")
        return True
    except Exception:
        return False


DB_AVAILABLE = _db_available()
needs_db = pytest.mark.skipif(not DB_AVAILABLE, reason="Neon database unavailable")


@pytest.fixture(scope="session")
def root() -> Path:
    return ROOT


@pytest.fixture(scope="session")
def corpus_stats() -> dict:
    from lib.db import fetch_all

    return fetch_all("SELECT * FROM ignis.document_stats")[0]
