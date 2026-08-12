-- Настройки нагрузки прогрева: то, что применится к следующему запуску.
--
-- Живут у кампании, а не только в снимке прогона: оператор настраивает партию
-- один раз, а прогревов у неё за жизнь несколько. При старте прогрева объект
-- копируется в tg_outreach_warmup_runs.settings — по нему идёт конкретный
-- прогон, и перезапуск воркера должен видеть то же решение оператора.
--
-- Пустой объект по умолчанию: код добирает недостающие поля дефолтами из
-- констант, поэтому кампании, где никто ничего не настраивал, ведут себя ровно
-- как до релиза.
alter table public.tg_outreach_campaigns
  add column if not exists warmup_settings jsonb not null default '{}'::jsonb;

comment on column public.tg_outreach_campaigns.warmup_settings is
  'Настройки прогрева: mode, ramp_days, public_chats, chats_per_account, curve, per_day';
