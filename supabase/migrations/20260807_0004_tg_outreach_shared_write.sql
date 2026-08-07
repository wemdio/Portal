-- TG Аутрич: запись в кампанию доступна любому сотруднику, а не только автору.
--
-- 20260320_0003 открыла чтение всем («Write operations remain restricted to the
-- owner»), и с тех пор чужую кампанию можно было смотреть, но не править.
-- На практике инструмент командный: аккаунты заливает один специалист, чистит
-- другой, диалоги разбирает третий.
--
-- Отказ был молчаливым и оттого особенно дорогим. DELETE под RLS не находит
-- строк — PostgREST отвечает 204 без ошибки, роут возвращает {ok:true}, UI
-- перезагружает список, и удалённая на вид строка остаётся на месте. Никакого
-- сообщения об отказе пользователь не видел.
--
-- Заливка аккаунтов при этом работала: /accounts/bulk-files ходит под
-- supabaseAdmin (service_role) и RLS не подчиняется, в отличие от остальных
-- роутов. Отсюда и наблюдаемая асимметрия «залить могу, удалить нет».
--
-- Тот же вывод уже сделан для прогрева в 20260804_0004: «прогрев — командная
-- операция, специалист должен уметь греть аккаунты кампании независимо от того,
-- кто её завёл». Таблицы `bases`, `base_contacts`, `campaign_bases` и
-- `warmup_runs` заведены сразу с `_all`-политиками. Здесь то же соглашение
-- распространяется на таблицы, оставшиеся с 20260310.
--
-- Что НЕ меняется:
--   * `tg_outreach_campaigns_insert_own` — единственная владельческая политика,
--     которую нужно сохранить: она проставляет автора при создании. Без неё в
--     user_id можно записать кого угодно, и колонка перестанет отвечать на
--     вопрос «кто завёл кампанию».
--   * `tg_outreach_jobs_insert_own` — строка джобы фиксирует, кто нажал
--     «Запустить»; роут подставляет id вызывающего, так что политика и так не
--     мешает чужой кампании.
--   * SELECT-политики — не трогаем, чтобы не задеть то, что уже работает.
--   * Воркер ходит под service_role и RLS не подчиняется — на него эти
--     политики не влияют вовсе.
--
-- Гранты уже есть: authenticated=arwdDxt на всех перечисленных таблицах
-- (проверено на бою). Здесь только политики.

-- Кампании: править и удалять может любой сотрудник, автор фиксируется при
-- создании и дальше не ограничивает.
drop policy if exists tg_outreach_campaigns_update_own on public.tg_outreach_campaigns;
create policy tg_outreach_campaigns_update_all on public.tg_outreach_campaigns
  for update to authenticated using (true) with check (true);

drop policy if exists tg_outreach_campaigns_delete_own on public.tg_outreach_campaigns;
create policy tg_outreach_campaigns_delete_all on public.tg_outreach_campaigns
  for delete to authenticated using (true);

-- Аккаунты кампании — вкладка «Аккаунты».
drop policy if exists tg_outreach_accounts_insert_own on public.tg_outreach_accounts;
create policy tg_outreach_accounts_insert_all on public.tg_outreach_accounts
  for insert to authenticated with check (true);

drop policy if exists tg_outreach_accounts_update_own on public.tg_outreach_accounts;
create policy tg_outreach_accounts_update_all on public.tg_outreach_accounts
  for update to authenticated using (true) with check (true);

drop policy if exists tg_outreach_accounts_delete_own on public.tg_outreach_accounts;
create policy tg_outreach_accounts_delete_all on public.tg_outreach_accounts
  for delete to authenticated using (true);

-- Прокси кампании — вкладка «Прокси».
drop policy if exists tg_outreach_proxies_insert_own on public.tg_outreach_proxies;
create policy tg_outreach_proxies_insert_all on public.tg_outreach_proxies
  for insert to authenticated with check (true);

drop policy if exists tg_outreach_proxies_update_own on public.tg_outreach_proxies;
create policy tg_outreach_proxies_update_all on public.tg_outreach_proxies
  for update to authenticated using (true) with check (true);

drop policy if exists tg_outreach_proxies_delete_own on public.tg_outreach_proxies;
create policy tg_outreach_proxies_delete_all on public.tg_outreach_proxies
  for delete to authenticated using (true);

-- Диалоги — вкладка «Диалоги»: статус лида, разрешение отправки, удаление.
drop policy if exists tg_outreach_dialogs_insert_own on public.tg_outreach_dialogs;
create policy tg_outreach_dialogs_insert_all on public.tg_outreach_dialogs
  for insert to authenticated with check (true);

drop policy if exists tg_outreach_dialogs_update_own on public.tg_outreach_dialogs;
create policy tg_outreach_dialogs_update_all on public.tg_outreach_dialogs
  for update to authenticated using (true) with check (true);

drop policy if exists tg_outreach_dialogs_delete_own on public.tg_outreach_dialogs;
create policy tg_outreach_dialogs_delete_all on public.tg_outreach_dialogs
  for delete to authenticated using (true);

-- Обработанные — вкладка «Обработанные»: ручное добавление и снятие.
drop policy if exists tg_outreach_processed_insert_own on public.tg_outreach_processed;
create policy tg_outreach_processed_insert_all on public.tg_outreach_processed
  for insert to authenticated with check (true);

drop policy if exists tg_outreach_processed_delete_own on public.tg_outreach_processed;
create policy tg_outreach_processed_delete_all on public.tg_outreach_processed
  for delete to authenticated using (true);

-- История автосмены прокси: строку пишет и UI при ручной смене.
drop policy if exists tg_outreach_proxy_swaps_insert_own on public.tg_outreach_proxy_swaps;
create policy tg_outreach_proxy_swaps_insert_all on public.tg_outreach_proxy_swaps
  for insert to authenticated with check (true);
