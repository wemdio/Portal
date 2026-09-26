/**
 * Пачки для in-фильтра PostgREST. Значения фильтра уезжают в адрес запроса, а
 * шлюз перед PostgREST режет адреса длиннее ~9–13 КБ (414). Пачка «по N штук»
 * этого не гарантирует: сто длинных адресов почты весят вдвое больше ста
 * коротких. Поэтому пачка набирается по весу — сумме закодированных длин
 * значений, с запасом до остальной части адреса (таблица, другие фильтры).
 */

/** Сколько закодированных байт значений кладём в один запрос. */
export const IN_FILTER_BUDGET_BYTES = 4000;

/**
 * Разбить значения на пачки не тяжелее budget байт в адресе запроса. Вес
 * значения — его длина после кодирования (у почты «@» становится «%40») плюс
 * закодированная запятая-разделитель («%2C»). Значение тяжелее всего бюджета
 * идёт отдельной пачкой: разрезать его нельзя.
 */
export function chunkForInFilter(values: string[], budget: number = IN_FILTER_BUDGET_BYTES): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let weight = 0;
  for (const value of values) {
    const cost = encodeURIComponent(value).length + 3;
    if (current.length && weight + cost > budget) {
      chunks.push(current);
      current = [];
      weight = 0;
    }
    current.push(value);
    weight += cost;
  }
  if (current.length) chunks.push(current);
  return chunks;
}
