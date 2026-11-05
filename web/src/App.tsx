import { lazy, Suspense, useEffect, useState } from "react";
import {
  Flame, Home, Database, BarChart3, Sparkles, FileText, Satellite,
  Rocket, Gauge, Scale,
} from "lucide-react";

import MissionControl from "@/components/MissionControl";
import GlobalSearch from "@/components/GlobalSearch";
import { LocalePicker, useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// Every non-default view is its own chunk, so a phone opening Mission Control
// never pays for the agent console or the report builder.
const Experiments = lazy(() => import("@/components/Experiments"));
const DataExplorer = lazy(() => import("@/components/DataExplorer"));
const Assistant = lazy(() => import("@/components/Assistant"));
const Explorer = lazy(() => import("@/components/Explorer"));
const Compare = lazy(() => import("@/components/Compare"));
const Insights = lazy(() => import("@/components/Insights"));
const Reports = lazy(() => import("@/components/Reports"));
const SmartRanking = lazy(() => import("@/components/SmartRanking"));
const Council = lazy(() => import("@/components/Council"));

export type Health = {
  status: string;
  backend?: string;
  server_time?: string;
  latency_ms?: number;
  stats?: Record<string, number | string>;
};

const NAV_OPERATIONS = [
  { id: "mission", label: "Mission Control", icon: Home },
  { id: "flame", label: "Flame Lab", icon: Flame },
  { id: "reports", label: "Research Reports", icon: FileText },
] as const;

const NAV_SCIENCE = [
  { id: "data", label: "Data Explorer", icon: BarChart3 },
  { id: "council", label: "Judgment Council", icon: Scale },
  { id: "intel", label: "IGNIS Intelligence", icon: Sparkles },
  { id: "rank", label: "Smart Ranking", icon: Gauge },
  { id: "publications", label: "Publications", icon: FileText },
  { id: "compare", label: "Comparative Analysis", icon: BarChart3 },
  { id: "insights", label: "Fire Safety Insights", icon: Database },
] as const;

type ViewId =
  | "mission" | "flame" | "reports" | "data" | "council" | "intel" | "rank"
  | "publications" | "compare" | "insights";

const VALID_VIEWS: readonly string[] = [
  "mission", "flame", "reports", "data", "council", "intel", "rank", "publications", "compare", "insights",
];

function MissionClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!now) {
    return <span className="font-mono text-xs tabular-nums text-muted-foreground">--:--:--</span>;
  }
  const date = now.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const time = now.toLocaleTimeString("en-GB", { hour12: false });
  return (
    <span className="flex items-baseline gap-2 font-mono text-xs tabular-nums text-muted-foreground">
      <span>{date}</span>
      <span className="text-foreground">{time} UTC</span>
    </span>
  );
}

function PanelFallback() {
  return (
    <div className="mission-panel flex items-center gap-3 p-5 text-sm text-muted-foreground">
      <span className="size-3.5 animate-spin rounded-full border-2 border-white/20 border-t-ember" />
      loading view…
    </div>
  );
}

export default function App() {
  const { t } = useI18n();
  const [view, setView] = useState<ViewId>(() => {
    const h = (typeof location !== "undefined" ? location.hash.replace(/^#\/?/, "") : "") as ViewId;
    return VALID_VIEWS.includes(h) ? h : "mission";
  });
  const [focusRef, setFocusRef] = useState<string | undefined>(undefined);
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ status: "error" }));
  }, []);

  // Keep the hash in sync so a view is linkable and the back button works.
  useEffect(() => {
    if (location.hash.replace(/^#\/?/, "") !== view) location.hash = `/${view}`;
  }, [view]);

  useEffect(() => {
    const onHash = () => {
      const h = location.hash.replace(/^#\/?/, "");
      if (VALID_VIEWS.includes(h)) setView(h as ViewId);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const online = health?.status === "ok";

  const navigate = (next: ViewId, ref?: string) => {
    setFocusRef(ref);
    setView(next);
  };

  const navGroup = (
    title: string,
    items: readonly { id: ViewId; label: string; icon: typeof Home }[],
  ) => (
    <div>
      <p className="px-4 pb-2 pt-4 font-mono text-[10px] font-medium uppercase tracking-[0.3em] text-muted-foreground/70">
        {t(title)}
      </p>
      <div className="space-y-1 px-3">
        {items.map(({ id, label, icon: Icon }) => {
          const isActive = view === id;
          return (
            <button
              key={id}
              onClick={() => navigate(id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-4 py-2.5 text-start text-sm font-medium transition-colors",
                isActive
                  ? "bg-primary/15 text-primary shadow-[inset_2px_0_0_0_var(--ember)] rtl:shadow-[inset_-2px_0_0_0_var(--ember)]"
                  : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
              )}
            >
              <Icon className={cn("size-4 shrink-0", isActive && "text-ember")} />
              <span className="truncate">{t(label)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <div className="relative min-h-screen overflow-hidden bg-background font-sans text-foreground">
      {/* space backdrop — NASA Blue Marble, slowly rotating */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="starfield absolute inset-0 opacity-70" />
        <div className="earth-atmo" style={{ opacity: 0.55 }} />
        <img
          src="/assets/earth-blue-marble.jpg"
          alt=""
          className="absolute -bottom-32 right-[-12%] h-[75vh] w-auto -rotate-12 object-contain opacity-[0.28] earth-spin"
          style={{
            maskImage: "radial-gradient(ellipse 70% 70% at 50% 50%, black 40%, transparent 72%)",
            WebkitMaskImage: "radial-gradient(ellipse 70% 70% at 50% 50%, black 40%, transparent 72%)",
          }}
        />
        <div className="earth-vignette absolute inset-0" />
        <div
          className="absolute -top-40 left-1/4 h-[60vh] w-[60vw] -translate-x-1/2 rounded-full opacity-25"
          style={{
            background:
              "radial-gradient(ellipse at center, color-mix(in oklab, var(--ember) 20%, transparent), transparent 65%)",
          }}
        />
        <div className="absolute inset-0 bg-gradient-to-r from-background via-background/90 to-background/30" />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-background/80" />
      </div>

      <div className="relative flex min-h-screen">
        {/* sidebar */}
        <aside className="hidden w-64 shrink-0 flex-col border-e border-border bg-background/70 backdrop-blur-xl lg:flex">
          <div className="flex items-center gap-3 px-5 py-6">
            <span className="ember-glow grid size-11 place-items-center rounded-xl bg-primary/15 text-ember">
              <Flame className="size-6" />
            </span>
            <div>
              <p className="font-display text-2xl font-bold tracking-[0.2em]">IGNIS</p>
              <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
                Microgravity Combustion
              </p>
            </div>
          </div>

          <nav className="flex-1 overflow-y-auto">
            {navGroup("Operations", NAV_OPERATIONS)}
            {navGroup("Science", NAV_SCIENCE)}
          </nav>

          <div className="m-3 rounded-xl border border-border bg-card/60 p-4">
            <div className="flex items-center gap-3">
              <span className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground">
                <Rocket className="size-4" />
              </span>
              <div className="text-xs leading-tight">
                <p className="font-semibold">NASA Space Apps</p>
                <p className="text-muted-foreground">Challenge 2026</p>
              </div>
            </div>
            <p className="mt-3 border-t border-border pt-3 font-display text-sm italic text-muted-foreground">
              Investigate. Understand. Innovate.
            </p>
          </div>
        </aside>

        {/* main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* topbar */}
          <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-background/50 px-4 py-3 backdrop-blur-xl md:px-6">
            <span
              className={cn(
                "flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-wider",
                online ? "text-success" : "text-destructive",
              )}
            >
              <span className={cn("size-2 rounded-full live-dot", online ? "bg-success" : "bg-destructive")} />
              {online ? t("System Online") : health ? t("Backend Offline") : t("Connecting")}
            </span>
            <div className="hidden items-center gap-x-5 text-sm text-muted-foreground lg:flex">
              <span>
                {t("Mission")}: <span className="font-medium text-foreground">{t("Combustion Research")}</span>
              </span>
              <span className="hidden items-center gap-2 xl:flex">
                <Satellite className="size-4 text-telemetry" /> {t("NASA NTRS — Live Corpus")}
              </span>
            </div>
            <div className="ms-auto flex items-center gap-2 md:gap-3">
              <img
                src="/assets/nasa-logo.svg"
                alt="NASA"
                className="hidden h-8 w-auto opacity-90 mix-blend-screen md:block"
                style={{ filter: "drop-shadow(0 0 6px rgba(255,106,31,.35))" }}
              />
              <GlobalSearch
                onPick={({ tab, ref }) =>
                  navigate((tab === "explorer" ? "publications" : tab) as ViewId, ref)
                }
              />
              <LocalePicker />
              <MissionClock />
            </div>
          </header>

          <main className="flex-1 space-y-4 p-4 md:p-6">
            {view === "mission" && <MissionControl health={health} onNavigate={(v) => navigate(v as ViewId)} />}
            {view !== "mission" && (
              <Suspense fallback={<PanelFallback />}>
                {view === "intel" && <Assistant />}
                {view === "council" && <Council />}
                {view === "publications" && <Explorer focusRef={focusRef} />}
                {view === "flame" && <Experiments focusRef={focusRef} />}
                {view === "data" && <DataExplorer focusKey={focusRef} />}
                {view === "compare" && <Compare />}
                {view === "insights" && <Insights />}
                {view === "reports" && <Reports />}
                {view === "rank" && <SmartRanking />}
              </Suspense>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
