import fs from 'fs';
import path from 'path';

const SQL = fs.readFileSync(
  path.resolve(
    __dirname,
    '../../../supabase/migrations/20260813_0001_drop_lead_source_channels.sql',
  ),
  'utf8',
);

describe('миграция удаления справочника источников', () => {
  it('удаляет таблицу идемпотентно', () => {
    expect(SQL).toMatch(/drop table if exists public\.lead_source_channels/);
  });
});
