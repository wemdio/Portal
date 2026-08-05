/** @jest-environment node */

/**
 * Контент-сторож миграции profiles.market (ENG-разделение по хосту).
 *
 * Миграция добавляет profiles.market ('ru'|'eng', default 'ru') и пересоздаёт
 * handle_new_user — последнюю (hardened) версию из 20260730_0001, поэтому
 * тест пинит не только market, но и сохранение защитных свойств:
 * захардкоженная роль 'client', узкий search_path, revoke'ы на функцию.
 */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260804_0004_profiles_market.sql',
);

const sql = fs.existsSync(migrationPath)
  ? fs.readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').toLowerCase()
  : '';

describe('profiles market migration', () => {
  it('добавляет profiles.market с default ru и check-констрейнтом ru|eng', () => {
    expect(sql).toContain(
      'alter table public.profiles add column if not exists market text not null default \'ru\'',
    );
    expect(sql).toContain('profiles_market_check');
    expect(sql).toContain("check (market in ('ru','eng'))");
  });

  it('handle_new_user копирует market из raw_user_meta_data с fallback на ru', () => {
    expect(sql).toContain('create or replace function public.handle_new_user()');
    expect(sql).toContain("nullif(new.raw_user_meta_data->>'market', '')");
    // Невалидный/пустой market не должен валить insert на check-констрейнте.
    expect(sql).toContain("v_market not in ('ru','eng')");
  });

  it('сохраняет hardening 20260730_0001: роль всегда client, узкий search_path, revoke', () => {
    expect(sql).not.toContain("new.raw_user_meta_data->>'role'");
    expect(sql).toContain('set search_path = pg_catalog, public');
    expect(sql).toContain('revoke all on function public.handle_new_user() from public');
    expect(sql).toContain('revoke all on function public.handle_new_user() from anon');
    expect(sql).toContain('revoke all on function public.handle_new_user() from authenticated');
  });

  it('on conflict не сбрасывает market (как и role) — ручные правки админа живут', () => {
    const fn = sql.match(
      /create or replace function public\.handle_new_user\(\).*?\$\$;/,
    )?.[0] ?? '';
    const conflict = fn.match(/on conflict \(id\) do update(.*?);/)?.[1] ?? '';
    expect(conflict).not.toContain('market');
    expect(conflict).not.toContain('role');
  });
});
