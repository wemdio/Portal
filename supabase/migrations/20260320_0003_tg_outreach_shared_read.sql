-- Allow all authenticated users to read TG Outreach campaigns, accounts, proxies.
-- Write operations remain restricted to the owner.

-- Campaigns: all authenticated can read
drop policy if exists tg_outreach_campaigns_select_all on public.tg_outreach_campaigns;
create policy tg_outreach_campaigns_select_all on public.tg_outreach_campaigns
  for select to authenticated using (true);

-- Campaign-scoped tables: all authenticated can read
drop policy if exists tg_outreach_accounts_select_all on public.tg_outreach_accounts;
create policy tg_outreach_accounts_select_all on public.tg_outreach_accounts
  for select to authenticated using (true);

drop policy if exists tg_outreach_proxies_select_all on public.tg_outreach_proxies;
create policy tg_outreach_proxies_select_all on public.tg_outreach_proxies
  for select to authenticated using (true);

drop policy if exists tg_outreach_dialogs_select_all on public.tg_outreach_dialogs;
create policy tg_outreach_dialogs_select_all on public.tg_outreach_dialogs
  for select to authenticated using (true);

drop policy if exists tg_outreach_processed_select_all on public.tg_outreach_processed;
create policy tg_outreach_processed_select_all on public.tg_outreach_processed
  for select to authenticated using (true);

drop policy if exists tg_outreach_logs_select_all on public.tg_outreach_logs;
create policy tg_outreach_logs_select_all on public.tg_outreach_logs
  for select to authenticated using (true);

drop policy if exists tg_outreach_jobs_select_all on public.tg_outreach_jobs;
create policy tg_outreach_jobs_select_all on public.tg_outreach_jobs
  for select to authenticated using (true);

-- Pool tables: all authenticated can read
drop policy if exists tg_pool_accounts_select_all on public.tg_pool_accounts;
create policy tg_pool_accounts_select_all on public.tg_pool_accounts
  for select to authenticated using (true);

drop policy if exists tg_pool_proxies_select_all on public.tg_pool_proxies;
create policy tg_pool_proxies_select_all on public.tg_pool_proxies
  for select to authenticated using (true);

drop policy if exists tg_pool_tags_select_all on public.tg_pool_tags;
create policy tg_pool_tags_select_all on public.tg_pool_tags
  for select to authenticated using (true);

-- Junction tables: all authenticated can read
drop policy if exists tg_pool_account_tags_select_all on public.tg_pool_account_tags;
create policy tg_pool_account_tags_select_all on public.tg_pool_account_tags
  for select to authenticated using (true);

drop policy if exists tg_pool_proxy_tags_select_all on public.tg_pool_proxy_tags;
create policy tg_pool_proxy_tags_select_all on public.tg_pool_proxy_tags
  for select to authenticated using (true);
