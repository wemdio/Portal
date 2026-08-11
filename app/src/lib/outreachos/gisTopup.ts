/**
 * OutreachOS 2GIS top-up — добор кандидатов из 2gis_dataset в дни недобора HH+SJ.
 * Дизайн: docs/design/2026-08-11-outreachos-2gis-topup.md (фазы 8t.1–8t.2 runner'а).
 *
 * ИЗОЛЯЦИЯ: импортирует ТОЛЬКО twoGis/* (разрешённое направление) и outreachos/*
 * (своё). НИ одного импорта из gisSignalOutreach: домены его seen-журнала
 * (gis_signal_seen_companies) читаем напрямую через supabaseAdmin, рубрикатор
 * конвертируем общим toTwoGisRubricGroups из twoGis/rubricGroups.
 *
 * Общий ключ между HH- и 2GIS-мирами — ДОМЕН сайта (deriveDomain): у карточки
 * 2GIS нет hh_employer_id, у HH-работодателя нет twogis_id.
 */

import 'server-only';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { deriveDomain } from '@/lib/jobs/hhAutoParser';
import { iterateTwoGisCards } from '@/lib/twoGis/repository';
import type { TwoGisCard, TwoGisRubricGroup } from '@/lib/twoGis/types';
import { GRID_HEADER } from './gridMapping';

export interface GisTopupCandidate {
  twogisId: string;
  name: string;
  site: string;
  cityName: string;
  category: string;
  subcategory: string;
}

/**
 * Исторический выход валидных контактов конструктора на компанию (HH-прогоны:
 * ~333 новых → ~155 валидных ≈ 0.45, замер 10.08 в дизайн-доке §1). Нужен,
 * чтобы пересчитать дефицит ЛИДОВ в число КОМПАНИЙ-кандидатов для pull'а.
 */
export const GIS_CONSTRUCTOR_YIELD = 0.45;
/**
 * Запас поверх расчётного дефицита: часть кандидатов вымрет на LLM-отсеве,
 * дедупе против своих кампаний и капе catch-all — тянем с overshoot, чтобы
 * добор реально добрал цель, а не «ровно столько, сколько нужно».
 */
export const GIS_PULL_OVERSHOOT = 1.3;
/**
 * Страховка от патологического полного скана датасета (4,3M карточек): если
 * исключающие множества съедают почти всю выдачу (пул под исчерпанием),
 * прекращаем скан после limit × N просканированных карточек — добор меньше
 * цели лучше, чем 20 минут фул-скана в «худом» дне.
 */
export const GIS_MAX_SCAN_MULTIPLIER = 25;

type Logger = (msg: string) => void;

/** Дефицит добора: сколько лидов не хватает до цели (target − kept HH+SJ). */
export function computeGisTopupDeficit(targetAppended: number, keptLeads: number): number {
  return Math.max(0, Math.trunc(targetAppended) - keptLeads);
}

/**
 * Лимит кандидатов 2GIS за прогон: min(cap, ceil(deficit / yield × overshoot)).
 * deficit<=0 или cap<=0 → 0 (топ-ап не запускается).
 */
export function computeGisPullLimit(deficit: number, dailyCap: number): number {
  if (deficit <= 0 || dailyCap <= 0) return 0;
  return Math.min(
    Math.trunc(dailyCap),
    Math.ceil((deficit / GIS_CONSTRUCTOR_YIELD) * GIS_PULL_OVERSHOOT),
  );
}

/**
 * НОВЫЙ кросс-пайплайнный рубеж (§4.1.2 дока): домены gis_signal_seen_companies
 * — компании, которым edu/remont-пайплайн УЖЕ писал (журнал «залитые навсегда»).
 * Без этого отсева компания получила бы второе письмо от OutreachOS.
 *
 * Все записи (окна нет — gis_signal seen не истекает), чанкованная range-
 * выборка по 1000 (PostgREST режет большие выборки — паттерн loadSuppression).
 * FAIL-CLOSED: сбой БД → null (топ-ап пропускаем с логом; пропущенный добор
 * лучше, чем повторное письмо компании, которой уже написал GIS-пайплайн).
 */
export async function loadGisSignalSeenDomains(): Promise<Set<string> | null> {
  if (!supabaseAdmin) return null;
  const db = supabaseAdmin;
  const domains = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('gis_signal_seen_companies')
      .select('domain')
      .range(from, from + PAGE - 1);
    if (error) return null; // fail-closed, см. шапку
    const rows = (data ?? []) as { domain: string | null }[];
    for (const r of rows) {
      if (r.domain) domains.add(r.domain.toLowerCase());
    }
    if (rows.length < PAGE) break;
  }
  return domains;
}

export interface GisTopupPullResult {
  candidates: GisTopupCandidate[];
  /** Карточек взято из потока после внутреннего дедупа (twogis_id + домен). */
  pulled: number;
  /** Отсеяно кросс-дедупом (домены seen outreachos + gis_signal + батч HH+SJ). */
  excludedDropped: number;
  /** Всего просканировано карточек потока (для диагностики выгорания пула). */
  scanned: number;
}

/**
 * 8t.1–8t.2(дедупы): стримит карточки 2GIS по рубрикатору (hasWebsite=true)
 * и набирает до limit компаний, применяя дедуп-матрицу §4.1 дока:
 *   (а-в) excludeDomains — объединённое множество доменов: seen-журнал
 *         OutreachOS (45д), gis_signal_seen_companies (все), домены сегодняшнего
 *         HH+SJ батча. Собирается runner'ом, сюда приходит готовым;
 *   (г)   внутри-прогонный дедуп по twogis_id И по домену (одна карточка может
 *         входить в несколько рубрик; разные карточки сети — один сайт).
 */
export async function pullGisTopupCandidates(opts: {
  rubricGroups: TwoGisRubricGroup[];
  limit: number;
  snapshotId: number;
  excludeDomains: ReadonlySet<string>;
  log?: Logger;
}): Promise<GisTopupPullResult> {
  const result: GisTopupPullResult = { candidates: [], pulled: 0, excludedDropped: 0, scanned: 0 };
  const limit = Math.trunc(opts.limit);
  if (limit <= 0 || opts.rubricGroups.length === 0) return result;

  const takenIds = new Set<string>();
  const takenDomains = new Set<string>();
  const maxScan = limit * GIS_MAX_SCAN_MULTIPLIER;

  outer: for await (const batch of iterateTwoGisCards(
    { rubricGroups: opts.rubricGroups, hasWebsite: true },
    { snapshotId: opts.snapshotId },
  )) {
    for (const card of batch) {
      result.scanned += 1;
      if (result.scanned > maxScan) break outer; // страховка, см. GIS_MAX_SCAN_MULTIPLIER
      if (!card.id || !card.website || takenIds.has(card.id)) continue;
      const domain = deriveDomain(card.website);
      if (!domain || takenDomains.has(domain)) continue;
      takenIds.add(card.id);
      takenDomains.add(domain);
      result.pulled += 1;
      if (opts.excludeDomains.has(domain)) {
        result.excludedDropped += 1;
        continue;
      }
      result.candidates.push(cardToCandidate(card));
      if (result.candidates.length >= limit) break outer;
    }
  }
  return result;
}

/** Маппинг карточки 2GIS → кандидат (как cardToCandidate в gisSignalOutreach/segments). */
function cardToCandidate(card: TwoGisCard): GisTopupCandidate {
  return {
    twogisId: card.id ?? '',
    name: card.name ?? '',
    site: card.website ?? '',
    cityName: card.city_name ?? '',
    category: card.category ?? '',
    subcategory: card.subcategory ?? '',
  };
}

/**
 * Кандидаты → сетка конструктора баз (тот же GRID_HEADER, что employersToGrid:
 * Компания/Сайт/Город/Email; Email пустой — заполнит find_emails).
 */
export function gisCandidatesToGrid(candidates: GisTopupCandidate[]): string[][] {
  const rows = candidates.map((c) => [c.name, c.site, c.cityName, '']);
  return [[...GRID_HEADER], ...rows];
}

/**
 * Контекст LLM-отсева для GIS-компаний (8t.4): у 2GIS нет HH-индустрий/описания/
 * вакансии — вместо них отдаём рубрики карточки как industries
 * ([category, subcategory]). Ключ мапы — домен сайта (как hhContext в runner).
 */
export function buildGisClassifyIndustries(
  candidates: readonly GisTopupCandidate[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of candidates) {
    const domain = deriveDomain(c.site);
    if (!domain || out.has(domain)) continue;
    const industries = [c.category, c.subcategory].map((s) => (s ?? '').trim()).filter(Boolean);
    out.set(domain, industries);
  }
  return out;
}

export interface GisSignalSeenRow {
  twogis_id: string;
  domain: string | null;
  company_name: string | null;
}

/**
 * §4.3 дока: журнал gis_signal_seen_companies («залитые навсегда») — пишем
 * ТОЛЬКО GIS-компании, чей ≥1 контакт реально ушёл в Instantly (at-least-once,
 * зеркально gisSignalOutreach/pipelineRunner шагу 5). Тогда edu/remont-пайплайн
 * видит контакт и не напишет второй раз.
 *
 * segment_key = NULL: компания пришла не из сегмента GIS-пайплайна (FK на
 * gis_signal_segments NULL допускает). Upsert ignore-duplicates по twogis_id —
 * повтор/гонка не перетирают first_seen_at. Своя реализация (НЕ импорт
 * gisSignalOutreach/seenCompanies — изоляция), паттерн ретраев как у markSeen.
 */
export async function markGisSignalSeen(rows: GisSignalSeenRow[]): Promise<void> {
  if (!supabaseAdmin || rows.length === 0) return;
  const db = supabaseAdmin;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK).map((r) => ({ ...r, segment_key: null }));
    let lastErr: string | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { error } = await db
        .from('gis_signal_seen_companies')
        .upsert(slice, { onConflict: 'twogis_id', ignoreDuplicates: true });
      if (!error) { lastErr = null; break; }
      lastErr = error.message;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 1000));
    }
    if (lastErr) throw new Error(`markGisSignalSeen upsert failed after retries: ${lastErr}`);
  }
}
