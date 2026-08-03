-- Отметка «это не встреча» на записях чата встреч.
-- Зачем: часть записей — внутренние созвоны или мусор, без сделки в принципе
-- (ошиблись чатом, тестовый файл и т.п.). Без отдельного состояния такую
-- запись некуда деть: она не попадает под domain/name-автоматчинг (значит
-- остаётся «непривязанной») и будет заново всплывать в очереди ручной
-- разметки /analytics/first-sales при каждом обновлении, даже после того как
-- человек её один раз просмотрел и решил, что это не встреча с клиентом.
-- Очередь так никогда не покажет ноль. План:
-- docs/superpowers/plans/2026-07-30-meeting-deal-links.md, Task 3.

alter table public.meeting_deal_links
  alter column amo_deal_id drop not null;

alter table public.meeting_deal_links
  drop constraint if exists meeting_deal_links_method_check;
alter table public.meeting_deal_links
  add constraint meeting_deal_links_method_check
  check (method in ('domain','name','manual','not_a_meeting'));

-- Инвариант: amo_deal_id пуст тогда и только тогда, когда method='not_a_meeting'.
-- Без этого отдельного констрейнта рано или поздно появится либо «привязка
-- в никуда» (amo_deal_id is null у method='manual'/'domain'/'name'), либо
-- method='not_a_meeting' с висящим amo_deal_id, который человек, читающий
-- данные напрямую, ошибочно примет за настоящую привязку.
alter table public.meeting_deal_links
  add constraint meeting_deal_links_deal_id_null_iff_not_a_meeting
  check ((amo_deal_id is null) = (method = 'not_a_meeting'));

comment on column public.meeting_deal_links.amo_deal_id is
  'Сделка AMO, к которой привязана запись. NULL тогда и только тогда, когда method=''not_a_meeting'' — запись размечена как не относящаяся к встречам с клиентом (внутренний созвон, мусор) и навсегда исключена из очереди ручной разметки.';
comment on column public.meeting_deal_links.method is
  'domain/name — автоматчинг по сайту/названию компании. manual — привязал человек. not_a_meeting — человек отметил, что это не встреча с клиентом; amo_deal_id при этом NULL.';

-- ─── Автоматчер: не перезатирать ручную разметку человека ──────────────────
--
-- В миграции 20260731_0001 условие ON CONFLICT было `method <> 'manual'` —
-- оно защищало только явную привязку к сделке. 'not_a_meeting' <> 'manual'
-- истинно, так что старое условие пропускало ЭТУ строку на обновление:
-- если запись, помеченная «не встреча», на следующем прогоне синка вдруг
-- зацепится по домену/названию (например, подпись задним числом
-- отредактировали), автоматчер молча заменил бы отметку на привязку к
-- сделке — то, что человек явно решил разобрать один раз, разобралось бы
-- заново без его участия. Условие расширяется: любая ручная разметка
-- (manual ИЛИ not_a_meeting) неприкосновенна для автоматчера.
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
    select l.amo_id,
           public.fsd_norm_domain(l.company_website) as dom,
           lower(btrim(l.company_name)) as cname
    from public.amo_leads l
    where l.pipeline_id = 7670334
      and (coalesce(l.company_website, '') <> '' or coalesce(l.company_name, '') <> '')
  ),
  cand as (
    select tr.id as transcript_id, s.amo_id,
           case when s.dom <> '' and length(s.dom) > 4
                     and (s.dom = tr.dom or split_part(s.dom, '.', 1) = tr.cap)
                then 'domain' else 'name' end as method
    from tr
    join site s
      on (s.dom <> '' and length(s.dom) > 4
          and (s.dom = tr.dom or split_part(s.dom, '.', 1) = tr.cap))
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
  insert into public.meeting_deal_links (transcript_id, amo_deal_id, method)
  select transcript_id, amo_id, method
  from ranked
  where rn = 1 and (method = 'domain' or n = 1)
  on conflict (transcript_id) do update
    set amo_deal_id = excluded.amo_deal_id,
        method      = excluded.method,
        matched_at  = now()
    -- Ключевая строка: не трогать НИКАКУЮ ручную разметку человека, не
    -- только привязку к сделке, но и «не встреча».
    where meeting_deal_links.method not in ('manual', 'not_a_meeting');

  get diagnostics affected = row_count;
  return affected;
end $$;

revoke all on function public.apply_meeting_deal_links() from public;
grant execute on function public.apply_meeting_deal_links() to service_role, postgres;

comment on function public.apply_meeting_deal_links() is
  'Автопривязка записей встреч к сделкам. Домен сильнее названия; неоднозначные по названию (n>1) оставляет человеку, неоднозначные по домену — нет. Ручную разметку человека — привязку (method=manual) и «не встреча» (method=not_a_meeting) — не трогает никогда.';
