/** @jest-environment node */

/**
 * Права на новые таблицы. Урок 05.08.2026: у tg_outreach_warmup_runs выдали
 * authenticated только select, и кнопка «Начать прогрев» не работала ни разу с
 * момента выката. Здесь UI пишет во все три таблицы, поэтому проверяем гранты
 * и политики сразу.
 */

import fs from 'node:fs';
import path from 'node:path';

const SQL = fs.readFileSync(
  path.resolve(process.cwd(), '../supabase/migrations/20260806_0003_tg_outreach_bases.sql'),
  'utf8',
);

const TABLES = [
  'tg_outreach_bases',
  'tg_outreach_base_contacts',
  'tg_outreach_campaign_bases',
];

describe('миграция баз контактов', () => {
  it.each(TABLES)('создаёт таблицу %s', (table) => {
    expect(SQL).toMatch(new RegExp(`create table if not exists public\\.${table}\\b`, 'i'));
  });

  it.each(TABLES)('%s: RLS включён', (table) => {
    expect(SQL).toMatch(new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  });

  it.each(TABLES)('%s: service_role получает всё', (table) => {
    expect(SQL).toMatch(new RegExp(`grant all on public\\.${table} to service_role`, 'i'));
  });

  it.each(TABLES)('%s: authenticated может писать, а не только читать', (table) => {
    const grants = SQL.match(
      new RegExp(`grant\\s+([^;]*?)\\s+on\\s+public\\.${table}\\s+to\\s+authenticated\\s*;`, 'gi'),
    );
    expect(grants).not.toBeNull();
    const granted = (grants ?? []).join(' ').toLowerCase();
    for (const verb of ['select', 'insert', 'update', 'delete']) {
      expect(granted).toContain(verb);
    }
  });

  it.each(TABLES)('%s: есть политики на запись', (table) => {
    for (const action of ['insert', 'update', 'delete']) {
      expect(SQL).toMatch(
        new RegExp(`create policy\\s+\\S+\\s+on public\\.${table}\\s+for ${action} to authenticated`, 'i'),
      );
    }
  });

  it('контакт уникален в пределах базы — повторная загрузка не плодит дубли', () => {
    expect(SQL).toMatch(/unique\s*\(\s*base_id\s*,\s*username\s*\)/i);
  });

  it('база не может быть привязана к кампании дважды', () => {
    expect(SQL).toMatch(/unique\s*\(\s*campaign_id\s*,\s*base_id\s*\)/i);
  });
});
