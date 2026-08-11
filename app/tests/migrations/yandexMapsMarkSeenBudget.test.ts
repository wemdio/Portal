/**
 * @jest-environment node
 *
 * Уборка после обхода не верит слову «выдача была исчерпывающей».
 *
 * Обход считает выдачу полной, когда Яндекс вернул меньше, чем у него просили.
 * Но «меньше» бывает и когда поиск оборвался: на бою 11.08.2026 «Москва ×
 * Бизнес» вернула 20 ссылок при 65 321 организации в каталоге, «Воронежская
 * область × Услуги» — ноль при 3 343. Без потолка все они получили бы
 * missing_streak + 1, а на втором таком обходе — отметку «кажется, закрылась».
 * Заодно потолок ограничивает саму работу: переписывать десятки тысяч широких
 * строк в 19-гигабайтной таблице — это и есть те 60 секунд, на которых шлюз
 * рвал вызов.
 */

import fs from 'fs';
import path from 'path';

const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260811_0002_yandex_maps_catalog_mark_seen_budget.sql',
);

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n\r]*/g, '');
}

describe('потолок пометки пропавших организаций', () => {
  const exists = fs.existsSync(MIGRATION_PATH);
  const sql = exists ? stripSqlComments(fs.readFileSync(MIGRATION_PATH, 'utf8')) : '';

  it('миграция есть', () => {
    expect(exists).toBe(true);
  });

  it('функция принимает потолок и старая пятиаргументная версия снята', () => {
    // Иначе на бою останутся две функции под одним именем, и вызов без потолка
    // по-прежнему разрешался бы в старую — с прежним поведением.
    expect(sql).toMatch(/drop\s+function\s+if\s+exists\s+public\.yandex_maps_catalog_mark_seen\s*\(\s*text\[\]\s*,\s*text\s*,\s*text\s*,\s*text\s*,\s*boolean\s*\)/i);
    expect(sql).toMatch(/create\s+or\s+replace\s+function\s+public\.yandex_maps_catalog_mark_seen[\s\S]*?p_max_missing\s+integer/i);
  });

  it('кандидаты набираются не больше, чем потолок плюс один', () => {
    // Плюс один — чтобы отличить «уложились» от «их больше»: считать всех по
    // паре вроде «вся Москва» дороже, чем сама пометка.
    expect(sql).toMatch(/limit[\s\S]{0,80}p_max_missing\s*\+\s*1/i);
  });

  it('переполнение потолка не переписывает ни одной строки', () => {
    expect(sql).toMatch(/cardinality\(\s*missing_ids\s*\)\s*>\s*p_max_missing\s+then[\s\S]{0,200}?return\s+0\s*;/i);
  });

  it('пометка идёт по собранным идентификаторам, а не повторным перебором каталога', () => {
    expect(sql).toMatch(/update\s+public\.yandex_maps_company_catalog[\s\S]*?where\s+c\.yandex_id\s*=\s*any\(\s*missing_ids\s*\)/i);
  });

  it('ограничение из 20260810_0003 никуда не делось', () => {
    // Организации с двумя промахами подряд уже помечены — переписывать их на
    // каждом следующем обходе незачем.
    expect(sql).toMatch(/c\.missing_streak\s*<\s*2/i);
  });
});
