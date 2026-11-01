-- ============================================================================
-- IGNIS — migration 0002: reference data (facilities + experiment catalog)
-- Canonical NASA microgravity combustion / spacecraft fire-safety campaigns.
-- ============================================================================
SET search_path TO ignis, public;

INSERT INTO facility (code, name, platform, agency, g_level, description) VALUES
  ('ISS',        'International Space Station',            'ISS',              'NASA/ISS',  '~1e-6 g', 'Long-duration microgravity laboratory; host of FLEX, BASS, SAME, ACE, CFI, SoFIE combustion experiments.'),
  ('BASS',       'Burning and Suppression of Solids',      'ISS',              'NASA',      '~1e-6 g', 'ISS investigation on burning and suppression of solid fuels in microgravity.'),
  ('SAFFIRE',    'Spacecraft Fire Safety Experiment',      'ISS/Cygnus',       'NASA',      '~1e-6 g', 'Series of large-scale spacecraft fire experiments flown in uncrewed Cygnus cargo vehicles (SAFFIRE I-VI).'),
  ('SAME',       'Smoke Aerosol Measurement Experiment',   'ISS',              'NASA',      '~1e-6 g', 'ISS experiment measuring smoke particle size and optical properties for spacecraft fire detection.'),
  ('FLEX',       'Flame Extinguishment Experiment',        'ISS',              'NASA',      '~1e-6 g', 'ISS droplet combustion experiments (FLEX, FLEX-2, FLEX-2J) studying droplet burning and extinction.'),
  ('CFI',        'Cool Flames Investigation',              'ISS',              'NASA',      '~1e-6 g', 'ISS investigation of low-temperature "cool flame" burning of fuels.'),
  ('ACE',        'Advanced Combustion via Microgravity Experiments', 'ISS',    'NASA',      '~1e-6 g', 'ISS combustion rack experiment suite (flame design, burning rate emulator, electric-field effects).'),
  ('SoFIE',      'Solid Fuel Ignition and Extinction',     'ISS',              'NASA',      '~1e-6 g', 'ISS investigation on ignition and extinction of solid fuels, including growth and extinction limits.'),
  ('DropTower',  'NASA Glenn Zero Gravity Drop Tower',     'drop_tower',       'NASA',      '1e-5 g (2.2 s)', 'Ground-based microgravity facility used for short-duration combustion experiments.'),
  ('KC135',      'Reduced Gravity Aircraft (KC-135)',      'parabolic_flight','NASA',      '~1e-2 g (20 s)', 'Parabolic flight aircraft providing repeated short-duration reduced-gravity conditions.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO experiment (code, name, aliases, campaign, objective, summary, status, gravity_level, fuel_type, ambient_gas, ignition_source, metadata) VALUES
  ('BASS-II', 'Burning and Suppression of Solids - II',
   ARRAY['BASS-II','BASS II','Burning and Suppression of Solids II'],
   'BASS',
   'Study burning and suppression of solid fuel samples in microgravity to improve spacecraft fire-safety models.',
   'ISS investigation extending BASS: solid fuels (PMMA, cotton-fiberglass blends, and other materials) burned in controlled microgravity flows, with suppression by gaseous agents. Aims to validate flame-spread and extinction models for spacecraft fire safety.',
   'flown', '~1e-6 g', 'PMMA; cotton-fiberglass blend (SIBAL)', 'O2/N2 and O2/CO2 mixtures',
   'hot-wire ignition', '{"rack":"Combustion Integrated Rack (CIR)","investigation":"BASS-II"}'::jsonb),

  ('SAFFIRE', 'Spacecraft Fire Safety Experiment',
   ARRAY['SAFFIRE','SAFFIRE I','SAFFIRE II','SAFFIRE III','SAFFIRE IV','SAFFIRE V','SAFFIRE VI'],
   'SAFFIRE',
   'Characterize large-scale flame growth and fire behavior on spacecraft-relevant materials in microgravity.',
   'Series of large-scale in-space fire experiments conducted inside uncrewed Cygnus cargo vehicles after undocking. SAFFIRE studied flame growth over large sample panels, smoke spread, and material flammability limits at spacecraft-relevant scales.',
   'completed', '~1e-6 g', 'SIBAL (cotton-fiberglass blend) fabric panels', 'Spacecraft cabin atmosphere (~21% O2, ~1 atm)',
   'hot-wire ignition', '{"vehicle":"Cygnus","sample_area_m2":0.9}'::jsonb),

  ('SAME', 'Smoke Aerosol Measurement Experiment',
   ARRAY['SAME','Smoke Aerosol Measurement Experiment'],
   'SAME',
   'Measure smoke particle size and optical properties produced by overheated spacecraft materials to improve fire detectors.',
   'ISS experiment that generated smoke from overheating candidate spacecraft materials and measured particle size distributions and light-scattering properties. Results inform spacecraft smoke-detector design and false-alarm reduction.',
   'flown', '~1e-6 g', 'spacecraft materials (wire insulation, silicone, Teflon, etc.)', 'Spacecraft cabin atmosphere',
   'thermal degradation / overheat', '{"purpose":"fire detection"}'::jsonb),

  ('FLEX-2', 'Flame Extinguishment Experiment - 2',
   ARRAY['FLEX','FLEX-2','FLEX-2J','Flame Extinguishment Experiment'],
   'FLEX',
   'Study droplet combustion, soot formation, and flame extinction of liquid fuels in microgravity.',
   'ISS droplet-combustion experiments burning single and binary fuel droplets (heptane, methanol, decane, etc.) in microgravity to determine burning rates, soot production, and extinction limits.',
   'flown', '~1e-6 g', 'heptane; methanol; decane; binary fuel mixtures', 'O2/He, O2/N2, O2/CO2',
   'hot-wire ignition of droplet', '{"droplet_combustion":true}'::jsonb),

  ('SoFIE', 'Solid Fuel Ignition and Extinction',
   ARRAY['SoFIE','Solid Fuel Ignition and Extinction','SoFIE-GEL','SoFIE-MIST','SoFIE-CA','SoFIE-FIG'],
   'SoFIE',
   'Determine solid-fuel ignition and extinction limits in microgravity for spacecraft fire safety.',
   'ISS investigation comprising multiple sub-experiments (Growth and Extinction Limit, Material Ignition and Suppression Test, Cool-flame and Ignition, Flammability of Inclined materials) to establish flammability limits relevant to spacecraft habitats.',
   'flown', '~1e-6 g', 'PMMA; cotton; other solid fuels', 'O2/N2 mixtures at varied pressure',
   'resistive / radiative ignition', '{"sub_experiments":["GEL","MIST","CA","FIG"]}'::jsonb),

  ('CFI', 'Cool Flames Investigation',
   ARRAY['CFI','Cool Flames Investigation','CFI-GA','CFI-BT'],
   'CFI',
   'Investigate low-temperature cool-flame burning and its role in spacecraft fire risk.',
   'ISS investigation of cool-flame combustion of gaseous and liquid fuels, examining the two-stage ignition behavior that can create unexpected low-temperature burning hazards.',
   'flown', '~1e-6 g', 'gaseous fuels (n-alkanes); liquid fuels', 'O2/N2 and O2/CO2',
   'hot-wire / spark ignition', '{"phenomenon":"cool flames"}'::jsonb),

  ('ACE', 'Advanced Combustion via Microgravity Experiments',
   ARRAY['ACE','Advanced Combustion via Microgravity Experiments','BRE','FLEX-Electric','s-Flame'],
   'ACE',
   'Conduct fundamental microgravity combustion studies to improve combustion models and spacecraft fire safety.',
   'ISS suite including Burning Rate Emulator (BRE), Electric-Field Effects on Laminar Diffusion Flames, and other sub-experiments probing flame structure, soot, and extinction in microgravity.',
   'flown', '~1e-6 g', 'gaseous and solid fuels', 'varied O2/N2',
   'spark / hot-wire', '{"sub_experiments":["BRE","EFELLS","s-Flame"]}'::jsonb),

  ('BASS', 'Burning and Suppression of Solids',
   ARRAY['BASS','Burning and Suppression of Solids'],
   'BASS',
   'Study solid-fuel burning and suppression in microgravity as the precursor to BASS-II.',
   'First-generation ISS investigation of solid fuel burning and suppression in microgravity, establishing methods later extended by BASS-II.',
   'flown', '~1e-6 g', 'PMMA; cotton-fiberglass blend', 'O2/N2 mixtures',
   'hot-wire ignition', '{"predecessor_of":"BASS-II"}'::jsonb)
ON CONFLICT (code) DO NOTHING;

-- Link experiments to their primary facility.
UPDATE experiment e SET facility_id = f.id
FROM facility f
WHERE e.facility_id IS NULL AND (
     (e.code IN ('BASS','BASS-II','FLEX-2','SoFIE','CFI','ACE','SAME') AND f.code = 'ISS')
  OR (e.code = 'SAFFIRE' AND f.code = 'SAFFIRE')
);
