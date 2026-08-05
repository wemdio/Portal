-- Рынок профиля: 'ru' (дефолт) или 'eng' (ENG-кабинет app.outreachos.xyz).
-- Читается middleware (host/market-гейты ENG-разделения) и /api/client/portal-mode
-- (видимость ENG-пункта навигации). Проставляется триггером handle_new_user из
-- raw_user_meta_data->>'market' (signup на ENG-хосте шлёт market='eng',
-- см. app/src/app/api/signup/route.ts) плюс backstop-update'ом того же роута.

alter table public.profiles
  add column if not exists market text not null default 'ru';

alter table public.profiles
  drop constraint if exists profiles_market_check;

alter table public.profiles
  add constraint profiles_market_check
  check (market in ('ru','eng'));

-- Пересоздание по образцу ПОСЛЕДНЕЙ версии из 20260730_0001_harden_team_data_acl.sql:
-- роль всегда 'client' (raw_user_meta_data->>'role' не доверяем), узкий
-- search_path, revoke'ы ниже. Добавлено только копирование market.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_full_name text;
  v_market text;
begin
  v_full_name := nullif(new.raw_user_meta_data->>'full_name', '');

  -- market приходит из caller-controlled metadata, но это не привилегия
  -- (лишь выбор кабинета), а check-констрейнт выше ограничивает значения.
  -- Невалид/пусто → 'ru': иначе insert упал бы на констрейнте и exception-
  -- ветка ниже молча проглотила бы создание профиля.
  v_market := nullif(new.raw_user_meta_data->>'market', '');
  if v_market is null or v_market not in ('ru','eng') then
    v_market := 'ru';
  end if;

  insert into public.profiles (id, email, full_name, role, market)
  values (
    new.id,
    new.email,
    coalesce(v_full_name, split_part(new.email, '@', 1)),
    'client',
    v_market
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = excluded.full_name;
    -- market, как и role, при конфликте НЕ перезаписываем: ручная разметка
    -- админа важнее метаданных повторной вставки.

  return new;
exception when others then
  -- Preserve existing auth behavior: profile failures must not block auth.users.
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon;
revoke all on function public.handle_new_user() from authenticated;
