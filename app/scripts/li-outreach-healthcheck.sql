-- LinkedIn Outreach — еженедельный health-check реального поведения в проде.
-- Каждый блок печатает violations (0 = инвариант держится). Запуск:
--   cat app/scripts/li-outreach-healthcheck.sql | docker exec -i main-postgres psql -U postgres -d postgres
-- Источник инвариантов — фиксы за неделю (welcome/startChat, dedup, parseMessageTemplate,
-- normalizeModel/Requesty, stop_on_reply, account ownership).

\echo '=== 1. Сырые плейсхолдеры в ОТПРАВЛЕННЫХ сообщениях (должно быть 0) ==='
-- Фикс parseMessageTemplate + startChat: ни одно отправленное (assistant) сообщение
-- не должно содержать {{...}}.
SELECT COUNT(*) AS raw_placeholder_msgs
FROM li_leads l
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(l.conversation_history, '[]'::jsonb)) AS m
WHERE m->>'role' = 'assistant' AND (m->>'content') ~ '\{\{.*\}\}';

\echo '=== 2. Дублирующиеся сообщения одному лиду (должно быть 0) ==='
-- Фикс startChat-двойной-отправки + удаление welcome-dedup: одинаковый assistant-текст
-- не должен встречаться лиду дважды.
SELECT COUNT(*) AS leads_with_dup_message FROM (
  SELECT l.id, m->>'content' AS content, COUNT(*) AS cnt
  FROM li_leads l
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(l.conversation_history, '[]'::jsonb)) AS m
  WHERE m->>'role' = 'assistant' AND length(m->>'content') > 20
  GROUP BY l.id, m->>'content'
  HAVING COUNT(*) > 1
) d;

\echo '=== 3. Ответившие лиды, не остановленные в stop_on_reply кампаниях (должно быть 0) ==='
-- Фикс stop_on_reply: если лид ответил (user_replied) и у кампании stop_on_reply=true,
-- он должен быть completed, а не висеть в очереди на новый фоллоу-ап.
SELECT COUNT(*) AS replied_but_not_stopped
FROM li_campaign_leads cl
JOIN li_campaigns c ON c.id = cl.campaign_id
WHERE cl.user_replied = true
  AND c.stop_on_reply = true
  AND cl.status NOT IN ('completed', 'error', 'skipped');

\echo '=== 4. Сейчас connected без welcome в welcome-кампаниях (ожидаем 0) ==='
-- Фикс welcome через webhook startChat. Смотрим только лидов, КОТОРЫЕ СЕЙЧАС
-- connected (приняли инвайт, ещё не получили message-шаг): у них welcome должен
-- был уйти. Лиды в статусе messaged/replied НЕ считаем — у них welcome мог быть
-- пропущен в pre-fix эпоху (Katya/Joshua), это исторический хвост, не регрессия.
-- Только running-кампании: в остановленных connected-без-welcome — замёрзший
-- pre-fix хвост (приняли до фикса, кампанию остановили), это не активный баг.
SELECT COUNT(*) AS connected_without_welcome
FROM li_campaign_leads cl
JOIN li_campaigns c ON c.id = cl.campaign_id
JOIN li_leads l ON l.id = cl.lead_id
WHERE cl.invite_accepted = true
  AND c.status = 'running'
  AND c.welcome_message IS NOT NULL AND c.welcome_message <> ''
  AND cl.welcome_sent_at IS NULL
  AND l.status = 'connected';

\echo '=== 5. GPT-персонализация за 7 дней: ok / no-op / error ==='
-- Фикс Requesty endpoint + normalizeModel. gpt_ok должен сильно превышать noop+error.
-- Высокий noop/error => GPT снова молча падает (битый ключ/модель/сеть).
SELECT
  COUNT(*) FILTER (WHERE message ILIKE '%GPT персонализировал%')                  AS gpt_ok,
  COUNT(*) FILTER (WHERE message ILIKE '%GPT вернул шаблон без изменений%')        AS gpt_noop,
  COUNT(*) FILTER (WHERE message ILIKE '%Ошибка GPT%')                            AS gpt_error
FROM li_campaign_logs
WHERE created_at > NOW() - INTERVAL '7 days';

\echo '=== 6. Bare-модели без provider/ (должно быть 0) ==='
-- Фикс normalizeModel + миграция: Requesty принимает только provider/model.
SELECT
  (SELECT COUNT(*) FROM li_campaigns WHERE ai_model   IS NOT NULL AND ai_model   <> '' AND ai_model   NOT LIKE '%/%') AS bare_in_campaigns,
  (SELECT COUNT(*) FROM li_settings  WHERE openai_model IS NOT NULL AND openai_model <> '' AND openai_model NOT LIKE '%/%') AS bare_in_settings;

\echo '=== 7. Остаточные BYOK OpenAI-ключи в li_settings (должно быть 0) ==='
-- Миграция 20260525_0003: per-user ключи вычищены, всё идёт через env Requesty.
SELECT COUNT(*) AS leftover_byok_keys
FROM li_settings
WHERE openai_api_key IS NOT NULL AND openai_api_key <> '';

\echo '=== 8. Свежие реальные ошибки за 24ч (не "дневной лимит") — контекст, не fail ==='
-- Ожидаем только invalid_recipient (битые профили из импорта). Любое другое — разбирать.
SELECT COALESCE(LEFT(message, 60), '—') AS error_kind, COUNT(*)
FROM li_campaign_logs
WHERE created_at > NOW() - INTERVAL '24 hours'
  AND level IN ('warning', 'error')
  AND message NOT ILIKE '%Дневной лимит%'
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
