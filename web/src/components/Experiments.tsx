import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

type Experiment = {
  id: number; code: string; name: string; campaign: string | null; status: string | null;
  gravity_level: string | null; fuel_type: string | null; ambient_gas: string | null;
  o2_fraction: number | null; pressure_kpa: number | null; objective: string | null;
  summary: string | null; aliases: string[] | null; facility: string | null;
  facility_name: string | null; platform: string | null; documents: number; findings: number;
};
type Facility = {
  id: number; code: string; name: string; platform: string | null; agency: string | null;
  g_level: string | null; description: string | null; experiments: number;
};

export default function Experiments({ focusRef }: { focusRef?: string }) {
  const { t } = useI18n();
  const [experiments, setExperiments] = useState<Experiment[]>([]);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [selected, setSelected] = useState<Experiment | null>(null);
  const [detail, setDetail] = useState<{
    documents: { id: number; source_id: string; title: string; kind: string; published_date: string | null; quality_score: number; landing_url: string }[];
    findings: { metric: string; value: number; value_max: number | null; unit: string; statement: string; evidence_quote: string }[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/experiments")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        setExperiments(d.experiments ?? []);
        setFacilities(d.facilities ?? []);
      })
      .catch((e) => setError(String(e)));
  }, []);

  async function pick(code: string) {
    const r = await fetch(`/api/experiments/${encodeURIComponent(code)}`);
    const d = await r.json();
    if (d.error) { setError(d.error); return; }
    setSelected(d.experiment);
    setDetail({ documents: d.documents ?? [], findings: d.findings ?? [] });
  }

  // Deep link from search: open the named campaign once the list has loaded.
  useEffect(() => {
    if (focusRef && experiments.some((e) => e.code === focusRef)) void pick(focusRef);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRef, experiments.length]);

  if (error) return <div className="card err">{error}</div>;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h3>
          Experiment Explorer{" "}
          <small>{t("NASA microgravity combustion campaigns catalogued in IGNIS")}</small>
        </h3>
        <div className="muted">
          Select a campaign to see its conditions, linked NASA documents and extracted findings.
        </div>
      </div>

      <div className="grid g4">
        {experiments.map((e) => (
          <div
            key={e.id}
            className="card"
            style={{
              cursor: "pointer",
              borderColor: selected?.code === e.code ? "rgba(255,106,31,.6)" : undefined,
            }}
            onClick={() => pick(e.code)}
          >
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
              <strong style={{ fontSize: 15 }}>{e.code}</strong>
              <span className="tag">{e.platform ?? "—"}</span>
            </div>
            <div className="muted" style={{ fontSize: 12, minHeight: 34 }}>{e.name}</div>
            <div className="row" style={{ marginTop: 10, gap: 6 }}>
              <span className="pill">{e.documents} docs</span>
              <span className="pill">{e.findings} findings</span>
            </div>
            <div className="muted" style={{ fontSize: 11, marginTop: 8 }}>
              {e.gravity_level ?? "—"} · {e.fuel_type ? e.fuel_type.split(";")[0] : "—"}
            </div>
          </div>
        ))}
        {experiments.length === 0 && (
          <div className="card muted">{t("No experiments loaded \u2014 check the database connection.")}</div>
        )}
      </div>

      {selected && detail && (
        <div className="grid g2">
          <div className="card">
            <h3>{selected.code} <small>{selected.name}</small></h3>
            <p className="muted" style={{ fontSize: 12.6, lineHeight: 1.6 }}>{selected.objective}</p>
            <p className="muted" style={{ fontSize: 12.6, lineHeight: 1.6 }}>{selected.summary}</p>
            <table>
              <tbody>
                <tr><th>{t("Facility")}</th><td>{selected.facility_name ?? "—"} ({selected.facility ?? "—"})</td></tr>
                <tr><th>{t("Platform")}</th><td>{selected.platform ?? "—"}</td></tr>
                <tr><th>{t("Gravity level")}</th><td>{selected.gravity_level ?? "—"}</td></tr>
                <tr><th>{t("Status")}</th><td>{selected.status ?? "—"}</td></tr>
                <tr><th>{t("Fuel")}</th><td>{selected.fuel_type ?? "—"}</td></tr>
                <tr><th>{t("Ambient gas")}</th><td>{selected.ambient_gas ?? "—"}</td></tr>
                <tr><th>{t("O\u2082 fraction")}</th><td>{selected.o2_fraction ?? "not specified in catalog"}</td></tr>
                <tr><th>{t("Pressure")}</th><td>{selected.pressure_kpa ? `${selected.pressure_kpa} kPa` : "not specified in catalog"}</td></tr>
                <tr><th>{t("Aliases")}</th><td>{selected.aliases?.join(", ") ?? "—"}</td></tr>
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>Linked documents ({detail.documents.length})</h3>
            <div className="scroll" style={{ maxHeight: 300 }}>
              {detail.documents.map((d) => (
                <div key={d.id} className="hit">
                  <div className="t">{d.title}</div>
                  <div className="meta">
                    NTRS {d.source_id} · {d.kind.replace(/_/g, " ")} ·{" "}
                    {d.published_date ? String(d.published_date).slice(0, 10) : "undated"} · quality{" "}
                    {d.quality_score?.toFixed(3)}
                  </div>
                  <a href={d.landing_url} target="_blank" rel="noreferrer" style={{ fontSize: 11.5 }}>
                    open on NTRS ↗
                  </a>
                </div>
              ))}
              {detail.documents.length === 0 && (
                <div className="muted">
                  No documents matched this campaign by alias. Ingest more NTRS material to improve coverage.
                </div>
              )}
            </div>

            <h3 style={{ marginTop: 16 }}>Extracted findings ({detail.findings.length})</h3>
            <div className="scroll" style={{ maxHeight: 300 }}>
              {detail.findings.map((f, i) => (
                <div key={i} className="hit">
                  <div className="t">{f.statement}</div>
                  <div className="quote">{f.evidence_quote}</div>
                </div>
              ))}
              {detail.findings.length === 0 && (
                <div className="muted">{t("No metric findings extracted for this campaign yet.")}</div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <h3>{t("Facilities & platforms ")}<small>where the science happens</small></h3>
        <table>
          <thead>
            <tr><th>{t("Code")}</th><th>{t("Name")}</th><th>{t("Platform")}</th><th>{t("Agency")}</th><th>g-level</th>
              <th style={{ textAlign: "right" }}>{t("Experiments")}</th></tr>
          </thead>
          <tbody>
            {facilities.map((f) => (
              <tr key={f.id}>
                <td><strong>{f.code}</strong></td>
                <td>{f.name}</td>
                <td>{f.platform ?? "—"}</td>
                <td>{f.agency ?? "—"}</td>
                <td>{f.g_level ?? "—"}</td>
                <td style={{ textAlign: "right" }}>{f.experiments}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
