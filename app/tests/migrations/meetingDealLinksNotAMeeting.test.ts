import fs from 'fs';
import path from 'path';

const SQL = fs.readFileSync(
  path.resolve(
    __dirname,
    '../../../supabase/migrations/20260731_0002_meeting_deal_links_not_a_meeting.sql',
  ),
  'utf8',
);

describe('миграция — отметка «не встреча» на записях чата встреч', () => {
  it('amo_deal_id становится nullable', () => {
    expect(SQL).toMatch(
      /alter table public\.meeting_deal_links\s+alter column amo_deal_id drop not null/i,
    );
  });

  it('method допускает not_a_meeting в списке допустимых значений', () => {
    expect(SQL).toMatch(/check\s*\(method in \([^)]*'not_a_meeting'[^)]*\)\)/);
  });

  it('инвариант: amo_deal_id пуст тогда и только тогда, когда method=not_a_meeting', () => {
    // Без этого констрейнта возможна и «привязка в никуда» (amo_deal_id
    // null при обычной привязке), и «не встреча» с висящим amo_deal_id.
    expect(SQL).toMatch(
      /check\s*\(\(amo_deal_id is null\)\s*=\s*\(method\s*=\s*'not_a_meeting'\)\)/,
    );
  });

  it('автоматчер переопределён и не перезаписывает ручную разметку (manual и not_a_meeting)', () => {
    // Старое условие `method <> 'manual'` из 20260731_0001 пропускало
    // not_a_meeting на перезапись, потому что 'not_a_meeting' <> 'manual'
    // истинно. Эта миграция обязана переопределить функцию с более широким
    // условием, иначе отметка «не встреча» слетит при следующем прогоне синка.
    expect(SQL).toMatch(/create or replace function public\.apply_meeting_deal_links/);
    expect(SQL).toMatch(
      /where[\s\S]{0,160}method\s+not in\s*\(\s*'manual'\s*,\s*'not_a_meeting'\s*\)/i,
    );
  });

  it('не оставляет старое разрешающее условие method <> \'manual\' без not_a_meeting', () => {
    // Регресс-страховка: если кто-то скопипастит старое тело функции без
    // расширения условия, этот тест должен упасть.
    const updateClauses = SQL.match(/on conflict[\s\S]*?where[^;]*;/gi) ?? [];
    expect(updateClauses.length).toBeGreaterThan(0);
    for (const clause of updateClauses) {
      expect(clause).not.toMatch(/method\s*<>\s*'manual'\s*;/i);
    }
  });
});
