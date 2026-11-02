#!/usr/bin/env python3
"""
Generate workers/ignis-agent/src/fonts.ts — the TrueType subsets embedded into
exported PDFs.

Why embed a font at all: the PDF base-14 fonts (Helvetica etc.) are Latin-1
only, so Arabic text silently disappears from a report. The only way to put
Arabic in a PDF is to embed a font with the glyphs and a /ToUnicode map.

We use IBM Plex Sans Arabic (SIL Open Font License 1.1), which is designed for
Arabic-Latin mixing, so one family covers both scripts in a single embedded
subset. Latin-only runs use the base-14 Helvetica, so the font is only embedded
when a document actually contains Arabic — this keeps most reports small.

Regenerate with:
    python3 workers/ignis-agent/tools/build_fonts.py
Requires: fonttools, and network access for the upstream font files.
"""
from __future__ import annotations

import base64
import gzip
import io
import sys
import urllib.request
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.subset import Options, Subsetter

OUT = Path(__file__).resolve().parent.parent / "src" / "fonts.ts"
CACHE = Path("/tmp/ignis-fonts")

BASE = "https://raw.githubusercontent.com/google/fonts/main/ofl/ibmplexsansarabic"
SOURCES = {
    "regular": f"{BASE}/IBMPlexSansArabic-Regular.ttf",
    "bold": f"{BASE}/IBMPlexSansArabic-Bold.ttf",
}

# Latin + punctuation so one font covers mixed reports, then the Arabic block,
# presentation forms (shaped glyphs) and Arabic-Indic digits.
UNICODES = (
    "U+0020-007E,U+00A0-00FF,U+2000-206F,"
    "U+060C,U+061B,U+061F,U+0621-063A,U+0640-064A,U+0651,U+0652,"
    "U+0660-0669,U+066A-066D,U+0670-06D3,U+06F0-06F9,U+FE70-FEFF"
)

# Arabic presentation forms that fonttools will not synthesise by default.
# Without these, a shaped letter such as an initial meem has no glyph.
EXTRA_FE = [
    *range(0xFE70, 0xFEFF),
]

# Ligatures the shaper produces that are not part of the FE70-FEFF block.
EXTRA_LIGATURES = ["lam_alef", "lam_alef_madda", "lam_alef_hamzaabove", "lam_alef_hamzabelow"]


def fetch(name: str, url: str) -> bytes:
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = CACHE / f"{name}.ttf"
    if not dest.exists():
        print(f"  downloading {url}")
        with urllib.request.urlopen(url, timeout=120) as r:
            dest.write_bytes(r.read())
    return dest.read_bytes()


def subset(data: bytes) -> TTFont:
    font = TTFont(io.BytesIO(data))
    opts = Options()
    opts.layout_features = ["*"]      # keep init/medi/fina/isol and ligature features
    opts.glyph_names = True
    opts.notdef_outline = True
    opts.recommended_glyphs = True
    opts.drop_tables = ["FFTM", "meta"]
    opts.name_IDs = ["*"]
    opts.hinting = True

    subsetter = Subsetter(options=opts)
    subsetter.populate(unicodes=parse_ranges(UNICODES))
    subsetter.subset(font)
    return font


def parse_ranges(spec: str) -> list[int]:
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if part.upper().startswith("U+"):
            part = part[2:]
        if "-" in part:
            lo, hi = part.split("-")
            out.extend(range(int(lo, 16), int(hi, 16) + 1))
        else:
            out.append(int(part, 16))
    out.extend(EXTRA_FE)
    return sorted(set(out))


def shape_tables(font: TTFont) -> tuple[dict[int, str], dict[str, str]]:
    """Return the cmap and the shaping table the PDF writer needs.

    The shaping table is the single most important part: it maps a raw Arabic
    code point to the four positional glyphs so the writer can substitute the
    right one, because PDF has no complex-text shaper.
    """
    cmap = font.getBestCmap()
    glyph_order = font.getGlyphOrder()
    name_to_gid = {n: i for i, n in enumerate(glyph_order)}

    # Standard Arabic letters that take initial/medial/final forms. Each entry
    # is (isolated, final, initial, medial) in the Unicode presentation block.
    PAIRS = {
        0x0621: (0xFE80, None, None, None), 0x0622: (0xFE81, 0xFE82, None, None),
        0x0623: (0xFE83, 0xFE84, None, None), 0x0624: (0xFE85, 0xFE86, None, None),
        0x0625: (0xFE87, 0xFE88, None, None), 0x0626: (0xFE89, 0xFE8A, 0xFE8B, 0xFE8C),
        0x0627: (0xFE8D, 0xFE8E, None, None), 0x0628: (0xFE8F, 0xFE90, 0xFE91, 0xFE92),
        0x0629: (0xFE93, 0xFE94, None, None), 0x062A: (0xFE95, 0xFE96, 0xFE97, 0xFE98),
        0x062B: (0xFE99, 0xFE9A, 0xFE9B, 0xFE9C), 0x062C: (0xFE9D, 0xFE9E, 0xFE9F, 0xFEA0),
        0x062D: (0xFEA1, 0xFEA2, 0xFEA3, 0xFEA4), 0x062E: (0xFEA5, 0xFEA6, 0xFEA7, 0xFEA8),
        0x062F: (0xFEA9, 0xFEAA, None, None), 0x0630: (0xFEAB, 0xFEAC, None, None),
        0x0631: (0xFEAD, 0xFEAE, None, None), 0x0632: (0xFEAF, 0xFEB0, None, None),
        0x0633: (0xFEB1, 0xFEB2, 0xFEB3, 0xFEB4), 0x0634: (0xFEB5, 0xFEB6, 0xFEB7, 0xFEB8),
        0x0635: (0xFEB9, 0xFEBA, 0xFEBB, 0xFEBC), 0x0636: (0xFEBD, 0xFEBE, 0xFEBF, 0xFEC0),
        0x0637: (0xFEC1, 0xFEC2, 0xFEC3, 0xFEC4), 0x0638: (0xFEC5, 0xFEC6, 0xFEC7, 0xFEC8),
        0x0639: (0xFEC9, 0xFECA, 0xFECB, 0xFECC), 0x063A: (0xFECD, 0xFECE, 0xFECF, 0xFED0),
        0x0641: (0xFED1, 0xFED2, 0xFED3, 0xFED4), 0x0642: (0xFED5, 0xFED6, 0xFED7, 0xFED8),
        0x0643: (0xFED9, 0xFEDA, 0xFEDB, 0xFEDC), 0x0644: (0xFEDD, 0xFEDE, 0xFEDF, 0xFEE0),
        0x0645: (0xFEE1, 0xFEE2, 0xFEE3, 0xFEE4), 0x0646: (0xFEE5, 0xFEE6, 0xFEE7, 0xFEE8),
        0x0647: (0xFEE9, 0xFEEA, 0xFEEB, 0xFEEC), 0x0648: (0xFEED, 0xFEEE, None, None),
        0x0649: (0xFEEF, 0xFEF0, None, None), 0x064A: (0xFEF1, 0xFEF2, 0xFEF3, 0xFEF4),
        # Persian / Urdu letters that also join.
        0x067E: (0xFB56, 0xFB57, 0xFB58, 0xFB59), 0x0686: (0xFB7A, 0xFB7B, 0xFB7C, 0xFB7D),
        0x0698: (0xFB8A, 0xFB8B, None, None), 0x06A9: (0xFB8E, 0xFB8F, 0xFB90, 0xFB91),
        0x06AF: (0xFB92, 0xFB93, 0xFB94, 0xFB95), 0x06CC: (0xFBFC, 0xFBFD, 0xFBFE, 0xFBFF),
    }
    ARABIC_ALEFS = {0x0622, 0x0623, 0x0625, 0x0627}

    def gname(cp: int | None) -> str | None:
        if cp is None or cp not in cmap:
            return None
        return cmap[cp]

    shaping: dict[int, dict[str, str]] = {}
    for cp, (isol, fina, init, medi) in PAIRS.items():
        if cp not in cmap:
            continue
        entry: dict[str, str] = {}
        for key, form in (("isolated", isol), ("final", fina), ("initial", init), ("medial", medi)):
            n = gname(form)
            if n:
                entry[key] = n
        if entry:
            entry["joins_prev"] = "true" if (init or medi) else "false"
            entry["joins_next"] = "true" if (fina or medi) else "false"
            shaping[cp] = entry

    # Lam-alef must be applied before ordinary shaping.
    lam_alef: dict[str, str] = {}
    for alef, form in ((0x0622, 0xFEF5), (0x0623, 0xFEF7), (0x0625, 0xFEF9), (0x0627, 0xFEFB)):
        for src, key in ((form, "isolated"), (form + 1, "final")):
            n = gname(src)
            if n:
                lam_alef[f"{0x0644:04X}:{alef:04X}:{key}"] = n

    # Per-glyph advance widths, in 1000-unit em space, for the PDF /W array.
    hmtx = font["hmtx"]
    upem = font["head"].unitsPerEm
    widths = {n: round(hmtx[n][0] * 1000 / upem) for n in glyph_order}

    # Glyph id -> unicode, for the /ToUnicode CMap so text can be copied out.
    # Presentation forms are mapped back to their base letters so extracted text
    # reads as normal Arabic rather than FE70-block code points.
    form_to_base: dict[int, int] = {}
    for cp, forms in PAIRS.items():
        for form in forms:
            if form is not None:
                form_to_base[form] = cp

    gid_to_uni: dict[int, int] = {}
    for cp, n in cmap.items():
        gid = name_to_gid.get(n)
        if gid is None:
            continue
        gid_to_uni[gid] = form_to_base.get(cp, cp)
    for entry in shaping.values():
        for form in ("isolated", "final", "initial", "medial"):
            n = entry.get(form)
            if n is None:
                continue
            gid = name_to_gid.get(n)
            if gid is not None:
                gid_to_uni.setdefault(gid, 0)

    # A lam-alef ligature is one glyph for two letters, so its ToUnicode entry
    # must emit two code points. Mapping it to a single letter would make
    # "الاحتراق" extract as "اللحتراق".
    ligature_to_uni: dict[int, list[int]] = {}
    for alef, form in ((0x0622, 0xFEF5), (0x0623, 0xFEF7), (0x0625, 0xFEF9), (0x0627, 0xFEFB)):
        for src in (form, form + 1):
            n = gname(src)
            if n is None:
                continue
            gid = name_to_gid.get(n)
            if gid is not None:
                ligature_to_uni[gid] = [0x0644, alef]
                gid_to_uni.pop(gid, None)

    return {
        "cmap": {cp: name_to_gid[n] for cp, n in cmap.items() if n in name_to_gid},
        "shaping": shaping,
        "lamAlef": lam_alef,
        "widths": widths,
        "glyphOrder": glyph_order,
        "gidToUni": gid_to_uni,
        "ligatureToUni": ligature_to_uni,
        "numGlyphs": font["maxp"].numGlyphs,
        "upem": upem,
        "bbox": [font["head"].xMin, font["head"].yMin, font["head"].xMax, font["head"].yMax],
        "italicAngle": font["post"].italicAngle,
        "ascent": font["hhea"].ascent,
        "descent": font["hhea"].descent,
        "capHeight": font["OS/2"].sCapHeight if hasattr(font["OS/2"], "sCapHeight") else font["hhea"].ascent,
    }


def main() -> int:
    variants = {}
    for name, url in SOURCES.items():
        print(f"[{name}]")
        raw = fetch(name, url)
        font = subset(raw)
        tables = shape_tables(font)
        buf = io.BytesIO()
        font.save(buf)
        data = buf.getvalue()
        gz = base64.b64encode(gzip.compress(data, 9)).decode()
        print(f"  glyphs={tables['numGlyphs']} ttf={len(data)}B embedded={len(gz)}B")
        variants[name] = {"data": gz, **tables}

    lines = [
        "// GENERATED FILE — do not edit by hand.",
        "// Produced by workers/ignis-agent/tools/build_fonts.py",
        "//",
        "// Embedded IBM Plex Sans Arabic subset (SIL Open Font License 1.1).",
        "// Base-14 PDF fonts are Latin-1 only, so Arabic would vanish from an",
        "// exported report; embedding is the only way to render it. The subset",
        "// also carries Latin and punctuation so one family covers mixed text.",
        "//",
        "// `shaping` is required because PDF has no complex-text shaper: it gives",
        "// the writer the isolated/initial/medial/final glyph for each letter.",
        "// Font data is gzip+base64 to keep the Worker bundle small.",
        "",
        "export type FontTables = {",
        "  data: string;",
        "  cmap: Record<number, number>;",
        "  shaping: Record<number, { isolated?: string; final?: string; initial?: string; medial?: string; joins_prev?: string; joins_next?: string }>;",
        "  lamAlef: Record<string, string>;",
        "  widths: Record<string, number>;",
        "  glyphOrder: string[];",
        "  gidToUni: Record<number, number>;",
        "  ligatureToUni: Record<number, number[]>;",
        "  numGlyphs: number;",
        "  upem: number;",
        "  bbox: number[];",
        "  italicAngle: number;",
        "  ascent: number;",
        "  descent: number;",
        "  capHeight: number;",
        "};",
        "",
        "export const FONTS: Record<'regular' | 'bold', FontTables> = {",
    ]
    import json
    for name, v in variants.items():
        lines.append(f"  {name}: {{")
        lines.append(f"    data: '{v['data']}',")
        lines.append(f"    cmap: {json.dumps(v['cmap'], separators=(',', ':'))},")
        lines.append(f"    shaping: {json.dumps(v['shaping'], separators=(',', ':'))},")
        lines.append(f"    lamAlef: {json.dumps(v['lamAlef'], separators=(',', ':'))},")
        lines.append(f"    widths: {json.dumps(v['widths'], separators=(',', ':'))},")
        lines.append(f"    glyphOrder: {json.dumps(v['glyphOrder'], separators=(',', ':'))},")
        lines.append(f"    gidToUni: {json.dumps(v['gidToUni'], separators=(',', ':'))},")
        lines.append(f"    ligatureToUni: {json.dumps(v['ligatureToUni'], separators=(',', ':'))},")
        lines.append(f"    numGlyphs: {v['numGlyphs']},")
        lines.append(f"    upem: {v['upem']},")
        lines.append(f"    bbox: {json.dumps(v['bbox'])},")
        lines.append(f"    italicAngle: {v['italicAngle']},")
        lines.append(f"    ascent: {v['ascent']},")
        lines.append(f"    descent: {v['descent']},")
        lines.append(f"    capHeight: {v['capHeight']},")
        lines.append("  },")
    lines.append("};")
    lines.append("")

    OUT.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
