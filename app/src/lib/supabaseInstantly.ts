import 'server-only';
import { createClient } from '@supabase/supabase-js';
import { stripUnstorableJsonChars } from './jsonbSafe';

const url = process.env.INSTANTLY_SUPABASE_URL;
const key = process.env.INSTANTLY_SUPABASE_SERVICE_ROLE_KEY;

const isLocalPostgrest = url ? !url.includes('supabase.co') : false;

/**
 * Жёсткий таймаут на каждый запрос к локальному PostgREST (144). Без него краткий
 * блип сети/контейнера на 144 подвешивал запрос НАВСЕГДА (голый fetch без таймаута) —
 * список кампаний в Автоотчётах грузился бесконечно, без ошибки и ретрая. С таймаутом
 * зависание превращается в ошибку, которую роут ловит и отдаёт клиенту (тот показывает
 * «Обновить список»). 20с — огромный запас (реальные чтения ~0.5с), срабатывает только
 * на настоящих зависаниях; для батч-upsert синка каталога тоже с запасом.
 */
const POSTGREST_TIMEOUT_MS = 20_000;

const postgrestFetch: typeof globalThis.fetch = (input, init) => {
  const raw =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const headers = new Headers(init?.headers);
  if (isLocalPostgrest) {
    headers.delete('Authorization');
    headers.delete('apikey');
  }

  // A single NUL/lone surrogate in an email (or a sliced preview) otherwise
  // rejects the entire jsonb RPC page. Preserve real Unicode, line breaks and
  // literal "\\u0000" text; sanitize parsed values, never the JSON escape text.
  let body = init?.body;
  if (typeof body === 'string' && headers.get('content-type')?.includes('application/json') &&
    /\\u(?:0000|d[89a-f][0-9a-f]{2})/i.test(body)) {
    body = JSON.stringify(stripUnstorableJsonChars(JSON.parse(body)));
  }
  // Hosted requests gain only JSON sanitization, not local routing/auth or a
  // different timeout policy.
  if (!isLocalPostgrest) return globalThis.fetch(input, { ...init, body });

  const controller = new AbortController();
  const timer = setTimeout(
    // ВАЖНО: причина отмены — DOMException с name='AbortError', а НЕ обычный Error.
    // Иначе postgrest-js не распознаёт отмену и РЕТРАИТ идемпотентные GET/HEAD 3× с
    // backoff (≈87с вместо 20с, долбя лежащую 144). Паттерн как в supabaseAdmin.ts.
    () =>
      controller.abort(
        new DOMException(`instantly PostgREST timeout после ${POSTGREST_TIMEOUT_MS}ms`, 'AbortError'),
      ),
    POSTGREST_TIMEOUT_MS,
  );
  // Уважаем внешний signal (если supabase-js когда-нибудь начнёт его передавать).
  const upstream = init?.signal;
  if (upstream) {
    if (upstream.aborted) controller.abort(upstream.reason);
    else upstream.addEventListener('abort', () => controller.abort(upstream.reason), { once: true });
  }

  return globalThis
    .fetch(raw.replace('/rest/v1', ''), { ...init, body, headers, signal: controller.signal })
    .finally(() => clearTimeout(timer));
};

export const supabaseInstantly = url
  ? createClient(url, key ?? 'local-postgrest', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: postgrestFetch },
    })
  : null;
