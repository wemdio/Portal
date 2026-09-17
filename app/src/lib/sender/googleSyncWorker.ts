import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  isGoogleWorkspaceConfigured,
  listWorkspaceMailboxes,
  type WorkspaceUser,
} from './googleWorkspace';

/**
 * Ежечасное зеркало каталога Google Workspace.
 *
 * Портал не импортирует ящики разово, а держит список таким, какой он в Google:
 * завели ящик — он появился, заблокировали — видно, что заблокирован, убрали из
 * домена — видно, что пропал. Решение «берём в рассылку» при этом остаётся за
 * человеком: новые ящики приезжают выключенными, и синхронизация галочку не
 * трогает — иначе очередная партия доменов начала бы слать письма сама.
 *
 * Синхронизация ничего не удаляет. Пропавший из каталога ящик помечается
 * `missing` и выключается, но остаётся в списке: по нему есть переписка, и
 * молча стирать историю рассылки нельзя.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

export interface GoogleSyncResult {
  added: number;
  updated: number;
  suspended: number;
  missing: number;
  total: number;
}

const EMPTY: GoogleSyncResult = { added: 0, updated: 0, suspended: 0, missing: 0, total: 0 };

function stateOf(user: WorkspaceUser): 'active' | 'suspended' {
  return user.suspended || user.archived ? 'suspended' : 'active';
}

export async function syncGoogleWorkspaceMailboxes(opts?: { log?: Log }): Promise<GoogleSyncResult> {
  const log: Log = opts?.log ?? (() => {});
  if (!supabaseAdmin || !isGoogleWorkspaceConfigured()) return EMPTY;
  const db = supabaseAdmin;

  const users = await listWorkspaceMailboxes();
  if (!users.length) return EMPTY;

  const nowIso = new Date().toISOString();

  const { data: existingRows } = await db
    .from('sender_mailboxes')
    .select('id, email, auth_type, enabled, status, google_state')
    .eq('auth_type', 'google_sa');

  const existing = new Map(
    (existingRows ?? []).map((row) => [String(row.email).toLowerCase(), row]),
  );

  const result: GoogleSyncResult = { ...EMPTY, total: users.length };
  const seen = new Set<string>();

  for (const user of users) {
    seen.add(user.email);
    const state = stateOf(user);
    if (state === 'suspended') result.suspended += 1;

    const known = existing.get(user.email);
    if (!known) {
      // Новый ящик домена: заводим выключенным. Проверка входа и тем более
      // отправка начнутся только после того, как его отметят галочкой.
      const { error } = await db.from('sender_mailboxes').insert({
        provider: 'google',
        auth_type: 'google_sa',
        email: user.email,
        display_name: user.fullName,
        username: user.email,
        smtp_host: 'smtp.gmail.com',
        smtp_port: 465,
        smtp_tls_mode: 'implicit_tls',
        imap_host: 'imap.gmail.com',
        imap_port: 993,
        secret_encrypted: null,
        enabled: false,
        status: 'pending',
        google_state: state,
        directory_synced_at: nowIso,
      });
      if (error) {
        log('warn', `Ящик ${user.email} не добавился: ${error.message}`);
        continue;
      }
      result.added += 1;
      continue;
    }

    const patch: Record<string, unknown> = {
      display_name: user.fullName,
      google_state: state,
      directory_synced_at: nowIso,
      updated_at: nowIso,
    };

    // Заблокированный в Google ящик снимаем с рассылки сам: письма с него всё
    // равно не уйдут, а «Готов» в списке вводил бы в заблуждение.
    if (state === 'suspended' && known.enabled) {
      patch.enabled = false;
      patch.last_error = 'Ящик заблокирован в Google Workspace';
    }
    // Разблокировали — возвращаем в очередь на проверку, но галочку не ставим:
    // решение «берём в работу» осталось за человеком.
    if (state === 'active' && known.google_state === 'suspended') {
      patch.status = 'pending';
      patch.last_error = null;
    }

    const { error } = await db.from('sender_mailboxes').update(patch).eq('id', known.id);
    if (error) {
      log('warn', `Ящик ${user.email} не обновился: ${error.message}`);
      continue;
    }
    result.updated += 1;
  }

  // Пропавшие из каталога: не удаляем, а помечаем и снимаем с рассылки.
  for (const [email, row] of existing) {
    if (seen.has(email) || row.google_state === 'missing') continue;
    await db
      .from('sender_mailboxes')
      .update({
        google_state: 'missing',
        enabled: false,
        last_error: 'Ящик пропал из каталога Google Workspace',
        directory_synced_at: nowIso,
        updated_at: nowIso,
      })
      .eq('id', row.id);
    result.missing += 1;
  }

  log(
    'info',
    `Каталог Google: всего ${result.total}, новых ${result.added}, обновлено ${result.updated}, `
    + `заблокировано ${result.suspended}, пропало ${result.missing}`,
  );
  return result;
}
