-- Operational Instantly DB only. Ответы, которые квалификатор не берёт, но
-- «Персонализированные ответы» должны показывать (07.10.2026):
--   1. instantly_reply_inbox — входящие наших кампаний «N. Polza_…» (сборщик
--      ответов видит их на тех же страницах и сохраняет без вердикта) и
--      история кампаний, привязанных к проекту позже первых ответов.
--      Раньше экран читал их из Instantly при каждом открытии и получал отказ
--      общего лимита чтения писем — 2177 отказов на 1123 чтения за 3 дня.
--   2. instantly_reply_inbox_backfill — где остановилась фоновая догрузка
--      истории кампании (одна страница за проход, по низкому приоритету).
BEGIN;

CREATE TABLE IF NOT EXISTS public.instantly_reply_inbox (
  email_id text PRIMARY KEY CHECK (length(email_id) BETWEEN 1 AND 500),
  account_id text NOT NULL DEFAULT 'main',
  campaign_id text NOT NULL,
  thread_id text,
  lead_email text NOT NULL,
  eaccount text,
  subject text,
  body_preview text,
  reply_timestamp timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS instantly_reply_inbox_campaign_ts_idx
  ON public.instantly_reply_inbox (campaign_id, reply_timestamp DESC);

ALTER TABLE public.instantly_reply_inbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.instantly_reply_inbox FROM PUBLIC;

CREATE TABLE IF NOT EXISTS public.instantly_reply_inbox_backfill (
  campaign_id text PRIMARY KEY CHECK (length(campaign_id) BETWEEN 1 AND 500),
  account_id text NOT NULL DEFAULT 'main',
  cursor text,
  pages integer NOT NULL DEFAULT 0 CHECK (pages >= 0),
  saved integer NOT NULL DEFAULT 0 CHECK (saved >= 0),
  done_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.instantly_reply_inbox_backfill ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.instantly_reply_inbox_backfill FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT ALL ON TABLE public.instantly_reply_inbox TO service_role;
    GRANT ALL ON TABLE public.instantly_reply_inbox_backfill TO service_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'instantly') THEN
    GRANT ALL ON TABLE public.instantly_reply_inbox TO instantly;
    GRANT ALL ON TABLE public.instantly_reply_inbox_backfill TO instantly;
  END IF;
END;
$$;

COMMENT ON TABLE public.instantly_reply_inbox IS
  'Входящие ответы без вердикта квалификатора для «Персонализированных ответов»: наши кампании «N. Polza_…» и история кампаний до привязки к проекту. Пишут сборщик ответов и фоновая догрузка (lib/instantly/replyInbox.ts); строки только добавляются.';
COMMENT ON TABLE public.instantly_reply_inbox_backfill IS
  'Прогресс фоновой догрузки истории кампании в instantly_reply_inbox: курсор Instantly, done_at — история дочитана.';

COMMIT;
NOTIFY pgrst, 'reload schema';
