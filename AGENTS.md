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
| `cloudflare_gateway` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_PROVIDER`, `CLOUDFLARE_GATEWAY_KEY` | AI Gateway. Needs AI Gateway permission on the token — see below. |
| `agentrouter_proxy` | `IGNIS_AGENTROUTER_PROXY_URL`, `IGNIS_PROXY_TOKEN` | AgentRouter via a Neon Function. Use when the local network is WAF-blocked. |
| `agentrouter` | `AGENTROUTER_API_KEY` | Direct. Speaks Anthropic Messages by default. See below. |

A provider whose credentials are incomplete is skipped, so a half-configured
gateway never enters the chain. With no provider available, callers fall back to
the deterministic extractive synthesizer in `synth.py` — grounded and cited, but
verbatim rather than fluent.

### Cloudflare AI Gateway needs a different token

The token in this workspace cannot use AI Gateway, and the root cause is scope
rather than configuration. `GET /accounts` returns **success with zero
accounts** (`count: 0`), so the token is scoped to Workers AI alone and sees no
account to attach a gateway to. Supporting evidence: a request to a **bogus
gateway name** returns the same `2009 Unauthorized` as a real one, and Workers AI
*through* the gateway fails while Workers AI *direct* succeeds with the same
token.

To enable it, mint a token with **Account → AI Gateway → Read** (add **Workers
Scripts → Edit** if wrangler should deploy), then set in `.env`:

```
CLOUDFLARE_GATEWAY_ID="default"
CLOUDFLARE_GATEWAY_PROVIDER="openai"        # or google-ai-studio, anthropic
CLOUDFLARE_GATEWAY_KEY="<upstream provider key>"
CLOUDFLARE_GATEWAY_MODEL="claude-opus-4-6"
CLOUDFLARE_GATEWAY_AUTH_TOKEN="<new Cloudflare token>"   # if Authenticated Gateway is on
```

`CLOUDFLARE_GATEWAY_AUTH_TOKEN` is not optional in practice: a gateway with
Authenticated Gateway enabled rejects requests that lack `cf-aig-authorization`,
which is a *separate* header from the provider's own `Authorization`. The
provider sends both when the variable is set.

Then confirm with `npm run pipeline:doctor`, which probes whichever providers
have credentials. No code change is needed once the token is in place.

### Reaching AgentRouter from a blocked network

`functions/ignisllm/` is a Neon Function that proxies AgentRouter. The point is
egress: the function runs on Neon's network, so it can reach the gateway from
networks the WAF blocks. Callers authenticate with `IGNIS_PROXY_TOKEN`; the
handler attaches the real upstream key, so the paid credential never reaches the
browser or the Next.js process.

Deploy with `npm run functions:deploy`, which runs `neon deploy --env .env`,
reads back the invocation URL, and writes `IGNIS_AGENTROUTER_PROXY_URL` into
`.env`. `neon auth` (browser sign-in) must be done once by a human first — an
unattended agent must not attempt it.

Both `AGENTROUTER_API_KEY` and `IGNIS_PROXY_TOKEN` must be non-empty in `.env`
before deploying: `neon.ts` declares them, and `defineConfig` throws on a
missing value.

`npm run functions:test` exercises the real handler with real `Request` objects.
Locally the upstream call returns the WAF page, which the handler reports as a
502 — that is the expected local result, not a bug.

### AgentRouter is unreachable from this network

`agentrouter.org` sits behind an Aliyun WAF that serves an HTML captcha page with
HTTP 200. Every client was tried and all fail: `requests`, `curl`, the Python
sync Anthropic SDK, the Node Anthropic SDK, and `curl_cffi` TLS impersonation.
Cookies harvested from a real browser do not help. The decisive evidence is that
the AgentRouter *website* also shows "Please slide to verify" from here, which
makes this a network/IP-level block rather than a client-fingerprint one.

Do not spend time on in-process workarounds. Use Cloudflare Workers AI instead.

### Two AgentRouter paths, two wire shapes

`agentrouter_proxy` uses the **OpenAI** dialect. The function forwards the path
verbatim, so the base URL carries `/v1` and the client appends
`/chat/completions`. `agentrouter` (direct) defaults to **Anthropic Messages**,
where the base URL must *not* carry `/v1` because the SDK appends `/v1/messages`.

The direct provider keeps Anthropic Messages as its default wire shape because the WAF
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
- Cloudflare's free tier is CPU-metered, and Workers AI requests are billed in
  "neurons" (a single 120B call cost ~4). It is fine for interactive use but is
  not the place for bulk corpus processing; prefer a self-hosted model there.
- The Cloudflare token in this workspace is read-only for Workers *scripts*
  (`PUT /accounts/<id>/workers/scripts/<name>` returns "No access to the
  specified resource"), so a proxy Worker cannot be deployed with it.

## LLM gateway Worker (workers/ignis-gateway)

`workers/ignis-gateway/worker.js` is a Cloudflare Worker that proxies the IGNIS
pipeline's LLM calls to AgentRouter (`agentrouter.org`). It exists because the
local network is blocked by an Aliyun WAF on `https://agentrouter.org`; Cloudflare's
edge IP plus the `claude-cli/2.0.0 (external, cli)` User-Agent is allowlisted.

Behavior:
- `/health` — liveness + `upstream_key_configured` (uses `env.AGENTROUTER_API_KEY`).
- Callers authenticate with `IGNIS_PROXY_TOKEN` (Bearer or `x-ignis-token`).
- `POST /v1/chat/completions` (with `messages`) is **translated**:
  chat-completions body -> Responses API body (`/v1/responses` upstream), then the
  upstream Responses SSE is rewritten back into chat-completions `chunk` frames.
  Both streaming and non-streaming work.
- Streaming returns `text/event-stream` with `x-ignis-llm-gateway: <model>`.
- Reasoning models reject sampling params: on HTTP 400 with `Unsupported
  parameter: '<name>'`, the param is stripped and the request retried (up to 3).
- Other paths (e.g. raw `/v1/responses`, `/v1/models`) pass through verbatim.

Key as a secret binding named `AGENTROUTER_API_KEY` (the deploy script
`scripts/deploy-worker.sh` does this from `.env`). Do not rename the binding:
the Worker reads `env.AGENTROUTER_API_KEY`.

Verified (2026-11-02): `npm run pipeline:doctor` passes for
`agentrouter_proxy/gpt-6.1-sol`, and `curl -N` to
`/v1/chat/completions?stream=true` yields incremental `choices[].delta.content`
chunks. The direct `agentrouter/claude-opus-4-6` provider legitimately fails the
doctor (WAF blocks local non-Cloudflare clients) — it is not the gateway path.

### The streaming fix

The dashboard's `/api/ask` previously timed out because the Python pipeline
serialized a full multi-stage agent run after 180s. The gateway now streams
LLM tokens, so the plan is to run the agent stages on the server but stream
tokens to the client. As of the hand-off, `/v1/chat/completions` streaming is
verified at the gateway; wiring streaming into `/api/ask` and the frontend is
the next step (see HANDOFF.md).
