/**
 * Воронка английского аутрича по строкам журнала — одна на сервер и экран:
 * счётчики этапов считает роут результатов (api/parsers/polza-outreach/[jobId]/results),
 * а окно разбора этапа (PolzaOutreachStageModal) по тем же правилам делит строки
 * на «прошла» и «не прошла» — число в цепочке и список в окне обязаны совпадать.
 *
 * Этапы — в порядке шагов раннера. С 26.09.2026 почту ищут до разбора ИИ
 * (спека 2026-09-26-outreach-to-sender-design.md §2 EN): кандидаты → домен →
 * ICP и повторы → почта → Lead Score (write now) → письма. Ключи воронки
 * исторические: geo_confirmed — это «write now».
 *
 * Модуль без зависимостей: его импортирует и клиентский экран.
 */

import type { PolzaOutreachFunnel } from '@/types';

export type PolzaFunnelKey = keyof PolzaOutreachFunnel;

/** Порядок этапов на экране = порядок шагов раннера. */
export const POLZA_FUNNEL_ORDER: readonly PolzaFunnelKey[] = [
  'vacancies',
  'domain_found',
  'icp_passed',
  'email_found',
  'geo_confirmed',
  'ready',
];

/** Поля строки polza_outreach_companies, по которым считается воронка. */
export interface PolzaFunnelRow {
  status: string;
  stage?: string | null;
  normalized_domain?: string | null;
  selected_company_email?: string | null;
  review_reason?: string | null;
  lead_status?: string | null;
}

/** Колонки для выборки воронки — ровно поля PolzaFunnelRow. */
export const POLZA_FUNNEL_COLUMNS = 'status,stage,normalized_domain,selected_company_email,review_reason,lead_status';

/**
 * Стадии строки после ICP и повторов: прошедшая их строка дальше всегда
 * получает одну из них (почта → разбор → письма). Отсеянная на ICP или как
 * повтор между запусками остаётся на s3_icp.
 */
const PAST_ICP_STAGES: ReadonlySet<string> = new Set(['s5_email', 's4_analyzed', 's6_letters']);

/**
 * Прошла ли строка этап. Прошедшая этап прошла и все предыдущие: число
 * каждого этапа не больше предыдущего.
 */
export function passedFunnelStep(row: PolzaFunnelRow, key: PolzaFunnelKey): boolean {
  switch (key) {
    case 'vacancies':
      return true;
    case 'domain_found':
      return Boolean(row.normalized_domain);
    case 'icp_passed':
      return PAST_ICP_STAGES.has(String(row.stage ?? ''));
    case 'email_found':
      // Почта не проверена — строка задержана на почте (на ручную проверку,
      // без разбора ИИ), как отсеянная; адрес в ней есть, чтобы человек решил.
      return Boolean(row.selected_company_email) && row.review_reason !== 'email_unverified';
    case 'geo_confirmed':
      // write now ставит оценка после разбора; письма и лимит его не меняют.
      return row.lead_status === 'write_now';
    case 'ready':
      return row.status === 'ready';
  }
}

export function polzaFunnel(rows: readonly PolzaFunnelRow[]): PolzaOutreachFunnel {
  const funnel: PolzaOutreachFunnel = { vacancies: 0, domain_found: 0, icp_passed: 0, email_found: 0, geo_confirmed: 0, ready: 0 };
  for (const row of rows) {
    for (const key of POLZA_FUNNEL_ORDER) {
      if (passedFunnelStep(row, key)) funnel[key] += 1;
    }
  }
  return funnel;
}
