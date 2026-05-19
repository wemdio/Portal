-- «Цепочки писем 2.0»: язык генерируемой цепочки (и ценностей).
-- Пользователь выбирает язык вывода — русский / английский / польский.
-- Входные данные (бриф, сегмент, правки) при этом могут быть на любом из языков.

alter table public.email_sequence_v2_runs
  add column if not exists output_language text not null default 'ru'
    check (output_language in ('ru', 'en', 'pl'));
