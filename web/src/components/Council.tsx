/**
 * NASA Judgment Council.
 *
 * A flight-readiness-review chamber: five specialist members independently
 * review the same corpus evidence for a question, then the chair issues a
 * verdict. The UI shows members "convening" → reporting in with a stance and
 * score → the panel verdict with vote tally.
 */

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { postSse } from "@/lib/sse";
import {
  Scale, Flame, ShieldAlert, Microscope, ClipboardCheck, Radar, Gavel,
  CheckCircle2, XCircle, MinusCircle, Loader2, UserRound, Send,
} from "lucide-react";

export type CouncilMember = {
  id: "physicist" | "engineer" | "materials" | "auditor" | "ops";
  title: string;
  area: string;
  role: string;
};

export type MemberReport = {
  index: number;
  member: CouncilMember;
  status: "concur" | "object" | "abstain" | "error";
  score: number;
  summary: string;
  concerns: string[];
  error?: string;
};

export type Verdict = {
  verdict: "PASSED" | "CONDITIONAL" | "FAILED";
  decision: string;
  key_risks: string[];
  conditions: string[];
  confidence: number;
  votes: { total: number; concur: number; object: number; abstain: number };
};

const MEMBER_ICON: Record<CouncilMember["id"], typeof Flame> = {
  physicist: Flame,
  engineer: ShieldAlert,
  materials: Microscope,
  auditor: ClipboardCheck,
  ops: Radar,
};

const EXAMPLES = [
  "Is the evidence sufficient to conclude that flame spread over solids is slower in microgravity without forced flow?",
  "Should NASA screening require limiting oxygen index testing for composite spacecraft materials?",
  "Are SAFFIRE results sufficient to validate large-scale fire growth models for crewed spacecraft?",
];

const STATUS_LABEL: Record<string, string> = {
  concur: "Concur",
  object: "Object",
  abstain: "Abstain",
  error: "Error",
};

const VERDICT_META: Record<Verdict["verdict"], { color: string; icon: typeof CheckCircle2 }> = {
  PASSED: { color: "var(--success, #34d399)", icon: CheckCircle2 },
  CONDITIONAL: { color: "var(--flame, #ff7a1a)", icon: Gavel },
  FAILED: { color: "var(--destructive, #ff5470)", icon: XCircle },
};

/** Stable per-browser id so council sessions persist under the conversation. */
function useCouncilId(): string {
  const ref = useRef<string>("");
  if (!ref.current) {
    let id = localStorage.getItem("ignis.council_conversation");
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem("ignis.council_conversation", id);
    }
    ref.current = id;
  }
  return ref.current;
}

export default function Council() {
  const { t } = useI18n();
  const conversationId = useCouncilId();
  const [question, setQuestion] = useState(EXAMPLES[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [members, setMembers] = useState<CouncilMember[]>([]);
  const [reports, setReports] = useState<Record<number, MemberReport>>({});
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [model, setModel] = useState<string>("gpt-5.6-sol");
  const [evidence, setEvidence] = useState<{ title: string; source_id: string; content: string; section_path?: string | null; landing_url?: string }[]>([]);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!loading) return;
    const s = Date.now();
    const t = setInterval(() => setElapsed((Date.now() - s) / 1000), 300);
    return () => clearInterval(t);
  }, [loading]);

  async function convene() {
    setLoading(true); setError(null); setMembers([]); setReports({}); setVerdict(null); setElapsed(0); setSubmitted(false); setEvidence([]);
    try {
      await postSse("/api/council", {
        question, stream: true, model, conversation_id: conversationId,
      }, (ev) => {
        const d = ev.data ?? {};
        switch (ev.event) {
          case "convene":
            setMembers(d.members ?? []);
            break;
          case "member": {
            const idx = Number(d.index ?? 0);
            const { index: _i, ...report } = d;
            setReports((r) => ({ ...r, [idx]: report as MemberReport }));
            break;
          }
          case "verdict":
            setVerdict(d.verdict ?? null);
            if (Array.isArray(d.evidence)) setEvidence(d.evidence);
            break;
          case "error":
            setError(d.error || "council error");
            break;
        }
      });
      setSubmitted(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  const done = !loading && !error && verdict !== null;
  const allReported = Object.keys(reports).length >= (members.length || 0);

  const V = verdict ? VERDICT_META[verdict.verdict] : VERDICT_META.FAILED;

  return (
    <div className="stack">
      <div className="mission-panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-3.5">
          <Scale className="size-4 text-ember" />
          <div>
            <h2 className="font-mono text-[11px] font-semibold uppercase tracking-[0.3em]">
              {t("NASA Judgment Council")}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t("A flight-readiness review panel over the NASA microgravity-combustion corpus")}
            </p>
          </div>
          <span className="ms-auto flex items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            <span className={loading ? "size-1.5 rounded-full bg-ember live-dot" : "size-1.5 rounded-full bg-success live-dot"} />
            {loading ? t("In session") : "5 " + t("members")}
          </span>
        </div>

        {/* question bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-4">
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && convene()}
            placeholder={t("Bring a question before the council…")}
            disabled={loading}
            className="h-10 min-w-0 flex-1 rounded-lg border border-input bg-background/60 px-4 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/50 disabled:opacity-60"
          />
          <button
            onClick={convene}
            disabled={loading || !question.trim()}
            className="flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-transform hover:scale-[1.02] active:scale-95 disabled:opacity-50"
          >
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Gavel className="size-4" />}
            {loading ? t("Deliberating…") : t("Convene Council")}
          </button>
        </div>

        {/* suggestions */}
        {!loading && !verdict && (
          <div className="flex flex-wrap gap-2 p-4 pt-3">
            {EXAMPLES.slice(0, 2).map((e, i) => (
              <button key={i} className="suggest" onClick={() => { setQuestion(e); convene(); }}>
                <Gavel className="size-3.5" />
                <span className="max-w-[60ch] truncate">{e}</span>
              </button>
            ))}
          </div>
        )}

        {error && (
          <div className="p-4">
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
              <strong>{t("Council error.")}</strong> {error}
              <div className="mt-3"><button className="ghost" onClick={convene}>{t("Try again")}</button></div>
            </div>
          </div>
        )}

        {/* chamber */}
        {members.length > 0 && (
          <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
            {members.map((m, i) => {
              const r = reports[i];
              const Icon = MEMBER_ICON[m.id] ?? UserRound;
              const status = r?.status;
              const StIcon = status === "concur" ? CheckCircle2 : status === "object" ? XCircle : status === "abstain" ? MinusCircle : Loader2;
              const stColor = status === "concur" ? "var(--success, #34d399)" : status === "object" ? "var(--destructive, #ff5470)" : status === "abstain" ? "var(--flame, #ff7a1a)" : "var(--muted, #94a3b8)";
              return (
                <div key={m.id} className={`rounded-xl border bg-card/50 p-4 transition-opacity ${status ? "border-border" : "border-dashed"}`}>
                  <div className="flex items-center gap-3">
                    <span className="ember-glow grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-ember">
                      <Icon className="size-5" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">{m.title}</p>
                      <p className="truncate font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">{m.area}</p>
                    </div>
                  </div>

                  {!r && (
                    <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3.5 animate-spin text-ember" />
                      <span>{t("reviewing evidence…")}</span>
                    </div>
                  )}

                  {r && status === "error" && (
                    <p className="mt-3 text-xs text-destructive">{r.error}</p>
                  )}

                  {r && status !== "error" && (
                    <>
                      <div className="mt-3 flex items-center gap-2">
                        <StIcon className="size-4" style={{ color: stColor }} />
                        <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: stColor }}>
                          {t(STATUS_LABEL[status ?? "abstain"])}
                        </span>
                        <span className="ms-auto font-mono text-lg font-bold tabular-nums text-foreground">
                          {Math.round((r.score ?? 0) * 100)}
                          <span className="text-xs text-muted-foreground">/100</span>
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-background/70">
                        <div className="h-full rounded-full" style={{ width: `${Math.round((r.score ?? 0) * 100)}%`, background: `color-mix(in oklab, ${stColor} 60%, transparent)` }} />
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{r.summary}</p>
                      {r.concerns.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {r.concerns.slice(0, 2).map((c, ci) => (
                            <li key={ci} className="flex gap-1.5 text-[11px] leading-snug text-muted-foreground/90">
                              <ShieldAlert className="size-3 shrink-0 text-destructive/70" style={{ marginTop: 2 }} />
                              <span>{c}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              );
            })}

            {/* chair seat */}
            <div className={`flex flex-col rounded-xl border p-4 ${verdict ? "border-ember/40 bg-ember/[0.06]" : "border-dashed"}`}>
              <div className="flex items-center gap-3">
                <span className={`ember-glow grid size-10 shrink-0 place-items-center rounded-lg ${verdict ? "bg-ember/15 text-ember" : "bg-primary/10 text-primary"}`}>
                  <Gavel className="size-5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-foreground">{t("Panel Chair")}</p>
                  <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground">{t("deliberation")}</p>
                </div>
              </div>

              <div className="mt-3 flex-1">
                {!verdict && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin text-ember" />
                    <span>
                      {allReported
                        ? t("All members reported — weighing assessments…")
                        : t("Waiting on member assessments…")}
                    </span>
                  </div>
                )}
                {verdict && (
                  <>
                    <div className="flex items-center gap-3">
                      <V.icon className="size-8" style={{ color: V.color }} />
                      <div>
                        <p className="font-display text-2xl font-bold tracking-tight" style={{ color: V.color }}>
                          {verdict.verdict}
                        </p>
                        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                          {t("council verdict")} · {Math.round(verdict.confidence * 100)}%
                        </p>
                      </div>
                    </div>

                    {/* vote tally */}
                    <div className="mt-3 flex gap-2">
                      <span className="rounded-full bg-success/10 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-success">
                        {t("concur")} {verdict.votes.concur}
                      </span>
                      <span className="rounded-full bg-destructive/10 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-destructive">
                        {t("object")} {verdict.votes.object}
                      </span>
                      <span className="rounded-full bg-ember/10 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-ember">
                        {t("abstain")} {verdict.votes.abstain}
                      </span>
                    </div>

                    <p className="mt-3 text-xs leading-relaxed text-foreground/90">{verdict.decision}</p>

                    {verdict.key_risks.length > 0 && (
                      <div className="mt-3">
                        <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">{t("Key risks")}</p>
                        <ul className="mt-1 space-y-1">
                          {verdict.key_risks.map((r, i) => (
                            <li key={i} className="flex gap-1.5 text-[11px] text-muted-foreground">
                              <XCircle className="size-3 shrink-0 text-destructive/70" style={{ marginTop: 2 }} /> <span>{r}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {verdict.conditions.length > 0 && (
                      <div className="mt-3">
                        <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-muted-foreground">{t("Conditions")}</p>
                        <ul className="mt-1 space-y-1">
                          {verdict.conditions.map((c, i) => (
                            <li key={i} className="flex gap-1.5 text-[11px] text-muted-foreground">
                              <CheckCircle2 className="size-3 shrink-0 text-ember" style={{ marginTop: 2 }} /> <span>{c}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                )}
              </div>

              {loading && (
                <p className="mt-3 border-t border-border/60 pt-2 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {elapsed.toFixed(1)}s · {Object.keys(reports).length}/{members.length} {t("reported")}
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {done && (
        <div className="mission-panel p-5">
          <div className="flex items-center gap-3">
            <ClipboardCheck className="size-4 text-ember" />
            <h3 className="font-mono text-[11px] font-semibold uppercase tracking-[0.3em]">{t("Evidence the council reviewed")}</h3>
            <span className="ms-auto font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {model} · {elapsed.toFixed(1)}s
            </span>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{t("The five members reviewed the same hybrid-retrieval passages. Open a source to audit the panel.")}</p>
          <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {evidence.map((h, i) => (
              <a
                key={i}
                href={h.landing_url}
                target="_blank"
                rel="noreferrer"
                className="group block rounded-lg border border-border bg-card/50 p-3 transition-colors hover:border-primary/40 hover:bg-primary/5"
              >
                <p className="line-clamp-2 text-xs font-semibold text-foreground group-hover:text-primary">{h.title}</p>
                <p className="mt-1 font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
                  NTRS {h.source_id}{h.section_path ? ` · ${h.section_path}` : ""}
                </p>
                <p className="mt-1.5 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">{h.content}</p>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}