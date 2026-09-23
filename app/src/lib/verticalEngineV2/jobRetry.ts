/**
 * Политика автоповтора research-стадий «Движка вертикалей» (ve_jobs).
 *
 * Упавшая стадия НЕ должна требовать кнопки «Повторить» (иначе пользователь
 * перезапускает весь research с site_profile и платит за уже пройденные
 * стадии). Воркер сам переставляет failed-джобу в pending; здесь решается,
 * сколько раз и с какой задержкой (run_after) это делать.
 *
 * Транзиентные ошибки (5xx/429 от Requesty, сеть, таймауты) пережидаем с
 * экспоненциальным бэкоффом — провайдер может быть недоступен десятки секунд.
 * Постоянные ошибки (валидация схемы, нет данных, 4xx) ретраить бессмысленно —
 * они умирают быстро, как раньше.
 */

import { isVeProviderBillingError, isVeProviderConfigurationError } from './collectionErrors';
import { VeLlmRateLimitError, veRateLimitDelay, type VeLlmRateLimit } from './llmRateLimit';
import { isVeStageDbInterruption } from './stageDb';
import type { VeJob } from './types';
import { VeJobInactivityError } from './workerLiveness';

/** Попытки для постоянных ошибок — как было до автоповтора. */
export const PERMANENT_MAX_ATTEMPTS = 3;
/** Транзиентные ошибки пережидаем дольше: больше попыток + бэкофф. */
export const RETRYABLE_MAX_ATTEMPTS = 5;

const RETRY_BACKOFF_BASE_MS = 30_000;
const RETRY_BACKOFF_MAX_MS = 120_000;

/** Транзиентная ли ошибка стадии (стоит ли ждать и повторять). */
export function isRetryableStageError(msg: string): boolean {
  if (isVeProviderBillingError(msg) || isVeProviderConfigurationError(msg)) return false;
  return (
    /\bSerper transient:/i.test(msg) ||
    /\b(5\d\d|429)\b/.test(msg) ||
    /provider is currently unavailable/i.test(msg) ||
    /econnreset|econnrefused|etimedout|enotfound|network|fetch failed|socket hang up|timeout|aborted/i.test(msg) ||
    isVeStageDbInterruption(msg)
  );
}

/** Лимит попыток для конкретной ошибки стадии. */
export function maxAttemptsFor(msg: string): number {
  // A journal failure may occur after a paid response. A fresh worker scope
  // must not automatically repeat the stage and charge for that work again.
  if (msg === 'Provider usage journal could not be saved.') return 1;
  if (isVeProviderBillingError(msg) || isVeProviderConfigurationError(msg)) return 1;
  return isRetryableStageError(msg) ? RETRYABLE_MAX_ATTEMPTS : PERMANENT_MAX_ATTEMPTS;
}

/**
 * `run_after` для отложенного requeue. `attempts` — номер только что
 * случившегося фейла (1-based). Для транзиентных ошибок возвращает будущее
 * время с бэкоффом (30с → 60с → 120с → 120с), для постоянных — `now` (клейм
 * сразу, как раньше).
 */
export function retryRunAfter(attempts: number, retryable: boolean, nowMs = Date.now(), rateLimit?: VeLlmRateLimit, scope = ''): string {
  if (!retryable) return new Date(nowMs).toISOString();
  const delay = Math.max(rateLimit?.deferred ? 0 : Math.min(RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_BACKOFF_MAX_MS),
    rateLimit ? veRateLimitDelay(rateLimit, scope, nowMs) : 0);
  return new Date(nowMs + delay).toISOString();
}

/**
 * Interruptions in a row that do not spend an attempt. Before 23.09.2026 a
 * hang ended in a process exit, and startup recovery returned the job to the
 * queue without counting it; the bounded stage database turned the same hang
 * into an ordinary failure, and five of them failed a base that was still
 * collecting. The limit only stops an endless loop of the same hang: after it
 * each further interruption counts as a normal failed attempt.
 */
export const VE_JOB_FREE_INTERRUPTIONS = 10;

/** The stage was interrupted (inactivity guard, its database request timed out or lost the connection); it did not fail by itself. */
export function isVeJobInterruption(error: unknown): boolean {
  if (error instanceof VeJobInactivityError) return true;
  return isVeStageDbInterruption(error instanceof Error ? error.message : String(error));
}

/** Consecutive interruptions, kept in the job payload (no column needed; stages ignore unknown keys). */
export function veJobInterruptions(payload: Record<string, unknown> | null | undefined): number {
  const value = payload?.interruptions;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/** A stage run that ended normally closes the series; null when there is nothing to reset. */
export function clearVeJobInterruptions(payload: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!payload || !veJobInterruptions(payload)) return null;
  const next = { ...payload };
  delete next.interruptions;
  return next;
}

export interface VeJobFailurePlan {
  status: 'pending' | 'failed';
  attempts: number;
  attemptCap: number;
  retryable: boolean;
  runAfter: string;
  /** Present for an interruption: the payload with the updated counter. */
  payload?: Record<string, unknown>;
  interruption: { count: number; free: boolean } | null;
}

/** How the worker records a failed stage run (attempts, next run, final failure). */
export function planVeJobFailure(job: Pick<VeJob, 'id' | 'attempts' | 'payload'>, error: unknown, nowMs = Date.now()): VeJobFailurePlan {
  const msg = error instanceof Error ? error.message : String(error);
  const retryable = isRetryableStageError(msg);
  const attemptCap = maxAttemptsFor(msg);
  const rateLimit = error instanceof VeLlmRateLimitError ? error : undefined;
  const interrupted = isVeJobInterruption(error);
  const count = interrupted ? veJobInterruptions(job.payload) + 1 : 0;
  const free = interrupted && count <= VE_JOB_FREE_INTERRUPTIONS;
  const attempts = job.attempts + Number(!rateLimit?.deferred && !free);
  const finalFail = !free && attempts >= attemptCap;
  return {
    status: finalFail ? 'failed' : 'pending',
    attempts,
    attemptCap,
    retryable,
    runAfter: free ? retryRunAfter(count, true, nowMs) : retryRunAfter(attempts, retryable, nowMs, rateLimit, job.id),
    ...(interrupted ? { payload: { ...job.payload, interruptions: count } } : {}),
    interruption: interrupted ? { count, free } : null,
  };
}
