import { useEffect, useMemo, useState } from "react";
import {
  Globe, Database, FlaskConical, ArrowRight, Activity, Flame, Send, Zap,
  TrendingUp, Thermometer, Gauge, Lightbulb, BarChart3, CircleDot, Sparkles,
  BookOpen, ShieldAlert, FileText,
} from "lucide-react";

import { useI18n } from "@/lib/i18n";
import { postSse } from "@/lib/sse";
import { fmtInt, fmtNum, n } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Health } from "@/App";

type Stats = {
  stats: Record<string, number | string>;
  byYear: { year: number | string; n: number | string }[];
  topMetrics: {
    metric: string; n: number | string; min_value: number | string | null;
    max_value: number | string | null; unit: string | null;
  }[];
};
type Insight = { id: number | string; title: string; body: string; severity: string; confidence: number | string | null };

type ChatMsg = { role: "user" | "ai"; text: string };

/* --------------------------------- helpers -------------------------------- */

function Sparkline({ points, className }: { points: number[]; className?: string }) {
  const max = Math.max(...points);
  const min = Math.min(...points);
  const range = max - min || 1;
  const path = useMemo(
    () =>
      points
        .map((p, i) => {
          const x = (i / (points.length - 1)) * 100;
          const y = 32 - ((p - min) / range) * 28 - 2;
          return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
        })
        .join(" "),
    [points, min, range],
  );
  const lastY = 32 - (((points[points.length - 1] ?? min) - min) / range) * 28 - 2;
  return (
    <svg viewBox="0 0 100 32" className={className} preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--ember)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--ember)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${path} L100,32 L0,32 Z`} fill="url(#sparkFill)" stroke="none" />
      <path d={path} fill="none" stroke="var(--ember)" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="100" cy={lastY} r="1.8" fill="var(--ember)" />
    </svg>
  );
}

function Donut({ percent }: { percent: number }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const filled = (percent / 100) * c;
  return (
    <svg viewBox="0 0 100 100" className="size-28 -rotate-90" aria-hidden>
      <circle cx="50" cy="50" r={r} fill="none" stroke="var(--secondary)" strokeWidth="10" />
      <circle
        cx="50" cy="50" r={r} fill="none" stroke="var(--ember)" strokeWidth="10"
        strokeLinecap="round" strokeDasharray={`${filled} ${c - filled}`}
      />
    </svg>
  );
}

function StatusCard({
  icon, label, value, badge, onClick,
}: {
  icon: React.ReactNode; label: string; value: string; badge?: string; onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      onClick={onClick}
      className={cn("mission-panel flex items-center gap-4 p-5", onClick && "text-start")}
    >
      <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-telemetry/10">{icon}</span>
      <div className="min-w-0">
        <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">{label}</p>
        <p className="font-display text-2xl font-bold leading-tight tabular-nums">{value}</p>
        {badge && (
          <p className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-success">
            {badge}
            <span className="size-1.5 rounded-full bg-success" />
          </p>
        )}
      </div>
    </Tag>
  );
}

function Telemetry({
  icon, label, value, delta, tone,
}: {
  icon: React.ReactNode; label: string; value: string; delta: string; tone: "up" | "flat";
}) {
  return (
    <div className="flex items-center gap-3 p-4">
      {icon}
      <div className="min-w-0 flex-1">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">{label}</p>
        <p className="font-mono text-lg font-semibold leading-tight tabular-nums">{value}</p>
      </div>
      <span
        className={cn(
          "font-mono text-[11px] font-semibold tabular-nums",
          tone === "up" ? "text-success" : "text-muted-foreground",
        )}
      >
        {delta}
      </span>
    </div>
  );
}

function PanelHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2.5">
      {icon}
      <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.3em]">{title}</h2>
    </div>
  );
}

/* -------------------------------- component ------------------------------- */

const QUICK_ACCESS = [
  { label: "NASA Data", icon: Database, view: "data" },
  { label: "AI Analysis", icon: Sparkles, view: "intel" },
  { label: "Experiments", icon: FlaskConical, view: "flame" },
  { label: "Insights", icon: BarChart3, view: "insights" },
] as const;

export default function MissionControl({
  health,
  onNavigate,
}: {
  health?: Health | null;
  onNavigate?: (view: string) => void;
}) {
  const { t } = useI18n();
  const [stats, setStats] = useState<Stats | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [chat, setChat] = useState<ChatMsg[]>([
    { role: "user", text: "What happens to flame shape in microgravity?" },
    {
      role: "ai",
      text: "In microgravity, buoyancy is absent, so flames form spherical shapes and combustion is diffusion-dominated. Ask me anything about the NASA corpus and I'll answer with citations.",
    },
  ]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/stats").then((r) => r.json()).then(setStats).catch(() => {});
    fetch("/api/insights").then((r) => r.json()).then((d) => setInsights(d.insights ?? [])).catch(() => {});
  }, []);

  const s = stats?.stats ?? {};
  const years = useMemo(
    () => [...(stats?.byYear ?? [])].sort((a, b) => (n(a.year) ?? 0) - (n(b.year) ?? 0)).slice(-12),
    [stats],
  );
  const spark = years.length > 1 ? years.map((y) => n(y.n) ?? 0) : [8, 14, 11, 19, 16, 24, 21, 28, 26, 33, 30, 38];

  // Real telemetry: pull measured quantities straight from the corpus.
  const metrics = stats?.topMetrics ?? [];
  const findMetric = (needle: string) =>
    metrics.find((m) => m.metric.toLowerCase().includes(needle));
  const temp = findMetric("temperature");
  const pressure = findMetric("pressure");
  const spread = findMetric("spread");

  const topInsight = insights[0];
  const coverage = Math.min(
    100,
    Math.round(((n(s.documents_with_fulltext) ?? 0) / Math.max(1, n(s.documents) ?? 1)) * 100),
  );

  async function send() {
    const text = draft.trim();
    if (!text || busy) return;
    setChat((c) => [...c, { role: "user", text }]);
    setDraft("");
    setBusy(true);
    let answer = "";
    try {
      await postSse("/api/ask", { question: text, deep: false }, (ev) => {
        if (ev.event === "token" && typeof ev.data?.text === "string") {
          answer += ev.data.text;
          setChat((c) => {
            const last = c[c.length - 1];
            return last?.role === "ai"
              ? [...c.slice(0, -1), { role: "ai", text: answer }]
              : [...c, { role: "ai", text: answer }];
          });
        } else if (ev.event === "final" && typeof ev.data?.answer === "string") {
          answer = ev.data.answer;
          setChat((c) => {
            const last = c[c.length - 1];
            return last?.role === "ai"
              ? [...c.slice(0, -1), { role: "ai", text: answer }]
              : [...c, { role: "ai", text: answer }];
          });
        }
      });
    } catch {
      setChat((c) => [
        ...c,
        { role: "ai", text: "The agent could not be reached. Open IGNIS Intelligence for the full console." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* status cards */}
      <section className="fade-in-up grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <StatusCard
          icon={<Globe className="size-6 text-telemetry" />}
          label={t("Environment")}
          value="0.00 g"
          badge={t("Microgravity")}
        />
        <StatusCard
          icon={<Database className="size-6 text-telemetry" />}
          label={t("Data Source")}
          value="NASA NTRS"
          badge={t("Official Data")}
        />
        <button
          onClick={() => onNavigate?.("flame")}
          className="mission-panel group flex items-center gap-4 p-5 text-start transition-colors hover:border-primary/40"
        >
          <FlaskConical className="size-8 shrink-0 text-ember" />
          <div className="min-w-0">
            <p className="font-mono text-[10px] uppercase tracking-[0.25em] text-muted-foreground">
              {t("Catalogued Campaigns")}
            </p>
            <p className="truncate font-display text-lg font-semibold">
              {fmtInt(s.experiments)} {t("experiments")}
            </p>
          </div>
          <ArrowRight className="ms-auto size-5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1 rtl:group-hover:-translate-x-1 group-hover:text-ember" />
        </button>
      </section>

      {/* visualization + assistant */}
      <section className="fade-in-up grid gap-4 xl:grid-cols-[1fr_360px]" style={{ animationDelay: "90ms" }}>
        <div className="mission-panel flex flex-col overflow-hidden">
          <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
            <Activity className="size-4 text-ember" />
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.3em]">
              {t("Combustion Visualization")}
            </h2>
            <span className="ms-auto flex items-center gap-2 rounded-full border border-success/30 bg-success/10 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-widest text-success">
              <span className="size-1.5 rounded-full bg-success live-dot" /> {t("Live Experiment")}
            </span>
          </div>

          <div className="grid flex-1 gap-4 p-4 md:grid-cols-[1fr_230px]">
            <div className="ember-ring relative min-h-[280px] overflow-hidden rounded-xl border border-primary/25 bg-black md:min-h-[360px]">
              <img
                src="/assets/nasa-flame-flex.jpg"
                alt={t("Spherical flame burning in microgravity — NASA SoFIE experiment")}
                className="absolute inset-0 h-full w-full object-cover"
                loading="lazy"
              />
              <div className="scanlines absolute inset-0" />
              <span className="absolute start-3 top-3 flex items-center gap-2 rounded-full bg-black/60 px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-widest text-destructive backdrop-blur">
                <span className="size-1.5 rounded-full bg-destructive live-dot" /> {t("Rec")}
              </span>
              <span className="absolute bottom-12 end-3 rounded bg-black/55 px-2 py-1 font-mono text-[9px] uppercase tracking-widest text-white/70 backdrop-blur">
                {t("NASA · Fire in Space")}
              </span>
              <div className="absolute inset-x-0 bottom-0 flex items-center gap-3 bg-gradient-to-t from-black/80 to-transparent px-4 py-3">
                <span className="grid size-8 place-items-center rounded-full bg-primary text-primary-foreground">
                  <Zap className="size-3.5" />
                </span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/15">
                  <div className="h-full w-[40%] rounded-full bg-primary" />
                </div>
                <span className="font-mono text-[10px] tabular-nums text-white/80">00:12 / 00:30</span>
              </div>
            </div>

            {/* telemetry — real measured values from the corpus */}
            <div className="flex flex-col divide-y divide-border rounded-lg border border-border bg-card/50">
              <Telemetry
                icon={<TrendingUp className="size-4 text-ember" />}
                label={t("Flame Spread Rate")}
                value={spread ? `${fmtNum(spread.max_value, 3)} ${spread.unit ?? "mm/s"}`.trim() : "—"}
                delta={`n=${fmtInt(spread?.n)}`}
                tone="up"
              />
              <Telemetry
                icon={<Thermometer className="size-4 text-telemetry" />}
                label={t("Flame Temperature")}
                value={temp ? `${fmtNum(temp.max_value, 1)} ${temp.unit ?? "K"}`.trim() : "—"}
                delta={`n=${fmtInt(temp?.n)}`}
                tone="up"
              />
              <Telemetry
                icon={<Gauge className="size-4 text-muted-foreground" />}
                label={t("Pressure")}
                value={pressure ? `${fmtInt(pressure.max_value)} ${pressure.unit ?? ""}`.trim() : "—"}
                delta={`n=${fmtInt(pressure?.n)}`}
                tone="flat"
              />
              <div className="p-4">
                <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">
                  {t("Documents per Year")}
                </p>
                <Sparkline points={spark} className="h-10 w-full" />
              </div>
            </div>
          </div>
        </div>

        {/* assistant — wired to the live agent */}
        <div className="mission-panel flex flex-col overflow-hidden">
          <div className="flex items-center gap-3 border-b border-border px-5 py-3.5">
            <Flame className="size-4 text-ember" />
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.3em]">
              {t("IGNIS Assistant")}
            </h2>
            <span className="ms-auto rounded-full border border-border px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              AI
            </span>
          </div>

          <div className="flex max-h-[380px] min-h-[300px] flex-1 flex-col gap-3 overflow-y-auto p-4">
            {chat.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="ms-8 rounded-xl rounded-se-sm bg-primary/90 px-4 py-2.5 text-sm text-primary-foreground">
                  {m.text}
                </div>
              ) : (
                <div key={i} className="me-4 whitespace-pre-wrap rounded-xl rounded-ss-sm bg-secondary px-4 py-2.5 text-sm leading-relaxed text-foreground/90">
                  {m.text}
                </div>
              ),
            )}
            {busy && (
              <div className="me-4 flex items-center gap-2 rounded-xl rounded-ss-sm bg-secondary px-4 py-2.5 text-sm text-muted-foreground">
                <span className="size-3 animate-spin rounded-full border-2 border-white/20 border-t-ember" />
                {t("thinking…")}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-border p-3">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && send()}
              placeholder={t("Ask anything about IGNIS…")}
              className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background/60 px-4 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/50"
            />
            <button
              onClick={send}
              disabled={busy}
              aria-label={t("Send message")}
              className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground transition-transform hover:scale-105 active:scale-95 disabled:opacity-50"
            >
              <Send className="size-4" />
            </button>
          </div>
        </div>
      </section>

      {/* bottom row */}
      <section className="fade-in-up grid gap-4 md:grid-cols-2 xl:grid-cols-3" style={{ animationDelay: "180ms" }}>
        <div className="mission-panel p-5">
          <PanelHeader icon={<Zap className="size-3.5 text-ember" />} title={t("Quick Access")} />
          <div className="mt-4 grid grid-cols-4 gap-2">
            {QUICK_ACCESS.map(({ label, icon: Icon, view }) => (
              <button
                key={label}
                onClick={() => onNavigate?.(view)}
                className="group flex flex-col items-center gap-2 rounded-lg border border-border bg-card/50 px-2 py-4 transition-colors hover:border-primary/40 hover:bg-primary/10"
              >
                <Icon className="size-5 text-ember transition-transform group-hover:scale-110" />
                <span className="text-center text-[10px] font-medium leading-tight text-muted-foreground group-hover:text-foreground">
                  {t(label)}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="mission-panel p-5">
          <PanelHeader icon={<Lightbulb className="size-3.5 text-ember" />} title={t("Key Insights")} />
          <div className="mt-4 flex gap-4">
            <img
              src="/assets/nasa-flame-flex.jpg"
              alt={t("Real NASA microgravity flame")}
              loading="lazy"
              className="size-20 shrink-0 rounded-lg border border-border object-cover"
            />
            <div className="min-w-0">
              <h3 className="font-display text-base font-semibold leading-snug">
                {topInsight?.title ?? t("Fire Safety Insights")}
              </h3>
              <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                {(topInsight?.body ?? t("Evidence-backed findings for spacecraft fire-safety engineering."))
                  .replace(/\[\d+\]/g, "")
                  .slice(0, 180)}
              </p>
              <button
                onClick={() => onNavigate?.("insights")}
                className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-ember transition-colors hover:text-primary"
              >
                {t("Read More")} <ArrowRight className="size-3.5" />
              </button>
            </div>
          </div>
        </div>

        <div className="mission-panel p-5 md:col-span-2 xl:col-span-1">
          <PanelHeader icon={<BarChart3 className="size-3.5 text-ember" />} title={t("Corpus Coverage")} />
          <div className="mt-2 flex items-center gap-6">
            <div className="relative grid place-items-center">
              <Donut percent={coverage} />
              <span className="absolute font-display text-xl font-bold tabular-nums">{coverage}%</span>
            </div>
            <div className="space-y-2.5 text-xs">
              <p className="flex items-center gap-2">
                <CircleDot className="size-3.5 text-ember" /> {fmtInt(s.documents)} {t("documents")}
              </p>
              <p className="flex items-center gap-2 text-muted-foreground">
                <CircleDot className="size-3.5 opacity-40" /> {fmtInt(s.chunks)} {t("passages")}
              </p>
              <p className="pt-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                {fmtInt(s.findings)} {t("findings")}
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
