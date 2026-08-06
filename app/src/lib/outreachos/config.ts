/**
 * Загрузка singleton-конфига OutreachOS пайплайна (outreachos_pipeline_config, id=1).
 *
 * Изолирован от client_auto_pipeline_configs (Mailganer-стек). Скоринга нет.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/** Шаги конструктора баз, которые НИКОГДА не допускаем в OutreachOS-прогон. */
export const FORBIDDEN_STEPS = ['ta_scoring', 'personalization'] as const;

/**
 * Канонический порядок шагов (приоритеты из AVAILABLE_STEPS, lib/tools/
 * processingSteps.ts). КРИТИЧНО: worker-baseconstructor выполняет selected_steps
 * В ПОРЯДКЕ МАССИВА и сам НЕ сортирует. Поэтому сортируем здесь — иначе случайная
 * перестановка в конфиге молча ломает прогон (напр. validate_emails раньше
 * find_emails → валидирует пустую колонку → 0 контактов без ошибки).
 */
const STEP_PRIORITY: Record<string, number> = {
  remove_empty: 10, dedup_full: 20, check_sites: 30, find_emails: 40,
  split_emails: 45, remove_support_emails: 47, dedup_email: 50,
  validate_emails: 55, clean_names: 60, enrich_descriptions: 65,
  ta_scoring: 70, personalization: 80,
};

function sortByPriority(steps: string[]): string[] {
  return [...steps].sort((a, b) => (STEP_PRIORITY[a] ?? 999) - (STEP_PRIORITY[b] ?? 999));
}

export interface OutreachOsConfig {
  id: number;
  enabled: boolean;
  /**
   * Замер воронки: парс+конструктор+подсчёт valid_contacts БЕЗ заливки в Instantly
   * и БЕЗ записи seen (неразрушающе, повторяемо). campaign_id не нужен.
   */
  measure_only: boolean;
  /** profiles.id аккаунта OutreachOS — он же user_id для base_constructor_jobs. */
  client_user_id: string;
  /** Одна заранее созданная кампания Instantly для ежедневного добора. */
  campaign_id: string | null;
  /**
   * Вторая кампания для A/B-сплита офферов. NULL = сплит выключен (всё в
   * campaign_id). Задана → лиды делятся 50/50 по hash домена компании.
   */
  campaign_id_b: string | null;
  /** HH top-level industry id'ы (см. lib/jobs/hhIndustries). Пусто = без industry-фильтра. */
  industries: string[];
  area: string;
  window_hours: number;
  max_employees: number | null;
  daily_limit: number;
  /** Шаги конструктора баз. ta_scoring/personalization вырезаются при загрузке. */
  selected_steps: string[];
  extra_exclude: string[];
  job_poll_timeout_minutes: number;
  /**
   * Второй источник работодателей — SuperJob (app/src/lib/outreachos/
   * superjobSource.ts). false → только HH. Ключ — env SUPERJOB_APP_KEY на
   * воркере; без него источник пропускается с предупреждением.
   */
  superjob_enabled: boolean;
  /** Каталоги (профобласти) SJ: IT=33, пром/производство=327, стройка=306,
   *  логистика=86, маркетинг=234, HR=76, консалтинг=426. */
  superjob_catalogues: number[];
}

/** Дефолтный набор каталогов SJ — подстраховка до миграции колонки. */
const SUPERJOB_DEFAULT_CATALOGUES = [33, 327, 306, 86, 234, 76, 426];

/**
 * Читает конфиг id=1. Возвращает null, если строки нет или БД недоступна.
 * Жёстко фильтрует selected_steps от ta_scoring/personalization — даже если
 * кто-то по ошибке вписал их в конфиг, OutreachOS их не выполнит.
 */
export async function loadOutreachOsConfig(): Promise<OutreachOsConfig | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('outreachos_pipeline_config')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error || !data) return null;

  const row = data as OutreachOsConfig;
  // Вырезаем запрещённые шаги И сортируем по каноническому приоритету (воркер
  // выполняет в порядке массива и сам не сортирует).
  const cleanedSteps = sortByPriority(
    (row.selected_steps ?? []).filter(
      (s) => !FORBIDDEN_STEPS.includes(s as (typeof FORBIDDEN_STEPS)[number]),
    ),
  );
  return {
    ...row,
    selected_steps: cleanedSteps,
    // До миграции колонок — безопасные дефолты (источник выключен).
    superjob_enabled: row.superjob_enabled === true,
    superjob_catalogues:
      Array.isArray(row.superjob_catalogues) && row.superjob_catalogues.length > 0
        ? row.superjob_catalogues
        : SUPERJOB_DEFAULT_CATALOGUES,
  };
}
