alter table public.profiles
  add column if not exists locale text not null default 'ru';

update public.profiles
set locale = 'ru'
where locale is null or locale not in ('ru', 'en');

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_locale_check'
  ) then
    alter table public.profiles
      add constraint profiles_locale_check
      check (locale in ('ru', 'en'));
  end if;
end
$$;

grant update (full_name, avatar_url, email, default_board_id, locale) on table public.profiles to authenticated;
