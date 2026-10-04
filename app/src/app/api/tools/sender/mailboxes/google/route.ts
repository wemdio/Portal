import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  GoogleWorkspaceNotConfigured,
  isGoogleWorkspaceConfigured,
  workspaceAccounts,
} from '@/lib/sender/googleWorkspace';
import { syncGoogleWorkspaceMailboxes } from '@/lib/sender/googleSyncWorker';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * GET — настроено ли подключение к Workspace (от этого зависит кнопка на
 * экране) и итог последнего синка по каждому аккаунту.
 *
 * Аккаунты берутся из настроек, а не из таблицы: подключённый, но ещё ни разу
 * не прочитанный Workspace тоже должен быть виден — строкой «синка не было».
 */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.mailboxes.google.status' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const configured = isGoogleWorkspaceConfigured();
    if (!configured || !supabaseAdmin) return NextResponse.json({ configured, accounts: [] });

    const accounts = workspaceAccounts();
    const { data } = await supabaseAdmin
      .from('sender_google_sync_accounts')
      .select('account, last_run_at, last_source, last_ok_at, last_error, last_error_at, mailboxes, added')
      .in('account', accounts);
    const byAccount = new Map((data ?? []).map((row) => [String(row.account), row]));

    return NextResponse.json({
      configured,
      accounts: accounts.map((account) => {
        const row = byAccount.get(account);
        return {
          account,
          lastRunAt: row?.last_run_at ?? null,
          lastSource: row?.last_source ?? null,
          lastOkAt: row?.last_ok_at ?? null,
          lastError: row?.last_error ?? null,
          lastErrorAt: row?.last_error_at ?? null,
          mailboxes: row?.mailboxes ?? null,
          added: row?.added ?? null,
        };
      }),
    });
  });
}

/**
 * POST — синхронизировать каталог прямо сейчас.
 *
 * То же самое воркер делает раз в час сам; кнопка нужна, когда ящики завели
 * только что и ждать целый час незачем. Галочки «берём в рассылку»
 * синхронизация не трогает: новые ящики появляются выключенными.
 */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.mailboxes.google.sync' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    try {
      const result = await syncGoogleWorkspaceMailboxes({ source: 'manual' });
      return NextResponse.json(result);
    } catch (e) {
      if (e instanceof GoogleWorkspaceNotConfigured) return jsonError(e.message, 503);
      const text = e instanceof Error ? e.message : String(e);
      // Самая частая причина отказа — не выданное делегирование: у Google это
      // «unauthorized_client», и без подсказки в этом сообщении не разобраться.
      const hint = text.includes('unauthorized_client')
        ? ' Похоже, в админке Workspace служебному аккаунту не выданы разрешения '
          + '(Безопасность → Управление делегированием на уровне домена).'
        : '';
      return jsonError(`Google не отдал список ящиков: ${text}.${hint}`, 502);
    }
  });
}
