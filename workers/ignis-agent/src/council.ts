/**
 * IGNIS Judgment Council.
 *
 * A flight-readiness-review panel over the NASA NTRS corpus. Five expert
 * personas each independently review the same evidence for a question, then a
 * panel chair reads all five assessments and issues a verdict.
 *
 * Design:
 *  - One shared retrieval pass (the same hybrid search the agent loop uses)
 *    feeds every member, so the panel cannot drift apart on facts. This also
 *    reuses the deadline-tight retrieval budget instead of spending five
 *    parallel loops.
 *  - Members run in PARALLEL (Promise.allSettled) because they share nothing
 *    but the evidence. A slow or failing member is isolated and the chair still
 *    hears from the ones that answered.
 *  - The chair call is separate and sequential: it needs all member outputs in
 *    context, so it cannot start until they land.
 */

import type { LoopHit } from "./agentic";

export type CouncilMemberId =
  | "physicist" | "engineer" | "materials" | "auditor" | "ops";

export type CouncilMember = {
  id: CouncilMemberId;
  title: string;
  role: string;
  area: string;
};

/** The five member personas. Purely descriptive — no logic here. */
export const COUNCIL_MEMBERS: CouncilMember[] = [
  {
    id: "physicist",
    title: "Combustion Physicist",
    area: "flame dynamics · microgravity transport",
    role: "Evaluate the physics: buoyancy effects, transport mechanisms, and whether the cited mechanisms are consistent with microgravity combustion literature.",
  },
  {
    id: "engineer",
    title: "Fire-Safety Engineer",
    area: "spacecraft fire risk · suppression",
    role: "Assess practical spacecraft fire-safety implications: ignition margins, flame-spread risk, suppression feasibility, and material screening pass/fail implications.",
  },
  {
    id: "materials",
    title: "Materials Scientist",
    area: "solid fuels · flammability",
    role: "Judge the materials claims: fuel properties, oxygen-index behaviour, pyrolysis, and whether the evidence distinguishes materials properly.",
  },
  {
    id: "auditor",
    title: "Data Auditor",
    area: "evidence quality · citation integrity",
    role: "Audit the evidence itself: passage relevance, unit sanity, internal consistency, and whether each quantitative claim is actually traceable to the cited passage.",
  },
  {
    id: "ops",
    title: "Mission Ops Officer",
    area: "experiment context · operations",
    role: "Check operational context: which experiments (SAFFIRE, BASS, SAME, SoFIE…) the evidence comes from, whether gravity levels and conditions are stated, and what a mission planner should take away.",
  },
];

export type CouncilVerdict = {
  /** PASSED / CONDITIONAL / FAILED — a readiness-style verdict. */
  verdict: "PASSED" | "CONDITIONAL" | "FAILED";
  decision: string;
  key_risks: string[];
  conditions: string[];
  confidence: number;
  votes: { total: number; concur: number; object: number; abstain: number };
};

export type CouncilRun = {
  question: string;
  evidence: LoopHit[];
  members: {
    member: CouncilMember;
    status: "concur" | "object" | "abstain" | "error";
    score: number;         // 0-1
    summary: string;
    concerns: string[];
    error?: string;
  }[];
  verdict: CouncilVerdict;
  model: string;
  latency_ms: number;
};

type Deps = {
  search: (query: string, k: number) => Promise<LoopHit[]>;
  chat: (
    messages: { role: "system" | "user" | "assistant"; content: string }[],
    opts: { maxTokens?: number; effort?: string; timeoutMs?: number },
  ) => Promise<string>;
  model: string;
  deadlineMs?: number;
  memberTimeoutMs?: number;
};

/** Compact numbered evidence block, shared verbatim by every member. */
function evidenceBlock(hits: LoopHit[]): string {
  if (!hits.length) return "(no evidence was retrieved)";
  return hits.map((h, i) =>
    `[${i + 1}] ${h.title} (NTRS ${h.source_id}; ${h.section_path ?? h.kind})\n${h.content.slice(0, 800).trim()}`,
  ).join("\n\n");
}

const MEMBER_SYSTEM = (
  member: CouncilMember,
) => `You are ${member.title} on the IGNIS Judgment Council, a NASA flight-readiness review panel over the microgravity-combustion corpus.

Your role: ${member.role}
Your specialty: ${member.area}

You are given a research question and the same numbered evidence passages every council member saw. Independently review that evidence as only ${member.title} can. Do NOT invent facts beyond the passages.

Reply with exactly one JSON object, no prose, no fences:
{"score": 0.0, "stance": "concur"|"object"|"abstain", "summary": "<2-4 sentence assessment>", "concerns": ["<each concern is one concrete issue>"]}

- score: your 0-1 confidence that the evidence SUPPORTS a sound, complete answer to the question.
- stance: "concur" if the evidence is sufficient and trustworthy, "object" if a critical flaw or gap makes an answer unsafe, "abstain" if the field is partly outside your purview or evidence is too thin.
- concerns: up to 3 specific, evidence-anchored worries. Empty array if none.`;

const CHAIR_SYSTEM = `You are the Chair of the IGNIS Judgment Council, a NASA flight-readiness review board. Five specialist members independently reviewed a research question against the same numbered evidence passages. Your job is to weigh their assessments and issue the panel verdict.

Reply with exactly one JSON object, no prose, no fences:
{"verdict": "PASSED"|"CONDITIONAL"|"FAILED", "decision": "<2-4 sentence decision that names specific evidence and member concerns>", "key_risks": ["<up to 3 concrete risks>"], "conditions": ["<conditions for PASSED vs CONDITIONAL; empty if PASSED>"], "confidence": 0.0, "votes": {"total": 5, "concur": 0, "object": 0, "abstain": 0}}`;

function stripFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
}

function extractJson(raw: string): any {
  const s = stripFences(raw);
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
}

const num = (v: any): number => (typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5);

async function callMember(
  member: CouncilMember,
  question: string,
  evidence: string,
  chat: Deps["chat"],
): Promise<CouncilRun["members"][number]> {
  try {
    const raw = await chat(
      [
        { role: "system", content: MEMBER_SYSTEM(member) },
        { role: "user", content: `Research question: ${question}\n\nEvidence:\n${evidence}\n\nDeliver your member assessment now.` },
      ],
      { maxTokens: 900, effort: "low", timeoutMs: 60000 },
    );
    const parsed = extractJson(raw);
    if (!parsed || typeof parsed !== "object") throw new Error("member returned no parseable JSON");
    const stance = parsed.stance === "concur" || parsed.stance === "object" || parsed.stance === "abstain"
      ? parsed.stance : "abstain";
    const concerns = Array.isArray(parsed.concerns)
      ? parsed.concerns.map((c: any) => String(c).trim()).filter(Boolean).slice(0, 3)
      : [];
    return {
      member,
      status: stance,
      score: num(parsed.score),
      summary: String(parsed.summary ?? "").trim().slice(0, 600) || "No summary provided.",
      concerns,
    };
  } catch (err: any) {
    return {
      member,
      status: "error",
      score: 0,
      summary: "",
      concerns: [],
      error: String(err?.message ?? err).slice(0, 200),
    };
  }
}

export async function runCouncil(question: string, deps: Deps): Promise<CouncilRun> {
  const started = Date.now();
  const deadlineMs = deps.deadlineMs ?? 170000;
  const hardDeadline = started + deadlineMs;
  const model = deps.model;

  // Single shared retrieval — the same hybrid search the agent loop uses.
  const hits = await deps.search(question, 6);
  const evidence = evidenceBlock(hits);

  if (!hits.length) {
    return {
      question, evidence: hits, members: [], model, latency_ms: Date.now() - started,
      verdict: {
        verdict: "FAILED", confidence: 0,
        decision: "The council could not retrieve any passages from the corpus for this question.",
        key_risks: ["No evidence available"], conditions: [], votes: { total: 0, concur: 0, object: 0, abstain: 0 },
      },
    };
  }

  // All five review in parallel; a slow member must not stall the panel.
  const members = await Promise.allSettled(
    COUNCIL_MEMBERS.map((m) => callMember(m, question, evidence, deps.chat)),
  ).then((rs) => rs.map((r) => (r.status === "fulfilled" ? r.value : {
    member: COUNCIL_MEMBERS[rs.indexOf(r)], status: "error" as const, score: 0, summary: "", concerns: [], error: "member crashed",
  })));

  // Chair reads every member's output and issues the verdict.
  const memberBlock = members.map((m, i) =>
    `MEMBER ${i + 1} — ${m.member.title} | stance: ${m.status} | score: ${m.score.toFixed(2)}\n` +
    (m.error ? `ERROR: ${m.error}` : `Summary: ${m.summary}\nConcerns: ${m.concerns.length ? m.concerns.map((c) => `- ${c}`).join("\n") : "- none"}`),
  ).join("\n\n");

  const voteCount = { total: members.length, concur: 0, object: 0, abstain: 0 };
  for (const m of members) {
    if (m.status === "concur") voteCount.concur++;
    if (m.status === "object") voteCount.object++;
    if (m.status === "abstain") voteCount.abstain++;
  }

  let verdict: CouncilVerdict = {
    verdict: "FAILED", confidence: 0,
    decision: "The chair could not deliberate (model failure).",
    key_risks: [], conditions: [], votes: voteCount,
  };
  try {
    const raw = await deps.chat(
      [
        { role: "system", content: CHAIR_SYSTEM },
        { role: "user", content:
          `Research question: ${question}\n\nEvidence the members reviewed:\n${evidence}\n\n` +
          `Member assessments:\n${memberBlock}\n\nIssue the panel verdict now.` },
      ],
      { maxTokens: 1100, effort: "low", timeoutMs: 90000 },
    );
    const p = extractJson(raw);
    if (p && typeof p === "object") {
      const v = String(p.verdict ?? "").toUpperCase();
      const okVerdict = v === "PASSED" || v === "CONDITIONAL" || v === "FAILED" ? v : "FAILED";
      const votes = p.votes && typeof p.votes === "object"
        ? {
            total: Number(p.votes.total) || members.length,
            concur: Number(p.votes.concur) || voteCount.concur,
            object: Number(p.votes.object) || voteCount.object,
            abstain: Number(p.votes.abstain) || voteCount.abstain,
          }
        : voteCount;
      verdict = {
        verdict: okVerdict,
        decision: String(p.decision ?? "").trim() || "The chair returned no decision.",
        key_risks: Array.isArray(p.key_risks) ? p.key_risks.map((c: any) => String(c)).filter(Boolean).slice(0, 3) : [],
        conditions: Array.isArray(p.conditions) ? p.conditions.map((c: any) => String(c)).filter(Boolean).slice(0, 4) : [],
        confidence: num(p.confidence),
        votes: votes,
      };
    }
  } catch (err: any) {
    verdict = {
      ...verdict,
      decision: `The chair's deliberation failed (${String(err?.message ?? err).slice(0, 160)}); the vote tally stands.`,
    };
  }

  return {
    question, evidence: hits, members, verdict, model, latency_ms: Date.now() - started,
  };
}
