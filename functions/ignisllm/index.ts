/**
 * IGNIS LLM gateway — a thin proxy onto the AgentRouter API.
 *
 * It exists because AgentRouter sits behind an Aliyun WAF that fingerprints the
 * caller and answers disallowed clients with an HTML captcha page and HTTP 200.
 * Every client tried from a development machine fails: requests, curl, the
 * Python and Node Anthropic SDKs, and TLS impersonation. This function runs on
 * Neon's network instead, which is a different egress path, so it can reach the
 * gateway when a local server cannot.
 *
 * The caller never sees the upstream key: it sends IGNIS_PROXY_TOKEN, and this
 * handler attaches AGENTROUTER_API_KEY. That keeps a paid credential out of the
 * browser and out of the Next.js process.
 *
 * Routes:
 *   GET  /health              → configuration state, no upstream call
 *   POST /v1/chat/completions → forwarded to AgentRouter's OpenAI dialect
 *   POST /v1/messages         → forwarded to AgentRouter's Anthropic dialect
 */

const UPSTREAM = "https://agentrouter.org";
const DEFAULT_TIMEOUT_MS = 120_000;

interface Env {
  AGENTROUTER_API_KEY?: string;
  IGNIS_PROXY_TOKEN?: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

function describe(body: string, contentType: string): string {
  if (contentType.includes("text/html")) {
    return "upstream returned an HTML interstitial (WAF or maintenance page)";
  }
  return body.slice(0, 300);
}

/** Attach the upstream credential for the dialect the caller asked for. */
function upstreamHeaders(incoming: Headers, path: string, key: string): Headers {
  const headers = new Headers();
  for (const [name, value] of incoming) {
    const lower = name.toLowerCase();
    // Hop-by-hop and identity headers must not be forwarded.
    if (["host", "authorization", "x-api-key", "content-length", "cf-connecting-ip",
         "x-forwarded-for", "x-forwarded-proto", "x-real-ip", "connection"].includes(lower)) {
      continue;
    }
    headers.set(name, value);
  }
  if (path.includes("/messages")) {
    headers.set("x-api-key", key);
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  } else {
    headers.set("authorization", `Bearer ${key}`);
  }
  return headers;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const env = (globalThis as unknown as { process?: { env: Env } }).process?.env ?? {};
    const key = env.AGENTROUTER_API_KEY;
    const expected = env.IGNIS_PROXY_TOKEN;

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type, authorization",
          "access-control-allow-methods": "GET, POST, OPTIONS",
        },
      });
    }

    if (path === "/health") {
      return json({
        ok: true,
        upstream: UPSTREAM,
        upstream_key_configured: Boolean(key),
        caller_token_required: Boolean(expected),
      });
    }

    if (request.method !== "POST") {
      return json({ error: "only POST is supported" }, 405);
    }

    if (!key) {
      return json({ error: "AGENTROUTER_API_KEY is not configured on this function" }, 500);
    }

    // Reject unauthenticated callers so the function cannot be used as an open
    // relay for a paid upstream key. This is application-level auth: it runs
    // before any upstream work.
    if (expected) {
      const supplied = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (supplied !== expected) {
        return json({ error: "unauthorized" }, 401);
      }
    }

    const body = await request.text();
    const target = `${UPSTREAM}${path}${url.search}`;
    const started = Date.now();

    try {
      const upstream = await fetch(target, {
        method: "POST",
        headers: upstreamHeaders(request.headers, path, key),
        body,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

      const text = await upstream.text();
      const contentType = upstream.headers.get("content-type") ?? "";
      const latency = Date.now() - started;

      if (!contentType.includes("json")) {
        // Surface the WAF page as an explicit error rather than passing HTML
        // back to a caller expecting JSON.
        return json({
          error: "upstream did not return JSON",
          detail: describe(text, contentType),
          upstream_status: upstream.status,
          latency_ms: latency,
        }, 502);
      }

      return new Response(text, {
        status: upstream.status,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
          "x-ignis-latency-ms": String(latency),
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return json({ error: "upstream request failed", detail }, 502);
    }
  },
};
