"""Mirror the local NTRS corpus into Neon S3 object storage and verify it.

`collect.py` uploads each artifact as it downloads, so the bucket is normally
already populated. This command re-syncs the local cache to the bucket and
reconciles `ignis.artifact`, which is what you want after a partial run, a
bucket change, or to confirm the corpus is intact.

    python3 pipeline/upload_corpus.py             # upload anything missing
    python3 pipeline/upload_corpus.py --verify    # report only, change nothing
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib import config, storage  # noqa: E402
from lib.db import execute, fetch_all  # noqa: E402

log = logging.getLogger("ignis.upload")

KIND_BY_DIR = {"pdf": "pdf", "txt": "fulltext_txt"}
MIMETYPE = {"pdf": "application/pdf", "txt": "text/plain"}


def local_artifacts() -> list[dict]:
    """Every local corpus file, paired with the key it should live under."""
    out: list[dict] = []
    for subdir, kind in KIND_BY_DIR.items():
        root = config.RAW_DIR / subdir
        if not root.exists():
            continue
        for path in sorted(root.iterdir()):
            if not path.is_file() or path.name.startswith("."):
                continue
            source_id = path.stem
            key = storage.key_for(source_id, "fulltext" if kind == "fulltext_txt" else "pdf",
                                  path.name)
            out.append({"path": path, "key": key, "kind": kind, "source_id": source_id,
                        "bytes": path.stat().st_size})
    return out


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def bucket_inventory() -> dict[str, int]:
    """Map every object under the prefix to its size."""
    client = storage.client()
    found: dict[str, int] = {}
    for page in client.get_paginator("list_objects_v2").paginate(
        Bucket=config.S3_BUCKET, Prefix=config.S3_PREFIX
    ):
        for obj in page.get("Contents", []):
            found[obj["Key"]] = obj["Size"]
    return found


def main() -> int:
    ap = argparse.ArgumentParser(description="Mirror the IGNIS corpus into S3")
    ap.add_argument("--verify", action="store_true",
                    help="report drift without uploading anything")
    ap.add_argument("--limit", type=int, default=None, help="stop after N files")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    files = local_artifacts()
    if args.limit:
        files = files[: args.limit]
    local_bytes = sum(f["bytes"] for f in files)
    log.info("local corpus: %d files, %.1f MB", len(files), local_bytes / 1048576)

    inventory = bucket_inventory()
    remote_bytes = sum(inventory.values())
    log.info("bucket: %d objects, %.1f MB under %s/",
             len(inventory), remote_bytes / 1048576, config.S3_PREFIX)

    uploaded = skipped = failed = 0
    for item in files:
        key, size = item["key"], item["bytes"]
        if inventory.get(key) == size:
            skipped += 1
            continue
        if args.verify:
            log.warning("would upload %s (%d bytes)", key, size)
            continue
        try:
            storage.upload_file(str(item["path"]), key)
            inventory[key] = size
            uploaded += 1
            execute(
                """UPDATE ignis.artifact
                      SET s3_bucket = %s, s3_key = %s, bytes = %s,
                          sha256 = coalesce(sha256, %s), status = 'stored'
                    WHERE local_path = %s OR url LIKE %s""",
                (config.S3_BUCKET, key, size, sha256_of(item["path"]),
                 str(item["path"]), f"%{item['path'].name}"),
            )
        except Exception as exc:  # keep going; report at the end
            failed += 1
            log.error("upload failed for %s: %s", key, exc)

    missing_remote = [f["key"] for f in files if f["key"] not in inventory]
    rows = fetch_all(
        """SELECT count(*) AS n,
                  count(s3_key) AS with_key,
                  pg_size_pretty(sum(coalesce(bytes, 0))) AS bytes
             FROM ignis.artifact"""
    )[0]

    report = {
        "local_files": len(files),
        "local_mb": round(local_bytes / 1048576, 1),
        "bucket_objects": len(inventory),
        "bucket_mb": round(sum(inventory.values()) / 1048576, 1),
        "uploaded": uploaded,
        "already_present": skipped,
        "failed": failed,
        "missing_from_bucket": len(missing_remote),
        "artifact_rows": rows["n"],
        "artifact_rows_with_s3_key": rows["with_key"],
        "artifact_bytes": rows["bytes"],
        "verify_only": args.verify,
    }
    log.info("RESULT %s", json.dumps(report))
    if missing_remote:
        for key in missing_remote[:10]:
            log.error("not in bucket: %s", key)
        return 1
    if failed:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
