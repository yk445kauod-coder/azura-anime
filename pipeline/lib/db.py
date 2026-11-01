"""Postgres helpers for the IGNIS pipeline."""
from __future__ import annotations

import contextlib
from typing import Any, Iterable, Sequence

import psycopg
from psycopg.rows import dict_row

from . import config


@contextlib.contextmanager
def connect(autocommit: bool = False):
    """Yield a connection that commits on clean exit and rolls back on error.

    Without this, writes issued through the module-level helpers below would be
    silently discarded when the connection closes.
    """
    conn = psycopg.connect(
        config.DATABASE_URL,
        row_factory=dict_row,
        autocommit=autocommit,
        connect_timeout=30,
        keepalives=1,
    )
    try:
        yield conn
        if not autocommit:
            conn.commit()
    except BaseException:
        if not autocommit:
            conn.rollback()
        raise
    finally:
        conn.close()


def fetch_all(sql: str, params: Sequence[Any] | None = None) -> list[dict[str, Any]]:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def fetch_one(sql: str, params: Sequence[Any] | None = None) -> dict[str, Any] | None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone()


def execute(sql: str, params: Sequence[Any] | None = None) -> None:
    with connect() as conn, conn.cursor() as cur:
        cur.execute(sql, params)


def start_pipeline_run(stage: str, params: dict[str, Any] | None = None) -> int:
    row = fetch_one(
        "INSERT INTO ignis.pipeline_run (stage, params) VALUES (%s, %s) RETURNING id",
        (stage, psycopg.types.json.Jsonb(params or {})),
    )
    return int(row["id"])  # type: ignore[index]


def finish_pipeline_run(
    run_id: int,
    *,
    status: str,
    items_in: int = 0,
    items_out: int = 0,
    bytes_in: int = 0,
    error: str | None = None,
) -> None:
    execute(
        """
        UPDATE ignis.pipeline_run
           SET status=%s, items_in=%s, items_out=%s, bytes_in=%s, error=%s, finished_at=now()
         WHERE id=%s
        """,
        (status, items_in, items_out, bytes_in, error, run_id),
    )


def execute_many(sql: str, rows: Iterable[Sequence[Any]]) -> int:
    n = 0
    with connect() as conn:
        with conn.cursor() as cur:
            for row in rows:
                cur.execute(sql, row)
                n += 1
        conn.commit()
    return n
