/**
 * Что показывать в выпадающем списке прокси при назначении на аккаунт.
 *
 * Список свободных прокси отвечал только на вопрос «какие адреса не заняты»,
 * и все сорок строк выглядели одинаково: один и тот же хост, разный порт.
 * Оператор выбирал вслепую и с равной вероятностью сажал аккаунт на прокси,
 * который уже неделю не отвечает. При этом портал про каждый из них знает —
 * счётчики ошибок, отлёжка и последний успешный круг лежат в той же строке,
 * которую экран и так загрузил.
 *
 * Здесь эти данные превращаются в порядок и подписи: сначала те, через
 * которые рассылка только что проходила, следом непроверенные, и в самом
 * низу сбоящие. Отбор свободных остаётся прежним (`proxySelection`) — этот
 * модуль ничего не прячет, а только сортирует и подписывает: занять сбоящий
 * прокси иногда осмысленно (других нет, а проверять его всё равно нужно
 * рассылкой), запрещать это не за что.
 *
 * Чистые функции: данные и состояние экрана — снаружи, поведение — здесь.
 */

import { describeProxy, type HealthMark, type HealthProxy, type HealthTone } from './accountHealth';

export interface PickerProxy extends HealthProxy {
  id: string;
  url: string;
  name?: string;
}

export interface ProxyPickerItem<T extends PickerProxy> {
  proxy: T;
  /** Тот же диагноз, что и в колонке «Здоровье прокси» — язык на экране один. */
  mark: HealthMark;
}

export interface ProxyPickerGroup<T extends PickerProxy> {
  tone: HealthTone;
  /** Заголовок секции. */
  title: string;
  /** Что этот статус означает для выбора — строкой под заголовком. */
  hint: string;
  items: ProxyPickerItem<T>[];
}

/**
 * Порядок секций = порядок, в котором прокси стоит выбирать.
 *
 * `unknown` выше `warn` намеренно: «через него ещё не было круга» — это
 * незнание, а «подряд идут ошибки» — уже известная поломка. Ставить их рядом
 * значило бы приравнять одно к другому.
 */
const GROUP_ORDER: { tone: HealthTone; title: string; hint: string }[] = [
  {
    tone: 'ok',
    title: 'Работают',
    hint: 'Через них недавно проходила рассылка — можно брать',
  },
  {
    tone: 'unknown',
    title: 'Не проверялись',
    hint: 'Кругов через них ещё не было: сработают или нет — узнаем только рассылкой',
  },
  {
    tone: 'warn',
    title: 'Сбоят',
    hint: 'Подряд идут ошибки. Ещё немного — и прокси уйдёт на отлёжку, а аккаунт останется без связи',
  },
  {
    tone: 'bad',
    title: 'Не работают',
    hint: 'Выключен или на отлёжке — рассылка через такой прокси не пойдёт',
  },
];

/**
 * Разложить прокси по секциям для выпадающего списка.
 *
 * Внутри секции порядок исходный — он осмысленный (по дате добавления), и
 * пересортировывать его вторым ключом значит лишить оператора единственной
 * стабильной точки отсчёта. Пустые секции не возвращаются: заголовок без
 * строк читается как «сбоящих нет, но мы их всё же упомянем».
 */
export function groupProxiesForPicker<T extends PickerProxy>(
  proxies: T[],
  now: number,
): ProxyPickerGroup<T>[] {
  const byTone = new Map<HealthTone, ProxyPickerItem<T>[]>();
  for (const proxy of proxies) {
    const mark = describeProxy(proxy, now);
    const bucket = byTone.get(mark.tone);
    if (bucket) bucket.push({ proxy, mark });
    else byTone.set(mark.tone, [{ proxy, mark }]);
  }
  return GROUP_ORDER
    .map((g) => ({ ...g, items: byTone.get(g.tone) ?? [] }))
    .filter((g) => g.items.length > 0);
}

/**
 * Секции в один список — в том же порядке, в каком они на экране.
 *
 * Нужно клавиатуре: стрелки ходят по строкам, а не по секциям, и порядок
 * обхода обязан совпадать с видимым, иначе «вниз» уводит вверх.
 */
export function flattenPickerGroups<T extends PickerProxy>(
  groups: ProxyPickerGroup<T>[],
): ProxyPickerItem<T>[] {
  return groups.flatMap((g) => g.items);
}

/** Сколько прокси в списке можно брать не задумываясь — для строки-итога. */
export function readyProxyCount<T extends PickerProxy>(groups: ProxyPickerGroup<T>[]): number {
  return groups.find((g) => g.tone === 'ok')?.items.length ?? 0;
}
