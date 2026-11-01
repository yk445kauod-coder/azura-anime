"use client";

import { useEffect, useState } from "react";
import Overview from "@/components/Overview";
import Explorer from "@/components/Explorer";
import Experiments from "@/components/Experiments";
import Assistant from "@/components/Assistant";
import Compare from "@/components/Compare";
import Insights from "@/components/Insights";
import Reports from "@/components/Reports";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "assistant", label: "AI Research Assistant" },
  { id: "explorer", label: "Experiment Explorer" },
  { id: "compare", label: "Comparative Analysis" },
  { id: "insights", label: "Fire Safety Insights" },
  { id: "reports", label: "Research Reports" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function Home() {
  const [tab, setTab] = useState<TabId>("overview");
  const [health, setHealth] = useState<{
    status: string;
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

  return (
    <div className="wrap">
      <header className="top">
        <div className="brand">
          <div className="logo">🔥</div>
          <div>
            <h1>IGNIS</h1>
            <p>
              Microgravity combustion &amp; spacecraft fire safety — NASA NTRS corpus,
              hybrid retrieval and agentic RAG
            </p>
          </div>
        </div>
        <div className="row" style={{ flex: "0 0 auto", gap: 8 }}>
          <span className="pill">
            <span className={`dot ${ok ? "" : "bad"}`} />
            {ok ? "Neon Postgres connected" : health ? "database unreachable" : "connecting…"}
          </span>
          <span className="pill">docs {health?.stats?.documents ?? "—"}</span>
          <span className="pill">chunks {health?.stats?.chunks ?? "—"}</span>
          <span className="pill">vectors {health?.stats?.embeddings ?? "—"}</span>
          <span className="pill">{corpusMB} M chars</span>
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab ${tab === t.id ? "on" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "overview" && <Overview />}
      {tab === "assistant" && <Assistant />}
      {tab === "explorer" && <Explorer />}
      {tab === "compare" && <Compare />}
      {tab === "insights" && <Insights />}
      {tab === "reports" && <Reports />}

      <footer className="muted" style={{ marginTop: 34 }}>
        IGNIS · corpus harvested from NASA Technical Reports Server (NTRS) · retrieval:
        Postgres full-text + pgvector hybrid (RRF) · agent: plan → retrieve → grade →
        expand → synthesize → verify · every claim is traced to its source passage.
      </footer>
    </div>
  );
}
