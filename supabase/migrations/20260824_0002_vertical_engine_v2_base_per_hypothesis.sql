-- Vertical Engine v2: база на гипотезу (base-per-hypothesis) — Phase 1.
-- Добавляет ve_bases.hypothesis_id (nullable, ON DELETE SET NULL) и индекс
-- антигонки «одна collecting-база на гипотезу». НЕ трогает he_* и существующие
-- строки (hypothesis_id остаётся NULL у ручной загрузки и легаси).

-- ─── колонка + FK ───────────────────────────────────────────────────────
alter table public.ve_bases
  add column if not exists hypothesis_id uuid;

alter table public.ve_bases
  drop constraint if exists ve_bases_hypothesis_id_fkey;
alter table public.ve_bases
  add constraint ve_bases_hypothesis_id_fkey
  foreign key (hypothesis_id) references public.ve_hypotheses(id) on delete set null;

create index if not exists idx_ve_bases_hypothesis
  on public.ve_bases(hypothesis_id);

-- ─── антигонка автосборки на гипотезу ──────────────────────────────────
-- Автосборка всегда проставляет hypothesis_id (в т.ч. авто-вывод единственной
-- гипотезы), поэтому уникальность для source='auto' задаём по hypothesis_id.
-- Для hypothesis_id IS NULL (ручная загрузка / легаси) остаётся старый
-- ve_bases_one_collecting_per_vertical.
create unique index if not exists ve_bases_one_collecting_per_hypothesis
  on public.ve_bases (hypothesis_id)
  where source = 'auto' and status = 'collecting' and hypothesis_id is not null;

comment on column public.ve_bases.hypothesis_id is
  'Гипотеза, под которую собрана база (base-per-hypothesis). NULL только у ручной загрузки и легаси; автосборка всегда проставляет гипотезу, в т.ч. авто-вывод единственной.';