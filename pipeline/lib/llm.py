"""Pluggable multi-provider LLM client for IGNIS synthesis.

Providers are auto-detected from the environment and tried in order, so a
single slow or unreachable provider degrades the answer instead of failing the
request. Configure the order with ``IGNIS_LLM_PROVIDERS`` (comma separated);
the default order is ``gemini,agentrouter,openai,openrouter,ollama``.

  * ``agentrouter_proxy`` — the AgentRouter API reached through the deployed
                      Neon Function in ``functions/ignisllm``. Use this on a
                      network the WAF blocks: the function egresses from Neon
                      instead. (IGNIS_AGENTROUTER_PROXY_URL, IGNIS_PROXY_TOKEN,
                      IGNIS_AGENTROUTER_MODEL)
  * ``cloudflare``  — Cloudflare Workers AI, free tier. Runs open models
                      (Llama, Qwen, GPT-OSS, Mistral) on Cloudflare's edge, so
                      requests never touch a third-party WAF.
                      (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN,
                      CLOUDFLARE_MODEL)
  * ``neon``        — Neon AI Gateway (Databricks-hosted). One Neon credential
                      reaches Claude, GPT, Gemini and open-source models, and it
                      is not behind a client-fingerprinting WAF, which makes it
                      the reliable route when a third-party gateway blocks you.
                      (NEON_AI_GATEWAY_BASE_URL, NEON_AI_GATEWAY_TOKEN,
                      NEON_AI_GATEWAY_MODEL)
  * ``gemini``      — Google AI Studio, OpenAI-compatible endpoint
                      (GEMINI_API_KEY, GEMINI_MODEL)
  * ``agentrouter`` — unified gateway. Speaks the Anthropic Messages protocol by
                      default (AGENTROUTER_API_KEY, AGENTROUTER_MODEL); set
                      AGENTROUTER_STYLE=openai for the chat-completions protocol.
                      AgentRouter's WAF fingerprints clients at the TLS layer and
                      only allowlists the Anthropic/OpenAI SDK handshakes, so a
                      plain requests call may be served a captcha page instead.
  * ``openai``      — any OpenAI-compatible endpoint
                      (OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL)
  * ``openrouter``  — OPENROUTER_API_KEY, OPENROUTER_MODEL
  * ``ollama``      — local Ollama at OLLAMA_BASE_URL (no key needed)

When no provider is configured the callers fall back to the deterministic
extractive synthesizer in ``synth.py``, so IGNIS always returns a grounded,
cited answer. Every successful call is cached in ``ignis.llm_cache``.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from dataclasses import dataclass, field

import psycopg
import requests

from . import config
from .db import connect

log = logging.getLogger("ignis.llm")

DEFAULT_ORDER = ("agentrouter_proxy", "cloudflare", "neon", "gemini",
                 "agentrouter", "openai", "openrouter", "ollama")

GEMINI_OPENAI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"
# AgentRouter's Anthropic-compatible base carries no /v1: the Messages path is
# appended by the client, and a /v1 suffix would produce /v1/v1/messages.
AGENTROUTER_ANTHROPIC_BASE = "https://agentrouter.org"
AGENTROUTER_OPENAI_BASE = "https://agentrouter.org/v1"
CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4/accounts"
ANTHROPIC_VERSION = "2023-06-01"


@dataclass
class LLMResult:
    text: str
    model: str
    provider: str
    tokens: int = 0
    cached: bool = False


@dataclass
class Provider:
    name: str
    base_url: str
    api_key: str
    model: str
    style: str = "openai"  # "openai" | "anthropic" | "ollama"
    headers: dict = field(default_factory=dict)
    # Reasoning models spend budget on hidden thinking tokens, so a small
    # caller-supplied max_tokens can leave the visible answer empty.
    min_max_tokens: int = 0

    @property
    def label(self) -> str:
        return f"{self.name}/{self.model}"


def _model_for(env: str, default: str) -> str:
    """Per-provider model; IGNIS_LLM_MODEL overrides every provider at once."""
    return os.environ.get("IGNIS_LLM_MODEL") or os.environ.get(env) or default


def _build(name: str) -> Provider | None:
    if name == "agentrouter_proxy":
        url = os.environ.get("IGNIS_AGENTROUTER_PROXY_URL")
        if not url:
            return None
        # The function forwards the path verbatim, so /v1 is part of the base.
        base = url.rstrip("/") + "/v1"
        return Provider("agentrouter_proxy", base,
                        os.environ.get("IGNIS_PROXY_TOKEN", ""),
                        _model_for("IGNIS_AGENTROUTER_MODEL", "claude-opus-4-6"),
                        min_max_tokens=1024)
    if name == "cloudflare":
        account = os.environ.get("CLOUDFLARE_ACCOUNT_ID")
        token = os.environ.get("CLOUDFLARE_API_TOKEN")
        if not (account and token):
            return None
        return Provider("cloudflare",
                        f"{CLOUDFLARE_API_BASE}/{account}/ai/v1",
                        token, _model_for("CLOUDFLARE_MODEL",
                                          "@cf/meta/llama-3.3-70b-instruct-fp8-fast"),
                        min_max_tokens=1024)
    if name == "neon":
        base = os.environ.get("NEON_AI_GATEWAY_BASE_URL")
        token = os.environ.get("NEON_AI_GATEWAY_TOKEN")
        if not (base and token):
            return None
        # The bare branch host carries no path; the unified dialect lives at /v1.
        return Provider("neon", f"{base.rstrip('/')}/v1", token,
                        _model_for("NEON_AI_GATEWAY_MODEL", "claude-sonnet-4-6"))
    if name == "gemini":
        key = os.environ.get("GEMINI_API_KEY")
        if not key:
            return None
        return Provider("gemini",
                        os.environ.get("GEMINI_BASE_URL", GEMINI_OPENAI_BASE),
                        key, _model_for("GEMINI_MODEL", "gemini-3.1-flash-lite"))
    if name == "agentrouter":
        key = os.environ.get("AGENTROUTER_API_KEY")
        if not key:
            return None
        style = os.environ.get("AGENTROUTER_STYLE", "anthropic").lower()
        if style == "openai":
            default_base = AGENTROUTER_OPENAI_BASE
        else:
            style = "anthropic"
            default_base = AGENTROUTER_ANTHROPIC_BASE
        return Provider("agentrouter",
                        os.environ.get("AGENTROUTER_BASE_URL", default_base),
                        key, _model_for("AGENTROUTER_MODEL", "claude-opus-4-6"),
                        style=style)
    if name == "openai":
        key = os.environ.get("OPENAI_API_KEY")
        if not key:
            return None
        return Provider("openai",
                        os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1"),
                        key, _model_for("OPENAI_MODEL", "gpt-4o-mini"))
    if name == "openrouter":
        key = os.environ.get("OPENROUTER_API_KEY")
        if not key:
            return None
        return Provider("openrouter", "https://openrouter.ai/api/v1", key,
                        _model_for("OPENROUTER_MODEL", "openai/gpt-4o-mini"),
                        headers={"HTTP-Referer": config.USER_AGENT})
    if name == "ollama":
        url = os.environ.get("OLLAMA_BASE_URL")
        if not url:
            return None
        return Provider("ollama", url.rstrip("/"), "",
                        _model_for("OLLAMA_MODEL", "llama3.1:8b"), style="ollama")
    return None


def _detect_providers() -> list[Provider]:
    order = os.environ.get("IGNIS_LLM_PROVIDERS")
    names = [n.strip() for n in order.split(",") if n.strip()] if order else list(DEFAULT_ORDER)
    found = []
    for name in names:
        provider = _build(name)
        if provider:
            found.append(provider)
    return found


class LLM:
    """A provider chain. Tries each configured provider until one answers."""

    def __init__(self, model: str | None = None, timeout: int = 120, retries: int | None = None,
                 enabled: bool = True):
        self.providers = _detect_providers() if enabled else []
        if model:
            for p in self.providers:
                p.model = model
        self.timeout = timeout
        self.retries = retries if retries is not None else int(
            os.environ.get("IGNIS_LLM_RETRIES", "4")
        )
        self.provider = self.providers[0].name if self.providers else "none"
        self.model = self.providers[0].model if self.providers else ""
        self.last_error = ""

    @property
    def available(self) -> bool:
        return bool(self.providers)

    @property
    def chain(self) -> list[str]:
        return [p.label for p in self.providers]

    # ---------------------------------------------------------------- caching
    @staticmethod
    def _cache_key(provider: str, model: str, system: str, user: str) -> str:
        return hashlib.sha256(
            f"{provider}\x00{model}\x00{system}\x00{user}".encode()
        ).hexdigest()

    def _cache_get(self, key: str) -> LLMResult | None:
        try:
            with connect() as conn, conn.cursor() as cur:
                cur.execute("SELECT model, response, tokens FROM ignis.llm_cache WHERE cache_key=%s",
                            (key,))
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
    def _attempt(self, p: Provider, system: str, user: str, temperature: float,
                 max_tokens: int, json_mode: bool) -> LLMResult:
        if p.style == "ollama":
            return self._call_ollama(p, system, user, temperature, json_mode)
        if p.style == "anthropic":
            return self._call_anthropic(p, system, user, temperature, max_tokens)
        return self._call_openai(p, system, user, temperature,
                                 max(max_tokens, p.min_max_tokens), json_mode)

    def _complete_one(self, p: Provider, system: str, user: str, temperature: float,
                      max_tokens: int, json_mode: bool) -> LLMResult:
        """Call one provider, retrying transient failures with backoff.

        Free tiers routinely answer 429/5xx during demand spikes, and the same
        call usually succeeds moments later. Retrying here keeps a transient
        throttle from cascading into a degraded answer.
        """
        delay = 1.0
        last: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                result = self._attempt(p, system, user, temperature, max_tokens, json_mode)
                if not result.text:
                    raise RuntimeError("empty completion")
                return result
            except Exception as exc:
                last = exc
                if attempt >= self.retries:
                    break
                status = getattr(getattr(exc, "response", None), "status_code", None)
                retryable = status in (408, 409, 425, 429, 500, 502, 503, 504) or status is None
                if not retryable:
                    break
                log.info("%s attempt %d/%d failed (%s), retrying in %.1fs",
                         p.label, attempt, self.retries, status or type(exc).__name__, delay)
                time.sleep(delay)
                delay = min(delay * 2, 16.0)
        raise last if last else RuntimeError("no attempt made")

    def complete(self, system: str, user: str, *, temperature: float = 0.2,
                 max_tokens: int = 1200, json_mode: bool = False,
                 use_cache: bool = True) -> LLMResult:
        if not self.available:
            raise RuntimeError("no LLM provider configured")

        errors: list[str] = []
        for p in self.providers:
            key = self._cache_key(p.name, p.model, system, user)
            if use_cache:
                hit = self._cache_get(key)
                if hit:
                    self.provider, self.model = p.name, p.model
                    return hit
            try:
                result = self._complete_one(p, system, user, temperature, max_tokens, json_mode)
            except Exception as exc:
                reason = str(exc).splitlines()[0][:160]
                errors.append(f"{p.label}: {reason}")
                log.warning("provider %s failed (%s), trying next", p.label, reason)
                continue
            self.provider, self.model = p.name, p.model
            if use_cache:
                self._cache_put(key, result)
            return result

        self.last_error = "; ".join(errors)
        raise RuntimeError(f"all LLM providers failed: {self.last_error}")
    def _call_ollama(self, p: Provider, system: str, user: str, temperature: float,
                     json_mode: bool) -> LLMResult:
        payload = {
            "model": p.model,
            "prompt": f"{system}\n\n{user}",
            "stream": False,
            "options": {"temperature": temperature},
        }
        if json_mode:
            payload["format"] = "json"
        r = requests.post(f"{p.base_url}/api/generate", json=payload, timeout=self.timeout)
        r.raise_for_status()
        data = r.json()
        return LLMResult((data.get("response") or "").strip(), p.model, p.name,
                         data.get("eval_count", 0))

    def _call_anthropic(self, p: Provider, system: str, user: str, temperature: float,
                        max_tokens: int) -> LLMResult:
        """Anthropic Messages protocol (``POST {base}/v1/messages``).

        AgentRouter allowlists this wire shape, so it is the default route there.
        """
        headers = {
            "x-api-key": p.api_key,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
            **p.headers,
        }
        payload = {
            "model": p.model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
        r = requests.post(f"{p.base_url.rstrip('/')}/v1/messages", json=payload,
                          headers=headers, timeout=self.timeout)
        r.raise_for_status()
        if "json" not in (r.headers.get("content-type") or ""):
            # A gateway returned an HTML interstitial (WAF / maintenance page).
            raise RuntimeError(f"{p.name} returned non-JSON content "
                               f"({r.headers.get('content-type')})")
        data = r.json()
        if "content" not in data:
            raise RuntimeError(f"{p.name} response missing 'content': {str(data)[:200]}")
        text = "".join(
            block.get("text", "")
            for block in data["content"]
            if isinstance(block, dict) and block.get("type") == "text"
        ).strip()
        usage = data.get("usage") or {}
        tokens = (usage.get("input_tokens") or 0) + (usage.get("output_tokens") or 0)
        return LLMResult(text, p.model, p.name, tokens)

    def _call_openai(self, p: Provider, system: str, user: str, temperature: float,
                     max_tokens: int, json_mode: bool) -> LLMResult:
        headers = {"Authorization": f"Bearer {p.api_key}", "Content-Type": "application/json",
                   **p.headers}
        payload = {
            "model": p.model,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        r = requests.post(f"{p.base_url}/chat/completions", json=payload,
                          headers=headers, timeout=self.timeout)
        r.raise_for_status()
        if "json" not in (r.headers.get("content-type") or ""):
            # A gateway returned an HTML interstitial (WAF / maintenance page).
            raise RuntimeError(f"{p.name} returned non-JSON content "
                               f"({r.headers.get('content-type')})")
        data = r.json()
        if "choices" not in data:
            raise RuntimeError(f"{p.name} response missing 'choices': {str(data)[:200]}")
        text = (data["choices"][0].get("message", {}).get("content") or "").strip()
        return LLMResult(text, p.model, p.name, (data.get("usage") or {}).get("total_tokens", 0))

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
