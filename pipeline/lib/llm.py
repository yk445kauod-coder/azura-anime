"""Pluggable LLM client for IGNIS synthesis.

Providers (auto-detected, first match wins):
  * ``openai``      — any OpenAI-compatible /chat/completions endpoint
                      (OPENAI_API_KEY, OPENAI_BASE_URL, IGNIS_LLM_MODEL)
  * ``openrouter``  — OPENROUTER_API_KEY
  * ``ollama``      — local Ollama at OLLAMA_BASE_URL (no key needed)
  * ``none``        — no provider configured; callers fall back to the
                      deterministic extractive synthesizer in ``synth.py``.

Every call is cached in ``ignis.llm_cache`` so agent runs stay cheap and
reproducible.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
from dataclasses import dataclass

import psycopg
import requests

from . import config
from .db import connect

log = logging.getLogger("ignis.llm")


@dataclass
class LLMResult:
    text: str
    model: str
    provider: str
    tokens: int = 0
    cached: bool = False


def _detect() -> tuple[str, str, str, str]:
    """Return (provider, base_url, api_key, model)."""
    if key := os.environ.get("OPENAI_API_KEY"):
        return ("openai",
                os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
                key, os.environ.get("IGNIS_LLM_MODEL", "gpt-4o-mini"))
    if key := os.environ.get("OPENROUTER_API_KEY"):
        return ("openrouter", "https://openrouter.ai/api/v1", key,
                os.environ.get("IGNIS_LLM_MODEL", "openai/gpt-4o-mini"))
    if os.environ.get("OLLAMA_BASE_URL"):
        return ("ollama", os.environ["OLLAMA_BASE_URL"].rstrip("/"), "",
                os.environ.get("IGNIS_LLM_MODEL", "llama3.1:8b"))
    return ("none", "", "", "")


class LLM:
    def __init__(self, model: str | None = None, timeout: int = 120):
        self.provider, self.base_url, self.api_key, detected_model = _detect()
        self.model = model or detected_model
        self.timeout = timeout

    @property
    def available(self) -> bool:
        return self.provider != "none"

    # ---------------------------------------------------------------- caching
    @staticmethod
    def _cache_key(model: str, system: str, user: str) -> str:
        return hashlib.sha256(f"{model}\x00{system}\x00{user}".encode()).hexdigest()

    def _cache_get(self, key: str) -> LLMResult | None:
        try:
            with connect() as conn, conn.cursor() as cur:
                cur.execute("SELECT model, response, tokens FROM ignis.llm_cache WHERE cache_key=%s", (key,))
                row = cur.fetchone()
        except Exception:
            return None
        if not row:
            return None
        return LLMResult(row["response"].get("text", ""), row["model"],
                         self.provider, row["tokens"] or 0, cached=True)

    def _cache_put(self, key: str, result: LLMResult) -> None:
        try:
            with connect() as conn, conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO ignis.llm_cache (cache_key, model, response, tokens)
                       VALUES (%s, %s, %s, %s) ON CONFLICT (cache_key) DO NOTHING""",
                    (key, result.model, psycopg.types.json.Jsonb({"text": result.text}),
                     result.tokens),
                )
        except Exception:
            pass

    # ------------------------------------------------------------- completion
    def complete(self, system: str, user: str, *, temperature: float = 0.2,
                 max_tokens: int = 1200, json_mode: bool = False,
                 use_cache: bool = True) -> LLMResult:
        if not self.available:
            raise RuntimeError("no LLM provider configured")

        key = self._cache_key(self.model, system, user)
        if use_cache:
            hit = self._cache_get(key)
            if hit:
                return hit

        if self.provider == "ollama":
            payload = {
                "model": self.model,
                "prompt": f"{system}\n\n{user}",
                "stream": False,
                "options": {"temperature": temperature},
            }
            if json_mode:
                payload["format"] = "json"
            r = requests.post(f"{self.base_url}/api/generate", json=payload, timeout=self.timeout)
            r.raise_for_status()
            data = r.json()
            text = data.get("response", "")
            tokens = data.get("eval_count", 0)
        else:
            headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
            if self.provider == "openrouter":
                headers["HTTP-Referer"] = config.USER_AGENT
            payload = {
                "model": self.model,
                "messages": [{"role": "system", "content": system},
                             {"role": "user", "content": user}],
                "temperature": temperature,
                "max_tokens": max_tokens,
            }
            if json_mode:
                payload["response_format"] = {"type": "json_object"}
            r = requests.post(f"{self.base_url}/chat/completions", json=payload,
                              headers=headers, timeout=self.timeout)
            r.raise_for_status()
            data = r.json()
            text = data["choices"][0]["message"]["content"]
            tokens = (data.get("usage") or {}).get("total_tokens", 0)

        result = LLMResult(text.strip(), self.model, self.provider, tokens)
        if use_cache:
            self._cache_put(key, result)
        return result

    def complete_json(self, system: str, user: str, **kw) -> dict:
        res = self.complete(system, user, json_mode=True, **kw)
        raw = res.text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            raw = raw[4:] if raw.lower().startswith("json") else raw
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            start, end = raw.find("{"), raw.rfind("}")
            if start != -1 and end > start:
                try:
                    return json.loads(raw[start:end + 1])
                except json.JSONDecodeError:
                    pass
            return {}
