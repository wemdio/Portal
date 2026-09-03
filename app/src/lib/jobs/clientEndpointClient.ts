/**
 * Client-specific scoring endpoint.
 *
 * Каждый клиент в авто-режиме держит у себя API, которому мы шлём домен
 * (полученный с HH через employer.site_url) и получаем JSON с двумя полями:
 *   { spf: <string>, score: <number> }
 *
 * Score определяет, в какой score-bucket (и значит, в какую цепочку Instantly)
 * попадёт лид. SPF мы пока только храним — потенциально пригодится для
 * аналитики deliverability.
 *
 * Этот модуль не знает про DB / Instantly / роутинг — он только отвечает за
 * HTTP-вызов с timeout'ом и нормализованным ответом. Оркестратор
 * (autoPipelineRunner) сам решает, что делать с null-ответом (status=skipped).
 *
 * Контракт ответа клиента ожидаем гибким:
 *   - score:    number | null  — если поле отсутствует, считаем null.
 *   - spf:      string | null  — то же.
 *   - любые дополнительные поля сохраняются в `raw` для диагностики.
 *
 * Авторизация — header `Authorization: Bearer <api_key>`. Если у конкретного
 * клиента другой формат, добавим в config поле auth_header_format.
 */

import { isMailganerEndpointUrl } from './mailganerScoringThrottle';
import { acquireMailganerScoreToken } from './mailganerScoringRateLimit';

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1500;

export interface FetchScoreInput {
  /** Endpoint URL configured per client (client_auto_pipeline_configs.endpoint_url). */
  url: string;
  /** API key (бывает что без префикса, бывает «Bearer», бывает «CodeRequest»). */
  apiKey: string;
  /**
   * Префикс в Authorization-заголовке. Дефолт «Bearer». Mailganer требует
   * «CodeRequest». Если apiKey пустой — заголовок не отправляется вообще
   * независимо от этой настройки.
   */
  authScheme?: string;
  /** Domain (without protocol/www) extracted from HH employer.site_url. */
  domain: string;
  /** Optional per-call timeout override. */
  timeoutMs?: number;
  /**
   * Сигнал прерывания вызывающего (необязателен).
   *
   * Нужен вызывающим на едином жизненном цикле задач: когда аренда потеряна
   * или пришёл SIGTERM, платный запрос к внешнему сервису — работа за чужой
   * счёт, и её надо бросить сразу, а не досидеть таймаут с двумя повторами.
   * Прерывание гасит и ожидание суточного токена, и сам HTTP-вызов, и паузы
   * между повторами. Без сигнала поведение прежнее.
   */
  signal?: AbortSignal;
}

export interface FetchScoreResult {
  /** Scoring value from the endpoint, or null when missing/invalid. */
  score: number | null;
  /** SPF DNS record returned by endpoint, or null. */
  spf: string | null;
  /** Full parsed response body (for diagnostics + future fields). */
  raw: Record<string, unknown> | null;
  /** Whether the HTTP call itself succeeded (not whether score is valid). */
  ok: boolean;
  /** Error message when ok=false. */
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function normalizeScore(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeSpf(raw: unknown): string | null {
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  return null;
}

/**
 * One-shot call with retries.
 *
 * Не бросает — возвращает { ok: false, error } при любом сбое HTTP/parse,
 * чтобы оркестратор мог пометить таких employers как status=skipped без
 * остановки всего прогона.
 */
export async function fetchScoreForDomain(input: FetchScoreInput): Promise<FetchScoreResult> {
  const { url, apiKey, domain } = input;
  const authScheme = (input.authScheme ?? 'Bearer').trim();
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outerSignal = input.signal;

  if (outerSignal?.aborted) {
    return { score: null, spf: null, raw: null, ok: false, error: 'aborted' };
  }

  // Жёсткий распределённый лимит к Mailganer (≤20k/сутки, равномерно). Только
  // для mailganer-эндпоинта; на исчерпании бюджета домен пропускаем (ok:false),
  // фоновые скореры возьмут его в следующий тик. См. mailganerScoringRateLimit.
  if (isMailganerEndpointUrl(url)) {
    const allowed = await acquireMailganerScoreToken(outerSignal);
    if (!allowed) {
      return { score: null, spf: null, raw: null, ok: false, error: 'rate_limited' };
    }
  }

  let lastError = '';

  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    if (outerSignal?.aborted) {
      return { score: null, spf: null, raw: null, ok: false, error: 'aborted' };
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    // Внешнее прерывание рвёт тот же контроллер, что и таймаут: fetch не умеет
    // двух сигналов, а AbortSignal.any есть не во всех рантаймах, где собирается
    // этот бандл. Слушателя обязательно снимаем — иначе долгий сигнал воркера
    // копил бы по одному на каждый домен прогона.
    const onOuterAbort = () => controller.abort();
    outerSignal?.addEventListener('abort', onOuterAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timeoutId);
      outerSignal?.removeEventListener('abort', onOuterAbort);
    };

    try {
      const headers: HeadersInit = { 'Content-Type': 'application/json' };
      if (apiKey) {
        // Если authScheme пустой строкой — отправляем чистый ключ без префикса
        // (некоторые API так и хотят, напр. Authorization: <key>).
        headers['Authorization'] = authScheme ? `${authScheme} ${apiKey}` : apiKey;
      }

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ domain }),
        signal: controller.signal,
      });

      cleanup();

      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        // На 4xx нет смысла ретраить — это про сам запрос (auth/bad domain).
        // 5xx — переход на следующую попытку.
        if (res.status < 500) {
          return { score: null, spf: null, raw: null, ok: false, error: lastError };
        }
      } else {
        const json = (await res.json().catch(() => null)) as unknown;
        if (!isPlainObject(json)) {
          return {
            score: null,
            spf: null,
            raw: null,
            ok: false,
            error: 'Endpoint returned non-object body',
          };
        }
        return {
          score: normalizeScore(json.score),
          spf: normalizeSpf(json.spf),
          raw: json,
          ok: true,
        };
      }
    } catch (err) {
      cleanup();
      lastError = err instanceof Error ? err.message : 'fetch failed';
      // На abort/timeout/network — ретраим (до RETRY_ATTEMPTS+1 попыток).
      // Кроме внешнего прерывания: решаем по СИГНАЛУ, а не по имени ошибки —
      // таймаут и прерывание дают неотличимый AbortError.
      if (outerSignal?.aborted) {
        return { score: null, spf: null, raw: null, ok: false, error: 'aborted' };
      }
    }

    if (attempt < RETRY_ATTEMPTS) {
      await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
      if (outerSignal?.aborted) {
        return { score: null, spf: null, raw: null, ok: false, error: 'aborted' };
      }
    }
  }

  return { score: null, spf: null, raw: null, ok: false, error: lastError || 'Unknown error' };
}

/**
 * Convenience helper to call the endpoint for a batch of domains with a
 * concurrency limit. Returns results in the same order as input domains.
 * Mostly used by autoPipelineRunner.
 */
export async function fetchScoresForDomains(
  domains: string[],
  base: Omit<FetchScoreInput, 'domain'>,
  options?: { concurrency?: number; onProgress?: (done: number, total: number) => void },
): Promise<FetchScoreResult[]> {
  const concurrency = Math.max(1, options?.concurrency ?? 5);
  const results: FetchScoreResult[] = new Array(domains.length);
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= domains.length) return;
      results[i] = await fetchScoreForDomain({ ...base, domain: domains[i] });
      done++;
      options?.onProgress?.(done, domains.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, domains.length) }, worker));
  return results;
}
