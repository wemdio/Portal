-- Здоровье Sender: один окончательный отбой на отправленное им письмо.
-- В ящике есть также отчёты от Instantly/других отправителей и уведомления
-- о задержках. Их нельзя делить на число писем только нашего Sender.
CREATE OR REPLACE FUNCTION public.sender_mailbox_health(p_ids uuid[], p_days integer DEFAULT 14)
RETURNS TABLE (mailbox_id uuid, sent bigint, bounced bigint, failed bigint)
LANGUAGE sql
STABLE
SET search_path = public
SET statement_timeout = '30s'
AS $$
  WITH since AS (SELECT now() - make_interval(days => greatest(p_days, 1)) AS t),
  reports AS MATERIALIZED (
    SELECT r.mailbox_id,
           r.in_reply_to,
           -- Google DSN сохраняет X-Original-Message-ID; другие серверы
           -- могут вложить исходные заголовки с обычным Message-ID.
           COALESCE(
             (regexp_match(r.body, '(?:^|\n)[[:blank:]]*X-Original-Message-ID:[[:space:]]*(<[^>[:space:]]+>)', 'i'))[1],
             (regexp_match(r.body, '(?:^|\n)[[:blank:]]*Original-Message-ID:[[:space:]]*(<[^>[:space:]]+>)', 'i'))[1],
             (regexp_match(r.body, '(?:^|\n)[[:blank:]]*Message-ID:[[:space:]]*(<[^>[:space:]]+>)', 'i'))[1]
           ) AS original_message_id
    FROM public.sender_replies r, since
    WHERE r.kind = 'bounce'
      AND r.mailbox_id = ANY (p_ids)
      AND COALESCE(r.received_at, r.created_at) >= since.t
      -- 4.x может быть окончательным отказом после исчерпания повторов.
      -- Поэтому исключаем именно Action: delayed, а не все временные коды.
      AND COALESCE(r.body, '') !~* '(?:^|\n)[[:blank:]]*Action:[[:blank:]]*delayed\M'
      AND COALESCE(r.subject, '') !~* 'Delivery Status Notification[[:blank:]]*\(Delay\)'
  ),
  report_keys AS (
    SELECT mailbox_id, in_reply_to AS message_id FROM reports WHERE in_reply_to IS NOT NULL
    UNION ALL
    SELECT mailbox_id, original_message_id FROM reports WHERE original_message_id IS NOT NULL
  ),
  recent_messages AS MATERIALIZED (
    SELECT m.id, m.mailbox_id, m.message_id, m.status
    FROM public.sender_messages m, since
    WHERE m.mailbox_id = ANY (p_ids)
      AND COALESCE(m.sent_at, m.created_at) >= since.t
  ),
  msg AS (
    SELECT m.mailbox_id,
           count(*) FILTER (WHERE m.status = 'sent') AS sent,
           count(*) FILTER (WHERE m.status = 'failed') AS failed
    FROM recent_messages m
    GROUP BY m.mailbox_id
  ),
  bnc AS (
    SELECT m.mailbox_id, count(DISTINCT m.id) AS bounced
    FROM recent_messages m
    JOIN report_keys r ON r.mailbox_id = m.mailbox_id AND r.message_id = m.message_id
    WHERE m.status = 'sent'
    GROUP BY m.mailbox_id
  )
  SELECT i AS mailbox_id,
         COALESCE(msg.sent, 0), COALESCE(bnc.bounced, 0), COALESCE(msg.failed, 0)
  FROM unnest(p_ids) AS i
  LEFT JOIN msg ON msg.mailbox_id = i
  LEFT JOIN bnc ON bnc.mailbox_id = i;
$$;

REVOKE ALL ON FUNCTION public.sender_mailbox_health(uuid[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sender_mailbox_health(uuid[], integer) TO service_role;
