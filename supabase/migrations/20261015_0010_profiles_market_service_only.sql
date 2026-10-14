-- Рынок профиля — только от доверенного сервера.
--
-- До этой миграции handle_new_user (20260804_0004) копировал market из
-- raw_user_meta_data. Эти метаданные задаёт САМ вызывающий: прямой
-- POST /auth/v1/signup с публичным anon-ключом и data:{market:'eng'} заводил
-- профиль role='client', market='eng' мимо /api/signup — мимо её счётчика
-- регистраций ENG (3 в час с IP) и алерта команде (аудит 14.10.2026, #2).
--
-- Теперь триггер берёт market только из raw_app_meta_data: публичный signup и
-- PUT /user его не меняют. Невалид или пусто — 'ru', как раньше.
--
-- ВАЖНО: на практике этот канал при регистрации пуст, и триггер пишет 'ru'
-- ВСЕМ новым аккаунтам. GoTrue admin createUser (v2.188 в deploy/main-db-prod)
-- вставляет auth.users с app_metadata = {provider, providers}, а переданный
-- app_metadata дописывает отдельным UPDATE уже после INSERT (adminUserCreate:
-- tx.Create(user), затем user.UpdateAppMetaData — по коду GoTrue, на живом
-- инстансе не проверялось) — AFTER INSERT триггер его не видит. Поэтому
-- передавать app_metadata.market в createUser бесполезно. ENG-аккаунт получает market='eng' ТОЛЬКО от /api/signup:
-- update профиля сервис-ролью сразу после createUser, после счётчика
-- регистраций (app/src/app/api/signup/route.ts; не лёг после повторов —
-- аккаунт удаляется, клиент регистрируется заново). raw_app_meta_data
-- триггер читает лишь для прямой вставки в auth.users сервис-ролью (SQL).
-- RU market не ставит нигде, его профили и так получали 'ru' — RU не
-- меняется.
--
-- Всё остальное в handle_new_user — тело функции 20260804_0004 байт в байт:
-- роль всегда 'client' (raw_user_meta_data->>'role' не доверяем), full_name
-- из metadata, on conflict не трогает ни role, ни market, сбой профиля не
-- блокирует auth.users, узкий search_path, те же revoke'ы. Триггер
-- on_auth_user_created не пересоздаётся: он вызывает функцию по имени.
--
-- Вторая функция — he_eng_auth_user_id_by_email (внизу): id аккаунта по
-- адресу ВХОДА (auth.users.email) для сброса пароля ENG
-- (api/auth/forgot-password/_engReset.ts). profiles.email клиент переписывает
-- сам и он не уникален, поэтому искать аккаунт по нему нельзя. Только
-- service_role; anon и authenticated отозваны.
--
-- Безопасна до выката кода и для старого кода: старый /api/signup тоже пишет
-- market='eng' backstop-update'ом, а новую функцию старый код не вызывает.
-- Идемпотентна (create or replace + revoke/grant).

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

  -- market — только из raw_app_meta_data (его пишет одна сервис-роль);
  -- caller-controlled raw_user_meta_data рынок больше не выбирает.
  -- Невалид/пусто → 'ru': иначе insert упал бы на констрейнте и exception-
  -- ветка ниже молча проглотила бы создание профиля.
  v_market := nullif(new.raw_app_meta_data->>'market', '');
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

-- id аккаунта по адресу входа. Пусто или нет такого — null. Адреса GoTrue
-- хранит в нижнем регистре; lower() с обеих сторон — на всякий случай.
-- Несколько строк с одним адресом (SSO) — самая ранняя.
create or replace function public.he_eng_auth_user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select u.id
    from auth.users u
   where nullif(btrim(p_email), '') is not null
     and lower(u.email) = lower(btrim(p_email))
   order by u.created_at
   limit 1;
$$;

revoke all on function public.he_eng_auth_user_id_by_email(text) from public, anon, authenticated;
grant execute on function public.he_eng_auth_user_id_by_email(text) to service_role, postgres;
