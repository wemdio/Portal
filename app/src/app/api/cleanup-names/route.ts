import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { buildHeuristicCleanupResults, type CompanyCleanupEntry } from '@/lib/companyNameCleanup';
import {
  CLEANUP_JSON_SYSTEM_PROMPT,
  CLEANUP_BATCH,
  buildCleanupUserMessage,
  parseCleanupResponseJson,
  parseCleanupResponse,
} from '@/lib/nameCleanupProtocol';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';

export const dynamic = 'force-dynamic';

const OPENROUTER_CLEANUP_API_KEY = process.env.OPENROUTER_CLEANUP_API_KEY ?? '';
const CLEANUP_MODEL = 'policy/cleanup';
const OPENROUTER_TIMEOUT_MS = 70000;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

type RequestBody = {
  companies: CompanyCleanupEntry[];
};

const MAX_RETRIES = 3;
// Env-переопределение — для тестов (иначе ретраи с backoff'ом растягивают
// jest-прогон на десятки секунд).
const RETRY_BASE_DELAY = Number(process.env.CLEANUP_RETRY_BASE_DELAY_MS ?? 1500);

function getFetchFailureReason(err: unknown): string {
  if (err instanceof Error && err.cause instanceof Error) {
    const cause = err.cause as Error & { code?: string };
    const code = cause.code ?? '';
    const message = cause.message ?? '';
    if (code && message) return `${code}: ${message}`;
    if (code) return code;
    if (message) return message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

type SubBatchOutcome =
  | { kind: 'ok'; cleanedMap: Map<number, string> }
  | { kind: 'ai_unavailable'; reason: string }
  | { kind: 'fatal'; reason: string };

/**
 * Один суб-батч (<=CLEANUP_BATCH) через JSON-протокол nameCleanupProtocol —
 * тот же механизм, что stepNameCleanup в base-constructor'е (единый источник
 * правды). Ретраим сеть/таймаут/пустой ответ/5xx; 4xx = fatal (ключ/квота —
 * дальше долбить бессмысленно).
 *
 * История: до 04.07.2026 роут просил нумерованный текст и в positional
 * fallback'е писал строки с «N. » префиксами как есть; масштабный тест на
 * 2000 имён показал ~20% сбойных батчей даже на здоровой модели. JSON-mode
 * с idx устраняет класс бага целиком.
 */
async function cleanupSubBatch(entries: CompanyCleanupEntry[]): Promise<SubBatchOutcome> {
  const userMessage = buildCleanupUserMessage(entries);
  let lastError = 'Unknown AI error';

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_BASE_DELAY * Math.pow(2, attempt - 1));

    let response: Response;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);
      response = await fetch('https://router.requesty.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_CLEANUP_API_KEY}`,
          'HTTP-Referer': 'https://portal.app',
          'X-Title': 'Portal - Name Cleanup',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: CLEANUP_MODEL,
          messages: [
            { role: 'system', content: CLEANUP_JSON_SYSTEM_PROMPT },
            { role: 'user', content: userMessage },
          ],
          temperature: 0.1,
          max_tokens: 4000,
          response_format: { type: 'json_object' },
        }),
      });
    } catch (err) {
      lastError = err instanceof Error && err.name === 'AbortError'
        ? 'Превышено время ожидания ответа от AI'
        : `Ошибка сети при обращении к AI: ${getFetchFailureReason(err)}`;
      continue;
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (response.ok) {
      const data = await response.json().catch(() => null) as
        | { choices?: { message?: { content?: string } }[] }
        | null;
      const content = data?.choices?.[0]?.message?.content?.trim() ?? '';
      if (!content) {
        lastError = 'Пустой ответ от AI';
        continue;
      }
      // Основной путь — JSON. Если модель проигнорировала response_format и
      // вернула нумерованный текст — страховочный text-парсер (он стрипает
      // префиксы и спецтокены во всех режимах).
      const cleanedMap = parseCleanupResponseJson(content)
        ?? parseCleanupResponse(content, entries.length);
      if (!cleanedMap || cleanedMap.size === 0) {
        lastError = 'Нераспознаваемый ответ от AI';
        continue;
      }
      return { kind: 'ok', cleanedMap };
    }

    let errorMessage = `API error: ${response.status}`;
    try {
      const errorData = await response.json() as { error?: { message?: string } | string };
      if (typeof errorData.error === 'string') {
        errorMessage = errorData.error;
      } else if (typeof errorData.error?.message === 'string') {
        errorMessage = errorData.error.message;
      }
    } catch {
      // ignore
    }
    lastError = errorMessage;

    const providerError = /provider returned error/i.test(errorMessage);
    const retryable = providerError || [500, 502, 503, 504].includes(response.status);
    if (!retryable) return { kind: 'fatal', reason: errorMessage };
  }

  return { kind: 'ai_unavailable', reason: lastError };
}

export async function POST(req: NextRequest) {
  // --- Auth ---
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  // --- Check API key ---
  if (!OPENROUTER_CLEANUP_API_KEY) {
    return jsonError('OPENROUTER_CLEANUP_API_KEY not configured on server', 500);
  }

  // --- Parse body ---
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const { companies } = body;
  if (!Array.isArray(companies) || companies.length === 0) {
    return jsonError('Missing required field: companies (non-empty array)', 400);
  }

  // Клиент шлёт до 100 компаний за запрос; внутри дробим по CLEANUP_BATCH (50),
  // чтобы ответ модели гарантированно влезал в лимит выходных токенов.
  // Суб-батчи независимы — гоним параллельно: латентность запроса остаётся
  // ~как у одного AI-вызова (за Cloudflare лимит ~100с, последовательные
  // суб-батчи с ретраями в него не влезали бы).
  const subBatches: CompanyCleanupEntry[][] = [];
  for (let start = 0; start < companies.length; start += CLEANUP_BATCH) {
    subBatches.push(companies.slice(start, start + CLEANUP_BATCH));
  }
  const outcomes = await Promise.all(subBatches.map((b) => cleanupSubBatch(b)));

  const results: { idx: number; cleanedName: string }[] = [];
  let heuristicReason: string | null = null;

  for (let b = 0; b < subBatches.length; b += 1) {
    const subBatch = subBatches[b];
    const outcome = outcomes[b];

    if (outcome.kind === 'fatal') {
      // Non-retryable (невалидный ключ, 4xx) — почти наверняка затронуло все
      // суб-батчи; отдаём ошибку целиком, клиент оставит оригиналы.
      return jsonError(`Не удалось получить ответ от AI. ${CLEANUP_MODEL}: ${outcome.reason}`, 502);
    }

    if (outcome.kind === 'ai_unavailable') {
      // AI недоступен по retryable-причине — локальная эвристика для этого
      // суб-батча (ООО/кавычки/суффиксы снимет, хуже оригинала не будет).
      results.push(...buildHeuristicCleanupResults(subBatch));
      heuristicReason = outcome.reason;
      continue;
    }

    // Ключи map'а 1-based (get(i+1)) — контракт parseCleanupResponseJson.
    // Для строк без ответа оставляем оригинал, как stepNameCleanup.
    for (let i = 0; i < subBatch.length; i += 1) {
      const c = subBatch[i];
      results.push({ idx: c.idx, cleanedName: outcome.cleanedMap.get(i + 1) || c.name });
    }
  }

  if (heuristicReason) {
    const warning = `AI временно недоступен, к части строк применена локальная очистка. Модель: ${CLEANUP_MODEL}. Причина: ${heuristicReason}`;
    console.warn('[cleanup-names] Falling back to heuristic cleanup', {
      model: CLEANUP_MODEL,
      companyCount: companies.length,
      reason: heuristicReason,
    });
    return NextResponse.json(
      { results, warning },
      { headers: { 'X-Portal-Name-Cleanup-Fallback': 'heuristic' } },
    );
  }

  return NextResponse.json({ results });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
