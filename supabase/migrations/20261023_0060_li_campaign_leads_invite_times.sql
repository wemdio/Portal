-- LinkedIn Outreach: когда отправлен инвайт, принят и пришёл ответ — для «отправлено / принято сегодня»
-- и статистики за выбранный период. Старые строки остаются без времени: для них период
-- считается по updated_at (приближение), точные времена пишутся только для новых событий.
alter table public.li_campaign_leads
  add column if not exists invite_sent_at timestamptz,
  add column if not exists invite_accepted_at timestamptz,
  add column if not exists replied_at timestamptz;
