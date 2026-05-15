-- Расширяем CHECK constraint на match_source: добавляем 'auto-text' и 'auto-ai'.
-- См. 20260515_0001 (новые match_source значения) — без расширения CHECK
-- любой UPSERT с новыми значениями падает с 23514 (check_violation), а
-- substring и AI matcher молча валятся, не создавая ни одной привязки.
--
-- Применено на проде 15 мая 2026 руками после первого обнаружения проблемы
-- на post-deploy sync; миграция здесь для consistency репо ↔ прод.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'project_instantly_campaigns_match_source_check'
      AND conrelid = 'public.project_instantly_campaigns'::regclass
  ) THEN
    ALTER TABLE public.project_instantly_campaigns
      DROP CONSTRAINT project_instantly_campaigns_match_source_check;
  END IF;
END$$;

ALTER TABLE public.project_instantly_campaigns
  ADD CONSTRAINT project_instantly_campaigns_match_source_check
  CHECK (match_source = ANY (ARRAY['auto', 'auto-text', 'auto-ai', 'manual']));
