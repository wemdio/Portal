-- Hypothesis Engine (Движок вертикалей): рынок проекта — 'ru' (дефолт,
-- обратная совместимость) или 'us' (ENG-пайплайн: geo-поиск Serper, язык
-- research-промптов, дефолтный язык цепочек писем 'en'). Читается воркером
-- в HeStageContext.market (worker/hypothesisEngine.ts) и lib/hypothesisEngine/market.ts.

alter table public.he_projects
  add column if not exists market text not null default 'ru';

alter table public.he_projects
  drop constraint if exists he_projects_market_check;

alter table public.he_projects
  add constraint he_projects_market_check
  check (market in ('ru','us'));
