import type { Utm } from '@/lib/leadsReport/extractUtm';

/** Классифицирует UTM в платформу для колонки D таблицы маркетинга. */
export function mapPlatform(utm: Utm): string {
  const source = (utm.source ?? '').toLowerCase();
  const medium = (utm.medium ?? '').toLowerCase();
  const campaign = (utm.campaign ?? '').toLowerCase();

  if (source === 'yandex' && medium === 'cpc') return 'Я.Директ';
  if (source === 'polzaagency' || source === 'hh') return 'HH';
  if (source === 'inst') return 'Инстаграм';
  if (source === 'vs' || campaign.includes('vs')) return 'VS';
  if (!source || source === 'organic') return 'Органика';
  return `Другое (${source})`;
}

/** Классифицирует площадку в категорию для колонки «источник для…». */
export function mapCategory(platform: string): string {
  if (['Я.Директ', 'Инстаграм', 'VK', 'VS'].includes(platform)) {
    return 'Лиды Директ';
  }
  if (platform === 'HH') return 'Лиды копирайт';
  if (platform === 'Органика') return 'Заявки органика';
  return 'Заявки органика';
}
