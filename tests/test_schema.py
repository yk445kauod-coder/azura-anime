"""Schema integrity: tables, constraints, indexes, search functions, views."""
from __future__ import annotations

import pytest

from conftest import needs_db
from lib.db import fetch_all, fetch_one

pytestmark = needs_db

EXPECTED_TABLES = {
    "raw_record", "artifact", "document", "document_text", "facility", "experiment",
    "finding", "experiment_document", "insight", "chunk", "chunk_embedding",
    "conversation", "message", "agent_run", "agent_step", "retrieval_hit",
    "citation", "pipeline_run", "dedupe_map", "llm_cache", "schema_migration",
}

# Superseded plural tables that must never come back (see migration 0004).
ORPHAN_TABLES = {
    "documents", "chunks", "experiments", "findings", "insights", "sources",
    "materials", "test_conditions", "experiment_materials", "ingest_runs", "query_log",
}


def _tables() -> set[str]:
    return {r["table_name"] for r in fetch_all(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='ignis'")}


def test_expected_tables_exist():
    assert EXPECTED_TABLES <= _tables()


def test_orphan_tables_are_gone():
    present = ORPHAN_TABLES & _tables()
    assert not present, f"superseded tables must be dropped: {sorted(present)}"


def test_search_functions_exist():
    names = {r["proname"] for r in fetch_all(
        """SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='ignis'""")}
    assert {"search_chunks_keyword", "search_chunks_vector",
            "search_chunks_hybrid"} <= names


def test_search_functions_pin_their_search_path():
    """Unqualified table names inside LANGUAGE sql functions break when inlined.

    Migration 0003 attaches an explicit search_path so the functions are
    self-contained regardless of the caller's session settings.
    """
    rows = fetch_all(
        """SELECT p.proname, p.proconfig FROM pg_proc p
             JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='ignis' AND p.proname LIKE 'search_chunks%'""")
    assert rows
    for r in rows:
        cfg = r["proconfig"] or []
        assert any(c.startswith("search_path=") for c in cfg), \
            f"{r['proname']} must pin search_path"


def test_search_functions_work_from_a_bare_session():
    """Regression: calling the functions with the default search_path must work."""
    import psycopg

    from lib import config
    from lib.embed import Embedder, to_pgvector

    vec = to_pgvector(Embedder().embed_one("flame spread in microgravity"))
    with psycopg.connect(config.DATABASE_URL) as conn:
        with conn.cursor() as cur:
            cur.execute("SET search_path TO public")  # deliberately unhelpful
            cur.execute(
                "SELECT count(*) FROM ignis.search_chunks_hybrid(%s, %s::vector, 5, 30, %s)",
                ("flame spread in microgravity", vec, config.EMBED_MODEL))
            assert cur.fetchone()[0] > 0


def test_document_text_view_aggregates():
    row = fetch_one("SELECT * FROM ignis.document_stats")
    assert row["documents"] > 0
    assert row["corpus_words"] > 0
    assert row["corpus_chars"] >= row["corpus_words"]


def test_chunk_embedding_dimension_is_384():
    row = fetch_one(
        """SELECT atttypmod FROM pg_attribute a
             JOIN pg_class c ON c.oid=a.attrelid
             JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='ignis' AND c.relname='chunk_embedding'
              AND a.attname='embedding'""")
    assert row is not None, "chunk_embedding.embedding must exist"


def test_chunk_ordinals_unique_per_document():
    dupes = fetch_all(
        """SELECT document_id, ordinal, count(*) AS n FROM ignis.chunk
            GROUP BY document_id, ordinal HAVING count(*) > 1 LIMIT 5""")
    assert dupes == []


def test_findings_reference_existing_documents():
    orphans = fetch_all(
        """SELECT f.id FROM ignis.finding f
            LEFT JOIN ignis.document d ON d.id = f.document_id
           WHERE d.id IS NULL LIMIT 5""")
    assert orphans == []


def test_chunks_reference_existing_documents():
    orphans = fetch_all(
        """SELECT c.id FROM ignis.chunk c
            LEFT JOIN ignis.document d ON d.id = c.document_id
           WHERE d.id IS NULL LIMIT 5""")
    assert orphans == []


def test_experiment_documents_reference_existing_rows():
    orphans = fetch_all(
        """SELECT ed.document_id FROM ignis.experiment_document ed
            LEFT JOIN ignis.document d ON d.id = ed.document_id
           WHERE d.id IS NULL LIMIT 5""")
    assert orphans == []


def test_document_content_sha256_is_unique():
    dupes = fetch_all(
        """SELECT content_sha256, count(*) AS n FROM ignis.document
            GROUP BY content_sha256 HAVING count(*) > 1 LIMIT 5""")
    assert dupes == [], "dedupe by content hash must hold"


def test_seeded_experiments_and_facilities():
    exps = fetch_all("SELECT code, name, campaign, gravity_level FROM ignis.experiment ORDER BY code")
    facs = fetch_all("SELECT code FROM ignis.facility")
    assert len(exps) >= 8, "reference campaigns (BASS-II, SAFFIRE, SAME, ...) must be seeded"
    assert len(facs) >= 10
    codes = {e["code"] for e in exps}
    assert {"BASS-II", "SAFFIRE", "SAME"} <= codes
    for e in exps:
        assert e["gravity_level"], f"{e['code']} must declare a gravity level"


def test_artifact_kinds_are_expected():
    kinds = {r["kind"] for r in fetch_all("SELECT DISTINCT kind FROM ignis.artifact")}
    assert kinds <= {"pdf", "fulltext_txt", "metadata", "supplement"}
    assert "pdf" in kinds
