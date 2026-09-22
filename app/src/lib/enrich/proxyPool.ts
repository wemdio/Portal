/**
 * Общий пул прокси для enrich-парсеров.
 *
 * Выделен из websiteParser.ts 21.09.2026 без изменения поведения: те же
 * переменные окружения, тот же round-robin, те же группы. Понадобился
 * почтовому скраперу, которому нужен RU-адрес на ретрае 403 — RU-сайты
 * отдают 403 нашему US-egress'у (139.60.162.24, HOSTKEY New York).
 *
 * Приоритетная группа (обычно российские DC-прокси) идёт ПЕРВОЙ при каждом
 * запросе. Fallback (зарубежные HK/EU) — только на retry, если прокси из
 * priority отказал: инцидент 28.07.2026, ИНН-парсер имел success rate 27%
 * из-за того что 9/12 прокси в общем пуле — HK/EU, и .ru-сайты отдавали им
 * 403/Cloudflare-геоблок.
 *
 * Приоритет источников:
 *   YANDEXMAPS_PROXY_URLS_PRIORITY (юзер вписывает только RU) →
 *   YANDEXMAPS_PROXY_URLS →
 *   PROXY_URLS (legacy fallback).
 * Если PRIORITY пуст, YANDEXMAPS_PROXY_URLS используется как приоритет
 * (поведение до фикса 28.07.2026).
 */

type Dispatcher = import('undici').Dispatcher;

export function parseProxyEnv(raw: string): string[] {
  const s = raw.trim();
  if (!s) return [];
  try {
    if (s.startsWith('[')) {
      return (JSON.parse(s) as string[]).map((v) => v.trim()).filter(Boolean);
    }
    return s.split(/[\n,;]+/).map((v) => v.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

let _proxyGroups: { priority: string[]; fallback: string[] } | null = null;

export function getProxyGroups(): { priority: string[]; fallback: string[] } {
  if (_proxyGroups) return _proxyGroups;
  const priorityRaw = process.env.YANDEXMAPS_PROXY_URLS_PRIORITY ?? '';
  const yandexRaw = process.env.YANDEXMAPS_PROXY_URLS ?? '';
  const legacyRaw = process.env.PROXY_URLS ?? '';
  const priority = parseProxyEnv(priorityRaw);
  const fallback = parseProxyEnv(yandexRaw || legacyRaw);
  if (priority.length === 0) {
    _proxyGroups = { priority: fallback, fallback: [] };
  } else {
    _proxyGroups = { priority, fallback };
  }
  return _proxyGroups;
}

/** Только для тестов: сбросить закэшированные группы после подмены env. */
export function resetProxyGroupsCache(): void {
  _proxyGroups = null;
}

let _priorityRR = 0;
let _fallbackRR = 0;

export function pickProxyUrl(preferPriority = true): string {
  const { priority, fallback } = getProxyGroups();
  if (preferPriority && priority.length > 0) {
    _priorityRR = (_priorityRR + 1) % priority.length;
    return priority[_priorityRR];
  }
  if (fallback.length > 0) {
    _fallbackRR = (_fallbackRR + 1) % fallback.length;
    return fallback[_fallbackRR];
  }
  // Нет fallback — крутимся по priority (лучше ретрай через тот же RU,
  // чем прямое соединение с IP US-сервера, которое Cloudflare-геоблок гарантирует).
  if (priority.length === 0) return '';
  _priorityRR = (_priorityRR + 1) % priority.length;
  return priority[_priorityRR];
}

let _otherRR = 0;

/**
 * Нода из «другого» пула: fallback без приоритетных адресов.
 *
 * pickProxyUrl(false) для этого не годится — YANDEXMAPS_PROXY_URLS содержит и
 * RU-ноды тоже, так что «второй шанс» в 3 случаях из 8 снова попадал бы в RU.
 * А смысл второго шанса как раз в другой подсети: замер 23.09.2026 (98 сайтов
 * × 8 нод) показал, что сайты режут прокси блоками по подсетям провайдера.
 * eksis.ru не пускает ни одну RU-ноду, но открывается через 154.19x; mikron.ru
 * наоборот — только через RU.
 */
export function pickNonPriorityProxyUrl(): string {
  const { priority, fallback } = getProxyGroups();
  const others = fallback.filter((u) => !priority.includes(u));
  if (others.length === 0) return '';
  _otherRR = (_otherRR + 1) % others.length;
  return others[_otherRR];
}

const _proxyDispatchers = new Map<string, Dispatcher>();

async function dispatcherFor(url: string): Promise<Dispatcher | undefined> {
  if (!url) return undefined;
  const existing = _proxyDispatchers.get(url);
  if (existing) return existing;
  try {
    const mod = await import('undici');
    const d = new mod.ProxyAgent(url) as unknown as Dispatcher;
    _proxyDispatchers.set(url, d);
    return d;
  } catch {
    return undefined;
  }
}

export async function getProxyDispatcher(preferPriority = true): Promise<Dispatcher | undefined> {
  return dispatcherFor(pickProxyUrl(preferPriority));
}

/** Dispatcher через ноду НЕ из приоритетного пула (см. pickNonPriorityProxyUrl). */
export async function getNonPriorityProxyDispatcher(): Promise<Dispatcher | undefined> {
  return dispatcherFor(pickNonPriorityProxyUrl());
}

/**
 * Пропуск в пул для разовых ретраев. Нужен потому, что прокси общие с
 * парсерами Яндекс.Карт: замер 21.09.2026 на боевом воркере показал ровную
 * работу пула до 75 одновременных запросов (p50 ≈ 0,78 с, ошибок 0, ~50 rps),
 * а на 150 — насыщение: p50 растёт до 2,1 с при том же потолке ~60 rps.
 *
 * Лимит на процесс, а реплик enrich-воркера девять, поэтому дефолт 6 держит
 * суммарный потолок ≈54 — внутри ровной зоны. Ждать очереди мы не даём:
 * не досталось пропуска — ретрая просто не будет, скорость основного
 * прохода важнее лишнего домена.
 */
const PROXY_RETRY_CONCURRENCY = Number(process.env.ENRICH_PROXY_RETRY_CONCURRENCY ?? '6');
let _inFlight = 0;

export function tryAcquireProxySlot(): (() => void) | null {
  if (PROXY_RETRY_CONCURRENCY <= 0) return null;
  if (_inFlight >= PROXY_RETRY_CONCURRENCY) return null;
  _inFlight += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    _inFlight -= 1;
  };
}

/** Только для тестов/метрик. */
export function proxySlotsInFlight(): number {
  return _inFlight;
}
