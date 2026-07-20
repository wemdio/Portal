-- 020: теги почт, скрываемые из дашборда «Нагрузка почт».
--
-- Зачем: часть клиентов ведётся в Coldy/Trigga, а не в Instantly. Их ящики стоят
-- в Instantly ТОЛЬКО на прогреве — отправок там нет и не будет, поэтому тег вечно
-- висит красным «Простой» (ложная тревога). work_format проекта = 'Колди'/'Тригга'
-- (portal_projects), но связать тег с проектом автоматически нельзя: у таких
-- проектов нет кампаний в Instantly, а имена тегов ≠ имена клиентов (mateca↔Маца).
-- Поэтому — явный курируемый список tag_id.
--
-- Как дополнять: INSERT новой строки (tag_id из raw_custom_tags). Удалить из
-- скрытия — DELETE. Дашборд читает эту таблицу вживую, передеплой приложения не нужен.

CREATE TABLE IF NOT EXISTS mailbox_load_hidden_tags (
  tag_id     TEXT PRIMARY KEY,
  tag_name   TEXT,          -- для читаемости (raw_custom_tags.name на момент добавления)
  reason     TEXT,          -- почему скрыт (напр. 'Coldy', 'Trigga')
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE mailbox_load_hidden_tags IS
  'Теги, исключаемые из дашборда нагрузки почт (клиент ведётся вне Instantly — Coldy/Trigga, ящики только на прогреве). Курируется вручную.';
