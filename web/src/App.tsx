import { useEffect, useState } from "react";
import Overview from "@/components/Overview";
import Explorer from "@/components/Explorer";
import Experiments from "@/components/Experiments";
import Assistant from "@/components/Assistant";
import Compare from "@/components/Compare";
import Insights from "@/components/Insights";
import Reports from "@/components/Reports";
import DataExplorer from "@/components/DataExplorer";
import GlobalSearch from "@/components/GlobalSearch";
import { useI18n, LocalePicker } from "@/lib/i18n";

/**
 * Tab ids follow the spec's section names: Mission Control, Flame Lab,
 * Data Explorer, IGNIS Intelligence, Research Reports.
 */
const TABS = [
  { id: "overview", label: "Mission Control", ico: "◉", hint: "platform overview and status" },
  { id: "experiments", label: "Flame Lab", ico: "◆", hint: "NASA microgravity combustion experiments" },
  { id: "data", label: "Data Explorer", ico: "▤", hint: "measured values and analysis" },
  { id: "assistant", label: "IGNIS Intelligence", ico: "✦", hint: "AI research agent" },
  { id: "explorer", label: "Publications", ico: "▣", hint: "NTRS documents in the corpus" },
  { id: "compare", label: "Comparative Analysis", ico: "⇄", hint: "side-by-side experiment comparison" },
  { id: "insights", label: "Fire Safety Insights", ico: "⚠", hint: "evidence-backed safety findings" },
  { id: "reports", label: "Research Reports", ico: "▦", hint: "generated, cited reports" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function App() {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<TabId>("overview");
  const [focusRef, setFocusRef] = useState<string | undefined>(undefined);
  const [health, setHealth] = useState<{
    status: string;
    backend?: string;
    stats?: { documents?: number; chunks?: number; embeddings?: number; corpus_chars?: number };
  } | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ status: "error" }));
  }, []);

  const ok = health?.status === "ok";
  const corpusMB = health?.stats?.corpus_chars
    ? (health.stats.corpus_chars / 1_000_000).toFixed(1)
    : "—";

  const current = TABS.find((t) => t.id === tab)!;

  function navigate(next: TabId, ref?: string) {
    setFocusRef(ref);
    setTab(next);
  }

  return (
    <div className="shell">
      <aside className="side">
        <div className="side-brand">
          <div className="logo">🔥</div>
          <div>
            <h1>IGNIS</h1>
            <p>{t("Microgravity Combustion Lab")}</p>
          </div>
        </div>

        <nav className="sidenav">
          {TABS.map((tabItem) => (
            <button
              key={tabItem.id}
              className={`navbtn ${tab === tabItem.id ? "on" : ""}`}
              onClick={() => navigate(tabItem.id)}
              title={t(tabItem.hint)}
            >
              <span className="ico">{tabItem.ico}</span>
              {t(tabItem.label)}
            </button>
          ))}
        </nav>

        <div className="side-foot">
          <div className="row" style={{ gap: 6, marginBottom: 9 }}>
            <span className="pill">
              <span className={`dot ${ok ? "" : "bad"}`} />
              {ok ? t("systems nominal") : health ? t("backend unreachable") : t("connecting…")}
            </span>
          </div>
          <div className="muted" style={{ fontSize: 11, lineHeight: 1.7 }}>
            {t("Source: NASA Technical Reports Server (NTRS)")}
            <br />
            {health?.stats?.documents ?? "—"} {t("documents")} · {health?.stats?.chunks ?? "—"} {t("passages")} ·{" "}
            {health?.stats?.embeddings ?? "—"} {t("vectors")} · {corpusMB} M {t("chars")}
            <br />
            {t("Retrieval: Postgres full-text + pgvector (RRF)")}
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <h2>{t(current.label)}</h2>
            <div className="crumb">
              {t(current.hint)} · {t("agent: plan → retrieve → grade → expand → synthesize → verify")}
            </div>
          </div>
          <div className="topbar-actions">
            <GlobalSearch onPick={({ tab: dest, ref }) => navigate(dest, ref)} />
            <LocalePicker />
          </div>
        </header>

        <div className="wrap">
          {tab === "overview" && <Overview onNavigate={(t) => navigate(t as TabId)} />}
          {tab === "assistant" && <Assistant />}
          {tab === "explorer" && <Explorer focusRef={focusRef} />}
          {tab === "experiments" && <Experiments focusRef={focusRef} />}
          {tab === "data" && <DataExplorer focusKey={focusRef} />}
          {tab === "compare" && <Compare />}
          {tab === "insights" && <Insights />}
          {tab === "reports" && <Reports />}

          <footer className="muted" style={{ marginTop: 34 }}>
            {t("IGNIS · corpus harvested from NASA Technical Reports Server (NTRS) · retrieval: Postgres full-text + pgvector hybrid (RRF) · every claim is traced to its source passage.")}
          </footer>
        </div>
      </div>
    </div>
  );
}
