# IGNIS database schema

Neon Postgres 18. Everything lives in the `ignis` schema, which is set as the search path
by migration `0003`, so queries can use bare table names.

Extensions: `vector` (pgvector, HNSW indexes), `pg_trgm` (fuzzy title matching),
`pgcrypto` (hashing).

Migrations are ordered files in `db/migrations/` and applied with `npm run db:migrate`:

| File | Purpose |
|---|---|
| `0001_ignis_core.sql` | Corpus, retrieval, agent and reporting tables |
| `0002_seed_reference.sql` | Facilities and campaign reference rows |
| `0003_ignis_search_path.sql` | Sets `search_path` to `ignis` |
| `0004_drop_orphan_tables.sql` | Removes superseded tables |
| `0005_agent_memory.sql` | Short- and long-term memory |
| `0006_datasets.sql` | `dataset` / `dataset_row` views over extracted findings |
| `0007_ui_translation.sql` | UI string cache keyed by source English text |

---

## Entity relationships

```
raw_record ──► artifact                      harvest provenance + object storage
                  │
                  ▼
              document ──► document_text     canonical, deduplicated corpus
                  │
                  ├──► chunk ──► chunk_embedding      retrieval units + 384-d vectors
                  │
                  ├──► finding                        extracted metric / value / unit
                  │
                  └──► experiment_document ──► experiment ──► facility

agent_run ──► agent_step                     agent observability
    ├──► retrieval_hit                       what was retrieved, per sub-question
    └──► citation                            what was cited + verification outcome

conversation ──► message ──► retrieval_hit
                    │
                    └──► short_term_memory

long_term_memory                             cross-session recall (embedded)
memory_signal                                recall feedback

insight · pipeline_run · llm_cache · dedupe_map · ui_translation
```

---

## Corpus tables

### `document`

The canonical unit of the corpus. One row per distinct NTRS record after deduplication.

| Column | Type | Notes |
|---|---|---|
| `id` | bigint PK | Internal id. Serialised to the API as a string |
| `source` | enum | `ntrs` and friends |
| `source_id` | text | The NTRS accession number, e.g. `20220005205`. **This is what the UI shows** |
| `kind` | enum | `other`, `presentation`, `workshop proceedings` |
| `title`, `abstract` | text | |
| `authors`, `author_affiliations`, `report_numbers` | text[] | |
| `doi` | text | Often null for older reports |
| `published_date` | date | Sparse before 1995 |
| `keywords`, `subject_categories` | text[] | |
| `landing_url` | text | `https://ntrs.nasa.gov/citations/<source_id>` |
| `word_count`, `page_count`, `char_count` | int | |
| `content_sha256` | text | Deduplication key |
| `quality_score` | real | Corpus-usefulness score, 0–1. Feeds smart ranking |
| `has_fulltext` | bool | NTRS fulltext preferred over PDF extraction |
| `search_tsv` | tsvector | Generated; backs keyword retrieval |

### `document_text`

Full text split out of `document` so the hot row stays small. Joined when full text is
needed, which is why list endpoints stay fast.

### `chunk`

The retrieval unit. A document is split into overlapping chunks at paragraph boundaries.

| Column | Type | Notes |
|---|---|---|
| `id` | bigint PK | |
| `document_id` | bigint FK | |
| `ordinal` | int | Position within the document |
| `kind` | enum | `abstract`, `body`, `figure_caption`, … |
| `section_path` | text | Heading trail, e.g. `Results > Flame spread` |
| `page_start`, `page_end` | int | |
| `content` | text | The passage itself |
| `token_count`, `char_count` | int | |
| `content_sha256` | text | |
| `search_tsv` | tsvector | Generated; keyword retrieval |

**Chunk order is citation order.** `[n]` markers in an agent answer resolve to the nth
entry of the run's evidence list, which is derived from this table. Do not reorder
`chunk` rows when rendering evidence.

### `chunk_embedding`

| Column | Type | Notes |
|---|---|---|
| `chunk_id` | bigint PK/FK | One embedding per chunk |
| `model` | text | `BAAI/bge-small-en-v1.5` |
| `dim` | int | 384 |
| `embedding` | vector(384) | HNSW index, cosine distance |

### `raw_record`, `artifact`, `dedupe_map`

Provenance. `artifact` records the S3 object for each PDF and fulltext mirror;
`dedupe_map` records which raw record collapsed into which document, so a merge can be
audited.

### `pipeline_run`

One row per pipeline stage execution: `stage`, `status`, `items_in`, `items_out`,
`bytes_in`, `error`, timings. Mission Control renders this directly, which is why the
"Pipeline activity" table shows repeated stages — each is a separate run.

---

## Analysis tables

### `experiment` and `facility`

Campaign reference data. `experiment` carries the test conditions:

| Column | Type | Notes |
|---|---|---|
| `code` | text | `SAFFIRE`, `BASS-II`, `SAME`, … Used as the API path key |
| `name`, `aliases` | | |
| `facility_id` | bigint FK | |
| `campaign`, `objective`, `summary`, `status` | | |
| `gravity_level` | text | e.g. `~1e-6 g` |
| `pressure_kpa`, `o2_fraction`, `flow_velocity` | real | **Frequently null** |
| `fuel_type`, `fuel_thickness`, `sample_geometry` | | |
| `ignition_source`, `ambient_gas` | | |
| `metadata` | jsonb | Free-form extras |

`experiment_document` links campaigns to documents many-to-many.

**A null condition is not a zero.** These columns are null for most campaigns because the
source report did not state the value. Rendering null as `0` produces a wrong comparison.

### `finding`

Extracted quantitative results — the `metric / value / unit` rows.

| Column | Type | Notes |
|---|---|---|
| `experiment_id`, `document_id`, `chunk_id` | bigint | Provenance chain |
| `statement` | text | The sentence the value came from |
| `metric` | text | Normalised key, e.g. `pressure`, `flame temperature` |
| `value`, `value_max` | double | `value_max` set for ranges |
| `unit` | text | Canonical unit |
| `conditions` | jsonb | Gravity, O₂, pressure at measurement |
| `direction` | text | `increase` / `decrease` where stated |
| `confidence` | real | Extractor confidence, 0–1 |
| `extraction_method` | text | Which regex rule fired |
| `evidence_quote` | text | **Verbatim source text** |

These are regex extractions, not ground truth. Every one carries its verbatim quote so a
reader can check it, and the UI should surface that quote rather than presenting the
number alone.

### `dataset` and `dataset_row` (views)

Aggregate views over `finding`, grouped by metric. `dataset` gives one row per metric with
value count, document count, min/max and the set of recorded units; `dataset_row` gives
the individual measurements for charting.

Recorded units vary by source (`kPa`, `PSI`, `atm`, `bar`, `torr`), so `recorded_unit_count`
above 1 means values were normalised into `canonical_unit`. Report the recorded units
alongside any figure — the normalisation is a convenience, not a claim.

### `insight`

Curated fire-safety findings. `slug`, `title`, `body`, `category`, `severity`,
`confidence`, `supporting_findings` (bigint[]), `supporting_documents` (bigint[]),
`generated_by`.

---

## Agent tables

### `agent_run` / `agent_step`

One `agent_run` per question. `agent_step` records each loop node — `plan`, `retrieve`,
`grade`, `expand`, `synthesize`, `verify`, `visualize` — with its thought and inputs. This
is what the "Reasoning trace" panel shows.

### `retrieval_hit`

Every passage considered during a run: `run_id`, `sub_question`, `chunk_id`, `rank`,
`vector_score`, `keyword_score`, `fused_score`, `rerank_score`, `relevance`,
`used_in_answer`.

The individual scores are kept separate rather than only the fused value, so a ranking can
be explained after the fact. `used_in_answer` distinguishes retrieved from actually cited.

### `citation`

`run_id`, `claim`, `chunk_id`, `document_id`, `quote`, `support_score`. A claim is written
here only after `verify` re-checked its quote against the cited chunk.

### `conversation` / `message`

Chat history. `message` carries `role`, `content`, `token_count`, `latency_ms`.

---

## Memory tables

### `short_term_memory`

Session-scoped, keyed by `conversation_id`. Cleared with the session.

### `long_term_memory`

Cross-session recall.

| Column | Type | Notes |
|---|---|---|
| `kind` | text | `finding`, `fact`, … |
| `content` | text | |
| `source_run_id`, `source_chunk_id` | | Provenance back to the run that produced it |
| `embedding` | vector(384) | HNSW; supports semantic recall |
| `importance` | real | 0–1 |
| `confidence` | real | |
| `hit_count`, `last_hit_at` | | Usage counters that surface over-recalled items |

`memory_signal` records recall feedback so importance can be adjusted.

---

## Supporting tables

| Table | Purpose |
|---|---|
| `llm_cache` | Prompt-hash keyed completion cache; makes re-runs and demos cheap |
| `ui_translation` | `locale`, `source_hash`, `source_en`, `translated`, `model`. Keyed by source English text |
| `pipeline_run` | Stage execution log |

### `ui_translation`

The dashboard ships a generated dictionary for all nine locales, so this table is the
runtime fallback and the source of truth for anything not in the bundle. `source_en` is the
lookup key — changing an English string orphans its translations, which is why
`scripts/gen-locales.py` treats the source strings as the unit of work.

---

## Querying the database

Use the **pooled** URL for application queries and the **direct** URL for migrations and
long jobs. Serverless functions open many short-lived connections, which the pooler
handles; migrations need a session that survives the whole file.

```bash
psql "$DATABASE_URL_POOLED" -c "SELECT count(*) FROM document;"
```

The worker reaches Postgres over HTTP (`neon.ts`), not a TCP socket, because Workers do
not expose TCP. The Python pipeline uses a normal connection.

---

## Data limitations worth knowing before writing a feature

- **Coverage is uneven.** `insight.coverage` reports campaigns named in the corpus with
  zero indexed documents. Some campaigns are known only by name.
- **Extracted values are candidates, not ground truth.** `finding.confidence` is the
  extractor's own confidence and some values are wrong — the range for `pressure` runs to
  827 atm because a figure caption was misread. Always show `evidence_quote`.
- **Conditions are often unreported.** Null `o2_fraction` and `pressure_kpa` are common;
  do not plot nulls as zero.
- **Units were normalised.** `recorded_units` holds what the source actually said.
- **Dates are sparse.** Most documents cluster in the 1990s and 2010s.
