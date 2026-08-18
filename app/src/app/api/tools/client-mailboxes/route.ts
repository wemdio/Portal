import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { sealMailboxSecret } from '@/lib/byoMailbox/credentials';
import { verifySmtp } from '@/lib/byoMailbox/smtp';
import { assertSafeSmtpTarget } from '@/lib/byoMailbox/netGuard';
import { presetFor, type MailboxProvider } from '@/lib/byoMailbox/providers';
import { registerMailboxForSending } from '@/lib/byoMailbox/sendingProvider';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

/**
 * ВТОРОЙ ПУТЬ подключения почты: студия заводит ящики клиенту «под ключ».
 *
 * Клиент с улицы приходит без инфраструктуры: у него нет ни отдельных доменов
 * под аутрич, ни ящиков на них. Слать с его основного домена нельзя — сгорит
 * деловая переписка. Поэтому в онбординге есть шаг «домены»: система подбирает
 * варианты, клиент выбирает, менеджер покупает и настраивает DNS, заводит
 * ящики. Здесь менеджер вносит готовые ящики в кабинет клиента.
 *
 * Отправка после этого работает ровно так же, как у клиента, подключившего
 * свои ящики сам: тот же registerMailboxForSending, тот же провайдер, тот же
 * health-check. Разница только в том, кто ввёл креды.
 */

interface Incoming {
  email?: unknown;
  password?: unknown;
  displayName?: unknown;
  provider?: unknown;
  smtpHost?: unknown;
  smtpPort?: unknown;
  imapHost?: unknown;
  imapPort?: unknown;
  username?: unknown;
  dailyLimit?: unknown;
}

/** POST /api/tools/client-mailboxes — завести ящики клиенту { clientUserId, mailboxes[] }. */
export async function POST(req: NextRequest) {
  const auth = await requireInternalToolAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  let body: { clientUserId?: unknown; mailboxes?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 });
  }

  const clientUserId = String(body.clientUserId ?? '').trim();
  const list = Array.isArray(body.mailboxes) ? (body.mailboxes as Incoming[]) : [];
  if (!clientUserId) return NextResponse.json({ error: 'Укажите clientUserId' }, { status: 400 });
  if (list.length === 0) return NextResponse.json({ error: 'Список ящиков пуст' }, { status: 400 });
  if (list.length > 25) {
    return NextResponse.json({ error: 'За раз не больше 25 ящиков' }, { status: 400 });
  }

  const { data: client } = await supabaseAdmin
    .from('profiles')
    .select('id')
    .eq('id', clientUserId)
    .maybeSingle();
  if (!client) return NextResponse.json({ error: 'Клиент не найден' }, { status: 404 });

  const results: Array<{ email: string; ok: boolean; error?: string; sendingReady?: boolean }> = [];

  // Последовательно, а не пачкой: каждый ящик — это SMTP-логин и вызов
  // провайдера, у которого общий на воркспейс рейт-лимит (прецедент выжигания
  // лимита уже был). Двадцать пять ящиков подряд того не стоят.
  for (const item of list) {
    const email = String(item.email ?? '').trim().toLowerCase();
    const password = String(item.password ?? '');
    if (!email.includes('@') || !password) {
      results.push({ email: email || '(пусто)', ok: false, error: 'Нужны email и пароль' });
      continue;
    }

    const provider = (typeof item.provider === 'string' ? item.provider : 'custom') as MailboxProvider;
    const preset = presetFor(provider);
    const smtpHost = String(item.smtpHost ?? preset?.smtpHost ?? '').trim();
    const smtpPort = Number(item.smtpPort ?? preset?.smtpPort ?? 465);
    const smtpSecure = preset?.smtpSecure ?? true;
    const username = String(item.username ?? '').trim() || email;
    const displayName = String(item.displayName ?? '').trim() || null;
    const dailyLimit = Number(item.dailyLimit ?? 30);

    if (!smtpHost || !Number.isFinite(smtpPort)) {
      results.push({ email, ok: false, error: 'Не задан SMTP-хост или порт' });
      continue;
    }

    const guard = await assertSafeSmtpTarget(smtpHost, smtpPort);
    if (!guard.ok) {
      results.push({ email, ok: false, error: 'Недопустимый SMTP-хост или порт' });
      continue;
    }

    const smtpCfg = { host: smtpHost, port: smtpPort, secure: smtpSecure, username, password };
    const verify = await verifySmtp(smtpCfg);
    if (!verify.ok) {
      results.push({ email, ok: false, error: `SMTP не пускает: ${verify.error ?? 'ошибка входа'}` });
      continue;
    }

    const secret_encrypted = sealMailboxSecret({ smtpPassword: password });
    const nowIso = new Date().toISOString();
    const { data: saved, error: saveErr } = await supabaseAdmin
      .from('client_mailbox_accounts')
      .upsert(
        {
          client_user_id: clientUserId,
          email,
          display_name: displayName,
          provider,
          smtp_host: smtpHost,
          smtp_port: smtpPort,
          smtp_secure: smtpSecure,
          imap_host: String(item.imapHost ?? preset?.imapHost ?? '').trim() || null,
          imap_port: item.imapPort != null ? Number(item.imapPort) : (preset?.imapPort ?? null),
          username,
          secret_encrypted,
          status: 'verified',
          last_verified_at: nowIso,
          last_error: null,
          daily_limit: Number.isFinite(dailyLimit) ? dailyLimit : 30,
          updated_at: nowIso,
        },
        { onConflict: 'client_user_id,email' },
      )
      .select('id, email, display_name, provider, username, smtp_host, smtp_port, imap_host, imap_port, daily_limit')
      .single();

    if (saveErr || !saved) {
      results.push({ email, ok: false, error: saveErr?.message ?? 'Не удалось сохранить' });
      continue;
    }

    const reg = await registerMailboxForSending({
      ...(saved as unknown as Parameters<typeof registerMailboxForSending>[0]),
      secret_encrypted,
    });
    await supabaseAdmin
      .from('client_mailbox_accounts')
      .update(
        reg.ok
          ? { instantly_status: 'registered', instantly_registered_at: nowIso, instantly_error: null }
          : { instantly_status: reg.permanent ? 'failed' : 'not_registered', instantly_error: reg.error },
      )
      .eq('id', (saved as { id: string }).id);

    if (!reg.ok) {
      await logError('byoMailbox.sending.register_failed', new Error(reg.error), {
        managerId: auth.auth.userId,
        clientUserId,
        email,
      });
    }
    results.push({ email, ok: true, sendingReady: reg.ok, error: reg.ok ? undefined : reg.error });
  }

  const ready = results.filter((r) => r.sendingReady).length;
  void logAudit('client.mailboxes.provisioned', 'Manager provisioned client mailboxes', {
    managerId: auth.auth.userId,
    clientUserId,
    total: results.length,
    ready,
  });

  return NextResponse.json({ results, ready, total: results.length });
}
