import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { refuseOwnMailboxConnectForEng, requireByoMailboxClient } from '@/lib/byoMailbox/access';
import { sealMailboxSecret } from '@/lib/byoMailbox/credentials';
import { verifySmtp, sendTestEmail } from '@/lib/byoMailbox/smtp';
import { assertSafeSmtpTarget, assertSafeImapTarget } from '@/lib/byoMailbox/netGuard';
import { presetFor, isFreeDomain, type MailboxProvider } from '@/lib/byoMailbox/providers';
import { registerMailboxForSending } from '@/lib/byoMailbox/sendingProvider';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';
import type { ClientMarket } from '@/lib/engMarket';

export const dynamic = 'force-dynamic';

/**
 * Колонки, которые роут ЧИТАЕТ из БД. Наружу уходит не этот список, а проекция
 * `toClientMailbox`: имена `instantly_*` называют рассыльщика, про которого
 * клиент знать не должен (миграция 20260818_0001_mailbox_instantly_link.sql так
 * и пишет: «клиент про Instantly не знает, имя колонок внутреннее»), а в
 * `instantly_error` лежит тело ответа провайдера вместе с его брендом.
 *
 * `instantly_registered_at`, `instantly_checked_at` и `instantly_vitals` не
 * читаем вовсе: их не показывает ни один кабинет, а `instantly_vitals` — это
 * сырой итог проверки живости у провайдера, то есть внутренние данные целиком.
 */
const SELECT_COLS =
  'id, email, display_name, provider, smtp_host, smtp_port, smtp_secure, imap_host, imap_port, username, status, last_verified_at, last_error, daily_limit, created_at, instantly_status, instantly_error';

/** Состояния регистрации из CHECK-констрейнта таблицы: имена наши, бренда в них нет. */
const SENDING_STATUSES = new Set(['not_registered', 'registered', 'failed', 'removed']);

/**
 * Текст ошибки регистрации наружу не отдаём НИКОГДА: в `instantly_error` лежит
 * либо русская константа адаптера (`byoMailbox/sendingProvider.ts`), либо тело
 * ответа провайдера вместе с его именем, обрезанное до 400 символов. Вместо
 * текста — одна из двух констант ниже; они собраны только из литералов этого
 * файла, так что ни один байт входа наружу не проходит.
 *
 * Классификатор `hypothesisEngine/clientErrors` сюда не подошёл, хотя формой
 * задача та же: он написан про стадии движка V1, и его объяснения
 * («everything collected so far is saved», «start the step again») на экране
 * подключения почты звучат мимо — клиент теряет единственное действие, которое
 * ему доступно. Тянуть модуль движка в контур byoMailbox ради этого тем более
 * незачем: связи между ними нет.
 *
 * Разбирать причину по тексту не требуется: постоянную ошибку от временной
 * адаптер уже отличил сам — `instantly_status='failed'` POST ставит ровно при
 * `reg.permanent`, а `not_registered` при временной.
 */
const SENDING_ERROR_PERMANENT =
  'This mailbox could not be set up for sending. Reconnect it with a fresh app password; if it keeps failing, contact your manager.';
/**
 * То же для ENG-кабинета: он self-serve, менеджера у его клиента нет —
 * Support (чат кабинета; страница /client/eng/mailboxes печатает слово ссылкой
 * через EngSupportText). RU-текст выше не меняется.
 */
const SENDING_ERROR_PERMANENT_ENG =
  'This mailbox could not be set up for sending. Reconnect it with a fresh app password; if it keeps failing, message Support.';
const SENDING_ERROR_RETRY =
  'This mailbox is not ready for sending yet. We retry automatically; if the status does not change, reconnect it.';

/**
 * 500-е: наружу константа + машинный код, сырьё — в `application_logs`
 * (контракт `api/client/eng/_shared.ts`). Тексты английские, и для RU это не
 * регресс: до сих пор здесь отдавался `error.message` PostgREST, то есть тоже
 * английская техническая строка, только ещё и с именами таблиц и колонок.
 */
const LIST_FAILED = 'Could not load the mailbox list.';
const SAVE_FAILED = 'Could not save the mailbox.';

function sendingStatusOf(value: unknown): string | null {
  // Белый список, а не passthrough: незнакомое значение лучше не показать
  // вовсе, чем отдать наружу то, чего мы не проверяли.
  return typeof value === 'string' && SENDING_STATUSES.has(value) ? value : null;
}

function sendingErrorOf(status: unknown, error: unknown, forEng: boolean): string | null {
  if (!error) return null;
  if (status !== 'failed') return SENDING_ERROR_RETRY;
  return forEng ? SENDING_ERROR_PERMANENT_ENG : SENDING_ERROR_PERMANENT;
}

/**
 * Кабинет запроса берём из общего гейта: `requireByoMailboxClient` →
 * `requireClientAuth` → `auth.market` (Host ENG-кабинета либо
 * `profiles.market`, см. `lib/clientApiHelper.ts`).
 *
 * Раньше тут стоял `?surface=eng` — пометка от вызывающего экрана. Забыть её
 * можно было молча: без параметра английский клиент получал русскую строку и
 * в payload, и (если бы не скраб на экране) в интерфейсе, а сам отказ при этом
 * выглядел рабочим. Host и колонку профиля забыть нельзя — их проставляет не
 * экран, а запрос; правило то же, по которому `byoMailbox/accessPolicy` вообще
 * открывает этому клиенту подключение почты.
 *
 * RU-кабинет живёт на основном хосте и с `market='ru'`, поэтому для него
 * ветка ниже не меняется ни на байт.
 */
const ENG_MARKET: ClientMarket = 'eng';

/**
 * Отказ 4xx общего роута.
 *
 * RU-экран печатает `error` как есть (`app/client/mailboxes/page.tsx:175`) —
 * русские тексты остаются его единственным объяснением опечатки. ENG-экран
 * разбирает отказ по `code` и печатает свой текст С ДЕЙСТВИЕМ
 * (`client/eng/mailboxes/page.tsx`), поэтому в payload ему уезжает не русская
 * строка, а одна английская константа: по планке волны 0 русского текста не
 * должно быть и в теле ответа, а не только на экране.
 *
 * Именно константа, а не перевод каждой причины: вторая копия восьми фраз
 * разошлась бы с картой экрана при первой же правке. Текст этой константы
 * клиент видит только если код отказа экрану незнаком — тогда он и должен быть
 * общим.
 */
const ENG_CONNECT_REJECTED =
  'Could not connect this mailbox. Check the address, the host and the port, and the app password, then try again.';

function connectRejection(market: ClientMarket, ruText: string, code: string, status: number): NextResponse {
  return NextResponse.json(
    { error: market === ENG_MARKET ? ENG_CONNECT_REJECTED : ruText, code },
    { status },
  );
}

/**
 * `client_mailbox_accounts.last_error` → английский текст для ENG-кабинета.
 *
 * Колонку пишет ровно один код — `byoMailbox/sender.ts:183` при умершем
 * refresh-токене; POST выше и оба OAuth-колбэка её только обнуляют. Поэтому
 * правка на стороне ЗАПИСИ ничего бы не дала: строки, записанные до неё, лежат
 * в БД, и кабинет читает именно их. Перевод — на чтении, значит история
 * закрыта вместе с будущими записями.
 *
 * Карта, а не скраб: незнакомый текст выбрасываем (`null`). Это та же граница,
 * что `COLLECT_SOURCE_LABELS`/`CONSTRUCT_NOTE_LABELS` в проекции движка —
 * наружу уходят только наши собственные литералы.
 */
const LAST_ERROR_LABELS_EN: Record<string, string> = {
  'Токен доступа истёк — переподключите ящик.':
    'This mailbox needs to be connected again: its access expired. Reconnect it to keep campaigns sending.',
};

function lastErrorForEng(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return LAST_ERROR_LABELS_EN[value.trim()] ?? null;
}

/**
 * Строка `client_mailbox_accounts` → то, что видит клиент.
 *
 * Белый список, а не «вычеркнуть лишнее»: новая колонка таблицы не должна
 * уезжать клиенту сама собой — именно так сюда и приехали поля `instantly_*`.
 * Параметры самого ящика (хост, порт, лимит) — данные клиента, их оставляем
 * как есть: их показывает RU-кабинет (`app/client/mailboxes/page.tsx`).
 */
function toClientMailbox(row: Record<string, unknown>, forEng: boolean): Record<string, unknown> {
  return {
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    provider: row.provider,
    smtp_host: row.smtp_host,
    smtp_port: row.smtp_port,
    smtp_secure: row.smtp_secure,
    imap_host: row.imap_host,
    imap_port: row.imap_port,
    username: row.username,
    status: row.status,
    last_verified_at: row.last_verified_at,
    last_error: forEng ? lastErrorForEng(row.last_error) : row.last_error,
    daily_limit: row.daily_limit,
    created_at: row.created_at,
    sendingStatus: sendingStatusOf(row.instantly_status),
    sendingError: sendingErrorOf(row.instantly_status, row.instantly_error, forEng),
  };
}

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
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured', code: 'SERVER_MISCONFIGURED' }, { status: 500 });
  }

  const { data, error } = await supabaseAdmin
    .from('client_mailbox_accounts')
    .select(SELECT_COLS)
    .eq('client_user_id', res.auth.userId)
    .order('created_at', { ascending: false });

  if (error) {
    await logError('byoMailbox.list.failed', error, { userId: res.auth.userId });
    return NextResponse.json({ error: LIST_FAILED, code: 'MAILBOX_LIST_FAILED' }, { status: 500 });
  }
  const forEng = res.auth.market === ENG_MARKET;
  return NextResponse.json({
    mailboxes: (data ?? []).map((row) => toClientMailbox(row as unknown as Record<string, unknown>, forEng)),
  });
}

/** POST /api/client/mailboxes — подключить ящик: верифицируем SMTP → шифруем → сохраняем. */
export async function POST(req: NextRequest) {
  const res = await requireByoMailboxClient(req);
  if ('error' in res) return res.error;
  // ENG-клиент свои ящики не подключает (byoMailbox/accessPolicy.ts); RU — дальше как было.
  const engRefusal = refuseOwnMailboxConnectForEng(res.auth);
  if (engRefusal) return engRefusal;
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured', code: 'SERVER_MISCONFIGURED' }, { status: 500 });
  }

  // Русские тексты валидации — для RU-кабинета, который печатает их как есть;
  // английский локализует отказ по `code` (`client/eng/mailboxes/page.tsx`),
  // поэтому код есть у каждого отказа, а не только у SMTP-проверок. Выбор
  // языка — в connectRejection, и рынок известен уже здесь: гейт отработал.
  const market = res.auth.market;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return connectRejection(market, 'Невалидный JSON', 'BAD_JSON', 400);
  }

  const provider = (typeof body.provider === 'string' ? body.provider : 'custom') as MailboxProvider;
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const displayName = String(body.displayName ?? '').trim() || null;

  if (!email || !email.includes('@')) {
    return connectRejection(market, 'Укажите корректный email', 'EMAIL_INVALID', 400);
  }
  if (!password) {
    return connectRejection(market, 'Укажите пароль приложения', 'PASSWORD_REQUIRED', 400);
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
    return connectRejection(market, 'Укажите SMTP-хост и порт', 'SMTP_TARGET_REQUIRED', 400);
  }

  const smtpCfg = { host: smtpHost, port: smtpPort, secure: smtpSecure, username, password };

  // 0) SSRF-guard: только публичный хост + стандартный SMTP-порт.
  const guard = await assertSafeSmtpTarget(smtpHost, smtpPort);
  if (!guard.ok) {
    return connectRejection(market, 'Недопустимый SMTP-хост или порт.', 'SMTP_TARGET_BLOCKED', 400);
  }

  // 0b) Тот же SSRF-guard для IMAP — у Maildoso это индивидуальный хост из CSV,
  //     а byoReplies опрашивает его по расписанию бесконечно, не один раз.
  if (imapHost) {
    const imapGuard = await assertSafeImapTarget(imapHost, imapPort || 993);
    if (!imapGuard.ok) {
      return connectRejection(market, 'Недопустимый IMAP-хост или порт.', 'IMAP_TARGET_BLOCKED', 400);
    }
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
    return connectRejection(
      market,
      'Не удалось подключиться: проверьте хост, порт и пароль приложения.',
      'SMTP_VERIFY_FAILED',
      422,
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
      return connectRejection(
        market,
        'Подключение есть, но тестовое письмо не отправилось.',
        'SMTP_SEND_FAILED',
        422,
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

  if (error) {
    await logError('byoMailbox.save.failed', error, { userId: res.auth.userId, email });
    return NextResponse.json({ error: SAVE_FAILED, code: 'MAILBOX_SAVE_FAILED' }, { status: 500 });
  }

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

  // `scrubBrand` тут больше не годится: он вычищает имя рассыльщика, но всё
  // остальное тело его ответа («… API 400: {…}») отдаёт как есть, а подставляет
  // при этом РУССКУЮ «систему рассылки». Оба свойства для ENG-клиента неверны,
  // поэтому текст заменяем константой — тем же правилом, что и в списке.
  return NextResponse.json({
    mailbox: toClientMailbox({ ...(data as Record<string, unknown>), ...regPatch }, market === ENG_MARKET),
    sendingReady: reg.ok,
    sendingError: reg.ok ? undefined : sendingErrorOf(regPatch.instantly_status, reg.error, market === ENG_MARKET),
    warning,
  });
}
