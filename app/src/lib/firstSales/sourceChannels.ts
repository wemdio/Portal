/**
 * Свёртка значения поля «Источник» AMO в канал продаж.
 *
 * Отличие от `leadsReport/channels.ts`: там пять каналов зашиты в код и
 * покрывают 38% потока — остальное отбрасывается как `null`. Здесь свёртка
 * берётся из редактируемой таблицы `lead_source_channels`, а всё неизвестное
 * становится явным `unassigned` и видно на дашборде, а не исчезает.
 */
import { extractCustomField } from '@/lib/leadsReport/extractCustomField';

/**
 * Единственный список каналов в TypeScript-коде. Тип выводится из него, а не
 * объявляется рядом — иначе добавленный канал пришлось бы вписывать дважды, и
 * рано или поздно кто-то вписал бы один раз. Тот же приём, что у
 * `ALL_NAV_TAB_IDS` в `toolsRegistry.ts`.
 *
 * Второй источник истины неизбежен и лежит в SQL: CHECK-констрейнт
 * `lead_source_channels.channel` в миграции 20260730_0001. Из TypeScript его
 * не достать, так что при добавлении канала правятся ровно два места — этот
 * массив и миграция.
 */
export const FIRST_SALES_CHANNELS = [
  'marketing',
  'smm',
  'outreach',
  'partners',
  'tg_outreach',
  'inbound',
  'referral',
  'events',
  'unassigned',
] as const;

export type FirstSalesChannel = (typeof FIRST_SALES_CHANNELS)[number];

export const CHANNEL_LABELS: Record<FirstSalesChannel, string> = {
  marketing: 'Маркетинг',
  smm: 'SMM',
  outreach: 'Аутрич',
  partners: 'Партнёрка',
  tg_outreach: 'TG Outreach',
  inbound: 'Входящие',
  referral: 'Сарафан',
  events: 'Мероприятия',
  unassigned: 'Не распределено',
};

export type SourceChannelRow = {
  source: string;
  channel: FirstSalesChannel;
  display_name: string | null;
};

export type ResolvedChannel = {
  /** Нормализованное значение «Источник»; пустая строка, если поле не заполнено. */
  source: string;
  channel: FirstSalesChannel;
  /** Есть ли источник в справочнике. false → строка «новый источник» на дашборде. */
  known: boolean;
};

/** trim + lower + ё→е. Той же нормализацией хранится `source` в справочнике. */
export function normalizeSource(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
}

export function buildSourceIndex(
  rows: SourceChannelRow[],
): Map<string, SourceChannelRow> {
  return new Map(rows.map((r) => [normalizeSource(r.source), r]));
}

/**
 * Единственное правило поверх справочника: явная ручная метка команды
 * «Контур = Маркетинг» выигрывает у пустого или незнакомого источника, но
 * уступает источнику, который в справочнике есть. Метку ставят руками именно
 * для тех сделок, у которых источник не заполнен.
 */
export function resolveChannel(
  raw: unknown,
  rows: SourceChannelRow[] | Map<string, SourceChannelRow>,
): ResolvedChannel {
  const index = rows instanceof Map ? rows : buildSourceIndex(rows);

  const source = normalizeSource(extractCustomField(raw, 'Источник'));
  const hit = source ? index.get(source) : undefined;
  if (hit) return { source, channel: hit.channel, known: true };

  const kontur = normalizeSource(extractCustomField(raw, 'Контур'));
  if (kontur === 'маркетинг') return { source, channel: 'marketing', known: false };

  return { source, channel: 'unassigned', known: false };
}
