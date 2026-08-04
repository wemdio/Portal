-- Фикс: amo_custom_field_value падал на сделках, где custom_fields_values —
-- JSON null, а не массив. AMO отдаёт именно `"custom_fields_values": null`
-- для сделки без единого заполненного кастомного поля; на 04.08.2026 таких
-- 304 из 5848 в amo_leads.
--
-- coalesce тут не помогает: он ловит только SQL NULL, а `raw -> 'ключ'` для
-- JSON null возвращает не NULL, а jsonb-скаляр 'null'. Он проходит coalesce
-- насквозь и валит jsonb_array_elements с «cannot extract elements from a
-- scalar» — из-за этого первый же боевой прогон источника renewal_marks
-- (04.08.2026 16:32 МСК) упал целиком, вместе с разметкой продлений.
--
-- Правильная проверка — jsonb_typeof(...) = 'array': она отсекает и JSON null,
-- и любой другой скаляр, если AMO когда-нибудь отдаст строку или число.
create or replace function public.amo_custom_field_value(p_raw jsonb, p_field_name text)
returns text language sql immutable as $$
  select nullif(btrim(v ->> 'value'), '')
  from jsonb_array_elements(
    case when jsonb_typeof(p_raw -> 'custom_fields_values') = 'array'
         then p_raw -> 'custom_fields_values'
         else '[]'::jsonb end
  ) f
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(f -> 'values') = 'array'
         then f -> 'values'
         else '[]'::jsonb end
  ) v
  where f ->> 'field_name' = p_field_name
  limit 1
$$;

revoke all on function public.amo_custom_field_value(jsonb, text) from public;
grant execute on function public.amo_custom_field_value(jsonb, text) to service_role, postgres;

comment on function public.amo_custom_field_value(jsonb, text) is
  'Первое значение кастомного поля AMO по имени (не по field_id — id завязан на конкретный аккаунт). NULL, если поля нет, оно пустое или custom_fields_values не массив.';
