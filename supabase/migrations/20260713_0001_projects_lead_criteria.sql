-- Per-project custom lead definition for the AI qualifier.
--
-- The baked-in criteria («лид = видел развёрнутое предложение И проявил
-- интерес») structurally suppress ALL leads of contact-request-first campaigns
-- (e.g. Ritso: step 1 asks «кто отвечает за 1С?» — a reply «можете меня
-- набрать в 14-15» is the very goal of that step, yet is classified not_lead).
-- This column lets the project team write their own definition; it takes
-- priority over the default criteria in the qualifier prompt. Empty = default
-- behavior, zero change for other projects.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS lead_criteria text;

COMMENT ON COLUMN public.projects.lead_criteria IS
  'Custom AI lead definition for all campaigns of this project; overrides the default qualifier criteria. Empty = default.';
