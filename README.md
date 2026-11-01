# IGNIS 🔥

**Interactive, AI-powered research platform for the _Flame in Freefall_ challenge** — how fire
behaves in microgravity, and what that means for spacecraft fire safety.

IGNIS is not a chatbot. It is a data platform: it harvests NASA's microgravity-combustion
literature, structures it, indexes it, and then lets an agentic RAG system summarise, rank,
compare and interpret the evidence — with every claim traceable back to the source passage.

```
NASA NTRS ──► harvest ──► clean ──► chunk ──► embed ──► hybrid index
                                                            │
                                        ┌───────────────────┴───────────────────┐
                                        │            IGNIS agent                │
                                        │  plan → retrieve → grade → expand →   │
                                        │  synthesize → verify                  │
                                        └───────────────────┬───────────────────┘
                                                            │
                              Next.js dashboard ◄───────────┘
                              (5 features + evidence table)
```

---

## What the challenge asked for

| Requirement | How IGNIS delivers |
|---|---|
| Summarise combustion experiment results | `POST /api/ask` — grounded synthesis with a citation table |
| Rank experiments/results by relevance to a question | Hybrid retrieval (Postgres FTS + pgvector, RRF-fused) then a multi-signal *smart ranking* pass |
| Interpret results and important relationships | Agentic loop with query expansion + cross-experiment comparative analysis |
| Extract insights for fire risk / mission safety | `pipeline/analyze.py` → evidence-backed fire-safety insights |

---

## The six features

1. **Experiment Explorer** — browse the harvested corpus, filter by document type and by NASA
   campaign (BASS-II, SAFFIRE, SAME, …), and inspect any document's chunks, extracted metrics
   and experiment links.
2. **AI Research Assistant** — the agentic RAG endpoint. Decomposes your question, retrieves
   per sub-question, grades sufficiency, expands thin queries, synthesises, then verifies each
   claim against its cited chunk.
3. **Smart Ranking** — every passage is scored on fused retrieval rank, lexical re-rank,
   corpus quality and domain density; the reasoning is shown, not hidden.
4. **Comparative Analysis** — pick campaigns and get a side-by-side condition matrix
   (gravity level, fuel, atmosphere, pressure, O₂ fraction) plus a metric-by-metric table.
5. **Fire Safety Insights** — curated, severity-ranked insights for engineers, each backed by
   supporting document IDs.
6. **Evidence & Sources** — each claim shows its verbatim quote, section, support score and a
   direct NTRS link. Data-coverage gaps are surfaced rather than papered over.

---

## Architecture

| Layer | Technology |
|---|---|
| UI | Next.js 15 (App Router), React 19, TypeScript |
| API | Next.js route handlers (`src/app/api/*`) |
| Agent / RAG | Python (`pipeline/lib/agent.py`, `retrieve.py`, `synth.py`) |
| Database | Neon Postgres 18 + **pgvector** (HNSW) + `pg_trgm` |
| Embeddings | `BAAI/bge-small-en-v1.5` (384-d, local ONNX via `fastembed`) |
| Object storage | Neon S3-compatible storage (PDF + fulltext mirror) |
| LLM | Pluggable (OpenAI-compatible / OpenRouter / Ollama), with a deterministic extractive fallback |

### Schema (`ignis`, 22 tables)

```
raw_record ── artifact                    # harvest provenance
   └─► document ── document_text          # canonical, deduplicated corpus
          ├─► chunk ── chunk_embedding    # retrieval units + 384-d vectors
          ├─► finding                     # extracted metric / value / unit + quote
          └─► experiment_document ── experiment ── facility
agent_run ── agent_step                   # agent observability
   ├─► retrieval_hit                      # what was retrieved, per sub-question
   └─► citation                           # what was actually cited + verification
insight · pipeline_run · llm_cache · dedupe_map · conversation · message
```

### Retrieval

1. **Keyword** — `ts_rank_cd` over a generated `tsvector` on every chunk.
2. **Vector** — cosine similarity over HNSW-indexed 384-d embeddings.
3. **Fusion** — Reciprocal Rank Fusion (RRF) combines both candidate lists.
4. **Re-rank** — query-term coverage, head-of-chunk weighting, phrase bonus, section prior.
5. **Smart rank** — `0.40·fused + 0.34·rerank + 0.16·quality + 0.10·domain_density`.
6. **MMR diversification** — stops one document from filling the evidence pack.

### The agent loop

| Node | What it does | Persisted to |
|---|---|---|
| `plan` | LLM (or heuristic) decomposition into 2–4 searchable sub-questions | `agent_step` |
| `retrieve` | Hybrid search per sub-question | `retrieval_hit` |
| `grade` | `sufficient` / `partial` / `insufficient` verdict per sub-question | `agent_step` |
| `expand` | Domain-lexicon query rewriting for thin sub-questions | `agent_step` |
| `synthesize` | Cited answer (LLM, or deterministic extractive fallback) | `agent_run` |
| `verify` | Each claim's quote re-checked against its cited chunk | `citation` |

---

## Quick start

```bash
npm install
cp .env.example .env.local          # fill in DATABASE_URL + storage keys

npm run db:migrate                  # create the ignis schema
npm run pipeline:collect            # harvest NASA NTRS (default target 300 MB)
npm run pipeline:clean              # parse, normalise, dedupe, extract findings
npm run pipeline:index              # chunk + embed (local, no API key)
npm run pipeline:analyze            # generate fire-safety insights

npm run dev                         # http://localhost:3000
```

Already collected the corpus? Rebuild the derived layers only:

```bash
npm run pipeline:rebuild
```

### Enabling an LLM (optional)

IGNIS works with **no LLM at all** — it falls back to a deterministic extractive synthesizer
that quotes source sentences verbatim, so the evidence guarantee holds either way. To get
paraphrased narrative answers, set any one of:

```bash
OPENAI_API_KEY=...      # + optional OPENAI_BASE_URL, IGNIS_LLM_MODEL
OPENROUTER_API_KEY=...
OLLAMA_BASE_URL=http://localhost:11434
```

The provider is auto-detected and every response is cached in `ignis.llm_cache`, so re-runs
and demos are cheap and reproducible.

---

## API

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/health` | GET | DB connectivity + corpus stats |
| `/api/stats` | GET | dashboard aggregates (kinds, timeline, top docs, metrics, pipeline runs) |
| `/api/documents` | GET | search/filter documents (`q`, `kind`, `experiment`, `limit`, `offset`) |
| `/api/documents/:id` | GET | one document + chunks + findings + experiment links |
| `/api/experiments` | GET | campaigns and facilities |
| `/api/experiments/:code` | GET | one campaign + linked documents + findings |
| `/api/search` | GET | hybrid retrieval only (`q`, `k`) |
| `/api/ask` | POST | **agentic RAG** — `{ question, k?, use_llm? }` |
| `/api/compare` | POST | **comparative analysis** — `{ experiments: string[], topic? }` |
| `/api/insights` | GET | fire-safety insights + metric distributions + coverage |

```bash
curl -s localhost:3000/api/ask -H 'content-type: application/json' \
  -d '{"question":"How does flame spread over solid fuels differ in microgravity?"}' | jq
```

---

## Data provenance & limitations

* Source: **NASA Technical Reports Server (NTRS)** public API (`ntrs.nasa.gov`).
* ~350 MB of PDFs + NTRS fulltext, ~1 M words of cleaned text across ~200 documents.
* Documents are deduplicated by content hash; the NTRS fulltext is preferred over PDF text
  extraction because it is cleaner.
* Extracted numeric findings come from auditable regex rules (`pipeline/clean.py`), each
  carrying its verbatim evidence quote. They are **candidates for review**, not ground truth.
* Values belong to their source experiment's conditions. IGNIS warns against extrapolating
  across facilities with different gravity levels, pressures and O₂ fractions, and it reports
  per-campaign coverage so gaps are visible.

---

## Repository layout

```
pipeline/
  collect.py            harvest NTRS metadata + fulltext/PDF → Neon S3
  clean.py              parse, normalise, dedupe, extract findings, link experiments
  index_vectors.py      chunk + embed + index (pgvector)
  analyze.py            fire-safety insight generation
  ask.py                CLI bridge: JSON in → JSON out (agent / compare / search / insights)
  migrate.py            apply db/migrations in order
  lib/                  config, db, storage, http, text, chunking, embed, llm,
                        retrieve, synth, agent
db/migrations/          ignis schema + search functions + seeds
src/app/api/            REST endpoints
src/components/         the five dashboard views
```
