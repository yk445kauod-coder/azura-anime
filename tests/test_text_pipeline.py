"""Text normalisation, sentence splitting, chunking and finding extraction."""
from __future__ import annotations

import pytest

from lib.chunking import chunk_document, classify_kind, count_tokens
from lib.text import (clean_text, dehyphenate, domain_density, fix_ocr_artifacts,
                      remove_page_noise, sentences, sha256_text, strip_ligatures,
                      unicode_normalize, words)

# The extraction rules live in the cleaning stage; test them where they run.
from clean import extract_findings as extract_findings_for_test  # noqa: E402


def test_strip_ligatures_and_normalize():
    assert strip_ligatures("ﬂame spread") == "flame spread"
    assert strip_ligatures("microﬁre") == "microfire"
    assert unicode_normalize("\u00a0space") == " space"


def test_dehyphenate_joins_broken_words():
    assert dehyphenate("combus-\ntion") == "combustion"
    assert dehyphenate("well-known") == "well-known"  # hyphenated compounds survive


def test_remove_page_noise():
    raw = "Intro text\n\nPage 3 of 12\n\nmore text\n\nNASA/TM-2001-210202 7"
    out = remove_page_noise(raw)
    assert "Page 3 of 12" not in out
    assert "Intro text" in out and "more text" in out


def test_fix_ocr_artifacts():
    # U+FFFD replacement characters sitting between isolated word characters
    # are removed, joining the word back together.
    assert fix_ocr_artifacts("a\ufffd\ufffdb") == "ab"
    assert fix_ocr_artifacts("x\ufffdy") == "xy"
    # Runs of single-spaced capitals (letter-by-letter OCR) are rejoined.
    assert fix_ocr_artifacts("N A S A") == "NASA"


def test_clean_text_pipeline():
    raw = "  Flam e\n\n\nspread   over\n\nsolid\tfuels  "
    out = clean_text(raw)
    assert "\n\n\n" not in out
    assert "  " not in out
    assert out == out.strip()


def test_sha256_is_stable_and_sensitive():
    assert sha256_text("abc") == sha256_text("abc")
    assert sha256_text("abc") != sha256_text("abd")


def test_words_and_sentences():
    text = "Flame spread occurs in microgravity. It differs from Earth."
    assert len(words(text)) == 9
    sents = sentences(text)
    assert len(sents) == 2
    assert sents[0].endswith(".")


def test_domain_density_ranks_topical_text_higher():
    topical = "Microgravity flame spread extinction soot combustion " * 10
    off_topic = "The quarterly budget report was reviewed by the committee " * 10
    assert domain_density(topical) > domain_density(off_topic)


def test_classify_kind():
    assert classify_kind("Abstract") == "abstract"
    assert classify_kind("Results and Discussion") == "results"
    assert classify_kind("Conclusions") == "conclusion"
    assert classify_kind("References") == "reference"
    assert classify_kind("Document") == "body"


def test_chunk_document_respects_target_and_overlaps():
    body = " ".join(f"Sentence number {i} about flame spread in microgravity." for i in range(400))
    text = "Abstract\n\n" + body + "\n\nResults\n\n" + body
    chunks = chunk_document(text, target_tokens=300, overlap_tokens=40)
    assert len(chunks) > 2
    assert [c["ordinal"] for c in chunks] == list(range(len(chunks)))
    assert all(c["content"].strip() for c in chunks)
    assert all(c["token_count"] > 0 for c in chunks)
    # Heading awareness: sections are tracked, not collapsed to "Document".
    assert {c["section_path"] for c in chunks} >= {"Abstract", "Results"}
    # Overlap means neighbouring chunks share trailing content.
    assert chunks[0]["content"][-40:] != chunks[1]["content"][:40]


def test_chunk_document_drops_degenerate_input():
    assert chunk_document("tiny") == []


def test_count_tokens_monotonic():
    assert count_tokens("hello world") > 0
    assert count_tokens("hello world again and again") > count_tokens("hello world")


# ---------------------------------------------------------------- findings ---
def test_extract_flame_spread_rate():
    text = ("Measurements showed that the flame spread rate was 1.2 mm/s "
            "for the thin fuel in quiescent microgravity conditions.")
    findings = extract_findings_for_test(text, document_id=1)
    metrics = {f["metric"]: f for f in findings}
    assert "flame spread rate" in metrics
    f = metrics["flame spread rate"]
    assert f["value"] == pytest.approx(1.2)
    assert f["unit"] == "mm/s"
    assert "flame spread rate" in f["evidence_quote"].lower()
    assert f["extraction_method"] == "regex"


def test_extract_limiting_oxygen_index_range():
    text = "The limiting oxygen index was found to be 15 to 18 % for the material."
    findings = extract_findings_for_test(text, document_id=2)
    loi = [f for f in findings if f["metric"] == "limiting oxygen index"]
    assert loi, "LOI should be extracted"
    assert loi[0]["value"] == pytest.approx(15.0)
    assert loi[0]["value_max"] == pytest.approx(18.0)


def test_extract_findings_deduplicates_and_caps():
    text = ("The flame spread rate was 1.2 mm/s. " * 60)
    findings = extract_findings_for_test(text, document_id=3, limit=5)
    assert len(findings) <= 5
    keys = [(f["metric"], f["value"], f["unit"]) for f in findings]
    assert len(keys) == len(set(keys)), "identical matches must not be duplicated"


def test_extract_findings_returns_empty_without_metrics():
    assert extract_findings_for_test("No numbers here at all.", document_id=4) == []


def test_evidence_quotes_are_single_line_prose():
    """Regression: PDF hard wraps used to be stored verbatim inside quotes."""
    text = ("The flame spread rate was 1.2 mm/s in\nquiescent microgravity\nconditions.\n")
    findings = extract_findings_for_test(text, document_id=5)
    assert findings
    for f in findings:
        assert "\n" not in f["evidence_quote"]
        assert "  " not in f["evidence_quote"]
