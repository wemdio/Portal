import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  isGoogleWorkspaceConfigured,
  listWorkspaceMailboxes,
  workspaceAccounts,
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
 *
 * Workspace может быть несколько: каталог каждого читается от имени его
 * админа, и у ящика запоминается, из какого аккаунта он пришёл
 * (`google_account`). «Пропал» ставится только по ящикам того аккаунта, чей
 * каталог прочитался: если Google отказал одному Workspace, его ящики не
 * должны разом стать пропавшими.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

export interface GoogleSyncResult {
  added: number;
  updated: number;
  suspended: number;
  missing: number;
  total: number;
  /** Аккаунты, чей каталог Google не отдал, — с текстом отказа. */
  failed: { account: string; error: string }[];
}

const empty = (): GoogleSyncResult => ({
  added: 0, updated: 0, suspended: 0, missing: 0, total: 0, failed: [],
});

function stateOf(user: WorkspaceUser): 'active' | 'suspended' {
  return user.suspended || user.archived ? 'suspended' : 'active';
}

export async function syncGoogleWorkspaceMailboxes(opts?: { log?: Log }): Promise<GoogleSyncResult> {
  const log: Log = opts?.log ?? (() => {});
  if (!supabaseAdmin || !isGoogleWorkspaceConfigured()) return empty();
  const db = supabaseAdmin;

  const accounts = workspaceAccounts();
  const result = empty();
  // Кто из какого аккаунта: читаем все каталоги до записи, чтобы решать про
  // «Пропал» по полной картине, а не по первому прочитанному аккаунту.
  const listed = new Map<string, { user: WorkspaceUser; account: string }>();
  const readAccounts = new Set<string>();

  for (const account of accounts) {
    try {
      const users = await listWorkspaceMailboxes(account);
      readAccounts.add(account);
      for (const user of users) {
        if (!listed.has(user.email)) listed.set(user.email, { user, account });
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log('warn', `Каталог Google ${account} не прочитался: ${error}`);
      result.failed.push({ account, error });
    }
  }

  // Ни один каталог не прочитался — это ошибка подключения, а не пустой домен.
  if (!readAccounts.size) {
    throw new Error(result.failed.map((f) => `${f.account}: ${f.error}`).join('; '));
  }

  const nowIso = new Date().toISOString();

  const { data: existingRows } = await db
    .from('sender_mailboxes')
    .select('id, email, auth_type, enabled, status, google_state, google_account')
    .eq('auth_type', 'google_sa');

  const existing = new Map(
    (existingRows ?? []).map((row) => [String(row.email).toLowerCase(), row]),
  );

  result.total = listed.size;

  for (const { user, account } of listed.values()) {
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
        google_account: account,
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
      google_account: account,
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

  // Пропавшие из каталога: не удаляем, а помечаем и снимаем с рассылки. Только
  // по аккаунтам, чей каталог прочитался; ящик без отметки аккаунта (заведён
  // до того, как её стали хранить) судим, лишь когда прочитались все.
  const allRead = readAccounts.size === accounts.length;
  for (const [email, row] of existing) {
    if (listed.has(email) || row.google_state === 'missing') continue;
    const owner = row.google_account ? String(row.google_account).toLowerCase() : null;
    if (owner ? !readAccounts.has(owner) && accounts.includes(owner) : !allRead) continue;
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
    `Каталог Google (${[...readAccounts].join(', ')}): всего ${result.total}, новых ${result.added}, `
    + `обновлено ${result.updated}, заблокировано ${result.suspended}, пропало ${result.missing}`,
  );
  return result;
}
