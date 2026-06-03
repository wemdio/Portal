-- Instantly activity feed (webhook-sourced) — источник партнёрского API.
--
-- Зачем: заказчик (Mailganer, аккаунт account-2) хочет pull-API «какие адреса
-- активны» — кто ОТВЕТИЛ и кто ОТКРЫЛ письмо, с временем. В polling-API
-- Instantly открытия отдаются ТОЛЬКО агрегатом (open_count). Per-email открытия
-- и ответы достаются лишь через ВЕБХУКИ (push). Поэтому подписываемся на
-- email_opened / reply_received, складываем каждое событие сюда, а
-- GET /api/partner/activity читает из этой таблицы → ноль обращений к Instantly
-- на чтении и ноль polling-нагрузки на сборе (push не считается в rate-limit).
--
-- Forward-only: бэкфилла нет (историю открытий per-email Instantly не отдаёт,
-- а /emails для ответов мы намеренно не трогаем — общий workspace rate limit).
--
-- Идемпотентность: Instantly ретраит вебхук при не-2xx, поэтому upsert по
-- dedup_key (event_id если он есть, иначе account+kind+email+время).

CREATE TABLE IF NOT EXISTS public.instantly_activity_events (
  id                   bigserial   PRIMARY KEY,
  instantly_account_id text        NOT NULL DEFAULT 'main',
  event_type           text        NOT NULL,            -- нормализовано: 'opened' | 'replied'
  lead_email           text        NOT NULL,
  campaign_id          text,
  occurred_at          timestamptz NOT NULL,            -- время события (хранится в UTC)
  dedup_key            text        NOT NULL,
  raw                  jsonb,                            -- исходный payload вебхука (для аудита)
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Дедуп ретраев вебхука.
CREATE UNIQUE INDEX IF NOT EXISTS uq_instantly_activity_dedup
  ON public.instantly_activity_events (dedup_key);

-- Партнёрский запрос «события за день по аккаунту»: фильтр account + occurred_at.
CREATE INDEX IF NOT EXISTS ix_instantly_activity_account_time
  ON public.instantly_activity_events (instantly_account_id, occurred_at);

COMMENT ON TABLE public.instantly_activity_events IS
  'События активности лидов из Instantly-вебхуков (opened/replied). Источник партнёрского API /api/partner/activity. Forward-only, без бэкфилла.';
COMMENT ON COLUMN public.instantly_activity_events.event_type IS
  'Нормализованный тип: opened (email_opened) | replied (reply_received).';
COMMENT ON COLUMN public.instantly_activity_events.dedup_key IS
  'Ключ дедупа ретраев: id:<account>:<event_id> если есть, иначе <account>:<kind>:<email>:<occurred_at>.';

-- Доступ только service-role (вебхук-ресивер и партнёрский API ходят под
-- service-role, который обходит RLS). Включаем RLS без политик → anon/auth
-- через PostgREST к таблице не достучатся.
ALTER TABLE public.instantly_activity_events ENABLE ROW LEVEL SECURITY;

-- Грант: таблицу пишет/читает только service-role (сервер + воркеры). authenticated
-- не выдаём — таблица служебная, клиент к ней напрямую не обращается.
GRANT ALL ON public.instantly_activity_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.instantly_activity_events_id_seq TO service_role;
