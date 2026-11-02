import { useEffect, useState } from "react";

type Claim = {
  claim: string; quote: string; title: string; source_id: string;
  section: string; support_score: number; landing_url: string; verified?: boolean;
};
type Hit = {
  chunk_id: number; document_id: number; title: string; source_id: string;
  kind: string; section_path: string | null; content: string;
  final_score: number; vector_score: number; keyword_score: number; rerank_score: number;
  quality_score: number; landing_url: string; relevance: string; sub_question: string | null;
};
type AskResult = {
  run_id: string; question: string; answer: string; claims: Claim[]; evidence: Hit[];
  sub_questions: string[]; confidence: number; grounded: boolean; iterations: number;
  trace: { node: string; [k: string]: unknown }[];
  latency_ms: number; provider: string; model: string;
};

const EXAMPLES = [
  "How does flame spread over solid fuels differ in microgravity compared with Earth?",
  "What is the limiting oxygen concentration for spacecraft fire safety?",
  "How do smoke and soot particles behave in microgravity, and what does it mean for fire detection?",
  "Why is fire suppression harder in microgravity, and which agents were tested?",
  "What did SAFFIRE teach us about large-scale fire growth in spacecraft?",
];

// Stealth SI (Super Intelligence) model family. The id is the upstream model
// name the gateway forwards; label + note are what the UI shows.
const SI_MODELS = [
  { id: "gpt-5.6-sol", name: "SI 1", tag: "fast · balanced", note: "5.6 — quick reasoning, default" },
  { id: "gpt-6.1-sol", name: "SI MAX", tag: "max capability", note: "6.1 — strongest reasoning" },
  { id: "gpt-6-astra", name: "SI ULTRA", tag: "ultra · high availability", note: "ASTRA — best availability 98%" },
];

type MemoryItem = {
  id: number; kind: string; content: string;
  importance: number; score?: number; hit_count?: number; created_at: string;
};

export default function Assistant() {
  const [question, setQuestion] = useState(EXAMPLES[0]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTrace, setShowTrace] = useState(false);
  const [mode, setMode] = useState<"fast" | "deep">("fast");
  const [model, setModel] = useState<string>(SI_MODELS[0].id);
  const [modeMeta, setModeMeta] = useState<{ mode: string; use_llm: boolean; max_iterations: number } | null>(null);
  const [recalled, setRecalled] = useState<MemoryItem[]>([]);
  const [memory, setMemory] = useState<{
    recent: MemoryItem[]; session: MemoryItem[]; stats: { long_term: number; short_term: number };
  } | null>(null);
  const [memQuery, setMemQuery] = useState("");
  const [memLoading, setMemLoading] = useState(false);

  const [stages, setStages] = useState<{ node: string; msg: string }[]>([]);

  async function loadMemory(query = memQuery) {
    setMemLoading(true);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("query", query.trim());
      const r = await fetch(`/api/memory?${params.toString()}`);
      const d = await r.json();
      if (d.recalled?.length) setRecalled(d.recalled);
      if (d.recent || d.session) setMemory({ recent: d.recent ?? [], session: d.session ?? [], stats: d.stats ?? { long_term: 0, short_term: 0 } });
    } catch { /* non-fatal */ } finally {
      setMemLoading(false);
    }
  }

  useEffect(() => { loadMemory(""); }, []);

  async function ask(q: string) {
    setLoading(true); setError(null); setResult(null); setStages([]); setModeMeta(null);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, k: 8, stream: true, mode, model }),
      });
      if (!r.ok || !r.body) {
        const d = await r.json().catch(() => null);
        setError(d?.error || `HTTP ${r.status}`);
        setLoading(false);
        return;
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const m = /^data: (.*)$/m.exec(raw.trim());
          if (!m) continue;
          try {
            const ev = JSON.parse(m[1]);
            if (ev.event === "error") {
              setError(ev.data?.error || "pipeline error");
            } else if (ev.event === "done") {
              if (ev.data?.result) setResult(ev.data.result);
              else {
                setStages((s) => [...s, {
                  node: "done",
                  msg: `confidence ${Math.round((ev.data?.confidence ?? 0) * 100)}% · ${ev.data?.latency_ms} ms`,
                }]);
              }
            } else if (ev.event === "mode") {
              setModeMeta({
                mode: ev.data?.mode ?? mode,
                use_llm: Boolean(ev.data?.use_llm),
                max_iterations: Number(ev.data?.max_iterations ?? 1),
              });
              setStages((s) => [...s, {
                node: "mode",
                msg: ev.data?.mode === "deep"
                  ? `deep reasoning — ${ev.data?.model ?? "SI"} · LLM plan · synthesize, ${ev.data?.max_iterations ?? 1} pass(es) max`
                  : `fast path — ${ev.data?.model ?? "Gemini"} · single-pass retrieval + synthesis`,
              }]);
            } else if (ev.event === "plan") {
              setStages((s) => [...s, {
                node: "plan",
                msg: `split into ${ev.data?.sub_questions?.length ?? 0} sub-questions`,
              }]);
            } else if (ev.event === "retrieve") {
              setStages((s) => [...s, {
                node: "retrieve",
                msg: `"${ev.data?.sub_question}" → ${ev.data?.n_hits} passages (${ev.data?.verdict})`,
              }]);
            } else if (ev.event === "expand") {
              setStages((s) => [...s, {
                node: "expand",
                msg: `query rewritten: ${(ev.data?.to ?? []).join("; ")}`,
              }]);
            } else if (ev.event === "memory") {
              setStages((s) => [...s, {
                node: "memory",
                msg: `recalled ${ev.data?.n_recalled ?? 0} relevant memor${(ev.data?.n_recalled ?? 0) === 1 ? "y" : "ies"} from vector store`,
              }]);
              setRecalled((ev.data?.contents ?? []).map((c: string) => ({
                id: -1, kind: "recalled", content: c, importance: 0, score: 0, created_at: new Date().toISOString(),
              })));
            } else if (ev.event === "memory_write") {
              setStages((s) => [...s, {
                node: "memory_write",
                msg: `${ev.data?.n_claims ?? 0} finding(s) persisted to long-term memory`,
              }]);
              loadMemory();
            } else if (ev.event === "synthesize") {
              setStages((s) => [...s, {
                node: "synthesize",
                msg: `${ev.data?.provider} · ${ev.data?.claims} claims`,
              }]);
            } else if (ev.event === "verify") {
              setStages((s) => [...s, {
                node: "verify",
                msg: `${Math.round((ev.data?.verified_ratio ?? 0) * 100)}% of claims traced`,
              }]);
            }
          } catch { /* skip malformed frame */ }
        }
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h3>
          AI Research Assistant{" "}
          <small>
            agentic RAG · plan → retrieve → grade → expand → synthesize → verify
            · ⚡ Gemini fast / 🧠 SI deep (SI 1 · SI MAX · SI ULTRA)
          </small>
        </h3>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about microgravity combustion, flame spread, extinction, smoke detection, suppression…"
        />
        <div className="row" style={{ marginTop: 11 }}>
          <button
            className="primary"
            disabled={loading || !question.trim()}
            onClick={() => ask(question)}
          >
            {loading ? <><span className="spin" /> researching…</> : "Run agentic analysis"}
          </button>
          {result && (
            <button className="ghost" onClick={() => setShowTrace((v) => !v)}>
              {showTrace ? "hide" : "show"} reasoning trace
            </button>
          )}
        </div>
        <div className="row" style={{ marginTop: 11, gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <div className="seg" role="group" aria-label="reasoning mode">
            <button
              className={mode === "fast" ? "seg-on" : ""}
              onClick={() => setMode("fast")}
              disabled={loading}
              title="Gemini flash — single-pass retrieval + synthesis (~5-12 s)"
            >
              ⚡ Fast · Gemini
            </button>
            <button
              className={mode === "deep" ? "seg-on" : ""}
              onClick={() => setMode("deep")}
              disabled={loading}
              title="SI deep model — LLM plan, retrieval passes and synthesis (~20-60 s)"
            >
              🧠 Deep · SI
            </button>
          </div>
          {mode === "deep" && (
            <div className="seg" role="group" aria-label="deep model">
              {SI_MODELS.map((m) => (
                <button
                  key={m.id}
                  className={model === m.id ? "seg-on" : ""}
                  onClick={() => setModel(m.id)}
                  disabled={loading}
                  title={`${m.id} — ${m.note}`}
                >
                  {m.name}
                </button>
              ))}
            </div>
          )}
          <span className="muted" style={{ fontSize: 11.5 }}>
            {mode === "deep"
              ? `Deep reasoning via ${SI_MODELS.find((m) => m.id === model)?.name ?? model} — LLM plan · synthesize · ${SI_MODELS.find((m) => m.id === model)?.note ?? ""}`
              : "Fast path via Gemini flash-lite — single-pass retrieval + synthesis"}
          </span>
          {modeMeta && (
            <span className="pill">
              mode: {modeMeta.mode} · {modeMeta.use_llm ? "LLM" : "extractive"} · ≤{modeMeta.max_iterations} pass(es)
            </span>
          )}
        </div>
        <div className="row" style={{ marginTop: 12, gap: 7 }}>
          {EXAMPLES.map((e, i) => (
            <button
              key={i}
              className="ghost"
              style={{ fontSize: 11.5, flex: "0 1 auto" }}
              onClick={() => { setQuestion(e); ask(e); }}
              disabled={loading}
            >
              {e.length > 58 ? e.slice(0, 58) + "…" : e}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="card err">Agent error: {error}</div>}

      {loading && (
        <div className="card muted">
          <div className="row" style={{ marginBottom: 6 }}>
            <span className="spin" /> Running the agent — updates appear as each stage completes.
          </div>
          <ul className="stream" style={{ margin: 0, paddingLeft: 18 }}>
            {stages.map((st, i) => (
              <li key={i}>
                <span className="tag">{st.node}</span> {st.msg}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result && (
        <>
          <div className="card">
            <div className="row" style={{ marginBottom: 12 }}>
              <span className="pill">
                <span className={`dot ${result.grounded ? "" : "warn"}`} />
                {result.grounded ? "grounded" : "low grounding"}
              </span>
              <span className="pill">confidence {(result.confidence * 100).toFixed(0)}%</span>
              <span className="pill">{result.claims.length} cited claims</span>
              <span className="pill">{result.evidence.length} passages</span>
              <span className="pill">{result.iterations} retrieval pass(es)</span>
              <span className="pill">{result.latency_ms} ms</span>
              <span className="pill">provider: {result.provider}</span>
            </div>

            <h3>Answer</h3>
            <div className="answer">{result.answer}</div>

            <h3 style={{ marginTop: 16 }}>
              Sub-questions <small>decomposed by the planner</small>
            </h3>
            <ol className="muted" style={{ margin: 0, paddingLeft: 20 }}>
              {result.sub_questions.map((s, i) => <li key={i}>{s}</li>)}
            </ol>
          </div>

          <div className="grid g2">
            <div className="card">
              <h3>
                Evidence &amp; sources <small>each claim traced to its passage</small>
              </h3>
              <div className="scroll">
                {result.claims.map((c, i) => (
                  <div key={i} className="hit">
                    <div className="t">
                      [{i + 1}] {c.title}
                      {c.verified === false && <span className="tag sev-high" style={{ marginLeft: 7 }}>unverified</span>}
                    </div>
                    <div className="meta">
                      NTRS {c.source_id} · section: {c.section} · support {c.support_score?.toFixed(3)}
                    </div>
                    <div className="quote">{c.quote}</div>
                    {c.landing_url && (
                      <a href={c.landing_url} target="_blank" rel="noreferrer" style={{ fontSize: 11.5 }}>
                        open source document ↗
                      </a>
                    )}
                  </div>
                ))}
                {result.claims.length === 0 && (
                  <div className="muted">No grounded claims were extracted for this question.</div>
                )}
              </div>
            </div>

            <div className="card">
              <h3>
                Ranked passages <small>hybrid RRF + smart ranking</small>
              </h3>
              <div className="scroll">
                {result.evidence.map((h, i) => (
                  <div key={h.chunk_id} className="hit">
                    <div className="t">[{i + 1}] {h.title}</div>
                    <div className="meta">
                      NTRS {h.source_id} · {h.kind}
                      {h.section_path ? ` · ${h.section_path}` : ""} · relevance {h.relevance}
                    </div>
                    <div className="body">{h.content.slice(0, 460)}…</div>
                    <div className="bar">
                      <i style={{ width: `${Math.min(100, h.final_score * 100)}%` }} />
                    </div>
                    <div className="meta" style={{ marginTop: 6, marginBottom: 0 }}>
                      fused {h.final_score.toFixed(3)} · vector {h.vector_score.toFixed(3)} ·
                      keyword {h.keyword_score.toFixed(3)} · rerank {h.rerank_score.toFixed(3)} ·
                      quality {h.quality_score.toFixed(3)}
                    </div>
                    <div className="meta" style={{ marginBottom: 0 }}>
                      matched sub-question: {h.sub_question}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {showTrace && (
            <div className="card">
              <h3>Reasoning trace <small>persisted in ignis.agent_step</small></h3>
              <table>
                <thead>
                  <tr><th>#</th><th>node</th><th>detail</th></tr>
                </thead>
                <tbody>
                  {result.trace.map((t, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td>
                      <td><span className="tag">{t.node}</span></td>
                      <td>
                        <code style={{ fontSize: 11.5, color: "#c3ccdd" }}>
                          {JSON.stringify(
                            Object.fromEntries(Object.entries(t).filter(([k]) => k !== "node")),
                          ).slice(0, 420)}
                        </code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <div className="card">
        <h3>
          🧠 Agent memory <small>short-term (session) + long-term (cross-session) vector memory</small>
        </h3>
        {memory && (
          <div className="row" style={{ marginBottom: 10 }}>
            <span className="pill">{memory.stats.long_term} long-term</span>
            <span className="pill">{memory.stats.short_term} short-term</span>
          </div>
        )}
        <div className="row" style={{ marginBottom: 10, gap: 7 }}>
          <input
            style={{ flex: 1 }}
            placeholder="Vector-recall memory by topic — e.g. 'flame spread rate'"
            value={memQuery}
            onChange={(e) => setMemQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") loadMemory(); }}
          />
          <button className="ghost" onClick={() => loadMemory()} disabled={memLoading}>
            {memLoading ? "recalling…" : "Recall"}
          </button>
        </div>

        {recalled.length > 0 && (
          <div className="hit" style={{ marginBottom: 10 }}>
            <div className="t">Vector recall results</div>
            <div className="scroll" style={{ maxHeight: 180 }}>
              {recalled.map((m, i) => (
                <div key={i} className="meta" style={{ marginBottom: 4 }}>
                  <span className="tag">{m.kind}</span> {m.content}
                  {m.score != null && m.score > 0 ? ` · ${(m.score * 100).toFixed(0)}% similar` : ""}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid g2">
          <div>
            <div className="muted" style={{ marginBottom: 6 }}>Long-term store (most valuable)</div>
            <div className="scroll" style={{ maxHeight: 240 }}>
              {(memory?.recent ?? []).map((m) => (
                <div key={m.id} className="hit">
                  <div className="t">
                    <span className="tag">{m.kind}</span> importance {(m.importance * 100).toFixed(0)}%
                    {m.hit_count ? ` · recalled ${m.hit_count}x` : ""}
                  </div>
                  <div className="body">{m.content}</div>
                </div>
              ))}
              {(memory?.recent ?? []).length === 0 && (
                <div className="muted">No long-term memories yet — ask a question to seed the store.</div>
              )}
            </div>
          </div>
          <div>
            <div className="muted" style={{ marginBottom: 6 }}>Short-term store (this session)</div>
            <div className="scroll" style={{ maxHeight: 240 }}>
              {(memory?.session ?? []).map((m) => (
                <div key={m.id} className="hit">
                  <div className="t"><span className="tag">{m.kind}</span></div>
                  <div className="body">{m.content}</div>
                </div>
              ))}
              {(memory?.session ?? []).length === 0 && (
                <div className="muted">Session memory tracks questions/answers for this conversation.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
