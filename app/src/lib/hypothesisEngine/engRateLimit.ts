/**
 * Счётчики частоты ENG-контура: регистрация с английского хоста (по IP и по
 * адресу почты), повторная отправка письма подтверждения (по пользователю),
 * запуски шаблона из кабинета, которые не прошли после платной части (по
 * шаблону), и отметка «запуск идёт» (по шаблону, её читает удаление проекта).
 *
 * СЧИТАЕТСЯ ТОЛЬКО СОСТОЯВШЕЕСЯ. Попадание записывается до действия (иначе
 * два параллельных запроса оба прошли бы последнее место), а если действие,
 * ради которого его считали, не состоялось (письмо не ушло; запуск прошёл или
 * отказал до платной части), вызывающий его возвращает: releaseHeEngRateHit.
 * Отметка 'launch_in_flight' — не лимит, а аренда: роут запуска возвращает её
 * всегда, когда запуск кончился, и отказом её не останавливает
 * (findHeEngRateHits ниже).
 *
 * ГДЕ СЧИТАЕТ. Основной путь — функция БД he_eng_rate_hit (миграция
 * 20261010_0001): «посчитать попадания в окне и, если лимит не достигнут,
 * записать новое» одной транзакцией под advisory-замком ключа, поэтому два
 * параллельных запроса не проходят оба на последнем свободном месте. Счёт
 * общий для всех процессов portal: контейнер поднимает несколько процессов
 * кластера (scripts/cluster.js, WEB_CONCURRENCY), и счётчик в памяти одного
 * процесса пропускал бы в N раз больше.
 *
 * ЗАПАСНОЙ ПУТЬ — память процесса. Любой отказ функции (миграция не
 * применена: 42883 / PGRST202; таблицы нет; блип БД) — решение принимает
 * скользящее окно в памяти этого процесса, а причина возвращается в
 * `fallbackReason`, чтобы вызывающий записал её в лог. Это слабее (лимит на
 * процесс, обнуляется рестартом), но не открывает дверь целиком и не
 * превращает блип БД в отказ регистрации.
 *
 * КЛЮЧИ. В БД уходит не IP и не адрес, а HMAC от них (engServerKey,
 * назначение 'rate-key'); без ключа сервис-роли — простой SHA-256.
 *
 * Модуль без логгера: строку лога пишет вызывающий.
 */

import { createHash, createHmac } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deriveHeEngKey } from './engServerKey';

export type HeEngRateBucket =
  | 'signup_ip'
  | 'signup_email'
  | 'verify_resend_min'
  | 'verify_resend_hour'
  | 'launch_failed'
  | 'launch_in_flight';

export interface HeEngRateRule {
  /** Сколько попаданий разрешено в окне. */
  limit: number;
  /** Скользящее окно, секунды. */
  windowSeconds: number;
}

/**
 * Лимиты. Регистраций с одного IP — 5 в час (офис за одним NAT спокойно
 * укладывается); попыток с одним адресом — 3 в час (второй аккаунт на тот же
 * адрес и так невозможен, лимит режет перебор «есть ли такой аккаунт»);
 * письмо подтверждения — не чаще раза в минуту и не больше 5 в час; запуск
 * шаблона, который не прошёл после платной части (отказ классификатора
 * сегментов 503 segment_classification_incomplete — платный вызов модели по
 * всей аудитории — или любой другой 5xx ядра, кроме отказов чтения/записи до
 * классификатора, либо бросок), — не больше 3 таких в час на шаблон
 * (api/client/eng/templates/[id]/launch).
 * 'launch_in_flight' — отметка идущего запуска шаблона, окно = аренда запуска
 * HE_LAUNCH_LEASE_MS (launchHandoff.ts, 15 мин): процесс, умерший посреди
 * запуска, её не вернёт, и она гаснет так же, как его аренда. Лимит у неё
 * только потолок роста таблицы — роут запуска отказ этой отметки не
 * исполняет (параллельных запусков одного шаблона больше 20 не бывает).
 * Окна не длиннее суток: функция БД убирает записи старше двух суток.
 */
export const HE_ENG_RATE_RULES: Record<HeEngRateBucket, HeEngRateRule> = {
  signup_ip: { limit: 5, windowSeconds: 3600 },
  signup_email: { limit: 3, windowSeconds: 3600 },
  verify_resend_min: { limit: 1, windowSeconds: 60 },
  verify_resend_hour: { limit: 5, windowSeconds: 3600 },
  launch_failed: { limit: 3, windowSeconds: 3600 },
  launch_in_flight: { limit: 20, windowSeconds: 15 * 60 },
};

export interface HeEngRateDecision {
  allowed: boolean;
  /** Через сколько секунд освободится место (0 — разрешено). */
  retryAfterSeconds: number;
  /** null — решала БД; строка — решала память процесса, вот почему. */
  fallbackReason: string | null;
}

const RATE_HIT_RPC = 'he_eng_rate_hit';

/** Ключ счётчика: HMAC(bucket:key) — ни IP, ни адрес в БД не лежат. */
export function heEngRateKeyHash(bucket: HeEngRateBucket, rawKey: string, env: NodeJS.ProcessEnv = process.env): string {
  const material = `${bucket}:${rawKey.trim().toLowerCase()}`;
  const key = deriveHeEngKey('rate-key', env);
  return key
    ? createHmac('sha256', key).update(material).digest('hex')
    : createHash('sha256').update(material).digest('hex');
}

/* ─────────────── Память процесса (запасной путь) ─────────────── */

const memoryHits = new Map<string, number[]>();
/** Потолок карты: поток разных ключей не должен растить её без предела. */
const MEMORY_MAX_KEYS = 5000;

function memoryHit(hash: string, rule: HeEngRateRule, nowMs: number): { allowed: boolean; retryAfterSeconds: number } {
  const windowMs = rule.windowSeconds * 1000;
  const fresh = (memoryHits.get(hash) ?? []).filter((t) => nowMs - t < windowMs);
  if (fresh.length >= rule.limit) {
    memoryHits.set(hash, fresh);
    const oldest = Math.min(...fresh);
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000)) };
  }
  if (!memoryHits.has(hash) && memoryHits.size >= MEMORY_MAX_KEYS) memoryHits.clear();
  fresh.push(nowMs);
  memoryHits.set(hash, fresh);
  return { allowed: true, retryAfterSeconds: 0 };
}

/* ─────────────── Попадание ─────────────── */

function rpcRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === 'object' ? (row as Record<string, unknown>) : null;
}

/**
 * Записать попадание, если лимит не достигнут. НИКОГДА НЕ БРОСАЕТ.
 * Отказ (allowed=false) ничего не записывает: перебор упирается в лимит, а не
 * растит таблицу.
 */
export async function hitHeEngRateLimit(
  db: SupabaseClient | null,
  bucket: HeEngRateBucket,
  rawKey: string,
  opts: { nowMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<HeEngRateDecision> {
  const rule = HE_ENG_RATE_RULES[bucket];
  const hash = heEngRateKeyHash(bucket, rawKey, opts.env);
  const nowMs = opts.nowMs ?? Date.now();
  let fallbackReason: string;
  if (db) {
    try {
      const { data, error } = await db.rpc(RATE_HIT_RPC, {
        p_bucket: bucket,
        p_key_hash: hash,
        p_limit: rule.limit,
        p_window_seconds: rule.windowSeconds,
      });
      const row = error ? null : rpcRow(data);
      if (row && typeof row.allowed === 'boolean') {
        const retry = Number(row.retry_after_seconds);
        return {
          allowed: row.allowed,
          retryAfterSeconds: row.allowed ? 0 : Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : rule.windowSeconds,
          fallbackReason: null,
        };
      }
      fallbackReason = error
        ? `${RATE_HIT_RPC} rpc: ${error.code ?? 'error'}${error.code === '42883' || error.code === 'PGRST202' ? ' (migration 20261010_0001 not applied)' : ''}`
        : `${RATE_HIT_RPC}: unexpected answer`;
    } catch (e) {
      fallbackReason = `${RATE_HIT_RPC} threw: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`;
    }
  } else {
    fallbackReason = 'no database client';
  }
  return { ...memoryHit(hash, rule, nowMs), fallbackReason };
}

const RATE_EVENTS_TABLE = 'he_eng_rate_events';

/**
 * Вернуть попадание, которое hitHeEngRateLimit записал (allowed=true), когда
 * действие, ради которого его считали, не состоялось. НИКОГДА НЕ БРОСАЕТ.
 * Отказ (allowed=false) ничего не записывал — возвращать нечего.
 *
 * Где решало попадание, там и возврат: решала БД — удаляется самая новая
 * запись ключа (записи одного ключа неразличимы, поэтому при параллельном
 * попадании безразлично, чья именно); решала память процесса — снимается
 * самая новая отметка ключа в ней.
 *
 * null — вернули (или записи уже нет); строка — почему не вышло, для лога:
 * тогда попадание так и считается до конца окна.
 */
export async function releaseHeEngRateHit(
  db: SupabaseClient | null,
  bucket: HeEngRateBucket,
  rawKey: string,
  decision: HeEngRateDecision,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  if (!decision.allowed) return null;
  const hash = heEngRateKeyHash(bucket, rawKey, opts.env);
  if (decision.fallbackReason !== null) {
    const hits = memoryHits.get(hash);
    if (hits && hits.length > 0) hits.splice(hits.indexOf(Math.max(...hits)), 1);
    return null;
  }
  if (!db) return 'no database client';
  try {
    const { data, error } = await db
      .from(RATE_EVENTS_TABLE)
      .select('id')
      .eq('bucket', bucket)
      .eq('key_hash', hash)
      .order('id', { ascending: false })
      .limit(1);
    if (error) return `${RATE_EVENTS_TABLE} read: ${error.code ?? 'error'}`;
    const id = Array.isArray(data) && data.length > 0 ? (data[0] as { id?: unknown }).id : null;
    if (id === null || id === undefined) return null;
    const { error: deleteErr } = await db.from(RATE_EVENTS_TABLE).delete().eq('id', id);
    return deleteErr ? `${RATE_EVENTS_TABLE} delete: ${deleteErr.code ?? 'error'}` : null;
  } catch (e) {
    return `${RATE_EVENTS_TABLE} release threw: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}`;
  }
}

export type HeEngRateHitsFound =
  | { kind: 'found' }
  | { kind: 'none' }
  /** Таблицы нет (миграция 20261010_0001 не применена) — отметок не бывает. */
  | { kind: 'table_missing' }
  | { kind: 'error'; message: string };

/**
 * Есть ли у какого-нибудь из ключей попадание не старше `sinceMs` — для
 * отметок, которые читает другой роут (удаление проекта читает
 * 'launch_in_flight' своих шаблонов). НИКОГДА НЕ БРОСАЕТ.
 *
 * Видит только то, что решала БД: попадание, которое из-за сбоя БД решала
 * память процесса (fallbackReason), другому процессу не видно.
 */
export async function findHeEngRateHits(
  db: SupabaseClient,
  bucket: HeEngRateBucket,
  rawKeys: string[],
  sinceMs: number,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<HeEngRateHitsFound> {
  if (rawKeys.length === 0) return { kind: 'none' };
  const hashes = rawKeys.map((key) => heEngRateKeyHash(bucket, key, opts.env));
  try {
    const { data, error } = await db
      .from(RATE_EVENTS_TABLE)
      .select('id')
      .eq('bucket', bucket)
      .in('key_hash', hashes)
      .gte('created_at', new Date(sinceMs).toISOString())
      .limit(1);
    if (error) {
      return error.code === '42P01' || error.code === 'PGRST205'
        ? { kind: 'table_missing' }
        : { kind: 'error', message: `${RATE_EVENTS_TABLE} read: ${error.code ?? 'error'}` };
    }
    return Array.isArray(data) && data.length > 0 ? { kind: 'found' } : { kind: 'none' };
  } catch (e) {
    return { kind: 'error', message: `${RATE_EVENTS_TABLE} read threw: ${e instanceof Error ? e.message.slice(0, 120) : 'unknown'}` };
  }
}

/** Минуты для текста клиенту: «about N minutes», не меньше одной. */
export function heEngRetryMinutes(retryAfterSeconds: number): number {
  return Math.max(1, Math.ceil(retryAfterSeconds / 60));
}
