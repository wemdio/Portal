/** @jest-environment node */

/**
 * 20260924_0011 меняет только разбор «Дедлайна» карточки в ve_try_iso_date.
 * Поведение на PostgreSQL проверяет PGlite-смоук из
 * veContactDeliveryWithoutPeriod.test.ts по случаям tests/helpers/projectDeadlineCases.json.
 */

import fs from 'fs';
import path from 'path';

const sql = fs.readFileSync(
  path.resolve(__dirname, '../../../supabase/migrations/20260924_0011_ve_project_deadline_card_formats.sql'),
  'utf8',
);

describe('migration 20260924_0011: project card deadline formats', () => {
  it('replaces only ve_try_iso_date and keeps its signature', () => {
    expect([...sql.matchAll(/create or replace function (public\.\w+\([^)]*\))/g)].map((match) => match[1]))
      .toEqual(['public.ve_try_iso_date(p_value text)']);
    expect(sql).toMatch(/returns date\s+language plpgsql\s+stable\s+set search_path = ''/);
  });

  it('keeps the helper internal like 20260924_0010 does', () => {
    expect(sql.replace(/\s+/g, ' ')).toContain(
      'revoke all on function public.ve_try_iso_date(text) from public, anon, authenticated, service_role;',
    );
    expect(sql).toContain('grant execute on function public.ve_try_iso_date(text) to postgres;');
  });
});
