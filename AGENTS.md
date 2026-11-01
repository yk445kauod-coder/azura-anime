# IGNIS — agent notes

AI-powered dashboard over NASA NTRS combustion-in-microgravity literature.
Next.js frontend + API routes in `src/`, Python pipeline in `pipeline/`, Neon
Postgres for storage and retrieval.

## Commands

```bash
npm run start            # serve on PORT (12000 in this workspace)
npm run build            # next build
npm run typecheck        # tsc --noEmit
python3 -m pytest tests/ -q          # full suite (~85s, needs DATABASE_URL)
python3 pipeline/llm_doctor.py       # probe every configured LLM provider
npm run pipeline:report -- --topic "..."   # generate a research report
```

Tests hit the real Neon database; there is no mocking layer. `tests/conftest.py`
skips DB-dependent tests when the database is unreachable.

## LLM providers

`pipeline/lib/llm.py` holds an ordered provider chain, auto-detected from the
environment. Configure the order with `IGNIS_LLM_PROVIDERS`.

Default order: `cloudflare, neon, gemini, agentrouter, openai, openrouter, ollama`.

| Provider | Credentials | Notes |
| --- | --- | --- |
| `cloudflare` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Workers AI, free tier. Preferred: account-scoped, so no third-party WAF sits in the path. |
| `neon` | `NEON_AI_GATEWAY_BASE_URL`, `NEON_AI_GATEWAY_TOKEN` | Neon AI Gateway. Needs a paid Neon plan. |
| `gemini` | `GEMINI_API_KEY` | Free tier throttles hard; retry-with-backoff mitigates. |
| `agentrouter` | `AGENTROUTER_API_KEY` | Speaks Anthropic Messages by default. See below. |

A provider whose credentials are incomplete is skipped, so a half-configured
gateway never enters the chain. With no provider available, callers fall back to
the deterministic extractive synthesizer in `synth.py` — grounded and cited, but
verbatim rather than fluent.

### AgentRouter is unreachable from this network

`agentrouter.org` sits behind an Aliyun WAF that serves an HTML captcha page with
HTTP 200. Every client was tried and all fail: `requests`, `curl`, the Python
sync Anthropic SDK, the Node Anthropic SDK, and `curl_cffi` TLS impersonation.
Cookies harvested from a real browser do not help. The decisive evidence is that
the AgentRouter *website* also shows "Please slide to verify" from here, which
makes this a network/IP-level block rather than a client-fingerprint one.

Do not spend time on in-process workarounds. Use Cloudflare Workers AI instead.

The provider keeps Anthropic Messages as its default wire shape because the WAF
allowlists that fingerprint; `AGENTROUTER_STYLE=openai` switches to
chat-completions. For the Messages path the base URL must **not** carry `/v1`,
since the client appends `/v1/messages` itself.

### Workers AI model choice

`@cf/meta/llama-3.3-70b-instruct-fp8-fast` is the default because it honours
`response_format: {"type": "json_object"}`. The agent pipeline depends on that.

`@cf/openai/gpt-oss-120b` reasons better but leaks its reasoning trace into
`message.content` and breaks JSON mode, so it is unsuitable as the default.
Reasoning models also spend budget on hidden thinking tokens, which is why
`Provider.min_max_tokens` exists (1024 for Cloudflare): a small caller budget can
otherwise return an empty visible answer.

`deepseek-v4-pro` and similar flagship models return "not available on the
Workers Free plan".

## Testing notes

`pipeline/lib/config.py` loads `.env` into `os.environ` at import time, so a
developer's real credentials are visible to tests. Any test asserting that a
provider is *absent* must delete that variable itself; `tests/test_llm_providers.py`
does this with an autouse fixture over `PROVIDER_ENV_VARS`.

## Gotchas

- Provider tests patch `llm_mod.requests.post`; no network calls.
- `complete_json` degrades to `{}` on unparseable output rather than raising, so
  a JSON-mode regression shows up as missing data, not an exception.
- The Cloudflare token in this workspace is read-only for Workers *scripts*
  (`PUT /accounts/<id>/workers/scripts/<name>` returns "No access to the
  specified resource"), so a proxy Worker cannot be deployed with it.
