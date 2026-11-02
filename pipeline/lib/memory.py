"""IGNIS agent memory: short-term (session) + long-term (episodic) vector memory.

Backed by pgvector tables ``short_term_memory`` / ``long_term_memory``.  Uses the
same local bge embedding model as retrieval, so recall is cheap and offline.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import dataclass, field

from . import config
from .db import connect, execute, fetch_all, fetch_one
from .embed import Embedder, to_pgvector

log = logging.getLogger("ignis.memory")

# Similarity threshold below which a memory is not considered a hit.
DEFAULT_MIN_SIM = 0.5
# How many memories to pull for a single recall.
DEFAULT_TOP_K = 5
# Long-term recency decay: a memory recalled today is ``base``, one recalled
# ``horizon_days`` ago decays toward 0.
LT_BASE = 1.0
LT_HORIZON_SECONDS = 90 * 24 * 3600


@dataclass
class MemoryHit:
    id: int
    kind: str
    content: str
    importance: float
    score: float
    created_at: str
    hit_count: int = 0
    confidence: float = 0.0


@dataclass
class MemoryStore:
    """Facade over both memory tables."""

    conversation_id: str | None = None
    embedder: Embedder = field(default_factory=Embedder)
    enabled: bool = True

    # ------------------------------------------------------------------ write
    def remember(
        self,
        content: str,
        *,
        kind: str = "fact",
        conversation_id: str | None = None,
        importance: float = 0.6,
        run_id: str | None = None,
        chunk_id: int | None = None,
    ) -> int | None:
        """Store an item in long-term memory. Returns the row id or None."""
        if not self.enabled or not content or not content.strip():
            return None
        try:
            vec = to_pgvector(self.embedder.embed_one(content))
            with connect() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO ignis.long_term_memory
                      (kind, content, source_run_id, source_chunk_id, embedding,
                       importance, confidence)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT DO NOTHING
                    RETURNING id
                    """,
                    (kind, content[:4000], run_id, chunk_id, vec, importance, 0.6),
                )
                row = cur.fetchone()
                conn.commit()
            if row:
                _signal("long_term", row["id"], "written", run_id=run_id)
                return row["id"]
        except Exception as exc:
            log.warning("long-term remember failed: %s", exc)
        return None

    def remember_session(
        self,
        content: str,
        *,
        kind: str = "question",
        conversation_id: str | None = None,
        importance: float = 0.5,
        run_id: str | None = None,
    ) -> int | None:
        """Store an item in short-term (per-conversation) memory."""
        conv = conversation_id or self.conversation_id
        if not self.enabled or not conv or not content.strip():
            return None
        try:
            vec = to_pgvector(self.embedder.embed_one(content))
            with connect() as conn, conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO ignis.short_term_memory
                      (conversation_id, kind, content, source_run_id, embedding, importance)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    RETURNING id
                    """,
                    (conv, kind, content[:4000], run_id, vec, importance),
                )
                row = cur.fetchone()
                conn.commit()
            if row:
                _signal("short_term", row["id"], "written", run_id=run_id)
                return row["id"]
        except Exception as exc:
            log.warning("short-term remember failed: %s", exc)
        return None

    # ------------------------------------------------------------------- read
    def recall_short_term(self, query: str, *, top_k: int = DEFAULT_TOP_K,
                          min_score: float = DEFAULT_MIN_SIM) -> list[MemoryHit]:
        """Return the most relevant short-term memories for this query."""
        conv = self.conversation_id
        if not self.enabled or not conv:
            return []
        try:
            vec = to_pgvector(self.embedder.embed_one(query))
            rows = fetch_all(
                "SELECT * FROM ignis.recall_short_term(%s::text, %s::uuid, %s::integer, %s::float8)",
                (vec, conv, top_k, min_score),
            )
            return [MemoryHit(
                id=r["id"], kind=r["kind"], content=r["content"],
                importance=r["importance"], score=float(r["score"]),
                created_at=str(r["created_at"]),
            ) for r in rows]
        except Exception as exc:
            log.warning("short-term recall failed: %s", exc)
            return []

    def recall_long_term(self, query: str, *, top_k: int = DEFAULT_TOP_K,
                         min_score: float = DEFAULT_MIN_SIM) -> list[MemoryHit]:
        """Return the most relevant long-term memories, then reinforce hits."""
        if not self.enabled:
            return []
        try:
            vec = to_pgvector(self.embedder.embed_one(query))
            rows = fetch_all(
                "SELECT * FROM ignis.recall_long_term(%s::text, %s::integer, %s::float8)",
                (vec, top_k, min_score),
            )
            hits = [MemoryHit(
                id=r["id"], kind=r["kind"], content=r["content"],
                importance=r["importance"], confidence=r["confidence"],
                hit_count=r["hit_count"], score=float(r["score"]),
                created_at=str(r["created_at"]),
            ) for r in rows]
            for h in hits:
                try:
                    execute(
                        "UPDATE ignis.long_term_memory SET hit_count = hit_count + 1, "
                        "last_hit_at = now() WHERE id = %s",
                        (h.id,),
                    )
                    _signal("long_term", h.id, "recalled", similarity=h.score)
                except Exception:
                    pass
            return hits
        except Exception as exc:
            log.warning("long-term recall failed: %s", exc)
            return []

    def recall(self, query: str, *, top_k: int = DEFAULT_TOP_K,
               min_score: float = DEFAULT_MIN_SIM) -> list[MemoryHit]:
        """Pull both memory layers for a query (short-term first)."""
        return self.recall_short_term(query, top_k=top_k, min_score=min_score) \
            + self.recall_long_term(query, top_k=top_k, min_score=min_score)

    # ------------------------------------------------------------- consolidate
    def consolidate_into_long_term(self, *, conversation_id: str | None = None,
                                   min_importance: float = 0.6,
                                   run_id: str | None = None) -> int:
        """Promote reusable short-term memories into long-term memory."""
        conv = conversation_id or self.conversation_id
        if not self.enabled or not conv:
            return 0
        promoted = 0
        try:
            rows = fetch_all(
                """SELECT content, kind, source_run_id, importance, embedding
                     FROM ignis.short_term_memory
                    WHERE conversation_id = %s AND importance >= %s
                    ORDER BY importance DESC LIMIT 25""",
                (conv, min_importance),
            )
            for r in rows:
                cur = fetch_one(
                    """SELECT id FROM ignis.long_term_memory
                        WHERE content = %s LIMIT 1""",
                    (r["content"],),
                )
                if cur:
                    continue
                self.remember(
                    r["content"], kind=r["kind"],
                    importance=r["importance"],
                    run_id=r.get("source_run_id") or run_id,
                )
                promoted += 1
        except Exception as exc:
            log.warning("consolidate failed: %s", exc)
        return promoted


def _signal(memory_type: str, memory_id: int, action: str, *, run_id=None,
            similarity: float | None = None) -> None:
    try:
        execute(
            """INSERT INTO ignis.memory_signal (memory_type, memory_id, run_id, action, similarity)
               VALUES (%s, %s, %s, %s, %s)""",
            (memory_type, memory_id, run_id, action, similarity),
        )
    except Exception:
        pass