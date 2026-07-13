-- Предохранитель от отравления общего демо-профиля (инцидент 12.07.2026):
-- PUT /api/user/locale не гейтил демо, один посетитель кликнул EN → locale='en'
-- записался в ОБЩИЙ демо-аккаунт → переводчик (заблокированный под демо)
-- вешал белый оверлей всем посетителям, включая /login.
--
-- Серверный гейт добавлен в роут (blockDemo в PUT), но этот триггер — защита
-- на уровне данных: какой бы код ни писал в profiles, локаль демо-аккаунтов
-- остаётся 'ru'. Идемпотентен; применён на прод вручную 12.07 (до деплоя).
create or replace function public.pin_demo_profile_locale()
returns trigger
language plpgsql
as $$
begin
  if new.is_demo is true and new.locale is distinct from 'ru' then
    new.locale := 'ru';
  end if;
  return new;
end
$$;

drop trigger if exists pin_demo_profile_locale on public.profiles;
create trigger pin_demo_profile_locale
  before insert or update on public.profiles
  for each row
  execute function public.pin_demo_profile_locale();
