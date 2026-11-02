import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";

type CompareResult = {
  experiments: Record<string, unknown>[];
  dimensions: string[];
  findings: Record<string, { metric: string; value: number; value_max: number | null; unit: string; statement: string; document_title: string; source_id: string }[]>;
  metric_matrix: { metric: string; values: Record<string, { value: number; value_max: number | null; unit: string }[]> }[];
  note?: string;
};

const LABELS: Record<string, string> = {
  campaign: "Campaign", facility: "Facility", facility_name: "Facility name",
  platform: "Platform", status: "Status", gravity_level: "Gravity level",
  fuel_type: "Fuel", ambient_gas: "Ambient gas", pressure_kpa: "Pressure (kPa)",
  o2_fraction: "O₂ fraction", ignition_source: "Ignition source",
  document_count: "Linked documents",
};

export default function Compare() {
  const { t } = useI18n();
  const [available, setAvailable] = useState<{ code: string; name: string }[]>([]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [topic, setTopic] = useState("");
  const [result, setResult] = useState<CompareResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/experiments")
      .then((r) => r.json())
      .then((d) => {
        const exps = d.experiments ?? [];
        setAvailable(exps);
        setChosen(exps.slice(0, 3).map((e: { code: string }) => e.code));
      })
      .catch(() => {});
  }, []);

  async function run() {
    setLoading(true); setError(null);
    try {
      const r = await fetch("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ experiments: chosen, topic: topic || null }),
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

  function toggle(code: string) {
    setChosen((c) => (c.includes(code) ? c.filter((x) => x !== code) : [...c, code]));
  }

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <h3>{t("Comparative Analysis ")}<small>conditions and results side by side</small></h3>
        <div className="row" style={{ marginBottom: 11 }}>
          <input
            style={{ flex: "2 1 260px" }}
            placeholder={t("Optional metric filter — e.g. flame spread rate, extinction time")}
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          />
          <button className="primary" onClick={run} disabled={loading || chosen.length === 0}>
            {loading ? <><span className="spin" /> comparing…</> : `Compare ${chosen.length} experiment(s)`}
          </button>
        </div>
        <div className="row" style={{ gap: 7 }}>
          {available.map((e) => (
            <button
              key={e.code}
              className="ghost"
              style={{
                fontSize: 11.5,
                borderColor: chosen.includes(e.code) ? "rgba(255,106,31,.65)" : undefined,
                color: chosen.includes(e.code) ? "#fff" : undefined,
              }}
              onClick={() => toggle(e.code)}
            >
              {e.code}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="card err">{error}</div>}

      {result && (
        <>
          <div className="card">
            <h3>{t("Condition matrix")}</h3>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>{t("Dimension")}</th>
                    {result.experiments.map((e) => (
                      <th key={String(e.code)}>{String(e.code)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.dimensions.map((dim) => (
                    <tr key={dim}>
                      <td style={{ color: "var(--muted)" }}>{LABELS[dim] ?? dim}</td>
                      {result.experiments.map((e) => (
                        <td key={String(e.code) + dim}>
                          {e[dim] === null || e[dim] === undefined || e[dim] === ""
                            ? "—"
                            : String(e[dim])}
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr>
                    <td style={{ color: "var(--muted)" }}>{t("Objective")}</td>
                    {result.experiments.map((e) => (
                      <td key={String(e.code) + "obj"} style={{ fontSize: 11.6 }}>
                        {String(e.objective ?? "—")}
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="card">
            <h3>
              Metric comparison{" "}
              <small>extracted quantitative findings per experiment</small>
            </h3>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>{t("Metric")}</th>
                    {result.experiments.map((e) => <th key={String(e.code)}>{String(e.code)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {result.metric_matrix.map((row) => (
                    <tr key={row.metric}>
                      <td>{row.metric}</td>
                      {result.experiments.map((e) => {
                        const vals = row.values[String(e.id)] ?? [];
                        return (
                          <td key={String(e.code) + row.metric}>
                            {vals.length === 0
                              ? "—"
                              : vals.slice(0, 4).map((v, i) => (
                                  <div key={i}>
                                    {v.value}{v.value_max ? `–${v.value_max}` : ""} {v.unit}
                                  </div>
                                ))}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  {result.metric_matrix.length === 0 && (
                    <tr><td colSpan={result.experiments.length + 1} className="muted">
                      No comparable numeric metrics were extracted for these experiments.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid g2">
            {result.experiments.map((e) => (
              <div className="card" key={String(e.code)}>
                <h3>
                  {String(e.code)} <small>{String(e.name)}</small>
                </h3>
                <div className="muted" style={{ marginBottom: 9 }}>
                  {String(e.document_count)} linked documents · {result.findings[String(e.id)]?.length ?? 0} findings
                </div>
                <div className="scroll" style={{ maxHeight: 300 }}>
                  {(result.findings[String(e.id)] ?? []).map((f, i) => (
                    <div key={i} className="hit">
                      <div className="t">{f.statement}</div>
                      <div className="meta">source: {f.document_title} (NTRS {f.source_id})</div>
                    </div>
                  ))}
                  {(result.findings[String(e.id)] ?? []).length === 0 && (
                    <div className="muted">{t("No numeric findings extracted for this campaign.")}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
