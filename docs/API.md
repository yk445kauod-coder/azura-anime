# IGNIS API reference

Every response is JSON. All endpoints live behind one origin, so the browser never
talks to a second host and there is no CORS preflight in the dashboard.

```
Browser ──► /api/*  ──►  Cloudflare Pages Function  ──►  ignis-agent Worker  ──►  Neon Postgres
             same origin        (functions/api/)            (workers/ignis-agent)
```

The Pages Function forwards the request body and streams the response back untouched,
which is what lets `POST /api/ask` deliver server-sent events. Call the worker directly
only when you are scripting against it:

| Environment | Base URL |
|---|---|
| Dashboard (same origin) | `/api` |
| Worker direct | `https://ignis-agent.yk445kauod.workers.dev` |

Times are ISO-8601 UTC. Large integers (`bigint` columns) are serialised as **strings**
so JavaScript does not lose precision — cast with `Number()` when you need arithmetic.

---

## Conventions

**Errors** are `{"error": "<message>"}` with a non-2xx status. `400` is bad input, `404`
is a missing record, `500` is an upstream or database failure. The message is written for
a developer, not an end user, so the UI should show its own text and log this.

**Streaming** endpoints (`/ask`, `/report`) return `text/event-stream`. Frames are
separated by a blank line and each carries one `data: <json>` line:

```
data: {"event":"mode","data":{"mode":"fast","model":"gpt-5.6-sol"}}

data: {"event":"done","data":{ ...the full result... }}
```

Read them with `readSse()` from `web/src/lib/sse.ts` rather than parsing by hand.

---

## Health and corpus statistics

### `GET /api/health`

Cheap liveness probe. Use it for the header status dot.

```json
{
  "status": "ok",
  "backend": "live-worker",
  "server_time": "2026-11-02T20:17:43.679Z",
  "latency_ms": 22,
  "stats": { "documents": "206", "chunks": "5070", "embeddings": "5070" }
}
```

### `GET /api/stats`

Everything the Mission Control tab renders, in one round trip.

```json
{
  "stats": {
    "documents": "206", "documents_with_fulltext": "206",
    "chunks": "5070", "embeddings": "5070",
    "experiments": "8", "findings": "185", "insights": "8",
    "corpus_words": "1160751", "corpus_chars": "6844756", "artifact_bytes": "367000000"
  },
  "byKind":    [{ "kind": "other", "n": 187 }],
  "byYear":    [{ "year": 1995, "n": 1 }],
  "topDocs":   [{
    "id": "193", "source_id": "20220005205", "title": "Laminar Non-Premixed Flames…",
    "kind": "other", "word_count": 4851, "quality_score": 0.8809,
    "published_date": "2022-05-18T00:00:00.000Z",
    "landing_url": "https://ntrs.nasa.gov/citations/20220005205", "chunks": 22
  }],
  "topMetrics": [{ "metric": "pressure", "n": 100, "min_value": "0.000", "max_value": "827.000", "unit": "atm" }],
  "pipeline":   [{ "stage": "index", "status": "done", "items_in": 186, "items_out": 4448,
                   "bytes_in": "0", "started_at": "…", "finished_at": "…" }]
}
```

`byYear` is sparse — plot it against a full year range or the gaps will close up.
`topMetrics` `n` is the number of extracted values, not documents; a metric with `n: 2`
cannot support a claim on its own.

---

## Documents

### `GET /api/documents`

| Query | Type | Default | Notes |
|---|---|---|---|
| `q` | string | — | Full-text match over title and abstract |
| `kind` | string | — | `other`, `presentation`, `workshop proceedings` |
| `experiment` | string | — | Campaign code, e.g. `SAFFIRE` |
| `limit` | int | 20 | Capped at 100 |
| `offset` | int | 0 | For paging |

```json
{ "documents": [{ "id": "193", "source_id": "20220005205", "title": "…",
                  "kind": "other", "published_date": "…", "quality_score": 0.88,
                  "word_count": 4851, "landing_url": "…", "has_fulltext": true }],
  "total": 206, "limit": 20, "offset": 0 }
```

Always page against `total`, never against `documents.length`.

### `GET /api/documents/:id`

One document plus its retrieval units and extracted findings. `id` is the internal
bigint, not the NTRS `source_id`.

```json
{ "document": { "id": "193", "title": "…", "abstract": "…", "authors": ["…"],
                "keywords": ["…"], "landing_url": "…", "quality_score": 0.88 },
  "chunks":  [{ "id": 41, "ordinal": 0, "kind": "abstract", "section_path": "Abstract",
                "token_count": 210, "preview": "…", "embedded": true }],
  "findings": [{ "metric": "pressure", "value": 101.3, "unit": "kPa",
                 "evidence_quote": "…", "confidence": 0.62 }],
  "experiments": [{ "code": "BASS-II", "name": "…" }] }
```

`chunks[].preview` is truncated to 600 characters. Fetch the chunk itself when the UI
needs the full passage.

---

## Retrieval

### `GET /api/search?q=…&k=…`

Hybrid retrieval with no generation step — useful for debugging why an answer cited
what it did. `k` defaults to 12, capped at 50.

```json
{ "query": "limiting oxygen concentration",
  "hits": [{ "chunk_id": 39, "document_id": 29, "title": "…", "source_id": "19930015566",
             "ordinal": 10, "kind": "body", "section_path": "Document",
             "content": "…full passage text…" }] }
```

---

## Ask — the agentic RAG endpoint

### `POST /api/ask`

```json
{ "question": "How does flame spread over solid fuels differ in microgravity?",
  "k": 8, "stream": true, "mode": "fast", "model": "gpt-5.6-sol",
  "conversation_id": "3f2b…" }
```

| Field | Type | Default | Notes |
|---|---|---|---|
| `question` | string | — | **Required** |
| `k` | int | 8 | Passages per retrieval pass |
| `stream` | bool | false | `true` returns SSE, `false` returns one JSON body |
| `mode` | `"fast"` \| `"deep"` | `"fast"` | Fast allows 5 loop iterations and 150 s; deep allows 8 and 210 s |
| `model` | string | `gpt-5.6-sol` | See the model table below |
| `conversation_id` | uuid | — | Ties the run to durable memory. **Must be a valid UUID** |

`conversation_id` is validated as a UUID — a plain string like `"abc"` returns
`500 invalid input syntax for type uuid`. Generate one per browser and keep it in
`localStorage`.

**SSE event order**

| Event | Meaning |
|---|---|
| `mode` | Loop configuration chosen for this run |
| `memory` | Prior findings recalled (`n_recalled`, `contents`) |
| `act` | One tool call: `{iteration, thought, tool, input, n_evidence}` |
| `final` | The model chose `final_answer` |
| `verify` | `{verified_ratio, claims, stop_reason}` |
| `synthesize` | Model and claim count for the answer |
| `visualize` | A chart was built |
| `memory_write` | Findings persisted to long-term memory |
| `error` | `{error}` — the run failed; no `done` follows |
| `done` | The complete result object |
| `close` | Stream finished |

The final payload from `done`:

```json
{
  "run_id": "61d502c0-…", "question": "…",
  "answer": "markdown with [n] citation markers",
  "chart": null,
  "claims":  [{ "claim": "…", "quote": "…", "title": "…", "source_id": "19930015566",
                "section": "Document", "support_score": 0.71, "landing_url": "…",
                "verified": true }],
  "evidence": [{ "chunk_id": 39, "document_id": 29, "title": "…", "source_id": "…",
                 "kind": "body", "section_path": "…", "content": "…",
                 "final_score": 0.83, "vector_score": 0.79, "keyword_score": 0.61,
                 "rerank_score": 0.72, "quality_score": 0.88,
                 "landing_url": "…", "relevance": "high", "sub_question": null }],
  "sub_questions": ["…"], "confidence": 0.74, "grounded": true, "iterations": 4,
  "stop_reason": "final_answer", "provider": "ignis-agent", "model": "gpt-5.6-sol",
  "trace": [{ "node": "plan", "…": "…" }], "latency_ms": 41230
}
```

**`answer` is markdown.** Render it with the `Markdown` component, which handles
headings, lists, tables and citation runs. Do not drop it into a `<p>` or a
`white-space: pre-wrap` block — that flattens the structure the agent produced.

**Citation markers resolve positionally.** `[3]` in `answer` means the third entry of
`evidence`. Render `evidence` in the order given or the numbers will point at the
wrong passages.

`stop_reason` tells you how the run ended:

| Value | Meaning |
|---|---|
| `final_answer` | The model answered normally |
| `forced_synthesis` | The loop hit its iteration limit and a final call wrote the answer from the gathered evidence |
| `budget` / `deadline` | Out of iterations or wall-clock time |
| `parse_error` | The model never produced a usable response |
| `model_error` | The upstream provider failed |

Treat `forced_synthesis` as a normal answer. Treat the other three as degraded: show the
answer but say it is incomplete, because `answer` may be a short apology rather than
synthesis.

### Models

| UI label | id | Character |
|---|---|---|
| SI 1 | `gpt-5.6-sol` | Fast, balanced. The default. |
| SI MAX | `gpt-6.1-sol` | Stronger reasoning, slower |
| SI ULTRA | `gpt-6-astra` | Best availability |

These are reasoning models: they bill hidden reasoning against the output budget, so a
low cap returns empty content. The worker retries with a larger budget before falling
back.

### `POST /api/ask-sync`

Same input and result shape without streaming. Convenient in scripts; prefer the
streaming form in the UI so the user sees progress during a 40-second run.

---

## Comparative analysis

### `POST /api/compare`

```json
{ "experiments": ["SAFFIRE", "BASS-II", "SAME"],
  "topic": "flame spread rate" }
```

Returns a condition matrix across the named campaigns plus a metric-by-metric table. When
no code is recognised the response carries an error rather than an empty matrix, so check
for it before rendering.

---

## Experiments

### `GET /api/experiments`

```json
{ "experiments": [{ "id": "3", "code": "SAME", "name": "Smoke Aerosol Measurement Experiment",
                    "campaign": "SAME", "status": "flown", "gravity_level": "~1e-6 g",
                    "fuel_type": "spacecraft materials (wire insulation, silicone, Teflon)",
                    "ambient_gas": "Spacecraft cabin atmosphere",
                    "o2_fraction": null, "pressure_kpa": null, "objective": "…" }],
  "facilities": [{ "id": "7", "code": "ACE", "name": "Advanced Combustion via Microgravity Experiments",
                   "platform": "ISS", "agency": "NASA", "g_level": "~1e-6 g", "description": "…" }] }
```

Nullable condition fields are common — `o2_fraction` and `pressure_kpa` are `null` for
many campaigns. Render "not reported" rather than `0`, because zero is a meaningful value
for these quantities.

### `GET /api/experiments/:code`

One campaign with its linked documents and findings. Use the `code`, not the numeric id.

---

## Fire-safety insights

### `GET /api/insights`

```json
{ "insights": [{ "id": "3", "slug": "limiting-oxygen-concentration-for-spacecraft-fire-safety-3",
                 "title": "Limiting Oxygen Concentration For Spacecraft Fire Safety",
                 "body": "…", "category": "…", "severity": "high", "confidence": 0.8,
                 "supporting_documents": [12, 44], "generated_by": "…" }],
  "metrics":  [{ "metric": "pressure", "n": 100, "min_value": "0.000", "max_value": "827.000",
                 "avg_value": "58.756", "unit": "atm" }],
  "coverage": [{ "code": "CFI", "name": "Cool Flames Investigation",
                 "campaign": "CFI", "documents": 0 }] }
```

`coverage[].documents` of `0` is a real finding: the campaign is named in the corpus but
has no indexed documents. Show these gaps — they are part of the honesty of the platform.

---

## Reports

### `POST /api/report`

Builds a multi-question report. Streams progress as SSE and finishes with
`{"event":"done","data":{"report":{…},"markdown":"…"}}`. The markdown is also
downloadable through `/api/export` as PDF or DOCX.

---

## Memory

### `GET /api/memory?conversation_id=<uuid>&query=<text>`

Returns `recalled` (vector matches against the query), `recent` (long-term store),
`session` (this conversation) and `stats` (`long_term`, `short_term` counts).
`conversation_id` must be a UUID.

---

## Localisation

### `GET /api/locales`

```json
{ "locales": [{ "code": "en", "name": "English", "english": "English" },
              { "code": "ar", "name": "العربية", "english": "Arabic", "rtl": true }] }
```

`rtl: true` means the UI must set `dir="rtl"` on the document element. The dashboard
ships a generated dictionary for all nine locales, so this endpoint is for discovery
rather than for fetching strings at runtime.

---

## Charts

A chart arrives in `result.chart` as `{spec, svg, rows, note}`. `rows` are measurements
mined from report text, not a curated dataset, and `note` says so. Keep that note visible
next to any figure.
