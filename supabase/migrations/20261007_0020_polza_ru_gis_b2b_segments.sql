-- Автоаутрич RU: 2ГИС без медицины и юристов.
--
-- Доходимость до готовой строки за 2 недели до 07.10.2026 по сегментам
-- сигнального конвейера: medicine 0,4% (13 из 2 996), legal 0,5% (7 из 1 307)
-- против 1–3% у остальных — в основном клиники и частная практика для людей,
-- их отсекает проверка B2B уже после поиска почты. Тот же отбор, что в
-- 20260925_0001, плюс фильтр сегмента.
create or replace function public.polza_ru_gis_candidates(p_since timestamptz, p_limit integer)
returns table (
  twogis_id text,
  company_name text,
  domain text,
  site text,
  sales_team boolean,
  multi_office boolean,
  evidence jsonb,
  checked_at timestamptz
)
language sql
stable
set statement_timeout = '30s'
as $$
  select s.twogis_id::text, c.company_name::text, c.domain::text, s.site::text,
         (coalesce(s.signal_sales_dept, false) or coalesce(s.signal_target_vacancy, false)),
         coalesce(s.signal_multi_office, false),
         s.evidence::jsonb,
         s.checked_at
  from public.gis_signal_company_signals s
  join public.gis_signal_seen_companies c on c.twogis_id = s.twogis_id
  where s.checked_at >= p_since
    and (s.signal_multi_office or s.signal_sales_dept or s.signal_target_vacancy)
    and coalesce(nullif(c.domain::text, ''), nullif(s.site::text, '')) is not null
    and coalesce(c.segment_key, '') not in ('medicine', 'legal')
  order by s.checked_at desc
  limit least(greatest(p_limit, 1), 5000);
$$;
revoke all on function public.polza_ru_gis_candidates(timestamptz, integer) from public;
grant execute on function public.polza_ru_gis_candidates(timestamptz, integer) to service_role;
