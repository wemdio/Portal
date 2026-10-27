/**
 * Метка строки 2ГИС без зависимостей: её берут и общий модуль строк (его же
 * собирает сборщик Ш5), и карантин VE2. Контракт метки — в twoGisQuarantine.ts.
 * Шлюз соответствия (relevanceGate) берёт отсюда же предикат строки-получателя,
 * тексты отказов и вердикт по ИНН владельца сайта (часть 3в): карантин он не
 * импортирует — тот тянет adaptiveCollection и node:crypto.
 */
export const VE_TWO_GIS_SOURCE_DETAIL = 'справочник организаций';
export const VE_TWO_GIS_ROW_FIELD = '_ve_two_gis';

/** Нормализация дописывает строки («\nСайт в источнике: …»), дедуп склеивает ячейку построчно
 * (mergeVeSourceFactText: «яндекс.карты\nсправочник организаций»): метка — любая строка. */
export const isVeTwoGisSourceDetail = (value: unknown) => typeof value === 'string'
  && value.split('\n').some((line) => line.trim() === VE_TWO_GIS_SOURCE_DETAIL);

/** Строка-получатель 2ГИС: метка или строка «справочник организаций» (то же, что isVeTwoGisRow без ключей близнецов). */
export const isVeTwoGisMarkedRow = (row: unknown): boolean => !!row && typeof row === 'object'
  && ((row as Record<string, unknown>)[VE_TWO_GIS_ROW_FIELD] != null || isVeTwoGisSourceDetail((row as Record<string, unknown>).source_detail));
// Тексты для интерфейса (≤ 400 символов, схема решения), не письма.
export const VE_TWO_GIS_SITE_FIRST_REASON = 'Компания из справочника организаций: сначала проверяем её сайт.';
export const VE_TWO_GIS_SITE_UNCONFIRMED_REASON = 'Сайт из справочника организаций не подтвердил компанию: на нём нет её названия и города, или он не открылся. Компания отсеяна.';
export const VE_TWO_GIS_IP_SITE_REASON = 'Сайт принадлежит ИП, а план базы ИП не берёт. Компания отсеяна.';
export const VE_TWO_GIS_OWNER_INN_EXCLUDED_REASON = 'ИНН владельца сайта уже есть в исключениях проекта или в другой базе. Компания отсеяна.';
export type VeTwoGisOwnerInnVerdict = { kind: 'none' } | { kind: 'ip_rejected' | 'ip_allowed' | 'company'; inn: string };
/** Только единственный владелец: 12 цифр — ИП (по разрешению плана), 10 — компания; иначе вердикта нет. */
export function veTwoGisOwnerInnVerdict(ownerInns: readonly string[] | undefined, ipAllowed: boolean): VeTwoGisOwnerInnVerdict {
  const owners = [...new Set(ownerInns ?? [])];
  if (owners.length !== 1) return { kind: 'none' };
  const [inn] = owners;
  if (/^\d{12}$/.test(inn)) return { kind: ipAllowed ? 'ip_allowed' : 'ip_rejected', inn };
  return /^\d{10}$/.test(inn) ? { kind: 'company', inn } : { kind: 'none' };
}
