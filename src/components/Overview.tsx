"use client";

import { useEffect, useState } from "react";

type Stats = {
  stats: Record<string, number>;
  byKind: { kind: string; n: number }[];
  byYear: { year: number; n: number }[];
  topDocs: {
    id: number;
    source_id: string;
    title: string;
    kind: string;
    word_count: number;
    quality_score: number;
    published_date: string | null;
    landing_url: string;
    chunks: number;
  }[];
  topMetrics: {
    metric: string;
    n: number;
    min_value: number | null;
    max_value: number | null;
    unit: string | null;
  }[];
  pipeline: {
    stage: string;
    status: string;
    items_in: number;
    items_out: number;
    bytes_in: number;
    started_at: string;
    finished_at: string | null;
  }[];
};

const fmt = (n?: number) =>
  typeof n === "number" ? n.toLocaleString("en-US") : "—";

export default function Overview() {
  const [data, setData] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/stats")
      .then((r) => r.json())
      .then((d) => (d.error ? setError(d.error) : setData(d)))
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="err">Failed to load stats: {error}</div>;
  if (!data) return <div className="muted"><span className="spin" /> loading corpus statistics…</div>;

  const s = data.stats ?? {};
  const maxYear = Math.max(1, ...data.byYear.map((y) => y.n));

  const cards = [
    { k: "Documents", v: fmt(s.documents), s: `${fmt(s.documents_with_fulltext)} with full text` },
    { k: "Text chunks", v: fmt(s.chunks), s: `${fmt(s.embeddings)} embedded vectors` },
    { k: "Corpus words", v: fmt(s.corpus_words), s: `${((s.corpus_chars ?? 0) / 1e6).toFixed(1)} M characters` },
    { k: "Artifacts stored", v: fmt(s.artifact_bytes ? Math.round(s.artifact_bytes / 1e6) : 0) + " MB", s: "PDF + fulltext in Neon S3" },
    { k: "Experiments", v: fmt(s.experiments), s: "catalogued campaigns" },
    { k: "Extracted findings", v: fmt(s.findings), s: "metric / value / unit" },
    { k: "Fire-safety insights", v: fmt(s.insights), s: "evidence-backed" },
  ];

  return (
    <div className="grid" style={{ gap: 18 }}>
      <div className="grid g4">
        {cards.map((c) => (
          <div className="card metric" key={c.k}>
            <div className="k">{c.k}</div>
            <div className="v">{c.v}</div>
            <div className="s">{c.s}</div>
          </div>
        ))}
      </div>

      <div className="grid g2">
        <div className="card">
          <h3>
            Publication timeline <small>documents per year in corpus</small>
          </h3>
          <div className="row" style={{ alignItems: "flex-end", gap: 3, height: 150 }}>
            {data.byYear.map((y) => (
              <div key={y.year} style={{ flex: "0 0 auto", textAlign: "center", width: 26 }}>
                <div
                  title={`${y.year}: ${y.n}`}
                  style={{
                    height: `${Math.max(4, (y.n / maxYear) * 118)}px`,
                    background: "linear-gradient(180deg,#ffb02e,#ff6a1f)",
                    borderRadius: "4px 4px 0 0",
                  }}
                />
                <div className="muted" style={{ fontSize: 9.5, marginTop: 4 }}>
                  {String(y.year).slice(2)}
                </div>
              </div>
            ))}
            {data.byYear.length === 0 && <div className="muted">no dated documents yet</div>}
          </div>
        </div>

        <div className="card">
          <h3>
            Document types <small>by classification</small>
          </h3>
          <table>
            <tbody>
              {data.byKind.map((k) => (
                <tr key={k.kind}>
                  <td>{k.kind.replace(/_/g, " ")}</td>
                  <td style={{ textAlign: "right", width: 70 }}>{fmt(k.n)}</td>
                </tr>
              ))}
              {data.byKind.length === 0 && (
                <tr><td className="muted">no documents ingested yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>
          Highest-quality documents <small>ranked by corpus usefulness score</small>
        </h3>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Title</th><th>Type</th><th>Year</th>
                <th style={{ textAlign: "right" }}>Words</th>
                <th style={{ textAlign: "right" }}>Chunks</th>
                <th style={{ textAlign: "right" }}>Quality</th>
              </tr>
            </thead>
            <tbody>
              {data.topDocs.map((d) => (
                <tr key={d.id}>
                  <td>
                    <a href={d.landing_url} target="_blank" rel="noreferrer">{d.title}</a>
                    <div className="muted" style={{ fontSize: 10.5 }}>NTRS {d.source_id}</div>
                  </td>
                  <td>{d.kind.replace(/_/g, " ")}</td>
                  <td>{d.published_date ? String(d.published_date).slice(0, 4) : "—"}</td>
                  <td style={{ textAlign: "right" }}>{fmt(d.word_count)}</td>
                  <td style={{ textAlign: "right" }}>{fmt(d.chunks)}</td>
                  <td style={{ textAlign: "right" }}>{d.quality_score?.toFixed(3) ?? "—"}</td>
                </tr>
              ))}
              {data.topDocs.length === 0 && (
                <tr><td className="muted">run <code>npm run pipeline:all</code> to populate the corpus</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid g2">
        <div className="card">
          <h3>
            Extracted quantitative findings <small>regex-extracted metrics</small>
          </h3>
          <div className="scroll">
            <table>
              <thead>
                <tr><th>Metric</th><th style={{ textAlign: "right" }}>n</th>
                <th style={{ textAlign: "right" }}>min</th><th style={{ textAlign: "right" }}>max</th><th>unit</th></tr>
              </thead>
              <tbody>
                {data.topMetrics.map((m) => (
                  <tr key={m.metric}>
                    <td>{m.metric}</td>
                    <td style={{ textAlign: "right" }}>{m.n}</td>
                    <td style={{ textAlign: "right" }}>{m.min_value ?? "—"}</td>
                    <td style={{ textAlign: "right" }}>{m.max_value ?? "—"}</td>
                    <td>{m.unit ?? "—"}</td>
                  </tr>
                ))}
                {data.topMetrics.length === 0 && (
                  <tr><td className="muted">no findings extracted yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <h3>
            Pipeline activity <small>collection → cleaning → indexing → analysis</small>
          </h3>
          <div className="scroll">
            <table>
              <thead>
                <tr><th>Stage</th><th>Status</th><th style={{ textAlign: "right" }}>In</th>
                <th style={{ textAlign: "right" }}>Out</th><th style={{ textAlign: "right" }}>MB</th></tr>
              </thead>
              <tbody>
                {data.pipeline.map((p, i) => (
                  <tr key={i}>
                    <td>{p.stage}</td>
                    <td>
                      <span className={`tag ${p.status === "done" ? "" : "sev-high"}`}>{p.status}</span>
                    </td>
                    <td style={{ textAlign: "right" }}>{fmt(p.items_in)}</td>
                    <td style={{ textAlign: "right" }}>{fmt(p.items_out)}</td>
                    <td style={{ textAlign: "right" }}>
                      {p.bytes_in ? (p.bytes_in / 1e6).toFixed(1) : "—"}
                    </td>
                  </tr>
                ))}
                {data.pipeline.length === 0 && (
                  <tr><td className="muted">no pipeline runs recorded yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
