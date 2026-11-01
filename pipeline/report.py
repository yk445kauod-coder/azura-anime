"""Research report generator — turns corpus evidence into a citable document.

Runs the agentic RAG pipeline over a topic's sub-questions, then assembles the
grounded answers into a structured report: executive summary, key findings,
evidence table, comparative experiment view, data limitations and references.

Every finding keeps its NTRS source, so a reader can trace any statement back
to the document it came from. With an LLM configured the narrative is written
by the model; otherwise the report is assembled from verbatim corpus text and
still fully cited.

Usage:
    python3 pipeline/report.py --topic "fire suppression in microgravity"
    python3 pipeline/report.py --topic "..." --format markdown --out report.md
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.agent import compare_experiments, run_agent  # noqa: E402
from lib.db import fetch_all  # noqa: E402
from lib.llm import LLM  # noqa: E402

log = logging.getLogger("ignis.report")

# Sub-questions that make a useful spacecraft-fire-safety report. A caller can
# override these; the defaults target the "Flame in Freefall" challenge.
DEFAULT_QUESTIONS = [
    "How does flame spread over solid fuels differ in microgravity?",
    "What limits flame extinction and quenching in microgravity?",
    "What is the limiting oxygen concentration for spacecraft fire safety?",
    "How are smoke and soot produced and detected in microgravity?",
    "Which fire suppression agents and methods work in microgravity?",
    "What did the large-scale spacecraft fire experiments (SAFFIRE) show?",
]

SUMMARY_SYSTEM = (
    "You are IGNIS, a scientific research analyst specialising in microgravity combustion "
    "and spacecraft fire safety. Write the executive summary of a research report. "
    "Use ONLY the provided findings. Do not introduce facts, numbers, or citations that are "
    "not present. Cite findings with bracketed numbers like [2]. "
    "Return JSON: {\"summary\": string (3-5 short paragraphs, markdown), "
    "\"limitations\": [string], \"recommendations\": [string]}"
)


def _corpus_stats() -> dict:
    row = fetch_all("SELECT * FROM ignis.document_stats")[0]
    return {k: (int(v) if isinstance(v, int) else v) for k, v in row.items()}


def _evidence_rows(findings: list[dict]) -> list[dict]:
    """Deduplicate the citations backing a report into one evidence table."""
    seen: dict[str, dict] = {}
    for f in findings:
        for c in f.get("citations", []):
            key = c.get("chunk_id") or c.get("source_id")
            if key and key not in seen:
                seen[key] = {
                    "source_id": c.get("source_id"),
                    "title": c.get("title"),
                    "section": c.get("section"),
                    "support_score": c.get("support_score"),
                    "quote": c.get("quote"),
                    "landing_url": c.get("landing_url"),
                }
    return sorted(seen.values(), key=lambda r: -(r.get("support_score") or 0))


def _synthesize_summary(question: str, findings: list[dict], llm) -> dict:
    blocks = []
    for i, f in enumerate(findings, 1):
        blocks.append(f"[{i}] {f['question']}\n{f['answer'][:1500]}")
    data = llm.complete_json(
        SUMMARY_SYSTEM,
        f"Report topic: {question}\n\nFindings:\n\n" + "\n\n".join(blocks),
        max_tokens=1600,
    )
    return {
        "summary": (data.get("summary") or "").strip(),
        "limitations": [str(x) for x in (data.get("limitations") or []) if str(x).strip()],
        "recommendations": [str(x) for x in (data.get("recommendations") or []) if str(x).strip()],
    }


def _fallback_summary(question: str, findings: list[dict], stats: dict) -> dict:
    """Deterministic summary when no LLM is configured — verbatim, still cited."""
    grounded = [f for f in findings if f["grounded"]]
    lines = [
        f"This report covers **{question}** across {stats['documents']} NASA documents "
        f"and {stats['chunks']} indexed passages "
        f"({stats.get('corpus_words', 0):,} words).",
        f"{len(grounded)} of {len(findings)} research questions returned grounded, "
        f"cited answers.",
    ]
    for i, f in enumerate(findings, 1):
        if f["grounded"]:
            first = f["answer"].split("\n\n")
            lead = next((p for p in first if len(p) > 80), f["answer"])[:400]
            lines.append(f"[{i}] **{f['question']}** — {lead}")
    return {
        "summary": "\n\n".join(lines),
        "limitations": [
            "Answers are assembled from retrieved passages; coverage depends on what the "
            "corpus contains.",
            "Quantitative values are quoted from the source documents and were not "
            "independently re-measured.",
        ],
        "recommendations": [],
    }


def build_report(topic: str, questions: list[str] | None = None, k: int = 8,
                 use_llm: bool = True, max_questions: int | None = None) -> dict:
    t0 = time.time()
    # The topic anchors the report: retrieve for it directly, then work through
    # the framework questions so the document is both on-topic and complete.
    questions = list(questions or DEFAULT_QUESTIONS)
    if topic and topic not in questions:
        questions.insert(0, topic)
    if max_questions:
        questions = questions[:max_questions]

    llm = LLM(enabled=use_llm)
    stats = _corpus_stats()

    findings: list[dict] = []
    for q in questions:
        log.info("researching: %s", q)
        try:
            res = run_agent(q, k=k, use_llm=use_llm)
            d = res.as_dict()
        except Exception as exc:
            log.warning("question failed (%s): %s", q, exc)
            continue
        findings.append({
            "question": q,
            "answer": d["answer"],
            "confidence": d["confidence"],
            "grounded": d["grounded"],
            "citations": d["claims"],
            "evidence_count": len(d["evidence"]),
            "provider": d["provider"],
            "model": d["model"],
            "latency_ms": d["latency_ms"],
        })

    experiments = []
    try:
        experiments = compare_experiments([], topic).get("experiments", [])
    except Exception as exc:
        log.warning("comparative view unavailable: %s", exc)

    if llm.available and findings:
        try:
            narrative = _synthesize_summary(topic, findings, llm)
        except Exception as exc:
            log.warning("LLM summary failed, using deterministic summary: %s", exc)
            narrative = _fallback_summary(topic, findings, stats)
    else:
        narrative = _fallback_summary(topic, findings, stats)

    evidence = _evidence_rows(findings)
    sources = sorted(
        {e["source_id"] for e in evidence if e.get("source_id")}
    )

    return {
        "topic": topic,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "generator": {
            "provider": llm.provider if llm.available else "extractive",
            "model": llm.model if llm.available else "ignis-extractive",
            "chain": llm.chain,
        },
        "corpus": {
            "documents": stats["documents"],
            "chunks": stats["chunks"],
            "words": stats.get("corpus_words", 0),
            "experiments": stats.get("experiments"),
            "findings_indexed": stats.get("findings"),
        },
        "summary": narrative["summary"],
        "key_findings": findings,
        "evidence": evidence,
        "comparative": experiments,
        "limitations": narrative["limitations"],
        "recommendations": narrative["recommendations"],
        "references": [
            {"source_id": s, "landing_url": f"https://ntrs.nasa.gov/citations/{s}"}
            for s in sources
        ],
        "metrics": {
            "questions": len(findings),
            "grounded": sum(1 for f in findings if f["grounded"]),
            "citations": sum(len(f["citations"]) for f in findings),
            "unique_sources": len(sources),
            "mean_confidence": round(
                sum(f["confidence"] for f in findings) / len(findings), 3
            ) if findings else 0.0,
            "latency_ms": int((time.time() - t0) * 1000),
        },
    }


def render_markdown(report: dict) -> str:
    m = report["metrics"]
    c = report["corpus"]
    out = [
        f"# IGNIS Research Report — {report['topic']}",
        "",
        f"*Generated {report['generated_at']} by {report['generator']['provider']}"
        f"/{report['generator']['model']}*",
        "",
        "## Executive Summary",
        "",
        report["summary"],
        "",
        "## Corpus",
        "",
        f"- Documents: {c['documents']}",
        f"- Indexed passages: {c['chunks']}",
        f"- Words: {c['words']:,}",
        "",
        "## Key Findings",
        "",
    ]
    for i, f in enumerate(report["key_findings"], 1):
        out.append(f"### {i}. {f['question']}")
        out.append("")
        out.append(f"*Confidence {f['confidence']} · {len(f['citations'])} citations · "
                   f"{'grounded' if f['grounded'] else 'ungrounded'}*")
        out.append("")
        out.append(f["answer"])
        out.append("")

    if report["comparative"]:
        out += ["## Comparative Experiment View", ""]
        for e in report["comparative"]:
            out.append(f"- **{e.get('code') or e.get('name')}** — "
                       f"{e.get('findings', 0)} findings")
        out.append("")

    out += ["## Data Limitations", ""]
    for lim in report["limitations"]:
        out.append(f"- {lim}")
    out.append("")

    if report["recommendations"]:
        out += ["## Recommendations", ""]
        for rec in report["recommendations"]:
            out.append(f"- {rec}")
        out.append("")

    out += ["## Evidence Table", "",
            "| # | NTRS ID | Section | Score | Quote |",
            "|---|---------|---------|-------|-------|"]
    for i, e in enumerate(report["evidence"], 1):
        quote = (e.get("quote") or "").replace("|", "/").replace("\n", " ")[:180]
        out.append(f"| {i} | {e.get('source_id')} | {e.get('section') or ''} | "
                   f"{e.get('support_score')} | {quote} |")
    out.append("")

    out += ["## References", ""]
    for r in report["references"]:
        out.append(f"- [{r['source_id']}]({r['landing_url']})")
    out.append("")
    out += ["---", "",
            f"*{m['grounded']}/{m['questions']} questions grounded · "
            f"{m['citations']} citations · {m['unique_sources']} unique sources · "
            f"generated in {m['latency_ms']} ms*", ""]
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="Generate an IGNIS research report")
    ap.add_argument("--topic", required=True)
    ap.add_argument("--question", action="append", dest="questions",
                    help="override sub-questions (repeatable)")
    ap.add_argument("--k", type=int, default=8)
    ap.add_argument("--max-questions", type=int, default=None)
    ap.add_argument("--no-llm", action="store_true")
    ap.add_argument("--format", choices=["json", "markdown"], default="json")
    ap.add_argument("--out", help="write to this path instead of stdout")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    report = build_report(args.topic, args.questions, k=args.k,
                          use_llm=not args.no_llm, max_questions=args.max_questions)
    text = render_markdown(report) if args.format == "markdown" else json.dumps(
        report, indent=2, default=str
    )
    if args.out:
        Path(args.out).write_text(text)
        log.info("wrote %s (%d chars)", args.out, len(text))
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
