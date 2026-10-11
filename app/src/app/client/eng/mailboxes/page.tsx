'use client';

/**
 * /client/eng/mailboxes — ящики, которые ENG-клиент подключил паролем
 * приложения. Заведение у отправляющего провайдера уже есть на POST
 * /api/client/mailboxes; имя провайдера в UI не показываем. OAuth здесь нет:
 * его экран согласия как раз и светит чужой бренд.
 *
 * С S2 запуск шага 5 собирает пресет отправки только из ящиков пула проекта
 * (engSendingPreset.ensureHeEngPresetForProject), а старт кампании отказывает,
 * если её адреса не из этого пула (engCampaignSending). Подключённый здесь ящик
 * ни в одну кампанию, запущенную кабинетом, не попадает: новое подключение
 * завело бы ящик у провайдера и строку, которую никто не читает. Поэтому форма
 * подключения скрыта (ENG_CONNECT_FORM_SHOWN), а список подключённых раньше
 * ящиков и их удаление остались — данные клиента экран не прячет.
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { PROVIDER_PRESETS, type MailboxProvider } from '@/lib/byoMailbox/providers';
import { mailboxSendingView } from '@/lib/byoMailbox/sendingStatusView';
import { engSafeText } from '@/components/client-eng/engText';
import { EngSupportText } from '@/components/client-eng/EngPaidAccess';
import { EngBadge, EngCard, EngSpinner, type EngTone } from '@/components/client-eng/ui';

/**
 * Запросы к общему `/api/client/mailboxes` идут БЕЗ пометки кабинета.
 *
 * Роут обслуживает оба кабинета, и часть колонок хранит РУССКИЙ текст, который
 * RU-экран печатает как есть (`app/client/mailboxes/page.tsx`). Кабинет запроса
 * роут определяет сам — по Host ENG-кабинета и `profiles.market`
 * (`lib/clientApiHelper.ts`), то есть по тому же признаку, по которому нам
 * вообще открыто подключение почты. Раньше экран помечал себя `?surface=eng`:
 * пометку можно было забыть в новом фетче, и английский клиент молча получал
 * русскую строку.
 *
 * Скраб `engSafeText` ниже при этом остаётся — он второй замок, а не первый.
 */

interface Mailbox {
  id: string;
  email: string;
  display_name: string | null;
  provider: MailboxProvider;
  status: 'pending' | 'verified' | 'failed' | 'disabled';
  sendingStatus?: string | null;
  sendingError?: string | null;
  /** Состояние самого ящика (не регистрации): переведено роутом для ENG-кабинета. */
  last_error: string | null;
  created_at: string;
}

/**
 * Форма подключения ящика — см. шапку: кампании кабинета подключённые ящики не
 * используют. Код формы оставлен целиком: если ящики клиента снова начнут
 * попадать в кампании, форма возвращается этим флагом вместе с текстами шапки.
 */
const ENG_CONNECT_FORM_SHOWN = false;

/**
 * Бейдж — состояние заведения ящика у провайдера, не отправка: «Ready to send»
 * рядом со словами шапки «кампании шлют не отсюда» читалось бы как обещание.
 */
function sendingLabel(row: Mailbox): { label: string; tone: EngTone } {
  if (row.sendingStatus === 'registered') return { label: 'Registered', tone: 'green' };
  if (row.sendingStatus === 'failed') return { label: 'Not registered', tone: 'red' };
  if (row.status === 'verified') return { label: 'Connected', tone: 'amber' };
  if (row.status === 'failed') return { label: 'Failed', tone: 'red' };
  return { label: 'Pending', tone: 'neutral' };
}

/**
 * Коды отказа POST /api/client/mailboxes → английский текст С ДЕЙСТВИЕМ.
 *
 * Нам роут отдаёт одну общую английскую константу на все отказы (русский текст
 * достаётся RU-кабинету, который его и печатает), а вот `code` у него
 * стабильный — по нему и локализуем. Без этой карты клиент потерял бы ровно
 * то единственное, что мог бы починить сам: хост, порт, пароль приложения.
 *
 * Порты в текстах — те, что реально пропускает SSRF-guard
 * (`byoMailbox/netGuard.ts`: SMTP 465/587/2525, IMAP 993), иначе совет
 * отправит клиента в стену.
 *
 * Карта покрывает ВСЕ 4xx с кодом: восемь проверок самого роута плюс
 * `DEMO_READONLY` из общего гейта. Остальные отказы сюда не вносим осознанно:
 * 500-е роута (`MAILBOX_LIST_FAILED`, `MAILBOX_SAVE_FAILED`,
 * `SERVER_MISCONFIGURED`) код тоже несут, но их текст — уже английская
 * константа роута, и она проходит скрабом как есть; копия здесь завела бы
 * второй источник правды на ту же фразу. А 401/403/503 приходят из общего
 * `lib/clientApiHelper.ts` и кода не несут вовсе — их разбирает
 * `connectErrorText` по статусу.
 */
const CONNECT_ERROR_BY_CODE: Record<string, string> = {
  DEMO_READONLY: 'Demo accounts cannot connect a live mailbox. Sign in with a real ENG client account.',
  BAD_JSON: 'The connection request did not reach us in one piece. Reload this page and enter the mailbox again.',
  EMAIL_INVALID: 'Enter the full mailbox address, including the part after the @.',
  PASSWORD_REQUIRED:
    'Enter the app password for this mailbox. It is the one you generate in Google Account → Security → App passwords, not the password you sign in with.',
  // Хост берётся из пресета провайдера, поэтому с этой формы код практически
  // недостижим — но текст даём честный: чинится он не в форме, а у нас.
  // Менеджера у self-serve кабинета нет — Support (чат кабинета; слово —
  // ссылка, экран печатает отказ через EngSupportText).
  SMTP_TARGET_REQUIRED:
    'We could not work out the sending server for this address. Message Support with this address so it can be set up.',
  SMTP_VERIFY_FAILED:
    'Could not sign in to this mailbox. Check the host and the port, and make sure the password is an app password created with 2-step verification turned on — the normal account password will not work.',
  SMTP_SEND_FAILED:
    'The mailbox signed in, but the test email did not go out. Check that this address is allowed to send, then try again.',
  SMTP_TARGET_BLOCKED:
    'That SMTP host or port is not allowed. Use the public SMTP server of your mail provider on port 465 or 587.',
  IMAP_TARGET_BLOCKED:
    'That IMAP host or port is not allowed. Use the public IMAP server of your mail provider on port 993.',
};

/** Ни код не опознан, ни текст роута не показуем — общий, но всё ещё с действием. */
const CONNECT_ERROR_FALLBACK =
  'Could not connect this mailbox. Check the address, the host and the port, and the app password, then try again.';

/** Заведение ящика у отправляющего провайдера — отдельный шаг и отдельный текст. */
const SENDING_ERROR_FALLBACK = 'Not registered for sending. Your campaigns do not use this mailbox.';

function connectErrorText(status: number, code: string | undefined, raw: string | undefined): string {
  const byCode = code ? CONNECT_ERROR_BY_CODE[code] : undefined;
  if (byCode) return byCode;
  // Отказы гейта и инфраструктуры кода не несут (они приходят из общего
  // `lib/clientApiHelper.ts`, а не из роута почты), но их причина однозначна по
  // статусу. 503 разбираем отдельно от общего фолбэка намеренно: блип БД чинится
  // ожиданием, а фолбэк отправил бы клиента перепроверять хост и пароль —
  // единственное, что здесь точно ни при чём.
  if (status === 403) return 'This account cannot connect mailboxes yet. Message Support to have it enabled.';
  if (status === 401) return 'Your session has expired. Sign in again, then reconnect the mailbox.';
  if (status === 503) return 'The service is busy right now. Wait a moment and connect the mailbox again.';
  // Остальное (отказ БД, прочие 5xx) — текст роута годится, только если он уже
  // английский и без бренда; иначе общий английский.
  return (raw ? engSafeText(raw) : null) ?? CONNECT_ERROR_FALLBACK;
}

/**
 * Отказ GET-списка. Тело у него английское (константа роута либо ENG-ветка
 * общего хелпера), но общее на все причины — поэтому текст ответа не читаем
 * вовсе, разбираем по статусу. Истёкшая сессия здесь так же вероятна, как в
 * форме: экран перезапрашивает список после каждого подключения и удаления.
 */
function listErrorText(status: number): string {
  if (status === 403) return 'This account has no access to connected mailboxes.';
  if (status === 401) return 'Your session has expired. Sign in again to see your mailboxes.';
  if (status === 503) return 'The service is busy right now. Refresh the page in a moment.';
  return `Could not load mailboxes (${status})`;
}

/**
 * Ошибка заведения ящика у отправляющего провайдера. Кодов тут нет вообще: в
 * `instantly_error` лежит либо русская константа нашего адаптера, либо тело
 * ответа провайдера вместе с его именем (список из GET скрабом не проходил).
 * Поэтому показываем только то, что пережило скраб и оказалось английским.
 */
function sendingErrorText(raw: string | null | undefined, fallback: string): string {
  return (raw ? engSafeText(raw) : null) ?? fallback;
}

export default function EngMailboxesPage() {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [sendTest, setSendTest] = useState(true);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  async function authHeaders(): Promise<Record<string, string> | null> {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return null;
    return { Authorization: `Bearer ${token}` };
  }

  const fetchMailboxes = useCallback(async () => {
    setListError(null);
    try {
      const headers = await authHeaders();
      if (!headers) {
        setListError('Sign in to see your mailboxes.');
        setLoading(false);
        return;
      }
      const res = await fetch('/api/client/mailboxes', { headers });
      if (!res.ok) {
        setListError(listErrorText(res.status));
        setLoading(false);
        return;
      }
      const data = (await res.json()) as { mailboxes: Mailbox[] };
      setMailboxes(
        (data.mailboxes ?? []).map((row) => ({
          ...row,
          ...mailboxSendingView(row),
        })),
      );
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMailboxes();
  }, [fetchMailboxes]);

  async function onConnect(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setOkMsg(null);
    setBusy(true);
    try {
      const headers = await authHeaders();
      if (!headers) {
        setFormError('Sign in to connect a mailbox.');
        return;
      }
      const res = await fetch('/api/client/mailboxes', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'gmail',
          email: email.trim(),
          displayName: displayName.trim() || undefined,
          password,
          sendTest,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        warning?: string;
        sendingReady?: boolean;
        sendingError?: string;
      };
      if (!res.ok) {
        setFormError(connectErrorText(res.status, data.code, data.error));
        return;
      }
      const registered = data.sendingReady === true
        ? 'Mailbox connected and registered for sending.'
        : `Mailbox saved, but sending registration failed: ${sendingErrorText(data.sendingError, 'try again in a minute; if it keeps failing, reconnect the mailbox.')}`;
      setOkMsg(data.warning ? `${registered} ${data.warning}` : registered);
      setEmail('');
      setPassword('');
      setDisplayName('');
      await fetchMailboxes();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    if (!confirm('Remove this mailbox?')) return;
    const headers = await authHeaders();
    if (!headers) return;
    const res = await fetch(`/api/client/mailboxes/${id}`, { method: 'DELETE', headers });
    if (res.ok) await fetchMailboxes();
  }

  const inputCls =
    'w-full rounded-md border px-3 py-2 text-sm outline-none';
  const inputStyle = {
    borderColor: 'var(--cp-divider)',
    background: 'var(--cp-bg)',
    color: 'var(--cp-paper)',
  };

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
          Connected mailboxes
        </h1>
        {/* С S2 кампании, запущенные кабинетом, шлют только из ящиков пула
            проекта (см. шапку файла), и прежние фразы «Campaigns will send from
            your addresses, not ours» и «Connect Google Workspace mailboxes»
            стали неправдой. «Campaigns you launch» — а не «your campaigns»:
            из каких ящиков шлёт кампания, созданная до S2 из пресета
            команды, экран не знает. */}
        <p className="mt-1 text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Campaigns you launch on step 5 «Review &amp; Launch» send from mailboxes we provide, not from mailboxes
          connected here, so this page no longer connects new ones. Mailboxes you connected earlier, if any, are
          listed below, and you can remove them.
        </p>
      </header>

      {ENG_CONNECT_FORM_SHOWN && (
        <EngCard className="mb-5">
          <p className="text-sm m-0" style={{ color: 'var(--cp-paper-mute)' }}>
            Use a dedicated outreach domain, not the one your business email already lives on.
            Turn on 2FA, create an app password in Google Account → Security, then paste it below.
            A personal @gmail.com address will connect, but cold email from it burns quickly.
          </p>
        </EngCard>
      )}

      {ENG_CONNECT_FORM_SHOWN && (
        <form onSubmit={onConnect} className="mb-8">
          <EngCard>
            <h2 className="text-sm font-semibold m-0 mb-3" style={{ color: 'var(--cp-paper)' }}>
              Connect a mailbox
            </h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="text-sm sm:col-span-2">
                <span className="mb-1 block" style={{ color: 'var(--cp-text-m)' }}>Email</span>
                <input
                  className={inputCls}
                  style={inputStyle}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="john@getyourbrand.com"
                  required
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block" style={{ color: 'var(--cp-text-m)' }}>From name (optional)</span>
                <input
                  className={inputCls}
                  style={inputStyle}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="John at Acme"
                />
              </label>
              <label className="text-sm">
                <span className="mb-1 block" style={{ color: 'var(--cp-text-m)' }}>App password</span>
                <input
                  className={inputCls}
                  style={inputStyle}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                />
                <span className="mt-1 block text-xs" style={{ color: 'var(--cp-text-m)' }}>
                  {PROVIDER_PRESETS.gmail.hint}
                </span>
              </label>
            </div>
            <label className="mt-3 flex items-center gap-2 text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
              <input
                type="checkbox"
                checked={sendTest}
                onChange={(e) => setSendTest(e.target.checked)}
              />
              Send a test email to this same address
            </label>
            {formError && (
              <p className="mt-3 text-sm m-0" style={{ color: 'var(--cp-red)' }}>
                <EngSupportText text={formError} />
              </p>
            )}
            {okMsg && (
              <p className="mt-3 text-sm m-0" style={{ color: 'var(--cp-green)' }}>
                <EngSupportText text={okMsg} />
              </p>
            )}
            <button
              type="submit"
              disabled={busy}
              className="mt-4 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
              style={{ background: 'var(--cp-paper)', color: 'var(--cp-bg)' }}
            >
              {busy ? 'Connecting…' : 'Connect mailbox'}
            </button>
          </EngCard>
        </form>
      )}

      <section>
        <h2 className="text-sm font-semibold mb-3" style={{ color: 'var(--cp-paper)' }}>
          Connected
        </h2>
        {loading ? (
          <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--cp-text-m)' }}>
            <EngSpinner /> Loading
          </div>
        ) : listError ? (
          <p className="text-sm" style={{ color: 'var(--cp-red)' }}>{listError}</p>
        ) : mailboxes.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>No mailboxes connected.</p>
        ) : (
          <ul className="flex flex-col gap-2 p-0 m-0 list-none">
            {mailboxes.map((row) => {
              const sending = sendingLabel(row);
              const mailboxError = row.last_error ? engSafeText(row.last_error) : null;
              return (
                <li key={row.id}>
                  <EngCard className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-medium" style={{ color: 'var(--cp-paper)' }}>
                        {row.display_name || row.email}
                      </div>
                      {row.display_name && (
                        <div className="text-xs mt-0.5" style={{ color: 'var(--cp-text-m)' }}>{row.email}</div>
                      )}
                      <div className="mt-2">
                        <EngBadge label={sending.label} tone={sending.tone} />
                      </div>
                      {/*
                        Состояние самого ящика: его пишет отправляющий воркер,
                        когда доступ к ящику умер, и до этой правки экран
                        объявлял поле, но не показывал — клиент видел красный
                        бейдж без единственного доступного ему действия.
                        Текст уже переведён роутом (он сам знает кабинет
                        запроса), скраб здесь — второй замок: если правило
                        когда-нибудь разойдётся, русская строка не отрисуется,
                        а исчезнет.
                      */}
                      {mailboxError && (
                        <p className="mt-2 text-xs m-0" style={{ color: 'var(--cp-red)' }}>
                          {mailboxError}
                        </p>
                      )}
                      {row.sendingError && (
                        <p className="mt-2 text-xs m-0" style={{ color: 'var(--cp-red)' }}>
                          <EngSupportText text={sendingErrorText(row.sendingError, SENDING_ERROR_FALLBACK)} />
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => void onDelete(row.id)}
                      className="text-xs underline"
                      style={{ color: 'var(--cp-text-m)' }}
                    >
                      Remove
                    </button>
                  </EngCard>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
