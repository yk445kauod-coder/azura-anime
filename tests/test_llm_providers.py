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


PROVIDER_ENV_VARS = (
    "GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_BASE_URL",
    "AGENTROUTER_API_KEY", "AGENTROUTER_MODEL", "AGENTROUTER_BASE_URL", "AGENTROUTER_STYLE",
    "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_BASE_URL",
    "OPENROUTER_API_KEY", "OPENROUTER_MODEL",
    "OLLAMA_BASE_URL", "OLLAMA_MODEL",
    "NEON_AI_GATEWAY_BASE_URL", "NEON_AI_GATEWAY_TOKEN", "NEON_AI_GATEWAY_MODEL",
    "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_MODEL",
    "IGNIS_LLM_MODEL", "IGNIS_LLM_PROVIDERS",
)


@pytest.fixture(autouse=True)
def _clean_provider_env(monkeypatch):
    """Strip every provider variable so results do not depend on the local .env."""
    for var in PROVIDER_ENV_VARS:
        monkeypatch.delenv(var, raising=False)


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
    # These cases exercise the chat-completions wire shape end to end; the
    # Anthropic protocol has its own tests below.
    monkeypatch.setenv("AGENTROUTER_STYLE", "openai")
    monkeypatch.setenv("AGENTROUTER_BASE_URL", "https://agentrouter.org/v1")
    return llm_mod.LLM()


def _ok(text="answer"):
    return FakeResponse({"choices": [{"message": {"content": text}}],
                         "usage": {"total_tokens": 7}})


def test_chain_is_ordered_and_labelled(monkeypatch):
    llm = _chain(monkeypatch)
    assert llm.available
    assert [p.name for p in llm.providers] == ["gemini", "agentrouter"]
    assert llm.chain == ["gemini/gemini-3.1-flash-lite",
                         "agentrouter/claude-opus-4-6"]


def test_provider_order_is_configurable(monkeypatch):
    llm = _chain(monkeypatch, names=("agentrouter", "gemini"))
    assert [p.name for p in llm.providers] == ["agentrouter", "gemini"]


def test_no_keys_means_unavailable():
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


# --------------------------------------------------------------------------- #
# AgentRouter protocol handling
# --------------------------------------------------------------------------- #
def _anthropic_ok(text="from claude"):
    return FakeResponse({
        "content": [{"type": "text", "text": text}],
        "usage": {"input_tokens": 5, "output_tokens": 3},
    })


# --------------------------------------------------------------------------- #
# Cloudflare Workers AI
# --------------------------------------------------------------------------- #
def test_cloudflare_provider_builds_account_scoped_endpoint(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct123")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "cftok")
    monkeypatch.delenv("CLOUDFLARE_MODEL", raising=False)
    monkeypatch.delenv("IGNIS_LLM_MODEL", raising=False)
    provider = llm_mod._build("cloudflare")
    assert provider.style == "openai"
    assert provider.base_url == (
        "https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1")
    assert provider.api_key == "cftok"
    assert provider.model == "@cf/meta/llama-3.3-70b-instruct-fp8-fast"


def test_cloudflare_provider_needs_both_account_and_token(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct123")
    monkeypatch.delenv("CLOUDFLARE_API_TOKEN", raising=False)
    assert llm_mod._build("cloudflare") is None
    monkeypatch.delenv("CLOUDFLARE_ACCOUNT_ID", raising=False)
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "cftok")
    assert llm_mod._build("cloudflare") is None


def test_cloudflare_calls_the_openai_compatible_route(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct123")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "cftok")
    monkeypatch.setenv("IGNIS_LLM_PROVIDERS", "cloudflare")
    monkeypatch.delenv("CLOUDFLARE_MODEL", raising=False)
    llm = llm_mod.LLM()
    seen = {}

    def fake_post(url, **kw):
        seen["url"] = url
        seen["auth"] = kw["headers"]["Authorization"]
        return _ok("from cloudflare")

    monkeypatch.setattr(llm_mod.requests, "post", fake_post)
    result = llm.complete("s", "u")
    assert seen["url"] == (
        "https://api.cloudflare.com/client/v4/accounts/acct123/ai/v1/chat/completions")
    assert seen["auth"] == "Bearer cftok"
    assert result.text == "from cloudflare"
    assert result.provider == "cloudflare"


def test_cloudflare_raises_a_tiny_token_budget_for_reasoning_models(monkeypatch):
    """Hidden reasoning tokens can otherwise consume the whole budget."""
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct123")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "cftok")
    monkeypatch.setenv("IGNIS_LLM_PROVIDERS", "cloudflare")
    llm = llm_mod.LLM()
    seen = {}

    def fake_post(url, **kw):
        seen["max_tokens"] = kw["json"]["max_tokens"]
        return _ok("ok")

    monkeypatch.setattr(llm_mod.requests, "post", fake_post)
    llm.complete("s", "u", max_tokens=256)
    assert seen["max_tokens"] == 1024, "a small budget is raised to the floor"

    llm.complete("s", "u", max_tokens=4000)
    assert seen["max_tokens"] == 4000, "a larger caller budget is respected"


def test_cloudflare_is_first_in_the_default_chain(monkeypatch):
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct123")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "cftok")
    monkeypatch.setenv("GEMINI_API_KEY", "gk")
    monkeypatch.setenv("AGENTROUTER_API_KEY", "ak")
    monkeypatch.delenv("IGNIS_LLM_PROVIDERS", raising=False)
    assert [p.name for p in llm_mod.LLM().providers] == [
        "cloudflare", "gemini", "agentrouter"]


# --------------------------------------------------------------------------- #
# Neon AI Gateway
# --------------------------------------------------------------------------- #
def test_neon_provider_builds_from_injected_env(monkeypatch):
    """Neon injects a bare branch host; the unified dialect lives at /v1."""
    monkeypatch.setenv("NEON_AI_GATEWAY_BASE_URL",
                       "https://ep-x-api.ai.us-east-1.aws.neon.tech")
    monkeypatch.setenv("NEON_AI_GATEWAY_TOKEN", "nt_live_abc")
    monkeypatch.delenv("NEON_AI_GATEWAY_MODEL", raising=False)
    monkeypatch.delenv("IGNIS_LLM_MODEL", raising=False)
    provider = llm_mod._build("neon")
    assert provider.style == "openai"
    assert provider.base_url == "https://ep-x-api.ai.us-east-1.aws.neon.tech/v1"
    assert provider.api_key == "nt_live_abc"
    assert provider.model == "claude-sonnet-4-6"


def test_neon_provider_needs_both_base_and_token(monkeypatch):
    monkeypatch.setenv("NEON_AI_GATEWAY_BASE_URL", "https://ep-x-api.ai.us-east-1.aws.neon.tech")
    monkeypatch.delenv("NEON_AI_GATEWAY_TOKEN", raising=False)
    assert llm_mod._build("neon") is None
    monkeypatch.delenv("NEON_AI_GATEWAY_BASE_URL", raising=False)
    monkeypatch.setenv("NEON_AI_GATEWAY_TOKEN", "nt_live_abc")
    assert llm_mod._build("neon") is None


def test_self_hosted_credentials_are_tried_before_the_waf_blocked_gateway(monkeypatch):
    """Cloudflare and Neon are account-scoped, so they precede AgentRouter."""
    monkeypatch.setenv("CLOUDFLARE_ACCOUNT_ID", "acct123")
    monkeypatch.setenv("CLOUDFLARE_API_TOKEN", "cftok")
    monkeypatch.setenv("NEON_AI_GATEWAY_BASE_URL", "https://ep-x-api.ai.us-east-1.aws.neon.tech")
    monkeypatch.setenv("NEON_AI_GATEWAY_TOKEN", "nt_live_abc")
    monkeypatch.setenv("GEMINI_API_KEY", "gk")
    monkeypatch.setenv("AGENTROUTER_API_KEY", "ak")
    monkeypatch.setenv("IGNIS_LLM_PROVIDERS",
                       "cloudflare,neon,gemini,agentrouter")
    assert [p.name for p in llm_mod.LLM().providers] == [
        "cloudflare", "neon", "gemini", "agentrouter"]


def test_neon_calls_the_chat_completions_route(monkeypatch):
    monkeypatch.setenv("NEON_AI_GATEWAY_BASE_URL", "https://ep-x-api.ai.us-east-1.aws.neon.tech")
    monkeypatch.setenv("NEON_AI_GATEWAY_TOKEN", "nt_live_abc")
    monkeypatch.setenv("IGNIS_LLM_PROVIDERS", "neon")
    monkeypatch.delenv("NEON_AI_GATEWAY_MODEL", raising=False)
    llm = llm_mod.LLM()
    seen = {}

    def fake_post(url, **kw):
        seen["url"] = url
        seen["auth"] = kw["headers"]["Authorization"]
        return _ok("from neon")

    monkeypatch.setattr(llm_mod.requests, "post", fake_post)
    result = llm.complete("s", "u")
    assert seen["url"] == "https://ep-x-api.ai.us-east-1.aws.neon.tech/v1/chat/completions"
    assert seen["auth"] == "Bearer nt_live_abc"
    assert result.text == "from neon"
    assert result.provider == "neon"


def test_agentrouter_defaults_to_anthropic_messages_protocol(monkeypatch):
    """AgentRouter's WAF allowlists the Messages wire shape, so it is the default."""
    monkeypatch.setenv("AGENTROUTER_API_KEY", "ak")
    monkeypatch.delenv("AGENTROUTER_STYLE", raising=False)
    monkeypatch.delenv("AGENTROUTER_BASE_URL", raising=False)
    provider = llm_mod._build("agentrouter")
    assert provider.style == "anthropic"
    # No /v1 suffix: the client appends /v1/messages itself.
    assert provider.base_url == "https://agentrouter.org"
    assert provider.model == "claude-opus-4-6"


def test_agentrouter_style_openai_switches_protocol(monkeypatch):
    monkeypatch.setenv("AGENTROUTER_API_KEY", "ak")
    monkeypatch.setenv("AGENTROUTER_STYLE", "openai")
    monkeypatch.delenv("AGENTROUTER_BASE_URL", raising=False)
    provider = llm_mod._build("agentrouter")
    assert provider.style == "openai"
    assert provider.base_url == "https://agentrouter.org/v1"


def test_anthropic_call_posts_messages_path_with_sdk_headers(monkeypatch):
    monkeypatch.setenv("AGENTROUTER_API_KEY", "ak")
    monkeypatch.setenv("IGNIS_LLM_PROVIDERS", "agentrouter")
    monkeypatch.delenv("AGENTROUTER_BASE_URL", raising=False)
    monkeypatch.delenv("AGENTROUTER_STYLE", raising=False)
    llm = llm_mod.LLM()
    seen = {}

    def fake_post(url, **kw):
        seen["url"] = url
        seen["headers"] = kw["headers"]
        seen["json"] = kw["json"]
        return _anthropic_ok()

    monkeypatch.setattr(llm_mod.requests, "post", fake_post)
    result = llm.complete("sys prompt", "user prompt", max_tokens=256)

    assert seen["url"] == "https://agentrouter.org/v1/messages"
    assert seen["headers"]["x-api-key"] == "ak"
    assert seen["headers"]["anthropic-version"] == llm_mod.ANTHROPIC_VERSION
    assert "Authorization" not in seen["headers"], "Messages protocol uses x-api-key"
    assert seen["json"]["system"] == "sys prompt"
    assert seen["json"]["messages"] == [{"role": "user", "content": "user prompt"}]
    assert seen["json"]["max_tokens"] == 256
    assert result.text == "from claude"
    assert result.provider == "agentrouter"
    assert result.tokens == 8


def test_anthropic_response_joins_text_blocks_and_ignores_others(monkeypatch):
    monkeypatch.setenv("AGENTROUTER_API_KEY", "ak")
    monkeypatch.setenv("IGNIS_LLM_PROVIDERS", "agentrouter")
    monkeypatch.delenv("AGENTROUTER_BASE_URL", raising=False)
    monkeypatch.delenv("AGENTROUTER_STYLE", raising=False)
    llm = llm_mod.LLM()
    monkeypatch.setattr(llm_mod.requests, "post", lambda url, **kw: FakeResponse({
        "content": [{"type": "thinking", "thinking": "…"},
                    {"type": "text", "text": "part one "},
                    {"type": "text", "text": "part two"}],
    }))
    assert llm.complete("s", "u").text == "part one part two"


def test_anthropic_missing_content_field_is_rejected(monkeypatch):
    monkeypatch.setenv("AGENTROUTER_API_KEY", "ak")
    monkeypatch.setenv("IGNIS_LLM_PROVIDERS", "agentrouter")
    monkeypatch.delenv("AGENTROUTER_BASE_URL", raising=False)
    monkeypatch.delenv("AGENTROUTER_STYLE", raising=False)
    llm = llm_mod.LLM()
    llm.retries = 1
    monkeypatch.setattr(llm_mod.requests, "post",
                        lambda url, **kw: FakeResponse({"error": "nope"}))
    with pytest.raises(RuntimeError, match="missing 'content'"):
        llm.complete("s", "u")
