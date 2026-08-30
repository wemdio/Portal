import { NO_MANAGER } from '@/lib/firstSales/metrics';
import { resolveSource } from '@/lib/firstSales/sources';

/**
 * Отбор сделок для раскрытой строки дашборда первички («что за этой цифрой»).
 *
 * Срез — либо источник, либо менеджер, и от этого зависит, нужен ли вдобавок
 * фильтр по источникам из шапки страницы:
 *
 *   * Провал в ИСТОЧНИК. Фильтр не нужен и был бы вреден: строка сама и есть
 *     источник, а второй список источников поверх неё способен только отнять
 *     сделки, которые сводка уже посчитала.
 *   * Провал в МЕНЕДЖЕРА. Фильтр нужен обязательно. Разбивка по менеджерам
 *     считается ПОСЛЕ фильтра источников, поэтому у Егора в строке стоит 2, а
 *     список без фильтра показывал все его сделки за период — восемнадцать
 *     штук (инцидент 30.08.2026: включён фильтр «Без источника»). Цифра и
 *     список под ней обязаны отвечать на один и тот же вопрос.
 *
 * Раньше правило жило одной строкой в ручке и звучало как «фильтр по
 * источникам здесь НЕ применяется» — верно ровно для половины случаев.
 */

/** Срез, в который провалился пользователь. Ровно один из двух. */
export type DrillSlice = { source: string } | { manager: string };

type LeadForDrill = {
  raw: unknown;
  responsible_name: string | null;
};

/**
 * Разбирает срез из query.
 *
 * `source` служит сразу двум ролям — это и ключ среза, и (при провале в
 * менеджера) фильтр из шапки, который приходит теми же повторяющимися
 * параметрами. Разводим их по наличию `manager`: он есть — значит все
 * `source` являются фильтром; его нет — значит `source` должен быть ровно
 * один и он и есть срез. Иначе пришлось бы заводить второе имя параметра под
 * то же самое понятие.
 */
export function parseDrillSlice(
  url: URL,
): { value: DrillSlice; error: null } | { value: null; error: string } {
  const manager = url.searchParams.get('manager');
  if (manager !== null) return { value: { manager }, error: null };

  // Проверяем на `null`, а не на пустоту: отсутствие параметра — ошибка
  // вызова, а пустая строка — законное (пусть и ничего не находящее) значение.
  const sources = url.searchParams.getAll('source');
  if (sources.length === 0) {
    return { value: null, error: 'Нужен ровно один параметр: source или manager' };
  }
  if (sources.length > 1) {
    return {
      value: null,
      error: 'Несколько source без manager: непонятно, какой из них срез',
    };
  }
  return { value: { source: sources[0] }, error: null };
}

/**
 * Предикат отбора сделок под раскрытую строку.
 *
 * `sources` — фильтр из шапки страницы (`null` — фильтра нет). Применяется
 * только к срезу по менеджеру, почему — см. шапку файла.
 */
export function matchesDrill(
  slice: DrillSlice,
  sources: string[] | null,
): (lead: LeadForDrill) => boolean {
  if ('source' in slice) {
    return (lead) => resolveSource(lead.raw).key === slice.source;
  }

  // `NO_MANAGER` — литерал строки «без ответственного» из разбивки: своих
  // идентификаторов у этого среза нет, группировка в metrics.ts идёт по тому
  // же имени, что показано в таблице.
  const allowed = sources === null ? null : new Set(sources);
  return (lead) => {
    if ((lead.responsible_name ?? NO_MANAGER) !== slice.manager) return false;
    if (allowed === null) return true;
    return allowed.has(resolveSource(lead.raw).key);
  };
}
