import { extractCustomField } from '@/lib/leadsReport/extractCustomField';

export type SummaryChannelName =
  | 'marketing'
  | 'smm'
  | 'outreach'
  | 'partners'
  | 'tg_outreach';

export type ChannelSummaryConfig = {
  name: SummaryChannelName;
  displayName: string;
};

export const SUMMARY_CHANNELS: ChannelSummaryConfig[] = [
  { name: 'marketing', displayName: 'Маркетинг' },
  { name: 'smm', displayName: 'SMM' },
  { name: 'outreach', displayName: 'Аутрич' },
  { name: 'partners', displayName: 'Партнёрка' },
  { name: 'tg_outreach', displayName: 'TG Outreach' },
];

const normalize = (value: string | null): string =>
  (value ?? '').trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');

/**
 * Источники, которые сознательно НЕ считаются в отчёт продаж.
 *
 * `портал (outreachos)` — автоаутрич с портала. За неделю 31.07–07.08 это была
 * 21 сделка, треть всего недельного потока, и одна из них дошла до проведённой
 * встречи. Решение Дмитрия от 10.08.2026 — не считать: отчёт сравнивают с
 * ручным, где автоаутрича нет.
 *
 * Список нужен именно явный: без него источник просто не подходит ни под одно
 * правило и молча выпадает, что неотличимо от пробела в классификации — на
 * разбор этого «пробела» уже ушло два расследования (03.08 и 10.08).
 */
export const EXCLUDED_SOURCES = new Set(['портал (outreachos)']);

/**
 * Возвращает канал сделки — либо один из пяти известных, либо `null`
 * если ни одно правило не сработало (сделка не считается в отчёт).
 *
 * Приоритет:
 *   1. Явно исключённые источники (см. EXCLUDED_SOURCES) — сознательное решение
 *      не считать, сильнее любых других пометок.
 *   2. Явный маркер «Контур» = «Маркетинг» — эти сделки команда вручную
 *      помечает как маркетинговые. Раньше «маркетинг» был мусорным fallback,
 *      куда падали 1399 сделок без «Источник» — теперь только явный маркер.
 *   3. Остальные 4 канала — по кастомному полю «Источник» AMO
 *      (алиасы оставлены на случай переименования значений).
 *   4. Если ни одно правило не сработало — `null`, сделка пропускается.
 */
export function detectSummaryChannel(raw: unknown): SummaryChannelName | null {
  const source = normalize(extractCustomField(raw, 'Источник'));
  // Проверка идёт до «Контура»: решение «не считать» не должно обходиться
  // пометкой контура, поставленной вручную.
  if (EXCLUDED_SOURCES.has(source)) return null;

  const kontur = normalize(extractCustomField(raw, 'Контур'));
  if (kontur === 'маркетинг') return 'marketing';

  const utmMedium = normalize(extractCustomField(raw, 'utm_medium'));

  if (source === 'telegram outreach') return 'tg_outreach';
  if (['партнер', 'партнерка'].includes(source)) return 'partners';
  if (['email outreach', 'аутрич'].includes(source)) return 'outreach';
  // SMM: явное «SMM»/utm_medium=smm либо контент-канал «Личный бренд (инст/ютуб)»
  // (согласовано с Никитой 2026-07-24).
  if (
    ['smm', 'смм'].includes(source)
    || utmMedium === 'smm'
    || source === 'личный бренд (инст /ютуб)'
  ) return 'smm';

  return null;
}
