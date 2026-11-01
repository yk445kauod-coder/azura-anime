"""Token-aware chunking for scientific documents."""
from __future__ import annotations

import re

from . import config
from .text import sha256_text

try:  # tiktoken gives accurate token counts; fall back to a heuristic.
    import tiktoken

    _ENC = tiktoken.get_encoding("cl100k_base")

    def count_tokens(text: str) -> int:
        return len(_ENC.encode(text))
except Exception:  # pragma: no cover
    def count_tokens(text: str) -> int:
        return max(1, int(len(text.split()) * 1.33))


# Section headings typical of NASA technical reports.
_HEADING = re.compile(
    r"^\s*(?:(?:\d+(?:\.\d+)*)[.)]?\s+)?"
    r"(abstract|introduction|background|objective[s]?|experimental(?:\s+(?:setup|apparatus|methods?|procedure))?"
    r"|method[s]?|apparatus|results?(?:\s+and\s+discussion)?|discussion|conclusions?|summary|recommendations?"
    r"|references|acknowledg(?:e)?ments?|appendix|nomenclature|introduction and background)\s*$",
    re.IGNORECASE,
)

# Kind classification from the section path.
_KIND_RULES = [
    (re.compile(r"abstract", re.I), "abstract"),
    (re.compile(r"results?|discussion", re.I), "results"),
    (re.compile(r"conclusion|summary|recommendation", re.I), "conclusion"),
    (re.compile(r"reference|bibliograph", re.I), "reference"),
    (re.compile(r"appendix|nomenclature", re.I), "table"),
]


def classify_kind(section_path: str | None) -> str:
    if not section_path:
        return "body"
    for pattern, kind in _KIND_RULES:
        if pattern.search(section_path):
            return kind
    return "body"


def _split_sentences(paragraph: str) -> list[str]:
    return [s for s in re.split(r"(?<=[.!?])\s+", paragraph) if s.strip()]


def chunk_document(
    text: str,
    target_tokens: int | None = None,
    overlap_tokens: int | None = None,
) -> list[dict]:
    """Split cleaned document text into overlapping, heading-aware chunks.

    Returns a list of dicts with content, kind, section_path, ordinal, tokens.
    """
    target = target_tokens or config.CHUNK_TARGET_TOKENS
    overlap = overlap_tokens or config.CHUNK_OVERLAP_TOKENS

    # Split into blocks on blank lines, tracking the nearest preceding heading.
    blocks: list[tuple[str, str]] = []  # (section_path, paragraph)
    section = "Document"
    for raw_block in text.split("\n\n"):
        block = raw_block.strip()
        if not block:
            continue
        if len(block) < 80 and _HEADING.match(block):
            section = block.strip()
            continue
        blocks.append((section, block))

    chunks: list[dict] = []
    buf: list[str] = []
    buf_tokens = 0
    buf_section = blocks[0][0] if blocks else "Document"

    def flush() -> None:
        nonlocal buf, buf_tokens, buf_section
        if not buf:
            return
        content = "\n\n".join(buf).strip()
        if len(content) < 60:  # drop degenerate fragments
            buf, buf_tokens = [], 0
            return
        chunks.append({
            "ordinal": len(chunks),
            "content": content,
            "section_path": buf_section,
            "kind": classify_kind(buf_section),
            "token_count": count_tokens(content),
            "char_count": len(content),
            "content_sha256": sha256_text(content),
        })
        # Carry an overlap tail into the next chunk.
        if overlap > 0:
            tail: list[str] = []
            tail_tokens = 0
            for block in reversed(buf):
                t = count_tokens(block)
                if tail_tokens + t > overlap:
                    break
                tail.insert(0, block)
                tail_tokens += t
            buf = tail
            buf_tokens = tail_tokens
        else:
            buf, buf_tokens = [], 0

    for section_path, block in blocks:
        block_tokens = count_tokens(block)
        if block_tokens > target * 1.8:
            # Oversized block: split on sentence boundaries.
            for sentence in _split_sentences(block):
                st = count_tokens(sentence)
                if buf_tokens + st > target and buf:
                    flush()
                    buf_section = section_path
                buf.append(sentence)
                buf_tokens += st
            continue
        if buf_tokens + block_tokens > target and buf:
            flush()
            buf_section = section_path
        if not buf:
            buf_section = section_path
        buf.append(block)
        buf_tokens += block_tokens

    flush()
    # Re-number after overlap handling.
    for i, c in enumerate(chunks):
        c["ordinal"] = i
    return chunks
