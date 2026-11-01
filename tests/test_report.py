"""Research report assembly: structure, citations, and no-LLM fallback."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))

import report as report_mod  # noqa: E402


QUESTIONS = ["How does flame spread differ in microgravity?",
             "What limits flame extinction in microgravity?"]


@pytest.fixture(scope="module")
def built():
    """One real report over the live corpus, deterministic (no LLM)."""
    return report_mod.build_report("fire suppression in microgravity",
                                   QUESTIONS, k=4, use_llm=False)


def test_report_has_required_sections(built):
    for key in ("topic", "summary", "key_findings", "evidence", "limitations",
                "references", "metrics", "corpus", "generated_at"):
        assert key in built, f"missing section: {key}"


def test_every_finding_is_grounded_and_cited(built):
    assert built["key_findings"], "report produced no findings"
    for f in built["key_findings"]:
        assert f["question"]
        assert f["answer"].strip()
        assert f["citations"], f"finding has no citations: {f['question']}"


def test_citations_point_at_real_chunks(built):
    for f in built["key_findings"]:
        for c in f["citations"]:
            assert c.get("chunk_id") is not None
            assert c.get("document_id") is not None
            assert c.get("source_id")
            assert (c.get("landing_url") or "").startswith("https://ntrs.nasa.gov/")


def test_evidence_table_is_deduplicated_and_ranked(built):
    rows = built["evidence"]
    assert rows, "evidence table is empty"
    keys = [(r["source_id"], r.get("quote")) for r in rows]
    assert len(keys) == len(set(keys)), "evidence table has duplicates"
    scores = [r.get("support_score") or 0 for r in rows]
    assert scores == sorted(scores, reverse=True), "evidence not ranked by support"


def test_references_resolve_to_ntrs(built):
    assert built["references"]
    for r in built["references"]:
        assert r["landing_url"] == f"https://ntrs.nasa.gov/citations/{r['source_id']}"


def test_metrics_are_consistent(built):
    m = built["metrics"]
    assert m["questions"] == len(built["key_findings"])
    assert m["grounded"] == sum(1 for f in built["key_findings"] if f["grounded"])
    assert m["citations"] == sum(len(f["citations"]) for f in built["key_findings"])
    assert m["unique_sources"] == len(built["references"])
    assert 0 <= m["mean_confidence"] <= 1
    assert m["latency_ms"] > 0


def test_fallback_summary_is_used_without_llm(built):
    assert built["generator"]["provider"] == "extractive"
    assert built["generator"]["model"] == "ignis-extractive"
    assert "NASA documents" in built["summary"]
    assert built["limitations"], "limitations must be stated"


def test_markdown_renders_core_sections(built):
    md = report_mod.render_markdown(built)
    for heading in ("# IGNIS Research Report", "## Executive Summary", "## Key Findings",
                    "## Evidence Table", "## References", "## Data Limitations"):
        assert heading in md, f"missing markdown heading: {heading}"
    assert "https://ntrs.nasa.gov/citations/" in md


def test_report_is_topic_sensitive(built):
    other = report_mod.build_report("smoke detection in spacecraft",
                                    QUESTIONS, k=4, use_llm=False)
    assert built["topic"] != other["topic"]
    a = {r["source_id"] for r in built["evidence"]}
    b = {r["source_id"] for r in other["evidence"]}
    assert a != b, "different topics returned identical evidence"
