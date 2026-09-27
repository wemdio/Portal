/**
 * Роутер цепочки, роутер кейса и скоринг 0–100 (RU_OUTREACH_HANDOFF §3.1, §3.3, §4.2).
 *
 * Выбор цепочки (v3, 25.09.2026): «Возврат» — жёсткое правило при записанном
 * разговоре в AMO. Остальные цепочки с подходящими поводами соревнуются по
 * баллу пригодности 0–100: сила повода 35, свежесть 20, доказательство 20,
 * кейс под отрасль 15, размер под оффер 10, второй повод той же цепочки +5.
 * При равенстве — порядок CEO. «Только профиль» — только при ЦА ≥ 7.
 * Затем сплит 50/50 (splitAutomation): половина подходящих компаний получает
 * «Автоматизированный аутрич»; скоринг при этом считается по исходной цепочке.
 *
 * Скоринг компании (сумма 100): сила сигнала 30, свежесть 15, ЦА-балл 20, B2B 10,
 * размер 10, сайт 5, кейс 5, почта 5. Порог из формы: от него пишем, ниже — пропуск.
 */

import type { CaseRecord } from './libraries';
import type { ChainType, IndustryGroup, Signal, SignalType } from './types';

const DAY = 86_400_000;

const STRENGTH: Record<ChainType, number> = {
  reactivation: 25,
  hiring: 30,
  ad_budget: 20,
  event: 25,
  growth_event: 20,
  icp_only: 0,
  // Сплит не участвует в скоринге: компания оценивается по своей цепочке.
  automation: 0,
};

/** Какой цепочке служит повод. Типы без записи (sales_hiring_broad, sales_team, crm_lost) цепочку не выбирают. */
const CHAIN_OF: Partial<Record<SignalType, Exclude<ChainType, 'reactivation' | 'icp_only'>>> = {
  sales_hiring: 'hiring',
  ad_running: 'ad_budget',
  trade_show_exhibitor: 'event',
  grant_or_accelerator: 'growth_event',
  contract_won: 'growth_event',
  tender_won: 'growth_event',
  revenue_growth: 'growth_event',
  investment: 'growth_event',
  product_launch: 'growth_event',
  new_region: 'growth_event',
  new_office: 'growth_event',
  new_production: 'growth_event',
  export_launch: 'growth_event',
  new_case: 'growth_event',
  partner_program: 'growth_event',
  dealer_search: 'growth_event',
};

/** Порядок CEO — только для равных баллов. «Автоматизация» сюда не входит: её даёт сплит. */
const CEO_ORDER: ChainType[] = ['reactivation', 'hiring', 'ad_budget', 'event', 'growth_event', 'icp_only'];

const CHAIN_SHORT: Record<ChainType, string> = {
  reactivation: 'возврат',
  hiring: 'найм',
  ad_budget: 'реклама',
  event: 'выставка',
  growth_event: 'рост',
  icp_only: 'профиль',
  automation: 'автоматизация',
};

export interface RouteInput {
  signals: Signal[];
  /** Давний отказ в AMO с записанным разговором. */
  reactivation: boolean;
  taScore: number;
  freshnessDays: number;
  revenue: number | null;
  employees: number | null;
  hasAdPixel: boolean;
  /** Есть ли утверждённый кейс под отрасль компании для этой цепочки. */
  hasCaseFor: (chain: ChainType) => boolean;
}

export interface Route {
  chain: ChainType;
  primary: Signal | null;
  /** Балл пригодности выбранной цепочки 0–100. */
  fit: number;
  /** Короткое «почему этот оффер» для таблицы. */
  reason: string;
  /** Второй вариант с баллом или null. */
  runnerUp: string | null;
  /** У «Автоматизации» — цепочка, которую компания получила бы без сплита. */
  from?: ChainType;
}

/** Цепочка до сплита 50/50: по ней скоринг, «возврат» и повод письма. */
export function baseChain(route: Route): ChainType {
  return route.from ?? route.chain;
}

/**
 * Какой цепочке служит повод; null — повод цепочку не выбирает. «Переписать
 * цепочку» по нему восстанавливает исходную цепочку «Автоматизации» из строки
 * журнала: главный повод строки выбрал именно её.
 */
export function chainOfSignal(type: SignalType): ChainType | null {
  return CHAIN_OF[type] ?? null;
}

/**
 * Признаки нескольких сегментов (INSTRUCTION_03 §9.1): продукты, регионы,
 * партнёры, дилеры, филиалы, отдел продаж, вакансии продаж.
 */
const SEGMENT_SIGNALS: Partial<Record<SignalType, string>> = {
  partner_program: 'партнёрская программа',
  dealer_search: 'ищет дилеров',
  new_region: 'новый регион',
  new_office: 'филиалы / новые точки',
  export_launch: 'экспорт',
  product_launch: 'новый продукт',
  sales_team: 'отдел продаж',
  sales_hiring: 'вакансия продаж',
  sales_hiring_broad: 'вакансия продаж',
};

export interface AutomationFitInput {
  signals: Signal[];
  reactivation: boolean;
  isB2b: boolean;
  /** Дословная цитата о рынке/клиентах — сегменты различимы. */
  marketQuote: string | null;
}

/**
 * Подходит ли компания под «Автоматизированный аутрич» (INSTRUCTION_03 §9):
 * B2B и либо был разговор в AMO, либо два независимых признака нескольких
 * сегментов. Возвращает «почему подходит» или null.
 */
export function automationFit(i: AutomationFitInput): string | null {
  if (!i.isB2b) return null;
  if (i.reactivation) return 'был разговор в AMO';
  const found = new Set<string>();
  for (const s of i.signals) {
    const label = SEGMENT_SIGNALS[s.type];
    if (label && s.level !== 'NONE') found.add(label);
  }
  if (i.marketQuote) found.add('рынок назван на сайте');
  return found.size >= 2 ? [...found].join(', ') : null;
}

/** Детерминированная половина по домену: повторный запуск кладёт компанию в ту же группу. */
export function automationHalf(domain: string): boolean {
  let h = 2166136261;
  for (const ch of domain.trim().toLowerCase()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2 === 0;
}

/**
 * Сплит 50/50 (решение 25.09.2026): подходящая компания из половины по домену
 * получает «Автоматизированный аутрич» вместо своей цепочки. SDR («найм») —
 * отдельный оффер Максима и в сплит не входит.
 */
export function splitAutomation(route: Route, domain: string, fit: AutomationFitInput): Route {
  if (route.chain === 'hiring') return route;
  const why = automationFit(fit);
  if (!why) return route;
  if (!automationHalf(domain)) return { ...route, reason: `${route.reason}; сплит 50/50: осталась своя цепочка` };
  return {
    ...route,
    chain: 'automation',
    from: route.chain,
    reason: `автоматизация (сплит 50/50 вместо «${CHAIN_SHORT[route.chain]}»): ${why}`,
    runnerUp: `${CHAIN_SHORT[route.chain]} ${route.fit}`,
  };
}

function ageDays(s: Signal | null, now: number): number | null {
  if (!s?.date) return null;
  const t = new Date(s.date).getTime();
  return Number.isFinite(t) ? (now - t) / DAY : null;
}

function freshnessPoints(s: Signal | null, chain: ChainType, freshnessDays: number, now: number): number {
  const age = ageDays(s, now);
  if (age === null) return 0;
  // Выставка впереди — лучшее окно для встреч; дальше 90 дней вперёд — слабее.
  if (chain === 'event' && age < 0) return age >= -90 ? 20 : 10;
  if (age <= 14) return 20;
  return age <= freshnessDays ? 10 : 0;
}

function evidencePoints(s: Signal | null): number {
  if (!s) return 0;
  const base = s.level === 'A' && s.quote ? 20 : s.level === 'A' || s.level === 'B' ? 10 : 0;
  return Math.max(0, base - (s.date ? 0 : 5));
}

/** Размер под оффер: неизвестный размер — нейтральные 5. */
function sizePoints(chain: ChainType, i: RouteInput): number {
  switch (chain) {
    case 'hiring':
      return i.employees == null ? 5 : i.employees >= 20 ? 10 : 0;
    case 'ad_budget':
      if (i.hasAdPixel || (i.revenue != null && i.revenue >= 30_000_000)) return 10;
      return i.revenue == null ? 5 : 0;
    case 'icp_only':
      return i.revenue == null ? 5 : i.revenue >= 100_000_000 ? 10 : 0;
    default:
      return 10;
  }
}

function strengthPoints(chain: ChainType, primary: Signal | null, taScore: number): number {
  let raw = STRENGTH[chain];
  if (chain === 'growth_event' && primary && !primary.date) raw = 15;
  if (chain === 'icp_only') raw = taScore >= 9 ? 20 : taScore >= 8 ? 15 : 10;
  return Math.round((raw / 30) * 35);
}

interface Candidate {
  chain: ChainType;
  primary: Signal | null;
  fit: number;
  parts: string;
}

function evaluate(chain: ChainType, signals: Signal[], i: RouteInput, now: number): Candidate {
  // Лучший повод цепочки — самый свежий и надёжный.
  const ranked = [...signals].sort(
    (a, b) =>
      freshnessPoints(b, chain, i.freshnessDays, now) + evidencePoints(b) - (freshnessPoints(a, chain, i.freshnessDays, now) + evidencePoints(a)),
  );
  // У найма цитата функции продаж сильнее голого названия должности, но берём её из уже отсортированных по свежести.
  const primary = chain === 'hiring' ? (ranked.find((s) => s.level === 'A') ?? ranked[0] ?? null) : (ranked[0] ?? null);
  const strength = strengthPoints(chain, primary, i.taScore);
  const fresh = chain === 'icp_only' ? 0 : freshnessPoints(primary, chain, i.freshnessDays, now);
  const evidence = evidencePoints(primary);
  const kase = chain === 'hiring' || i.hasCaseFor(chain) ? 15 : 0;
  const size = sizePoints(chain, i);
  const distinctFacts = new Set(signals.map((s) => s.title.trim().toLowerCase())).size;
  const extra = distinctFacts > 1 ? 5 : 0;
  const fit = Math.min(100, strength + fresh + evidence + kase + size + extra);
  const parts = [
    `повод ${strength}`,
    `свежесть ${fresh}`,
    `доказательство ${evidence}`,
    kase ? `кейс ${kase}` : 'без кейса',
    `размер ${size}`,
    ...(extra ? [`поводов ${distinctFacts}`] : []),
  ].join(', ');
  return { chain, primary, fit, parts };
}

export function routeChain(input: RouteInput): Route | null {
  const now = Date.now();
  const usable = input.signals.filter((s) => s.level === 'A' || s.level === 'B');
  if (input.reactivation) {
    const lost = usable.filter((s) => s.type === 'crm_lost').sort((a, b) => (ageDays(a, now) ?? 1e9) - (ageDays(b, now) ?? 1e9));
    return { chain: 'reactivation', primary: lost[0] ?? null, fit: 100, reason: 'возврат: был записанный разговор в AMO', runnerUp: null };
  }

  const byChain = new Map<ChainType, Signal[]>();
  for (const s of usable) {
    const chain = CHAIN_OF[s.type];
    if (!chain) continue;
    byChain.set(chain, [...(byChain.get(chain) ?? []), s]);
  }
  const candidates: Candidate[] = [];
  for (const chain of CEO_ORDER) {
    if (chain === 'reactivation') continue;
    if (chain === 'icp_only') {
      if (input.taScore >= 7) candidates.push(evaluate('icp_only', [], input, now));
      continue;
    }
    const list = byChain.get(chain);
    if (list?.length) candidates.push(evaluate(chain, list, input, now));
  }
  if (!candidates.length) return null;

  // Устойчивая сортировка по баллу: при равенстве остаётся порядок CEO.
  const ranked = [...candidates].sort((a, b) => b.fit - a.fit);
  const [best, second] = ranked;
  return {
    chain: best.chain,
    primary: best.primary,
    fit: best.fit,
    reason: `${CHAIN_SHORT[best.chain]} ${best.fit}: ${best.parts}`,
    runnerUp: second ? `${CHAIN_SHORT[second.chain]} ${second.fit}` : null,
  };
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
