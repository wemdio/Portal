-- One-off data repair: ложный skip «юзернейм не найден» на frozen аккаунте.
-- Аудит 25.08.2026, кампания TG_VBI, аккаунт 254360278 (Василий, 998336180831).
--
-- Код: gramJS getEntity → contacts.ResolveUsername отдаёт USERNAME_NOT_OCCUPIED
-- на ЖИВЫЕ ники, когда аккаунт урезан/frozen. Старый isUsernameNotFound ставил
-- status=skipped навсегда: 273 живых контакта сожжено (в т.ч. +60 за 25.08).
--
-- Правильный порядок (НЕ нарушать):
--   1) деплой воркеров с фиксом логики (origin/Sergey → сергей-ветка);
--   2) запустить этот скрипт — он ПОСЛЕДОВАТЕЛЬНО: паркует аккаунт, затем
--      возвращает сожжённые контакты в pending;
--   3) только после пункта 2 аккаунт не будет повторно жечь базу.
--
-- Скрипт идемпотентен: повторный запуск ничего не меняет (парковка перезаписана,
-- контактов со skip_reason='юзернейм не найден в Telegram' в skipped больше нет).
--
-- НЕ выполнять на test/main, НЕ деплоить без явного «давай» оператора.

BEGIN;

-- 1) Паркуем аккаунт на сутки — страховка от повторного сожжения, если воркер
--    ещё работает по старому коду (фикс логики не доехал до пула).
UPDATE tg_outreach_accounts
SET cooldown_until = now() + interval '24 hours',
    updated_at = now()
WHERE id = '65447664-4515-48af-b149-e41bdadf125f';  -- session_name=254360278

-- 2) Возвращаем в pending все контакты TG_VBI, сожжённые ложным
--    «юзернейм не найден». Остальные причины skip (Premium, «уже писали»)
--    НЕ трогаем — это настоящие терминальные причины.
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
  AND cb.campaign_id = '978f79cb-6ccd-4b4c-9b6f-aa23cb4af614'  -- TG_VBI
  AND c.status = 'skipped'
  AND c.skip_reason = 'юзернейм не найден в Telegram';

-- Итог для лога: сколько вернули и сколько осталось skipped по причинам.
SELECT c.status, c.skip_reason, count(*) AS n
FROM tg_outreach_base_contacts c
JOIN tg_outreach_campaign_bases cb ON cb.base_id = c.base_id
WHERE cb.campaign_id = '978f79cb-6ccd-4b4c-9b6f-aa23cb4af614'
GROUP BY c.status, c.skip_reason
ORDER BY c.status, c.skip_reason;

COMMIT;