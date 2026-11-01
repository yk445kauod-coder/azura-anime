"""IGNIS agentic RAG engine.

A bounded, observable agent loop over the corpus:

    PLAN  -> decompose the question into sub-questions
    RETRIEVE -> hybrid (keyword + vector) search per sub-question
    GRADE -> judge whether retrieved evidence is sufficient
    EXPAND -> if not, rewrite/expand the query and retrieve again
    SYNTHESIZE -> produce a cited answer (LLM or deterministic extractive)
    VERIFY -> check each claim is actually supported by its cited chunk

Every step is persisted to ``agent_step`` / ``retrieval_hit`` / ``citation``
so answers are auditable end-to-end.
"""
from __future__ import annotations

import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from . import config
from .db import connect, execute, fetch_one
from .llm import LLM
from .retrieve import Hit, grade_hits, retrieve
from .synth import synthesize_extractive, synthesize_with_llm
from .text import words

log = logging.getLogger("ignis.agent")

MAX_ITERATIONS = 3
MIN_GRADE_SCORE = 0.28

# Domain lexicon used for query expansion when evidence is thin.
EXPANSIONS: dict[str, list[str]] = {
    "flame": ["flame spread", "flame structure", "diffusion flame", "premixed flame"],
    "spread": ["flame spread rate", "spread rate over solid fuel"],
    "extinguish": ["extinction limit", "flame extinguishment", "radiative extinction"],
    "extinction": ["extinction limit", "flame extinguishment", "quenching distance"],
    "ignit": ["ignition delay", "ignition limit", "ignitability"],
    "smolder": ["smoldering combustion", "forward smolder", "reverse smolder"],
    "smoke": ["smoke aerosol", "particle size distribution", "smoke detector"],
    "soot": ["soot volume fraction", "soot formation", "soot radiation"],
    "material": ["material flammability", "PMMA", "SIBAL", "cotton-fiberglass"],
    "oxygen": ["limiting oxygen concentration", "oxygen concentration fire safety"],
    "pressure": ["ambient pressure", "sub-atmospheric pressure combustion"],
    "spacecraft": ["spacecraft fire safety", "spacecraft atmosphere", "cabin fire"],
    "suppress": ["fire suppression", "gaseous suppression agent", "inert gas suppression"],
    "droplet": ["droplet combustion", "droplet burning rate", "binary fuel droplet"],
    "cool": ["cool flame", "low temperature ignition", "two-stage ignition"],
    "safety": ["fire safety", "flammability limits", "fire risk"],
    "microgravity": ["microgravity combustion", "reduced gravity flame"],
}


@dataclass
class AgentResult:
    run_id: str
    question: str
    answer: str
    claims: list[dict]
    evidence: list[dict]
    sub_questions: list[str]
    confidence: float
    grounded: bool
    iterations: int
    trace: list[dict] = field(default_factory=list)
    latency_ms: int = 0
    provider: str = "none"
    model: str = ""

    def as_dict(self) -> dict:
        return {
            "run_id": self.run_id, "question": self.question, "answer": self.answer,
            "claims": self.claims, "evidence": self.evidence,
            "sub_questions": self.sub_questions, "confidence": self.confidence,
            "grounded": self.grounded, "iterations": self.iterations,
            "trace": self.trace, "latency_ms": self.latency_ms,
            "provider": self.provider, "model": self.model,
        }


# --------------------------------------------------------------------------- #
# Planning
# --------------------------------------------------------------------------- #
PLAN_SYSTEM = (
    "You decompose research questions about microgravity combustion and spacecraft fire "
    "safety into 2-4 focused retrieval sub-questions. Return JSON: "
    '{"sub_questions": ["..."], "key_terms": ["..."]}. '
    "Sub-questions must be independently searchable scientific queries. "
    "Do not answer the question."
)


def heuristic_plan(question: str) -> list[str]:
    """Key-free decomposition: split on conjunctions, then add facet probes."""
    low = question.lower().strip(" ?.")
    subs: list[str] = []
    for part in low.replace(" and ", "|").replace(" vs ", "|").replace(" versus ", "|").split("|"):
        part = part.strip()
        if len(part) > 8:
            subs.append(part)
    subs = subs[:2]

    facets = [
        ("extinction", "extinction limit and flame extinguishment"),
        ("ignition", "ignition limits of solid fuels"),
        ("spread", "flame spread rate over solid fuel"),
        ("smoke", "smoke and soot production"),
        ("detect", "fire detection and smoke detection"),
        ("suppress", "fire suppression in spacecraft"),
        ("oxygen", "limiting oxygen concentration and atmosphere"),
        ("pressure", "pressure effects on combustion"),
    ]
    for needle, probe in facets:
        if needle in low and len(subs) < 4:
            subs.append(probe)
    if len(subs) < 2:
        subs.append(f"{question} experimental results")
    if len(subs) < 3:
        subs.append("spacecraft fire safety implications microgravity")
    return subs[:4]


def plan(question: str, llm: LLM) -> tuple[list[str], list[str]]:
    if llm.available:
        try:
            data = llm.complete_json(PLAN_SYSTEM, f"Question: {question}", max_tokens=400)
            subs = [s for s in (data.get("sub_questions") or []) if isinstance(s, str) and len(s) > 4]
            terms = [t for t in (data.get("key_terms") or []) if isinstance(t, str)]
            if subs:
                return subs[:4], terms[:12]
        except Exception as exc:
            log.warning("LLM planning failed, using heuristic plan: %s", exc)
    return heuristic_plan(question), []


def expand_query(sub_question: str, already_seen: set[str]) -> str:
    """Rewrite a thin sub-question into a richer domain query."""
    low = sub_question.lower()
    additions: list[str] = []
    for stem, variants in EXPANSIONS.items():
        if stem in low:
            additions.extend(variants)
    additions = [a for a in additions if a.lower() not in low][:3]
    if not additions:
        additions = ["microgravity combustion experimental results"]
    expanded = sub_question + " " + " ".join(additions)
    return expanded if expanded not in already_seen else sub_question + " spacecraft fire safety"


def heuristic_grade(hits: list[Hit], sub_question: str) -> tuple[str, float]:
    """Judge evidence sufficiency without an LLM."""
    if not hits:
        return "insufficient", 0.0
    top = hits[:4]
    best = max(h.rerank_score for h in top)
    avg = sum(h.rerank_score for h in top) / len(top)
    if best >= 0.5 and avg >= 0.3:
        return "sufficient", round(avg, 4)
    if best >= MIN_GRADE_SCORE:
        return "partial", round(avg, 4)
    return "insufficient", round(avg, 4)


GRADE_SYSTEM = (
    "You are a strict retrieval grader for a scientific corpus on microgravity combustion. "
    "Given a sub-question and numbered evidence passages, decide whether the evidence is "
    "sufficient to answer it. Return JSON: "
    '{"verdict": "sufficient"|"partial"|"insufficient", "score": 0..1, '
    '"relevant": [evidence numbers], "missing": "what is missing"}.'
)


def llm_grade(sub_question: str, hits: list[Hit], llm: LLM) -> tuple[str, float, list[int]]:
    blocks = [f"[{i}] {h.title}\n{h.content[:900]}" for i, h in enumerate(hits[:8], 1)]
    try:
        data = llm.complete_json(
            GRADE_SYSTEM,
            f"Sub-question: {sub_question}\n\nEvidence:\n" + "\n\n".join(blocks),
            max_tokens=300,
        )
        verdict = str(data.get("verdict", "partial")).lower()
        if verdict not in ("sufficient", "partial", "insufficient"):
            verdict = "partial"
        try:
            score = float(data.get("score", 0.5))
        except (TypeError, ValueError):
            score = 0.5
        relevant = [int(x) for x in (data.get("relevant") or []) if str(x).isdigit()]
        return verdict, round(score, 4), relevant
    except Exception as exc:
        log.warning("LLM grading failed: %s", exc)
        verdict, score = heuristic_grade(hits, sub_question)
        return verdict, score, list(range(1, min(len(hits), 4) + 1))


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #
def _persist_step(run_id: str, index: int, node: str, *, thought: str | None = None,
                  tool: str | None = None, tool_input: Any = None,
                  tool_output: Any = None, tokens: int = 0, latency_ms: int = 0) -> None:
    import psycopg

    try:
        execute(
            """INSERT INTO ignis.agent_step
                 (run_id, step_index, node, thought, tool, tool_input, tool_output, tokens, latency_ms)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (run_id, step_index) DO NOTHING""",
            (run_id, index, node, thought, tool,
             psycopg.types.json.Jsonb(tool_input) if tool_input is not None else None,
             psycopg.types.json.Jsonb(tool_output) if tool_output is not None else None,
             tokens, latency_ms),
        )
    except Exception as exc:  # never let observability break an answer
        log.debug("step persist failed: %s", exc)


def _persist_hits(run_id: str, sub_question: str, hits: list[Hit], offset: int) -> None:
    if not hits:
        return
    try:
        with connect() as conn, conn.cursor() as cur:
            for i, h in enumerate(hits, 1):
                cur.execute(
                    """INSERT INTO ignis.retrieval_hit
                         (run_id, sub_question, chunk_id, rank, vector_score, keyword_score,
                          fused_score, rerank_score, relevance, used_in_answer)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (run_id, sub_question, h.chunk_id, offset + i,
                     h.vector_score, h.keyword_score, h.fused_score, h.rerank_score,
                     h.relevance, h.relevance != "irrelevant"),
                )
            conn.commit()
    except Exception as exc:
        log.debug("hit persist failed: %s", exc)


def _persist_citations(run_id: str, claims: list[dict]) -> None:
    if not claims:
        return
    try:
        with connect() as conn, conn.cursor() as cur:
            for c in claims:
                cur.execute(
                    """INSERT INTO ignis.citation
                         (run_id, claim, chunk_id, document_id, quote, support_score)
                       VALUES (%s, %s, %s, %s, %s, %s)""",
                    (run_id, c.get("claim", "")[:2000], c.get("chunk_id"),
                     c.get("document_id"), (c.get("quote") or "")[:2000],
                     c.get("support_score")),
                )
            conn.commit()
    except Exception as exc:
        log.debug("citation persist failed: %s", exc)


# --------------------------------------------------------------------------- #
# Verification
# --------------------------------------------------------------------------- #
def verify_claims(claims: list[dict], hits_by_chunk: dict[int, Hit]) -> tuple[list[dict], float]:
    """Confirm each claim's quote really appears in its cited chunk."""
    supported = 0
    for c in claims:
        hit = hits_by_chunk.get(c.get("chunk_id"))
        quote = (c.get("quote") or c.get("claim") or "").strip()
        ok = False
        if hit and quote:
            chunk_low = hit.content.lower()
            probe = quote.lower()[:180]
            if probe and probe in chunk_low:
                ok = True
            else:
                qt = {w.lower() for w in words(quote) if len(w) > 3}
                ct = {w.lower() for w in words(hit.content)}
                ok = bool(qt) and (len(qt & ct) / len(qt)) >= 0.6
        c["verified"] = ok
        supported += int(ok)
    ratio = supported / len(claims) if claims else 0.0
    return claims, round(ratio, 4)


# --------------------------------------------------------------------------- #
# Main loop
# --------------------------------------------------------------------------- #
def run_agent(
    question: str,
    *,
    conversation_id: str | None = None,
    k: int = 8,
    max_iterations: int = MAX_ITERATIONS,
    use_llm: bool = True,
) -> AgentResult:
    t0 = time.time()
    llm = LLM(enabled=use_llm)

    run_id = str(uuid.uuid4())
    trace: list[dict] = []
    step = 0

    def step_no() -> int:
        nonlocal step
        step += 1
        return step

    try:
        execute(
            """INSERT INTO ignis.agent_run (id, conversation_id, question, status)
               VALUES (%s, %s, %s, 'running')""",
            (run_id, conversation_id, question),
        )
    except Exception as exc:
        log.debug("agent_run insert failed: %s", exc)

    # ---------------- PLAN ----------------
    t = time.time()
    sub_questions, key_terms = plan(question, llm)
    trace.append({"node": "plan", "sub_questions": sub_questions, "key_terms": key_terms})
    _persist_step(run_id, step_no(), "plan",
                  thought=f"Decomposed into {len(sub_questions)} sub-questions",
                  tool="plan", tool_output={"sub_questions": sub_questions},
                  latency_ms=int((time.time() - t) * 1000))

    # ---------------- RETRIEVE / GRADE / EXPAND ----------------
    all_hits: dict[int, Hit] = {}
    graded: dict[int, str] = {}
    iterations = 0

    for iteration in range(max_iterations):
        iterations = iteration + 1
        thin: list[str] = []

        for sq in sub_questions:
            t = time.time()
            hits = retrieve(sq, k=k, pool=80)
            latency = int((time.time() - t) * 1000)

            if llm.available:
                verdict, score, relevant = llm_grade(sq, hits, llm)
                for i, h in enumerate(hits, 1):
                    h.relevance = "relevant" if i in relevant else (
                        "partial" if i <= 4 else "irrelevant")
            else:
                hits = grade_hits(sq, hits)
                verdict, score = heuristic_grade(hits, sq)
                relevant = []

            trace.append({"node": "retrieve", "iteration": iteration, "sub_question": sq,
                          "verdict": verdict, "score": score, "n_hits": len(hits),
                          "top_score": round(hits[0].final_score, 4) if hits else 0.0})
            _persist_step(run_id, step_no(), "retrieve",
                          thought=f"sub-question: {sq}",
                          tool="hybrid_search",
                          tool_input={"query": sq, "k": k},
                          tool_output={"verdict": verdict, "score": score,
                                       "hits": [h.as_dict() for h in hits[:k]]},
                          latency_ms=latency)

            for h in hits:
                h.sub_question = sq
                prev = all_hits.get(h.chunk_id)
                if prev is None or h.final_score > prev.final_score:
                    all_hits[h.chunk_id] = h
            _persist_hits(run_id, sq, hits, offset=iteration * 1000)

            if verdict != "sufficient":
                thin.append(sq)

        if not thin or iteration == max_iterations - 1:
            break

        # ---------------- EXPAND ----------------
        seen = set(sub_questions)
        new_subs = []
        for sq in thin[:2]:
            expanded = expand_query(sq, seen)
            if expanded not in seen:
                new_subs.append(expanded)
                seen.add(expanded)
        trace.append({"node": "expand", "from": thin[:2], "to": new_subs})
        _persist_step(run_id, step_no(), "expand",
                      thought=f"{len(thin)} sub-question(s) had thin evidence; expanding",
                      tool="query_expansion", tool_output={"new_sub_questions": new_subs})
        if not new_subs:
            break
        sub_questions = new_subs + sub_questions[:1]

    # ---------------- SELECT EVIDENCE ----------------
    ranked = sorted(all_hits.values(), key=lambda h: h.final_score, reverse=True)
    relevant_hits = [h for h in ranked if h.relevance != "irrelevant"][:k]
    if not relevant_hits:
        relevant_hits = ranked[:k]

    # ---------------- SYNTHESIZE ----------------
    t = time.time()
    if llm.available:
        try:
            synth = synthesize_with_llm(question, relevant_hits, llm, sub_questions)
            provider, model = llm.provider, llm.model
        except Exception as exc:
            log.warning("LLM synthesis failed, falling back to extractive: %s", exc)
            synth = synthesize_extractive(question, relevant_hits, sub_questions)
            provider, model = "extractive", "ignis-extractive"
    else:
        synth = synthesize_extractive(question, relevant_hits, sub_questions)
        provider, model = "extractive", "ignis-extractive"

    _persist_step(run_id, step_no(), "synthesize",
                  thought=f"synthesized with {provider}",
                  tool="synthesize",
                  tool_output={"provider": provider, "claims": len(synth["claims"])},
                  latency_ms=int((time.time() - t) * 1000))

    # ---------------- VERIFY ----------------
    hits_by_chunk = {h.chunk_id: h for h in relevant_hits}
    claims, verified_ratio = verify_claims(synth["claims"], hits_by_chunk)
    trace.append({"node": "verify", "claims": len(claims), "verified_ratio": verified_ratio})
    _persist_step(run_id, step_no(), "verify",
                  thought=f"{verified_ratio:.0%} of claims traced to their source chunk",
                  tool="verify", tool_output={"verified_ratio": verified_ratio})

    _persist_citations(run_id, claims)

    confidence = round(min(0.95, 0.55 * synth["confidence"] + 0.45 * verified_ratio), 3)
    latency_ms = int((time.time() - t0) * 1000)

    try:
        import psycopg

        execute(
            """UPDATE ignis.agent_run
                  SET status='done', plan=%s, iterations=%s, answer=%s,
                      answer_confidence=%s, latency_ms=%s, finished_at=now()
                WHERE id=%s""",
            (psycopg.types.json.Jsonb({"sub_questions": sub_questions,
                                       "key_terms": key_terms}),
             iterations, synth["answer"], confidence, latency_ms, run_id),
        )
    except Exception as exc:
        log.debug("agent_run update failed: %s", exc)

    return AgentResult(
        run_id=run_id, question=question, answer=synth["answer"], claims=claims,
        evidence=[h.as_dict() for h in relevant_hits], sub_questions=sub_questions,
        confidence=confidence, grounded=bool(claims) and verified_ratio > 0.3,
        iterations=iterations, trace=trace, latency_ms=latency_ms,
        provider=provider, model=model,
    )


# --------------------------------------------------------------------------- #
# Comparative analysis (feature 4)
# --------------------------------------------------------------------------- #
def compare_experiments(experiment_codes: list[str], topic: str | None = None) -> dict:
    """Build a side-by-side comparison of experiments + their findings."""
    from .db import fetch_all

    exps = fetch_all(
        """SELECT e.*, f.code AS facility_code, f.name AS facility_name, f.platform
             FROM ignis.experiment e LEFT JOIN ignis.facility f ON f.id = e.facility_id
            WHERE e.code = ANY(%s)""",
        (experiment_codes,),
    )
    if not exps:
        return {"experiments": [], "dimensions": [], "findings": {}, "note": "no matching experiments"}

    ids = [e["id"] for e in exps]
    # Findings carry no direct experiment link; membership is defined by the
    # document -> experiment association, so derive the experiment id from the join.
    findings = fetch_all(
        """SELECT ed.experiment_id, f.metric, f.value, f.value_max, f.unit, f.statement,
                  f.confidence, d.title, d.source_id
             FROM ignis.finding f
             JOIN ignis.experiment_document ed ON ed.document_id = f.document_id
             JOIN ignis.document d ON d.id = f.document_id
            WHERE ed.experiment_id = ANY(%s)
              AND (%s::text IS NULL OR f.metric ILIKE '%%' || %s::text || '%%')
            ORDER BY ed.experiment_id, f.metric""",
        (ids, topic, topic),
    )
    doc_counts = fetch_all(
        """SELECT experiment_id, count(*) AS n
             FROM ignis.experiment_document WHERE experiment_id = ANY(%s)
            GROUP BY experiment_id""",
        (ids,),
    )
    counts = {r["experiment_id"]: r["n"] for r in doc_counts}

    by_exp: dict[int, list[dict]] = {}
    for f in findings:
        by_exp.setdefault(f["experiment_id"], []).append({
            "metric": f["metric"], "value": f["value"], "value_max": f["value_max"],
            "unit": f["unit"], "statement": f["statement"], "confidence": f["confidence"],
            "document_title": f["title"], "source_id": f["source_id"],
        })

    dimensions = ["campaign", "facility_code", "platform", "status", "gravity_level",
                  "fuel_type", "ambient_gas", "pressure_kpa", "o2_fraction", "ignition_source"]

    return {
        "experiments": [{
            "id": e["id"], "code": e["code"], "name": e["name"], "campaign": e["campaign"],
            "facility": e["facility_code"], "facility_name": e["facility_name"],
            "platform": e["platform"], "status": e["status"],
            "gravity_level": e["gravity_level"], "fuel_type": e["fuel_type"],
            "ambient_gas": e["ambient_gas"], "pressure_kpa": e["pressure_kpa"],
            "o2_fraction": e["o2_fraction"], "ignition_source": e["ignition_source"],
            "objective": e["objective"], "summary": e["summary"],
            "document_count": counts.get(e["id"], 0),
        } for e in exps],
        "dimensions": dimensions,
        "findings": {str(e["id"]): by_exp.get(e["id"], []) for e in exps},
        "metric_matrix": _metric_matrix(exps, by_exp),
    }


def _metric_matrix(exps: list[dict], by_exp: dict[int, list[dict]]) -> list[dict]:
    """Pivot findings into a metric x experiment table for the UI."""
    metrics: dict[str, dict[int, list[dict]]] = {}
    for e in exps:
        for f in by_exp.get(e["id"], []):
            metrics.setdefault(f["metric"], {}).setdefault(e["id"], []).append(f)
    rows = []
    for metric, per_exp in sorted(metrics.items()):
        rows.append({
            "metric": metric,
            "values": {str(eid): [
                {"value": v["value"], "value_max": v["value_max"], "unit": v["unit"]}
                for v in vals] for eid, vals in per_exp.items()},
        })
    return rows
