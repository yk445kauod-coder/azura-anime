// Exercises the real handler with real Requests; only the process env is staged.
process.env.AGENTROUTER_API_KEY = process.env.AGENTROUTER_API_KEY || "test-key";
process.env.IGNIS_PROXY_TOKEN = "secret-token";

const { default: handler } = await import(new URL("../functions/ignisllm/index.ts", import.meta.url).href);

const base = "https://fn.example";
async function call(path, init) {
  const res = await handler.fetch(new Request(base + path, init));
  const ct = res.headers.get("content-type") || "";
  const text = await res.text();
  let body = text;
  if (ct.includes("json")) { try { body = JSON.parse(text); } catch {} }
  return { status: res.status, ct, body };
}

const show = (label, r) => {
  const b = typeof r.body === "string" ? r.body.slice(0, 180) : JSON.stringify(r.body).slice(0, 240);
  console.log(`\n### ${label}\n  status: ${r.status}  ct: ${r.ct}\n  body: ${b}`);
};

show("health (no upstream call)", await call("/health"));
show("401 without token", await call("/v1/chat/completions", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "x", messages: [] }),
}));
show("405 on GET", await call("/v1/chat/completions", { method: "GET" }));
show("204 CORS preflight", await call("/v1/chat/completions", { method: "OPTIONS" }));
show("real upstream call (expect WAF detection locally)", await call("/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
  body: JSON.stringify({ model: "claude-opus-4-6", max_tokens: 32, messages: [{ role: "user", content: "Reply OK" }] }),
}));
