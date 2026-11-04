"""Stage 2 — CLEAN & ANALYZE.

Transforms raw harvested artifacts into a canonical, deduplicated, quality-scored
corpus in Postgres:

  * parse fulltext TXT (fallback: extract PDF text with pypdf)
  * normalize/clean text (ligatures, hyphenation, page noise, whitespace)
  * upsert canonical ``document`` rows with metadata + analytics
  * detect duplicates (content hash, then title similarity) -> ``dedupe_map``
  * link documents to ``experiment`` records via alias matching
  * extract ``finding`` rows (metric/value/unit) with regex rules
  * write a manifest for auditability

Usage:
    python3 pipeline/clean.py
    python3 pipeline/clean.py --limit 50
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import psycopg  # noqa: E402

from lib import config  # noqa: E402
from lib.db import connect, fetch_all, finish_pipeline_run, start_pipeline_run  # noqa: E402
from lib.text import (clean_text, domain_density, keywords, sha256_bytes,  # noqa: E402
                      sha256_text, words)

log = logging.getLogger("ignis.clean")

MIN_WORDS = 120          # ignore stub/failed extractions
TITLE_SIM_THRESHOLD = 0.93


# --------------------------------------------------------------------------- #
# Parsing
# --------------------------------------------------------------------------- #
def extract_pdf_text(path: Path, max_pages: int = 0) -> str:
    try:
        from pypdf import PdfReader
    except Exception:
        return ""
    try:
        reader = PdfReader(str(path))
        pages = reader.pages if max_pages <= 0 else reader.pages[:max_pages]
        out = []
        for page in pages:
            try:
                out.append(page.extract_text() or "")
            except Exception:
                continue
        return "\n\n".join(out)
    except Exception as exc:
        log.warning("pdf extract failed %s: %s", path.name, exc)
        return ""


def guess_kind(payload: dict, title: str) -> str:
    sti = (payload.get("stiType") or "").lower()
    t = title.lower()
    if "workshop" in t or "symposium" in t or "proceedings" in t:
        return "workshop_proceedings"
    if sti in ("technical memorandum", "technical memo"):
        return "technical_memo"
    if "final report" in t:
        return "final_report"
    if sti in ("conference paper", "conference publication"):
        return "conference_paper"
    if sti in ("journal article", "technical publication"):
        return "journal_article"
    if "presentation" in sti or "presentation" in t:
        return "presentation"
    if "dataset" in sti:
        return "dataset"
    return "other"


def _str_list(value) -> list[str]:
    """Coerce an NTRS field into a list of plain strings (drops dicts/None)."""
    if value is None:
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [v for v in (value.get("name"), value.get("code")) if isinstance(v, str)]
    if isinstance(value, (list, tuple)):
        out: list[str] = []
        for item in value:
            out.extend(_str_list(item))
        return out
    return []


def _authors(payload: dict) -> tuple[list[str], list[str]]:
    """Extract (author names, affiliations) from NTRS authorAffiliations."""
    names: list[str] = []
    orgs: list[str] = []
    for entry in payload.get("authorAffiliations") or []:
        if not isinstance(entry, dict):
            continue
        meta = entry.get("meta") or {}
        author = meta.get("author") or {}
        if isinstance(author, dict) and author.get("name"):
            names.append(str(author["name"]))
        elif entry.get("name"):
            names.append(str(entry["name"]))
        org = meta.get("organization") or {}
        if isinstance(org, dict) and org.get("name"):
            orgs.append(str(org["name"]))
        for aff in entry.get("affiliations") or []:
            if isinstance(aff, str):
                orgs.append(aff)
    return names, orgs


def _center(payload: dict) -> str | None:
    center = payload.get("center")
    if isinstance(center, dict):
        code, name = center.get("code"), center.get("name")
        if name and code:
            return f"{name} ({code})"
        return name or code
    if isinstance(center, str):
        return center
    return None


def parse_date(value) -> str | None:
    if not value:
        return None
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", str(value))
    return m.group(0) if m else None


def quality_score(text: str, doc: dict) -> float:
    """Composite 0..1 usefulness score for corpus ranking / pruning."""
    n = len(words(text))
    length = min(1.0, n / 2500.0)
    density = domain_density(text)
    meta = 0.0
    if doc.get("abstract"):
        meta += 0.35
    if doc.get("keywords"):
        meta += 0.25
    if doc.get("report_numbers"):
        meta += 0.15
    if doc.get("authors"):
        meta += 0.25
    # Penalize boilerplate-heavy extractions.
    alpha = sum(ch.isalpha() for ch in text) / max(1, len(text))
    readability = min(1.0, alpha / 0.75)
    return round(0.35 * length + 0.35 * density + 0.15 * meta + 0.15 * readability, 4)


# --------------------------------------------------------------------------- #
# Finding extraction (rule-based, auditable)
# --------------------------------------------------------------------------- #
METRIC_PATTERNS: list[tuple[str, re.Pattern, str]] = [
    ("flame spread rate", re.compile(r"flame\s+spread\s+rate[s]?\s*(?:of|was|were|reached|up to|≈|~|=|:)?\s*([\d.]+)\s*(?:to\s*([\d.]+)\s*)?(mm/s|cm/s|m/s|mm/min)", re.I), "mm/s"),
    ("burning rate", re.compile(r"burn(?:ing)?\s+rate[s]?\s*(?:of|was|were|up to|≈|~|=|:)?\s*([\d.]+)\s*(?:to\s*([\d.]+)\s*)?(mm/s|cm/s|mg/s|g/s|mm/min)", re.I), "mm/s"),
    ("limiting oxygen index", re.compile(r"(?:limiting\s+oxygen\s+(?:index|concentration)|LOI|LOC)[^\d%]{0,20}([\d.]+)\s*(?:to\s*([\d.]+)\s*)?(%|vol\s*%|mole\s*fraction)", re.I), "vol%"),
    ("extinction time", re.compile(r"extinction\s+time[s]?\s*(?:of|was|were|≈|~|=|:)?\s*([\d.]+)\s*(?:to\s*([\d.]+)\s*)?(s|ms|min)", re.I), "s"),
    ("ignition delay", re.compile(r"ignition\s+delay\s*(?:time)?\s*(?:of|was|were|≈|~|=|:)?\s*([\d.]+)\s*(?:to\s*([\d.]+)\s*)?(s|ms)", re.I), "s"),
    ("smoke particle size", re.compile(r"(?:particle|aerosol|mean)\s+(?:diameter|size)[^\d]{0,25}([\d.]+)\s*(?:to\s*([\d.]+)\s*)?(nm|µm|um|micron[s]?)", re.I), "nm"),
    ("soot volume fraction", re.compile(r"soot\s+volume\s+fraction[^\d]{0,20}([\d.]+)\s*(?:to\s*([\d.]+)\s*)?(ppm|ppb|-)?", re.I), "ppm"),
    ("flame temperature", re.compile(r"(?:flame|adiabatic)\s+temperature[^\d]{0,20}([\d.]+)\s*(?:to\s*([\d.]+)\s*)?(K|°C|C)", re.I), "K"),
    ("pressure", re.compile(r"(?:ambient\s+)?pressure[^\d]{0,20}([\d.]+)\s*(?:to\s*([\d.]+)\s*)?(kPa|atm|bar|torr|psi)", re.I), "kPa"),
    ("gravity level", re.compile(r"([\d.]+)\s*(?:x|×)?\s*10\s*(?:\^|⁻|\*\*)?\s*[-−]?\s*(\d+)?\s*(?:g\b)", re.I), "g"),
    # The metrics below broaden corpus coverage. Each pattern requires the
    # quantity's own name and a unit on the same line, so precision stays high
    # even though the surrounding prose is unstructured.
    ("droplet diameter", re.compile(r"droplet\s+(?:diameter|size)[^\d]{0,20}([\d.]+)\s*(?:to\s*([\d.]+)\s*)?(mm|µm|um|micron[s]?)", re.I), "mm"),
    ("oxygen concentration", re.compile(r"(?:oxygen|O2)\s+(?:concentration|mole\s*fraction)[^\d%]{0,20}([\d.]+)\s*(?:to\s*([\d.]+)\s*)?(%|vol\s*%|mole\s*fraction)", re.I), "vol%"),
    ("flow velocity", re.compile(r"(?:opposed|forced|air|oxidizer)\s+flow\s+velocity[^\d]{0,20}([\d.]+)\s*(?:to\s*([\d.]+)\s*)?(mm/s|cm/s|m/s)", re.I), "cm/s"),
    ("flame length", re.compile(r"flame\s+length[s]?[^\d]{0,20}([\d.]+)\s*(?:to\s*([\d.]+)\s*)?(mm|cm|m)(?![a-zA-Z/])", re.I), "mm"),
    ("flame height", re.compile(r"flame\s+height[s]?[^\d]{0,20}([\d.]+)\s*(?:to\s*([\d.]+)\s*)?(mm|cm|m)(?![a-zA-Z/])", re.I), "mm"),
    ("burn time", re.compile(r"(?:burn|burning|combustion)\s+time[s]?[^\d]{0,20}([\d.]+)\s*(?:to\s*([\d.]+)\s*)?(s|ms|min)\b", re.I), "s"),
    ("heat release rate", re.compile(r"heat\s+release\s+rate[s]?[^\d]{0,20}([\d.]+)\s*(?:to\s*([\d.]+)\s*)?(kW|W|MW)", re.I), "W"),
]

EVIDENCE_SENTENCE = re.compile(r"[^.]*?\b(?:flame|fire|burn|smolder|ignit|extinct|soot|smoke|flammab)\w*[^.]*\.", re.I)


def _normalize_quote(quote: str) -> str:
    """Collapse PDF line breaks and stray spacing inside an evidence quote."""
    quote = re.sub(r"-\n(?=[a-z])", "", quote)      # rejoin hyphenated line breaks
    quote = re.sub(r"\s*\n\s*", " ", quote)          # hard wraps -> single space
    quote = re.sub(r"\s{2,}", " ", quote)
    return quote.strip()


def extract_findings(text: str, document_id: int, limit: int = 40) -> list[dict]:
    out: list[dict] = []
    seen: set[tuple] = set()
    # PDF text sometimes breaks a doubled unit letter across a space — "14.9m m"
    # for "14.9 mm", "5 c m" for "5 cm". Rejoin before matching so the unit is
    # read as written rather than as a bare metre.
    text = re.sub(r"(?<=\d)\s*m\s+m\b", " mm", text)
    text = re.sub(r"(?<=\d)\s+c\s+m\b", " cm", text)
    for metric, pattern, default_unit in METRIC_PATTERNS:
        for m in pattern.finditer(text):
            try:
                value = float(m.group(1))
            except (TypeError, ValueError):
                continue
            value_max = None
            unit = default_unit
            if m.lastindex and m.lastindex >= 2 and m.group(2):
                try:
                    value_max = float(m.group(2))
                except ValueError:
                    value_max = None
            if m.lastindex and m.lastindex >= 3 and m.group(3):
                unit = m.group(3)
            key = (metric, value, value_max, unit)
            if key in seen:
                continue
            seen.add(key)
            start = max(0, m.start() - 260)
            end = min(len(text), m.end() + 160)
            window = text[start:end]
            quote_m = EVIDENCE_SENTENCE.search(window)
            quote = (quote_m.group(0).strip() if quote_m else window.strip())[:600]
            # Extracted PDF text often contains hard line breaks mid-sentence;
            # normalise them so the stored quote reads as running prose and
            # stays comparable to the sentence text used for verification.
            quote = _normalize_quote(quote)
            out.append({
                "document_id": document_id,
                "statement": f"{metric} = {value}"
                             + (f"–{value_max}" if value_max else "")
                             + f" {unit}",
                "metric": metric,
                "value": value,
                "value_max": value_max,
                "unit": unit,
                "confidence": 0.62,
                "extraction_method": "regex",
                "evidence_quote": quote,
            })
            if len(out) >= limit:
                return out
    return out


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def load_candidates(limit: int | None) -> list[dict]:
    """Pick the single best artifact per raw record.

    A record usually has both a NTRS fulltext TXT and a PDF. The TXT is cleaner
    and cheaper to parse, so prefer it and never process both for one record.
    """
    sql = """
        SELECT DISTINCT ON (r.id)
               r.id AS raw_record_id, r.source_id, r.payload,
               a.id AS artifact_id, a.local_path, a.sha256, a.bytes, a.kind
          FROM ignis.raw_record r
          JOIN ignis.artifact a ON a.raw_record_id = r.id
         WHERE a.status = 'downloaded'
           AND a.kind IN ('fulltext_txt', 'pdf')
           AND NOT EXISTS (
                 SELECT 1 FROM ignis.artifact a2
                  WHERE a2.raw_record_id = r.id AND a2.document_id IS NOT NULL
               )
         ORDER BY r.id, (a.kind = 'fulltext_txt') DESC, a.bytes DESC
    """
    if limit:
        sql = f"SELECT * FROM ({sql}) sub LIMIT {int(limit)}"
    return fetch_all(sql)


def refresh_findings() -> dict:
    """Re-extract findings for every document from its stored cleaned text.

    Extraction rules evolve (regexes, quote normalisation), so this rebuilds
    ``ignis.finding`` in place without re-parsing the source PDFs.
    """
    rows = fetch_all(
        "SELECT document_id, content FROM ignis.document_text WHERE content IS NOT NULL"
    )
    stats = {"docs": 0, "findings": 0, "errors": 0}
    for row in rows:
        doc_id = row["document_id"]
        try:
            findings = extract_findings(row["content"], doc_id)
            with connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM ignis.finding WHERE document_id = %s", (doc_id,))
                    for f in findings:
                        cur.execute(
                            """INSERT INTO ignis.finding
                                 (document_id, statement, metric, value, value_max, unit, confidence,
                                  extraction_method, evidence_quote)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                            (doc_id, f["statement"], f["metric"], f["value"], f["value_max"],
                             f["unit"], f["confidence"], f["extraction_method"], f["evidence_quote"]),
                        )
                conn.commit()
            stats["docs"] += 1
            stats["findings"] += len(findings)
        except Exception:
            log.exception("finding refresh failed for document %s", doc_id)
            stats["errors"] += 1
    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description="IGNIS cleaning & analysis")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--refresh-findings", action="store_true",
                    help="re-extract findings for existing documents and exit")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    if args.refresh_findings:
        stats = refresh_findings()
        print(f"REFRESHED findings for {stats['docs']} documents: "
              f"{stats['findings']} findings, {stats['errors']} errors")
        return 0 if not stats["errors"] else 1

    run_id = start_pipeline_run("clean", {"limit": args.limit})
    rows = load_candidates(args.limit)
    log.info("candidates to clean: %d", len(rows))

    stats = {"docs": 0, "skipped": 0, "dupes": 0, "findings": 0, "links": 0, "words": 0, "errors": 0}
    manifest_path = config.MANIFEST_DIR / "documents.jsonl"
    manifest = manifest_path.open("a", encoding="utf-8")

    # Prepare duplicate-detection helpers.
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT id, title, content_sha256 FROM ignis.document WHERE content_sha256 IS NOT NULL")
            hash_index: dict[str, int] = {}
            title_index: list[tuple[int, str]] = []
            for r in cur.fetchall():
                hash_index[r["content_sha256"]] = r["id"]
                title_index.append((r["id"], r["title"]))
            cur.execute("SELECT code, id, aliases FROM ignis.experiment")
            experiments = cur.fetchall()

    for row in rows:
        payload = row["payload"]
        source_id = row["source_id"]
        try:
            raw = Path(row["local_path"]).read_text(encoding="utf-8", errors="replace") \
                if row["kind"] == "fulltext_txt" else extract_pdf_text(Path(row["local_path"]))
            text = clean_text(raw)
            if len(words(text)) < MIN_WORDS:
                with connect() as conn, conn.cursor() as cur:
                    cur.execute("UPDATE ignis.artifact SET status='skipped', error='too little text' WHERE id=%s",
                                (row["artifact_id"],))
                stats["skipped"] += 1
                continue

            title = (payload.get("title") or f"NTRS {source_id}").strip()
            abstract = clean_text(payload.get("abstract") or "") or None
            content_hash = sha256_text(text)
            wc = len(words(text))
            authors, affiliations = _authors(payload)

            doc = {
                "source": "NTRS", "source_id": source_id,
                "kind": guess_kind(payload, title), "title": title[:1000],
                "abstract": abstract,
                "authors": authors,
                "author_affiliations": affiliations,
                "report_numbers": _str_list(payload.get("otherReportNumbers")),
                "center": _center(payload),
                "distribution": payload.get("distribution") if isinstance(payload.get("distribution"), str) else None,
                "keywords": _str_list(payload.get("keywords")),
                "subject_categories": _str_list(payload.get("subjectCategories")),
                "landing_url": f"{config.NTRS_BASE}/citations/{source_id}",
                "published_date": parse_date(payload.get("distributionDate") or payload.get("created")),
                "submitted_date": payload.get("submittedDate"),
                "modified_date": payload.get("modified"),
                "word_count": wc, "char_count": len(text),
                "content_sha256": content_hash,
                "quality_score": quality_score(text, payload),
                "has_fulltext": True,
            }
            doc["keywords"] = doc["keywords"] or keywords(text, 12)

            with connect() as conn:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        INSERT INTO ignis.document
                          (source, source_id, kind, title, abstract, authors, author_affiliations,
                           report_numbers, center, distribution, keywords, subject_categories,
                           landing_url, published_date, submitted_date, modified_date,
                           word_count, char_count, content_sha256, quality_score, has_fulltext)
                        VALUES ('NTRS', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                                %s, %s, %s, %s, %s, %s, %s, true)
                        ON CONFLICT (source, source_id) DO UPDATE SET
                          title = EXCLUDED.title, abstract = EXCLUDED.abstract,
                          authors = EXCLUDED.authors, keywords = EXCLUDED.keywords,
                          word_count = EXCLUDED.word_count, char_count = EXCLUDED.char_count,
                          content_sha256 = EXCLUDED.content_sha256,
                          quality_score = EXCLUDED.quality_score, has_fulltext = true
                        RETURNING id
                        """,
                        (doc["source_id"], doc["kind"], doc["title"], doc["abstract"],
                         doc["authors"], doc["author_affiliations"], doc["report_numbers"],
                         doc["center"], doc["distribution"], doc["keywords"],
                         doc["subject_categories"], doc["landing_url"], doc["published_date"],
                         doc["submitted_date"], doc["modified_date"], doc["word_count"],
                         doc["char_count"], doc["content_sha256"], doc["quality_score"]),
                    )
                    document_id = cur.fetchone()["id"]

                    cur.execute(
                        """
                        INSERT INTO ignis.document_text (document_id, content, content_sha256, word_count, char_count)
                        VALUES (%s, %s, %s, %s, %s)
                        ON CONFLICT (document_id) DO UPDATE SET
                          content = EXCLUDED.content, content_sha256 = EXCLUDED.content_sha256,
                          word_count = EXCLUDED.word_count, char_count = EXCLUDED.char_count
                        """,
                        (document_id, text, content_hash, wc, len(text)),
                    )
                    cur.execute("UPDATE ignis.artifact SET document_id=%s WHERE raw_record_id=%s",
                                (document_id, row["raw_record_id"]))

                    # Deduplicate against existing corpus.
                    dup_of = hash_index.get(content_hash)
                    reason = "sha256" if dup_of else None
                    if dup_of and dup_of != document_id:
                        cur.execute(
                            """INSERT INTO ignis.dedupe_map (duplicate_document_id, canonical_document_id, reason, similarity)
                               VALUES (%s, %s, 'sha256', 1.0) ON CONFLICT DO NOTHING""",
                            (document_id, dup_of),
                        )
                        stats["dupes"] += 1
                    else:
                        hash_index[content_hash] = document_id
                        title_index.append((document_id, title))

                    # Link to known experiments by alias/code match.
                    low = f" {title.lower()} {text[:4000].lower()} "
                    for exp in experiments:
                        names = [exp["code"], *(exp["aliases"] or [])]
                        if any(f" {n.lower()} " in low for n in names if n):
                            cur.execute(
                                """INSERT INTO ignis.experiment_document (experiment_id, document_id, relation, confidence)
                                   VALUES (%s, %s, 'describes', 0.7) ON CONFLICT DO NOTHING""",
                                (exp["id"], document_id),
                            )
                            stats["links"] += 1

                    # Findings.
                    findings = extract_findings(text, document_id)
                    for f in findings:
                        cur.execute(
                            """INSERT INTO ignis.finding
                                 (document_id, statement, metric, value, value_max, unit, confidence,
                                  extraction_method, evidence_quote)
                               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                            (document_id, f["statement"], f["metric"], f["value"], f["value_max"],
                             f["unit"], f["confidence"], f["extraction_method"], f["evidence_quote"]),
                        )
                    stats["findings"] += len(findings)
                conn.commit()

            manifest.write(json.dumps({
                "document_id": document_id, "source_id": source_id, "title": title,
                "kind": doc["kind"], "words": wc, "chars": len(text),
                "quality": doc["quality_score"], "sha256": content_hash,
                "duplicate_of": hash_index.get(content_hash) if reason == "sha256" else None,
            }) + "\n")

            stats["docs"] += 1
            stats["words"] += wc
            if stats["docs"] % 25 == 0:
                log.info("cleaned %d docs (%d findings, %.1fk words)",
                         stats["docs"], stats["findings"], stats["words"] / 1000)
        except Exception as exc:
            stats["errors"] += 1
            log.warning("clean failed %s: %s", source_id, exc)

    manifest.close()
    log.info("clean complete: %s", stats)
    finish_pipeline_run(run_id, status="done", items_in=len(rows),
                        items_out=stats["docs"], bytes_in=0)
    print(f"\nCLEANED: {stats['docs']} documents, {stats['findings']} findings, "
          f"{stats['links']} experiment links, {stats['words'] / 1e6:.2f}M words, "
          f"{stats['dupes']} duplicates, {stats['skipped']} skipped, {stats['errors']} errors")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
