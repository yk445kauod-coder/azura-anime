import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

type Doc = {
  id: number; source_id: string; title: string; kind: string; abstract: string | null;
  authors: string[] | null; published_date: string | null; word_count: number;
  quality_score: number; has_fulltext: boolean; landing_url: string; chunks: number;
};

const KINDS = [
  "", "experiment_report", "conference_paper", "journal_article", "technical_memo",
  "presentation", "workshop_proceedings", "final_report", "other",
];

export default function Explorer({ focusRef }: { focusRef?: string }) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("");
  const [experiment, setExperiment] = useState("");
  const [docs, setDocs] = useState<Doc[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<{
    document: Doc & { abstract: string; keywords: string[]; report_numbers: string[]; center: string };
    chunks: { id: number; ordinal: number; kind: string; section_path: string | null; token_count: number; preview: string; embedded: boolean }[];
    findings: { metric: string; value: number; unit: string; statement: string; evidence_quote: string }[];
    experiments: { code: string; name: string }[];
  } | null>(null);
  const [experiments, setExperiments] = useState<{ code: string; name: string }[]>([]);

  async function load(offset = 0) {
    setLoading(true);
    const p = new URLSearchParams({ q: query, limit: "25", offset: String(offset) });
    if (kind) p.set("kind", kind);
    if (experiment) p.set("experiment", experiment);
    const r = await fetch(`/api/documents?${p}`);
    const d = await r.json();
    setDocs(d.documents ?? []);
    setTotal(d.total ?? 0);
    setLoading(false);
  }

  useEffect(() => {
    fetch("/api/experiments")
      .then((r) => r.json())
      .then((d) => setExperiments(d.experiments ?? []))
      .catch(() => {});
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openDoc(id: number) {
    const r = await fetch(`/api/documents/${id}`);
    setDetail(await r.json());
  }

  // Deep link from search: NTRS ids are what the index returns, so look the
  // document up directly and open its inspector.
  useEffect(() => {
    if (!focusRef) return;
    (async () => {
      const r = await fetch(`/api/documents?q=${encodeURIComponent(focusRef)}&limit=1`);
      const d = await r.json();
      const hit = (d.documents ?? [])[0];
      if (hit) { setQuery(focusRef); setDocs(d.documents); setTotal(d.total ?? 1); void openDoc(hit.id); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRef]);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h3>{t("Experiment Explorer ")}<small>search the harvested NASA corpus</small></h3>
        <div className="row">
          <input
            style={{ flex: "3 1 320px" }}
            placeholder={t("Search titles and full text — e.g. flame spread PMMA, cool flame, smoke detector")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && load()}
          />
          <select style={{ flex: "1 1 170px" }} value={kind} onChange={(e) => setKind(e.target.value)}>
            {KINDS.map((k) => <option key={k} value={k}>{k ? k.replace(/_/g, " ") : "all types"}</option>)}
          </select>
          <select style={{ flex: "1 1 170px" }} value={experiment} onChange={(e) => setExperiment(e.target.value)}>
            <option value="">all experiments</option>
            {experiments.map((e) => <option key={e.code} value={e.code}>{e.code}</option>)}
          </select>
          <button className="primary" onClick={() => load()} disabled={loading}>
            {loading ? "searching…" : "Search"}
          </button>
        </div>
        <div className="muted" style={{ marginTop: 9 }}>
          {total.toLocaleString()} matching documents
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <h3>{t("Results")}</h3>
          <div className="scroll">
            {docs.map((d) => (
              <div key={d.id} className="hit">
                <div className="t">{d.title}</div>
                <div className="meta">
                  NTRS {d.source_id} · {d.kind.replace(/_/g, " ")} ·{" "}
                  {d.published_date ? String(d.published_date).slice(0, 10) : "undated"} ·{" "}
                  {(d.word_count ?? 0).toLocaleString()} words · {d.chunks} chunks · quality{" "}
                  {d.quality_score?.toFixed(3)}
                </div>
                {d.abstract && <div className="body">{d.abstract.slice(0, 300)}…</div>}
                <div className="row" style={{ marginTop: 9 }}>
                  <button className="ghost" onClick={() => openDoc(d.id)}>inspect</button>
                  <a className="ghost" style={{ padding: "9px 14px" }} href={d.landing_url} target="_blank" rel="noreferrer">
                    NTRS ↗
                  </a>
                </div>
              </div>
            ))}
            {docs.length === 0 && !loading && (
              <div className="muted">
                No documents. Run <code>npm run pipeline:all</code> to harvest the corpus.
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <h3>Document inspector {detail && <small>{t("NTRS")} {detail.document.source_id}</small>}</h3>
          {!detail && <div className="muted">{t("Select a document to inspect its chunks, findings and experiment links.")}</div>}
          {detail && (
            <div className="scroll">
              <div style={{ fontWeight: 700, marginBottom: 6 }}>{detail.document.title}</div>
              <div className="muted" style={{ marginBottom: 10 }}>
                {detail.document.center ?? "—"} · {(detail.document.word_count ?? 0).toLocaleString()} words
                {detail.document.report_numbers?.length
                  ? ` · ${detail.document.report_numbers.join(", ")}`
                  : ""}
              </div>
              {detail.experiments.length > 0 && (
                <div style={{ marginBottom: 10 }}>
                  {detail.experiments.map((e) => (
                    <span key={e.code} className="tag">{e.code}</span>
                  ))}
                </div>
              )}
              {detail.document.keywords?.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  {detail.document.keywords.slice(0, 14).map((k) => (
                    <span key={k} className="tag">{k}</span>
                  ))}
                </div>
              )}

              <h3 style={{ fontSize: 12.5, marginTop: 14 }}>
                Chunks ({detail.chunks.length}) — embedded{" "}
                {detail.chunks.filter((c) => c.embedded).length}
              </h3>
              {detail.chunks.slice(0, 25).map((c) => (
                <div key={c.id} className="hit">
                  <div className="meta" style={{ marginBottom: 4 }}>
                    #{c.ordinal} · {c.kind} · {c.section_path ?? "—"} · {c.token_count} tok ·{" "}
                    {c.embedded ? "vector ✓" : "no vector"}
                  </div>
                  <div className="body">{c.preview}…</div>
                </div>
              ))}

              <h3 style={{ fontSize: 12.5, marginTop: 14 }}>
                Extracted findings ({detail.findings.length})
              </h3>
              {detail.findings.length === 0 && (
                <div className="muted">{t("No metric-bearing statements matched the extraction rules.")}</div>
              )}
              {detail.findings.slice(0, 25).map((f, i) => (
                <div key={i} className="hit">
                  <div className="t">{f.statement}</div>
                  <div className="quote">{f.evidence_quote}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
