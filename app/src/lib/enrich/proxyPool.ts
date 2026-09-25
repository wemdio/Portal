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

// ── Выбывание нод ────────────────────────────────────────────────
// Нода, которая трижды подряд не пустила в туннель по своей вине (отказ,
// сброс, закрытие CONNECT без ответа, TCP-таймаут), выбывает на 60 с.
// Отказ сразу после возврата выводит её снова на вдвое больший срок, до
// 15 мин; 407 — сразу на 15 мин. Любой ответ ноды на CONNECT (в том числе
// 5xx — это голос сайта за ней) обнуляет счёт. Состояние — в памяти
// процесса, общее для всех, кто выбирает ноду через этот пул.
const NODE_FAILURES_TO_TRIP = 3;
const NODE_OUT_MS = 60_000;
const NODE_OUT_MAX_MS = 15 * 60_000;

type NodeHealth = { failures: number; outUntil: number; trips: number };
const _nodeHealth = new Map<string, NodeHealth>();

function nodeOut(url: string, now = Date.now()): boolean {
  return (_nodeHealth.get(url)?.outUntil ?? 0) > now;
}

/** Номер ноды для журнала: адрес с логином и паролем наружу не уходит. */
function nodeLabel(url: string): string {
  const { priority, fallback } = getProxyGroups();
  const index = priority.indexOf(url);
  if (index >= 0) return `RU-прокси №${index + 1}`;
  const other = fallback.indexOf(url);
  return other >= 0 ? `Прокси №${other + 1} запасной группы` : 'Прокси вне пула';
}

function tripNode(url: string, state: NodeHealth, ms: number, why: string): void {
  state.trips += 1;
  state.failures = 0;
  state.outUntil = Date.now() + ms;
  _nodeHealth.set(url, state);
  console.warn(`[proxyPool] ${nodeLabel(url)} выбыл на ${Math.round(ms / 1000)} с: ${why}`);
}

/** Исход CONNECT к ноде (см. boundedProxyAgent). */
export function reportProxyNodeResult(url: string, kind: 'answered' | 'auth' | 'down', detail = ''): void {
  if (!url) return;
  if (kind === 'answered') {
    _nodeHealth.delete(url);
    return;
  }
  const state = _nodeHealth.get(url) ?? { failures: 0, outUntil: 0, trips: 0 };
  const reason = detail ? ` (${detail})` : '';
  if (kind === 'auth') {
    // Параллельные CONNECT к выбывшей ноде: срок — до 15 мин, без новой строки в журнал.
    if (nodeOut(url)) state.outUntil = Math.max(state.outUntil, Date.now() + NODE_OUT_MAX_MS);
    else tripNode(url, state, NODE_OUT_MAX_MS, `не принял логин и пароль${reason}`);
    return;
  }
  // Поздние отказы соединений, начатых до выбывания, срок не продлевают.
  if (nodeOut(url)) return;
  state.failures += 1;
  if (state.trips > 0) {
    tripNode(url, state, Math.min(NODE_OUT_MS * 2 ** state.trips, NODE_OUT_MAX_MS), `отказ соединения после возврата${reason}`);
  } else if (state.failures >= NODE_FAILURES_TO_TRIP) {
    tripNode(url, state, NODE_OUT_MS, `${state.failures} отказа соединения подряд${reason}`);
  } else {
    _nodeHealth.set(url, state);
  }
}

/** Только для тестов: вернуть все ноды в строй. */
export function resetProxyNodeHealth(): void {
  _nodeHealth.clear();
}

/** Выбывшие ноды приоритетной группы — номера с 1, без адресов. */
export function proxyPoolHealth(): { priorityOut: number[] } {
  const now = Date.now();
  return { priorityOut: getProxyGroups().priority.flatMap((url, index) => (nodeOut(url, now) ? [index + 1] : [])) };
}

/** Следующая живая нода группы по кругу; '' — живых нет. */
function pickLive(group: string[], cursor: number): [string, number] {
  const now = Date.now();
  for (let step = 1; step <= group.length; step += 1) {
    const index = (cursor + step) % group.length;
    if (!nodeOut(group[index], now)) return [group[index], index];
  }
  return ['', cursor];
}

let _priorityRR = 0;
let _fallbackRR = 0;

/** Выбывшие ноды пропускаются. Все ноды группы выбыли — '': у вызывающих
 * уже есть путь «прокси нет». */
export function pickProxyUrl(preferPriority = true): string {
  const { priority, fallback } = getProxyGroups();
  let url: string;
  if (preferPriority && priority.length > 0) {
    [url, _priorityRR] = pickLive(priority, _priorityRR);
    return url;
  }
  if (fallback.length > 0) {
    [url, _fallbackRR] = pickLive(fallback, _fallbackRR);
    return url;
  }
  // Нет fallback — крутимся по priority (лучше ретрай через тот же RU,
  // чем прямое соединение с IP US-сервера, которое Cloudflare-геоблок гарантирует).
  if (priority.length === 0) return '';
  [url, _priorityRR] = pickLive(priority, _priorityRR);
  return url;
}

/** Есть ли живая нода в группе, которую выбрал бы pickProxyUrl. */
export function hasLiveProxy(preferPriority = true): boolean {
  const { priority, fallback } = getProxyGroups();
  const group = preferPriority && priority.length > 0 ? priority : fallback.length > 0 ? fallback : priority;
  const now = Date.now();
  return group.some((url) => !nodeOut(url, now));
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
  let url: string;
  [url, _otherRR] = pickLive(others, _otherRR);
  return url;
}

const _proxyDispatchers = new Map<string, Dispatcher>();

// Туннель (CONNECT и TLS к сайту) ограничен самым длинным окном страницы у
// тех, кто читает через пул: 15 с у websiteEnrichmentWorker и
// fetchAndExtract(…, { timeout: 15_000 }). Короче нельзя: срок общий для
// всех, и медленный, но рабочий туннель обрывался бы раньше окна вызывающего.
// Раньше CONNECT ждал до 300 с. От шторма защищает не срок, а окончательный
// сбой туннеля (boundedProxyAgent). Число соединений и keep-alive — прежние.
const ENRICH_TUNNEL_TIMEOUT_MS = 15_000;

async function dispatcherFor(url: string): Promise<Dispatcher | undefined> {
  if (!url) return undefined;
  const existing = _proxyDispatchers.get(url);
  if (existing) return existing;
  try {
    const { createBoundedProxyAgent } = await import('./boundedProxyAgent');
    const d = createBoundedProxyAgent(url, {
      tunnelTimeoutMs: ENRICH_TUNNEL_TIMEOUT_MS,
      onNodeResult: (kind, detail) => reportProxyNodeResult(url, kind, detail),
    }) as unknown as Dispatcher;
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
