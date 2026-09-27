/** @jest-environment node */

/**
 * Строки шага «Почт на компанию» и новое описание «Найти Email» должны
 * переводиться на en/es.
 *
 * /client/base-constructor рендерит BaseConstructorView под
 * GlobalTextTranslator, а он переводит узел только по ТОЧНОМУ совпадению с
 * каталогом (getClientTranslation) и неизвестный текст оставляет на русском.
 * Старое описание «Ищет все email по сайту компании» было в каталоге — без
 * этих строк английский клиент увидел бы карточку по-русски. Тест также
 * сверяет, что строки дословно есть в компоненте: правка текста без
 * обновления каталога его уронит.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClientTranslation } from '@/lib/clientI18n';

const STRINGS = [
  'Ищет email на сайте компании до первой страницы с почтой. Больше адресов — шаг «Почт на компанию»',
  'Почт на компанию',
  'Оставляет до N почт на компанию, сначала подтверждённые. При N больше 1 «Найти Email» проходит несколько страниц сайта — дольше',
  'Сколько адресов оставить у одной компании. Сначала остаются подтверждённые валидацией, затем catch-all.',
  'Поиск почт пройдёт по нескольким страницам сайта, а не остановится на главной: адресов больше, поиск примерно на треть дольше.',
  'Без шага «Валидация Email» остаются первые адреса по порядку.',
];

const viewSource = readFileSync(
  join(__dirname, '..', '..', 'src', 'components', 'base-constructor', 'BaseConstructorView.tsx'),
  'utf8',
).replace(/\s+/g, ' ');

describe('каталог переводов — шаг «Почт на компанию»', () => {
  it.each(STRINGS)('en и es есть для «%s»', (source) => {
    expect(getClientTranslation(source, 'en')).toEqual(expect.any(String));
    expect(getClientTranslation(source, 'es')).toEqual(expect.any(String));
  });

  it.each(STRINGS)('строка дословно есть в BaseConstructorView: «%s»', (source) => {
    expect(viewSource).toContain(source);
  });
});
