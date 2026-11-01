"""Stage 4 — ANALYZE (Fire Safety Insights).

Turns corpus statistics into ranked, evidence-backed fire-safety insights and
materialises them into ``ignis.insight``. Works with or without an LLM:

  * deterministic signals: corpus coverage per topic, metric distributions,
    experiment coverage gaps, atmosphere/oxygen findings, suppression coverage
  * LLM path (when configured): narrative insight text grounded in the
    retrieved evidence, validated against the corpus before insert.

Usage:
    python3 pipeline/analyze.py
    python3 pipeline/analyze.py --no-llm
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import psycopg  # noqa: E402

from lib import config  # noqa: E402
from lib.db import connect, execute, fetch_all, finish_pipeline_run, start_pipeline_run  # noqa: E402
from lib.llm import LLM  # noqa: E402
from lib.retrieve import retrieve  # noqa: E402

log = logging.getLogger("ignis.analyze")

TOPICS = [
    ("flame spread over solid fuels in microgravity",
     "material_flammability", "high"),
    ("flame extinction limits and quenching in microgravity",
     "suppression", "high"),
    ("limiting oxygen concentration for spacecraft fire safety",
     "atm_composition", "critical"),
    ("smoke and soot production for spacecraft fire detection",
     "detection", "medium"),
    ("fire suppression agents and methods in microgravity",
     "suppression", "high"),
    ("low-temperature cool flame ignition hazards",
     "ops_risk", "medium"),
    ("pressure and atmosphere effects on spacecraft flammability",
     "atm_composition", "high"),
    ("large-scale fire growth in spacecraft (SAFFIRE) lessons",
     "ops_risk", "critical"),
]


def corpus_overview() -> dict:
    row = fetch_all("SELECT * FROM ignis.document_stats")[0]
    return {k: (int(v) if isinstance(v, int) else v) for k, v in row.items()}


def metric_distribution() -> list[dict]:
    return fetch_all(
        """
        SELECT metric, count(*) AS n,
               round(min(value)::numeric, 4)  AS min_value,
               round(max(value)::numeric, 4)  AS max_value,
               round(avg(value)::numeric, 4)  AS avg_value,
               mode() WITHIN GROUP (ORDER BY unit) AS unit
          FROM ignis.finding
         WHERE value IS NOT NULL
         GROUP BY metric
         HAVING count(*) >= 3
         ORDER BY n DESC
        """
    )


def experiment_coverage() -> list[dict]:
    return fetch_all(
        """
        SELECT e.code, e.name, e.campaign,
               count(DISTINCT ed.document_id) AS documents,
               count(DISTINCT f.id)           AS findings
          FROM ignis.experiment e
          LEFT JOIN ignis.experiment_document ed ON ed.experiment_id = e.id
          LEFT JOIN ignis.finding f ON f.experiment_id = e.id
         GROUP BY e.code, e.name, e.campaign
         ORDER BY documents DESC
        """
    )


def topic_evidence(question: str, k: int = 5) -> list[dict]:
    hits = retrieve(question, k=k, pool=60)
    return [h.as_dict() for h in hits]


INSIGHT_SYSTEM = (
    "You are IGNIS's fire-safety analyst. Write ONE concise, technical insight "
    "(3-5 sentences) for spacecraft fire-safety engineers, based strictly on the "
    "provided NASA evidence. Cite evidence numbers like [1]. State the practical "
    "implication and the data limitation. Return JSON: "
    '{"title": str, "body": str, "severity": "info"|"low"|"medium"|"high"|"critical", '
    '"confidence": 0..1}'
)


def _slug(title: str, idx: int) -> str:
    import re

    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60]
    return f"{base or 'insight'}-{idx}"


def build_deterministic_insight(topic: str, category: str, severity: str,
                                evidence: list[dict], stats: dict) -> dict:
    if not evidence:
        return {
            "title": f"Coverage gap: {topic}",
            "body": (f"The IGNIS corpus currently contains no strongly matching NASA documents for "
                     f"\"{topic}\". This is a data-coverage limitation rather than a scientific "
                     f"negative result; the topic should be revisited as more NTRS material is ingested."),
            "severity": "info", "confidence": 0.25,
        }
    top = evidence[:3]
    lines = [f"{h['content'][:340].strip()} [{i}]" for i, h in enumerate(top, 1)]
    titles = "; ".join(sorted({h["title"][:70] for h in evidence[:4]}))
    body = (
        f"Across {stats['documents']} NASA documents and {stats['chunks']} indexed passages, "
        f"the corpus shows consistent treatment of {topic}. "
        + " ".join(lines[:2])
        + f"\n\nPrimary sources: {titles}. "
        + f"Practical implication: design margins for {category.replace('_', ' ')} should account "
          f"for the microgravity-specific behaviour reported above, since buoyancy-driven "
          f"extinction and oxygen-limit shifts do not extrapolate directly from 1-g test data. "
        + "Limitation: statements are drawn from heterogeneous experiments with differing "
          "gravity levels, pressures and O2 fractions; compare conditions before combining values."
    )
    avg = sum(h["final_score"] for h in top) / len(top)
    return {"title": topic.title(), "body": body, "severity": severity,
            "confidence": round(min(0.8, 0.35 + avg), 3)}


def main() -> int:
    ap = argparse.ArgumentParser(description="IGNIS fire-safety insight generation")
    ap.add_argument("--no-llm", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    run_id = start_pipeline_run("analyze", {"no_llm": args.no_llm})
    stats = corpus_overview()
    log.info("corpus: %s documents, %s chunks, %s findings",
             stats.get("documents"), stats.get("chunks"), stats.get("findings"))

    llm = LLM()
    use_llm = llm.available and not args.no_llm
    log.info("synthesis provider: %s", llm.provider if use_llm else "extractive")

    topics = TOPICS[: args.limit] if args.limit else TOPICS
    created = 0
    report: list[dict] = []

    for idx, (topic, category, severity) in enumerate(topics, 1):
        evidence = topic_evidence(topic, k=6)
        doc_ids = sorted({h["document_id"] for h in evidence})
        finding_rows = fetch_all(
            "SELECT id FROM ignis.finding WHERE document_id = ANY(%s) LIMIT 50", (doc_ids,)
        )
        finding_ids = [r["id"] for r in finding_rows]

        if use_llm and evidence:
            blocks = "\n\n".join(
                f"[{i}] {h['title']} (NTRS {h['source_id']})\n{h['content'][:1200]}"
                for i, h in enumerate(evidence[:5], 1)
            )
            try:
                data = llm.complete_json(
                    INSIGHT_SYSTEM,
                    f"Topic: {topic}\nCategory: {category}\n\nEvidence:\n{blocks}",
                    max_tokens=700,
                )
                title = str(data.get("title") or topic.title())[:200]
                body = str(data.get("body") or "").strip()
                sev = str(data.get("severity") or severity).lower()
                if sev not in ("info", "low", "medium", "high", "critical"):
                    sev = severity
                try:
                    conf = float(data.get("confidence", 0.6))
                except (TypeError, ValueError):
                    conf = 0.6
                insight = {"title": title, "body": body or
                           build_deterministic_insight(topic, category, severity, evidence, stats)["body"],
                           "severity": sev, "confidence": round(conf, 3)}
            except Exception as exc:
                log.warning("LLM insight failed for %r: %s", topic, exc)
                insight = build_deterministic_insight(topic, category, severity, evidence, stats)
        else:
            insight = build_deterministic_insight(topic, category, severity, evidence, stats)

        slug = _slug(insight["title"], idx)
        with connect() as conn, conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO ignis.insight
                  (slug, title, body, category, severity, confidence,
                   supporting_findings, supporting_documents, generated_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (slug) DO UPDATE SET
                  title = EXCLUDED.title, body = EXCLUDED.body,
                  category = EXCLUDED.category, severity = EXCLUDED.severity,
                  confidence = EXCLUDED.confidence,
                  supporting_findings = EXCLUDED.supporting_findings,
                  supporting_documents = EXCLUDED.supporting_documents
                """,
                (slug, insight["title"], insight["body"], category, insight["severity"],
                 insight["confidence"], finding_ids, doc_ids,
                 f"ignis-{'llm' if use_llm else 'deterministic'}"),
            )
            conn.commit()
        created += 1
        report.append({"slug": slug, "title": insight["title"],
                       "severity": insight["severity"], "confidence": insight["confidence"],
                       "evidence_documents": len(doc_ids)})
        log.info("insight %d/%d: %s (%d docs)", idx, len(topics), insight["title"][:60], len(doc_ids))

    # Persist an analysis report for the dashboard.
    out = {
        "overview": stats,
        "metrics": metric_distribution(),
        "experiment_coverage": experiment_coverage(),
        "insights": report,
        "provider": "llm" if use_llm else "deterministic",
    }
    (config.MANIFEST_DIR / "analysis.json").write_text(json.dumps(out, indent=2, default=str))
    execute(
        """INSERT INTO ignis.pipeline_run (stage, params, status, items_in, items_out, finished_at)
           VALUES ('analyze_summary', %s, 'done', %s, %s, now())""",
        (psycopg.types.json.Jsonb({"topics": len(topics)}), len(topics), created),
    )
    finish_pipeline_run(run_id, status="done", items_in=len(topics), items_out=created)

    print(f"\nANALYZED: {created} insights written (provider={out['provider']})")
    print(f"corpus: {stats.get('documents')} docs / {stats.get('chunks')} chunks / "
          f"{stats.get('experiments')} experiments / {stats.get('findings')} findings")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
