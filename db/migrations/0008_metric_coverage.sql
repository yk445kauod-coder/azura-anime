-- ============================================================================
-- IGNIS — broaden extracted-metric coverage
-- Migration 0008
--
-- The Data Explorer and Insights pages present one row per measured variable,
-- but the extractor only recognised ten quantities, so the corpus appeared to
-- hold seven usable metrics. This adds the conversions for the additional
-- combustion quantities now extracted by pipeline/clean.py so the canonical
-- value is comparable across the units the corpus actually records.
--
-- Only unit metadata changes here; the values themselves are produced by
-- `python -m pipeline.clean --refresh-findings`, which re-derives findings from
-- the stored cleaned text. No number is invented.
-- ============================================================================

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
    -- length -> mm
    WHEN metric IN ('droplet diameter', 'flame length', 'flame height') AND unit = 'µm' THEN 0.001
    WHEN metric IN ('droplet diameter', 'flame length', 'flame height') AND unit = 'um' THEN 0.001
    WHEN metric IN ('droplet diameter', 'flame length', 'flame height') AND unit LIKE 'micron%' THEN 0.001
    WHEN metric IN ('flame length', 'flame height') AND unit = 'cm' THEN 10
    WHEN metric IN ('flame length', 'flame height') AND unit = 'm'  THEN 1000
    -- velocity -> cm/s
    WHEN metric = 'flow velocity' AND unit = 'mm/s' THEN 0.1
    WHEN metric = 'flow velocity' AND unit = 'm/s'  THEN 100
    -- time -> s
    WHEN metric = 'burn time' AND unit = 'ms'  THEN 0.001
    WHEN metric = 'burn time' AND unit = 'min' THEN 60
    -- power -> W
    WHEN metric = 'heat release rate' AND unit = 'kW' THEN 1000
    WHEN metric = 'heat release rate' AND unit = 'MW' THEN 1000000
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
    WHEN 'droplet diameter'      THEN 'mm'
    WHEN 'oxygen concentration'  THEN 'vol%'
    WHEN 'flow velocity'         THEN 'cm/s'
    WHEN 'flame length'          THEN 'mm'
    WHEN 'flame height'          THEN 'mm'
    WHEN 'burn time'             THEN 's'
    WHEN 'heat release rate'     THEN 'W'
    ELSE NULL
  END;
$$;
