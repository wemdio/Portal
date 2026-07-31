-- Hypothesis Engine (Движок вертикалей): авто-сборка баз под вертикаль —
-- стадия base_collect и режим he_bases source='auto'.
--
-- Рядом с ручной загрузкой базы специалистом появляется авто-режим:
-- POST /api/tools/hypothesis-engine/verticals/[id]/collect создаёт
-- he_bases(source='auto', status='collecting') + he_jobs(stage='base_collect'),
-- а воркер (app/src/lib/hypothesisEngine/stages/baseCollect.ts) строит план
-- источников (LLM), диспатчит задачи в существующие коллекторы
-- (companies_directory, hh, Яндекс.Карты, Google Maps) и по мере готовности
-- собирает строки в he_bases. Ход сборки (план + статусы задач) живёт в
-- he_bases.collect_info.
--
-- Grant'ы не нужны — колонки наследуют права таблиц; меняются только
-- constraint'ы и схема.

-- ─── 1. he_bases: источник базы и состояние авто-сборки ──────────────────

alter table public.he_bases
  add column if not exists source text not null default 'upload'
  check (source in ('upload','auto'));

alter table public.he_bases
  add column if not exists collect_info jsonb;

comment on column public.he_bases.source is
  'upload — загружена специалистом; auto — собирается стадией base_collect.';
comment on column public.he_bases.collect_info is
  'Состояние авто-сборки (только source=auto): {plan, tasks[], stats} — план источников и статусы задач коллекторов.';

-- ─── 2. he_bases.status: + 'collecting' ──────────────────────────────────
-- База проводит авто-сборку в collecting: uploaded (ручная загрузка) →
-- analyzing → analyzed; collecting → analyzing → analyzed | failed.

alter table public.he_bases
  drop constraint if exists he_bases_status_check;

alter table public.he_bases
  add constraint he_bases_status_check
  check (status in ('uploaded','collecting','analyzing','analyzed','failed'));

-- ─── 3. he_jobs.stage: + 'base_collect' ──────────────────────────────────
-- Полный список стадий (как в 20260727_0001_he_jobs_stage_add_dossier.sql)
-- плюс base_collect; без него каждый insert джобы авто-сборки падает на
-- check-ограничении.

alter table public.he_jobs
  drop constraint if exists he_jobs_stage_check;

alter table public.he_jobs
  add constraint he_jobs_stage_check
  check (stage in ('site_profile','competitors','brand_cloud','hypotheses','evidence','clustering','chain','vocab','base_analyze','template','dossier','base_collect'));
