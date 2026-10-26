/**
 * Метка строки 2ГИС без зависимостей: её берут и общий модуль строк (его же
 * собирает сборщик Ш5), и карантин VE2. Контракт метки — в twoGisQuarantine.ts.
 */
export const VE_TWO_GIS_SOURCE_DETAIL = 'справочник организаций';
export const VE_TWO_GIS_ROW_FIELD = '_ve_two_gis';

/** Нормализация дописывает строки («\nСайт в источнике: …»), дедуп склеивает ячейку построчно
 * (mergeVeSourceFactText: «яндекс.карты\nсправочник организаций»): метка — любая строка. */
export const isVeTwoGisSourceDetail = (value: unknown) => typeof value === 'string'
  && value.split('\n').some((line) => line.trim() === VE_TWO_GIS_SOURCE_DETAIL);
