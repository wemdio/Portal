-- Разбивка отбоев за день для блока «Нагрузка почт» (15.10.2026): по ящикам,
-- кампаниям, шагам цепочки и доменам получателей. Причины отказа в событиях
-- Instantly нет: считается только то, что уже сохранено в instantly_activity_events.
CREATE OR REPLACE FUNCTION public.instantly_bounces_breakdown(p_day date)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = public
AS $$
  WITH b AS (
    SELECT raw->>'email_account' AS mailbox,
           COALESCE(raw->>'campaign_name', campaign_id, '—') AS campaign,
           COALESCE(raw->>'step', '—') AS step,
           lower(split_part(COALESCE(lead_email, raw->>'email', ''), '@', 2)) AS domain
    FROM public.instantly_activity_events
    WHERE instantly_account_id = 'main'
      AND event_type = 'bounced'
      AND occurred_at >= p_day::timestamp AT TIME ZONE 'UTC'
      AND occurred_at < (p_day + 1)::timestamp AT TIME ZONE 'UTC'
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM b),
    'mailboxes', COALESCE((SELECT jsonb_agg(x) FROM (SELECT mailbox AS key, count(*) AS bounced FROM b GROUP BY 1 ORDER BY 2 DESC LIMIT 10) x), '[]'::jsonb),
    'campaigns', COALESCE((SELECT jsonb_agg(x) FROM (SELECT campaign AS key, count(*) AS bounced FROM b GROUP BY 1 ORDER BY 2 DESC LIMIT 10) x), '[]'::jsonb),
    'steps', COALESCE((SELECT jsonb_agg(x) FROM (SELECT step AS key, count(*) AS bounced FROM b GROUP BY 1 ORDER BY 2 DESC LIMIT 10) x), '[]'::jsonb),
    'domains', COALESCE((SELECT jsonb_agg(x) FROM (SELECT domain AS key, count(*) AS bounced FROM b WHERE domain <> '' GROUP BY 1 ORDER BY 2 DESC LIMIT 10) x), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.instantly_bounces_breakdown(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.instantly_bounces_breakdown(date) TO service_role;
