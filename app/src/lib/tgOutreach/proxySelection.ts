/**
 * Какие прокси можно предложить аккаунту.
 *
 * Ключ занятости — АДРЕС прокси, а не строка в базе, и считается он по всему
 * порталу. Это не педантизм: для Telegram один адрес — это одно устройство, и
 * два аккаунта на нём читаются как «один человек с двух телефонов», то есть
 * прямой повод для блокировки. Ровно ради этого выпадающий список и прячет
 * занятые.
 *
 * Прежняя версия считала по id строки и только внутри кампании, и ломалась
 * двумя способами сразу:
 *
 *   - один и тот же адрес заведён несколькими строками (на 27.08.2026 в базе
 *     598 записей на 532 адреса, причём дубли есть и внутри одной кампании).
 *     Оператор назначал первую строку, вторая оставалась «свободной» и тут же
 *     предлагалась следующему аккаунту — тот же прокси под другим id;
 *   - 66 адресов заведены сразу в двух кампаниях, поэтому прокси, занятый в
 *     соседней кампании, здесь числился свободным.
 *
 * Чистые функции: состояние экрана и запросы — снаружи, поведение — здесь и
 * под тестами.
 */

export interface SelectableProxy {
  id: string;
  url: string;
  name?: string;
}

export interface ProxyHolder {
  proxy_id?: string | null;
}

/**
 * Приводит адрес к виду, в котором два написания одного прокси совпадают.
 *
 * Намеренно повторяет `normalizeProxyUrl` из apiHelpers лишь в части регистра и
 * пробелов: сравнение должно быть устойчивым и к схеме, дописанной сервером при
 * сохранении, и к её отсутствию в старых строках.
 */
export function proxyUrlKey(url: string | null | undefined): string {
  return (url ?? '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^socks5?:\/\//, '')
    .replace(/\/+$/, '');
}

/**
 * Адреса, которые уже кем-то заняты.
 *
 * Складываем два источника. `serverTakenUrls` — снимок по всему порталу, каким
 * его отдала ручка. Локальные назначения — то, что оператор сделал на этом
 * экране только что: между назначением и следующей загрузкой списка он успевает
 * открыть соседнюю строку, и без этого слагаемого прокси предлагался бы дважды.
 */
export function takenProxyUrls(args: {
  serverTakenUrls: string[];
  accounts: ProxyHolder[];
  proxies: SelectableProxy[];
}): Set<string> {
  const taken = new Set(args.serverTakenUrls.map(proxyUrlKey).filter(Boolean));
  const urlById = new Map(args.proxies.map((p) => [p.id, p.url]));
  for (const account of args.accounts) {
    if (!account.proxy_id) continue;
    const key = proxyUrlKey(urlById.get(account.proxy_id));
    if (key) taken.add(key);
  }
  return taken;
}

/**
 * Свободные прокси кампании — по одному на адрес.
 *
 * Дедуп обязателен: две строки одного прокси в списке выглядят как два разных
 * варианта, оператор «выбирает другой», а получает тот же самый адрес.
 * Порядок сохраняем исходный — он осмысленный (по дате добавления).
 */
export function selectableProxies<T extends SelectableProxy>(
  proxies: T[],
  taken: Set<string>,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const proxy of proxies) {
    const key = proxyUrlKey(proxy.url);
    if (!key || taken.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(proxy);
  }
  return out;
}

/**
 * Варианты для конкретной строки: свободные плюс собственный прокси аккаунта.
 *
 * Без своего оператор не увидел бы, что вообще стоит в строке, и открытая
 * выпадашка выглядела бы как «прокси сбросился».
 */
export function proxyOptionsFor<T extends SelectableProxy>(
  currentProxyId: string | null | undefined,
  proxies: T[],
  free: T[],
): T[] {
  const current = currentProxyId ? proxies.find((p) => p.id === currentProxyId) : null;
  if (!current) return free;
  return free.some((p) => p.id === current.id) ? free : [current, ...free];
}
