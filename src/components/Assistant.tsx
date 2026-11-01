"use client";

import { useState } from "react";

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

export default function Assistant() {
  const [question, setQuestion] = useState(EXAMPLES[0]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTrace, setShowTrace] = useState(false);

  async function ask(q: string) {
    setLoading(true); setError(null); setResult(null);
    try {
      const r = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, k: 8 }),
      });
      const d = await r.json();
      if (d.error) setError(d.error);
      else setResult(d);
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
          <span className="spin" /> Decomposing the question, running hybrid retrieval over
          the corpus, grading evidence and verifying every claim…
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
    </div>
  );
}
