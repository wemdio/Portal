-- Track which configured Instantly workspace each client preset/resource uses.
-- Existing rows belong to the legacy main workspace.

alter table public.client_campaign_presets
  add column if not exists instantly_account_id text not null default 'main';

alter table public.instantly_campaign_catalog
  add column if not exists instantly_account_id text not null default 'main';

alter table public.client_campaign_launches
  add column if not exists instantly_account_id text not null default 'main';

alter table public.client_instantly_access
  add column if not exists instantly_account_id text not null default 'main';

create index if not exists idx_client_campaign_presets_instantly_account
  on public.client_campaign_presets(instantly_account_id);

create index if not exists idx_instantly_campaign_catalog_instantly_account
  on public.instantly_campaign_catalog(instantly_account_id);

create index if not exists idx_client_campaign_launches_instantly_account
  on public.client_campaign_launches(instantly_account_id);

create index if not exists idx_client_instantly_access_account_resource
  on public.client_instantly_access(instantly_account_id, resource_type, resource_id);
