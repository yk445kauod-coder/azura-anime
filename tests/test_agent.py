"""Agentic RAG: planning, grading, verification, persistence and the full loop."""
from __future__ import annotations

import pytest

from conftest import needs_db
from lib.agent import (AgentResult, compare_experiments, expand_query,
                       heuristic_grade, heuristic_plan, run_agent, verify_claims)
from lib.retrieve import Hit, rerank


def _hit(chunk_id: int, content: str) -> Hit:
    return Hit(chunk_id=chunk_id, document_id=1, title="Doc", source_id="1",
               ordinal=0, kind="results", section_path="Results", content=content,
               final_score=0.7, rerank_score=0.7)


# --------------------------------------------------------------- planning ---
def test_heuristic_plan_decomposes_compound_question():
    subs = heuristic_plan("How does flame spread and extinction differ in microgravity?")
    assert 2 <= len(subs) <= 4
    assert all(isinstance(s, str) and len(s) > 8 for s in subs)


def test_heuristic_plan_adds_facet_probes():
    subs = heuristic_plan("What limits smoke detection and suppression in spacecraft?")
    joined = " ".join(subs).lower()
    assert "smoke" in joined
    assert "suppress" in joined


def test_heuristic_plan_always_returns_searchable_queries():
    subs = heuristic_plan("Fire?")
    assert len(subs) >= 2
    assert all(len(s) > 5 for s in subs)


# -------------------------------------------------------------- expansion ---
def test_expand_query_adds_domain_synonyms():
    out = expand_query("flame extinction limits", set())
    assert "extinction" in out
    assert any(k in out for k in ("extinguishment", "quenching", "limit"))
    assert out != "flame extinction limits"


def test_expand_query_falls_back_for_unknown_terms():
    out = expand_query("quokka habitat", set())
    assert "microgravity combustion" in out or "spacecraft fire safety" in out


# --------------------------------------------------------------- grading ----
def test_heuristic_grade_sufficient_on_strong_hits():
    q = "flame spread microgravity"
    hits = [_hit(i, "flame spread microgravity over solid fuel was measured") for i in range(4)]
    rerank(q, hits)
    verdict, score = heuristic_grade(hits, q)
    assert verdict in ("sufficient", "partial")
    assert 0.0 <= score <= 1.0


def test_heuristic_grade_insufficient_on_empty():
    assert heuristic_grade([], "anything") == ("insufficient", 0.0)


def test_heuristic_grade_insufficient_on_irrelevant():
    q = "flame spread microgravity"
    hits = [_hit(i, "quarterly budget and staffing review for the committee") for i in range(4)]
    rerank(q, hits)
    verdict, _ = heuristic_grade(hits, q)
    assert verdict == "insufficient"


# ------------------------------------------------------------ verification --
def test_verify_claims_accepts_exact_quote():
    hit = _hit(1, "The flame spread rate was 1.2 mm/s in quiescent microgravity.")
    claims = [{"claim": "spread rate 1.2 mm/s", "chunk_id": 1,
               "quote": "The flame spread rate was 1.2 mm/s in quiescent microgravity."}]
    out, ratio = verify_claims(claims, {1: hit})
    assert out[0]["verified"] is True
    assert ratio == 1.0


def test_verify_claims_rejects_fabricated_quote():
    hit = _hit(1, "The flame spread rate was 1.2 mm/s in quiescent microgravity.")
    claims = [{"claim": "invented", "chunk_id": 1,
               "quote": "combustion of liquid hydrogen produced 9000 K plasmas"}]
    out, ratio = verify_claims(claims, {1: hit})
    assert out[0]["verified"] is False
    assert ratio == 0.0


def test_verify_claims_handles_missing_chunk():
    claims = [{"claim": "x", "chunk_id": 999, "quote": "something"}]
    out, ratio = verify_claims(claims, {})
    assert out[0]["verified"] is False
    assert ratio == 0.0


def test_verify_claims_tolerates_paraphrase():
    hit = _hit(1, "Flame spread rate over the solid fuel increased with oxygen concentration.")
    claims = [{"claim": "rate rose with O2", "chunk_id": 1,
               "quote": "Flame spread rate over the solid fuel increased with oxygen concentration"}]
    out, ratio = verify_claims(claims, {1: hit})
    assert out[0]["verified"] is True
    assert ratio == 1.0


# ------------------------------------------------------------------- loop ---
@needs_db
def test_run_agent_produces_grounded_cited_answer():
    res = run_agent("How does flame spread over solid fuels differ in microgravity?",
                    k=5, use_llm=False)
    assert isinstance(res, AgentResult)
    assert res.answer and len(res.answer) > 200
    assert res.claims, "a grounded answer must carry claims"
    assert res.evidence, "evidence pack must not be empty"
    assert 0.0 <= res.confidence <= 1.0
    assert res.iterations >= 1
    assert res.run_id


@needs_db
def test_run_agent_claims_link_to_retrieved_chunks():
    res = run_agent("What is the limiting oxygen concentration for spacecraft?", k=5, use_llm=False)
    chunk_ids = {h["chunk_id"] for h in res.evidence}
    assert res.claims
    assert all(c["chunk_id"] in chunk_ids for c in res.claims)
    assert all(c.get("landing_url", "").startswith("https://ntrs.nasa.gov") for c in res.claims)


@needs_db
def test_run_agent_trace_records_every_node():
    res = run_agent("Why is fire suppression harder in microgravity?", k=5, use_llm=False)
    nodes = [t["node"] for t in res.trace]
    assert nodes[0] == "plan"
    assert "retrieve" in nodes
    assert "verify" in nodes


@needs_db
def test_run_agent_persists_run_steps_and_citations():
    from lib.db import fetch_all

    res = run_agent("How do smoke particles behave in microgravity?", k=5, use_llm=False)
    steps = fetch_all("SELECT node FROM ignis.agent_step WHERE run_id=%s ORDER BY step_index",
                      (res.run_id,))
    hits = fetch_all("SELECT count(*) AS n FROM ignis.retrieval_hit WHERE run_id=%s",
                     (res.run_id,))
    cites = fetch_all("SELECT count(*) AS n FROM ignis.citation WHERE run_id=%s", (res.run_id,))
    run = fetch_all("SELECT status, answer_confidence FROM ignis.agent_run WHERE id=%s",
                    (res.run_id,))
    assert {s["node"] for s in steps} >= {"plan", "retrieve", "synthesize", "verify"}
    assert hits[0]["n"] > 0
    assert cites[0]["n"] == len(res.claims)
    assert run[0]["status"] == "done"


@needs_db
def test_run_agent_is_question_sensitive():
    a = run_agent("flame spread rate over PMMA", k=4, use_llm=False)
    b = run_agent("smoke detector particle size in spacecraft", k=4, use_llm=False)
    assert a.answer != b.answer
    assert {h["chunk_id"] for h in a.evidence} != {h["chunk_id"] for h in b.evidence}


# ------------------------------------------------------------- comparison ---
@needs_db
def test_compare_experiments_returns_condition_matrix():
    from lib.db import fetch_all

    codes = [r["code"] for r in fetch_all("SELECT code FROM ignis.experiment ORDER BY code LIMIT 3")]
    out = compare_experiments(codes)
    assert len(out["experiments"]) == len(codes)
    assert "gravity_level" in out["dimensions"]
    assert set(out["findings"].keys()) == {str(e["id"]) for e in out["experiments"]}
    assert isinstance(out["metric_matrix"], list)


@needs_db
def test_compare_experiments_surfaces_findings():
    """Regression: findings were keyed off a NULL finding.experiment_id.

    Membership must be derived from the document -> experiment association, so
    campaigns with linked documents must report a non-empty metric matrix.
    """
    out = compare_experiments(["SAME", "SAFFIRE", "BASS-II"])
    assert out["metric_matrix"], "linked campaigns must yield comparable metrics"
    per_exp = out["findings"]
    assert any(rows for rows in per_exp.values()), "at least one campaign has findings"
    for rows in per_exp.values():
        for f in rows:
            assert f["metric"] and f["statement"]


@needs_db
def test_compare_experiments_values_carry_units():
    out = compare_experiments(["SAME", "SAFFIRE"])
    seen = 0
    for row in out["metric_matrix"]:
        for vals in row["values"].values():
            for v in vals:
                assert v["value"] is not None
                assert v["unit"] is None or isinstance(v["unit"], str)
                seen += 1
    assert seen > 0


@needs_db
def test_compare_experiments_unknown_code():
    out = compare_experiments(["NOT_A_REAL_CAMPAIGN"])
    assert out["experiments"] == []
    assert "note" in out


@needs_db
def test_compare_experiments_metric_filter():
    from lib.db import fetch_all

    codes = [r["code"] for r in fetch_all("SELECT code FROM ignis.experiment ORDER BY code LIMIT 4")]
    out = compare_experiments(codes, topic="flame")
    for rows in out["metric_matrix"]:
        assert "flame" in rows["metric"].lower()
