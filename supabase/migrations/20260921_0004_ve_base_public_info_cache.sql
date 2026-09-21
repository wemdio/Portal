-- Публичный срез collect_info считается ПРИ ЗАПИСИ, а не при каждом чтении.
--
-- Миграция 20260921_0003 убрала из ответа лишние сотни мегабайт, но не убрала
-- чтение: чтобы собрать 94 КБ среза, база всё равно читала и распаковывала весь
-- collect_info. Замер на проекте «Ивент и маркетинг груп» (26 баз, 178 МБ на
-- диске): обычные колонки отдаются за 46 мс, срез — за 1 985 мс. И так на каждом
-- опросе карточки, а она опрашивается раз в 4 секунды.
--
-- При этом сам расчёт среза дешёвый: на строке, которая УЖЕ в памяти, он стоит
-- 1-123 мс (замер по пяти базам того же проекта). Две секунды — это чтение
-- TOAST, а не работа. Значит срез надо считать там, где документ и так в
-- памяти: в момент записи.
alter table public.ve_bases add column if not exists public_info jsonb;

comment on column public.ve_bases.public_info is
  'VE2: публичный срез collect_info для карточки проекта. Считается триггером при записи collect_info; NULL означает «ещё не пересчитан», и тогда чтение падает обратно на ve_base_public_info.';

create or replace function public.ve_base_public_info_sync()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.public_info := public.ve_base_public_info(new);
  return new;
end $$;

-- UPDATE OF collect_info — синтаксическая проверка списка SET, а не сравнение
-- значений: обновление обычных колонок (например лимита адресов сразу по всем
-- базам проекта) триггер не будит и за тяжёлый документ не платит.
drop trigger if exists ve_bases_public_info_sync on public.ve_bases;
create trigger ve_bases_public_info_sync
  before insert or update of collect_info on public.ve_bases
  for each row execute function public.ve_base_public_info_sync();

-- Читающая сторона: готовый срез, а если его ещё нет — считаем на лету.
-- Так деталка не ломается на базах, которые с момента миграции не сохранялись.
create or replace function public.ve_base_public_info_cached(b public.ve_bases)
returns jsonb language sql stable parallel safe set search_path = '' as $$
  select coalesce(b.public_info, public.ve_base_public_info(b));
$$;

comment on function public.ve_base_public_info_cached(public.ve_bases) is
  'VE2: срез collect_info для карточки проекта. Отдаёт посчитанный при записи, иначе считает на лету.';

revoke all on function public.ve_base_public_info_sync() from public, anon;
revoke all on function public.ve_base_public_info_cached(public.ve_bases) from public, anon;
grant execute on function public.ve_base_public_info_cached(public.ve_bases) to authenticated, service_role;
