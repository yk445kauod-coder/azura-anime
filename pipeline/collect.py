"""Stage 1 — COLLECT.

Harvest NASA NTRS microgravity-combustion / spacecraft-fire-safety material:

  1. Run a broad, curated set of NTRS search queries.
  2. Persist every citation record verbatim into ``ignis.raw_record``.
  3. Download fulltext TXT (clean text for RAG) and PDFs (raw corpus volume)
     into local cache + Neon S3 object storage, recording ``ignis.artifact``.

Usage:
    python3 pipeline/collect.py                 # default target ~300 MB
    python3 pipeline/collect.py --target-mb 260
    python3 pipeline/collect.py --txt-only      # skip PDFs (fast, small)
"""
from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import psycopg  # noqa: E402

from lib import config, http, storage  # noqa: E402
from lib.db import connect, finish_pipeline_run, start_pipeline_run  # noqa: E402
from lib.text import sha256_bytes  # noqa: E402

log = logging.getLogger("ignis.collect")

# Curated query set spanning the whole challenge domain.
QUERIES: list[str] = [
    "microgravity combustion",
    "microgravity flame spread",
    "spacecraft fire safety",
    "fire safety microgravity",
    "flame spread microgravity solid fuel",
    "solid fuel ignition extinction microgravity",
    "smoldering combustion microgravity",
    "smoke aerosol measurement experiment",
    "spacecraft smoke detection",
    "BASS burning suppression solids",
    "BASS-II burning suppression solids",
    "SAFFIRE spacecraft fire experiment",
    "SAME smoke aerosol measurement experiment",
    "FLEX flame extinguishment experiment",
    "FLEX-2 droplet combustion",
    "SoFIE solid fuel ignition extinction",
    "cool flames investigation microgravity",
    "advanced combustion via microgravity experiments",
    "droplet combustion microgravity",
    "flame extinguishment microgravity",
    "flammability limits microgravity",
    "limiting oxygen index microgravity",
    "diffusion flame microgravity",
    "premixed flame microgravity",
    "soot formation microgravity flame",
    "radiative extinction flame microgravity",
    "buoyancy effects combustion microgravity",
    "spacecraft material flammability",
    "ISS combustion integrated rack",
    "Cygnus fire experiment",
    "low gravity combustion",
    "reduced gravity flame",
    "parabolic flight combustion experiment",
    "drop tower combustion experiment",
    "quiescent microgravity flame",
    "fire detection spacecraft atmosphere",
    "oxygen concentration fire safety spacecraft",
    "fire suppression spacecraft microgravity",
    "microgravity combustion workshop",
    "spacecraft fire risk microgravity",
]


def _search(query: str, page_from: int, page_size: int) -> dict:
    return http.get_json(
        f"{config.NTRS_API}/citations/search",
        params={"q": query, "page.size": page_size, "page.from": page_from},
    )


def harvest_metadata(page_size: int = 100, max_per_query: int = 300) -> tuple[int, int]:
    """Run all queries, upserting raw records. Returns (queries, records)."""
    total_records = 0
    with connect() as conn:
        for query in QUERIES:
            got = 0
            page_from = 0
            while got < max_per_query:
                try:
                    payload = _search(query, page_from, page_size)
                except Exception as exc:  # network hiccup on one query must not abort the run
                    log.warning("search failed q=%r from=%d: %s", query, page_from, exc)
                    break
                results = payload.get("results", [])
                if not results:
                    break
                with conn.cursor() as cur:
                    for rec in results:
                        cur.execute(
                            """
                            INSERT INTO ignis.raw_record
                              (source, source_id, endpoint, query, payload, payload_sha256)
                            VALUES ('NTRS', %s, %s, %s, %s, %s)
                            ON CONFLICT (source, source_id) DO UPDATE
                              SET payload = EXCLUDED.payload,
                                  payload_sha256 = EXCLUDED.payload_sha256
                            """,
                            (
                                str(rec.get("id")),
                                f"{config.NTRS_API}/citations/search",
                                query,
                                psycopg.types.json.Jsonb(rec),
                                sha256_bytes(
                                    __import__("json").dumps(rec, sort_keys=True).encode()
                                ),
                            ),
                        )
                conn.commit()
                got += len(results)
                total_records += len(results)
                page_from += page_size
                if len(results) < page_size:
                    break
                time.sleep(0.4)
            log.info("query %-55s -> %4d records", query[:55], got)
    return len(QUERIES), total_records


def _existing_artifact(url: str) -> dict | None:
    from lib.db import fetch_one

    return fetch_one("SELECT * FROM ignis.artifact WHERE url = %s", (url,))


def _record_artifact(
    raw_record_id: int,
    url: str,
    kind: str,
    *,
    local_path: str | None,
    s3_key: str | None,
    nbytes: int,
    sha: str,
    mimetype: str,
    status: str,
) -> None:
    from lib.db import execute

    execute(
        """
        INSERT INTO ignis.artifact
          (raw_record_id, kind, url, s3_bucket, s3_key, local_path, bytes, sha256, mimetype, status)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (url) DO UPDATE SET
          s3_key = EXCLUDED.s3_key, local_path = EXCLUDED.local_path,
          bytes = EXCLUDED.bytes, sha256 = EXCLUDED.sha256,
          status = EXCLUDED.status, error = NULL, fetched_at = now()
        """,
        (raw_record_id, kind, url, config.S3_BUCKET, s3_key, local_path,
         nbytes, sha, mimetype, status),
    )


def download_candidates() -> list[dict]:
    """Return documents with downloadable fulltext, ordered by domain relevance."""
    from lib.db import fetch_all

    return fetch_all(
        """
        WITH scored AS (
          SELECT r.id AS raw_record_id,
                 r.source_id,
                 r.payload->>'title' AS title,
                 r.payload->>'abstract' AS abstract,
                 r.payload->'downloads' AS downloads,
                 coalesce(r.payload->>'distribution', '') AS distribution,
                 (
                   CASE WHEN r.payload->>'abstract' ILIKE '%microgravity%' THEN 3 ELSE 0 END
                 + CASE WHEN r.payload->>'abstract' ILIKE '%flame%'       THEN 2 ELSE 0 END
                 + CASE WHEN r.payload->>'abstract' ILIKE '%fire%'        THEN 2 ELSE 0 END
                 + CASE WHEN r.payload->>'abstract' ILIKE '%combustion%'  THEN 2 ELSE 0 END
                 + CASE WHEN r.payload->>'abstract' ILIKE '%extinction%'  THEN 1 ELSE 0 END
                 + CASE WHEN r.payload->>'abstract' ILIKE '%flammab%'     THEN 1 ELSE 0 END
                 + CASE WHEN r.payload->>'abstract' ILIKE '%spacecraft%'  THEN 1 ELSE 0 END
                 + CASE WHEN r.payload->>'abstract' ILIKE '%smoke%'       THEN 1 ELSE 0 END
                 + CASE WHEN r.payload->>'abstract' ILIKE '%soot%'        THEN 1 ELSE 0 END
                 + CASE WHEN r.payload->>'abstract' ILIKE '%droplet%'     THEN 1 ELSE 0 END
                 ) AS relevance,
                 jsonb_array_length(coalesce(r.payload->'downloads', '[]'::jsonb)) AS ndl
          FROM ignis.raw_record r
        )
        SELECT * FROM scored
        WHERE ndl > 0
        ORDER BY relevance DESC, ndl DESC
        """
    )


def _local_or_fetch(url: str, local: Path, timeout: int) -> tuple[bytes, bool]:
    """Return file bytes, reusing the local cache when present."""
    if local.exists() and local.stat().st_size > 0:
        return local.read_bytes(), True
    data = http.get_bytes(url, timeout=timeout)
    local.parent.mkdir(parents=True, exist_ok=True)
    local.write_bytes(data)
    return data, False


def _store(raw_record_id: int, url: str, kind: str, source_id: str,
           filename: str, mimetype: str, timeout: int) -> int:
    """Download (or reuse) one artifact, mirror it to S3, record it. Returns bytes."""
    local = config.RAW_DIR / ("txt" if kind == "fulltext_txt" else "pdf") / filename
    data, cached = _local_or_fetch(url, local, timeout)
    s3key = storage.key_for(source_id, "fulltext" if kind == "fulltext_txt" else "pdf", filename)
    if not cached or not storage.exists(s3key):
        try:
            storage.put_bytes(s3key, data, mimetype)
        except Exception as exc:
            log.warning("s3 upload failed for %s: %s", s3key, exc)
            s3key = None
    _record_artifact(
        raw_record_id, url, kind, local_path=str(local), s3_key=s3key,
        nbytes=len(data), sha=sha256_bytes(data), mimetype=mimetype, status="downloaded",
    )
    return len(data)


def download_artifacts(target_bytes: int, txt_only: bool = False) -> dict:
    """Download fulltext + PDFs until ``target_bytes`` of raw corpus is stored."""
    candidates = download_candidates()
    log.info("download candidates with fulltext: %d", len(candidates))

    stats = {"txt": 0, "pdf": 0, "bytes": 0, "errors": 0, "skipped": 0, "cached": 0}

    for cand in candidates:
        if stats["bytes"] >= target_bytes:
            log.info("target reached (%.1f MB)", stats["bytes"] / 1e6)
            break

        links = None
        for dl in cand.get("downloads") or []:
            if isinstance(dl.get("links"), dict):
                links = dl["links"]
                break
        if not links:
            continue
        source_id = cand["source_id"]

        # ---- fulltext TXT (highest value per byte: clean RAG text) ----
        txt_path = links.get("fulltext") or links.get("original")
        if txt_path and txt_path.endswith(".txt"):
            url = f"{config.NTRS_BASE}{txt_path}"
            existing = _existing_artifact(url)
            if existing and existing["status"] == "downloaded":
                stats["skipped"] += 1
                stats["bytes"] += int(existing["bytes"] or 0)
            else:
                try:
                    n = _store(cand["raw_record_id"], url, "fulltext_txt", source_id,
                               f"{source_id}.txt", "text/plain", 120)
                    stats["txt"] += 1
                    stats["bytes"] += n
                except Exception as exc:
                    stats["errors"] += 1
                    log.warning("txt download failed %s: %s", source_id, exc)

        # ---- PDF (raw corpus volume) ----
        if txt_only or stats["bytes"] >= target_bytes:
            continue
        pdf_path = links.get("pdf") or links.get("original")
        if not pdf_path or not pdf_path.endswith(".pdf"):
            continue
        url = f"{config.NTRS_BASE}{pdf_path}"
        existing = _existing_artifact(url)
        if existing and existing["status"] == "downloaded":
            stats["skipped"] += 1
            stats["bytes"] += int(existing["bytes"] or 0)
            continue
        try:
            n = _store(cand["raw_record_id"], url, "pdf", source_id,
                       f"{source_id}.pdf", "application/pdf", 900)
            stats["pdf"] += 1
            stats["bytes"] += n
            log.info("pdf %-12s %6.2f MB  (total %.1f MB)",
                     source_id, n / 1e6, stats["bytes"] / 1e6)
        except Exception as exc:
            stats["errors"] += 1
            log.warning("pdf download failed %s: %s", source_id, exc)

    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description="IGNIS collection pipeline")
    ap.add_argument("--target-mb", type=float, default=300.0,
                    help="target raw corpus size in MB (default 300)")
    ap.add_argument("--txt-only", action="store_true", help="skip PDFs")
    ap.add_argument("--skip-metadata", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    run_id = start_pipeline_run("collect", {"target_mb": args.target_mb, "txt_only": args.txt_only})
    target = int(args.target_mb * 1024 * 1024)
    try:
        nq = nr = 0
        if not args.skip_metadata:
            nq, nr = harvest_metadata()
            log.info("metadata harvest: %d queries, %d records", nq, nr)
        stats = download_artifacts(target, txt_only=args.txt_only)
        log.info("downloads: %s", stats)
        finish_pipeline_run(
            run_id, status="done", items_in=nr,
            items_out=stats["txt"] + stats["pdf"], bytes_in=stats["bytes"],
        )
        print(f"\nCOLLECTED: {stats['txt']} fulltext + {stats['pdf']} PDFs "
              f"= {stats['bytes'] / 1e6:.1f} MB (errors={stats['errors']})")
        return 0
    except Exception as exc:
        finish_pipeline_run(run_id, status="failed", error=str(exc))
        log.exception("collect failed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
