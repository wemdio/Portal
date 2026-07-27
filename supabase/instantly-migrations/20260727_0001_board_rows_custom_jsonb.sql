-- Кастомные колонки гостевой таблицы лидов: произвольные текстовые значения
-- по ключу из project_lead_boards.column_config (записи вида
-- {key: 'c_inn', label: 'ИНН', visible: true, custom: true}). Builtin-данные
-- не трогаем — только добавляем jsonb-кошелёк.
ALTER TABLE public.project_lead_board_rows
  ADD COLUMN IF NOT EXISTS custom jsonb NOT NULL DEFAULT '{}'::jsonb;
