#!/usr/bin/env python3
"""Generate web/src/lib/locales.generated.ts from the ignis.ui_translation table.

The runtime dictionary is committed so every locale renders with no network call
and no flash of English. `npm run i18n:sync` re-collects the literals used in the
app, translates anything new, and rewrites this file.
"""
import hashlib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import psycopg

from i18n_glossary import GLOSSARY

WEB = "/workspace/project/project-08/web"
OUT = os.path.join(WEB, "src/lib/locales.generated.ts")
ENV = "/workspace/project/project-08/.env"
LOCALES = ["ar", "fr", "es", "de", "pt", "ru", "zh", "ja", "hi"]
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")


def db_url():
    env = open(ENV).read()
    return re.search(r'(postgresql://[^\s"\']+)', env).group(1).replace("&channel_binding=require", "")


def collect_strings():
    """Every literal passed to t("...") in the web sources."""
    found = set()
    for root, _, files in os.walk(os.path.join(WEB, "src")):
        for name in files:
            if not name.endswith((".ts", ".tsx")):
                continue
            src = open(os.path.join(root, name), encoding="utf-8").read()
            for m in re.finditer(r'\bt\(\s*("(?:[^"\\]|\\.)*")\s*\)', src):
                found.add(json.loads(m.group(1)))
            for m in re.finditer(r"\bt\(\s*`([^`$]*)`\s*\)", src):
                found.add(m.group(1))
    return sorted(s for s in found if s.strip())


def gtx(texts, locale, chunk=40):
    """Translate via Google's public endpoint, one request per newline-joined chunk."""
    out = []
    for i in range(0, len(texts), chunk):
        part = texts[i:i + chunk]
        q = urllib.parse.urlencode({
            "client": "gtx", "sl": "en", "tl": locale, "dt": "t", "q": "\n".join(part),
        })
        url = f"https://translate.googleapis.com/translate_a/single?{q}"
        for attempt in range(4):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = json.load(r)
                segs = [s[0] for s in data[0] if s and s[0]]
                joined = [x.strip() for x in "".join(segs).split("\n")]
                if len(joined) != len(part):
                    raise ValueError(f"alignment {len(joined)} != {len(part)}")
                out.extend(joined)
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(1.5 * (attempt + 1))
    return out


def fetch_missing(sql, strings):
    """Translate only what the table lacks, then insert it."""
    with sql.cursor() as cur:
        cur.execute("SELECT locale, source_en FROM ignis.ui_translation")
        have = {(loc, src) for loc, src in cur.fetchall()}

    missing = {loc: [s for s in strings if (loc, s) not in have] for loc in LOCALES}
    # Curated terms always win, so re-apply them on every run.
    for loc in LOCALES:
        missing[loc] = [s for s in missing[loc] if s not in GLOSSARY.get(loc, {})]
    todo = [(loc, texts) for loc, texts in missing.items() if texts]
    if not todo:
        print("  nothing new to translate")
    else:
        print("  translating new strings")

    for loc, texts in todo:
        print(f"  {loc}: {len(texts)} new")

    def work(item):
        loc, texts = item
        try:
            return loc, gtx(texts, loc), None
        except Exception as e:
            return loc, None, str(e)[:120]

    with ThreadPoolExecutor(max_workers=5) as pool:
        results = list(pool.map(work, todo))

    rows, failures = [], []
    for loc, translated, err in results:
        if err:
            failures.append(f"{loc}: {err}")
            continue
        for s, t in zip(missing[loc], translated):
            rows.append((loc, hashlib.md5(s.encode()).hexdigest(), s, t or s))

    # Curated overrides are written last so they take precedence in the upsert.
    for loc in LOCALES:
        for src, tr in GLOSSARY.get(loc, {}).items():
            if src in strings:
                rows.append((loc, hashlib.md5(src.encode()).hexdigest(), src, tr))
    print(f"  glossary overrides: {sum(1 for l in LOCALES for k in GLOSSARY.get(l, {}) if k in strings)}")

    if rows:
        with sql.cursor() as cur:
            cur.executemany(
                """INSERT INTO ignis.ui_translation (locale, source_hash, source_en, translated)
                   VALUES (%s, %s, %s, %s)
                   ON CONFLICT (locale, source_hash) DO UPDATE SET translated = EXCLUDED.translated""",
                rows,
            )
        sql.commit()
    if failures:
        print("  failures:", failures, file=sys.stderr)


def read_table(sql):
    with sql.cursor() as cur:
        cur.execute("SELECT locale, source_en, translated FROM ignis.ui_translation")
        table = {}
        for loc, src, tr in cur.fetchall():
            table.setdefault(loc, {})[src] = tr
    return table


def write_module(strings, table):
    lines = [
        "/* eslint-disable */",
        "// Generated by scripts/gen-locales.py - do not edit by hand.",
        "// Source of truth: ignis.ui_translation in Neon. Regenerate with `npm run i18n:sync`.",
        "",
        "/** English strings the app asks for, in source order. */",
        "export const SOURCE_STRINGS: readonly string[] = [",
    ]
    for s in strings:
        lines.append(f"  {json.dumps(s, ensure_ascii=False)},")
    lines += ["] as const;", "", "/** locale -> { english source: translation } */", "export const DICTIONARIES: Record<string, Record<string, string>> = {"]

    for loc in LOCALES:
        entries = table.get(loc, {})
        lines.append(f"  {json.dumps(loc)}: {{")
        for s in strings:
            tr = entries.get(s)
            # Omit identity mappings: the runtime already falls back to the key.
            if tr and tr != s:
                lines.append(f"    {json.dumps(s, ensure_ascii=False)}: {json.dumps(tr, ensure_ascii=False)},")
        lines.append("  },")
    lines += ["};", ""]

    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))

    covered = sum(1 for loc in LOCALES for s in strings if table.get(loc, {}).get(s))
    total = len(strings) * len(LOCALES)
    print(f"  wrote {OUT}")
    print(f"  coverage: {covered}/{total} ({100 * covered // max(total, 1)}%)")


def main():
    strings = collect_strings()
    print(f"{len(strings)} source strings x {len(LOCALES)} locales")
    with psycopg.connect(db_url()) as sql:
        fetch_missing(sql, strings)
        write_module(strings, read_table(sql))


if __name__ == "__main__":
    main()
