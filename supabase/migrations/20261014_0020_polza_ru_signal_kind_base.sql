-- Своя загруженная база компаний (с почтой, без повода) в загрузках сигналов RU автоаутрича.
alter table public.polza_ru_signal_uploads drop constraint if exists polza_ru_signal_uploads_kind_check;
alter table public.polza_ru_signal_uploads
  add constraint polza_ru_signal_uploads_kind_check check (kind in ('exhibitors', 'contracts', 'growth', 'tenders', 'base'));
alter table public.polza_ru_signal_rows drop constraint if exists polza_ru_signal_rows_kind_check;
alter table public.polza_ru_signal_rows
  add constraint polza_ru_signal_rows_kind_check check (kind in ('exhibitors', 'contracts', 'growth', 'tenders', 'base'));
