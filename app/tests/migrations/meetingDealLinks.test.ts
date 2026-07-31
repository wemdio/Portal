import fs from 'fs';
import path from 'path';

const SQL = fs.readFileSync(
  path.resolve(__dirname, '../../../supabase/migrations/20260731_0001_meeting_deal_links.sql'),
  'utf8',
);

describe('миграция привязки записей встреч к сделкам', () => {
  it('создаёт таблицу привязок', () => {
    expect(SQL).toMatch(/create table if not exists public\.meeting_deal_links/);
  });

  it('одна запись — одна сделка', () => {
    // Без этого одна запись матчится на несколько компаний с похожими
    // названиями, и встречи тихо задваиваются: за июль 72 записи давали
    // 78 пар (сделка, дата).
    expect(SQL).toMatch(/unique[\s\S]{0,80}transcript_id/);
  });

  it('ручную привязку автоматчер не перезаписывает', () => {
    expect(SQL).toMatch(/where[\s\S]{0,120}method\s*(<>|!=)\s*'manual'/i);
  });

  it('ограничивает способ привязки списком', () => {
    for (const m of ['domain', 'name', 'manual']) expect(SQL).toContain(`'${m}'`);
  });

  it('выдаёт гранты service_role', () => {
    expect(SQL).toMatch(/grant all on public\.meeting_deal_links\s+to service_role/);
  });

  it('включает RLS без select-политики для authenticated', () => {
    expect(SQL).toMatch(/alter table public\.meeting_deal_links\s+enable row level security/);
    expect(SQL).not.toMatch(/create policy .* on public\.meeting_deal_links for select/);
  });
});
