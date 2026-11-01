-- 0003 — pin search_path on IGNIS functions.
--
-- The retrieval functions reference tables (chunk, document, chunk_embedding)
-- by unqualified name. Because they are LANGUAGE sql, Postgres may inline them
-- into the caller, at which point the *caller's* search_path applies and the
-- lookup fails with `relation "chunk" does not exist`. Attaching an explicit
-- search_path makes the functions self-contained (and non-inlinable), so they
-- behave identically no matter which client or schema calls them.

ALTER FUNCTION ignis.search_chunks_keyword(text, integer)
  SET search_path = ignis, public;

ALTER FUNCTION ignis.search_chunks_vector(vector, integer, text)
  SET search_path = ignis, public;

ALTER FUNCTION ignis.search_chunks_hybrid(text, vector, integer, integer, text, integer)
  SET search_path = ignis, public;

ALTER FUNCTION ignis.update_chunk_tsv()
  SET search_path = ignis, public;

ALTER FUNCTION ignis.update_document_tsv()
  SET search_path = ignis, public;

-- Allow the public schema as an extra safety net for extension operators
-- (pgvector's <=> is resolved through the operator's own schema).
GRANT USAGE ON SCHEMA ignis TO PUBLIC;
