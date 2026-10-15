-- Оценка здоровья ящиков «Рассылки» (15.10.2026): сколько писем ушло, сколько
-- вернулось отбойниками и сколько отправок упало с ошибкой за последние дни.
-- Сама оценка 0–100 считается в коде (lib/sender/mailboxHealth.ts).
CREATE OR REPLACE FUNCTION public.sender_mailbox_health(p_ids uuid[], p_days integer DEFAULT 14)
RETURNS TABLE (mailbox_id uuid, sent bigint, bounced bigint, failed bigint)
LANGUAGE sql
STABLE
SET search_path = public
SET statement_timeout = '30s'
AS $$
  WITH since AS (SELECT now() - make_interval(days => greatest(p_days, 1)) AS t),
  msg AS (
    SELECT m.mailbox_id,
           count(*) FILTER (WHERE m.status = 'sent') AS sent,
           count(*) FILTER (WHERE m.status = 'failed') AS failed
    FROM public.sender_messages m, since
    WHERE m.mailbox_id = ANY (p_ids)
      AND COALESCE(m.sent_at, m.created_at) >= since.t
    GROUP BY m.mailbox_id
  ),
  bnc AS (
    SELECT r.mailbox_id, count(*) AS bounced
    FROM public.sender_replies r, since
    WHERE r.kind = 'bounce'
      AND r.mailbox_id = ANY (p_ids)
      AND COALESCE(r.received_at, r.created_at) >= since.t
    GROUP BY r.mailbox_id
  )
  SELECT i AS mailbox_id,
         COALESCE(msg.sent, 0), COALESCE(bnc.bounced, 0), COALESCE(msg.failed, 0)
  FROM unnest(p_ids) AS i
  LEFT JOIN msg ON msg.mailbox_id = i
  LEFT JOIN bnc ON bnc.mailbox_id = i;
$$;

REVOKE ALL ON FUNCTION public.sender_mailbox_health(uuid[], integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.sender_mailbox_health(uuid[], integer) TO service_role;
