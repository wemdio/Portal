import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { requireByoMailboxClient } from '@/lib/byoMailbox/access';
import { sealMailboxSecret } from '@/lib/byoMailbox/credentials';
import { verifySmtp, sendTestEmail } from '@/lib/byoMailbox/smtp';
import { assertSafeSmtpTarget } from '@/lib/byoMailbox/netGuard';
import { presetFor, isFreeDomain, type MailboxProvider } from '@/lib/byoMailbox/providers';
import { registerMailboxForSending } from '@/lib/byoMailbox/sendingProvider';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';
import { scrubBrand } from '@/lib/scrubBrand';

export const dynamic = 'force-dynamic';

const SELECT_COLS =
  'id, email, display_name, provider, smtp_host, smtp_port, smtp_secure, imap_host, imap_port, username, status, last_verified_at, last_error, daily_limit, created_at, instantly_status, instantly_registered_at, instantly_error, instantly_checked_at, instantly_vitals';

/**
 * Домены проектов клиента: с них он ведёт настоящую переписку.
 * Холодная рассылка с основного домена бьёт по его же деловой почте, и
 * восстанавливается репутация долго. Предупреждаем, но не запрещаем: бывают
 * осознанные сценарии, а решать клиенту.
 */
async function clientOwnDomains(userId: string): Promise<Set<string>> {
  const out = new Set<string>();
  if (!supabaseAdmin) return out;
  const { data } = await supabaseAdmin
    .from('he_projects')
    .select('website_url')
    .eq('created_by', userId)
    .limit(50);
  for (const row of data ?? []) {
    const raw = String((row as { website_url?: unknown }).website_url ?? '');
    const host = raw.replace(/^https?:\/\//i, '').split('/')[0].replace(/^www\./i, '').toLowerCase();
    if (host) out.add(host);
  }
  return out;
}

/** GET /api/client/mailboxes — список подключённых ящиков клиента (без секретов). */
export async function GET(req: NextRequest) {
  const res = await requireByoMailboxClient(req);
  if ('error' in res) return res.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { data, error } = await supabaseAdmin
    .from('client_mailbox_accounts')
    .select(SELECT_COLS)
    .eq('client_user_id', res.auth.userId)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ mailboxes: data ?? [] });
}

/** POST /api/client/mailboxes — подключить ящик: верифицируем SMTP → шифруем → сохраняем. */
export async function POST(req: NextRequest) {
  const res = await requireByoMailboxClient(req);
  if ('error' in res) return res.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Невалидный JSON' }, { status: 400 });
  }

  const provider = (typeof body.provider === 'string' ? body.provider : 'custom') as MailboxProvider;
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const displayName = String(body.displayName ?? '').trim() || null;

  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'Укажите корректный email' }, { status: 400 });
  }
  if (!password) {
    return NextResponse.json({ error: 'Укажите пароль приложения' }, { status: 400 });
  }

  const preset = presetFor(provider);
  const smtpHost = String(body.smtpHost ?? preset?.smtpHost ?? '').trim();
  const smtpPort = Number(body.smtpPort ?? preset?.smtpPort ?? 465);
  const smtpSecure = body.smtpSecure != null ? Boolean(body.smtpSecure) : (preset?.smtpSecure ?? true);
  const imapHost = String(body.imapHost ?? preset?.imapHost ?? '').trim() || null;
  const imapPort =
    body.imapPort != null ? Number(body.imapPort) : (preset?.imapPort ?? null);
  const username = String(body.username ?? '').trim() || email;

  if (!smtpHost || !Number.isFinite(smtpPort)) {
    return NextResponse.json({ error: 'Укажите SMTP-хост и порт' }, { status: 400 });
  }

  const smtpCfg = { host: smtpHost, port: smtpPort, secure: smtpSecure, username, password };

  // 0) SSRF-guard: только публичный хост + стандартный SMTP-порт.
  const guard = await assertSafeSmtpTarget(smtpHost, smtpPort);
  if (!guard.ok) {
    return NextResponse.json(
      { error: 'Недопустимый SMTP-хост или порт.', code: 'SMTP_TARGET_BLOCKED' },
      { status: 400 },
    );
  }

  // 1) Проверяем, что логинимся в SMTP. Детали — только в серверный лог; клиенту
  //    отдаём общее сообщение, чтобы ошибка не работала как recon-оракул.
  const verify = await verifySmtp(smtpCfg);
  if (!verify.ok) {
    await logError('byoMailbox.smtp.verify_failed', new Error(verify.error || 'verify failed'), {
      userId: res.auth.userId,
      host: smtpHost,
      port: smtpPort,
    });
    return NextResponse.json(
      { error: 'Не удалось подключиться: проверьте хост, порт и пароль приложения.', code: 'SMTP_VERIFY_FAILED' },
      { status: 422 },
    );
  }

  // 2) Опционально шлём тестовое письмо самому себе.
  if (body.sendTest) {
    const test = await sendTestEmail(smtpCfg, email, email);
    if (!test.ok) {
      await logError('byoMailbox.smtp.send_failed', new Error(test.error || 'send failed'), {
        userId: res.auth.userId,
        host: smtpHost,
      });
      return NextResponse.json(
        { error: 'Подключение есть, но тестовое письмо не отправилось.', code: 'SMTP_SEND_FAILED' },
        { status: 422 },
      );
    }
  }

  // 3) Шифруем пароль и сохраняем.
  const secret_encrypted = sealMailboxSecret({
    smtpPassword: password,
    imapPassword: body.imapPassword ? String(body.imapPassword) : undefined,
  });

  const nowIso = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('client_mailbox_accounts')
    .upsert(
      {
        client_user_id: res.auth.userId,
        email,
        display_name: displayName,
        provider,
        smtp_host: smtpHost,
        smtp_port: smtpPort,
        smtp_secure: smtpSecure,
        imap_host: imapHost,
        imap_port: imapPort,
        username,
        secret_encrypted,
        status: 'verified',
        last_verified_at: nowIso,
        last_error: null,
        updated_at: nowIso,
      },
      { onConflict: 'client_user_id,email' },
    )
    .select(SELECT_COLS)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 4) Заводим ящик у отправляющего провайдера. Это и есть то, ради чего всё:
  //    до сих пор ENG-кампании уходили с НАШИХ ящиков в общем воркспейсе.
  //    Провал регистрации не откатывает сохранение: ящик проверен и лежит у
  //    нас, повторить заведение можно ретраем, а терять введённые клиентом
  //    креды из-за блипа провайдера нельзя.
  const row = data as unknown as Parameters<typeof registerMailboxForSending>[0];
  const reg = await registerMailboxForSending({ ...row, secret_encrypted });
  const regPatch = reg.ok
    ? { instantly_status: 'registered', instantly_registered_at: nowIso, instantly_error: null }
    : { instantly_status: reg.permanent ? 'failed' : 'not_registered', instantly_error: reg.error };
  await supabaseAdmin.from('client_mailbox_accounts').update(regPatch).eq('id', (data as { id: string }).id);

  if (!reg.ok) {
    await logError('byoMailbox.sending.register_failed', new Error(reg.error), {
      userId: res.auth.userId,
      email,
      permanent: reg.permanent,
    });
  }

  // Предупреждения — по убыванию опасности, показываем самое важное.
  const ownDomains = await clientOwnDomains(res.auth.userId);
  const domain = email.split('@')[1] ?? '';
  let warning: string | undefined;
  if (ownDomains.has(domain)) {
    warning =
      'This is the domain your business actually runs on. Cold email sent from it puts your everyday correspondence at risk: ' +
      'if recipients mark it as spam, your invoices and client threads start landing in spam too, and that takes months to undo. ' +
      'Use separate lookalike domains for outreach and keep this one for real conversations.';
  } else if (isFreeDomain(email)) {
    warning =
      'This is a free mail domain. It connects, but cold outreach from it gets throttled and blocked quickly. ' +
      'Use a business domain you control, warmed up before sending.';
  }

  return NextResponse.json({
    mailbox: { ...(data as Record<string, unknown>), ...regPatch },
    sendingReady: reg.ok,
    sendingError: reg.ok ? undefined : scrubBrand(reg.error),
    warning,
  });
}
