-- Кампания «Рассылки» может быть привязана к тегу ящиков целиком.
--
-- Раньше тег в окне выбора ящиков был лишь быстрым способом отметить его
-- ящики: пул кампании хранил только сами ящики. Ящики, добавленные под тег
-- позже, в идущую кампанию не попадали — приходилось ставить её на паузу и
-- заново выбирать тег. Теперь связь «кампания — тег» запоминается, и новые
-- ящики тега сами доливаются в идущие кампании (lib/sender/campaignTags.ts).
create table if not exists public.sender_campaign_tags (
  campaign_id uuid not null references public.sender_campaigns(id) on delete cascade,
  tag_id uuid not null references public.sender_mailbox_tags(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (campaign_id, tag_id)
);

-- Под выборку «какие кампании привязаны к этому тегу».
create index if not exists idx_sender_campaign_tags_tag
  on public.sender_campaign_tags (tag_id);

-- Как и остальные sender_*: только service_role, люди ходят через
-- /api/tools/sender/** с проверкой доступа.
alter table public.sender_campaign_tags enable row level security;

grant all on public.sender_campaign_tags to service_role;

comment on table public.sender_campaign_tags is
  'Tags of mailboxes attached to a sender campaign as a whole: mailboxes added to the tag later join the live campaign.';
