import { useCallback, useEffect, useRef, useState } from "react";
import { postSse } from "@/lib/sse";
import Markdown from "@/components/Markdown";

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
type Stage = { node: string; msg: string };

const EXAMPLES = [
  "How does flame spread over solid fuels differ in microgravity compared with Earth?",
  "What is the limiting oxygen concentration for spacecraft fire safety?",
  "How do smoke and soot particles behave in microgravity, and what does it mean for fire detection?",
  "Why is fire suppression harder in microgravity, and which agents were tested?",
  "What did SAFFIRE teach us about large-scale fire growth in spacecraft?",
];

// The gateway forwards these ids upstream; the label is what the UI shows.
const MODELS = [
  { id: "gpt-5.6-sol", name: "SI 1", note: "fast · balanced" },
  { id: "gpt-6.1-sol", name: "SI MAX", note: "stronger reasoning" },
  { id: "gpt-6-astra", name: "SI ULTRA", note: "best availability" },
];

const NODE_LABEL: Record<string, string> = {
  memory: "recall",
  mode: "setup",
  plan: "plan",
  retrieve: "retrieve",
  grade: "grade",
  expand: "expand",
  synthesize: "synthesize",
  verify: "verify",
  memory_write: "remember",
  done: "done",
};

type MemoryItem = {
  id: number; kind: string; content: string;
  importance: number; score?: number; hit_count?: number; created_at: string;
};

/** Stable per-browser conversation id so session memory survives reloads. */
function useConversationId(): string {
  const ref = useRef<string>("");
  if (!ref.current) {
    let id = localStorage.getItem("ignis.conversation_id");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("ignis.conversation_id", id);
    }
    ref.current = id;
  }
  return ref.current;
}

export default function Assistant() {
  const conversationId = useConversationId();
  const [question, setQuestion] = useState(EXAMPLES[0]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTrace, setShowTrace] = useState(false);
  const [mode, setMode] = useState<"fast" | "deep">("fast");
  const [model, setModel] = useState<string>(MODELS[0].id);
  const [stages, setStages] = useState<Stage[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [recalled, setRecalled] = useState<MemoryItem[]>([]);
  const [memory, setMemory] = useState<{
    recent: MemoryItem[]; session: MemoryItem[]; stats: { long_term: number; short_term: number };
  } | null>(null);
  const [memQuery, setMemQuery] = useState("");
  const [memLoading, setMemLoading] = useState(false);

  const loadMemory = useCallback(async (query = "") => {
    setMemLoading(true);
    try {
      const params = new URLSearchParams({ conversation_id: conversationId });
      if (query.trim()) params.set("query", query.trim());
      const d = await (await fetch(`/api/memory?${params}`)).json();
      if (d.recalled?.length) setRecalled(d.recalled);
      if (d.recent || d.session) {
        setMemory({
          recent: d.recent ?? [],
          session: d.session ?? [],
          stats: d.stats ?? { long_term: 0, short_term: 0 },
        });
      }
    } catch {
      // memory panel is non-critical
    } finally {
      setMemLoading(false);
    }
  }, [conversationId]);

  useEffect(() => { loadMemory(""); }, [loadMemory]);

  // Tick a timer while a run is in flight so the wait is visible.
  useEffect(() => {
    if (!loading) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed((Date.now() - started) / 1000), 250);
    return () => clearInterval(t);
  }, [loading]);

  const push = (node: string, msg: string) => setStages((s) => [...s, { node, msg }]);

  async function ask(q: string) {
    setLoading(true); setError(null); setResult(null); setStages([]); setElapsed(0);
    try {
      await postSse("/api/ask", {
        question: q, k: 8, stream: true, mode, model, conversation_id: conversationId,
      }, (ev) => {
        const d = ev.data ?? {};
        switch (ev.event) {
          case "memory":
            push("memory", `recalled ${d.n_recalled} memor${d.n_recalled === 1 ? "y" : "ies"} from vector store`);
            if (d.contents?.length) {
              setRecalled(d.contents.map((c: string) => ({
                id: -1, kind: "recalled", content: c, importance: 0, score: 0,
                created_at: new Date().toISOString(),
              })));
            }
            break;
          case "mode":
            push("mode", `${d.mode === "deep" ? "deep" : "fast"} path · ${d.model ?? "model"}${d.max_iterations > 1 ? ` · ≤${d.max_iterations} passes` : ""}`);
            break;
          case "plan":
            push("plan", `split into ${d.sub_questions?.length ?? 0} sub-question(s)`);
            break;
          case "retrieve":
            push("retrieve", `"${d.sub_question}" → ${d.n_hits} passage(s) · ${d.verdict}`);
            break;
          case "grade":
            push("grade", `evidence ${d.verdict} (score ${d.score})`);
            break;
          case "expand":
            push("expand", `rewrote the query: ${(d.to ?? []).join("; ")}`);
            break;
          case "synthesize":
            push("synthesize", `${d.model} drafted ${d.claims} cited claim(s)`);
            break;
          case "verify":
            push("verify", `${Math.round((d.verified_ratio ?? 0) * 100)}% of claims traced to a passage`);
            break;
          case "memory_write":
            push("memory_write", `${d.n_claims} finding(s) saved to long-term memory`);
            loadMemory();
            break;
          case "error":
            setError(d.error || "agent error");
            break;
          case "done":
            // The worker sends the result inline in `data`.
            setResult(d as AskResult);
            push("done", `${Math.round((d.confidence ?? 0) * 100)}% confidence · ${d.latency_ms} ms`);
            break;
        }
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const activeModel = MODELS.find((m) => m.id === model) ?? MODELS[0];

  return (
    <div className="stack">
      <div className="card">
        <div className="cardhead">
          <h3>Ask the research agent</h3>
          <span className="muted">plan → retrieve → grade → expand → synthesize → verify</span>
        </div>

        <textarea
          className="ask-input"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && question.trim() && !loading) ask(question);
          }}
          placeholder="Ask about flame spread, extinction, smoke detection, suppression, oxygen limits…"
        />

        <div className="controls">
          <div className="seg" role="group" aria-label="reasoning mode">
            <button
              className={mode === "fast" ? "seg-on" : ""}
              onClick={() => setMode("fast")}
              disabled={loading}
              title="Single retrieval pass — fastest (~8-12 s)"
            >
              Fast
            </button>
            <button
              className={mode === "deep" ? "seg-on" : ""}
              onClick={() => setMode("deep")}
              disabled={loading}
              title="LLM plans sub-questions, then synthesizes (~20-40 s)"
            >
              Deep
            </button>
          </div>

          <select
            className="select"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={loading}
            title={activeModel.note}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>{m.name} — {m.note}</option>
            ))}
          </select>

          <button className="primary" disabled={loading || !question.trim()} onClick={() => ask(question)}>
            {loading ? <><span className="spin" /> researching…</> : "Run research"}
          </button>

          {loading && <span className="muted mono">{elapsed.toFixed(1)}s</span>}

          {result && (
            <button className="ghost" onClick={() => setShowTrace((v) => !v)}>
              {showTrace ? "Hide" : "Show"} trace
            </button>
          )}
        </div>

        <div className="examples">
          {EXAMPLES.map((e, i) => (
            <button key={i} className="chip" onClick={() => { setQuestion(e); ask(e); }} disabled={loading}>
              {e.length > 62 ? e.slice(0, 62) + "…" : e}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="card err">
          <strong>Agent error.</strong> {error}
        </div>
      )}

      {loading && (
        <div className="card">
          <div className="cardhead">
            <h3><span className="spin" /> Working</h3>
            <span className="muted mono">{elapsed.toFixed(1)}s elapsed</span>
          </div>
          <ol className="timeline">
            {stages.map((st, i) => (
              <li key={i}>
                <span className="tag">{NODE_LABEL[st.node] ?? st.node}</span>
                <span>{st.msg}</span>
              </li>
            ))}
            {stages.length === 0 && <li className="muted">contacting the agent…</li>}
          </ol>
        </div>
      )}

      {result && (
        <>
          <div className="card">
            <div className="pillrow">
              <span className="pill">
                <span className={`dot ${result.grounded ? "" : "warn"}`} />
                {result.grounded ? "grounded in sources" : "low grounding"}
              </span>
              <span className="pill">confidence {(result.confidence * 100).toFixed(0)}%</span>
              <span className="pill">{result.claims.length} cited claims</span>
              <span className="pill">{result.evidence.length} passages</span>
              <span className="pill">{(result.latency_ms / 1000).toFixed(1)}s</span>
              <span className="pill">{result.model}</span>
            </div>

            <h3 className="sectionhead">Answer</h3>
            <div className="answer">
              <Markdown text={result.answer} />
            </div>

            {result.sub_questions.length > 0 && (
              <>
                <h3 className="sectionhead">Sub-questions</h3>
                <ol className="sublist">
                  {result.sub_questions.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              </>
            )}
          </div>

          <div className="grid g2">
            <div className="card">
              <div className="cardhead">
                <h3>Evidence &amp; sources</h3>
                <span className="muted">each claim traced to a passage</span>
              </div>
              <div className="scroll">
                {result.claims.map((c, i) => (
                  <div key={i} className="hit">
                    <div className="hittitle">
                      <sup className="cite">[{i + 1}]</sup> {c.title}
                      {c.verified === false && <span className="tag sev-high">unverified</span>}
                    </div>
                    <div className="meta">
                      NTRS {c.source_id} · {c.section} · support {c.support_score?.toFixed(3)}
                    </div>
                    <blockquote className="quote">{c.quote}</blockquote>
                    {c.landing_url && (
                      <a href={c.landing_url} target="_blank" rel="noreferrer">open source document ↗</a>
                    )}
                  </div>
                ))}
                {result.claims.length === 0 && (
                  <div className="muted">No grounded claims were extracted for this question.</div>
                )}
              </div>
            </div>

            <div className="card">
              <div className="cardhead">
                <h3>Ranked passages</h3>
                <span className="muted">hybrid RRF + smart ranking</span>
              </div>
              <div className="scroll">
                {result.evidence.map((h, i) => (
                  <div key={h.chunk_id} className="hit">
                    <div className="hittitle"><sup className="cite">[{i + 1}]</sup> {h.title}</div>
                    <div className="meta">
                      NTRS {h.source_id} · {h.kind}
                      {h.section_path ? ` · ${h.section_path}` : ""} · {h.relevance}
                    </div>
                    <div className="body">{h.content.slice(0, 420)}…</div>
                    <div className="bar"><i style={{ width: `${Math.min(100, h.final_score * 100)}%` }} /></div>
                    <div className="meta">
                      fused {h.final_score.toFixed(3)} · vector {h.vector_score.toFixed(3)} ·
                      keyword {h.keyword_score.toFixed(3)} · rerank {h.rerank_score.toFixed(3)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {showTrace && (
            <div className="card">
              <div className="cardhead">
                <h3>Reasoning trace</h3>
                <span className="muted">run {result.run_id.slice(0, 8)}</span>
              </div>
              <ol className="timeline">
                {result.trace.map((t, i) => (
                  <li key={i}>
                    <span className="tag">{NODE_LABEL[t.node] ?? t.node}</span>
                    <code className="code">
                      {JSON.stringify(
                        Object.fromEntries(Object.entries(t).filter(([k]) => k !== "node")),
                      ).slice(0, 260)}
                    </code>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}

      <div className="card">
        <div className="cardhead">
          <h3>Agent memory</h3>
          <span className="muted">session + cross-session vector memory</span>
        </div>
        {memory && (
          <div className="pillrow">
            <span className="pill">{memory.stats.long_term} long-term</span>
            <span className="pill">{memory.stats.short_term} short-term</span>
          </div>
        )}
        <div className="controls">
          <input
            className="grow"
            placeholder="Recall memory by topic — e.g. 'flame spread rate'"
            value={memQuery}
            onChange={(e) => setMemQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") loadMemory(memQuery); }}
          />
          <button className="ghost" onClick={() => loadMemory(memQuery)} disabled={memLoading}>
            {memLoading ? "recalling…" : "Recall"}
          </button>
        </div>

        {recalled.length > 0 && (
          <div className="hit">
            <div className="hittitle">Vector recall</div>
            <div className="scroll short">
              {recalled.map((m, i) => (
                <div key={i} className="meta">
                  <span className="tag">{m.kind}</span> {m.content}
                  {m.score ? ` · ${(m.score * 100).toFixed(0)}% similar` : ""}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid g2">
          <div>
            <div className="subhead">Long-term store</div>
            <div className="scroll short">
              {(memory?.recent ?? []).map((m) => (
                <div key={m.id} className="hit">
                  <div className="meta">
                    <span className="tag">{m.kind}</span> importance {(m.importance * 100).toFixed(0)}%
                    {m.hit_count ? ` · recalled ${m.hit_count}×` : ""}
                  </div>
                  <div className="body">{m.content}</div>
                </div>
              ))}
              {(memory?.recent ?? []).length === 0 && (
                <div className="muted">Empty — ask a question to seed the store.</div>
              )}
            </div>
          </div>
          <div>
            <div className="subhead">This session</div>
            <div className="scroll short">
              {(memory?.session ?? []).map((m) => (
                <div key={m.id} className="hit">
                  <div className="meta"><span className="tag">{m.kind}</span></div>
                  <div className="body">{m.content}</div>
                </div>
              ))}
              {(memory?.session ?? []).length === 0 && (
                <div className="muted">Session memory appears after your first question.</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
