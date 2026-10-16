-- «Прогноз» (динамический финплан) в «Расходах и доходах»: последний расчёт
-- пользователя.
--
-- 16.10.2026: цифры жили только в localStorage браузера и терялись в другом
-- браузере, на другом компьютере и после очистки. Теперь последний набор
-- переменных и ставок хранится за пользователем: закрыл портал, открыл — тот же
-- расчёт. Строка одна на пользователя, пишет и читает только роут
-- /api/expenses/forecast (service_role) под гардом раздела «Деньги».

create table if not exists public.fin_forecast_inputs (
  user_id uuid primary key references auth.users (id) on delete cascade,
  inputs jsonb not null,
  updated_at timestamptz not null default now()
);

-- Только сервер: клиентские роли сюда напрямую не ходят.
alter table public.fin_forecast_inputs enable row level security;

revoke all on table public.fin_forecast_inputs from anon, authenticated;
grant select, insert, update, delete on table public.fin_forecast_inputs to service_role;

comment on table public.fin_forecast_inputs is
  'Last «Прогноз» (dynamic financial plan) inputs per user; read/written only by /api/expenses/forecast via service_role.';
