/**
 * Скоринг сегментов gisSignalOutreach (0–100) поверх сигнальных вердиктов.
 *
 * Сегменты со скоринг-профилем (сейчас — legal) квалифицируются НЕ по
 * signal_min_count, а по взвешенному скору: каждый сработавший сигнал даёт
 * свой вес, сумма весов профиля = 100. Скор ниже threshold — компания
 * нерелевантна и отбрасывается (архивируется, в конструктор не идёт).
 * Грейд по поясам bands (A/B/C) прокидывается в архив, сетку и лиды.
 *
 * Сегменты БЕЗ профиля — старое поведение (signalsCount >= signal_min_count).
 *
 * Чистые функции, без внешних вызовов. Реестр реэкспортируется из config.ts
 * для обнаруживаемости рядом с остальным конфигом пайплайна.
 */

import type { OutreachSignalSet } from './signals';

/** Пояс грейда: grade присваивается при score >= min. Отсортированы по min DESC. */
export interface ScoreBand {
  min: number;
  grade: string;
}

export interface SegmentScoringProfile {
  /** Веса по ключам сигналов; сумма = 100. */
  weights: Partial<Record<keyof OutreachSignalSet, number>>;
  /** Скор ниже порога → компания нерелевантна (отсев). */
  threshold: number;
  /** Пояса грейдов по убыванию min: первый подходящий выигрывает. */
  bands: ScoreBand[];
}

export interface SegmentScore {
  /** Взвешенный скор 0..100 (сумма весов сработавших сигналов). */
  score: number;
  /** Грейд по поясам; null — ниже threshold (нерелевантна). */
  grade: string | null;
}

/** Общие пояса грейдов (одинаковы во всех ТЗ): A=75–100, B=55–74, C=35–54. */
const STANDARD_BANDS: ScoreBand[] = [
  { min: 75, grade: 'A' },
  { min: 55, grade: 'B' },
  { min: 35, grade: 'C' },
];

/**
 * Реестр скоринг-профилей по ключу сегмента. Веса — дословно из ТЗ клиента,
 * сумма каждого профиля = 100 (проверяется тестом), порог отсева 35.
 *
 * Профили accounting/consulting добавлены 15.08.2026. Их специфика — четыре
 * новых сигнала (accountingRelevance, consultingRelevance, pricingPackages,
 * clientSegments, см. signals.ts); остальные веса ложатся на уже существующие
 * детекторы. Заметная разница с legal: у accounting вес вакансий ниже (10 vs 15),
 * зато появляются «упаковка услуги» (pricingPackages 10) и «работа с ИП/ООО/МСБ»
 * (clientSegments 5); у consulting вакансии, наоборот, весят 15.
 */
export const SEGMENT_SCORING_PROFILES: Record<string, SegmentScoringProfile> = {
  legal: {
    weights: {
      legalRelevance: 25,
      generalPhone: 10,
      contactForm: 10,
      salesDept: 20,
      targetVacancy: 15,
      highVolume: 10,
      multiOffice: 5,
      crmCalltracking: 5,
    },
    threshold: 35,
    bands: STANDARD_BANDS,
  },
  accounting: {
    weights: {
      accountingRelevance: 25,
      generalPhone: 10,
      contactForm: 10,
      salesDept: 20,
      targetVacancy: 10,
      pricingPackages: 10,
      highVolume: 5,
      clientSegments: 5,
      crmCalltracking: 5,
    },
    threshold: 35,
    bands: STANDARD_BANDS,
  },
  consulting: {
    weights: {
      consultingRelevance: 25,
      generalPhone: 10,
      contactForm: 10,
      salesDept: 20,
      targetVacancy: 15,
      highVolume: 10,
      multiOffice: 5,
      crmCalltracking: 5,
    },
    threshold: 35,
    bands: STANDARD_BANDS,
  },
};

/** Профиль сегмента или undefined — у сегментов без профиля старый фильтр. */
export function getSegmentScoringProfile(segmentKey: string): SegmentScoringProfile | undefined {
  return SEGMENT_SCORING_PROFILES[segmentKey];
}

/**
 * Взвешенный скор + грейд по профилю. grade=null при score < threshold —
 * такая компания отсеивается раннером (в конструктор не идёт).
 */
export function computeSegmentScore(
  profile: SegmentScoringProfile,
  signals: OutreachSignalSet,
): SegmentScore {
  let score = 0;
  for (const [key, weight] of Object.entries(profile.weights)) {
    if (signals[key as keyof OutreachSignalSet]?.hit) score += weight ?? 0;
  }
  if (score < profile.threshold) return { score, grade: null };
  const band = profile.bands.find((b) => score >= b.min);
  return { score, grade: band?.grade ?? null };
}
