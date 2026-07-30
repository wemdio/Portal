import fs from 'fs';
import path from 'path';

const SQL = fs.readFileSync(
  path.resolve(
    __dirname,
    '../../../supabase/migrations/20260730_0001_first_sales_dashboard.sql',
  ),
  'utf8',
);

describe('миграция дашборда первички', () => {
  it('создаёт справочник источников', () => {
    expect(SQL).toMatch(/create table if not exists public\.lead_source_channels/);
    expect(SQL).toMatch(/unique/i);
  });

  it('ограничивает канал списком значений', () => {
    for (const channel of [
      'marketing', 'smm', 'outreach', 'partners',
      'tg_outreach', 'inbound', 'referral', 'events', 'unassigned',
    ]) {
      expect(SQL).toContain(`'${channel}'`);
    }
  });

  it('создаёт view дат этапов', () => {
    expect(SQL).toMatch(/create or replace view public\.amo_lead_stage_dates_v/);
  });

  it('выдаёт гранты service_role на новую таблицу', () => {
    expect(SQL).toMatch(/grant all on public\.lead_source_channels\s+to service_role/);
  });

  it('включает RLS без select-политики для authenticated', () => {
    expect(SQL).toMatch(
      /alter table public\.lead_source_channels\s+enable row level security/,
    );
    expect(SQL).not.toMatch(/create policy .* on public\.lead_source_channels for select/);
  });

  it('индексирует amo_events под запросы view', () => {
    expect(SQL).toMatch(/create index if not exists .* on public\.amo_events/);
  });

  it('ограничивает пороги этапов сверху', () => {
    // Статус 143 «Закрыто и не реализовано» имеет sort 11000 и проходит ЛЮБОЙ
    // порог вида `sort >= N`. Без верхней границы мёртвая сделка получает дату
    // встречи и договора равной дате закрытия, и воронка раздувается на весь
    // поток отвалившихся лидов. На этом уже наступали в отчёте продаж —
    // коммит 60ac8a1e. Сторож стоит, чтобы границу не сняли как «лишнюю».
    // Вырезаем комментарии и строковые литералы: слово sort встречается и в
    // пояснениях, и в тексте comment on view — считать их наравне с логикой
    // значит ловить собственный хвост.
    const code = SQL.replace(/--[^\n]*/g, '').replace(/'(?:[^']|'')*'/g, "''");

    for (const threshold of [40, 70, 100, 110]) {
      const all = code.match(new RegExp(String.raw`sort\s*>=\s*${threshold}\b`, 'g')) ?? [];
      const bounded =
        code.match(
          new RegExp(String.raw`sort\s*>=\s*${threshold}\s+and\s+\S*sort\s*<\s*10000`, 'g'),
        ) ?? [];
      expect(all.length).toBeGreaterThan(0);
      expect(bounded).toHaveLength(all.length);
    }
  });
});
