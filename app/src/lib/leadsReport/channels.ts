import { extractCustomField } from '@/lib/leadsReport/extractCustomField';

export type SummaryChannelName =
  | 'marketing'
  | 'smm'
  | 'outreach'
  | 'partners'
  | 'tg_outreach'
  | 'conference'
  | 'sdr'
  | 'auto_outreach'
  | 'eng_tg_outreach'
  | 'eng_email_outreach';

export type ChannelSummaryConfig = {
  name: SummaryChannelName;
  displayName: string;
};

/**
 * Каналы основного сообщения отчёта — те, что сверяют с ручным отчётом
 * продаж строка в строку (состав согласован с Дмитрием 31.08.2026).
 *
 * Автоаутрич и оба ENG здесь, хотя вручную их не считают: строки для них
 * ждут в ручном отчёте, поэтому место им в основном сообщении, а не в
 * дополнительном.
 */
export const MAIN_SUMMARY_CHANNELS: ChannelSummaryConfig[] = [
  { name: 'marketing', displayName: 'Маркетинг' },
  { name: 'smm', displayName: 'SMM' },
  { name: 'outreach', displayName: 'Аутрич' },
  { name: 'partners', displayName: 'Партнёрка + сарафан' },
  { name: 'tg_outreach', displayName: 'TG Outreach' },
  { name: 'auto_outreach', displayName: 'Автоаутрич' },
  { name: 'eng_tg_outreach', displayName: 'ENG TG Outreach' },
  { name: 'eng_email_outreach', displayName: 'ENG Email Outreach' },
];

/**
 * Каналы, которых в ручном отчёте нет вообще (Дмитрий, 31.08.2026): их завели
 * 31.08, чтобы поток перестал быть невидимым. Идут ОТДЕЛЬНЫМ сообщением —
 * если склеить с основными, ручную сверку придётся вести по половине списка,
 * а бот разобьёт длинное сообщение как попало.
 */
export const EXTRA_SUMMARY_CHANNELS: ChannelSummaryConfig[] = [
  { name: 'conference', displayName: 'Конференции' },
  { name: 'sdr', displayName: 'SDR' },
];

export const SUMMARY_CHANNELS: ChannelSummaryConfig[] = [
  ...MAIN_SUMMARY_CHANNELS,
  ...EXTRA_SUMMARY_CHANNELS,
];

const normalize = (value: string | null): string =>
  (value ?? '').trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');

/**
 * Значение поля «Источник» AMO → канал отчёта.
 *
 * Разложено на встрече 31.08.2026 (расшифровка — `Встреча в Телемосте
 * 31.08.26`), сверено со всеми 27 значениями, реально встречающимися в
 * воронке за последние 120 дней. Ключи нормализованы (`normalize`): регистр,
 * «ё» и внешние пробелы значения не имеют, поэтому пиши их так, как значение
 * выглядит в AMO.
 *
 * Раньше на месте таблицы была цепочка `if`, и любое незнакомое значение
 * молча выпадало из отчёта — так потерялись `Email Outreach Eng` (сделка
 * hst.ie с проведённой встречей), `SDR` (ДримБудка и Nimax, тоже встречи) и
 * `Конференция` (9 сделок с конфы ТОК за одну неделю). Таблица не защищает от
 * появления НОВОГО значения сама по себе — от этого защищает
 * `UNMAPPED_SOURCES` ниже плюс алерт в `metrics.ts`.
 */
const SOURCE_TO_CHANNEL: ReadonlyMap<string, SummaryChannelName> = new Map(
  (
    [
      // Маркетинг — весь входящий поток с площадок студии.
      ['Сайт', 'marketing'],
      ['SEO', 'marketing'],
      ['PR', 'marketing'],
      ['Внешние статьи', 'marketing'],
      ['ТГ-канал', 'marketing'],
      ['ТГ-АДС', 'marketing'],
      ['TG-посев', 'marketing'],
      ['ТГ-посев', 'marketing'],
      ['Инст-посев', 'marketing'],
      ['ТГ Бот', 'marketing'],
      ['Бот', 'marketing'],
      ['Телеграм', 'marketing'],
      ['Email-рассылка', 'marketing'],
      // Названы на встрече, в базе пока не встречались — вписаны заранее,
      // чтобы первая же такая сделка не выпала из отчёта молча.
      ['Яндекс Директ', 'marketing'],
      ['ЯндексДирект', 'marketing'],
      ['ВК', 'marketing'],
      ['Avito', 'marketing'],
      ['Авито', 'marketing'],

      ['Личный бренд (инст /ютуб)', 'smm'],
      ['SMM', 'smm'],
      ['СММ', 'smm'],

      // Российский аутрич. «Аутрич» — легаси-значение (последняя сделка
      // 25.06): его перестали использовать, когда завели полноценный
      // «Email Outreach», но старые сделки читаются тем же правилом.
      ['Email Outreach', 'outreach'],
      ['Аутрич', 'outreach'],

      ['Telegram Outreach', 'tg_outreach'],

      // Партнёрка и сарафан — одна строка отчёта: «сарафан» это тот же
      // приход по рекомендации, только от старого клиента, а не от партнёра.
      ['Партнер', 'partners'],
      ['Партнерка', 'partners'],
      ['Сарафан', 'partners'],

      ['Конференция', 'conference'],
      ['SDR', 'sdr'],

      // Автоаутрич с портала и ручная пометка «Автоаутрич» — один канал.
      ['Автоаутрич', 'auto_outreach'],
      ['портал (outreachOS)', 'auto_outreach'],

      ['TG Outreach Eng', 'eng_tg_outreach'],
      ['Telegram Outreach Eng', 'eng_tg_outreach'],
      ['Email Outreach Eng', 'eng_email_outreach'],
    ] as [string, SummaryChannelName][]
  ).map(([source, channel]) => [normalize(source), channel]),
);

/**
 * Источники, которые сознательно НЕ считаются ни в одну строку отчёта.
 *
 * Список нужен именно явный: без него источник просто не подходит ни под одно
 * правило и молча выпадает, что неотличимо от пробела в классификации — на
 * разбор таких «пробелов» уже ушло три расследования (03.08, 10.08 и 31.08).
 *
 * `Лидскан` — сервис, которым перестали пользоваться (последняя сделка
 * 17.06.2026), решение встречи 31.08 — не считать.
 *
 * `Холодная база` — 50 сделок за последние 120 дней, последняя 05.08. На
 * встрече 31.08 не обсуждалась вообще, поэтому лежит здесь, а не в маркетинге
 * или аутриче: тихо приписать полсотни сделок к чужому каналу хуже, чем
 * оставить строку честно непосчитанной до решения продаж.
 */
export const UNMAPPED_SOURCES: ReadonlySet<string> = new Set(
  ['Лидскан', 'Холодная база'].map(normalize),
);

/**
 * Возвращает канал сделки — либо один из известных, либо `null`
 * если ни одно правило не сработало (сделка не считается в отчёт).
 *
 * Приоритет:
 *   1. Явный маркер «Контур» = «Маркетинг» — эту пометку команда ставит
 *      руками, и она сильнее источника. Конфликта с таблицей сегодня нет: у
 *      всех немаркетинговых источников (`Партнер`, `Конференция`, `SDR`,
 *      `портал (outreachOS)`, оба аутрича) «Контур» пуст во всех сделках за
 *      120 дней.
 *   2. Таблица `SOURCE_TO_CHANNEL` — источник сильнее любых utm-меток
 *      (Дмитрий, 31.08.2026). Практическое следствие: 26 сделок за полгода с
 *      «Источник» = «Сайт» и `utm_medium=smm` считаются Маркетингом, а не
 *      SMM, как считались раньше, когда «Сайт» не значил ничего.
 *   3. `utm_medium=smm` — запасной признак SMM для сделок, чей источник
 *      таблице неизвестен или не заполнен вовсе.
 *   4. Если ни одно правило не сработало — `null`, сделка пропускается.
 */
export function detectSummaryChannel(raw: unknown): SummaryChannelName | null {
  const source = normalize(extractCustomField(raw, 'Источник'));
  if (UNMAPPED_SOURCES.has(source)) return null;

  const kontur = normalize(extractCustomField(raw, 'Контур'));
  if (kontur === 'маркетинг') return 'marketing';

  const mapped = SOURCE_TO_CHANNEL.get(source);
  if (mapped) return mapped;

  if (normalize(extractCustomField(raw, 'utm_medium')) === 'smm') return 'smm';

  return null;
}

/**
 * Источник сделки, если он не разложен ни по одному правилу и не занесён в
 * `UNMAPPED_SOURCES` сознательно. Пустая строка (нет поля вовсе) не считается:
 * такие сделки были всегда, это не новый источник.
 *
 * Нужен, чтобы новое значение поля «Источник» не утекало из отчёта молча —
 * `metrics.ts` пишет такие в лог.
 */
export function unknownSourceOf(raw: unknown): string | null {
  const value = extractCustomField(raw, 'Источник');
  const source = normalize(value);
  if (!source) return null;
  if (UNMAPPED_SOURCES.has(source)) return null;
  if (SOURCE_TO_CHANNEL.has(source)) return null;
  return value;
}
