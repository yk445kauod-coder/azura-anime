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
    else:
        question = (payload.get("question") or "").strip()
        if not question:
            print(json.dumps({"error": "missing 'question'"}))
            return 2
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
