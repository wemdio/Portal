-- VE2: стадия broad_hypotheses — добавить широкие гипотезы уровня сектора в
-- уже исследованный проект. Повторное исследование удаляет вертикали, а с ними
-- базы, шаблоны и цепочки; эта задача только дописывает новые гипотезы и
-- вертикали. Список стадий расширяется, прежние значения остаются.

alter table public.ve_jobs drop constraint if exists ve_jobs_stage_check;
alter table public.ve_jobs add constraint ve_jobs_stage_check check(stage in (
  'site_profile','competitors','brand_cloud','hypotheses','evidence','clustering',
  'chain','vocab','base_analyze','base_collect','template','dossier','segmentation_audit','outreach_start',
  'broad_hypotheses'
));

-- Одна идущая задача на проект из двух: запуск исследования (site_profile)
-- или добавление широких. Код проверяет занятость выборкой перед вставкой, и
-- два почти одновременных запроса проходят проверку оба; индекс пропускает
-- только первую вставку, вторая получает 23505 (повторное нажатие отдаёт
-- идущую задачу, другое действие отвечает «занято»). Следующие стадии
-- исследования воркер ставит после завершения предыдущей, их индекс не касается.
create unique index if not exists ve_jobs_one_active_research_start
  on public.ve_jobs (project_id)
  where stage in ('site_profile', 'broad_hypotheses') and status in ('pending', 'running');
