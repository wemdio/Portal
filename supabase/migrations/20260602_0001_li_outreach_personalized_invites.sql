-- LinkedIn Outreach: персонализированные инвайты из CSV.
--
-- Менеджер заранее готовит для каждого лида свой текст инвайта (например, AI
-- генерит индивидуальное приветствие со ссылкой на конкретный продукт лида) и
-- загружает CSV вида «LinkedIn ID, Invite». Чтобы воркер мог использовать эту
-- per-lead колонку вместо единого шаблона из step.message, нам нужны три поля:
--
--  * li_leads.invite_text          — собственно текст инвайта для конкретного
--                                    лида. NULL означает «нет своего текста,
--                                    используем шаблон кампании».
--  * li_lead_lists.has_custom_invites
--                                  — флаг на списке лидов, выставляется при
--                                    импорте через /leads/import-with-invites.
--                                    Используется UI'ём, чтобы понять, что у
--                                    выбранного списка есть колонка с инвайтами
--                                    и можно показать тумблер на шаге 1 в
--                                    редакторе кампании.
--  * li_campaigns.use_custom_invites
--                                  — собственно тумблер на кампании. Когда
--                                    включён, runner берёт invite_text вместо
--                                    шаблона. Когда выключен — поведение как
--                                    раньше (шаблон + AI).

alter table public.li_leads
  add column if not exists invite_text text;

alter table public.li_lead_lists
  add column if not exists has_custom_invites boolean not null default false;

alter table public.li_campaigns
  add column if not exists use_custom_invites boolean not null default false;

comment on column public.li_leads.invite_text is
  'Персонализированный текст инвайта для этого лида (импорт через CSV с инвайтами). NULL — нет своего текста.';
comment on column public.li_lead_lists.has_custom_invites is
  'Список собран через импорт CSV с персонализированными инвайтами (колонка invite_text заполнена у его лидов).';
comment on column public.li_campaigns.use_custom_invites is
  'Использовать персонализированный invite_text лидов вместо общего шаблона step.message. Доступно только если у списка has_custom_invites=true.';
