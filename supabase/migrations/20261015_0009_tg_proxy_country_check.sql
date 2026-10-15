-- Страна и итог последней проверки прокси TG-аутрича (15.10.2026): по ним
-- «Неопределённые» раскладываются по спискам «Авто · Страна» / «Не работают»,
-- а в выпадающем списке прокси у аккаунта подписана страна.
alter table public.tg_outreach_proxies add column if not exists country_code text;
alter table public.tg_outreach_proxies add column if not exists check_status text;
alter table public.tg_outreach_proxies add column if not exists checked_at timestamptz;
