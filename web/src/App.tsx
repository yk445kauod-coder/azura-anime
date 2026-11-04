import { lazy, Suspense, useEffect, useState } from "react";
import Overview from "@/components/Overview";
import GlobalSearch from "@/components/GlobalSearch";
import EarthBackdrop from "@/components/EarthBackdrop";
import { Icon } from "@/components/Icon";
import { useI18n, LocalePicker } from "@/lib/i18n";
import { fmtCompact, fmtInt } from "@/lib/format";

// Every non-default view is its own chunk. A phone opening Mission Control
// never pays for the agent console, the report builder or the comparison tool.
const Experiments = lazy(() => import("@/components/Experiments"));
const DataExplorer = lazy(() => import("@/components/DataExplorer"));
const Assistant = lazy(() => import("@/components/Assistant"));
const Explorer = lazy(() => import("@/components/Explorer"));
const Compare = lazy(() => import("@/components/Compare"));
const Insights = lazy(() => import("@/components/Insights"));
const Reports = lazy(() => import("@/components/Reports"));

function PanelFallback() {
  return (
    <div className="card muted" style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span className="spin" /> loading view…
    </div>
  );
}

export type Health = {
  status: string;
  backend?: string;
  server_time?: string;
  latency_ms?: number;
  stats?: Record<string, number | string>;
};

const TABS = [
  { id: "overview", label: "Mission Control", icon: "LayoutDashboard", hint: "platform overview and status", group: "Operations" },
  { id: "experiments", label: "Flame Lab", icon: "FlaskConical", hint: "NASA microgravity combustion experiments", group: "Operations" },
  { id: "reports", label: "Research Reports", icon: "FileText", hint: "generated, cited reports", group: "Operations" },
  { id: "data", label: "Data Explorer", icon: "Table2", hint: "measured values and analysis", group: "Science" },
  { id: "assistant", label: "IGNIS Intelligence", icon: "Sparkles", hint: "AI research agent", group: "Science" },
  { id: "explorer", label: "Publications", icon: "BookOpen", hint: "NTRS documents in the corpus", group: "Science" },
  { id: "compare", label: "Comparative Analysis", icon: "Scale", hint: "side-by-side experiment comparison", group: "Science" },
  { id: "insights", label: "Fire Safety Insights", icon: "ShieldAlert", hint: "evidence-backed safety findings", group: "Science" },
] as const;

type TabId = (typeof TABS)[number]["id"];

// Nav is grouped the way the mission-control mock is: flight operations first,
// then the science tooling. Order inside a group is deliberate.
const NAV_GROUPS = ["Operations", "Science"] as const;

function MissionClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!now) return <span className="missionclock">--:--:--</span>;
  const date = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = now.toLocaleTimeString("en-GB", { hour12: false });
  return (
    <span className="missionclock">
      <span>{date}</span>
      <b>{time} UTC</b>
    </span>
  );
}

export default function App() {
  const { t } = useI18n();
  const [tab, setTab] = useState<TabId>("overview");
  const [focusRef, setFocusRef] = useState<string | undefined>(undefined);
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ status: "error" }));
  }, []);

  const ok = health?.status === "ok";
  const s = health?.stats ?? {};
  const corpusMB = ((Number(s.corpus_chars) || 0) / 1_000_000).toFixed(1);

  const current = TABS.find((x) => x.id === tab)!;

  function navigate(next: TabId, ref?: string) {
    setFocusRef(ref);
    setTab(next);
  }

  return (
    <>
      <EarthBackdrop />
      <div className="shell">
        <aside className="side">
          <div className="side-brand">
            <div className="logo">
              <Icon name="Flame" size={21} />
            </div>
            <div>
              <h1>IGNIS</h1>
              <p>{t("Microgravity Combustion Lab")}</p>
            </div>
          </div>

          <nav className="sidenav">
            {NAV_GROUPS.map((group) => (
              <div key={group}>
                <div className="navgroup">{t(group)}</div>
                {TABS.filter((item) => item.group === group).map((item) => (
                  <button
                    key={item.id}
                    className={`navbtn ${tab === item.id ? "on" : ""}`}
                    onClick={() => navigate(item.id)}
                    title={t(item.hint)}
                  >
                    <span className="ico"><Icon name={item.icon} size={16} /></span>
                    {t(item.label)}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className="side-foot">
            <div className="row" style={{ gap: 6, marginBottom: 10 }}>
              <span className="pill">
                <span className={`dot ${ok ? "live" : "bad"}`} />
                {ok ? t("systems nominal") : health ? t("backend unreachable") : t("connecting…")}
              </span>
            </div>
            <div className="muted" style={{ fontSize: 11, lineHeight: 1.7 }}>
              {fmtInt(s.documents)} {t("documents")} · {fmtInt(s.chunks)} {t("passages")} ·{" "}
              {fmtInt(s.embeddings)} {t("vectors")} · {corpusMB} M {t("chars")}
            </div>
            <div className="challenge-card">
              <div className="row" style={{ gap: 9 }}>
                <span className="challenge-badge"><Icon name="Rocket" size={15} /></span>
                <div style={{ lineHeight: 1.35 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{t("NASA Space Apps")}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{t("Challenge 2026")}</div>
                </div>
              </div>
              <p>{t("Investigate. Understand. Innovate.")}</p>
            </div>
            <div className="nasa-credit">
              <img src="/assets/nasa-logo.svg" alt="NASA" />
              <span>
                {t("Source: NASA Technical Reports Server (NTRS)")}
                <br />
                {t("Retrieval: Postgres full-text + pgvector (RRF)")}
              </span>
            </div>
          </div>
        </aside>

        <div className="main">
          <header className="topbar">
            <div className="topbar-left">
              <div className="sysonline">
                <span className={`dot ${ok ? "live" : "bad"}`} />
                {ok ? t("System Online") : health ? t("backend unreachable") : t("connecting…")}
              </div>
              <h2>{t(current.label)}</h2>
              <div className="crumb">
                {t(current.hint)} · {t("agent: plan → retrieve → grade → expand → synthesize → verify")}
              </div>
            </div>
            <div className="topbar-actions">
              <div className="statusstrip">
                <div className="statustile">
                  <Icon name="Satellite" size={14} />
                  <div>
                    <div className="k">{t("Environment")}</div>
                    <div className="v">0.00 g</div>
                  </div>
                </div>
                <div className="statustile">
                  <Icon name="Database" size={14} />
                  <div>
                    <div className="k">{t("Data source")}</div>
                    <div className="v">NASA NTRS</div>
                  </div>
                </div>
                <div className="statustile">
                  <Icon name="Activity" size={14} />
                  <div>
                    <div className="k">{t("Corpus")}</div>
                    <div className="v">{fmtCompact(s.documents)} {t("docs")}</div>
                  </div>
                </div>
              </div>
              <MissionClock />
              <GlobalSearch onPick={({ tab: dest, ref }) => navigate(dest, ref)} />
              <LocalePicker />
            </div>
          </header>

          <div className="wrap">
            {tab === "overview" && <Overview health={health} onNavigate={(x) => navigate(x as TabId)} />}
            {tab !== "overview" && (
              <Suspense fallback={<PanelFallback />}>
                {tab === "assistant" && <Assistant />}
                {tab === "explorer" && <Explorer focusRef={focusRef} />}
                {tab === "experiments" && <Experiments focusRef={focusRef} />}
                {tab === "data" && <DataExplorer focusKey={focusRef} />}
                {tab === "compare" && <Compare />}
                {tab === "insights" && <Insights />}
                {tab === "reports" && <Reports />}
              </Suspense>
            )}

            <footer className="muted" style={{ marginTop: 34 }}>
              {t("IGNIS · corpus harvested from NASA Technical Reports Server (NTRS) · retrieval: Postgres full-text + pgvector hybrid (RRF) · every claim is traced to its source passage.")}
            </footer>
          </div>
        </div>
      </div>
    </>
  );
}
