import type { SupabaseClient } from '@supabase/supabase-js';
import { isTransientDbError } from '@/lib/db/transientError';
import { isVeStageDbInterruption } from './stageDb';

/**
 * Журнал строк 2ГИС (ve_twogis_rows, миграция 20261026_0030; план 26.10, R3 часть 3б): один
 * домен сайта — одна строка на линию гипотезы проекта. Сначала claim здесь, потом запись
 * collect_info (одна на диспатч); повтор страницы узнаёт свои claim по base_id и card_id.
 * Обновляет только claimed-строки своей базы — в rejected при окончательном отказе
 * (markVeTwoGisOutcome, часть 3в); прочее — вставка без конфликтов, чтение и удаление claimed
 * своей базы при выходе (или чужой — когда её база уже не собирается). id не шлём
 * (identity), hypothesis_id шлём всегда, null тоже. Домены в ошибки и логи не попадают.
 */
export interface VeTwoGisLine { projectId: string; hypothesisId: string | null; baseId: string; snapshotId: number }
export interface VeTwoGisClaim { registrable_domain: string; host: string; card_id: string }
export interface VeTwoGisClaimResult { accepted: Set<string>; inserted: number; replayed: number; takenOver: number; held: number; duplicate: number }

export class VeTwoGisJournalError extends Error {
  readonly name = 'VeTwoGisJournalError';
  constructor(readonly step: 'input' | 'insert' | 'read' | 'owners' | 'takeover' | 'release' | 'outcome', readonly code: string,
    readonly transient: boolean) {
    super(`2ГИС журнал: ${step} ${code}`);
  }
}

const TABLE = 've_twogis_rows';
const ON_CONFLICT = 'project_id,hypothesis_id,registrable_domain';
const TIMEOUT_MS = 10_000;
const CHUNK_ROWS = 100;
const URL_BUDGET = 1800;
const LABELS = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

type Step = VeTwoGisJournalError['step'];
type Response<T> = { data: T | null; error: { code?: unknown; message?: unknown } | null; status?: number };

/** Один запрос: свой предел 10 с вместе с сигналом задачи. Отмена задачи — не ошибка журнала. */
async function step<T>(name: Step, signal: AbortSignal | undefined, run: (abort: AbortSignal) => PromiseLike<Response<T>>): Promise<T | null> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let response: Response<T>;
  try {
    response = await run(signal ? AbortSignal.any([signal, timeout]) : timeout);
  } catch (error) {
    response = { data: null, error: (error ?? {}) as Response<T>['error'], status: 0 };
  }
  // postgrest-js отдаёт отмену как {error, status: 0}.
  signal?.throwIfAborted();
  const error = response.error;
  if (!error) return response.data;
  const code = typeof error.code === 'string' && error.code ? error.code : timeout.aborted ? 'timeout' : 'error';
  throw new VeTwoGisJournalError(name, code, timeout.aborted || isTransientDbError(error, response.status)
    || isVeStageDbInterruption(String(error.message ?? '')));
}

/** Значения для in.(…) кусками: бюджет URL и не больше 100 значений (как chunkDomainsByUrlBudget в seenEmployers). */
function urlChunks(values: string[]): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const value of values) {
    // +3 = кавычки вокруг значения и запятая-разделитель внутри in.(…)
    const cost = encodeURIComponent(value).length + 3;
    if (current.length > 0 && (length + cost > URL_BUDGET || current.length >= CHUNK_ROWS)) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(value);
    length += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Вставка без конфликтов: возвращает домены, которые теперь наши. */
async function insertClaims(db: SupabaseClient, line: VeTwoGisLine, claims: VeTwoGisClaim[], signal?: AbortSignal): Promise<Set<string>> {
  const inserted = new Set<string>();
  for (let index = 0; index < claims.length; index += CHUNK_ROWS) {
    const rows = claims.slice(index, index + CHUNK_ROWS).map((claim) => ({ project_id: line.projectId,
      hypothesis_id: line.hypothesisId, base_id: line.baseId, registrable_domain: claim.registrable_domain, host: claim.host,
      card_id: claim.card_id, snapshot_id: line.snapshotId, outcome: 'claimed' }));
    const data = await step<Array<{ registrable_domain?: unknown }>>('insert', signal, (abort) => db.from(TABLE)
      .upsert(rows, { onConflict: ON_CONFLICT, ignoreDuplicates: true }).select('registrable_domain').abortSignal(abort));
    for (const row of data ?? []) if (typeof row.registrable_domain === 'string') inserted.add(row.registrable_domain);
  }
  return inserted;
}

async function deleteClaimed(db: SupabaseClient, name: Step, baseId: string, signal?: AbortSignal): Promise<void> {
  await step(name, signal, (abort) => db.from(TABLE).delete().eq('base_id', baseId).eq('outcome', 'claimed').abortSignal(abort));
}

/**
 * Заявки страницы. Своё (тот же card_id, claimed) — повтор: принято. Своё иначе — дубль.
 * Чужое claimed собирающейся базы и чужой итог — занято. claimed базы, которая уже не
 * собирается, — запоздалое освобождение за неё и одна повторная вставка. Линию без гипотезы
 * уникальный индекс собирающих баз не сериализует: там чужое claimed — всегда занято.
 */
export async function claimVeTwoGisRows(db: SupabaseClient, line: VeTwoGisLine, claims: VeTwoGisClaim[],
  signal?: AbortSignal): Promise<VeTwoGisClaimResult> {
  const result: VeTwoGisClaimResult = { accepted: new Set(), inserted: 0, replayed: 0, takenOver: 0, held: 0, duplicate: 0 };
  const byDomain = new Map<string, VeTwoGisClaim>();
  for (const claim of claims) {
    const domain = claim.registrable_domain;
    if (typeof domain !== 'string' || typeof claim.host !== 'string' || domain !== domain.toLowerCase()
      || claim.host !== claim.host.toLowerCase() || !LABELS.test(domain) || !LABELS.test(claim.host)
      || typeof claim.card_id !== 'string' || !claim.card_id.trim()) throw new VeTwoGisJournalError('input', 'invalid', false);
    if (!byDomain.has(domain)) byDomain.set(domain, claim);
  }
  if (!byDomain.size) return result;
  const unique = [...byDomain.values()];

  // C1: вставка.
  for (const domain of await insertClaims(db, line, unique, signal)) {
    result.accepted.add(domain);
    result.inserted += 1;
  }

  // C2: прочее — чьё оно.
  const rest = unique.map((claim) => claim.registrable_domain).filter((domain) => !result.accepted.has(domain));
  const owners = new Map<string, string[]>();
  const retry: string[] = [];
  for (const chunk of urlChunks(rest)) {
    const data = await step<Array<{ registrable_domain?: unknown; base_id?: unknown; card_id?: unknown; outcome?: unknown }>>(
      'read', signal, (abort) => {
        let query = db.from(TABLE).select('registrable_domain, base_id, card_id, outcome').eq('project_id', line.projectId);
        query = line.hypothesisId === null ? query.is('hypothesis_id', null) : query.eq('hypothesis_id', line.hypothesisId);
        return query.in('registrable_domain', chunk).abortSignal(abort);
      });
    const found = new Map((data ?? []).map((row) => [String(row.registrable_domain), row] as const));
    for (const domain of chunk) {
      const row = found.get(domain);
      if (!row) { retry.push(domain); continue; }
      const mine = String(row.base_id) === line.baseId;
      if (mine && row.outcome === 'claimed' && row.card_id === byDomain.get(domain)!.card_id) {
        result.accepted.add(domain);
        result.replayed += 1;
      } else if (mine) result.duplicate += 1;
      else if (row.outcome === 'claimed' && line.hypothesisId !== null) {
        const owner = String(row.base_id);
        owners.set(owner, [...owners.get(owner) ?? [], domain]);
      } else result.held += 1;
    }
  }

  // C3: владельцы, которые ещё собирают, держат свои claim.
  const dead: string[] = [];
  if (owners.size) {
    const collecting = new Set<string>();
    for (const chunk of urlChunks([...owners.keys()])) {
      const data = await step<Array<{ id?: unknown; status?: unknown }>>('owners', signal, (abort) =>
        db.from('ve_bases').select('id, status').in('id', chunk).abortSignal(abort));
      for (const row of data ?? []) if (row.status === 'collecting') collecting.add(String(row.id));
    }
    for (const [owner, domains] of owners) {
      if (collecting.has(owner)) result.held += domains.length;
      else dead.push(owner);
    }
  }

  // Запоздалое освобождение: тот же запрос, что пропустил выход владельца; одна повторная вставка, без цикла.
  const takeover = dead.flatMap((owner) => owners.get(owner)!);
  for (const owner of dead) await deleteClaimed(db, 'takeover', owner, signal);
  const again = [...takeover, ...retry];
  if (again.length) {
    const taken = await insertClaims(db, line, again.map((domain) => byDomain.get(domain)!), signal);
    const fromOwners = new Set(takeover);
    for (const domain of again) {
      if (!taken.has(domain)) { result.held += 1; continue; }
      result.accepted.add(domain);
      if (fromOwners.has(domain)) result.takenOver += 1; else result.inserted += 1;
    }
  }
  return result;
}

/** Выход базы из сбора: её claimed без итога освобождаются. Списка в URL нет. */
export async function releaseVeTwoGisClaims(db: SupabaseClient, baseId: string, signal?: AbortSignal): Promise<void> {
  await deleteClaimed(db, 'release', baseId, signal);
}

const DOMAIN_PAGE = 1000;

/** Домены, которые база держит claimed в журнале линии: страницами по 1000, по id. Домены наружу не логируются. */
export async function readVeTwoGisClaimedDomains(db: SupabaseClient, baseId: string, signal?: AbortSignal): Promise<Set<string>> {
  const domains = new Set<string>();
  for (let from = 0; ; from += DOMAIN_PAGE) {
    const data = await step<Array<{ registrable_domain?: unknown }>>('read', signal, (abort) => db.from(TABLE).select('registrable_domain')
      .eq('base_id', baseId).eq('outcome', 'claimed').order('id').abortSignal(abort).range(from, from + DOMAIN_PAGE - 1));
    const rows = data ?? [];
    for (const row of rows) if (typeof row.registrable_domain === 'string') domains.add(row.registrable_domain);
    if (rows.length < DOMAIN_PAGE) return domains;
  }
}

export type VeTwoGisRejectReason = 'site_unconfirmed' | 'ip_site' | 'owner_inn_excluded' | 'no_published_mailbox';

/**
 * Окончательный отказ по карточкам своей базы: claimed → rejected с причиной. Только claimed — итог не
 * переписывается, повтор безвреден. rejected переживает выход базы (удаляются только claimed): домен
 * закрыт для линии гипотезы. Пустой список — ни одного запроса. updated_at пишет модуль (миграция
 * 20261026_0030). Ключ — card_id: claim сделан по домену Ш5, а сайт строки мог переписаться.
 */
export async function markVeTwoGisOutcome(db: SupabaseClient, baseId: string, cardIds: readonly string[], outcome: 'rejected',
  reason: VeTwoGisRejectReason, signal?: AbortSignal): Promise<void> {
  const cards = [...new Set(cardIds.filter((card) => typeof card === 'string' && card.trim() !== ''))];
  if (!cards.length) return;
  const updatedAt = new Date().toISOString();
  for (const chunk of urlChunks(cards)) {
    await step('outcome', signal, (abort) => db.from(TABLE).update({ outcome, reason, updated_at: updatedAt })
      .eq('base_id', baseId).eq('outcome', 'claimed').in('card_id', chunk).abortSignal(abort));
  }
}
