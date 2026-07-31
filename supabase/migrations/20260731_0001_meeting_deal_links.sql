-- Привязка записей встреч (tg_video_transcripts) к сделкам AMO.
-- Зачем: Егор считает встречей наличие записи разговора в телеграм-чате
-- встреч, а этап AMO «Встреча проведена + КП отправлено» засорён —
-- 200+ в месяц против его 64. План: docs/superpowers/plans/2026-07-30-meeting-deal-links.md
--
-- Сырьё (tg_video_transcripts) остаётся нетронутым; привязка живёт здесь,
-- отдельно, — тот же принцип, что в 20260730_0001_expenses_core.sql: сырьё
-- честное, трактовки отдельно.

create table if not exists public.meeting_deal_links (
  id            bigserial primary key,
  transcript_id uuid   not null references public.tg_video_transcripts(id) on delete cascade,
  amo_deal_id   bigint not null,
  method        text   not null check (method in ('domain','name','manual')),
  matched_at    timestamptz not null default now(),
  matched_by    uuid references public.profiles(id) on delete set null
);

-- Одна запись — ровно одна сделка. Без этого подписи вроде «laserstyle»
-- цепляют несколько компаний с похожими названиями, и встречи задваиваются:
-- за июль 2026 72 записи давали 78 пар (сделка, дата).
create unique index if not exists uq_meeting_deal_links_tid
  on public.meeting_deal_links (transcript_id);

create index if not exists idx_meeting_deal_links_deal
  on public.meeting_deal_links (amo_deal_id);

comment on table public.meeting_deal_links is
  'Запись разговора (tg_video_transcripts) → сделка AMO. Автоматчинг по домену и названию компании (apply_meeting_deal_links), хвост размечается руками на /analytics/first-sales. method=manual никогда не перезаписывается автоматчером.';

-- ─── Автоматчер ──────────────────────────────────────────────────────────

-- Нормализация домена: снять протокол, www и путь/query. immutable — тело
-- состоит только из lower/split_part/regexp_replace/btrim, все они встроены
-- и не читают mutable session-настройки (тот же довод, что для уже
-- существующего idx_amo_leads_company_name на lower(company_name)); поэтому
-- функцию безопасно использовать в индексных выражениях и планировщик волен
-- инлайнить её вызовы. Без search_path — намеренно: SET-клауза на SQL-
-- функции блокирует инлайнинг, а сама функция не трогает ни одной таблицы,
-- только встроенные функции из pg_catalog.
create or replace function public.fsd_norm_domain(v text)
returns text language sql immutable as $$
  select lower(split_part(regexp_replace(btrim(coalesce(v,'')), '^(https?://)?(www\.)?', '', 'i'), '/', 1))
$$;

revoke all on function public.fsd_norm_domain(text) from public;

comment on function public.fsd_norm_domain(text) is
  'Домен без протокола/www/пути/query, lower-case. Использовать для сравнения сайтов вне зависимости от того, как их записал человек.';

create or replace function public.apply_meeting_deal_links()
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  affected integer;
begin
  with tr as (
    -- Чат встреч — tg_chat_id = -1001852890744. Второй чат
    -- (-1002179160904) — внутренние созвоны команды, в метрику не входит.
    select t.id,
           lower(btrim(t.caption)) as cap,
           public.fsd_norm_domain(t.caption) as dom
    from public.tg_video_transcripts t
    where t.tg_chat_id = -1001852890744
      and coalesce(t.caption, '') <> ''
  ),
  site as (
    -- company_website уже нормализован тем же способом (без протокола,
    -- www, пути) воркером amo_enrich/AmoSync при ночном синке — см.
    -- _extract_website_from_lead в services/portal-external-sync/sources/amo.py
    -- и комментарий к колонке в 20260713_0001_amo_linking_columns.sql.
    -- Повторно парсить raw->custom_fields_values здесь незачем: это то же
    -- самое значение, посчитанное в том же прогоне синка, только с лишней
    -- хрупкой зависимостью от формы raw JSON.
    select l.amo_id,
           public.fsd_norm_domain(l.company_website) as dom,
           lower(btrim(l.company_name)) as cname
    from public.amo_leads l
    where l.pipeline_id = 7670334
      and (coalesce(l.company_website, '') <> '' or coalesce(l.company_name, '') <> '')
  ),
  cand as (
    select tr.id as transcript_id, s.amo_id,
           -- Домен надёжнее названия: сайт почти уникален, название — нет.
           case when s.dom <> '' and length(s.dom) > 4
                     and (s.dom = tr.dom or split_part(s.dom, '.', 1) = tr.cap)
                then 'domain' else 'name' end as method
    from tr
    join site s
      on (s.dom <> '' and length(s.dom) > 4
          and (s.dom = tr.dom or split_part(s.dom, '.', 1) = tr.cap))
      -- position(), а не LIKE: company_name приходит от человека через AMO
      -- и может содержать % или _ (например «100% Fitness») — тот же довод,
      -- что уже применён к expense_rules в 20260730_0003_apply_expense_rules.sql.
      or (s.cname <> '' and length(s.cname) > 3 and position(s.cname in tr.cap) > 0)
  ),
  ranked as (
    select transcript_id, amo_id, method,
           row_number() over (
             partition by transcript_id
             order by case method when 'domain' then 0 else 1 end, amo_id
           ) as rn,
           count(*) over (partition by transcript_id) as n
    from cand
  )
  -- Берём только однозначные: если запись зацепила несколько сделок по
  -- слабому признаку (название), автомат не выбирает за человека — строка
  -- остаётся в очереди ручной разметки. Молчаливый выбор «первой попавшейся
  -- сделки» дал бы цифру, которую невозможно проверить, а именно
  -- проверяемость тут и есть цель.
  insert into public.meeting_deal_links (transcript_id, amo_deal_id, method)
  select transcript_id, amo_id, method
  from ranked
  where rn = 1 and (method = 'domain' or n = 1)
  on conflict (transcript_id) do update
    set amo_deal_id = excluded.amo_deal_id,
        method      = excluded.method,
        matched_at  = now()
    -- Ключевая строка всей задачи: правило не трогает то, что размечено
    -- человеком. Защита структурная, а не договорённость между людьми.
    where meeting_deal_links.method <> 'manual';

  get diagnostics affected = row_count;
  return affected;
end $$;

revoke all on function public.apply_meeting_deal_links() from public;

comment on function public.apply_meeting_deal_links() is
  'Автопривязка записей встреч к сделкам. Домен сильнее названия; неоднозначные по названию (n>1) оставляет человеку, неоднозначные по домену — нет (см. обсуждение в плане). Ручные привязки (method=manual) не трогает никогда.';

-- ─── RLS и гранты ────────────────────────────────────────────────────────
-- Select-политики для authenticated нет сознательно: данные читает только
-- серверный код под service_role через API-роуты с гардом доступа.

alter table public.meeting_deal_links enable row level security;

grant all on public.meeting_deal_links to service_role, postgres;
grant usage, select on sequence public.meeting_deal_links_id_seq to service_role, postgres;
grant execute on function public.apply_meeting_deal_links() to service_role, postgres;
grant execute on function public.fsd_norm_domain(text) to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.meeting_deal_links to readonly';
  end if;
end $$;
