/**
 * Роутер цепочки, роутер кейса и скоринг 0–100 (RU_OUTREACH_HANDOFF §3.1, §3.3, §4.2).
 *
 * Выбор цепочки (v3, 25.09.2026): «Возврат» — жёсткое правило при записанном
 * разговоре в AMO. Остальные цепочки с подходящими поводами соревнуются по
 * баллу пригодности 0–100: сила повода 35, свежесть 20, доказательство 20,
 * кейс под отрасль 15, размер под оффер 10, второй повод той же цепочки +5.
 * При равенстве — порядок CEO. «Только профиль» — только при ЦА ≥ 7.
 * Цепочка — повод письма; что предлагаем, с 29.10.2026 решает каскад продуктов
 * (cascade.ts), сплита 50/50 на «Автоматизированный аутрич» больше нет.
 *
 * Скоринг компании (сумма 100): сила сигнала 30, свежесть 15, ЦА-балл 20, B2B 10,
 * размер 10, сайт 5, кейс 5, почта 5. Порог из формы: от него пишем, ниже — пропуск.
 */

import type { Product } from './cascade';
import { rankCaseMatches, type CaseMatchContext } from '@/lib/outreachLlm/caseMatching';
import { caseAllowedForProduct, type CaseRecord } from './libraries';
import type { ChainType, IndustryGroup, Signal, SignalType } from './types';

const DAY = 86_400_000;

const STRENGTH: Record<ChainType, number> = {
  reactivation: 25,
  hiring: 30,
  ad_budget: 20,
  event: 25,
  growth_event: 20,
  icp_only: 0,
  // Цепочка строк до каскада (сплит 50/50), роутер её не выбирает.
  automation: 0,
};

/** Какой цепочке служит повод. Типы без записи (sales_team, crm_lost) цепочку не выбирают. */
const CHAIN_OF: Partial<Record<SignalType, Exclude<ChainType, 'reactivation' | 'icp_only'>>> = {
  sales_hiring: 'hiring',
  // Обычная вакансия продаж — тот же «найм», сила повода ниже (BROAD_HIRING_STRENGTH).
  sales_hiring_broad: 'hiring',
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

/** Сила повода «найм» по обычной вакансии продаж: строгий SDR — 30, обычная — 25. */
const BROAD_HIRING_STRENGTH = 25;

/** Порядок CEO — только для равных баллов. «Автоматизации» здесь нет: роутер её не выбирает. */
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
  /**
   * С какого ЦА-балла компания без повода идёт цепочкой «Только профиль».
   * С 14.10.2026 — ползунок «Похожесть на клиента» формы запуска (было жёстко 7:
   * своя база по ОКВЭД ЦА давала 42 готовых из 1969). Не задан — 7.
   */
  icpMinTa?: number;
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
  /**
   * У «Автоматизации» строк до каскада — цепочка, которую компания получила бы
   * без сплита 50/50 (восстанавливает «Переписать цепочку»). Роутер её не ставит.
   */
  from?: ChainType;
}

/** Цепочка до сплита 50/50 (строки до каскада): по ней «возврат» и повод письма. */
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
  if (chain === 'hiring' && primary?.type === 'sales_hiring_broad') raw = BROAD_HIRING_STRENGTH;
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
      if (input.taScore >= (input.icpMinTa ?? 7)) candidates.push(evaluate('icp_only', [], input, now));
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
  if (i.chain === 'hiring' && i.primary?.type === 'sales_hiring_broad') strength = BROAD_HIRING_STRENGTH;
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

/**
 * Кейс по отраслевой группе; только утверждённые и разрешённые для этой цепочки
 * (повода) или продукта каскада: в allowed_chains кейса — поводы и продукты,
 * пусто — везде.
 */
export function routeCase(
  cases: CaseRecord[],
  group: IndustryGroup | null,
  chain: ChainType,
  product: Product,
  context?: CaseMatchContext,
): { record: CaseRecord; reason: string } | null {
  const eligible = cases.filter((c) => c.cold_email !== false && caseAllowedForProduct(c, product)
    && (!c.allowed_chains.length || c.allowed_chains.includes(chain) || c.allowed_chains.includes(product)));
  if (context && product !== 'sdr') {
    const match = rankCaseMatches(eligible.map((c) => ({ ...c, id: c.case_id, groups: c.industry_groups, text: c.case_text_short, profiles: c.match_profiles })), group, context, 1)[0];
    if (match) return { record: match.record, reason: match.reason };
  }
  const hit = (group ? eligible.find((c) => c.industry_groups.includes(group)) : null)
    // SDR доказывает выход на роль; для него допустим проверенный пример из другой отрасли.
    ?? (product === 'sdr' ? eligible.find((c) => c.evidence_type === 'role_contact') : null);
  if (hit && (!context || product === 'sdr')) return { record: hit, reason: product === 'sdr' ? 'подтверждённый выход на роль' : `отраслевая группа «${group}»` };
  // При отсутствии близкого бизнеса показываем сильный результат того же продукта.
  // Для зарубежной классики сначала берём реальные зарубежные кампании.
  const foreign = product === 'classic_abroad' ? eligible.filter((c) => c.allowed_chains.includes('classic_abroad')) : [];
  const showcase = (foreign.length ? foreign : eligible).sort((a, b) =>
    (b.leads_count ?? 0) - (a.leads_count ?? 0) || a.case_id.localeCompare(b.case_id));
  if (!showcase.length) return null;
  let hash = 0;
  for (const ch of (context?.key ?? '').toLowerCase()) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const record = showcase[hash % Math.min(3, showcase.length)];
  return { record: { ...record, showcase: true }, reason: 'пример из другой сферы' };
}
