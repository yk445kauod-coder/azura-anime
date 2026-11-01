"""Deterministic extractive synthesis — the key-free fallback path.

When no LLM provider is configured (or the LLM call fails), IGNIS still
produces a grounded, citation-bearing answer by:
  1. selecting the most query-relevant sentences from retrieved chunks,
  2. ordering them into a coherent technical briefing,
  3. attaching the exact supporting quote + source for every claim.

This keeps the "evidence & sources" guarantee true even without an API key.
"""
from __future__ import annotations

import re

from .retrieve import Hit, _query_terms
from .text import sentences, words

_SECTION_ORDER = ["abstract", "results", "conclusion", "body", "reference", "table"]

# Sections that carry no scientific content; excluded from evidence.
_SKIP_SECTIONS = re.compile(
    r"^(acknowledg|references?|bibliograph|appendix|table of contents|contents|"
    r"nomenclature|abbreviations|distribution list|figure list|list of figures|"
    r"author|biograph|dedication|preface|foreword|abstract$)",
    re.I,
)

_CUES = re.compile(
    r"\b(microgravity|flame spread|extinction|ignition|flammab|limiting oxygen|burn(?:ing)? rate"
    r"|soot|smoke|suppress|fire safety|spacecraft|droplet|cool flame|smolder|oxygen concentration"
    r"|pressure|quiescent|buoyancy|convection|material|PMMA|SIBAL)\w*",
    re.I,
)

# Fragments typical of tables of contents, figure captions and reference lists.
_NOISE = re.compile(
    r"(\.{2,}|--\s|figure\s+\d|table\s+\d|eq\.|eqn\.|ref\.|et al\.|"
    r"^\s*\d+(\.\d+)*\s+[A-Z][a-z]+\s*$|"
    r"\b(?:NASA/TM|NTRS|doi:|http[s]?://)\b)",
    re.I,
)


# Clause continuations that never begin a well-formed extracted sentence.
# Articles and prepositions are already caught by the leading-capital check.
_MID_SENTENCE_STARTS = frozenset({
    "and", "or", "but", "which", "that", "whereas", "although", "though",
    "because", "since", "therefore", "thus", "hence", "moreover", "furthermore",
    "then", "than",
})


def _is_content_section(section: str | None) -> bool:
    return not (section and _SKIP_SECTIONS.match(section.strip()))


def _score_sentence(sent: str, terms: set[str]) -> float:
    if not (60 <= len(sent) <= 420):
        return -1.0
    toks = [w.lower() for w in words(sent)]
    if len(toks) < 9:
        return -1.0
    # A well-formed extracted sentence ends in terminal punctuation. This is the
    # only structural requirement, because PDF extraction routinely breaks
    # sentences across lines; everything else below is a soft penalty.
    if not sent.rstrip().endswith((".", "!", "?")):
        return -1.0
    if _NOISE.search(sent):
        return -1.0

    penalty = 0.0
    if not sent.lstrip()[:1].isupper():
        penalty += 0.35          # sliced mid-sentence
    if toks[0] in _MID_SENTENCE_STARTS:
        penalty += 0.45
    if sent.count("(") != sent.count(")"):
        penalty += 0.20
    caps = sum(1 for w in words(sent) if w[:1].isupper())
    if caps / len(toks) > 0.42:
        penalty += 0.50          # headings, tables of contents, reference lists

    tokset = set(toks)
    overlap = len(terms & tokset) / max(1, len(terms))
    cues = len(_CUES.findall(sent))
    numbers = len(re.findall(r"\d", sent))
    return (1.7 * overlap + 0.22 * min(cues, 5) + 0.0008 * min(numbers, 40)) - penalty


def best_sentences(hit: Hit, terms: set[str], max_n: int = 3) -> list[str]:
    if not _is_content_section(hit.section_path):
        return []
    sents = sentences(hit.content)
    scored = sorted(((_score_sentence(s, terms), s) for s in sents), key=lambda x: x[0], reverse=True)
    out, seen = [], set()
    for score, s in scored:
        if score <= 0:
            break
        key = s[:80].lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s.strip())
        if len(out) >= max_n:
            break
    return out


def _section_label(hit: Hit) -> str:
    if hit.section_path and hit.section_path.lower() not in ("document", "body"):
        return hit.section_path
    return hit.kind.replace("_", " ").title()


def synthesize_extractive(question: str, hits: list[Hit], sub_questions: list[str] | None = None) -> dict:
    """Build a structured, cited answer without an LLM."""
    terms = _query_terms(question)
    ordered = sorted(hits, key=lambda h: (_SECTION_ORDER.index(h.kind)
                                          if h.kind in _SECTION_ORDER else 99,
                                          -h.final_score))
    claims: list[dict] = []
    paragraphs: list[str] = []

    for hit in ordered:
        picked = best_sentences(hit, terms)
        if not picked:
            continue
        body = " ".join(picked)
        paragraphs.append(f"{body} [{len(claims) + 1}]")
        for s in picked:
            claims.append({
                "claim": s,
                "chunk_id": hit.chunk_id,
                "document_id": hit.document_id,
                "source_id": hit.source_id,
                "title": hit.title,
                "quote": s,
                "support_score": round(hit.final_score, 4),
                "landing_url": hit.landing_url,
                "section": _section_label(hit),
            })

    if not claims:
        return {
            "answer": "No sufficiently relevant passages were found in the IGNIS corpus "
                      "for this question. Try broadening the query or rephrasing it in "
                      "combustion terms (e.g. \"flame spread over PMMA in microgravity\").",
            "claims": [], "confidence": 0.0, "grounded": False,
        }

    header = f"Evidence-based synthesis for: {question}"
    lead = (f"IGNIS retrieved {len(hits)} passages across "
            f"{len({h.document_id for h in hits})} NASA documents. "
            f"The following findings are extracted verbatim from the corpus, "
            f"with bracketed citations to the evidence table below.")

    sections: list[str] = [header, "", lead, ""]
    if sub_questions:
        sections.append("Sub-questions resolved: " + "; ".join(sub_questions))
        sections.append("")

    # Group narrative by section kind for readability.
    grouped: dict[str, list[str]] = {}
    for hit in ordered:
        picked = best_sentences(hit, terms)
        if not picked:
            continue
        grouped.setdefault(_section_label(hit), []).append(" ".join(picked))

    idx = 0
    for label, texts in grouped.items():
        idx += 1
        sections.append(f"### {idx}. {label}")
        for t in texts[:3]:
            sections.append(f"- {t}")
        sections.append("")

    sections.append("### Evidence & limitations")
    sections.append(
        "- Every statement above is quoted from a NASA NTRS document; see the citation table.\n"
        "- This answer was produced by IGNIS's deterministic extractive synthesizer "
        "(no LLM provider configured), so it reports source wording rather than paraphrasing.\n"
        "- Numeric values reflect the conditions of their source experiment; do not extrapolate "
        "across facilities without checking the stated gravity level, pressure and O2 fraction."
    )

    avg_support = sum(c["support_score"] for c in claims) / len(claims)
    confidence = round(min(0.85, 0.35 + 0.5 * avg_support), 3)
    return {
        "answer": "\n".join(sections).strip(),
        "claims": claims,
        "confidence": confidence,
        "grounded": True,
    }


def synthesize_with_llm(question: str, hits: list[Hit], llm, sub_questions=None) -> dict:
    """LLM synthesis constrained to the retrieved evidence."""
    from .text import sha256_text

    evidence_blocks = []
    for i, h in enumerate(hits, 1):
        evidence_blocks.append(
            f"[{i}] {h.title} (NTRS {h.source_id}; section: {h.section_path or h.kind})\n"
            f"{h.content[:1800]}"
        )
    evidence = "\n\n".join(evidence_blocks)

    system = (
        "You are IGNIS, a scientific research analyst specialising in microgravity combustion "
        "and spacecraft fire safety. Answer ONLY from the provided evidence. "
        "Cite every factual claim with bracketed evidence numbers like [2]. "
        "If the evidence is insufficient, say so explicitly. "
        "Never invent values, experiment names, or citations. "
        "Return JSON: {\"answer\": string (markdown), \"claims\": "
        "[{\"claim\": string, \"evidence\": int, \"quote\": string}], \"confidence\": 0..1}"
    )
    user = f"Question: {question}\n\nEvidence:\n{evidence}"
    if sub_questions:
        user += "\n\nSub-questions to address: " + "; ".join(sub_questions)

    data = llm.complete_json(system, user, max_tokens=1800)
    answer = (data.get("answer") or "").strip()
    if not answer:
        return synthesize_extractive(question, hits, sub_questions)

    claims = []
    for c in data.get("claims", []) or []:
        try:
            ev = int(c.get("evidence", 1))
        except (TypeError, ValueError):
            ev = 1
        hit = hits[ev - 1] if 1 <= ev <= len(hits) else (hits[0] if hits else None)
        if not hit:
            continue
        claims.append({
            "claim": str(c.get("claim", ""))[:1000],
            "chunk_id": hit.chunk_id,
            "document_id": hit.document_id,
            "source_id": hit.source_id,
            "title": hit.title,
            "quote": str(c.get("quote", ""))[:1000],
            "support_score": round(hit.final_score, 4),
            "landing_url": hit.landing_url,
            "section": hit.section_path or hit.kind,
        })
    confidence = data.get("confidence")
    try:
        confidence = float(confidence)
    except (TypeError, ValueError):
        confidence = round(min(0.9, 0.4 + 0.05 * len(claims)), 3)
    return {"answer": answer, "claims": claims,
            "confidence": round(confidence, 3), "grounded": bool(claims)}
