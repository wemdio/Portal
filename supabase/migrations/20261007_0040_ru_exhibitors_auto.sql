-- «Наш автоаутрич»: экспоненты выставок без ручной загрузки файла.
-- Воркер polza-outreach раз в неделю обходит каталоги участников (МВК и
-- платформа Expodat, lib/polzaRuOutreach/sources/exhibitionCatalogs.ts) и
-- кладёт их в те же polza_ru_signal_uploads / polza_ru_signal_rows.
-- Ручные загрузки не меняются: у них source и source_key пустые.

alter table public.polza_ru_signal_uploads add column if not exists source text;
alter table public.polza_ru_signal_uploads add column if not exists source_key text;
alter table public.polza_ru_signal_uploads add column if not exists synced_at timestamptz;
alter table public.polza_ru_signal_uploads add column if not exists sync_meta jsonb not null default '{}'::jsonb;

comment on column public.polza_ru_signal_uploads.source is
  'Откуда строки: null — файл оператора; mvk / expodat — автосинк каталога выставки.';
comment on column public.polza_ru_signal_uploads.source_key is
  'Ключ выпуска выставки в автосинке (mvk:pcvexpo-2026) — повторный синк обновляет ту же загрузку.';
comment on column public.polza_ru_signal_uploads.sync_meta is
  'Итог последнего автосинка: сколько в каталоге, отсеяно иностранцев и без сайта, ключи отсеянных иностранцев.';

-- Обычный (не частичный) уникальный индекс: на нём держится upsert из кода;
-- у ручных загрузок source_key null, а null-ы в уникальном индексе не конфликтуют.
create unique index if not exists polza_ru_signal_uploads_source_key_uidx
  on public.polza_ru_signal_uploads (source_key);

alter table public.polza_ru_signal_rows add column if not exists source_key text;

comment on column public.polza_ru_signal_rows.source_key is
  'Id экспонента в каталоге (mvk:115406, expodat:118428) — строка не дублируется при повторном синке.';

create unique index if not exists polza_ru_signal_rows_upload_source_key_uidx
  on public.polza_ru_signal_rows (upload_id, source_key);
