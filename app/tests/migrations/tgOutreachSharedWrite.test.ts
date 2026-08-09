/** @jest-environment node */

/**
 * Регрессия на «чужую кампанию нельзя редактировать».
 *
 * 20260320_0003 открыла чтение всем сотрудникам, но запись осознанно оставила
 * владельцу кампании. На практике инструмент командный: аккаунты заливает один
 * специалист, чистит другой. Хуже того, отказ был молчаливым — DELETE под RLS
 * не находит строк, PostgREST возвращает 204 без ошибки, и UI рапортовал успех
 * при нетронутой строке.
 *
 * Тот же вывод уже зафиксирован в 20260804_0004 для прогрева: «прогрев —
 * командная операция, специалист должен уметь греть аккаунты кампании
 * независимо от того, кто её завёл». Здесь это распространяется на остальные
 * таблицы кампании.
 *
 * Воркер ходит под service_role и RLS не подчиняется — политики authenticated
 * на него не влияют.
 */

import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(process.cwd(), '../supabase/migrations');

function allMigrationsSql(): string {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((n) => n.endsWith('.sql'))
    .sort()
    .map((n) => fs.readFileSync(path.join(MIGRATIONS_DIR, n), 'utf8'))
    .join('\n');
}

/** Политики владельца, которые обязаны быть сняты — иначе они продолжат резать. */
const OWNER_POLICIES_TO_DROP = [
  ['tg_outreach_campaigns', 'tg_outreach_campaigns_update_own'],
  ['tg_outreach_campaigns', 'tg_outreach_campaigns_delete_own'],
  ['tg_outreach_accounts', 'tg_outreach_accounts_insert_own'],
  ['tg_outreach_accounts', 'tg_outreach_accounts_update_own'],
  ['tg_outreach_accounts', 'tg_outreach_accounts_delete_own'],
  ['tg_outreach_proxies', 'tg_outreach_proxies_insert_own'],
  ['tg_outreach_proxies', 'tg_outreach_proxies_update_own'],
  ['tg_outreach_proxies', 'tg_outreach_proxies_delete_own'],
  ['tg_outreach_dialogs', 'tg_outreach_dialogs_insert_own'],
  ['tg_outreach_dialogs', 'tg_outreach_dialogs_update_own'],
  ['tg_outreach_dialogs', 'tg_outreach_dialogs_delete_own'],
  ['tg_outreach_processed', 'tg_outreach_processed_insert_own'],
  ['tg_outreach_processed', 'tg_outreach_processed_delete_own'],
  ['tg_outreach_proxy_swaps', 'tg_outreach_proxy_swaps_insert_own'],
] as const;

/** Команды, которые должны стать доступны любому сотруднику. */
const SHARED_WRITES = [
  ['tg_outreach_campaigns', 'update'],
  ['tg_outreach_campaigns', 'delete'],
  ['tg_outreach_accounts', 'insert'],
  ['tg_outreach_accounts', 'update'],
  ['tg_outreach_accounts', 'delete'],
  ['tg_outreach_proxies', 'insert'],
  ['tg_outreach_proxies', 'update'],
  ['tg_outreach_proxies', 'delete'],
  ['tg_outreach_dialogs', 'insert'],
  ['tg_outreach_dialogs', 'update'],
  ['tg_outreach_dialogs', 'delete'],
  ['tg_outreach_processed', 'insert'],
  ['tg_outreach_processed', 'delete'],
  ['tg_outreach_proxy_swaps', 'insert'],
] as const;

describe('tg_outreach: запись в кампанию доступна любому сотруднику', () => {
  const sql = allMigrationsSql();

  it.each(OWNER_POLICIES_TO_DROP)('%s: снята политика %s', (table, policy) => {
    expect(sql).toMatch(
      new RegExp(`drop policy if exists ${policy} on public\\.${table}\\s*;`, 'i'),
    );
  });

  // Проверяем именно общую политику, а не любую: старые `_own` тоже объявлены
  // как `for insert to authenticated`, и проверка без предиката прошла бы на
  // них, ничего не доказав. Требуем соглашение об именах `_all` (его задали
  // 20260320_0003 и 20260804_0004) и предикат `true` в теле политики.
  it.each(SHARED_WRITES)('%s: есть общая политика на %s', (table, cmd) => {
    expect(sql).toMatch(
      new RegExp(
        `create policy\\s+\\S*_all\\s+on public\\.${table}\\s+for ${cmd} to authenticated[^;]*\\btrue\\b`,
        'i',
      ),
    );
  });

  it('создание кампании по-прежнему штампует автора', () => {
    // Единственная политика, которую снимать нельзя: она проставляет владельца
    // при создании. Без неё в user_id можно записать кого угодно, и колонка
    // перестанет отвечать на вопрос «кто завёл кампанию».
    expect(sql).not.toMatch(
      /drop policy if exists tg_outreach_campaigns_insert_own on public\.tg_outreach_campaigns\s*;/i,
    );
  });
});
