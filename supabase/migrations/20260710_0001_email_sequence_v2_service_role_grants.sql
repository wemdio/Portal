-- v2-таблицы «Цепочек писем 2.0» создавались без грантов для service_role
-- (в отличие от v1 email_sequence_runs): любые запросы через supabaseAdmin
-- получали permission denied и МОЛЧА трактовались как «пусто». Последствия
-- на проде: tariffs.countChains не считал v2-генерации в лимит тарифа
-- («потрачено 0 цепочек» при реальных генерациях), а онбординг-шаг
-- «Написать первую цепочку» не видел v2-раны и не завершался. Клиентский
-- инструмент при этом работал — его роуты ходят authenticated-ролью.
-- Найдено 10.07.2026 при верификации IA-переработки (аккаунт Cheesmall).
grant all on table public.email_sequence_v2_runs to service_role;
grant all on table public.email_sequence_v2_letters to service_role;
