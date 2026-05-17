-- Сжатое хранение состояния инструмента «Работа с базами».
--
-- Проблема: database_spreadsheet_states.state (jsonb) хранит ВСЕ вкладки
-- пользователя одним blob. У активных пользователей он разрастался до
-- 30 МБ. Такой объём:
--   - писался десятками секунд (POST висел в pending),
--   - читался 47-60 секунд (не укладывался в таймаут загрузки),
-- из-за чего большие базы (~32k строк) терялись.
--
-- Решение: клиент сжимает JSON состояния (gzip) и шлёт base64 в новую
-- колонку state_compressed. 30 МБ JSON → ~3-4 МБ gzip → ~4-5 МБ base64.
-- Чтение/запись ускоряются в ~6-8 раз.
--
-- Колонка state (jsonb) остаётся для обратной совместимости: старые
-- записи читаются как раньше; при первом же сохранении пользователь
-- переходит на state_compressed (state выставляется в NULL).

ALTER TABLE public.database_spreadsheet_states
  ADD COLUMN IF NOT EXISTS state_compressed text;

-- state перестаёт быть обязательной: новые записи несут данные в
-- state_compressed, а state остаётся NULL. NOT NULL снимаем, иначе
-- INSERT нового сжатого состояния падал бы с not-null violation.
ALTER TABLE public.database_spreadsheet_states
  ALTER COLUMN state DROP NOT NULL;
