"""Apply SQL migrations from db/migrations in lexical order.

Tracks applied migrations in ignis.schema_migration so runs are idempotent.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import config  # noqa: E402
from lib.db import connect  # noqa: E402

MIGRATIONS = sorted((config.ROOT / "db" / "migrations").glob("*.sql"))


def main() -> int:
    print(f"Ignis migrations -> {config.DATABASE_URL.split('@')[-1]}")
    with connect(autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("CREATE SCHEMA IF NOT EXISTS ignis")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS ignis.schema_migration (
              version     text PRIMARY KEY,
              applied_at  timestamptz NOT NULL DEFAULT now(),
              checksum    text
            )
            """
        )
        cur.execute("SELECT version FROM ignis.schema_migration")
        applied = {r["version"] for r in cur.fetchall()}

        for path in MIGRATIONS:
            version = path.stem
            if version in applied:
                print(f"  = {version} (already applied)")
                continue
            sql = path.read_text()
            print(f"  + {version} ...", end="", flush=True)
            cur.execute(sql)
            cur.execute(
                "INSERT INTO ignis.schema_migration (version) VALUES (%s)",
                (version,),
            )
            print(" ok")

        cur.execute("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='ignis'")
        print(f"Applied {len(MIGRATIONS)} migration file(s); ignis schema tables: {cur.fetchone()['n']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
