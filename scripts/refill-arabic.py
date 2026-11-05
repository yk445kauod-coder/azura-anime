#!/usr/bin/env python3
"""Backfill `web/src/lib/locales.generated.ts` for Arabic from the LIVE worker.

The runtime `/api/translate` endpoint fills missing strings a page at a time,
but the committed Arabic dictionary only covered 127 strings, so on first load
most of the UI rendered English. This script collects every literal the app
passes to t(...) (same regex as gen-locales.py), asks the live endpoint for the
whole missing set once, and rewrites the bundle so Arabic is complete offline.

Run from repo root:  python3 scripts/refill-arabic.py
Idempotent: only strings marked "_MISSING_" / absent / identical are re-sent.
"""
import json
import os
import re
import urllib.request
import urllib.parse

WEB = os.path.join(os.path.dirname(__file__), "..", "web")
SRC = os.path.join(WEB, "src")
OUT = os.path.join(SRC, "lib", "locales.generated.ts")
ENDPOINT = "https://ignis-project.pages.dev/api/translate"


def collect_strings():
    found = set()
    for root, _, names in os.walk(SRC):
        for name in names:
            if not name.endswith((".ts", ".tsx")):
                continue
            src = open(os.path.join(root, name), encoding="utf-8").read()
            for m in re.finditer(r'\bt\(\s*("(?:[^"\\]|\\.)*")\s*\)', src):
                found.add(json.loads(m.group(1)))
            for m in re.finditer(r"\bt\(\s*`([^`$]*)`\s*\)", src):
                found.add(m.group(1))
    return sorted(s for s in found if s.strip())


def translate(strings, locale="ar"):
    out = []
    chunk = 40  # small enough that the model reliably emits one item per input
    for i in range(0, len(strings), chunk):
        part = strings[i:i + chunk]
        payload = json.dumps({"locale": locale, "strings": part}).encode("utf-8")
        req = urllib.request.Request(ENDPOINT, data=payload,
                                     headers={"Content-Type": "application/json",
                                              "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
                                              "Origin": "https://ignis-project.pages.dev",
                                              "Referer": "https://ignis-project.pages.dev/"})
        with urllib.request.urlopen(req, timeout=180) as r:
            data = json.load(r)
        got = data.get("translations", {})
        for s in part:
            out.append(got.get(s) or s)
        print(f"  batch {i // chunk + 1}/{(len(strings) + chunk - 1) // chunk}: {len(part)} strings")
    return out


def main():
    strings = collect_strings()
    print(f"{len(strings)} source strings")

    body = open(OUT, encoding="utf-8").read()

    # Existing ar dict (parsed by brace depth) → keep non-identity entries.
    start = body.find('"ar": {')
    existing: dict[str, str] = {}
    locale_block_end = body.find("},", start) if start >= 0 else -1
    if start >= 0:
        depth = 1
        i = start + len('"ar": {')
        while depth and i < len(body):
            if body[i] == "{":
                depth += 1
            elif body[i] == "}":
                depth -= 1
            i += 1
        locale_block_end = i - 1  # index of the closing '}'
        block = body[start:i]
        for m in re.finditer(r'"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"', block):
            key, val = json.loads('"' + m.group(1) + '"'), json.loads('"' + m.group(2) + '"')
            if val and val != key:
                existing[key] = val

    missing = [s for s in strings if s not in existing]
    print(f"existing ar: {len(existing)}  missing: {len(missing)}")

    # Iterate until no progress: the model can truncate long batches, and a
    # short model reply would otherwise leave many strings permanently English.
    for attempt in range(4):
        todo = [s for s in missing if s not in existing]
        if not todo:
            break
        print(f"pass {attempt + 1}: {len(todo)} to translate")
        for s, tr in zip(todo, translate(todo)):
            if tr and tr.strip() and tr.strip() != s and s not in existing:
                existing[s] = tr.strip()
    remaining = [s for s in strings if s not in existing]
    if remaining:
        print("STILL MISSING (kept English):", remaining)

    # Rebuild the whole ar block, keeping identity-aware filtering.
    new_block = '  "ar": {\n'
    for s in strings:
        tr = existing.get(s)
        if tr and tr != s:
            new_block += f"    {json.dumps(s, ensure_ascii=False)}: {json.dumps(tr, ensure_ascii=False)},\n"
    new_block += "  },"

    if start >= 0:
        out = body[:start] + new_block + body[locale_block_end + 1:]
    else:
        # No ar key yet: insert before the closing of DICTIONARIES.
        marker = body.rstrip().rfind("};")
        out = body[:marker] + new_block + body[marker:]
    # dedupe possible double spaces from the marker splice
    out = out.replace("  }\n};\n", "  },\n};\n")
    open(OUT, "w", encoding="utf-8").write(out)
    print(f"wrote {OUT}")

    covered = sum(1 for s in strings if existing.get(s) and existing[s] != s)
    print(f"ar coverage: {covered}/{len(strings)} ({100 * covered // max(len(strings), 1)}%)")


if __name__ == "__main__":
    main()