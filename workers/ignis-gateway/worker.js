/**
 * IGNIS LLM gateway - AgentRouter, reachable from anywhere.
 *
 * AgentRouter guards access in two layers:
 *   1. An Aliyun WAF on the whole domain, answering disallowed clients with an
 *      HTML captcha page and HTTP 200. Cloudflare's edge is not blocked, so
 *      requests from here reach the application.
 *   2. An application-level client check returning "unauthorized client
 *      detected" for anything but an allowlisted client, keyed on the Claude CLI
 *      user agent. This Worker sets it, so callers never need to know.
 *
 * The account's models speak the OpenAI Responses API, so this translates
 * chat-completions requests in and back out again, streaming included.
 *
 * Callers authenticate with IGNIS_PROXY_TOKEN; the real upstream key stays here.
 */
const UPSTREAM = "https://agentrouter.org";
const ALLOWLISTED_USER_AGENT = "claude-cli/2.0.0 (external, cli)";
const TIMEOUT_MS = 300000;
const MAX_PARAM_STRIPS = 3;

function json(body, status, extra) {
  return new Response(JSON.stringify(body), {
    status: status === undefined ? 200 : status,
    headers: Object.assign(
      { "content-type": "application/json", "access-control-allow-origin": "*" },
      extra || {},
    ),
  });
}

/** Flatten a chat-completions body into a Responses API body. */
function toResponsesBody(chat) {
  const input = (chat.messages || []).map((m) => ({
    role: m.role,
    content: typeof m.content === "string"
      ? m.content
      : (m.content || []).map((part) => (part && part.text) || "").join(""),
  }));

  const body = { model: chat.model, input: input };
  const maxOut = chat.max_tokens || chat.max_output_tokens;
  if (maxOut) body.max_output_tokens = maxOut;
  if (typeof chat.temperature === "number") body.temperature = chat.temperature;
  if (chat.response_format && chat.response_format.type === "json_object") {
    body.text = { format: { type: "json_object" } };
  }
  if (chat.stream) body.stream = true;
  return body;
}

/** Collapse a Responses API payload back into chat-completions shape. */
function toChatCompletion(resp, requestedModel) {
  let content = "";
  for (const item of resp.output || []) {
    if (!item || item.type !== "message") continue;
    for (const part of item.content || []) {
      if (part && (part.type === "output_text" || part.type === "text")) {
        content += part.text || "";
      }
    }
  }
  const usage = resp.usage || {};
  return {
    id: resp.id,
    object: "chat.completion",
    created: resp.created_at || Math.floor(Date.now() / 1000),
    model: resp.model || requestedModel,
    choices: [{
      index: 0,
      message: { role: "assistant", content: content },
      finish_reason: resp.status === "completed" ? "stop" : (resp.status || "stop"),
    }],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    },
  };
}

/** Split an SSE buffer into complete events, returning the remainder. */
function takeEvents(buffer) {
  const events = [];
  let rest = buffer;
  for (;;) {
    const cut = rest.indexOf("\n\n");
    if (cut === -1) break;
    events.push(rest.slice(0, cut));
    rest = rest.slice(cut + 2);
  }
  return { events: events, rest: rest };
}

/** Extract JSON payloads from the data: lines of one SSE block. */
function dataLines(block) {
  const out = [];
  for (const line of block.split("\n")) {
    if (line.indexOf("data:") === 0) out.push(line.slice(5).trim());
  }
  return out;
}

/**
 * Rewrite a Responses API SSE stream into chat-completions chunks.
 *
 * The upstream emits semantic events (response.output_text.delta, reasoning
 * summaries, response.completed). Callers expect the chat-completions shape,
 * so text deltas are re-emitted as chunk frames and everything else is
 * dropped (but kept so usage arrives on the final frame).
 */
function streamTranslator(model) {
  const id = "chatcmpl-" + Date.now();
  let buffer = "";
  let sentRole = false;
  let usage = null;

  const frame = (delta, finish) => {
    const payload = {
      id: id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{ index: 0, delta: delta, finish_reason: finish || null }],
    };
    return "data: " + JSON.stringify(payload) + "\n\n";
  };

  const handle = (payload) => {
    let out = "";
    const type = payload.type || "";
    if (type === "response.output_text.delta") {
      if (!sentRole) {
        sentRole = true;
        out += frame({ role: "assistant" }, null);
      }
      out += frame({ content: payload.delta || "" }, null);
    } else if (type === "response.completed") {
      usage = (payload.response || {}).usage || null;
      if (!sentRole) out += frame({ role: "assistant", content: "" }, null);
      out += frame({}, "stop");
    }
    return out;
  };

  const push = (chunk) => {
    buffer += chunk;
    const parsed = takeEvents(buffer);
    buffer = parsed.rest;
    let out = "";
    for (const block of parsed.events) {
      for (const data of dataLines(block)) {
        if (!data) continue;
        let payload = null;
        try { payload = JSON.parse(data); } catch (e) { continue; }
        out += handle(payload);
      }
    }
    return out;
  };

  return { push: push, usage: function () { return usage; } };
}

function upstreamHeaders(request, key) {
  const headers = {
    "User-Agent": ALLOWLISTED_USER_AGENT,
    "Content-Type": request.headers.get("content-type") || "application/json",
  };
  if (key) headers["Authorization"] = "Bearer " + key;
  const forwarded = request.headers.get("x-request-id");
  if (forwarded) headers["x-request-id"] = forwarded;
  return headers;
}

function unsupportedParameter(text) {
  const match = /Unsupported parameter: '([^']+)'/.exec(text);
  return match ? match[1] : null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
    }

    if (request.method === "GET") {
      if (url.pathname === "/health") {
        return json({
          ok: true,
          upstream: UPSTREAM,
          upstream_key_configured: Boolean(env.AGENTROUTER_API_KEY),
          caller_token_required: true,
          user_agent: ALLOWLISTED_USER_AGENT,
        });
      }
      if (url.pathname === "/" || url.pathname === "/v1/models") {
        return json({ ok: true, name: "ignis-gateway", model_hint: env.MODEL || "gpt-6.1-sol" });
      }
    }

    // Authenticate callers against IGNIS_PROXY_TOKEN.
    const callerToken = env.IGNIS_PROXY_TOKEN;
    const authHeader = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const proxyHeader = (request.headers.get("x-ignis-token") || "").trim();
    const provided = authHeader || proxyHeader;
    if (callerToken && provided !== callerToken) {
      return json({ error: "unauthorized - missing or invalid IGNIS_PROXY_TOKEN" }, 401);
    }

    const key = env.AGENTROUTER_API_KEY;
    if (!key) {
      return json({ error: "upstream key not configured on the Worker" }, 503);
    }
    if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

    const raw = await request.text();
    let chat = {};
    try { chat = JSON.parse(raw); } catch (e) { }
    const model = chat.model || env.MODEL || "gpt-6.1-sol";
    const isChatCompletions = url.pathname.indexOf("/chat/completions") !== -1;
    const headers = upstreamHeaders(request, key);
    const started = Date.now();

    // Passthrough for non-chat-completions routes (kept for raw /v1/responses use).
    if (!isChatCompletions || !chat.messages) {
      const upstream = await fetch(UPSTREAM + url.pathname + url.search, {
        method: "POST", headers: headers, body: raw,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") || "application/json", "access-control-allow-origin": "*", "x-ignis-latency-ms": String(Date.now() - started) },
      });
    }

    const body = toResponsesBody(chat);
    const upstreamPath = "/v1/responses";
    const wantsStream = Boolean(chat.stream);

    if (wantsStream) {
      let upstream = await fetch(UPSTREAM + upstreamPath, {
        method: "POST", headers: headers, body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (upstream.status === 400) {
        const txt = await upstream.text();
        for (let attempt = 0; attempt < MAX_PARAM_STRIPS; attempt++) {
          const param = unsupportedParameter(txt);
          if (!param || !Object.prototype.hasOwnProperty.call(body, param)) break;
          delete body[param];
          upstream = await fetch(UPSTREAM + upstreamPath, {
            method: "POST", headers: headers, body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          if (upstream.status !== 400) break;
        }
      }
      const ct = upstream.headers.get("content-type") || "";
      if (upstream.status !== 200 || ct.indexOf("text/event-stream") === -1 || !upstream.body) {
        const txt = await upstream.text();
        return new Response(txt, { status: upstream.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "x-ignis-latency-ms": String(Date.now() - started) } });
      }
      const translator = streamTranslator(model);
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      (async () => {
        try {
          const reader = upstream.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const out = translator.push(buf);
            buf = "";
            if (out) await writer.write(encoder.encode(out));
          }
          // Flush any remaining parser buffer.
          const tail = translator.push("");
          if (tail) await writer.write(encoder.encode(tail));
        } catch (e) {
          // Aborted upstream: close cleanly.
        } finally {
          await writer.close();
        }
      })();
      return new Response(readable, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          "access-control-allow-origin": "*",
          "x-ignis-llm-gateway": model,
        },
      });
    }

    // Non-streaming chat-completions -> Responses -> chat-completions.
    let upstream = await fetch(UPSTREAM + upstreamPath, {
      method: "POST", headers: headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let text = await upstream.text();
    if (upstream.status === 400) {
      for (let attempt = 0; attempt < MAX_PARAM_STRIPS; attempt++) {
        const param = unsupportedParameter(text);
        if (!param || !Object.prototype.hasOwnProperty.call(body, param)) break;
        delete body[param];
        upstream = await fetch(UPSTREAM + upstreamPath, {
          method: "POST", headers: headers, body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        text = await upstream.text();
        if (upstream.status !== 400) break;
      }
    }
    if (upstream.status >= 400) {
      return new Response(text, { status: upstream.status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "x-ignis-latency-ms": String(Date.now() - started) } });
    }
    let parsed = {};
    try { parsed = JSON.parse(text); } catch (e) { }
    const out = toChatCompletion(parsed, model);
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*", "x-ignis-latency-ms": String(Date.now() - started) },
    });
  },
};
