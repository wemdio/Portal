-- Фикс молчаливой потери всех новых классификаций лидов начиная с ~6 мая 2026.
--
-- Симптом: worker logи показывали "Classified ... (confidence: 0.95)" каждые
-- N минут на одни и те же 4 reply, но в БД 0 записей за неделю. AI впустую
-- тратил токены, специалисты не получали уведомления о лидах.
--
-- Корень проблемы: в leadQualificationWorker.ts upsert-операция:
--   .upsert({...}, { onConflict: 'instantly_email_id', ignoreDuplicates: true })
-- PostgREST превращает её в SQL `INSERT ... ON CONFLICT (instantly_email_id)
-- DO NOTHING`. PostgreSQL требует, чтобы ON CONFLICT (col) ссылался на
-- ПОЛНЫЙ unique constraint/index. У нас же был partial:
--   CREATE UNIQUE INDEX ... WHERE instantly_email_id IS NOT NULL
-- (создан в 20260410_0001). PostgREST на это отвечал 400 c кодом 42P10
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification", а в коде ошибка не проверялась — фейл был тихий.
--
-- Решение: заменить partial UNIQUE на FULL UNIQUE. По стандартным NULLS
-- DISTINCT множественные NULL допускаются — это значит, что строки без
-- instantly_email_id (легаси/ручные/webhook без id) не будут падать
-- с конфликтом, как и при partial-индексе.

DROP INDEX IF EXISTS public.idx_instantly_lead_qualifications_email_id;

-- Идемпотентный ADD CONSTRAINT: ensureDatabase прокатывает каждую миграцию
-- при каждом деплое, и эта была сначала применена руками на проде,
-- потом попала в репо — без guard вторая попытка ловит 42P07
-- (relation already exists) и срывает весь деплой.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'instantly_lead_qualifications_email_id_key'
      AND conrelid = 'public.instantly_lead_qualifications'::regclass
  ) THEN
    ALTER TABLE public.instantly_lead_qualifications
      ADD CONSTRAINT instantly_lead_qualifications_email_id_key
      UNIQUE (instantly_email_id);
  END IF;
END$$;
