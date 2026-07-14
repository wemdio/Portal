-- 019: soft-delete для raw_accounts.
--
-- Проблема: /accounts отдаёт ПОЛНЫЙ текущий список ящиков, но синк только
-- UPSERT-ил — удалённые в Instantly почты оставались у нас навсегда. На
-- 2026-07-14 таких «призраков» было 534 из 1548 (34%). Дашборд «Нагрузка почт»
-- считал их живыми: +43 ящика и +3185 писем/день фантомного потолка по 12 тегам
-- (напр. «ИЗИ Контроль» показывал 28 ящиков вместо 27 в Instantly).
--
-- Почему НЕ hard-delete: на raw_accounts.email смотрит история raw_emails.eaccount
-- (2M+ писем). Физическое удаление осиротило бы метаданные отправителя во всей
-- исторической аналитике. Поэтому soft-delete: строка остаётся, но помечена.
--
-- Контракт: deleted_at IS NULL  ⇔  ящик существует в Instantly СЕЙЧАС.
-- Текущее состояние (дашборды, потолки, утилизация) — только по deleted_at IS NULL.
-- Историю (raw_emails JOIN raw_accounts) — по всем строкам, без фильтра.

ALTER TABLE raw_accounts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

COMMENT ON COLUMN raw_accounts.deleted_at IS
  'Когда ящик пропал из живого /accounts Instantly (soft-delete). NULL = существует сейчас. Для текущего состояния фильтруй deleted_at IS NULL; для истории — не фильтруй.';

-- Дашборд всегда ходит с этим фильтром → частичный индекс по живым.
CREATE INDEX IF NOT EXISTS raw_accounts_live_idx ON raw_accounts (email) WHERE deleted_at IS NULL;
