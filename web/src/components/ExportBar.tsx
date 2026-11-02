/**
 * Export controls for an answer or a report.
 *
 * The worker writes the file (it owns the Arabic font embedding and the chart
 * renderers), so this posts the markdown plus any chart specs and saves the
 * returned blob. Charts must travel with the request or the exported PDF would
 * show a blank space where the figure belongs.
 */

import { useState } from "react";
import type { ChartPayload } from "@/components/Chart";
import { useI18n } from "@/lib/i18n";

type Format = "pdf" | "docx" | "md";

const LABEL: Record<Format, string> = { pdf: "PDF", docx: "DOCX", md: "Markdown" };

export default function ExportBar({
  markdown,
  charts = [],
  title,
  filename,
}: {
  markdown: string;
  charts?: ChartPayload[];
  title: string;
  filename?: string;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function download(format: Format) {
    setBusy(format);
    setError(null);
    try {
      const res = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markdown,
          format,
          title,
          filename: filename ?? title,
          charts: charts.map((c) => c.spec),
        }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(detail?.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const name = `${(filename ?? title).replace(/[^\w\-. ]+/g, "").replace(/\s+/g, "-").slice(0, 70)}.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(String((err as Error)?.message ?? err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="exportbar">
      <span className="muted">{t("Export")}</span>
      {(["pdf", "docx", "md"] as Format[]).map((f) => (
        <button key={f} className="btn ghost sm" disabled={busy !== null} onClick={() => download(f)}>
          {busy === f ? "…" : LABEL[f]}
        </button>
      ))}
      {charts.length > 0 && <span className="muted">with {charts.length} chart{charts.length > 1 ? "s" : ""}</span>}
      {error && <span className="tag sev-high">{error}</span>}
    </div>
  );
}
