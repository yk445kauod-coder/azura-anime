import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { ErrorState, Loading } from "@/components/States";

/**
 * Smart Ranking explorer.
 *
 * This is the retrieval-quality surface. It runs the real pipeline
 * (hybrid vector+keyword → RRF fusion → lexical rerank → weighted smart rank →
 * MMR diversification) and shows every intermediate score, so a reviewer can
 * see exactly why a passage was ranked where it was rather than trusting a
 * black box.
 */

type Factors = {
  fusion: number; rerank: number; quality: number; domain: number;
  fusion_raw: number; rerank_raw: number; quality_raw: number; domain_raw: number;
};
type Hit = {
  chunk_id: number; document_id: number; title: string; source_id: string;
  kind: string; section_path: string | null; content: string;
  vector_score: number; keyword_score: number; fused_score: number;
  rerank_score: number; final_score: number; quality_score: number;
  landing_url: string; published_date: string | null; relevance: string;
  factors?: Factors; pre_rank: number; diversified: boolean;
};
type RankResult = {
  query: string; k: number; pool: number; latency_ms: number;
  weights: { fusion: number; rerank: number; quality: number; domain: number };
  verdict: string; grade_score: number; hits: Hit[];
};

const EXAMPLES = [
  "flame spread rate over PMMA in microgravity",
  "limiting oxygen concentration spacecraft fire safety",
  "radiative extinction of diffusion flames",
  "smoke particle size microgravity fire detection",
  "SAFFIRE large-scale fire growth",
];

const FACTOR_META: { key: keyof Factors; raw: keyof Factors; label: string; color: string }[] = [
  { key: "fusion", raw: "fusion_raw", label: "Fusion", color: "var(--flame)" },
  { key: "rerank", raw: "rerank_raw", label: "Rerank", color: "var(--cyan)" },
  { key: "quality", raw: "quality_raw", label: "Quality", color: "var(--green)" },
  { key: "domain", raw: "domain_raw", label: "Domain", color: "var(--violet, #a78bfa)" },
];

const VERDICT_STYLE: Record<string, { label: string; cls: string }> = {
  sufficient: { label: "sufficient evidence", cls: "" },
  partial: { label: "partial evidence", cls: "warnpill" },
  insufficient: { label: "insufficient evidence", cls: "warnpill" },
};

export default function SmartRanking() {
  const { t } = useI18n();
  const [query, setQuery] = useState(EXAMPLES[0]);
  const [result, setResult] = useState<RankResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  async function run(q = query) {
    if (!q.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/rank?q=${encodeURIComponent(q)}&k=10`);
      const d = await r.json();
      if (d.error) setError(d.error);
      else setResult(d);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoading(false);
    }
  }

  const verdict = result ? VERDICT_STYLE[result.verdict] ?? { label: result.verdict, cls: "" } : null;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h3>
          {t("Smart Ranking")}{" "}
          <small>{t("explainable hybrid retrieval — every score, in the open")}</small>
        </h3>
        <div className="muted" style={{ marginBottom: 10 }}>
          {t(
            "Hybrid vector + keyword search fused with reciprocal rank fusion, refined by a lexical rerank, then weighted by corpus quality and combustion-domain density before MMR diversification removes near-duplicates.",
          )}
        </div>
        <div className="row">
          <input
            style={{ flex: "2 1 320px" }}
            placeholder={t("Query the corpus — e.g. flame spread rate in microgravity")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !loading) run(); }}
          />
          <button className="primary" onClick={() => run()} disabled={loading || !query.trim()}>
            {loading ? <><span className="spin" /> {t("ranking…")}</> : t("Rank passages")}
          </button>
        </div>
        <div className="examples">
          {EXAMPLES.map((e, i) => (
            <button key={i} className="chip" onClick={() => { setQuery(e); run(e); }} disabled={loading}>
              {e}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorState title="Ranking failed" message={error} onRetry={() => run()} />}

      {loading && !result && (
        <Loading
          title={t("Running the retrieval pipeline…")}
          sub={t("Embedding the query, fusing vector and keyword legs, reranking, then diversifying.")}
          rows={5}
        />
      )}

      {result && (
        <>
          <div className="card">
            <div className="pillrow">
              {verdict && (
                <span className={`pill ${verdict.cls}`}>
                  <span className={`dot ${result.verdict === "sufficient" ? "" : "warn"}`} />
                  {t(verdict.label)}
                </span>
              )}
              <span className="pill">{result.pool} {t("candidate passages")}</span>
              <span className="pill">{result.hits.length} {t("ranked")}</span>
              <span className="pill">{result.hits.filter((h) => h.diversified).length} {t("kept after MMR")}</span>
              <span className="pill">{result.latency_ms} ms</span>
              <span className="pill mono">grade {result.grade_score}</span>
            </div>

            <div className="row" style={{ gap: 14, flexWrap: "wrap", marginTop: 10 }}>
              {FACTOR_META.map((f) => (
                <span key={f.key} className="state-row" style={{ gap: 6, fontSize: 11.6 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: f.color, display: "inline-block" }} />
                  <span className="muted">
                    {t(f.label)} · {result.weights[f.key as keyof typeof result.weights]}
                  </span>
                </span>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="cardhead">
              <h3>{t("Ranked passages")}</h3>
              <span className="muted">
                {t("top")} {Math.min(15, result.hits.length)} {t("of")} {result.hits.length} · {t("stacked bar shows each weighted contribution")}
              </span>
            </div>
            <div className="scroll">
              {result.hits.slice(0, 15).map((h) => {
                const f = h.factors;
                const open = expanded === h.chunk_id;
                return (
                  <div key={h.chunk_id} className="hit">
                    <div className="hittitle">
                      <sup className="cite">#{h.pre_rank}</sup> {h.title}
                      {!h.diversified && (
                        <span className="tag" title={t("Removed by MMR as a near-duplicate of a higher-ranked passage")}>
                          {t("dropped · duplicate")}
                        </span>
                      )}
                      <span className="ms-auto" style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className="mono" style={{ fontSize: 12.5 }}>{h.final_score.toFixed(4)}</span>
                      </span>
                    </div>
                    <div className="meta">
                      NTRS {h.source_id} · {h.kind}
                      {h.section_path ? ` · ${h.section_path}` : ""}
                      {h.published_date ? ` · ${String(h.published_date).slice(0, 10)}` : ""}
                    </div>

                    {f && (
                      <div className="rankbar" aria-hidden="true">
                        {FACTOR_META.map((fm) => (
                          <i
                            key={fm.key}
                            title={`${t(fm.label)}: ${(f[fm.key] as number).toFixed(4)}`}
                            style={{
                              width: `${Math.max(0, Math.min(1, f[fm.key] as number)) * 100}%`,
                              background: fm.color,
                            }}
                          />
                        ))}
                      </div>
                    )}

                    <div className="body" style={{ marginTop: 8 }}>
                      {open ? h.content : `${h.content.slice(0, 300)}…`}
                    </div>

                    <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                      <button className="ghost" style={{ fontSize: 11.5 }} onClick={() => setExpanded(open ? null : h.chunk_id)}>
                        {open ? t("Hide score breakdown") : t("Show score breakdown")}
                      </button>
                      {h.landing_url && (
                        <a href={h.landing_url} target="_blank" rel="noreferrer" style={{ fontSize: 11.5 }}>
                          {t("open on NTRS ↗")}
                        </a>
                      )}
                    </div>

                    {open && f && (
                      <table className="ranktable">
                        <thead>
                          <tr>
                            <th>{t("Factor")}</th>
                            <th>{t("Raw")}</th>
                            <th>{t("Weight")}</th>
                            <th>{t("Contribution")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {FACTOR_META.map((fm) => (
                            <tr key={fm.key}>
                              <td>
                                <span style={{ width: 9, height: 9, borderRadius: 2, background: fm.color, display: "inline-block", marginInlineEnd: 7 }} />
                                {t(fm.label)}
                              </td>
                              <td className="mono">{(f[fm.raw] as number).toFixed(4)}</td>
                              <td className="mono">{result.weights[fm.key as keyof typeof result.weights]}</td>
                              <td className="mono">{(f[fm.key] as number).toFixed(4)}</td>
                            </tr>
                          ))}
                          <tr>
                            <td><strong>{t("Final score")}</strong></td>
                            <td />
                            <td />
                            <td className="mono"><strong>{h.final_score.toFixed(4)}</strong></td>
                          </tr>
                          <tr>
                            <td className="muted">{t("Retrieval legs")}</td>
                            <td className="mono" colSpan={3}>
                              vector {h.vector_score.toFixed(3)} · keyword {h.keyword_score.toFixed(3)} · fused {h.fused_score.toFixed(3)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    )}
                  </div>
                );
              })}
              {result.hits.length === 0 && (
                <div className="muted">{t("No passages matched this query.")}</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
