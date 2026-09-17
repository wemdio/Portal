import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  GoogleWorkspaceNotConfigured,
  isGoogleWorkspaceConfigured,
  listWorkspaceMailboxes,
} from '@/lib/sender/googleWorkspace';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/** GET — настроено ли подключение к Workspace: от этого зависит кнопка на экране. */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.mailboxes.google.status' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    return NextResponse.json({ configured: isGoogleWorkspaceConfigured() });
  });
}

/**
 * POST — забрать ящики из каталога Google Workspace.
 *
 * Пароли не спрашиваются и не хранятся: вход в такой ящик идёт по временному
 * ключу служебного аккаунта. Повторный запуск не плодит строки — уже
 * подключённые ящики обновляются и снова уходят на проверку, а новые ящики
 * домена просто добавляются к списку.
 */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.mailboxes.google.import' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    let users;
    try {
      users = await listWorkspaceMailboxes();
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

    // Заблокированные и архивные ящики в рассылку не годятся: письмо с них не
    // уйдёт, а в списке они выглядели бы рабочими.
    const active = users.filter((user) => !user.suspended && !user.archived);
    if (!active.length) {
      return NextResponse.json({ imported: 0, skipped: users.length, total: users.length });
    }

    const nowIso = new Date().toISOString();
    const rows = active.map((user) => ({
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
      // Проверку входа делает воркер: двести ящиков не уложатся в один запрос.
      status: 'pending',
      last_error: null,
      created_by: auth.user.id,
      updated_at: nowIso,
    }));

    const { data, error } = await supabaseAdmin
      .from('sender_mailboxes')
      .upsert(rows, { onConflict: 'email' })
      .select('id');

    if (error) return jsonError(error.message, 500);

    return NextResponse.json({
      imported: data?.length ?? 0,
      skipped: users.length - active.length,
      total: users.length,
    });
  });
}
