/**
 * Cloudflare Pages Function — proxies /api/* to the ignis-agent Worker.
 *
 * Keeps the browser on a single origin (no CORS), hides the worker hostname, and
 * streams SSE responses through untouched so the assistant can render live stages.
 */
interface Env {
  IGNIS_LIVE_URL?: string;
}

const DEFAULT_UPSTREAM = "https://ignis-agent.yk445kauod.workers.dev";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
]);

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env, params } = context;
  const segments = params.path;
  const suffix = Array.isArray(segments) ? segments.join("/") : segments ?? "";

  const upstream = (env.IGNIS_LIVE_URL || DEFAULT_UPSTREAM).replace(/\/$/, "");
  const incoming = new URL(request.url);
  const target = `${upstream}/${suffix}${incoming.search}`;

  const headers = new Headers(request.headers);
  headers.delete("host");

  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  let res: Response;
  try {
    res = await fetch(target, init);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `upstream unreachable: ${(err as Error).message}` }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  const outHeaders = new Headers();
  for (const [k, v] of res.headers) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders.set(k, v);
  }
  outHeaders.set("access-control-allow-origin", "*");
  outHeaders.set("cache-control", "no-store");

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: outHeaders,
  });
};
