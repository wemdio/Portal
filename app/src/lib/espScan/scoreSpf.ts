/**
 * Скоринг SPF-записи по словарю ESP.
 *
 * Score = сумма весов найденных marketing-ESP (см. espDictionary.ts).
 * Прочие категории (corporate/security/transactional/crm) матчатся и
 * сохраняются в matched — для фильтров и аналитики, но score не дают.
 */

import { ESP_DICTIONARY, type EspCategory } from './espDictionary';

export interface EspMatch {
  key: string;
  label: string;
  category: EspCategory;
  weight: number;
  /** Маркер, который сработал первым (для отладки/калибровки). */
  marker: string;
}

export interface SpfScoreResult {
  /** Сумма весов marketing-ESP. 0 = сигнала нет. */
  score: number;
  /** A ≥ 90, B ≥ 45 (платформа), C > 0 (только automation), null = 0. */
  grade: 'A' | 'B' | 'C' | null;
  matched: EspMatch[];
}

export const ESP_GRADE_THRESHOLDS = { A: 90, B: 45 } as const;

/** Матчит все словарные маркеры по сырой SPF-строке (подтверждённая механика Mailganer). */
export function matchEspInSpf(spf: string | null | undefined): EspMatch[] {
  if (!spf) return [];
  const lower = spf.toLowerCase();
  const matched: EspMatch[] = [];
  for (const entry of ESP_DICTIONARY) {
    for (const marker of entry.markers) {
      if (lower.includes(marker)) {
        matched.push({
          key: entry.key,
          label: entry.label,
          category: entry.category,
          weight: entry.weight,
          marker,
        });
        break; // один entry = один матч, даже если сработало несколько маркеров
      }
    }
  }
  return matched;
}

export function scoreSpf(spf: string | null | undefined): SpfScoreResult {
  const matched = matchEspInSpf(spf);
  const score = matched
    .filter((m) => m.category === 'marketing')
    .reduce((sum, m) => sum + m.weight, 0);
  const grade: SpfScoreResult['grade'] =
    score >= ESP_GRADE_THRESHOLDS.A
      ? 'A'
      : score >= ESP_GRADE_THRESHOLDS.B
        ? 'B'
        : score > 0
          ? 'C'
          : null;
  return { score, grade, matched };
}
