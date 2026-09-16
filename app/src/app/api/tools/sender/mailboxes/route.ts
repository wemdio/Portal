import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sealMailboxSecret } from '@/lib/byoMailbox/credentials';
import { parseMailboxFile, FileParseError } from '@/lib/sender/fileParse';
import { parseMailboxRows, type SenderProvider } from '@/lib/sender/mailboxImport';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

const LIST_COLS =
  'id, provider, email, display_name, username, smtp_host, smtp_port, smtp_tls_mode, imap_host, imap_port, status, daily_campaign_limit, daily_total_limit, last_verified_at, last_error, last_send_at, imap_checked_at, created_at';

const PROVIDERS: SenderProvider[] = ['maildoso', 'zapmail', 'google', 'custom'];
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const PAGE_SIZE = 30;

/** GET — список подключённых ящиков (без паролей), постранично. */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.mailboxes.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const url = new URL(req.url);
    const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);

    // Сортировка строго по email: батч-импорт даёт всем строкам одинаковое
    // created_at, и сортировка по нему дёргает список при каждом опросе
    // статусов — строки менялись местами каждые пару секунд.
    const { data, error, count } = await supabaseAdmin
      .from('sender_mailboxes')
      .select(LIST_COLS, { count: 'exact' })
      .order('email', { ascending: true })
      .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ mailboxes: data ?? [], total: count ?? 0 });
  });
}

/**
 * POST — загрузка выгрузки провайдера (CSV/XLSX). Ящики сохраняются со
 * статусом «ожидает проверки»: вход по SMTP и IMAP проверяет воркер, иначе
 * загрузка сотни ящиков не уложилась бы в один HTTP-запрос.
 */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.mailboxes.import' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return jsonError('Ожидается файл выгрузки', 400);
    }

    const file = form.get('file');
    if (!(file instanceof File)) return jsonError('Добавьте файл выгрузки (CSV или XLSX)', 400);
    if (file.size > MAX_FILE_BYTES) return jsonError('Файл больше 10 МБ', 400);

    const providerRaw = String(form.get('provider') ?? 'maildoso');
    const provider = (PROVIDERS as string[]).includes(providerRaw)
      ? (providerRaw as SenderProvider)
      : 'maildoso';

    let parsed;
    try {
      const rows = parseMailboxFile(file.name, Buffer.from(await file.arrayBuffer()));
      parsed = parseMailboxRows(rows, provider);
    } catch (e) {
      if (e instanceof FileParseError) return jsonError(e.message, 400);
      return jsonError(`Не удалось прочитать файл: ${e instanceof Error ? e.message : String(e)}`, 400);
    }

    if (!parsed.mailboxes.length) {
      return NextResponse.json({ imported: 0, errors: parsed.errors }, { status: 200 });
    }

    const nowIso = new Date().toISOString();
    const rows = parsed.mailboxes.map((mailbox) => ({
      provider,
      email: mailbox.email,
      display_name: mailbox.displayName,
      username: mailbox.username,
      smtp_host: mailbox.smtpHost,
      smtp_port: mailbox.smtpPort,
      smtp_tls_mode: mailbox.smtpTlsMode,
      imap_host: mailbox.imapHost,
      imap_port: mailbox.imapPort,
      secret_encrypted: sealMailboxSecret({
        smtpPassword: mailbox.smtpPassword,
        imapPassword: mailbox.imapPassword ?? undefined,
      }),
      // Повторная загрузка того же файла обновляет пароль и хосты, но снова
      // отправляет ящик на проверку — креды могли смениться.
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
      errors: parsed.errors,
    });
  });
}
