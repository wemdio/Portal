/**
 * Роутер цепочки, роутер кейса и скоринг 0–100 (RU_OUTREACH_HANDOFF §3.1, §3.3, §4.2).
 *
 * Тип цепочки — по главному поводу, в порядке CEO:
 *   reactivation → hiring → ad_budget → event → growth_event → icp_only (ЦА ≥ 7).
 * Нет повода и ЦА < 7 — цепочку не собираем.
 *
 * Скоринг (сумма 100): сила сигнала 30, свежесть 15, ЦА-балл 20, B2B 10,
 * размер 10, сайт 5, кейс 5, почта 5. Один порог из формы: от него пишем,
 * ниже — пропуск (ручную проверку CEO убрал 23.09.2026).
 */

import type { CaseRecord } from './libraries';
import type { ChainType, IndustryGroup, Signal, SignalType } from './types';

const DAY = 86_400_000;

const GROWTH_TYPES = new Set<SignalType>([
  'grant_or_accelerator', 'contract_won', 'product_launch', 'new_region', 'new_office', 'new_production',
  'export_launch', 'new_case', 'partner_program', 'dealer_search',
]);

const STRENGTH: Record<ChainType, number> = {
  reactivation: 25,
  hiring: 30,
  ad_budget: 20,
  event: 25,
  growth_event: 20,
  icp_only: 0,
};

export interface RouteInput {
  signals: Signal[];
  /** Давний отказ в AMO с записанным разговором. */
  reactivation: boolean;
  taScore: number;
}

export interface Route {
  chain: ChainType;
  primary: Signal | null;
}

function freshest(signals: Signal[]): Signal | null {
  return [...signals].sort((a, b) => (b.date ? new Date(b.date).getTime() : 0) - (a.date ? new Date(a.date).getTime() : 0))[0] ?? null;
}

export function routeChain(input: RouteInput): Route | null {
  const usable = input.signals.filter((s) => s.level === 'A' || s.level === 'B');
  const of = (pred: (s: Signal) => boolean) => usable.filter(pred);
  if (input.reactivation) return { chain: 'reactivation', primary: freshest(of((s) => s.type === 'crm_lost')) };
  const hiring = of((s) => s.type === 'sales_hiring');
  if (hiring.length) {
    // Цитата функции продаж сильнее голого названия должности.
    return { chain: 'hiring', primary: hiring.find((s) => s.level === 'A') ?? freshest(hiring) };
  }
  const ads = of((s) => s.type === 'ad_running');
  if (ads.length) return { chain: 'ad_budget', primary: freshest(ads) };
  const events = of((s) => s.type === 'trade_show_exhibitor');
  if (events.length) return { chain: 'event', primary: freshest(events) };
  const growth = of((s) => GROWTH_TYPES.has(s.type));
  if (growth.length) {
    // Датированное событие сильнее постоянной страницы «Партнёрам».
    const dated = growth.filter((s) => s.date);
    return { chain: 'growth_event', primary: freshest(dated.length ? dated : growth) };
  }
  if (input.taScore >= 7) return { chain: 'icp_only', primary: null };
  return null;
}

export interface ScoreInput {
  chain: ChainType;
  primary: Signal | null;
  freshnessDays: number;
  taScore: number;
  isB2b: boolean;
  revenue: number | null;
  employees: number | null;
  hasAdPixel: boolean;
  siteReachable: boolean;
  hasCase: boolean;
  emailFound: boolean;
}

export interface Score {
  total: number;
  parts: Record<string, number>;
}

export function scoreCompany(i: ScoreInput): Score {
  const now = Date.now();
  let strength = STRENGTH[i.chain];
  if (i.chain === 'growth_event' && i.primary && !i.primary.date) strength = 15;
  // У «Только профиль» повода нет: его «сигнал» — само сходство с клиентом Polza.
  // Без этого цепочка из таблицы CEO никогда не дотягивала бы до порогов.
  if (i.chain === 'icp_only') strength = i.taScore >= 9 ? 20 : i.taScore >= 8 ? 15 : 10;
  const age = i.primary?.date ? (now - new Date(i.primary.date).getTime()) / DAY : null;
  let freshness = age === null ? 0 : age <= 14 ? 15 : age <= i.freshnessDays ? 8 : 0;
  // Выставка впереди — лучшее окно для встреч (SPEC §4.1).
  if (i.chain === 'event' && age !== null && age < 0) freshness = 15;
  // Давний отказ и профиль — повод не по дате, свежесть нейтральная.
  if (i.chain === 'reactivation' || i.chain === 'icp_only') freshness = 8;

  let size = 0;
  if (i.revenue != null) size += i.revenue >= 1_000_000_000 ? 7 : i.revenue >= 100_000_000 ? 5 : i.revenue >= 30_000_000 ? 3 : 0;
  if (i.employees != null && i.employees >= 20) size += 3;
  if (i.hasAdPixel) size += 2;
  size = Math.min(10, size);

  const parts = {
    signal: strength,
    freshness,
    ta: Math.max(0, Math.min(20, i.taScore * 2)),
    b2b: i.isB2b ? 10 : 0,
    size,
    site: i.siteReachable ? 5 : 0,
    case: i.hasCase ? 5 : 0,
    email: i.emailFound ? 5 : 0,
  };
  return { total: Object.values(parts).reduce((a, b) => a + b, 0), parts };
}

export type Decision = 'write' | 'skip';

export function decide(total: number, writeThreshold: number): Decision {
  return total >= writeThreshold ? 'write' : 'skip';
}

/** Кейс по отраслевой группе; только утверждённые и разрешённые для этой цепочки. */
export function routeCase(cases: CaseRecord[], group: IndustryGroup | null, chain: ChainType): { record: CaseRecord; reason: string } | null {
  // SDR-цепочке отраслевой кейс не подбираем: доказательство там — роли, до
  // которых доходили в клиентских кампаниях, и только с апрувом
  // (SDR_ENTERPRISE_PROOF_AND_OFFER_ROUTING §2).
  if (!group || chain === 'hiring') return null;
  const hit = cases.find((c) => c.industry_groups.includes(group) && (!c.allowed_chains.length || c.allowed_chains.includes(chain)));
  return hit ? { record: hit, reason: `отраслевая группа «${group}»` } : null;
}
