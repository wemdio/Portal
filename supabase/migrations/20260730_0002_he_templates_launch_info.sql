-- Хранилище результата «Отправить в запуск» (Hypothesis Engine).
-- Кнопка на шаге 5 создаёт кампанию Instantly на паузе из шаблона и базы;
-- сюда пишем сведения о запуске (campaign_id, leads, preset, предупреждения),
-- чтобы не допустить повторный запуск того же шаблона без force.

alter table public.he_templates
  add column if not exists launch_info jsonb;

comment on column public.he_templates.launch_info is
  'Сведения о запуске в Instantly: {campaign_id, campaign_url, leads_count, preset_id, created_at, warnings}. NULL — шаблон ещё не уходил в запуск.';
