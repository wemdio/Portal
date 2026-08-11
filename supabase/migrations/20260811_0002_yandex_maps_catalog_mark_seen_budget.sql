-- Уборка после обхода перестаёт верить слову «выдача была исчерпывающей».
--
-- Обход считает выдачу полной, если Яндекс вернул меньше ссылок, чем у него
-- просили. Но «меньше» бывает и когда поиск оборвался или его придушил прокси.
-- Замер на бою 11.08.2026:
--
--   «Москва × Бизнес»              — 20 ссылок в выдаче, 65 321 организация в каталоге;
--   «Воронежская область × Услуги» —  0 ссылок,           3 343;
--   «Набережные Челны × Уход за внешностью» — 4 ссылки,     148.
--
-- По прежним правилам все они получали missing_streak + 1, а на втором таком
-- обходе — closed_suspected_at. То есть механизм, задуманный ловить закрывшиеся
-- точки, записывал в закрытые живые компании тысячами.
--
-- Вторая беда та же по корню: переписать десятки тысяч широких строк в таблице
-- на 19 ГБ — это минуты, а вызов шёл через PostgREST, где Kong рвёт соединение
-- на 60 секундах. 343 пары очереди из 20 000 висели в «упало» с
-- `Не удалось отметить организации: The upstream server is timing out` — и ни
-- одной новой организации по ним не собиралось: уборка стояла первым шагом.
--
-- Потолок закрывает оба случая разом. Показал Яндекс N организаций — уборка
-- вправе усомниться максимум в 2N + 20 (считает missingMarkBudget в
-- app/src/lib/parsers/yandexMapsCatalog.ts). Не сошлось — выдача была неполной,
-- и трогать нечего. Заодно объём работы ограничен сверху, и минутных вызовов
-- больше не будет.
--
-- p_max_missing = null сохраняет прежнее поведение: без потолка, как было.

-- Старую пятиаргументную снимаем: иначе на бою останутся две функции под одним
-- именем, и вызов без потолка разрешался бы в прежнюю.
drop function if exists public.yandex_maps_catalog_mark_seen(text[], text, text, text, boolean);

create or replace function public.yandex_maps_catalog_mark_seen(
  p_seen text[],
  p_country text,
  p_place text,
  p_rubric text,
  p_exhaustive boolean default false,
  p_max_missing integer default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  missing_ids text[];
  suspected integer := 0;
begin
  if p_seen is not null and cardinality(p_seen) > 0 then
    update public.yandex_maps_company_catalog
       set last_seen_in_search_at = now(),
           missing_streak = 0,
           closed_suspected_at = null
     where yandex_id = any(p_seen);
  end if;

  if not coalesce(p_exhaustive, false) then
    return 0;
  end if;

  -- Кандидаты собираются один раз и с потолком: «плюс один» отличает
  -- «уложились» от «их больше», не заставляя досчитывать всю Москву.
  -- missing_streak < 2 — из 20260810_0003: у кого две отметки подряд уже есть,
  -- сигнал полон, переписывать строку заново незачем.
  select coalesce(array_agg(candidate.yandex_id), '{}'::text[])
    into missing_ids
    from (
      select c.yandex_id
        from public.yandex_maps_company_catalog c
       where c.country = p_country
         and (c.city = p_place or c.region = p_place)
         and public.yandex_maps_rubric_tokens(c.categories, c.subcategories)
             && array[btrim(lower(p_rubric))]
         and c.missing_streak < 2
         and not (c.yandex_id = any(coalesce(p_seen, array[]::text[])))
       limit case when p_max_missing is null then null else p_max_missing + 1 end
    ) candidate;

  -- Выдача оказалась заметно беднее каталога — значит она не была полной, и
  -- отсутствие организации в ней ни о чём не говорит. Не трогаем ничего.
  if p_max_missing is not null and cardinality(missing_ids) > p_max_missing then
    return 0;
  end if;

  update public.yandex_maps_company_catalog c
     set missing_streak = c.missing_streak + 1,
         closed_suspected_at = case
           when c.missing_streak + 1 >= 2 then now()
           else c.closed_suspected_at
         end
   where c.yandex_id = any(missing_ids)
     -- Перепроверка после освобождения строки другим обновлением.
     and c.missing_streak < 2;

  get diagnostics suspected = row_count;
  return suspected;
end;
$$;

grant execute on function public.yandex_maps_catalog_mark_seen(text[], text, text, text, boolean, integer)
  to service_role;
