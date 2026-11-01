-- ============================================================================
-- IGNIS — microgravity combustion & spacecraft fire-safety research platform
-- Schema migration 0001: core corpus + retrieval + agentic RAG + analysis
-- Target: PostgreSQL 18 (Neon) with pgvector, pg_trgm, unaccent
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS ignis;
SET search_path TO ignis, public;

-- ============================================================================
-- ENUMS
-- ============================================================================
DO $$ BEGIN
  CREATE TYPE source_system AS ENUM ('NTRS', 'NASA_TECHREPORTS', 'PSI', 'MANUAL', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE ingestion_status AS ENUM ('discovered', 'downloaded', 'parsed', 'cleaned', 'failed', 'skipped');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE document_kind AS ENUM (
    'experiment_report', 'conference_paper', 'journal_article', 'technical_memo',
    'dataset', 'presentation', 'workshop_proceedings', 'final_report', 'other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE chunk_kind AS ENUM ('abstract', 'body', 'results', 'conclusion', 'figure_caption', 'table', 'reference', 'metadata');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE agent_role AS ENUM ('system', 'user', 'assistant', 'tool');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================================
-- 1. PROVENANCE / HARVEST LAYER
-- ============================================================================

-- Every API/source record we ever saw, before any normalization.
CREATE TABLE IF NOT EXISTS raw_record (
  id              bigserial PRIMARY KEY,
  source          source_system NOT NULL,
  source_id       text NOT NULL,                    -- NTRS citation id
  endpoint        text,
  query           text,                             -- search query that surfaced it
  payload         jsonb NOT NULL,                   -- verbatim API response object
  payload_sha256  text NOT NULL,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS raw_record_payload_gin ON raw_record USING gin (payload jsonb_path_ops);
CREATE INDEX IF NOT EXISTS raw_record_query_idx ON raw_record (query);

-- Downloaded binary/text artifacts (PDF, TXT, CSV) mirrored in S3 + local cache.
CREATE TABLE IF NOT EXISTS artifact (
  id              bigserial PRIMARY KEY,
  raw_record_id   bigint REFERENCES raw_record(id) ON DELETE CASCADE,
  document_id     bigint,                           -- set after document upsert
  kind            text NOT NULL,                    -- pdf | fulltext_txt | csv | image | other
  url             text NOT NULL,
  s3_bucket       text,
  s3_key          text,
  local_path      text,
  bytes           bigint,
  sha256          text,
  mimetype        text,
  status          ingestion_status NOT NULL DEFAULT 'discovered',
  error           text,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (url)
);
CREATE INDEX IF NOT EXISTS artifact_status_idx ON artifact (status);
CREATE INDEX IF NOT EXISTS artifact_sha_idx ON artifact (sha256);

-- ============================================================================
-- 2. CANONICAL RESEARCH OBJECTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS document (
  id              bigserial PRIMARY KEY,
  source          source_system NOT NULL,
  source_id       text NOT NULL,
  kind            document_kind NOT NULL DEFAULT 'other',
  title           text NOT NULL,
  abstract        text,
  authors         text[],
  author_affiliations text[],
  report_numbers  text[],
  doi             text,
  published_date  date,
  submitted_date  timestamptz,
  modified_date   timestamptz,
  center          text,                              -- NASA center
  distribution    text,                              -- PUBLIC / restricted
  language        text DEFAULT 'en',
  keywords        text[],
  subject_categories text[],
  landing_url     text,
  -- derived analytics
  word_count      integer,
  page_count      integer,
  char_count      integer,
  content_sha256  text,                              -- normalized text hash (near-dup key)
  quality_score   real,                              -- 0..1 corpus usefulness
  has_fulltext    boolean NOT NULL DEFAULT false,
  -- search
  search_tsv      tsvector,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS document_tsv_idx ON document USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS document_title_trgm ON document USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS document_abstract_trgm ON document USING gin (abstract gin_trgm_ops);
CREATE INDEX IF NOT EXISTS document_keywords_gin ON document USING gin (keywords);
CREATE INDEX IF NOT EXISTS document_kind_idx ON document (kind);
CREATE INDEX IF NOT EXISTS document_content_sha_idx ON document (content_sha256);
CREATE INDEX IF NOT EXISTS document_quality_idx ON document (quality_score DESC NULLS LAST);

-- Normalized, cleaned body text (one row per document version).
CREATE TABLE IF NOT EXISTS document_text (
  document_id     bigint PRIMARY KEY REFERENCES document(id) ON DELETE CASCADE,
  content         text NOT NULL,
  content_sha256  text NOT NULL,
  word_count      integer NOT NULL,
  char_count      integer NOT NULL,
  cleaned_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 3. EXPERIMENT DOMAIN MODEL (structured science facts)
-- ============================================================================

CREATE TABLE IF NOT EXISTS facility (
  id              bigserial PRIMARY KEY,
  code            text NOT NULL UNIQUE,              -- e.g. ISS, BASS-II, SAFFIRE, SAME, FLEX-2
  name            text NOT NULL,
  platform        text,                              -- ISS | sounding_rocket | drop_tower | parabolic_flight | ground
  agency          text,
  description     text,
  g_level         text,                              -- microgravity class, e.g. '10^-5 g'
  metadata        jsonb DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS experiment (
  id              bigserial PRIMARY KEY,
  code            text NOT NULL UNIQUE,              -- canonical short code, e.g. 'BASS-II'
  name            text NOT NULL,
  aliases         text[] DEFAULT '{}',
  facility_id     bigint REFERENCES facility(id) ON DELETE SET NULL,
  campaign        text,                              -- e.g. 'BASS', 'SAFFIRE', 'SAME'
  objective       text,
  summary         text,
  status          text,                              -- flown | planned | ground | completed
  start_date      date,
  end_date        date,
  -- experimental conditions
  gravity_level   text,
  pressure_kpa    real,
  o2_fraction     real,
  flow_velocity   real,
  flow_velocity_unit text DEFAULT 'cm/s',
  fuel_type       text,
  fuel_thickness  real,
  sample_geometry text,
  ignition_source text,
  ambient_gas     text,
  metadata        jsonb DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS experiment_campaign_idx ON experiment (campaign);
CREATE INDEX IF NOT EXISTS experiment_code_trgm ON experiment USING gin (code gin_trgm_ops);
CREATE INDEX IF NOT EXISTS experiment_aliases_gin ON experiment USING gin (aliases);

-- Measurable findings extracted from a document about an experiment.
CREATE TABLE IF NOT EXISTS finding (
  id              bigserial PRIMARY KEY,
  experiment_id   bigint REFERENCES experiment(id) ON DELETE CASCADE,
  document_id     bigint REFERENCES document(id) ON DELETE CASCADE,
  chunk_id        bigint,                            -- evidence anchor (FK added later)
  statement       text NOT NULL,                     -- one-sentence claim
  metric          text,                              -- e.g. 'flame spread rate', 'LOI', 'extinction time'
  value           double precision,
  value_max       double precision,
  unit            text,
  conditions      jsonb DEFAULT '{}'::jsonb,
  direction       text,                              -- increase | decrease | no_change | threshold
  confidence      real,                              -- 0..1 extraction confidence
  extraction_method text DEFAULT 'llm',              -- llm | regex | manual
  evidence_quote  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finding_experiment_idx ON finding (experiment_id);
CREATE INDEX IF NOT EXISTS finding_document_idx ON finding (document_id);
CREATE INDEX IF NOT EXISTS finding_metric_idx ON finding (metric);

CREATE TABLE IF NOT EXISTS experiment_document (
  experiment_id   bigint NOT NULL REFERENCES experiment(id) ON DELETE CASCADE,
  document_id     bigint NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  relation        text DEFAULT 'describes',          -- describes | mentions | results | background
  confidence      real,
  PRIMARY KEY (experiment_id, document_id)
);

-- Curated fire-safety insights surfaced to the dashboard.
CREATE TABLE IF NOT EXISTS insight (
  id              bigserial PRIMARY KEY,
  slug            text UNIQUE,
  title           text NOT NULL,
  body            text NOT NULL,
  category        text,                              -- material_flammability | suppression | detection | atm_composition | ops_risk
  severity        text,                              -- info | low | medium | high | critical
  confidence      real,
  supporting_findings bigint[] DEFAULT '{}',
  supporting_documents bigint[] DEFAULT '{}',
  generated_by    text DEFAULT 'ignis-analyst',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS insight_category_idx ON insight (category, severity);

-- ============================================================================
-- 4. RAG RETRIEVAL LAYER
-- ============================================================================

CREATE TABLE IF NOT EXISTS chunk (
  id              bigserial PRIMARY KEY,
  document_id     bigint NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  ordinal         integer NOT NULL,                  -- position within document
  kind            chunk_kind NOT NULL DEFAULT 'body',
  section_path    text,                              -- e.g. 'Results > Flame Spread'
  page_start      integer,
  page_end        integer,
  content         text NOT NULL,
  token_count     integer NOT NULL,
  char_count      integer NOT NULL,
  content_sha256  text NOT NULL,
  search_tsv      tsvector,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, ordinal)
);
CREATE INDEX IF NOT EXISTS chunk_document_idx ON chunk (document_id);
CREATE INDEX IF NOT EXISTS chunk_tsv_idx ON chunk USING gin (search_tsv);
CREATE INDEX IF NOT EXISTS chunk_content_trgm ON chunk USING gin (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS chunk_sha_idx ON chunk (content_sha256);

-- Embeddings kept in a separate table so the model/dimension can be swapped
-- and re-embedded without rewriting chunk rows.
CREATE TABLE IF NOT EXISTS chunk_embedding (
  chunk_id        bigint NOT NULL REFERENCES chunk(id) ON DELETE CASCADE,
  model           text NOT NULL,                     -- e.g. 'BAAI/bge-small-en-v1.5'
  dim             integer NOT NULL,
  embedding       vector(384) NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, model)
);
CREATE INDEX IF NOT EXISTS chunk_embedding_hnsw
  ON chunk_embedding USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

ALTER TABLE finding
  DROP CONSTRAINT IF EXISTS finding_chunk_id_fkey;
ALTER TABLE finding
  ADD CONSTRAINT finding_chunk_id_fkey FOREIGN KEY (chunk_id) REFERENCES chunk(id) ON DELETE SET NULL;

-- ============================================================================
-- 5. AGENTIC RAG LAYER
-- ============================================================================

CREATE TABLE IF NOT EXISTS conversation (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         text,                              -- Neon Managed Better Auth subject
  title           text,
  mode            text NOT NULL DEFAULT 'agentic',   -- agentic | quick
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS message (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  role            agent_role NOT NULL,
  content         text,
  tool_name       text,
  tool_args       jsonb,
  tool_result     jsonb,
  token_count     integer,
  latency_ms      integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS message_conversation_idx ON message (conversation_id, id);

-- One run of the agentic pipeline per user question.
CREATE TABLE IF NOT EXISTS agent_run (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid REFERENCES conversation(id) ON DELETE SET NULL,
  question        text NOT NULL,
  plan            jsonb,                             -- decomposed sub-questions
  iterations      integer DEFAULT 0,
  status          text NOT NULL DEFAULT 'running',   -- running | done | failed
  answer          text,
  answer_confidence real,
  total_tokens    integer,
  latency_ms      integer,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX IF NOT EXISTS agent_run_conversation_idx ON agent_run (conversation_id);

-- Each reasoning/tool step, for transparency + eval.
CREATE TABLE IF NOT EXISTS agent_step (
  id              bigserial PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  step_index      integer NOT NULL,
  node            text NOT NULL,                     -- plan | retrieve | grade | expand | synthesize | verify
  thought         text,
  tool            text,
  tool_input      jsonb,
  tool_output     jsonb,
  tokens          integer,
  latency_ms      integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, step_index)
);

-- Retrieved evidence for an answer, with ranking + grading signals.
CREATE TABLE IF NOT EXISTS retrieval_hit (
  id              bigserial PRIMARY KEY,
  run_id          uuid REFERENCES agent_run(id) ON DELETE CASCADE,
  message_id      bigint REFERENCES message(id) ON DELETE CASCADE,
  sub_question    text,
  chunk_id        bigint NOT NULL REFERENCES chunk(id) ON DELETE CASCADE,
  rank            integer NOT NULL,
  vector_score    real,
  keyword_score   real,
  fused_score     real,                              -- RRF / weighted fusion
  rerank_score    real,                              -- cross-encoder or LLM grade
  relevance       text,                              -- relevant | partial | irrelevant
  used_in_answer  boolean DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS retrieval_hit_run_idx ON retrieval_hit (run_id, rank);
CREATE INDEX IF NOT EXISTS retrieval_hit_chunk_idx ON retrieval_hit (chunk_id);

-- Grounded claim -> citation map (evidence & sources feature).
CREATE TABLE IF NOT EXISTS citation (
  id              bigserial PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  claim           text NOT NULL,
  chunk_id        bigint REFERENCES chunk(id) ON DELETE SET NULL,
  document_id     bigint REFERENCES document(id) ON DELETE SET NULL,
  quote           text,
  support_score   real,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS citation_run_idx ON citation (run_id);

-- ============================================================================
-- 6. OPERATIONAL / OBSERVABILITY
-- ============================================================================

CREATE TABLE IF NOT EXISTS pipeline_run (
  id              bigserial PRIMARY KEY,
  stage           text NOT NULL,                     -- collect | clean | index | analyze
  params          jsonb DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'running',
  items_in        integer DEFAULT 0,
  items_out       integer DEFAULT 0,
  bytes_in        bigint DEFAULT 0,
  error           text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

-- Dedupe log: maps duplicate documents onto their canonical representative.
CREATE TABLE IF NOT EXISTS dedupe_map (
  duplicate_document_id bigint PRIMARY KEY REFERENCES document(id) ON DELETE CASCADE,
  canonical_document_id bigint NOT NULL REFERENCES document(id) ON DELETE CASCADE,
  reason          text NOT NULL,                     -- sha256 | title_similarity | source_id
  similarity      real,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Cached LLM responses (agent runs stay cheap + reproducible).
CREATE TABLE IF NOT EXISTS llm_cache (
  cache_key       text PRIMARY KEY,                  -- sha256(model + prompt)
  model           text NOT NULL,
  response        jsonb NOT NULL,
  tokens          integer,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- 7. FULL-TEXT SEARCH TRIGGERS
-- ============================================================================

CREATE OR REPLACE FUNCTION ignis.update_document_tsv() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv :=
      setweight(to_tsvector('english', coalesce(NEW.title, '')), 'A')
    || setweight(to_tsvector('english', coalesce(array_to_string(NEW.keywords, ' '), '')), 'B')
    || setweight(to_tsvector('english', coalesce(NEW.abstract, '')), 'C');
  NEW.updated_at := now();
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS document_tsv_trg ON document;
CREATE TRIGGER document_tsv_trg BEFORE INSERT OR UPDATE ON document
  FOR EACH ROW EXECUTE FUNCTION ignis.update_document_tsv();

CREATE OR REPLACE FUNCTION ignis.update_chunk_tsv() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv := to_tsvector('english', coalesce(NEW.content, ''));
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chunk_tsv_trg ON chunk;
CREATE TRIGGER chunk_tsv_trg BEFORE INSERT OR UPDATE ON chunk
  FOR EACH ROW EXECUTE FUNCTION ignis.update_chunk_tsv();

-- ============================================================================
-- 8. RETRIEVAL VIEWS + HYBRID SEARCH FUNCTIONS
-- ============================================================================

CREATE OR REPLACE VIEW document_stats AS
SELECT
  (SELECT count(*) FROM document)                                  AS documents,
  (SELECT count(*) FROM document WHERE has_fulltext)               AS documents_with_fulltext,
  (SELECT count(*) FROM chunk)                                     AS chunks,
  (SELECT count(*) FROM chunk_embedding)                           AS embeddings,
  (SELECT count(*) FROM experiment)                                AS experiments,
  (SELECT count(*) FROM finding)                                   AS findings,
  (SELECT count(*) FROM insight)                                   AS insights,
  (SELECT coalesce(sum(word_count), 0) FROM document_text)          AS corpus_words,
  (SELECT coalesce(sum(char_count), 0) FROM document_text)          AS corpus_chars,
  (SELECT coalesce(sum(bytes), 0) FROM artifact)                    AS artifact_bytes;

-- Full-text (keyword) search over chunks with document context.
CREATE OR REPLACE FUNCTION ignis.search_chunks_keyword(
  q text, k integer DEFAULT 20
) RETURNS TABLE (
  chunk_id bigint, document_id bigint, title text, source_id text,
  ordinal integer, kind chunk_kind, section_path text,
  content text, score real
) AS $$
  SELECT c.id, c.document_id, d.title, d.source_id, c.ordinal, c.kind, c.section_path, c.content,
         ts_rank_cd(c.search_tsv, websearch_to_tsquery('english', q))::real AS score
  FROM chunk c JOIN document d ON d.id = c.document_id
  WHERE c.search_tsv @@ websearch_to_tsquery('english', q)
  ORDER BY score DESC
  LIMIT k;
$$ LANGUAGE sql STABLE;

-- Dense (vector) search over chunk embeddings.
CREATE OR REPLACE FUNCTION ignis.search_chunks_vector(
  qvec vector(384), k integer DEFAULT 20, model_name text DEFAULT 'BAAI/bge-small-en-v1.5'
) RETURNS TABLE (
  chunk_id bigint, document_id bigint, title text, source_id text,
  ordinal integer, kind chunk_kind, section_path text,
  content text, score real
) AS $$
  SELECT c.id, c.document_id, d.title, d.source_id, c.ordinal, c.kind, c.section_path, c.content,
         (1 - (e.embedding <=> qvec))::real AS score
  FROM chunk_embedding e
  JOIN chunk c ON c.id = e.chunk_id
  JOIN document d ON d.id = c.document_id
  WHERE e.model = model_name
  ORDER BY e.embedding <=> qvec
  LIMIT k;
$$ LANGUAGE sql STABLE;

-- Reciprocal Rank Fusion of keyword + vector results (hybrid retrieval).
CREATE OR REPLACE FUNCTION ignis.search_chunks_hybrid(
  q text, qvec vector(384), k integer DEFAULT 12, pool integer DEFAULT 60,
  model_name text DEFAULT 'BAAI/bge-small-en-v1.5', rrf_k integer DEFAULT 60
) RETURNS TABLE (
  chunk_id bigint, document_id bigint, title text, source_id text,
  ordinal integer, kind chunk_kind, section_path text,
  content text, vector_score real, keyword_score real, fused_score real
) AS $$
  WITH kw AS (
    SELECT * FROM ignis.search_chunks_keyword(q, pool)
  ), vec AS (
    SELECT * FROM ignis.search_chunks_vector(qvec, pool, model_name)
  ), fused AS (
    SELECT
      coalesce(kw.chunk_id, vec.chunk_id) AS chunk_id,
      coalesce(kw.document_id, vec.document_id) AS document_id,
      coalesce(kw.title, vec.title) AS title,
      coalesce(kw.source_id, vec.source_id) AS source_id,
      coalesce(kw.ordinal, vec.ordinal) AS ordinal,
      coalesce(kw.kind, vec.kind) AS kind,
      coalesce(kw.section_path, vec.section_path) AS section_path,
      coalesce(kw.content, vec.content) AS content,
      coalesce(vec.score, 0)::real AS vector_score,
      coalesce(kw.score, 0)::real AS keyword_score,
      ( coalesce(1.0 / (rrf_k + kw_rank), 0) + coalesce(1.0 / (rrf_k + vec_rank), 0) )::real AS fused_score
    FROM (SELECT *, row_number() OVER (ORDER BY score DESC) AS kw_rank FROM kw) kw
    FULL OUTER JOIN (SELECT *, row_number() OVER (ORDER BY score DESC) AS vec_rank FROM vec) vec
      ON kw.chunk_id = vec.chunk_id
  )
  SELECT * FROM fused ORDER BY fused_score DESC LIMIT k;
$$ LANGUAGE sql STABLE;
