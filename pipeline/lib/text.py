"""Text normalization / cleaning primitives for scientific PDF & fulltext data."""
from __future__ import annotations

import hashlib
import re
import unicodedata

# Ligatures and typographic characters common in scanned/typeset NASA reports.
_LIGATURES = {
    "\ufb00": "ff", "\ufb01": "fi", "\ufb02": "fl", "\ufb03": "ffi", "\ufb04": "ffl",
    "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
    "\u2013": "-", "\u2014": " - ", "\u2212": "-", "\u00ad": "",
    "\u00a0": " ", "\u2009": " ", "\u202f": " ", "\u200b": "",
}

# Running heads / footers repeated on NASA PDFs.
_PAGE_NOISE = re.compile(
    r"^\s*(?:page\s+)?\d{1,4}\s*(?:of\s+\d{1,4})?\s*$"
    r"|^\s*(?:NASA/TM|NASA/CR|NASA/TP|AIAA|NTRS)[^\n]{0,120}$"
    r"|^\s*https?://\S+\s*$"
    r"|^\s*(?:Downloaded|Retrieved)\s+(?:by|from)\s+[^\n]{0,120}$",
    re.IGNORECASE,
)

_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_WS = re.compile(r"[ \t\u00a0]+")
_BLANKS = re.compile(r"\n{3,}")
# Soft hyphenation across line breaks: "com-\nbustion" -> "combustion"
_HYPHEN_BREAK = re.compile(r"(\w)-\n(\w)")
# Common PDF extraction artifacts
_ARTIFACTS = re.compile(r"(\b\w)\s?(\uFFFD)+\s?(\w\b)")


def strip_ligatures(text: str) -> str:
    for src, dst in _LIGATURES.items():
        text = text.replace(src, dst)
    return text


def unicode_normalize(text: str) -> str:
    return unicodedata.normalize("NFKC", text)


def dehyphenate(text: str) -> str:
    return _HYPHEN_BREAK.sub(r"\1\2", text)


def remove_page_noise(text: str) -> str:
    lines = text.split("\n")
    kept = [ln for ln in lines if not _PAGE_NOISE.match(ln)]
    return "\n".join(kept)


def collapse_whitespace(text: str) -> str:
    text = _CONTROL.sub(" ", text)
    text = _WS.sub(" ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = _BLANKS.sub("\n\n", text)
    return text.strip()


def fix_ocr_artifacts(text: str) -> str:
    text = _ARTIFACTS.sub(r"\1\3", text)
    # Rejoin words split by stray single spaces inside long runs of capitals
    text = re.sub(r"\b([A-Z]) ([A-Z]) ([A-Z]) ([A-Z])\b", r"\1\2\3\4", text)
    return text


def clean_text(raw: str) -> str:
    """Full cleaning chain: normalize -> dehyphenate -> de-noise -> collapse."""
    if not raw:
        return ""
    text = unicode_normalize(raw)
    text = strip_ligatures(text)
    text = dehyphenate(text)
    text = fix_ocr_artifacts(text)
    text = remove_page_noise(text)
    text = collapse_whitespace(text)
    return text


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


_WORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9'\-]*")
_SENT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9(])")

# A line is a paragraph terminator when it ends in terminal punctuation; a line
# beginning with one of these markers also starts a new logical unit.
_TERMINAL = (".", "!", "?", ":", ";", '"', "”")
_BULLET_OR_HEADING = re.compile(
    r"^(?:[-•*\u2022\u2013\u2014]\s|\d+(?:\.\d+)*[.)]?\s+[A-Z]|[A-Z][A-Z0-9 ,\-/]{2,40}$)"
)


def _reflow(block: list[str]) -> list[str]:
    """Join PDF soft-wrapped lines back into paragraphs.

    Extracted PDF text hard-wraps mid-sentence, so treating every physical line
    as a sentence fragments the text into unusable slivers.
    """
    out: list[str] = []
    buf = ""
    for raw in block:
        line = raw.strip()
        if not line:
            continue
        if not buf:
            buf = line
        elif buf.endswith(_TERMINAL) or _BULLET_OR_HEADING.match(line):
            out.append(buf)
            buf = line
        else:
            buf = f"{buf} {line}"
    if buf:
        out.append(buf)
    return out


def words(text: str) -> list[str]:
    return _WORD.findall(text)


def sentences(text: str) -> list[str]:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"(\w)-\n(?=[a-z])", r"\1", text)  # rejoin hyphenated wraps
    out: list[str] = []
    for block in re.split(r"\n\s*\n", text):
        lines = block.split("\n")
        for para in _reflow(lines):
            out.extend(s.strip() for s in _SENT.split(para) if s.strip())
    return out


# Scientific vocabulary signals used for quality scoring & domain relevance.
DOMAIN_TERMS = {
    "microgravity", "combustion", "flame", "flammability", "ignition", "extinction",
    "smolder", "smoulder", "soot", "pyrolysis", "oxidizer", "oxidiser", "quenching",
    "fire", "fire-safety", "suppression", "diffusion flame", "premixed", "droplet",
    "burning rate", "flame spread", "limiting oxygen", "loi", "cool flame",
    "spacecraft", "iss", "bass", "saffire", "same", "flex", "sofie", "cfi", "ace",
    "cygnus", "pmma", "sibal", "heptane", "methanol", "decane", "ethylene",
    "buoyancy", "convection", "radiative", "aerosol", "smoke", "detector",
}

_STOP = set("""a an the and or but if while of to in on for with without from by as at is are was were be been being
this that these those it its their there here which who whom whose what when where why how not no nor so than then
we our you your they them he she his her can could may might must shall should will would do does did done have has had
also such more most other some any each both few many much own same too very s t just don now""".split())


def keywords(text: str, top: int = 12) -> list[str]:
    from collections import Counter
    counts = Counter(w.lower() for w in words(text) if len(w) > 3 and w.lower() not in _STOP)
    return [w for w, _ in counts.most_common(top)]


def domain_density(text: str) -> float:
    """Fraction of domain-relevant terms in the text (0..1)."""
    toks = [w.lower() for w in words(text)]
    if not toks:
        return 0.0
    low = text.lower()
    hits = sum(low.count(term) for term in DOMAIN_TERMS)
    return min(1.0, hits / max(1, len(toks)) * 8)
