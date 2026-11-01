"""Stage 3 — INDEX.

Chunk cleaned documents and compute embeddings, writing:
  * ``ignis.chunk``            — overlapping, heading-aware text chunks
  * ``ignis.chunk_embedding``  — 384-d vectors (pgvector, HNSW indexed)

Usage:
    python3 pipeline/index_vectors.py
    python3 pipeline/index_vectors.py --limit 200 --batch 32
    python3 pipeline/index_vectors.py --reembed        # recompute all vectors
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import config  # noqa: E402
from lib.chunking import chunk_document  # noqa: E402
from lib.db import connect, fetch_all, finish_pipeline_run, start_pipeline_run  # noqa: E402
from lib.embed import Embedder, to_pgvector  # noqa: E402

log = logging.getLogger("ignis.index")


def pending_documents(limit: int | None, reembed: bool) -> list[dict]:
    if reembed:
        sql = """
            SELECT d.id, d.source_id, d.title, t.content
              FROM ignis.document d JOIN ignis.document_text t ON t.document_id = d.id
             ORDER BY d.id
        """
    else:
        sql = """
            SELECT d.id, d.source_id, d.title, t.content
              FROM ignis.document d JOIN ignis.document_text t ON t.document_id = d.id
             WHERE NOT EXISTS (SELECT 1 FROM ignis.chunk c WHERE c.document_id = d.id)
             ORDER BY d.quality_score DESC NULLS LAST, d.id
        """
    if limit:
        sql += f" LIMIT {int(limit)}"
    return fetch_all(sql)


def main() -> int:
    ap = argparse.ArgumentParser(description="IGNIS chunking + embedding indexer")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--batch", type=int, default=64, help="embedding batch size")
    ap.add_argument("--reembed", action="store_true", help="recompute vectors for all chunks")
    ap.add_argument("--chunk-tokens", type=int, default=None)
    ap.add_argument("--overlap-tokens", type=int, default=None)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    run_id = start_pipeline_run("index", {"limit": args.limit, "reembed": args.reembed})
    embedder = Embedder()
    log.info("embedding model: %s (dim=%d)", embedder.model_name, embedder.dim)

    docs = pending_documents(args.limit, args.reembed)
    log.info("documents to index: %d", len(docs))

    stats = {"docs": 0, "chunks": 0, "embeddings": 0, "errors": 0}
    buffer_texts: list[str] = []
    buffer_keys: list[tuple[int, int]] = []   # (chunk_id, document_id)

    def flush() -> None:
        if not buffer_texts:
            return
        vectors = embedder.embed(buffer_texts, batch_size=args.batch)
        with connect() as conn, conn.cursor() as cur:
            for (chunk_id, _doc_id), vec in zip(buffer_keys, vectors):
                cur.execute(
                    """
                    INSERT INTO ignis.chunk_embedding (chunk_id, model, dim, embedding)
                    VALUES (%s, %s, %s, %s::vector)
                    ON CONFLICT (chunk_id, model) DO UPDATE SET embedding = EXCLUDED.embedding
                    """,
                    (chunk_id, embedder.model_name, embedder.dim, to_pgvector(vec)),
                )
            conn.commit()
        stats["embeddings"] += len(vectors)
        buffer_texts.clear()
        buffer_keys.clear()

    for doc in docs:
        try:
            chunks = chunk_document(doc["content"], args.chunk_tokens, args.overlap_tokens)
            if not chunks:
                continue
            with connect() as conn, conn.cursor() as cur:
                if args.reembed:
                    cur.execute("DELETE FROM ignis.chunk WHERE document_id=%s", (doc["id"],))
                for ch in chunks:
                    cur.execute(
                        """
                        INSERT INTO ignis.chunk
                          (document_id, ordinal, kind, section_path, content,
                           token_count, char_count, content_sha256)
                        VALUES (%s, %s, %s::ignis.chunk_kind, %s, %s, %s, %s, %s)
                        ON CONFLICT (document_id, ordinal) DO UPDATE SET
                          kind = EXCLUDED.kind, section_path = EXCLUDED.section_path,
                          content = EXCLUDED.content, token_count = EXCLUDED.token_count,
                          char_count = EXCLUDED.char_count, content_sha256 = EXCLUDED.content_sha256
                        RETURNING id
                        """,
                        (doc["id"], ch["ordinal"], ch["kind"], ch["section_path"], ch["content"],
                         ch["token_count"], ch["char_count"], ch["content_sha256"]),
                    )
                    chunk_id = cur.fetchone()["id"]
                    buffer_texts.append(ch["content"])
                    buffer_keys.append((chunk_id, doc["id"]))
                conn.commit()
            stats["chunks"] += len(chunks)
            stats["docs"] += 1
            if len(buffer_texts) >= args.batch:
                flush()
            if stats["docs"] % 25 == 0:
                log.info("indexed %d docs / %d chunks / %d vectors",
                         stats["docs"], stats["chunks"], stats["embeddings"])
        except Exception as exc:
            stats["errors"] += 1
            log.warning("index failed for doc %s: %s", doc["source_id"], exc)

    flush()
    log.info("index complete: %s", stats)
    finish_pipeline_run(run_id, status="done", items_in=len(docs),
                        items_out=stats["chunks"])
    print(f"\nINDEXED: {stats['docs']} documents -> {stats['chunks']} chunks, "
          f"{stats['embeddings']} vectors ({embedder.model_name}), errors={stats['errors']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
