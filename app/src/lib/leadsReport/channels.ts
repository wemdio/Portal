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
 * Возвращает ровно один канал для сделки.
 *
 * В живой AMO партнёрский источник называется «Партнер», а SMM размечен
 * преимущественно через utm_medium=smm. Алиасы оставлены, чтобы отчёт не
 * сломался при переименовании значений в AMO.
 */
export function detectSummaryChannel(raw: unknown): SummaryChannelName {
  const source = normalize(extractCustomField(raw, 'Источник'));
  const utmMedium = normalize(extractCustomField(raw, 'utm_medium'));

  if (source === 'telegram outreach') return 'tg_outreach';
  if (['партнер', 'партнерка'].includes(source)) return 'partners';
  if (['email outreach', 'аутрич'].includes(source)) return 'outreach';
  if (['smm', 'смм'].includes(source) || utmMedium === 'smm') return 'smm';
  return 'marketing';
}
