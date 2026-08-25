-- One-off data repair: возврат ложных skip «юзернейм не найден» по ВСЕМ кампаниям.
-- Аудит 25.08.2026. Баг: gramJS getEntity → contacts.ResolveUsername отдаёт
-- USERNAME_NOT_OCCUPIED на ЖИВЫЕ ники, когда аккаунт урезан/frozen. Старый код
-- ставил status=skipped навсегда. Фикс логики уже в origin/Sergey (коммиты
-- 739cfaeef, 3d5217daf) — этот скрипт только возвращает уже сожжённое.
--
-- Кампании и объёмы (сверены с продом 25.08.2026):
--   TG_VBI               273   (аккаунт 254360278, Василий — доказанная заморозка)
--   Polza_Старые аккаунты 80
--   ATOL-1                57
--   TG_Roistat             6
--   ИТОГО                416
--
-- ПОРЯДОК (НЕ нарушать):
--   1) задеплоить воркеры с фиксом логики (после фикса возврат безопасен: живые
--      ники отправятся, мёртвые больше НЕ сгорят в skipped — отложатся 3 раза и
--      уйдут в failed);
--   2) запустить этот скрипт.
--
-- Скрипт идемпотентен: повторный запуск ничего не меняет (контактов со
-- skip_reason='юзернейм не найден в Telegram' в skipped больше нет).
--
-- НЕ выполнять на test/main, НЕ запускать без явного «давай» оператора.

BEGIN;

-- Паркуем ТОЛЬКО доказанно замороженный аккаунт TG_VBI (254360278). Остальные
-- замороженные аккаунты парковать вручную не нужно: после деплоя фикс сам уведёт
-- их в cooldown_until при первой же «вся порция USERNAME_NOT_OCCUPIED».
UPDATE tg_outreach_accounts
SET cooldown_until = now() + interval '24 hours',
    updated_at = now()
WHERE id = '65447664-4515-48af-b149-e41bdadf125f';  -- session_name=254360278

-- Возвращаем в pending все контакты, сожжённые ложным «юзернейм не найден».
-- Другие причины skip (Premium, «уже писали», заблокировал и т.п.) НЕ трогаем —
-- это настоящие терминальные причины.
UPDATE tg_outreach_base_contacts c
SET status      = 'pending',
    attempts    = 0,
    skip_reason = NULL,
    account_id  = NULL,
    tg_user_id  = NULL,
    sent_at     = NULL,
    updated_at  = now()
FROM tg_outreach_campaign_bases cb
WHERE cb.base_id = c.base_id
  AND cb.campaign_id IN (
        '978f79cb-6ccd-4b4c-9b6f-aa23cb4af614',  -- TG_VBI
        '15db0cb5-7ebe-454b-9d75-892272ee56bf',  -- Polza_Старые аккаунты
        '32584cc1-e8e4-41bb-8008-fccb0e9ead27',  -- ATOL-1
        '4a6414e6-4f1c-47a4-84b5-6697916ed42a'   -- TG_Roistat
  )
  AND c.status = 'skipped'
  AND c.skip_reason = 'юзернейм не найден в Telegram';

-- Итог для лога: сколько вернули и что осталось в skipped по причинам.
SELECT cm.name AS campaign,
       count(*) FILTER (WHERE c.status = 'pending')                    AS pending_now,
       count(*) FILTER (WHERE c.status = 'skipped')                    AS skipped_left,
       count(*) FILTER (WHERE c.status = 'skipped'
                           AND c.skip_reason = 'юзернейм не найден в Telegram') AS skipped_username_nf_left
FROM tg_outreach_base_contacts c
JOIN tg_outreach_campaign_bases cb ON cb.base_id = c.base_id
JOIN tg_outreach_campaigns cm ON cm.id = cb.campaign_id
WHERE cb.campaign_id IN (
        '978f79cb-6ccd-4b4c-9b6f-aa23cb4af614',
        '15db0cb5-7ebe-454b-9d75-892272ee56bf',
        '32584cc1-e8e4-41bb-8008-fccb0e9ead27',
        '4a6414e6-4f1c-47a4-84b5-6697916ed42a'
)
GROUP BY cm.name
ORDER BY cm.name;

COMMIT;
