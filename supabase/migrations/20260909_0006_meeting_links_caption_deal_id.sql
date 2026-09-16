-- Привязка записей встреч к сделкам по номеру сделки из подписи.
--
-- Что сломалось. Автоматчик (20260731_0001) ищет сделку по домену из подписи
-- и по названию компании. Летом 2026 менеджеры сменили формат подписи на
--   «#34157623 | https://adaptasoft.ru/ | Оффер нравится, завтра ОС»
-- и домен перестал распознаваться: `fsd_norm_domain` снимает протокол с
-- НАЧАЛА строки, а начало теперь занято номером сделки. Матчинг по названию
-- добирает малую часть.
--
-- Масштаб (сверка 09.09.2026, чат встреч):
--   июнь      103 записи → 73 привязано
--   июль      114        → 81
--   август    105        → 41   ← смена формата
--   сентябрь   41        →  9
-- За август дашборд показывал 36 встреч при 90 реальных: метрика занижена в
-- два с половиной раза, и сильнее всех у тех, кто перешёл на новый формат
-- раньше (Юлия — 2 из 18).
--
-- Что делаем. Номер сделки в подписи — самый сильный признак из возможных:
-- его ставит человек, который эту встречу провёл, и он не допускает
-- толкований, в отличие от домена (совпадает у разных сделок одного клиента)
-- и названия (совпадает у разных клиентов). Поэтому 'deal_id' идёт первым
-- приоритетом, домен вторым, название третьим.
--
-- Регулярка `#\s?(\d{6,10})` — та же, что в 20260904_0001
-- (transcript_amo_lead_link): подпись одна, и разбирать её двумя разными
-- способами значит однажды получить два разных ответа.
--
-- Ручная разметка (manual, not_a_meeting) по-прежнему неприкосновенна.

alter table public.meeting_deal_links
  drop constraint if exists meeting_deal_links_method_check;
alter table public.meeting_deal_links
  add constraint meeting_deal_links_method_check
  check (method in ('deal_id','domain','name','manual','not_a_meeting'));

comment on column public.meeting_deal_links.method is
  'deal_id — номер сделки из подписи («#34157623 | …»), самый надёжный признак. domain/name — автоматчинг по сайту/названию компании. manual — привязал человек. not_a_meeting — человек отметил, что это не встреча с клиентом; amo_deal_id при этом NULL.';

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
           public.fsd_norm_domain(t.caption) as dom,
           (regexp_match(t.caption, '#\s?(\d{6,10})'))[1] as caption_deal
    from public.tg_video_transcripts t
    where t.tg_chat_id = -1001852890744
      and coalesce(t.caption, '') <> ''
  ),
  by_id as (
    -- Воронка здесь не ограничивается намеренно: привязка отвечает на вопрос
    -- «о какой сделке эта запись», а не «идёт ли она в первичку». Отбор по
    -- воронке делает метрика (lib/firstSales/meetings.ts), и запись про
    -- сделку продлений остаётся привязанной — она нужна разбору и AI.
    select tr.id as transcript_id, l.amo_id, 'deal_id' as method
    from tr
    join public.amo_leads l on l.amo_id = tr.caption_deal::bigint
    where tr.caption_deal is not null
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
    select transcript_id, amo_id, method from by_id
    union all
    select tr.id, s.amo_id,
           case when s.dom <> '' and length(s.dom) > 4
                     and (s.dom = tr.dom or split_part(s.dom, '.', 1) = tr.cap)
                then 'domain' else 'name' end
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
             order by case method when 'deal_id' then 0 when 'domain' then 1 else 2 end, amo_id
           ) as rn,
           count(*) over (partition by transcript_id) as n
    from cand
  )
  -- Слабый признак (название) по-прежнему годится только когда он
  -- единственный: выбирать за человека между двумя похожими названиями —
  -- значит выдать непроверяемую цифру. Сильные признаки (номер сделки, домен)
  -- решают сами.
  insert into public.meeting_deal_links (transcript_id, amo_deal_id, method)
  select transcript_id, amo_id, method
  from ranked
  where rn = 1 and (method in ('deal_id','domain') or n = 1)
  on conflict (transcript_id) do update
    set amo_deal_id = excluded.amo_deal_id,
        method      = excluded.method,
        matched_at  = now()
    where meeting_deal_links.method not in ('manual','not_a_meeting');

  get diagnostics affected = row_count;
  return affected;
end $$;

revoke all on function public.apply_meeting_deal_links() from public;
grant execute on function public.apply_meeting_deal_links() to service_role, postgres;

comment on function public.apply_meeting_deal_links() is
  'Автопривязка записей встреч к сделкам. Приоритет признаков: номер сделки из подписи (deal_id) → домен → название компании. Неоднозначные по названию (n>1) оставляет человеку. Ручную разметку человека — привязку (manual) и «не встреча» (not_a_meeting) — не трогает никогда.';

-- Прогон сразу: без него история чинится только следующей ночью, а цифра на
-- экране всё это время остаётся заниженной вдвое.
select public.apply_meeting_deal_links();
