-- ============================================================================
-- IGNIS — dataset catalogue for the Data Explorer
-- Migration 0006
--
-- The Data Explorer needs a dataset/variable abstraction, but every number it
-- shows must be a real measured value. Rather than introducing a second,
-- hand-maintained store of numbers, these objects are *views* over
-- ignis.finding — the table that holds values extracted from the NTRS corpus.
-- That keeps one source of truth: a measurement cannot drift between the
-- dataset catalogue and the underlying evidence row.
--
-- Provenance is deliberately preserved: every row keeps the source document,
-- the verbatim evidence quote, and the extractor's confidence, so the UI can
-- state honestly that values are regex-extracted from report text rather than
-- curated by NASA as machine-readable data.
--
-- Units are heterogeneous in the corpus (pressure alone appears in atm, kPa,
-- psi, torr and bar). Charts must not plot those on one axis, so each metric
-- declares a canonical unit and ignis.dataset_convert() maps the recorded unit
-- onto it. Both raw and normalised values are exposed.
-- ============================================================================

-- Recorded unit -> canonical unit, per metric.
CREATE OR REPLACE FUNCTION ignis.unit_factor(metric text, unit text)
RETURNS double precision
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN unit IS NULL THEN 1
    -- pressure -> kPa
    WHEN metric = 'pressure' AND lower(unit) = 'atm'  THEN 101.325
    WHEN metric = 'pressure' AND lower(unit) = 'kpa'  THEN 1
    WHEN metric = 'pressure' AND lower(unit) = 'psi'  THEN 6.894757
    WHEN metric = 'pressure' AND lower(unit) = 'torr' THEN 0.1333224
    WHEN metric = 'pressure' AND lower(unit) = 'bar'  THEN 100
    -- length -> nm
    WHEN metric = 'smoke particle size' AND unit = 'μm' THEN 1000
    -- velocity -> mm/s
    WHEN metric = 'flame spread rate' AND unit = 'cm/s' THEN 10
    ELSE 1
  END;
$$;

CREATE OR REPLACE FUNCTION ignis.unit_canonical(metric text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE metric
    WHEN 'pressure'            THEN 'kPa'
    WHEN 'flame temperature'   THEN 'K'
    WHEN 'limiting oxygen index' THEN '%'
    WHEN 'soot volume fraction'  THEN 'ppm'
    WHEN 'smoke particle size'   THEN 'nm'
    WHEN 'flame spread rate'     THEN 'mm/s'
    WHEN 'gravity level'         THEN 'g'
    ELSE NULL
  END;
$$;

-- ---------------------------------------------------------------------------
-- ignis.dataset — one row per measured variable
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW ignis.dataset AS
SELECT
  replace(lower(f.metric), ' ', '_')                     AS key,
  f.metric                                               AS name,
  ignis.unit_canonical(f.metric)                         AS canonical_unit,
  count(*)                                               AS value_count,
  count(DISTINCT f.document_id)                          AS document_count,
  count(DISTINCT f.unit)                                 AS recorded_unit_count,
  array_agg(DISTINCT f.unit ORDER BY f.unit)             AS recorded_units,
  min(f.value)                                           AS value_min,
  max(f.value)                                           AS value_max,
  count(*) FILTER (WHERE f.value_max IS NOT NULL)        AS ranged_value_count,
  round(avg(f.confidence)::numeric, 3)                   AS mean_confidence,
  array_agg(DISTINCT f.extraction_method)                AS extraction_methods
FROM ignis.finding f
WHERE f.metric IS NOT NULL AND f.value IS NOT NULL
GROUP BY f.metric;

-- ---------------------------------------------------------------------------
-- ignis.dataset_row — the analysable observations behind a dataset
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW ignis.dataset_row AS
SELECT
  f.id                                                    AS finding_id,
  replace(lower(f.metric), ' ', '_')                      AS dataset_key,
  f.metric                                                AS metric,
  f.value                                                 AS raw_value,
  f.unit                                                  AS raw_unit,
  f.value * ignis.unit_factor(f.metric, f.unit)           AS value,
  ignis.unit_canonical(f.metric)                          AS unit,
  f.value_max * ignis.unit_factor(f.metric, f.unit)       AS value_max,
  f.statement,
  f.evidence_quote,
  f.confidence,
  f.extraction_method,
  f.document_id,
  d.source_id                                             AS document_source_id,
  d.title                                                 AS document_title,
  d.landing_url,
  e.code                                                  AS experiment_code,
  e.name                                                  AS experiment_name
FROM ignis.finding f
LEFT JOIN ignis.document d ON d.id = f.document_id
LEFT JOIN LATERAL (
  SELECT x.code, x.name
  FROM ignis.experiment_document ed
  JOIN ignis.experiment x ON x.id = ed.experiment_id
  WHERE ed.document_id = f.document_id
  ORDER BY x.code
  LIMIT 1
) e ON true
WHERE f.metric IS NOT NULL AND f.value IS NOT NULL;

GRANT SELECT ON ignis.dataset, ignis.dataset_row TO PUBLIC;
