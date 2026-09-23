/**
 * Поводы и Lead Score v1 английского аутрича (en-outreach-flow-improvements §3).
 *
 * Четыре блока, сумма 100:
 *   Company fit до 40 — B2B SaaS/service/platform 15, понятный ICP 10,
 *                       дорогая сделка 10, не агентство/стаффинг/B2C 5;
 *   Firmographic до 25 — 3–10 чел. 5, 11–50 — 15, 51–200 — 20; страна из списка CEO 5;
 *   Trigger до 25     — найм sales/GTM 15, YC 15, запуск продукта 10, стек продаж 5;
 *   Data quality до 10 — сайт 3, корпоративная почта 3, описание 2, ссылка на повод 2.
 * Статус: ≥75 write now, 55–74 manual check, ниже — skip (пороги из формы).
 */

import { POLZA_OUTREACH_PRIORITY_COUNTRIES } from './types';

export type TriggerType = 'hiring' | 'yc' | 'launch' | 'tech_stack';

export interface Trigger {
  type: TriggerType;
  /** Должность, батч YC, цитата о запуске, список инструментов. */
  title: string;
  url: string | null;
  date: string | null;
  /** Дословная цитата-доказательство, если есть. */
  quote: string | null;
}

const TRIGGER_POINTS: Record<TriggerType, number> = { hiring: 15, yc: 15, launch: 10, tech_stack: 5 };

export interface ScoreInput {
  isB2b: boolean;
  businessModel: 'saas' | 'service' | 'platform' | 'other';
  icpClear: boolean;
  highValue: boolean;
  excluded: boolean;
  employees: number | null;
  countryCode: string | null;
  triggers: Trigger[];
  hasSite: boolean;
  hasEmail: boolean;
  hasDescription: boolean;
}

export interface LeadScore {
  total: number;
  dataQuality: number;
  breakdown: { fit: number; firmographic: number; trigger: number; data_quality: number };
}

/** PDL-корзина размера → середина диапазона (для правила 3–200). */
export function employeesFromBucket(bucket: string | null): number | null {
  if (!bucket) return null;
  const m = bucket.match(/^(\d+)-(\d+)$/);
  if (m) return Math.round((Number(m[1]) + Number(m[2])) / 2);
  const plus = bucket.match(/^(\d+)\+$/);
  return plus ? Number(plus[1]) : null;
}

export function scoreLead(i: ScoreInput): LeadScore {
  const fit =
    (i.isB2b && i.businessModel !== 'other' ? 15 : i.isB2b ? 8 : 0) +
    (i.icpClear ? 10 : 0) +
    (i.highValue ? 10 : 0) +
    (!i.excluded && i.isB2b ? 5 : 0);

  let size = 0;
  if (i.employees != null) {
    if (i.employees >= 51 && i.employees <= 200) size = 20;
    else if (i.employees >= 11 && i.employees <= 50) size = 15;
    else if (i.employees >= 3 && i.employees <= 10) size = 5;
  }
  const country = i.countryCode && (POLZA_OUTREACH_PRIORITY_COUNTRIES as readonly string[]).includes(i.countryCode) ? 5 : 0;
  const firmographic = Math.min(25, size + country);

  const types = new Set(i.triggers.map((t) => t.type));
  const trigger = Math.min(25, Array.from(types).reduce((sum, t) => sum + TRIGGER_POINTS[t], 0));

  const dataQuality =
    (i.hasSite ? 3 : 0) + (i.hasEmail ? 3 : 0) + (i.hasDescription ? 2 : 0) + (i.triggers.some((t) => t.url) ? 2 : 0);

  return {
    total: fit + firmographic + trigger + dataQuality,
    dataQuality,
    breakdown: { fit, firmographic, trigger, data_quality: dataQuality },
  };
}

export type LeadStatus = 'write_now' | 'manual_check' | 'skip';

export function leadStatus(total: number, t: { write: number; review: number }): LeadStatus {
  if (total >= t.write) return 'write_now';
  if (total >= t.review) return 'manual_check';
  return 'skip';
}

/** Главный повод: найм и YC — «очень сильные», затем запуск, затем стек. */
export function primaryTrigger(triggers: Trigger[]): Trigger | null {
  const order: TriggerType[] = ['hiring', 'yc', 'launch', 'tech_stack'];
  for (const type of order) {
    const hit = triggers.find((t) => t.type === type);
    if (hit) return hit;
  }
  return null;
}
