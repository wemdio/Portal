import { heCompanySiteIdentity, normalizeCompanyForDedup } from './collectionIdentity';
import type { HeEngBaseBudgetSnapshot } from './engBaseBudgetLedger';

/** Targets count checked, qualified, unique addresses, never source candidates. */
export const HE_ENG_READY_CONTACT_TARGET = 500;
export const HE_ENG_RESERVE_CONTACT_DEFAULT = 0;
/** Historical paid-reserve checkpoints remain readable; new runs do not buy one. */
export const HE_ENG_RESERVE_CONTACT_MIN = 2_000;
export const HE_ENG_RESERVE_CONTACT_MAX = 5_000;
export const HE_ENG_COLLECTION_MAX_ROUNDS = 100;
export const HE_ENG_COLLECTION_MAX_CANDIDATES = 20_000;

export type HeEngCollectionStopReason =
  | 'budget_limit' | 'sources_exhausted' | 'low_yield' | 'safety_limit' | 'error';

/** Safe counters for the client. Contact rows and round identifiers stay private. */
export interface HeEngCollectionTarget {
  version: 1;
  ready_target: typeof HE_ENG_READY_CONTACT_TARGET;
  reserve_target: number;
  ready_count: number;
  reserve_count: number;
  total_ready: number;
  phase: 'collecting' | 'building_reserve' | 'complete' | 'stopped';
  stop_reason: HeEngCollectionStopReason | null;
  rounds_completed: number;
}

export type HeEngCollectionRow = Record<string, unknown>;

export interface HeEngCollectionRound {
  id: string;
  candidates_processed: number;
  /** Net new unique, deliverable contacts after the global company cap. */
  contacts_added: number;
}

/**
 * Private collect_info.eng_collection_pool checkpoint. Keep this out of the
 * client projection. Only readyRows may be written to he_bases.data: launch
 * consumers read every row there and have no notion of a reserve marker.
 */
export interface HeEngCollectionPool {
  version: 1;
  max_emails_per_company: number;
  candidates_processed: number;
  rows: HeEngCollectionRow[];
  rounds: HeEngCollectionRound[];
}

export interface HeEngCollectionPartition {
  readyRows: HeEngCollectionRow[];
  reserveRows: HeEngCollectionRow[];
}

export interface HeEngCollectionCheckpoint extends HeEngCollectionPartition {
  target: HeEngCollectionTarget;
  pool: HeEngCollectionPool;
}

function integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertReserveTarget(value: number): void {
  if (value !== 0 && !integer(value, HE_ENG_RESERVE_CONTACT_MIN, HE_ENG_RESERVE_CONTACT_MAX)) {
    throw new Error('ENG collection: reserve target must be zero or a historical target between 2000 and 5000');
  }
}

/** A zero reserve target never means that an empty or partial base is complete. */
export function heEngCollectionTargetPhase(
  readyCount: number, reserveCount: number, reserveTarget: number,
): 'collecting' | 'building_reserve' | 'complete' {
  return readyCount < HE_ENG_READY_CONTACT_TARGET ? 'collecting'
    : reserveCount >= reserveTarget ? 'complete' : 'building_reserve';
}

/**
 * Apply only at a completed-wave boundary, after retaining paid results. The
 * pool, counters and history are unchanged; an old terminal record is history,
 * not an instruction to resume or rewrite that collection.
 */
export function applyHeEngReadyOnlyTargetPolicy(target: HeEngCollectionTarget): HeEngCollectionTarget {
  if (target.phase === 'complete' || target.phase === 'stopped' || target.reserve_target === 0) return target;
  return { ...target, reserve_target: 0,
    phase: heEngCollectionTargetPhase(target.ready_count, target.reserve_count, 0) };
}

function assertCompanyCap(value: number): void {
  if (!integer(value, 1, 100)) throw new Error('ENG collection: invalid company contact cap');
}

export function createHeEngCollectionTarget(
  input: { reserveTarget?: number } = {},
): HeEngCollectionTarget {
  const reserveTarget = input.reserveTarget ?? HE_ENG_RESERVE_CONTACT_DEFAULT;
  assertReserveTarget(reserveTarget);
  return {
    version: 1, ready_target: HE_ENG_READY_CONTACT_TARGET, reserve_target: reserveTarget,
    ready_count: 0, reserve_count: 0, total_ready: 0, phase: 'collecting',
    stop_reason: null, rounds_completed: 0,
  };
}

export function createHeEngCollectionPool(
  input: { maxEmailsPerCompany?: number } = {},
): HeEngCollectionPool {
  const cap = input.maxEmailsPerCompany ?? 5;
  assertCompanyCap(cap);
  return { version: 1, max_emails_per_company: cap, candidates_processed: 0, rows: [], rounds: [] };
}

/** Constructor rows have exactly one email per row; do not split unverified cells. */
function contact(row: HeEngCollectionRow): { email: string; status: 'ok' | 'catch_all' } | null {
  const email = typeof row.email === 'string' ? row.email.trim().toLowerCase() : '';
  const status = typeof row._email_status === 'string' ? row._email_status.trim().toLowerCase() : '';
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email) ||
      (status !== 'ok' && status !== 'catch_all') || row._low_relevance === true) return null;
  return { email, status };
}

function companyKey(row: HeEngCollectionRow, email: string, rootSites: ReadonlySet<string>): string {
  const site = heCompanySiteIdentity(row.website);
  // Names and www variants cannot reset a cap. Only join a subdomain to the
  // root when that root is actually present; two hosted tenants must not be
  // collapsed merely because their sites share an eTLD+1 (same ENG identity
  // rule as collectionIdentity.ts).
  if (site) return `site:${rootSites.has(site.registrable) ? site.registrable : site.host}`;
  const name = typeof row.company === 'string' ? normalizeCompanyForDedup(row.company) : '';
  return name ? `name:${name}` : `email:${email}`;
}

/**
 * Caller has already checked company fit, countries, DNC and source ownership.
 * This helper does not replace those checks. It enforces the final email gate,
 * deduplication and one company cap across ALL completed rounds. OK addresses
 * outrank catch-all globally, including a later OK verdict for the same email.
 */
export function partitionHeEngCollectionRows(
  rows: readonly HeEngCollectionRow[],
  input: { maxEmailsPerCompany?: number } = {},
): HeEngCollectionPartition {
  const cap = input.maxEmailsPerCompany ?? 5;
  assertCompanyCap(cap);
  const candidates = rows.flatMap((row) => {
    const parsed = contact(row);
    return parsed ? [{ row, ...parsed }] : [];
  }).sort((a, b) => Number(b.status === 'ok') - Number(a.status === 'ok'));
  const rootSites = new Set(candidates.flatMap(({ row }) => {
    const site = heCompanySiteIdentity(row.website);
    return site && site.host === site.registrable ? [site.host] : [];
  }));
  const emails = new Set<string>();
  const companies = new Map<string, number>();
  const accepted: HeEngCollectionRow[] = [];
  for (const candidate of candidates) {
    if (emails.has(candidate.email)) continue;
    const key = companyKey(candidate.row, candidate.email, rootSites);
    const count = companies.get(key) ?? 0;
    if (count >= cap) continue;
    emails.add(candidate.email);
    companies.set(key, count + 1);
    accepted.push({ ...candidate.row, email: candidate.email, _email_status: candidate.status });
    if (accepted.length === HE_ENG_READY_CONTACT_TARGET + HE_ENG_RESERVE_CONTACT_MAX) break;
  }
  return {
    readyRows: accepted.slice(0, HE_ENG_READY_CONTACT_TARGET),
    reserveRows: accepted.slice(HE_ENG_READY_CONTACT_TARGET),
  };
}

const STOP_REASONS = new Set<HeEngCollectionStopReason>([
  'budget_limit', 'sources_exhausted', 'low_yield', 'safety_limit', 'error',
]);

/** Corrupt/mismatched progress must never silently restart paid collection. */
export function readHeEngCollectionCheckpoint(
  rawTarget: unknown,
  rawPool: unknown,
): HeEngCollectionCheckpoint {
  const fail = (): never => { throw new Error('ENG collection: invalid saved target or contact pool'); };
  if (!record(rawTarget) || !record(rawPool) || rawTarget.version !== 1 || rawPool.version !== 1 ||
      rawTarget.ready_target !== HE_ENG_READY_CONTACT_TARGET ||
      (rawTarget.reserve_target !== 0 && !integer(rawTarget.reserve_target, HE_ENG_RESERVE_CONTACT_MIN, HE_ENG_RESERVE_CONTACT_MAX)) ||
      !integer(rawPool.max_emails_per_company, 1, 100) ||
      !integer(rawPool.candidates_processed, 0, HE_ENG_COLLECTION_MAX_CANDIDATES) ||
      !Array.isArray(rawPool.rows) || !rawPool.rows.every(record) ||
      rawPool.rows.length > HE_ENG_READY_CONTACT_TARGET + HE_ENG_RESERVE_CONTACT_MAX ||
      !Array.isArray(rawPool.rounds) || rawPool.rounds.length > HE_ENG_COLLECTION_MAX_ROUNDS) return fail();
  const ids = new Set<string>();
  let candidates = 0;
  for (const round of rawPool.rounds) {
    if (!record(round) || typeof round.id !== 'string' || !round.id || round.id.length > 200 || ids.has(round.id) ||
        !integer(round.candidates_processed, 0, HE_ENG_COLLECTION_MAX_CANDIDATES) ||
        !integer(round.contacts_added, 0, HE_ENG_READY_CONTACT_TARGET + HE_ENG_RESERVE_CONTACT_MAX)) return fail();
    ids.add(round.id);
    candidates += round.candidates_processed;
  }
  if (candidates !== rawPool.candidates_processed) return fail();
  const partition = partitionHeEngCollectionRows(rawPool.rows, { maxEmailsPerCompany: rawPool.max_emails_per_company });
  const ready = partition.readyRows.length;
  const reserve = partition.reserveRows.length;
  if (ready + reserve !== rawPool.rows.length || rawTarget.ready_count !== ready ||
      rawTarget.reserve_count !== reserve || rawTarget.total_ready !== ready + reserve ||
      rawTarget.rounds_completed !== ids.size) return fail();
  const expectedPhase = heEngCollectionTargetPhase(ready, reserve, rawTarget.reserve_target as number);
  if (rawTarget.phase === 'stopped') {
    if (!STOP_REASONS.has(rawTarget.stop_reason as HeEngCollectionStopReason)) return fail();
  } else if (rawTarget.phase !== expectedPhase || rawTarget.stop_reason !== null) return fail();
  return {
    target: rawTarget as unknown as HeEngCollectionTarget,
    pool: rawPool as unknown as HeEngCollectionPool,
    ...partition,
  };
}

export function stopHeEngCollectionTarget(
  target: HeEngCollectionTarget,
  reason: HeEngCollectionStopReason,
): HeEngCollectionTarget {
  if (!STOP_REASONS.has(reason)) throw new Error('ENG collection: invalid stop reason');
  // An unknown charge/provider outcome is still a problem when the contact
  // count happens to meet the goal. Never hide it behind a successful target.
  return target.phase === 'complete' && reason !== 'error'
    ? target : { ...target, phase: 'stopped', stop_reason: reason };
}

/** A read-only snapshot can stop planning, but cannot authorize a paid request. */
function budgetStop(budget: HeEngBaseBudgetSnapshot | undefined): HeEngCollectionStopReason | null {
  if (!budget) return null; // The existing per-request ledger remains mandatory.
  if (budget.limitMicrousd !== 5_000_000 ||
      !integer(budget.actualMicrousd, 0, Number.MAX_SAFE_INTEGER) ||
      !integer(budget.reservedMicrousd, 0, Number.MAX_SAFE_INTEGER) ||
      !Number.isSafeInteger(budget.actualMicrousd + budget.reservedMicrousd)) return 'error';
  if (budget.holdReason && budget.holdReason !== 'budget_exhausted') return 'error';
  if (budget.holdReason === 'budget_exhausted' ||
      budget.actualMicrousd + budget.reservedMicrousd >= budget.limitMicrousd) return 'budget_limit';
  return null;
}

/** Small initial batches; adapt to actual accepted-address yield, never raw rows. */
export function nextHeEngCollectionBatchSize(input: {
  target: HeEngCollectionTarget; pool: HeEngCollectionPool;
}): number {
  const { target, pool } = input;
  if (target.phase === 'complete' || target.phase === 'stopped' ||
      pool.rounds.length >= HE_ENG_COLLECTION_MAX_ROUNDS) return 0;
  const remainingCandidates = HE_ENG_COLLECTION_MAX_CANDIDATES - pool.candidates_processed;
  if (remainingCandidates <= 0) return 0;
  const recent = pool.rounds.slice(-3);
  const examined = recent.reduce((n, round) => n + round.candidates_processed, 0);
  const accepted = recent.reduce((n, round) => n + round.contacts_added, 0);
  const remainingContacts = target.phase === 'collecting'
    ? target.ready_target - target.ready_count : target.reserve_target - target.reserve_count;
  const desired = examined > 0 && accepted > 0
    ? Math.ceil(remainingContacts / (accepted / examined)) : 100;
  return Math.min(remainingCandidates, Math.max(50, Math.min(200, desired)));
}

export function appendHeEngCollectionRound(input: {
  target: HeEngCollectionTarget;
  pool: HeEngCollectionPool;
  roundId: string;
  qualifiedRows: readonly HeEngCollectionRow[];
  candidatesProcessed: number;
  /** True only when all allowed discovery routes are exhausted, not one slice. */
  sourcesExhausted?: boolean;
  stopReason?: HeEngCollectionStopReason;
  budget?: HeEngBaseBudgetSnapshot;
  /** New ENG policy; finish the already-started wave, then stop at 500 ready. */
  readyOnly?: boolean;
}): HeEngCollectionCheckpoint & { duplicateRound: boolean; nextBatchSize: number } {
  const saved = readHeEngCollectionCheckpoint(input.target, input.pool);
  if (saved.pool.rounds.some((round) => round.id === input.roundId)) {
    return { ...saved, duplicateRound: true, nextBatchSize: nextHeEngCollectionBatchSize(saved) };
  }
  if (saved.target.phase === 'complete' || saved.target.phase === 'stopped') {
    throw new Error('ENG collection: cannot append to a terminal target');
  }
  if (typeof input.roundId !== 'string' || !input.roundId || input.roundId.length > 200 ||
      !integer(input.candidatesProcessed, 0, HE_ENG_COLLECTION_MAX_CANDIDATES) ||
      saved.pool.candidates_processed + input.candidatesProcessed > HE_ENG_COLLECTION_MAX_CANDIDATES ||
      saved.pool.rounds.length >= HE_ENG_COLLECTION_MAX_ROUNDS) {
    throw new Error('ENG collection: invalid round or safety limit exceeded');
  }
  const partition = partitionHeEngCollectionRows([...saved.pool.rows, ...input.qualifiedRows], {
    maxEmailsPerCompany: saved.pool.max_emails_per_company,
  });
  const rows = [...partition.readyRows, ...partition.reserveRows];
  const pool: HeEngCollectionPool = {
    ...saved.pool, rows, candidates_processed: saved.pool.candidates_processed + input.candidatesProcessed,
    rounds: [...saved.pool.rounds, {
      id: input.roundId, candidates_processed: input.candidatesProcessed,
      contacts_added: Math.max(0, rows.length - saved.pool.rows.length),
    }],
  };
  let target: HeEngCollectionTarget = {
    ...saved.target, ready_count: partition.readyRows.length, reserve_count: partition.reserveRows.length,
    total_ready: rows.length, rounds_completed: pool.rounds.length, stop_reason: null,
    phase: heEngCollectionTargetPhase(partition.readyRows.length, partition.reserveRows.length, saved.target.reserve_target),
  };
  // This is an active input being committed now, not a historical terminal
  // record. Retain any overshoot/already-built reserve without buying more.
  if (input.readyOnly) target = { ...target, reserve_target: 0,
    phase: heEngCollectionTargetPhase(target.ready_count, target.reserve_count, 0) };
  const reason = input.stopReason ?? budgetStop(input.budget) ??
    (input.sourcesExhausted ? 'sources_exhausted' : null) ??
    (pool.rounds.length >= HE_ENG_COLLECTION_MAX_ROUNDS ||
      pool.candidates_processed >= HE_ENG_COLLECTION_MAX_CANDIDATES ? 'safety_limit' : null);
  if (reason) target = stopHeEngCollectionTarget(target, reason);
  return {
    target, pool, ...partition, duplicateRound: false,
    nextBatchSize: nextHeEngCollectionBatchSize({ target, pool }),
  };
}
