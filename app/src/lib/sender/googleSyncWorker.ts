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

/** Итог прогона по одному аккаунту — для экрана, см. sender_google_sync_accounts. */
interface AccountOutcome {
  mailboxes: number | null;
  added: number;
  /** Каталог не прочитался или не записались ящики — текст для экрана. */
  errors: string[];
}

/**
 * Записывает итог прогона по аккаунтам. Запись итога не должна ронять сам
 * синк: ящики уже обновлены, а строка на экране — лишь отчёт о прогоне.
 */
async function recordOutcomes(
  outcomes: Map<string, AccountOutcome>,
  source: 'auto' | 'manual',
  nowIso: string,
  log: Log,
): Promise<void> {
  if (!supabaseAdmin || !outcomes.size) return;
  // Успешный прогон last_error не трогает: прошлая ошибка остаётся видна с
  // датой, а экран по датам понимает, что она уже позади.
  const rows = [...outcomes].map(([account, o]): Record<string, unknown> & { account: string } => ({
    account,
    last_run_at: nowIso,
    last_source: source,
    ...(o.mailboxes === null ? {} : { mailboxes: o.mailboxes, added: o.added }),
    ...(o.errors.length
      ? { last_error: o.errors.join('; ').slice(0, 2000), last_error_at: nowIso }
      : { last_ok_at: nowIso }),
  }));
  // Строки с разным набором полей — отдельными запросами: в одном upsert
  // PostgREST дописал бы недостающие поля значением null.
  for (const row of rows) {
    const { error } = await supabaseAdmin
      .from('sender_google_sync_accounts')
      .upsert(row, { onConflict: 'account' });
    if (error) log('warn', `Итог синка ${row.account} не записался: ${error.message}`);
  }
}

const empty = (): GoogleSyncResult => ({
  added: 0, updated: 0, suspended: 0, missing: 0, total: 0, failed: [],
});

function stateOf(user: WorkspaceUser): 'active' | 'suspended' {
  return user.suspended || user.archived ? 'suspended' : 'active';
}

export async function syncGoogleWorkspaceMailboxes(
  opts?: { log?: Log; source?: 'auto' | 'manual' },
): Promise<GoogleSyncResult> {
  const log: Log = opts?.log ?? (() => {});
  const source = opts?.source ?? 'auto';
  if (!supabaseAdmin || !isGoogleWorkspaceConfigured()) return empty();
  const db = supabaseAdmin;

  const accounts = workspaceAccounts();
  const result = empty();
  // Кто из какого аккаунта: читаем все каталоги до записи, чтобы решать про
  // «Пропал» по полной картине, а не по первому прочитанному аккаунту.
  const listed = new Map<string, { user: WorkspaceUser; account: string }>();
  const readAccounts = new Set<string>();
  const outcomes = new Map<string, AccountOutcome>();
  const nowIso = new Date().toISOString();

  for (const account of accounts) {
    try {
      const users = await listWorkspaceMailboxes(account);
      readAccounts.add(account);
      outcomes.set(account, { mailboxes: users.length, added: 0, errors: [] });
      for (const user of users) {
        if (!listed.has(user.email)) listed.set(user.email, { user, account });
      }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      log('warn', `Каталог Google ${account} не прочитался: ${error}`);
      result.failed.push({ account, error });
      outcomes.set(account, { mailboxes: null, added: 0, errors: [`каталог не прочитался: ${error}`] });
    }
  }

  // Ни один каталог не прочитался — это ошибка подключения, а не пустой домен.
  if (!readAccounts.size) {
    await recordOutcomes(outcomes, source, nowIso, log);
    throw new Error(result.failed.map((f) => `${f.account}: ${f.error}`).join('; '));
  }

  // Не записавшиеся ящики — тоже ошибка прогона: на экране «всё хорошо» при
  // молча не добавленных ящиках вводило бы в заблуждение.
  const rowFailed = (account: string, email: string, message: string) => {
    const o = outcomes.get(account);
    if (o && o.errors.length < 3) o.errors.push(`${email}: ${message}`);
  };

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
        rowFailed(account, user.email, `не добавился (${error.message})`);
        continue;
      }
      result.added += 1;
      const o = outcomes.get(account);
      if (o) o.added += 1;
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
      rowFailed(account, user.email, `не обновился (${error.message})`);
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

  await recordOutcomes(outcomes, source, nowIso, log);

  log(
    'info',
    `Каталог Google (${[...readAccounts].join(', ')}): всего ${result.total}, новых ${result.added}, `
    + `обновлено ${result.updated}, заблокировано ${result.suspended}, пропало ${result.missing}`,
  );
  return result;
}
