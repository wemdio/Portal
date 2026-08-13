/**
 * Этапы считаются только по исходной воронке сделки.
 *
 * История: правка 20260807_0002 сняла привязку порядка этапа к воронке сделки,
 * чтобы у переехавшей сделки не обнулялись даты. Побочный эффект — этапы чужих
 * воронок начали проходить пороги первички по одному лишь номеру: «Отвал / не
 * продлен» из воронки продлений стоит под номером 120 и засчитывался договором
 * (сделка 33181669, 10.08.2026).
 *
 * Сторож проверяет ровно то, что легко потерять при следующей правке view:
 * соединение со справочником этапов обязано ограничивать воронку, а исключение
 * для «Успешно реализовано» — оставаться исключением.
 */
import fs from 'fs';
import path from 'path';

const SQL = fs.readFileSync(
  path.resolve(
    __dirname,
    '../../../supabase/migrations/20260813_0004_first_sales_stage_events_own_pipeline.sql',
  ),
  'utf8',
);

/** SQL без комментариев: слова из пояснений не должны считаться логикой. */
const CODE = SQL.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");

describe('миграция «этапы по своей воронке»', () => {
  it('пересоздаёт view дат этапов', () => {
    expect(CODE).toMatch(/create or replace view public\.amo_lead_stage_dates_v as/);
  });

  it('ограничивает справочник этапов исходной воронкой сделки', () => {
    // Именно это условие и чинит баг: без него номер этапа чужой воронки
    // сравнивается с порогами первички.
    expect(CODE).toMatch(
      /join public\.amo_status_pipeline_v sp\s+on sp\.status_id = ev\.to_status\s+and sp\.pipeline_id = o\.pipeline_id/,
    );
  });

  it('берёт воронку из origin, а не из текущей воронки сделки', () => {
    expect(CODE).toMatch(/left join origin o on o\.amo_deal_id = ev\.amo_deal_id/);
    // `l.pipeline_id` в reached означал бы возврат к бажной версии 20260730.
    const reached = CODE.slice(CODE.indexOf('reached as ('), CODE.indexOf('select\n  l.amo_id'));
    expect(reached).not.toMatch(/sp\.pipeline_id = l\.pipeline_id/);
  });

  it('оставляет пороги этапов с верхней границей', () => {
    // Та же защита, что и в 20260730_0001: 142/143 арифметически проходят
    // любой `>= N`, и без границы мёртвая сделка получала бы дату договора.
    for (const threshold of [40, 70, 100, 110]) {
      const bounded = CODE.match(
        new RegExp(String.raw`sort\s*>=\s*${threshold}\s+and\s+\S*sort\s*<\s*10000`, 'g'),
      ) ?? [];
      expect(bounded.length).toBeGreaterThan(0);
    }
  });

  it('не ограничивает воронкой поиск «Успешно реализовано»', () => {
    // 142 есть в каждой воронке и ни одной не принадлежит: в
    // amo_status_pipeline_v его нет вовсе, и фильтр по воронке обнулил бы
    // запасной источник won_at для переехавших сделок.
    expect(CODE).toMatch(/filter \(where ev\.to_status = 142\)/);
  });

  it('сохраняет security_invoker у view', () => {
    expect(CODE).toMatch(/alter view public\.amo_lead_stage_dates_v set \(security_invoker = on\)/);
  });
});
