/**
 * Пул residential-прокси для email-скрапера.
 *
 * Формат `PROXY_URLS` тот же, что у websiteParser.ts / hhParser.ts —
 * JSON-массив строк `["http://user:pass@ip:port", ...]` либо список через
 * запятую.
 *
 * Зачем отдельный модуль (2026-07-30). С 21.07 email-скрапер ходит через этот
 * пул, и сбор базы замедлился в ~2.4 раза: доля строк, упавших в таймаут 60с,
 * выросла 5.4% → 32.9%, среднее число попыток 1.07 → 1.76. Причина не в самой
 * идее прокси, а в том, что мёртвый или перегруженный IP не отвечает вообще:
 * запрос висит до общего таймаута строки, и запасной прямой запрос уже не
 * успевает выполниться. Четыре IP обслуживают до 75 сайтов в полёте
 * (3 реплики × WEBSITE_ENRICHMENT_CONCURRENCY=25), плюс парсер Яндекс.Карт и
 * поиск ИНН на том же пуле.
 *
 * Поэтому здесь три вещи:
 *   1. `proxyAttemptTimeoutMs()` — короткий бюджет на попытку через прокси,
 *      чтобы остаток времени строки достался прямому запросу;
 *   2. ejection — IP, не ответивший подряд `FAILS_BEFORE_EJECT` раз, выводится
 *      из ротации на `EMAIL_SCRAPER_PROXY_EJECT_MS`;
 *   3. `EMAIL_SCRAPER_PROXY=0` — мгновенный откат на прямые запросы, без деплоя.
 */

type Dispatcher = import('undici').Dispatcher;

const FAILS_BEFORE_EJECT = 3;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 8_000;
const DEFAULT_EJECT_MS = 5 * 60_000;

let _urls: string[] | null = null;
let _rr = 0;

type Health = { fails: number; ejectedUntil: number };
const _health = new Map<string, Health>();
const _dispatchers = new Map<string, Dispatcher>();

/** Прокси можно выключить одной переменной окружения — без пересборки образа */
export function isProxyEnabled(): boolean {
  return (process.env.EMAIL_SCRAPER_PROXY ?? '1') !== '0';
}

export function proxyAttemptTimeoutMs(): number {
  const raw = Number(process.env.EMAIL_SCRAPER_PROXY_TIMEOUT_MS ?? DEFAULT_ATTEMPT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ATTEMPT_TIMEOUT_MS;
}

function ejectMs(): number {
  const raw = Number(process.env.EMAIL_SCRAPER_PROXY_EJECT_MS ?? DEFAULT_EJECT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EJECT_MS;
}

export function getProxyUrls(): string[] {
  if (_urls) return _urls;
  const raw = (process.env.PROXY_URLS ?? '').trim();
  try {
    _urls = raw.startsWith('[')
      ? (JSON.parse(raw) as string[]).map((s) => String(s).trim()).filter(Boolean)
      : raw.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  } catch {
    _urls = [];
  }
  return _urls;
}

/** Живой прокси из ротации, либо `''` — значит идём напрямую */
export function pickProxyUrl(now: number = Date.now()): string {
  if (!isProxyEnabled()) return '';
  const urls = getProxyUrls();
  if (!urls.length) return '';

  for (let i = 0; i < urls.length; i += 1) {
    _rr = (_rr + 1) % urls.length;
    const url = urls[_rr];
    const health = _health.get(url);
    if (!health || health.ejectedUntil <= now) return url;
  }
  // Все IP в бане — честнее пойти напрямую, чем ждать заведомо мёртвый
  return '';
}

/** Итог запроса через прокси: успех обнуляет счётчик, серия отказов — бан */
export function reportProxyResult(url: string, ok: boolean, now: number = Date.now()): void {
  if (!url) return;
  if (ok) {
    _health.delete(url);
    return;
  }
  const health = _health.get(url) ?? { fails: 0, ejectedUntil: 0 };
  health.fails += 1;
  if (health.fails >= FAILS_BEFORE_EJECT) {
    health.ejectedUntil = now + ejectMs();
    health.fails = 0;
  }
  _health.set(url, health);
}

export async function getProxyDispatcher(
  now: number = Date.now(),
): Promise<{ url: string; dispatcher: Dispatcher } | null> {
  const url = pickProxyUrl(now);
  if (!url) return null;

  const existing = _dispatchers.get(url);
  if (existing) return { url, dispatcher: existing };

  try {
    const mod = await import('undici');
    const dispatcher = new mod.ProxyAgent(url) as unknown as Dispatcher;
    _dispatchers.set(url, dispatcher);
    return { url, dispatcher };
  } catch {
    return null;
  }
}

/** Только для тестов: сбросить кэш env и статистику здоровья */
export function __resetProxyPool(): void {
  _urls = null;
  _rr = 0;
  _health.clear();
  _dispatchers.clear();
}
