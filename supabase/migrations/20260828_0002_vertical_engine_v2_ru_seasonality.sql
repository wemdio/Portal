-- Vertical Engine v2: verified RU seasonality on evidence-stage hypotheses.
-- Nullable by design: existing rows and non-RU projects remain backward compatible.

alter table public.ve_hypotheses
  add column if not exists seasonality jsonb;

alter table public.ve_hypotheses
  drop constraint if exists ve_hypotheses_seasonality_shape_check;

alter table public.ve_hypotheses
  add constraint ve_hypotheses_seasonality_shape_check
  check (
    seasonality is null
    or coalesce((
      jsonb_typeof(seasonality) = 'object'
      and seasonality ->> 'version' = '1'
      and seasonality ->> 'classification' in ('seasonal', 'neutral', 'unknown')
      and seasonality ->> 'confidence' in ('low', 'medium', 'high')
      and jsonb_typeof(seasonality -> 'rationale') = 'string'
      and jsonb_typeof(seasonality -> 'windows') = 'array'
      and jsonb_typeof(seasonality -> 'evidence') = 'array'
    ), false)
  );

comment on column public.ve_hypotheses.seasonality is
  'Verified RU annual seasonality assessment (windows, confidence and source quotes); NULL for legacy/non-RU rows.';
