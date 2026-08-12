/**
 * Общий конвертер рубрикатора 2GIS из jsonb-формы (как она хранится в БД:
 * gis_signal_segments.rubric_groups, outreachos_pipeline_config.gis_topup_rubric_groups)
 * в TwoGisRubricGroup для фильтров iterateTwoGisCards.
 *
 * Живёт в twoGis (а не в gisSignalOutreach), чтобы OutreachOS top-up мог
 * переиспользовать конвертер без импорта из gisSignalOutreach (изоляция:
 * outreachos → twoGis разрешён, outreachos → gisSignalOutreach — нет).
 */

import type { TwoGisRubricGroup } from './types';

/**
 * jsonb-форма группы рубрик: includedSubcategories задан → mode 'some';
 * иначе excludedSubcategories задан → mode 'allExcept'; иначе mode 'all'.
 */
export interface TwoGisRubricGroupConfig {
  category: string;
  includedSubcategories?: string[];
  excludedSubcategories?: string[];
}

/**
 * Конвертация jsonb-рубрикатора в TwoGisRubricGroup для фильтров
 * iterateTwoGisCards. included выигрывает у excluded, когда заданы оба.
 */
export function toTwoGisRubricGroups(
  groups: readonly TwoGisRubricGroupConfig[],
): TwoGisRubricGroup[] {
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
