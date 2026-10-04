-- «Рассылка»: кампания может быть привязана к проекту портала.
--
-- Необязательно: автоаутрич и внутренние рассылки ни к какому клиентскому
-- проекту не относятся. Проект удалили — привязка обнуляется, кампания
-- остаётся.
alter table public.sender_campaigns
  add column if not exists project_id uuid references public.projects(id) on delete set null;

-- Индекс нужен и для выборки «кампании проекта», и для обнуления при удалении
-- проекта без полного прохода по рассылкам.
create index if not exists sender_campaigns_project_id_idx
  on public.sender_campaigns (project_id);

comment on column public.sender_campaigns.project_id is
  'Optional portal project this sender campaign belongs to; set null when the project is deleted.';
