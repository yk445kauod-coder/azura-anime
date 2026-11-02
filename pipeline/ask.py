"""CLI bridge: run the IGNIS agentic RAG pipeline for a question.

Reads JSON from stdin, writes JSON to stdout. Used by the Next.js API layer.

    echo '{"question":"how does flame spread change in microgravity?"}' | python3 pipeline/ask.py
"""
from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.agent import compare_experiments, run_agent  # noqa: E402
from lib.db import fetch_all  # noqa: E402



def _emit(ev: dict) -> None:
    """Stream one event as NDJSON (event + data wrapped in one JSON object)."""
    sys.stdout.write(json.dumps({"event": ev.get("node", "info"), "data": ev}, default=str) + "\n")
    sys.stdout.flush()


def main() -> int:
    logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(message)s")
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": f"invalid JSON input: {exc}"}))
        return 2

    action = payload.get("action", "ask")

    if action == "compare":
        result = compare_experiments(
            payload.get("experiments") or [],
            payload.get("topic"),
        )
    elif action == "search":
        from lib.retrieve import retrieve

        hits = retrieve(payload.get("query", ""), k=int(payload.get("k", 12)))
        result = {"query": payload.get("query"), "hits": [h.as_dict() for h in hits]}
    elif action == "insights":
        result = {"insights": fetch_all(
            """SELECT id, slug, title, body, category, severity, confidence,
                      supporting_documents, created_at
                 FROM ignis.insight ORDER BY
                   CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                                 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
                   confidence DESC"""
        )}
    elif action == "memory":
        # Vector memory recall + recent store listing.
        from lib.memory import MemoryStore

        store = MemoryStore(conversation_id=payload.get("conversation_id"))
        query = (payload.get("query") or "").strip()
        recalled = store.recall(query, top_k=8, min_score=0.35) if query else []
        recent = fetch_all(
            """SELECT id, kind, content, importance, confidence, hit_count, created_at
                 FROM ignis.long_term_memory
                ORDER BY (importance * ln(hit_count + 1)) DESC, last_hit_at DESC
                LIMIT 30"""
        )
        session = []
        if payload.get("conversation_id"):
            session = fetch_all(
                """SELECT id, kind, content, importance, created_at
                     FROM ignis.short_term_memory
                    WHERE conversation_id = %s
                      AND (expires_at IS NULL OR expires_at > now())
                    ORDER BY created_at DESC LIMIT 30""",
                (payload["conversation_id"],),
            )
        result = {
            "recalled": [
                {"id": h.id, "kind": h.kind, "content": h.content,
                 "importance": h.importance, "score": round(h.score, 4),
                 "created_at": h.created_at} for h in recalled
            ],
            "recent": recent, "session": session,
            "stats": {
                "long_term": fetch_all("SELECT count(*) AS n FROM ignis.long_term_memory")[0]["n"],
                "short_term": fetch_all("SELECT count(*) AS n FROM ignis.short_term_memory")[0]["n"],
            },
        }
    elif action == "memory_write":
        from lib.memory import MemoryStore

        store = MemoryStore(conversation_id=payload.get("conversation_id"))
        content = payload.get("content") or ""
        kind = payload.get("kind") or "fact"
        importance = float(payload.get("importance", 0.6))
        if payload.get("long_term", True):
            mid = store.remember(content, kind=kind, importance=importance)
        else:
            mid = store.remember_session(content, kind=kind, importance=importance)
        result = {"id": mid, "stored": mid is not None}
    elif action == "report":
        from report import build_report, render_markdown

        topic = (payload.get("topic") or payload.get("question") or "").strip()
        if not topic:
            print(json.dumps({"error": "missing 'topic'"}))
            return 2
        rep = build_report(
            topic,
            payload.get("questions"),
            k=int(payload.get("k", 8)),
            use_llm=bool(payload.get("use_llm", True)),
            max_questions=payload.get("max_questions"),
        )
        result = {"report": rep, "markdown": render_markdown(rep)}
    else:
        question = (payload.get("question") or "").strip()
        if not question:
            print(json.dumps({"error": "missing 'question'"}))
            return 2
        stream = bool(payload.get("stream", False))
        if stream:
            # NDJSON events: {"event": "...", "data": {...}} on each line,
            # ending with the full AgentResult as the last event.
            res = run_agent(
                question,
                conversation_id=payload.get("conversation_id"),
                k=int(payload.get("k", 8)),
                use_llm=bool(payload.get("use_llm", True)),
                on_event=lambda ev: _emit(ev),
            )
            _emit({"node": "done", "result": res.as_dict()})
            return 0
        res = run_agent(
            question,
            conversation_id=payload.get("conversation_id"),
            k=int(payload.get("k", 8)),
            use_llm=bool(payload.get("use_llm", True)),
        )
        result = res.as_dict()

    print(json.dumps(result, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
