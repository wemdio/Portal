-- gisSignalOutreach: вес сегмента в дневном лимите.
--
-- До этого daily_limit делился между активными сегментами ПОРОВНУ, а базы ниш
-- различаются на порядок (замер 18.08.2026, компании с сайтом в 2GIS):
--   мебель/ремонт 56 195 · образование 21 122 · юристы 19 417 ·
--   бухгалтерия 5 523 · консалтинг 3 840.
-- При равном делении по 400 карточек в день мебели хватало на 135 рабочих дней,
-- а консалтингу — на девять: маленькие ниши выключались бы одна за другой, пока
-- большие простаивают.
--
-- Вес нормируется на сумму весов (см. computeSegmentQuotas), поэтому значение —
-- пропорция, а не абсолют, и при смене daily_limit доли сохраняются.
-- DEFAULT 1 = прежнее поведение (равные доли), поэтому колонка безопасна для
-- уже существующих строк и для кода, который о ней ещё не знает.

alter table public.gis_signal_segments
  add column if not exists quota_weight integer not null default 1;

alter table public.gis_signal_segments
  add constraint gis_signal_segments_quota_weight_nonneg check (quota_weight >= 0) not valid;

comment on column public.gis_signal_segments.quota_weight is
  'Доля сегмента в daily_limit: квота = daily_limit * weight / сумма весов активных сегментов. 0 — пауза сегмента без выключения. 1 у всех = деление поровну.';
