/** @jest-environment node */

/**
 * Поля профиля нужны, чтобы список показывал реальное состояние аккаунта в
 * Telegram, а не то, что мы туда отправили. Сейчас в tg_outreach_accounts нет
 * ни имени, ни описания.
 */

import fs from 'node:fs';
import path from 'node:path';

const SQL = fs.readFileSync(
  path.resolve(process.cwd(), '../supabase/migrations/20260806_0002_tg_outreach_account_profile.sql'),
  'utf8',
);

describe('миграция полей профиля аккаунта', () => {
  it.each(['first_name', 'last_name', 'bio', 'avatar_url', 'profile_synced_at'])(
    'добавляет колонку %s',
    (column) => {
      expect(SQL).toMatch(
        new RegExp(`alter table public\\.tg_outreach_accounts[\\s\\S]{0,80}add column if not exists ${column}\\b`, 'i'),
      );
    },
  );

  it('колонки добавляются мягко — таблица уже в проде', () => {
    expect(SQL).toMatch(/add column if not exists/i);
    expect(SQL).not.toMatch(/drop column/i);
  });
});
