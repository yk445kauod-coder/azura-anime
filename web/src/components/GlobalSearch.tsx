import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";

/**
 * Global search across the four entity types in the corpus: experiments,
 * datasets (measured variables), NTRS documents and extracted findings.
 * Selecting a result navigates to the owning tab rather than opening a detail
 * page here, so there is one canonical place to read each kind of record.
 */

type Results = {
  experiments: { code: string; name: string; campaign: string | null; objective: string | null }[];
  datasets: { key: string; name: string; canonical_unit: string | null; value_count: number }[];
  documents: { id: number; source_id: string; title: string; kind: string; landing_url: string }[];
  findings: { id: number; metric: string; value: number; unit: string | null; statement: string | null; document_id: number }[];
};

export default function GlobalSearch({
  onPick,
}: {
  onPick: (target: { tab: "explorer" | "experiments" | "data"; ref?: string }) => void;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Results | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setRes(null);
      return;
    }
    const t = setTimeout(() => {
      fetch(`/api/global-search?q=${encodeURIComponent(term)}`)
        .then((r) => r.json())
        .then((d) => {
          setRes(d);
          setOpen(true);
        })
        .catch(() => setRes(null));
    }, 260);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const total = res
    ? res.experiments.length + res.datasets.length + res.documents.length + res.findings.length
    : 0;

  function pick(fn: () => void) {
    fn();
    setOpen(false);
    setQ("");
  }

  return (
    <div className="gsbox" ref={box}>
      <input
        className="input"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => res && setOpen(true)}
        placeholder={t("Search experiments, datasets, publications, findings…")}
        aria-label="Global search"
      />
      {open && res && (
        <div className="gsdrop">
          {total === 0 && <div className="gsitem muted">No matches for “{q}”.</div>}

          {res.experiments.length > 0 && (
            <>
              <div className="gsgroup">{t("Experiments")}</div>
              {res.experiments.map((e) => (
                <button key={e.code} className="gsitem" onClick={() => pick(() => onPick({ tab: "experiments", ref: e.code }))}>
                  {e.code} — {e.name}
                  <span className="sub">{e.campaign ?? "campaign unknown"}</span>
                </button>
              ))}
            </>
          )}

          {res.datasets.length > 0 && (
            <>
              <div className="gsgroup">{t("Measured variables")}</div>
              {res.datasets.map((d) => (
                <button key={d.key} className="gsitem" onClick={() => pick(() => onPick({ tab: "data", ref: d.key }))}>
                  {d.name}
                  <span className="sub">{d.value_count} values · {d.canonical_unit ?? "no unit"}</span>
                </button>
              ))}
            </>
          )}

          {res.findings.length > 0 && (
            <>
              <div className="gsgroup">{t("Findings")}</div>
              {res.findings.slice(0, 6).map((f) => (
                <button key={f.id} className="gsitem" onClick={() => pick(() => onPick({ tab: "data", ref: f.metric.toLowerCase().replace(/ /g, "_") }))}>
                  {f.metric}: {f.value} {f.unit ?? ""}
                  <span className="sub">{(f.statement ?? "").slice(0, 90) || "extracted measurement"}</span>
                </button>
              ))}
            </>
          )}

          {res.documents.length > 0 && (
            <>
              <div className="gsgroup">{t("Publications")}</div>
              {res.documents.map((d) => (
                <button key={d.id} className="gsitem" onClick={() => pick(() => onPick({ tab: "explorer", ref: d.source_id }))}>
                  {d.title.slice(0, 96)}
                  <span className="sub">{d.kind.replace(/_/g, " ")} · NTRS {d.source_id}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
