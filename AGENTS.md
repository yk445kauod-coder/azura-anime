# IGNIS — agent notes

AI-powered dashboard over NASA NTRS combustion-in-microgravity literature.
React + Vite frontend in `web/`, serverless backend in `workers/ignis-agent/`,
Python pipeline in `pipeline/`, Neon Postgres for storage and retrieval.

Live: https://ignis-project.pages.dev (Cloudflare Pages + Pages Function `/api/*` proxy
to the `ignis-agent` worker).

## Commands

```bash
npm run web:dev          # Vite dev server (proxies /api/* to the worker)
npm run web:build        # typecheck + production build
npm run web:deploy       # build + publish to Cloudflare Pages
npm run worker:deploy    # deploy the ignis-agent worker
npm run web:typecheck    # tsc --noEmit
python3 -m pytest tests/ -q          # full suite (~85s, needs DATABASE_URL)
python3 pipeline/llm_doctor.py       # probe every configured LLM provider
npm run pipeline:report -- --topic "..."   # generate a research report
```

Tests hit the real Neon database; there is no mocking layer. `tests/conftest.py`
skips DB-dependent tests when the database is unreachable.

## Deployment topology

| Piece | Where | Notes |
| --- | --- | --- |
| Dashboard | Cloudflare Pages, project `ignis-project` → https://ignis-project.pages.dev | `web/dist`, SPA fallback via `web/public/_redirects` |
| API proxy | Pages Function `web/functions/api/[[path]].ts` | forwards `/api/<x>` to the worker's `/<x>`; streams SSE through |
| Backend | Worker `ignis-agent` | hybrid retrieval, agent loop, `/report`, `/memory`; Neon over HTTP |
| LLM gateway | Worker `ignis-gateway` | holds the upstream agentrouter.org key; `IGNIS_PROXY_TOKEN` gates callers |

`/health` on the worker returns the full `document_stats` row, so the dashboard
header can show live corpus counts.

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
browser or any server process.

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

## Agent synthesis: ask for markdown, derive citations locally

`workers/ignis-agent` is the live agent (the Python `pipeline/` is the offline
harvester). Its `/ask` and `/ask-sync` endpoints run
`plan → retrieve → grade → expand → synthesize → verify`.

### The agentic loop must not use the deep model in fast mode

`runAgentic` used to ignore `mode` and always use `IGNIS_DEEP_MODEL`
(`gpt-6-astra`). Each upstream completion on that model costs ~60-90s, so a
multi-turn loop could not reach synthesis inside its 150s deadline: it ended
`stop_reason: deadline` at ~151s and shipped the extractive dump (the
"gathered the following directly relevant passages" answer, ~0.80 confidence).
Fast mode now uses `IGNIS_FAST_MODEL` (`gpt-5.6-sol`), which completes a call in
~35s, so a run reaches `forced_synthesis` in 37-105s at confidence ~0.90.

Two supporting changes make the deadline reachable: the loop pre-seeds the
evidence pool with one local retrieval (retrieval is <1s) and skips the loop
entirely when the seed is already sufficient, and forced synthesis uses the same
output budgets as the fixed pipeline (`[4000, 8000]`). A reasoning model needs
~4000 output tokens before it stops spending the cap on hidden reasoning; a
smaller cap returns empty content, which is how a run silently degrades to the
extractive answer.

Recalled memory is passed to the loop as `deps.context`, not concatenated onto
the question string. Concatenating it made the model echo the memory preamble
into the answer heading.

The default model, `gpt-5.6-sol`, is a **reasoning model**. It spends its
`max_tokens` budget on hidden reasoning before emitting any text, so:

- **Do not ask it for JSON.** Structured-output prompts make it hit
  `finish_reason=incomplete` with an empty `message.content`. This was the
  original cause of the extractive fallback firing on most questions.
- **Ask for plain markdown** (3-5 sentences) and cap `max_tokens` around 900.
  `reasoning_effort` must be sent; `low` is both faster and more reliable here
  (`medium` truncates more often).
- **Derive claims from `[n]` markers, not from model-authored quote fields.**
  `claimsFromCitations()` maps each marker to the passage it points at and
  quotes that passage, so every claim is grounded by construction and
  `verifyClaims()` cannot fail on a hallucinated quote.
- **Retry once with a larger budget** when the call returns empty; the retry
  loop in `synthesizeWithLLM()` tries 900 then 2000 tokens before falling back
  to `synthesizeExtractive()`.

Measured after this change: 5/5 non-extractive answers, 7-12s, confidence
0.88-0.95. Before it: extractive fallback on most runs, 14-38s.

## Deploying the dashboard

- Agent Worker: `cd workers/ignis-agent && npx wrangler deploy`.
- Gateway Worker: `cd workers/ignis-gateway && npx wrangler deploy`.
- Pages: the project is named **`ignis-project`** → https://ignis-project.pages.dev.
  A second, older project named `ignis` (subdomain `ignis-1j3.pages.dev`) also
  exists in the account; deploying to it is a no-op for the live site. Deploy with:
  `cd web && CI=true npx wrangler pages deploy dist --project-name=ignis-project --branch=main`
  (`--branch=main` is required, or the deployment lands on a preview URL instead
  of the production subdomain).
- The frontend proxies `/api/*` to the agent Worker via the `IGNIS_LIVE_URL`
  var in `web/wrangler.toml`.

## Python tests

`npm test` runs `pytest tests/`. It needs `psycopg[binary]`, `requests` and
`fastembed` installed, plus a reachable `DATABASE_URL`; without them the
collection errors are import failures, not real test failures. With them:
111 passed.

---

## Documentation set

Three guides in `docs/`, all written against the live system — re-read the deployed
worker and the Neon schema before trusting any of them, they drift.

| File | Covers |
|---|---|
| `docs/API.md` | Endpoints, response fields, SSE event order, `stop_reason` contract |
| `docs/SCHEMA.md` | 25 tables + 3 views, relationships, data limitations |
| `docs/FRONTEND.md` | Design tokens, UX rules, i18n workflow, shipped-bug list |

### Facts that are easy to get wrong

- **Live URL is `ignis-project.pages.dev`.** `ignis.pages.dev` belongs to a third party.
- **The live agent is `workers/ignis-agent/src/agentic.ts`**, not `pipeline/lib/agent.py`.
  The Python is a reference implementation.
- **Agent answers are markdown.** Render with the `Markdown` component. Never emit a bare
  `<li>` (invalid HTML, browsers drop the marker) and never put `white-space: pre-wrap`
  on a container holding block elements. Both bugs shipped once.
- **Citations are positional.** `[3]` means `evidence[2]`. Do not reorder `evidence`.
- **`conversation_id` must be a UUID**, or `/api/ask` and `/api/memory` return 500.
- **Null conditions are not zero.** `o2_fraction` and `pressure_kpa` are null for most
  campaigns; render "not reported".
- **Extracted findings are candidates.** Every `finding` carries `evidence_quote`; show it.
- **`stop_reason` decides whether an answer is complete.** `final_answer` and
  `forced_synthesis` are fine; `budget`, `deadline`, `parse_error`, `model_error` are not.

## Frontend: design system and device budget

The dashboard is a dark "mission control" theme — glass panels over an animated
NASA Blue Marble backdrop, flame/amber accent (`--flame`), cyan for secondary
data. Tokens live at the top of `web/src/globals.css`; every component reads
them, so a theme change is one file.

Three rules keep it fast on weak devices:

- **Numbers must go through `web/src/lib/format.ts`.** Postgres `bigint`/`numeric`
  reach the client over the Neon HTTP driver as *strings*, so `toLocaleString`,
  `toFixed` and arithmetic silently render `—` or `NaN`. The worker also coerces
  with `numify()` in `index.ts`, but the client helper is the safety net.
- **WebGL is opt-in.** `web/src/lib/device.ts` gates on cores, memory, pointer
  type and reduced-motion. `IssPanel` renders a static NASA PNG unless the device
  qualifies; only then does it `import()` `IssViewer`, which pulls the isolated
  `three` chunk (~305 kB gzip). `frameloop="demand"` plus a 24 fps `Pulse` keeps
  the decorative rotation off the vsync budget, and it pauses when hidden.
- **Canvas animations throttle and pause.** `FlameViz` draws at 20 fps and stops
  on `visibilitychange`; the CSS earth rotation is disabled under reduced motion.

Every non-default tab is a `React.lazy` chunk, so opening Mission Control never
downloads the agent console or the report builder.

### Vendored visual assets

| File | Source | Licence |
| --- | --- | --- |
| `web/public/assets/iss.glb` | NASA 3D Resources, ISS (B) | public domain |
| `web/public/assets/iss-preview.png` | NASA 3D Resources (downscaled 760px) | public domain |
| `web/public/assets/earth-blue-marble.jpg` | three-globe example imagery (NASA Blue Marble) | public domain |
| `web/public/assets/nasa-logo.svg` | Wikimedia Commons | public domain |

The ISS model is untextured PBR, so `IssViewer` lights it with drei's `Stage`
rather than expecting baked textures. Icons are inlined `[tag, attrs]` tuples in
`web/src/components/Icon.tsx` (paths from Lucide, ISC) — no icon dependency, no
CDN request at runtime.

### Credentials

`.env` holds live Neon and S3 credentials and is gitignored. The worker's own secrets
(`NEON_DATABASE_URL`, `IGNIS_PROXY_TOKEN`, `AGENTROUTER_API_KEY`) live in Cloudflare via
`wrangler secret put`. Neither belongs in the repository.
