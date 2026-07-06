import 'server-only';
import { createClient } from '@supabase/supabase-js';

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
  headers.delete('Authorization');
  headers.delete('apikey');

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`instantly PostgREST timeout после ${POSTGREST_TIMEOUT_MS}ms`)),
    POSTGREST_TIMEOUT_MS,
  );
  // Уважаем внешний signal (если supabase-js когда-нибудь начнёт его передавать).
  const upstream = init?.signal;
  if (upstream) {
    if (upstream.aborted) controller.abort(upstream.reason);
    else upstream.addEventListener('abort', () => controller.abort(upstream.reason), { once: true });
  }

  return globalThis
    .fetch(raw.replace('/rest/v1', ''), { ...init, headers, signal: controller.signal })
    .finally(() => clearTimeout(timer));
};

export const supabaseInstantly = url
  ? createClient(url, key ?? 'local-postgrest', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      ...(isLocalPostgrest ? { global: { fetch: postgrestFetch } } : {}),
    })
  : null;
