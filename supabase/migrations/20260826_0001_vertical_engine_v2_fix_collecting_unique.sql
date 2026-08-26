-- Vertical Engine v2: чиню legacy-индекс антигонки автосборки, который ломал
-- base-per-hypothesis (миграция 20260824_0002).
--
-- Индекс ve_bases_one_collecting_per_vertical был уникальным на (vertical_id)
-- для source='auto' AND status='collecting' БЕЗ условия на hypothesis_id. При
-- multi-hypothesis (N баз одной вертикали, по одной на гипотезу) вторая база
-- падала с 23505 duplicate key.
--
-- Оставляем антигонку «одна collecting-база на вертикаль» только для легаси и
-- ENG-refill, где hypothesis_id IS NULL. Базы с гипотезой защищает индекс
-- ve_bases_one_collecting_per_hypothesis.

drop index if exists public.ve_bases_one_collecting_per_vertical;

create unique index if not exists ve_bases_one_collecting_per_vertical
  on public.ve_bases (vertical_id)
  where source = 'auto' and status = 'collecting' and hypothesis_id is null;
