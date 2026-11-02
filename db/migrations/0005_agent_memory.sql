-- ============================================================================
-- IGNIS — agent memory layer: short-term + long-term vector memory
-- Migration 0005
--   short_term_memory : per-conversation recall (user context within a session)
--   long_term_memory  : cross-session knowledge distilled from completed runs
--   memory_signal     : usage stats for memory hygiene
-- ============================================================================

CREATE TABLE IF NOT EXISTS ignis.short_term_memory (
  id              bigserial PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES ignis.conversation(id) ON DELETE CASCADE,
  kind            text NOT NULL,                     -- question | answer | fact | preference
  content         text NOT NULL,
  source_run_id   uuid REFERENCES ignis.agent_run(id) ON DELETE SET NULL,
  embedding       vector(384) NOT NULL,
  importance      real NOT NULL DEFAULT 0.5,         -- 0..1 how reusable this memory is
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz                        -- NULL = keep for the whole session
);
CREATE INDEX IF NOT EXISTS short_term_memory_conversation_idx
  ON ignis.short_term_memory (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS short_term_memory_hnsw
  ON ignis.short_term_memory USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS ignis.long_term_memory (
  id              bigserial PRIMARY KEY,
  kind            text NOT NULL,                     -- fact | finding | insight | lesson
  content         text NOT NULL,
  source_run_id   uuid REFERENCES ignis.agent_run(id) ON DELETE SET NULL,
  source_chunk_id bigint REFERENCES ignis.chunk(id) ON DELETE SET NULL,
  embedding       vector(384) NOT NULL,
  importance      real NOT NULL DEFAULT 0.5,
  confidence      real NOT NULL DEFAULT 0.5,
  hit_count       integer NOT NULL DEFAULT 1,        -- reinforcement (spaced recall)
  last_hit_at     timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS long_term_memory_kind_idx ON ignis.long_term_memory (kind);
CREATE INDEX IF NOT EXISTS long_term_memory_hnsw
  ON ignis.long_term_memory USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE TABLE IF NOT EXISTS ignis.memory_signal (
  id              bigserial PRIMARY KEY,
  memory_type     text NOT NULL,                     -- short_term | long_term
  memory_id       bigint NOT NULL,
  run_id          uuid REFERENCES ignis.agent_run(id) ON DELETE SET NULL,
  action          text NOT NULL,                     -- written | recalled
  similarity      real,                              -- recall similarity when applicable
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_signal_memory_idx ON ignis.memory_signal (memory_type, memory_id, created_at DESC);

-- Recall over short-term memory: ANN by embedding, then boost by recency.
CREATE OR REPLACE FUNCTION ignis.recall_short_term(
  qvec text,
  conv uuid,
  k integer DEFAULT 5,
  min_score double precision DEFAULT 0.5
) RETURNS TABLE (
  id bigint, kind text, content text, importance real, score real, created_at timestamptz
) AS $$
  SELECT id, kind, content, importance,
         (1 - (embedding <=> qvec::vector))::real AS score,
         created_at
  FROM ignis.short_term_memory
  WHERE conversation_id = conv
    AND (expires_at IS NULL OR expires_at > now())
    AND (1 - (embedding <=> qvec::vector)) >= min_score
  ORDER BY embedding <=> qvec::vector
  LIMIT k;
$$ LANGUAGE sql STABLE
SET search_path = ignis, public;

CREATE OR REPLACE FUNCTION ignis.recall_long_term(
  qvec text,
  k integer DEFAULT 5,
  min_score double precision DEFAULT 0.5
) RETURNS TABLE (
  id bigint, kind text, content text, importance real, confidence real,
  hit_count integer, score real, created_at timestamptz
) AS $$
  SELECT id, kind, content, importance, confidence, hit_count,
         (1 - (embedding <=> qvec::vector))::real AS score,
         created_at
  FROM ignis.long_term_memory
  WHERE (1 - (embedding <=> qvec::vector)) >= min_score
  ORDER BY embedding <=> qvec::vector
  LIMIT k;
$$ LANGUAGE sql STABLE
SET search_path = ignis, public;
  SELECT id, kind, content, importance,
         (1 - (embedding <=> qvec))::real AS score,
         created_at
  FROM ignis.short_term_memory
  WHERE conversation_id = conv
    AND (expires_at IS NULL OR expires_at > now())
    AND (1 - (embedding <=> qvec)) >= min_score
  ORDER BY embedding <=> qvec
  LIMIT k;
$$ LANGUAGE sql STABLE;

-- Recall over long-term memory: ANN by embedding, boosted by hit_count (reinforcement).
CREATE OR REPLACE FUNCTION ignis.recall_long_term(
  qvec vector(384),
  k integer DEFAULT 5,
  min_score real DEFAULT 0.5
) RETURNS TABLE (
  id bigint, kind text, content text, importance real, confidence real,
  hit_count integer, score real, created_at timestamptz
) AS $$
  SELECT id, kind, content, importance, confidence, hit_count,
         (1 - (embedding <=> qvec))::real AS score,
         created_at
  FROM ignis.long_term_memory
  WHERE (1 - (embedding <=> qvec)) >= min_score
  ORDER BY embedding <=> qvec
  LIMIT k;
$$ LANGUAGE sql STABLE;