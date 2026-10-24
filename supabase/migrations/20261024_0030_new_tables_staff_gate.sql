-- Две таблицы, созданные после закрытия доступа 15.10, снова открыты любому вошедшему.
--
-- УТЕЧКА. 20261022_0040 дала tg_outreach_reports политики «to authenticated using
-- (true)» на чтение и «with check (true)» на запись, 20261022_0060 — то же на чтение
-- li_campaign_accounts. Регистрация в GoTrue открыта, поэтому любой человек с
-- публичным anon-ключом получает клиентский JWT и через /rest/v1 читает отчёты
-- TG-аутрича (контакты, диалоги, передачи лидов по всем кампаниям) и может писать в
-- них. Шлюз 20261015_0033 строился по таблицам, существовавшим на момент миграции, и
-- новые таблицы не накрыл.
--
-- ИСПРАВЛЕНИЕ. Тот же ограничивающий шлюз, что в 20261015_0033: RESTRICTIVE-политика
-- «только внутренние сотрудники» на все команды для anon и authenticated. Она
-- складывается по И с существующими разрешающими политиками, поэтому у сотрудников
-- ничего не меняется (экран отчёта TG-аутрича читает и пишет таблицу JWT сотрудника),
-- а клиенты, демо и самостоятельно зарегистрированные аккаунты теряют доступ.
-- service_role (портал, воркеры) обходит RLS и не затронут.
--
-- ЗАВИСИТ ОТ public.is_internal_staff() из 20261015_0030_profiles_read_lockdown.sql.

drop policy if exists tg_outreach_reports_staff_gate on public.tg_outreach_reports;
create policy tg_outreach_reports_staff_gate on public.tg_outreach_reports
  as restrictive for all to anon, authenticated
  using ((select public.is_internal_staff()))
  with check ((select public.is_internal_staff()));

drop policy if exists li_campaign_accounts_staff_gate on public.li_campaign_accounts;
create policy li_campaign_accounts_staff_gate on public.li_campaign_accounts
  as restrictive for all to anon, authenticated
  using ((select public.is_internal_staff()))
  with check ((select public.is_internal_staff()));

revoke all on public.tg_outreach_reports from anon;
revoke all on public.li_campaign_accounts from anon;
