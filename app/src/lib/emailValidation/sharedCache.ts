import { domainToUnicode } from 'url';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ValidationResult } from './shared';

/**
 * Validation memory shared by every job and process (owner 2026-10-23: «общий
 * кэш результатов и признака „принимает любые адреса“ … даже на пару месяцев»).
 *
 * The three SMTP probe IPs went back to Spamhaus CSS a day after delisting:
 * every job probed the same addresses again, every day, and each domain's
 * catch-all check sent one more RCPT to a random mailbox. Now a conclusive
 * answer for an address (ok / invalid / catch_all from an actual SMTP reply)
 * and the catch-all flag of a domain are kept for EMAIL_VALIDATION_CACHE_TTL_DAYS
 * (default 60). An unknown answer is never kept: it must be probed again.
 *
 * Reads and writes are batched across concurrent validations. The cache is
 * best effort: any database failure means a normal probe, never a guessed
 * verdict. EMAIL_VALIDATION_SHARED_CACHE=0 switches it off. The database
 * client is loaded on first use: the validator is also imported where there is
 * no server database (tests, scripts), and then the cache is simply off.
 */

const RESULT_TABLE = 'email_validation_result_cache';
const CATCH_ALL_TABLE = 'email_validation_catch_all_cache';
// Bounces of our own sends (migration 20261026_0090): the Instantly webhook,
// hard bounces of our sender and imported Instantly lead statuses.
const BOUNCE_VIEW = 'email_bounce_history';
const DAY_MS = 86_400_000;
const TTL_MS = Math.max(1, Number(process.env.EMAIL_VALIDATION_CACHE_TTL_DAYS ?? '60') || 60) * DAY_MS;
// Only a bounce of the last EMAIL_VALIDATION_BOUNCE_DAYS counts: a refusal by
// policy (a blocked sending mailbox) must not bury an address for good.
const BOUNCE_WINDOW_MS = Math.max(1, Number(process.env.EMAIL_VALIDATION_BOUNCE_DAYS ?? '180') || 180) * DAY_MS;
const READ_WINDOW_MS = 15;
const READ_BATCH = 200;
const WRITE_DELAY_MS = 2_000;
const WRITE_BATCH = 200;
// A miss is remembered in this process for a few minutes: the retry pass of
// the same job must not ask the database again for every address.
const MISS_MEMORY_MS = 5 * 60_000;
const HIT_MEMORY_MS = 60 * 60_000;
const MEMORY_LIMIT = 50_000;
const CLEANUP_EVERY_MS = 60 * 60_000;
const MAX_DETAIL_TEXT = 300;

let adminClient: Promise<SupabaseClient | null> | null = null;

function database(): Promise<SupabaseClient | null> {
  if (process.env.EMAIL_VALIDATION_SHARED_CACHE === '0') return Promise.resolve(null);
  adminClient ??= import('@/lib/supabaseAdmin').then((module) => module.supabaseAdmin ?? null).catch(() => null);
  return adminClient;
}

/** Only verdicts that came from an SMTP answer about this address or domain. */
export function isConclusiveValidation(result: ValidationResult): boolean {
  return ['ok', 'invalid', 'catch_all'].includes(result.result) && result.smtp_code >= 200 && !result.error;
}

type Remembered<V> = { value: V | null; until: number };

function remember<V>(memory: Map<string, Remembered<V>>, key: string, value: V | null, ms: number): void {
  if (memory.size >= MEMORY_LIMIT) memory.delete(memory.keys().next().value as string);
  memory.set(key, { value, until: Date.now() + ms });
}

function recalled<V>(memory: Map<string, Remembered<V>>, key: string): Remembered<V> | undefined {
  const entry = memory.get(key);
  if (!entry) return undefined;
  if (entry.until <= Date.now()) { memory.delete(key); return undefined; }
  return entry;
}

/** One database query per short window for all concurrent lookups. */
function batched<V>(load: (keys: string[]) => Promise<Map<string, V>>): (key: string) => Promise<V | null> {
  let queue = new Map<string, Array<(value: V | null) => void>>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = async () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const batch = queue;
    queue = new Map();
    let found = new Map<string, V>();
    try { found = await load([...batch.keys()]); } catch { /* best effort: probe as usual */ }
    for (const [key, waiters] of batch) for (const resolve of waiters) resolve(found.get(key) ?? null);
  };
  return (key) => new Promise((resolve) => {
    const waiters = queue.get(key) ?? [];
    waiters.push(resolve);
    queue.set(key, waiters);
    if (queue.size >= READ_BATCH) void flush();
    else if (!timer) timer = setTimeout(() => void flush(), READ_WINDOW_MS);
  });
}

function compactDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).map(([key, value]) =>
    [key, typeof value === 'string' && value.length > MAX_DETAIL_TEXT ? value.slice(0, MAX_DETAIL_TEXT) : value]));
}

export type BounceRecord = { lastBouncedAt: string; bounces: number };

const resultMemory = new Map<string, Remembered<ValidationResult>>();
const catchAllMemory = new Map<string, Remembered<boolean>>();
const bounceMemory = new Map<string, Remembered<BounceRecord>>();
const pendingResults = new Map<string, { email: string; result: string; payload: ValidationResult; checked_at: string; expires_at: string }>();
const pendingCatchAll = new Map<string, { domain: string; is_catch_all: boolean; checked_at: string; expires_at: string }>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let lastCleanup = 0;

const loadResults = batched<ValidationResult>(async (emails) => {
  const db = await database();
  if (!db) return new Map();
  const { data, error } = await db.from(RESULT_TABLE)
    .select('email, payload').in('email', emails).gt('expires_at', new Date().toISOString());
  if (error) throw new Error(error.message);
  return new Map((data ?? []).map((row: { email: string; payload: ValidationResult }) => [row.email, row.payload]));
});

const loadCatchAll = batched<boolean>(async (domains) => {
  const db = await database();
  if (!db) return new Map();
  const { data, error } = await db.from(CATCH_ALL_TABLE)
    .select('domain, is_catch_all').in('domain', domains).gt('expires_at', new Date().toISOString());
  if (error) throw new Error(error.message);
  return new Map((data ?? []).map((row: { domain: string; is_catch_all: boolean }) => [row.domain, row.is_catch_all]));
});

// A failing lookup leaves verdicts as SMTP gave them; say so, at most every 10 minutes.
let bounceWarnedAt = 0;

const loadBounces = batched<BounceRecord>(async (emails) => {
  const db = await database();
  if (!db) return new Map();
  const { data, error } = await db.from(BOUNCE_VIEW)
    .select('email, last_bounced_at, bounces').in('email', emails)
    .gt('last_bounced_at', new Date(Date.now() - BOUNCE_WINDOW_MS).toISOString());
  if (error) {
    if (Date.now() - bounceWarnedAt >= 10 * 60_000) {
      bounceWarnedAt = Date.now();
      console.warn(`[email-validation] bounce history lookup skipped: ${error.message}`);
    }
    throw new Error(error.message);
  }
  return new Map((data ?? []).map((row: { email: string; last_bounced_at: string; bounces: number }) =>
    [row.email, { lastBouncedAt: row.last_bounced_at, bounces: row.bounces }]));
});

/** A kept verdict for this normalised address, or null (then probe it). */
export async function cachedValidation(email: string): Promise<ValidationResult | null> {
  if (!(await database())) return null;
  const memory = recalled(resultMemory, email);
  if (memory) return memory.value && { ...memory.value, details: { ...memory.value.details, cache: 'hit' } };
  const value = await loadResults(email);
  remember(resultMemory, email, value, value ? HIT_MEMORY_MS : MISS_MEMORY_MS);
  return value && { ...value, details: { ...value.details, cache: 'hit' } };
}

/** The kept catch-all flag of a domain, or null (then check it). */
export async function cachedCatchAll(domain: string): Promise<boolean | null> {
  if (!(await database())) return null;
  const memory = recalled(catchAllMemory, domain);
  if (memory) return memory.value;
  const value = await loadCatchAll(domain);
  remember(catchAllMemory, domain, value, value === null ? MISS_MEMORY_MS : HIT_MEMORY_MS);
  return value;
}

/**
 * The latest recent bounce of this normalised address in our sends, or null.
 * EMAIL_VALIDATION_BOUNCE_HISTORY=0 switches the lookup off.
 */
export async function bouncedBefore(email: string): Promise<BounceRecord | null> {
  if (process.env.EMAIL_VALIDATION_BOUNCE_HISTORY === '0' || !(await database())) return null;
  const memory = recalled(bounceMemory, email);
  if (memory) return memory.value;
  // The validator looks up IDN addresses in punycode, senders may keep them
  // as written (info@завод.рф): ask for both forms.
  const at = email.lastIndexOf('@');
  const unicodeDomain = email.includes('xn--') ? domainToUnicode(email.substring(at + 1)) : '';
  const unicode = unicodeDomain && unicodeDomain !== email.substring(at + 1) ? `${email.substring(0, at)}@${unicodeDomain}` : null;
  const [ascii, written] = await Promise.all([loadBounces(email), unicode ? loadBounces(unicode) : Promise.resolve(null)]);
  const value = ascii && written
    ? { lastBouncedAt: ascii.lastBouncedAt > written.lastBouncedAt ? ascii.lastBouncedAt : written.lastBouncedAt, bounces: ascii.bounces + written.bounces }
    : ascii ?? written;
  remember(bounceMemory, email, value, value ? HIT_MEMORY_MS : MISS_MEMORY_MS);
  return value;
}

function scheduleWrite(): void {
  if (pendingResults.size + pendingCatchAll.size >= WRITE_BATCH) { void flushSharedValidationCache(); return; }
  if (writeTimer) return;
  writeTimer = setTimeout(() => void flushSharedValidationCache(), WRITE_DELAY_MS);
  writeTimer.unref?.();
}

export function rememberValidation(email: string, result: ValidationResult): void {
  if (process.env.EMAIL_VALIDATION_SHARED_CACHE === '0' || !isConclusiveValidation(result)) return;
  const now = Date.now();
  const payload: ValidationResult = { ...result, details: compactDetails(result.details) };
  delete (payload.details as Record<string, unknown>).cache;
  remember(resultMemory, email, payload, HIT_MEMORY_MS);
  pendingResults.set(email, { email, result: result.result, payload,
    checked_at: new Date(now).toISOString(), expires_at: new Date(now + TTL_MS).toISOString() });
  scheduleWrite();
}

export function rememberCatchAll(domain: string, isCatchAll: boolean): void {
  if (process.env.EMAIL_VALIDATION_SHARED_CACHE === '0') return;
  const now = Date.now();
  remember(catchAllMemory, domain, isCatchAll, HIT_MEMORY_MS);
  pendingCatchAll.set(domain, { domain, is_catch_all: isCatchAll,
    checked_at: new Date(now).toISOString(), expires_at: new Date(now + TTL_MS).toISOString() });
  scheduleWrite();
}

/** Write what is pending now (also called by the timer); never throws. */
export async function flushSharedValidationCache(): Promise<void> {
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  const results = [...pendingResults.values()];
  const catchAll = [...pendingCatchAll.values()];
  pendingResults.clear();
  pendingCatchAll.clear();
  const db = await database();
  if (!db || (!results.length && !catchAll.length)) return;
  const check = (response: { error: { message: string } | null }) => {
    if (response.error) throw new Error(response.error.message);
  };
  try {
    for (let i = 0; i < results.length; i += WRITE_BATCH) {
      check(await db.from(RESULT_TABLE).upsert(results.slice(i, i + WRITE_BATCH), { onConflict: 'email' }));
    }
    for (let i = 0; i < catchAll.length; i += WRITE_BATCH) {
      check(await db.from(CATCH_ALL_TABLE).upsert(catchAll.slice(i, i + WRITE_BATCH), { onConflict: 'domain' }));
    }
    if (Date.now() - lastCleanup >= CLEANUP_EVERY_MS) {
      lastCleanup = Date.now();
      const now = new Date().toISOString();
      check(await db.from(RESULT_TABLE).delete().lt('expires_at', now));
      check(await db.from(CATCH_ALL_TABLE).delete().lt('expires_at', now));
    }
  } catch (error) {
    console.warn(`[email-validation] shared cache write skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Tests only. */
export function __resetSharedValidationCache(): void {
  adminClient = null;
  resultMemory.clear();
  catchAllMemory.clear();
  bounceMemory.clear();
  pendingResults.clear();
  pendingCatchAll.clear();
  if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
  lastCleanup = 0;
}
