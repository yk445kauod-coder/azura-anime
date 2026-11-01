"""Hybrid retrieval + smart ranking for IGNIS.

Pipeline:  hybrid (BM25-ish FTS + pgvector cosine, fused with RRF)
           -> quality/domain/relevance-aware smart ranking
           -> MMR diversification
           -> evidence pack for the synthesizer.
"""
from __future__ import annotations

import math
import re
from dataclasses import dataclass, field

from . import config
from .db import fetch_all
from .embed import Embedder, to_pgvector
from .text import domain_density, words

_EMBEDDER: Embedder | None = None

STOP = set("""a an the and or but if while of to in on for with without from by as at is are was were be been
what which who how why when where does do did is are can could should would will""".split())


def embedder() -> Embedder:
    global _EMBEDDER
    if _EMBEDDER is None:
        _EMBEDDER = Embedder()
    return _EMBEDDER


@dataclass
class Hit:
    chunk_id: int
    document_id: int
    title: str
    source_id: str
    ordinal: int
    kind: str
    section_path: str | None
    content: str
    vector_score: float = 0.0
    keyword_score: float = 0.0
    fused_score: float = 0.0
    rerank_score: float = 0.0
    final_score: float = 0.0
    quality_score: float = 0.0
    landing_url: str = ""
    published_date: str | None = None
    sub_question: str | None = None
    relevance: str = "unrated"
    meta: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return {
            "chunk_id": self.chunk_id, "document_id": self.document_id,
            "title": self.title, "source_id": self.source_id,
            "ordinal": self.ordinal, "kind": self.kind,
            "section_path": self.section_path,
            "content": self.content,
            "vector_score": round(self.vector_score, 4),
            "keyword_score": round(self.keyword_score, 4),
            "fused_score": round(self.fused_score, 6),
            "rerank_score": round(self.rerank_score, 4),
            "final_score": round(self.final_score, 4),
            "quality_score": round(self.quality_score, 4),
            "landing_url": self.landing_url,
            "published_date": str(self.published_date) if self.published_date else None,
            "sub_question": self.sub_question,
            "relevance": self.relevance,
        }


def hybrid_search(question: str, k: int = 24, pool: int = 80,
                  model_name: str | None = None) -> list[Hit]:
    """Run RRF fusion of keyword + vector search in Postgres."""
    qvec = embedder().embed_one(question)
    rows = fetch_all(
        "SELECT * FROM ignis.search_chunks_hybrid(%s, %s::vector, %s, %s, %s)",
        (question, to_pgvector(qvec), k, pool, model_name or config.EMBED_MODEL),
    )
    hits = [Hit(
        chunk_id=r["chunk_id"], document_id=r["document_id"], title=r["title"],
        source_id=r["source_id"], ordinal=r["ordinal"], kind=str(r["kind"]),
        section_path=r["section_path"], content=r["content"],
        vector_score=float(r["vector_score"] or 0),
        keyword_score=float(r["keyword_score"] or 0),
        fused_score=float(r["fused_score"] or 0),
    ) for r in rows]
    return _enrich(hits)


def _enrich(hits: list[Hit]) -> list[Hit]:
    """Attach document metadata (quality, landing URL, date) to hits."""
    if not hits:
        return hits
    ids = list({h.document_id for h in hits})
    rows = fetch_all(
        """SELECT id, quality_score, landing_url, published_date
             FROM ignis.document WHERE id = ANY(%s)""",
        (ids,),
    )
    meta = {r["id"]: r for r in rows}
    for h in hits:
        m = meta.get(h.document_id)
        if m:
            h.quality_score = float(m["quality_score"] or 0)
            h.landing_url = m["landing_url"] or ""
            h.published_date = m["published_date"]
    return hits


# --------------------------------------------------------------------------- #
# Smart ranking
# --------------------------------------------------------------------------- #
def _query_terms(question: str) -> set[str]:
    return {w.lower() for w in words(question) if len(w) > 2 and w.lower() not in STOP}


def _lexical_overlap(text: str, terms: set[str]) -> float:
    if not terms:
        return 0.0
    low = text.lower()
    hits = sum(1 for t in terms if t in low)
    return hits / len(terms)


_PHRASE = re.compile(r'"([^"]{4,})"')


def rerank(question: str, hits: list[Hit]) -> list[Hit]:
    """Cheap cross-encoder substitute: query-term coverage + phrase + position."""
    terms = _query_terms(question)
    phrases = [p.lower() for p in _PHRASE.findall(question)]
    for h in hits:
        overlap = _lexical_overlap(h.content, terms)
        # Head-of-chunk matches matter more than tail matches.
        head = h.content[:600].lower()
        head_bonus = _lexical_overlap(head, terms) * 0.5
        phrase_bonus = 0.25 * sum(1 for p in phrases if p in h.content.lower())
        section_bonus = 0.15 if h.kind in ("abstract", "results", "conclusion") else 0.0
        h.rerank_score = round(min(1.0, 0.55 * overlap + head_bonus + phrase_bonus + section_bonus), 4)
    return hits


def smart_rank(hits: list[Hit], question: str, *, w_fusion: float = 0.40,
               w_rerank: float = 0.34, w_quality: float = 0.16,
               w_domain: float = 0.10) -> list[Hit]:
    """Combine fusion, rerank, corpus quality and domain density into one score."""
    if not hits:
        return hits
    max_fused = max((h.fused_score for h in hits), default=0) or 1.0
    for h in hits:
        norm_fused = h.fused_score / max_fused
        h.final_score = round(
            w_fusion * norm_fused
            + w_rerank * h.rerank_score
            + w_quality * h.quality_score
            + w_domain * domain_density(h.content),
            6,
        )
    hits.sort(key=lambda x: x.final_score, reverse=True)
    return hits


def mmr_diversify(hits: list[Hit], k: int, lambda_: float = 0.72) -> list[Hit]:
    """Maximal Marginal Relevance over bag-of-words similarity.

    Prevents the evidence pack from being filled with near-identical chunks
    from one document.
    """
    if len(hits) <= k:
        return hits
    token_sets = [set(w.lower() for w in words(h.content)) for h in hits]
    selected: list[int] = []
    remaining = list(range(len(hits)))

    def jaccard(a: set[str], b: set[str]) -> float:
        if not a or not b:
            return 0.0
        return len(a & b) / len(a | b)

    while remaining and len(selected) < k:
        best, best_score = None, -math.inf
        for i in remaining:
            sim = max((jaccard(token_sets[i], token_sets[j]) for j in selected), default=0.0)
            score = lambda_ * hits[i].final_score - (1 - lambda_) * sim
            if score > best_score:
                best, best_score = i, score
        selected.append(best)          # type: ignore[arg-type]
        remaining.remove(best)         # type: ignore[arg-type]
    return [hits[i] for i in selected]


def retrieve(question: str, *, k: int = 8, pool: int = 80, diversify: bool = True) -> list[Hit]:
    """Full retrieval path used by both the API and the agent."""
    hits = hybrid_search(question, k=max(k * 3, 24), pool=pool)
    hits = rerank(question, hits)
    hits = smart_rank(hits, question)
    if diversify:
        hits = mmr_diversify(hits, k)
    return hits[:k]


def grade_hits(question: str, hits: list[Hit], llm=None) -> list[Hit]:
    """Assign relevance labels; uses the LLM when available, else heuristics."""
    terms = _query_terms(question)
    for h in hits:
        if llm is not None and getattr(llm, "available", False):
            continue  # LLM grading is done batched in agent.py
        score = 0.6 * h.rerank_score + 0.4 * _lexical_overlap(h.content, terms)
        h.relevance = "relevant" if score >= 0.45 else ("partial" if score >= 0.22 else "irrelevant")
    return hits
