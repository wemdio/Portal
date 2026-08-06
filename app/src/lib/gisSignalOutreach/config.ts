/**
 * Загрузка singleton-конфига gisSignalOutreach пайплайна
 * (gis_signal_pipeline_config, id=1) + списка сегментов (gis_signal_segments).
 *
 * Пайплайн: 2GIS → 6-сигнальная квалификация сайта → конструктор баз →
 * добор в per-сегментные кампании Instantly. Изолирован от OutreachOS и
 * Mailganer-стека. Скоринга нет — есть сигнальная квалификация (signals.ts).
 *
 * Паттерн повторяет lib/outreachos/config.ts.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { TwoGisRubricGroup } from '@/lib/twoGis/types';

/** Шаги конструктора баз, которые НИКОГДА не допускаем в прогон этого пайплайна. */
export const FORBIDDEN_STEPS = ['ta_scoring', 'personalization', 'remove_support_emails'] as const;

/**
 * Канонический порядок шагов (приоритеты из AVAILABLE_STEPS, lib/tools/
 * processingSteps.ts). КРИТИЧНО: worker-baseconstructor выполняет selected_steps
 * В ПОРЯДКЕ МАССИВА и сам НЕ сортирует. Поэтому сортируем здесь — иначе случайная
 * перестановка в конфиге молча ломает прогон (напр. validate_emails раньше
 * find_emails → валидирует пустую колонку → 0 контактов без ошибки).
 */
const STEP_PRIORITY: Record<string, number> = {
  remove_empty: 10, dedup_full: 20, check_sites: 30, find_emails: 40,
  split_emails: 45, dedup_email: 50, validate_emails: 55,
  cap_emails_per_company: 57, clean_names: 60, enrich_descriptions: 65,
};

function sortByPriority(steps: string[]): string[] {
  return [...steps].sort((a, b) => (STEP_PRIORITY[a] ?? 999) - (STEP_PRIORITY[b] ?? 999));
}

/**
 * Рубрикатор сегмента в gis_signal_segments.rubric_groups (jsonb).
 * Упрощённая форма TwoGisRubricGroup: includedSubcategories задан → mode 'some';
 * иначе excludedSubcategories задан → mode 'allExcept'; иначе mode 'all'.
 */
export interface GisSignalRubricGroup {
  category: string;
  includedSubcategories?: string[];
  excludedSubcategories?: string[];
}

export interface GisSignalConfig {
  id: number;
  enabled: boolean;
  /**
   * Замер воронки: кандидаты+сигналы+конструктор+подсчёт valid_contacts БЕЗ
   * заливки в Instantly и БЕЗ записи seen (неразрушающе, повторяемо).
   */
  measure_only: boolean;
  /** profiles.id аккаунта-владельца — он же user_id для base_constructor_jobs. */
  client_user_id: string | null;
  /** Информационная цель месяца (не влияет на прогон, для дашборда). */
  monthly_target_companies: number;
  /** Потолок НОВЫХ компаний за прогон (суммарно по всем сегментам). */
  daily_limit: number;
  /** Минимум сработавших сигналов (0..6), чтобы компания пошла в конструктор. */
  signal_min_count: number;
  /** Шаги конструктора баз. ta_scoring/personalization/remove_support_emails вырезаются при загрузке. */
  selected_steps: string[];
  /** step_config для base_constructor_jobs (find_emails.stop_at_first, cap_emails_per_company.max, ...). */
  step_config: Record<string, unknown>;
  job_poll_timeout_minutes: number;
  updated_at?: string;
}

export interface GisSignalSegment {
  key: string;
  label: string;
  /** Кампания Instantly сегмента. NULL = сегмент меряется, но не заливается. */
  instantly_campaign_id: string | null;
  rubric_groups: GisSignalRubricGroup[];
  /**
   * true → в конструктор идут только компании с признаком онлайн-формата
   * на сайте (detectOutreachSignals с checkOnlineFormat). false/отсутствует
   * в старых строках → фильтр выключен.
   */
  require_online: boolean;
  priority: number;
  enabled: boolean;
}

/**
 * Конвертация рубрикатора сегмента (jsonb-форма из БД) в TwoGisRubricGroup
 * для фильтров iterateTwoGisCards.
 */
export function toTwoGisRubricGroups(groups: GisSignalRubricGroup[]): TwoGisRubricGroup[] {
  return (groups ?? []).map((g) => {
    const included = (g.includedSubcategories ?? []).filter(Boolean);
    if (included.length > 0) {
      return { category: g.category, mode: 'some', subcategories: included };
    }
    const excluded = (g.excludedSubcategories ?? []).filter(Boolean);
    if (excluded.length > 0) {
      return { category: g.category, mode: 'allExcept', excludedSubcategories: excluded };
    }
    return { category: g.category, mode: 'all' };
  });
}

/**
 * Читает конфиг id=1. Возвращает null, если строки нет или БД недоступна.
 * Жёстко фильтрует selected_steps от запрещённых шагов И сортирует по
 * каноническому приоритету (воркер выполняет в порядке массива, сам не сортирует).
 */
export async function loadGisSignalConfig(): Promise<GisSignalConfig | null> {
  if (!supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin
    .from('gis_signal_pipeline_config')
    .select('*')
    .eq('id', 1)
    .maybeSingle();
  if (error || !data) return null;

  const row = data as GisSignalConfig;
  const cleanedSteps = sortByPriority(
    (row.selected_steps ?? []).filter(
      (s) => !FORBIDDEN_STEPS.includes(s as (typeof FORBIDDEN_STEPS)[number]),
    ),
  );
  return {
    ...row,
    signal_min_count: Math.max(1, Number(row.signal_min_count ?? 1)),
    step_config: (row.step_config ?? {}) as Record<string, unknown>,
    selected_steps: cleanedSteps,
  };
}

/**
 * Активные сегменты (enabled=true), отсортированные по priority ASC —
 * порядок важен: при cross-segment дедупе компанию забирает ПЕРВЫЙ по
 * приоритету сегмент, чья рубрика её накрывает.
 */
export async function loadGisSignalSegments(): Promise<GisSignalSegment[]> {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from('gis_signal_segments')
    .select('*')
    .eq('enabled', true)
    .order('priority', { ascending: true });
  if (error || !data) return [];
  // Сортируем и в JS поверх SQL ORDER BY: порядок критичен (cross-segment
  // дедуп забирает компанию первым по приоритету сегментом) и не должен
  // молча зависеть от того, что БД отдала строки как попало.
  return (data as GisSignalSegment[])
    .map((s) => ({
      ...s,
      // Колонка появилась позже остальных: у старых строк её может не быть.
      require_online: s.require_online === true,
      rubric_groups: (s.rubric_groups ?? []) as GisSignalRubricGroup[],
    }))
    .sort((a, b) => a.priority - b.priority);
}
