"""Provider-chain behaviour for pipeline/lib/llm.py.

No network calls: the transport is patched so the chain's ordering, failover
and response-validation logic is exercised directly.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pipeline"))

from lib import llm as llm_mod  # noqa: E402


class FakeResponse:
    def __init__(self, payload=None, content_type="application/json", status=200, text=""):
        self._payload = payload
        self.headers = {"content-type": content_type}
        self.status_code = status
        self.text = text or str(payload)

    def raise_for_status(self):
        if self.status_code >= 400:
            err = llm_mod.requests.HTTPError(f"HTTP {self.status_code}")
            err.response = self
            raise err

    def json(self):
        return self._payload


@pytest.fixture(autouse=True)
def _no_cache(monkeypatch):
    monkeypatch.setattr(llm_mod.LLM, "_cache_get", lambda self, key: None)
    monkeypatch.setattr(llm_mod.LLM, "_cache_put", lambda self, key, result: None)
    # Backoff sleeps are real seconds; tests should not wait them out.
    monkeypatch.setattr(llm_mod.time, "sleep", lambda s: None)


def _chain(monkeypatch, names=("gemini", "agentrouter")):
    monkeypatch.setenv("GEMINI_API_KEY", "gk")
    monkeypatch.setenv("AGENTROUTER_API_KEY", "ak")
    monkeypatch.setenv("IGNIS_LLM_PROVIDERS", ",".join(names))
    monkeypatch.delenv("IGNIS_LLM_MODEL", raising=False)
    monkeypatch.delenv("GEMINI_MODEL", raising=False)
    monkeypatch.delenv("AGENTROUTER_MODEL", raising=False)
    return llm_mod.LLM()


def _ok(text="answer"):
    return FakeResponse({"choices": [{"message": {"content": text}}],
                         "usage": {"total_tokens": 7}})


def test_chain_is_ordered_and_labelled(monkeypatch):
    llm = _chain(monkeypatch)
    assert llm.available
    assert [p.name for p in llm.providers] == ["gemini", "agentrouter"]
    assert llm.chain == ["gemini/gemini-3.1-flash-lite",
                         "agentrouter/deepseek-v4-flash"]


def test_provider_order_is_configurable(monkeypatch):
    llm = _chain(monkeypatch, names=("agentrouter", "gemini"))
    assert [p.name for p in llm.providers] == ["agentrouter", "gemini"]


def test_no_keys_means_unavailable(monkeypatch):
    for var in ("GEMINI_API_KEY", "AGENTROUTER_API_KEY", "OPENAI_API_KEY",
                "OPENROUTER_API_KEY", "OLLAMA_BASE_URL"):
        monkeypatch.delenv(var, raising=False)
    assert llm_mod.LLM().available is False


def test_falls_back_to_next_provider_on_http_error(monkeypatch):
    llm = _chain(monkeypatch)
    llm.retries = 1  # isolate failover from retry behaviour
    seen = []

    def fake_post(url, **kw):
        seen.append(url)
        if "generativelanguage" in url:
            return FakeResponse(status=503, text="overloaded")
        return _ok("from agentrouter")

    monkeypatch.setattr(llm_mod.requests, "post", fake_post)
    result = llm.complete("s", "u")
    assert result.text == "from agentrouter"
    assert result.provider == "agentrouter"
    assert len(seen) == 2, "should have tried both providers"


def test_html_interstitial_is_rejected_and_skipped(monkeypatch):
    """A WAF/captcha page must not be mistaken for a completion."""
    llm = _chain(monkeypatch)

    def fake_post(url, **kw):
        if "generativelanguage" in url:
            return _ok("from gemini")
        return FakeResponse(content_type="text/html; charset=utf-8",
                            text="<html>captcha</html>")

    monkeypatch.setattr(llm_mod.requests, "post", fake_post)
    result = llm.complete("s", "u")
    assert result.provider == "gemini"
    assert result.text == "from gemini"


def test_all_providers_failing_raises_with_reasons(monkeypatch):
    llm = _chain(monkeypatch)
    monkeypatch.setattr(llm_mod.requests, "post",
                        lambda url, **kw: FakeResponse(content_type="text/html", text="<html>"))
    with pytest.raises(RuntimeError) as exc:
        llm.complete("s", "u")
    assert "all LLM providers failed" in str(exc.value)
    assert "gemini" in llm.last_error and "agentrouter" in llm.last_error


def test_empty_completion_counts_as_failure(monkeypatch):
    llm = _chain(monkeypatch)

    def fake_post(url, **kw):
        if "generativelanguage" in url:
            return _ok("")
        return _ok("real answer")

    monkeypatch.setattr(llm_mod.requests, "post", fake_post)
    assert llm.complete("s", "u").text == "real answer"


def test_json_mode_parses_fenced_response(monkeypatch):
    llm = _chain(monkeypatch)
    monkeypatch.setattr(llm_mod.requests, "post", lambda url, **kw: _ok(
        '```json\n{"answer": "x", "confidence": 0.5}\n```'))
    assert llm.complete_json("s", "u")["answer"] == "x"


def test_global_model_override_wins(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "gk")
    monkeypatch.setenv("IGNIS_LLM_MODEL", "forced-model")
    monkeypatch.setenv("IGNIS_LLM_PROVIDERS", "gemini")
    assert llm_mod.LLM().model == "forced-model"


def test_transient_5xx_is_retried_within_one_provider(monkeypatch):
    """Gemini's free tier 503s in bursts; a retry should recover without failover."""
    llm = _chain(monkeypatch, names=("gemini",))
    llm.retries = 3
    monkeypatch.setattr(llm_mod.time, "sleep", lambda s: None)
    calls = {"n": 0}

    def fake_post(url, **kw):
        calls["n"] += 1
        if calls["n"] < 3:
            return FakeResponse(status=503, text="overloaded")
        return _ok("recovered")

    monkeypatch.setattr(llm_mod.requests, "post", fake_post)
    result = llm.complete("s", "u")
    assert result.text == "recovered"
    assert result.provider == "gemini"
    assert calls["n"] == 3, "should have retried twice before succeeding"


def test_retries_are_capped_then_failover(monkeypatch):
    llm = _chain(monkeypatch)
    llm.retries = 2
    monkeypatch.setattr(llm_mod.time, "sleep", lambda s: None)
    counts = {"gemini": 0}

    def fake_post(url, **kw):
        if "generativelanguage" in url:
            counts["gemini"] += 1
            return FakeResponse(status=503, text="overloaded")
        return _ok("from agentrouter")

    monkeypatch.setattr(llm_mod.requests, "post", fake_post)
    result = llm.complete("s", "u")
    assert result.provider == "agentrouter"
    assert counts["gemini"] == 2, "should stop retrying at the cap"


def test_non_retryable_error_fails_over_immediately(monkeypatch):
    """A 400 (bad model name) will not improve on retry — move on."""
    llm = _chain(monkeypatch)
    llm.retries = 3
    monkeypatch.setattr(llm_mod.time, "sleep", lambda s: None)
    counts = {"gemini": 0}

    def fake_post(url, **kw):
        if "generativelanguage" in url:
            counts["gemini"] += 1
            return FakeResponse(status=404, text="model not found")
        return _ok("from agentrouter")

    monkeypatch.setattr(llm_mod.requests, "post", fake_post)
    assert llm.complete("s", "u").provider == "agentrouter"
    assert counts["gemini"] == 1, "should not retry a 404"
