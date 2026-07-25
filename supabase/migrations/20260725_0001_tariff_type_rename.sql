-- Переименование значений тарифа в client_tariffs.tariff_type под названия из
-- продукта: standard → Запуск, pro → Поток, custom → Масштаб.
--
-- Зачем: до этого в БД лежали одни слова, а в лендинге, ЛК клиента и счетах
-- показывались другие, и между ними висел маппинг. Теперь SQL-запросы, логи и
-- выгрузки говорят на том же языке, что и продукт, без промежуточного слоя.
--
-- Колонка — text с CHECK-констрейнтом (не enum), поэтому переименование это
-- UPDATE данных + замена констрейнта. Строк немного: на 25.07.2026 было 25
-- (19 standard / 3 pro / 3 custom).
--
-- ─── ПОЧЕМУ CHECK ОСТАЁТСЯ ШИРОКИМ ──────────────────────────────────────────
-- Констрейнт намеренно принимает И новые, И прежние значения. Причина в порядке
-- деплоя: Semaphore прогоняет миграции preflight'ом на новом образе ДО
-- переключения трафика (scheduled-deploy.yml, ensureDatabase.js). Значит между
-- миграцией и переключением живым остаётся СТАРЫЙ код, который пишет
-- 'standard'. Сузь мы CHECK сразу до новых значений — этот код упёрся бы в
-- ошибку констрейнта, а это платёжный путь: активация тарифа и вебхуки ЮКассы.
--
-- Плюс второй сценарий: у клиента может быть открыта вкладка ЛК со старым JS,
-- которая после деплоя пришлёт tariff_type: 'standard' в /api/client/payment.
-- Приложение это переваривает через normalizeTariffType (lib/tariffPricing.ts),
-- но и БД не должна отвергать такую запись.
--
-- Сузить CHECK до трёх новых значений можно отдельной миграцией — после того
-- как новый код отработает в проде хотя бы сутки и в таблице не останется
-- строк со старыми значениями. Проверка перед сужением:
--   select tariff_type, count(*) from client_tariffs group by 1;

-- ─── 1. Расширяем CHECK: старые + новые значения ────────────────────────────
-- Порядок важен: сначала разрешить новые значения, только потом писать их.
alter table public.client_tariffs
  drop constraint if exists client_tariffs_tariff_type_check;

alter table public.client_tariffs
  add constraint client_tariffs_tariff_type_check
  check (tariff_type = any (array[
    'Запуск'::text, 'Поток'::text, 'Масштаб'::text,
    'standard'::text, 'pro'::text, 'custom'::text
  ]));

-- ─── 2. Переводим существующие данные ───────────────────────────────────────
update public.client_tariffs set tariff_type = 'Запуск'  where tariff_type = 'standard';
update public.client_tariffs set tariff_type = 'Поток'   where tariff_type = 'pro';
update public.client_tariffs set tariff_type = 'Масштаб' where tariff_type = 'custom';

-- ─── 3. Дефолт колонки, если он был выставлен на старое значение ────────────
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'client_tariffs'
      and column_name = 'tariff_type'
      and column_default is not null
  ) then
    alter table public.client_tariffs alter column tariff_type set default 'Запуск';
  end if;
end $$;

comment on column public.client_tariffs.tariff_type is
  'Тариф клиента: Запуск / Поток / Масштаб. CHECK временно принимает и прежние standard/pro/custom — см. миграцию 20260725_0001, сузить отдельной миграцией после стабилизации.';
