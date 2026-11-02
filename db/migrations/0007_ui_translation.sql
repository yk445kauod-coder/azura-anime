-- ============================================================================
-- IGNIS — UI localisation cache
-- Migration 0007
--   ui_translation : one row per (locale, source string) so the 10 supported
--                    languages cost one LLM call ever, not one per page view.
--
-- Strings are keyed by the exact English source text rather than by a symbolic
-- key, so a component can translate its own literal without a registry entry and
-- a string that changes in the source simply misses the cache and gets redone.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ignis.ui_translation (
  id            bigserial PRIMARY KEY,
  locale        text NOT NULL,                 -- ar, fr, es, ...
  source_hash   text NOT NULL,                 -- md5 of source_en, keeps the unique key small
  source_en     text NOT NULL,
  translated    text NOT NULL,
  model         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (locale, source_hash)
);
CREATE INDEX IF NOT EXISTS ui_translation_locale_idx ON ignis.ui_translation (locale);

-- Bulk lookups always ask for a set of hashes in one locale.
CREATE INDEX IF NOT EXISTS ui_translation_lookup_idx
  ON ignis.ui_translation (locale, source_hash);

GRANT USAGE ON SCHEMA ignis TO PUBLIC;
GRANT SELECT, INSERT, UPDATE ON ignis.ui_translation TO PUBLIC;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ignis TO PUBLIC;
