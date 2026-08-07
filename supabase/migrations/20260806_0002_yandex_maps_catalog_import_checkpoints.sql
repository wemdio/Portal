alter table public.yandex_maps_catalog_import_runs
  add column if not exists current_file text,
  add column if not exists current_row integer not null default 0,
  add column if not exists checkpoint_at timestamptz;

comment on column public.yandex_maps_catalog_import_runs.current_file is
  'Relative source file currently being imported; used for resumable imports.';
comment on column public.yandex_maps_catalog_import_runs.current_row is
  'Last source row durably merged for current_file.';
