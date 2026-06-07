'use client';

/**
 * /client/mailboxes — BYO: клиент подключает свои почтовые ящики для отправки
 * через собственный SMTP (наш движок, без Instantly).
 *
 * Пилот: доступ только пользователям из allowlist'а BYO_MAILBOX_PILOT_USER_IDS.
 * Все роуты /api/client/mailboxes отдают 403, если пользователь не в пилоте.
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import {
  PROVIDER_PRESETS,
  presetFor,
  isFreeDomain,
  type MailboxProvider,
} from '@/lib/byoMailbox/providers';

interface Mailbox {
  id: string;
  email: string;
  display_name: string | null;
  provider: MailboxProvider;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: boolean;
  status: 'pending' | 'verified' | 'failed' | 'disabled';
  last_verified_at: string | null;
  last_error: string | null;
  daily_limit: number;
  created_at: string;
}

const PROVIDER_OPTIONS: { id: MailboxProvider; label: string }[] = [
  { id: 'yandex', label: PROVIDER_PRESETS.yandex.label },
  { id: 'mailru', label: PROVIDER_PRESETS.mailru.label },
  { id: 'gmail', label: PROVIDER_PRESETS.gmail.label },
  { id: 'custom', label: 'Другой SMTP (вручную)' },
];

function StatusBadge({ status }: { status: Mailbox['status'] }) {
  const map: Record<Mailbox['status'], { label: string; cls: string }> = {
    verified: { label: 'Подключён', cls: 'bg-emerald-500/15 text-emerald-400' },
    pending: { label: 'Ожидает', cls: 'bg-amber-500/15 text-amber-400' },
    failed: { label: 'Ошибка', cls: 'bg-red-500/15 text-red-400' },
    disabled: { label: 'Выключен', cls: 'bg-zinc-500/15 text-zinc-400' },
  };
  const s = map[status];
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${s.cls}`}>{s.label}</span>;
}

export default function ClientMailboxesPage() {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  // форма
  const [provider, setProvider] = useState<MailboxProvider>('yandex');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('465');
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [sendTest, setSendTest] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  const preset = presetFor(provider);

  async function authHeaders(): Promise<Record<string, string> | null> {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return null;
    return { Authorization: `Bearer ${token}` };
  }

  const fetchMailboxes = useCallback(async () => {
    setListError(null);
    try {
      const headers = await authHeaders();
      if (!headers) {
        setListError('Не авторизованы');
        setLoading(false);
        return;
      }
      const res = await fetch('/api/client/mailboxes', { headers });
      if (!res.ok) {
        setListError(`Ошибка ${res.status}`);
        setLoading(false);
        return;
      }
      const data = (await res.json()) as { mailboxes: Mailbox[] };
      setMailboxes(data.mailboxes);
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Ошибка сети');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchMailboxes();
  }, [fetchMailboxes]);

  // Возврат из Google OAuth: ?connected=<email> или ?oauth_error=<code>
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const connected = sp.get('connected');
    const oerr = sp.get('oauth_error');
    if (connected) {
      setOkMsg(`Подключено через Google: ${connected} ✓`);
      window.history.replaceState({}, '', '/client/mailboxes');
      void fetchMailboxes();
    } else if (oerr) {
      setFormError('Не удалось подключить через Google: ' + oerr);
      window.history.replaceState({}, '', '/client/mailboxes');
    }
  }, [fetchMailboxes]);

  async function connectGoogle() {
    setFormError(null);
    setOkMsg(null);
    try {
      const headers = await authHeaders();
      if (!headers) {
        setFormError('Не авторизованы');
        return;
      }
      const res = await fetch('/api/client/mailboxes/oauth/google/start', { headers });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) {
        setFormError(data.error || `Не удалось начать OAuth (${res.status})`);
        return;
      }
      window.location.href = data.url;
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Ошибка сети');
    }
  }

  async function onConnect(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setOkMsg(null);
    setBusy(true);
    try {
      const headers = await authHeaders();
      if (!headers) {
        setFormError('Не авторизованы');
        return;
      }
      const payload: Record<string, unknown> = {
        provider,
        email: email.trim(),
        displayName: displayName.trim() || undefined,
        password,
        sendTest,
      };
      if (provider === 'custom') {
        payload.smtpHost = smtpHost.trim();
        payload.smtpPort = Number(smtpPort);
        payload.smtpSecure = smtpSecure;
      }
      const res = await fetch('/api/client/mailboxes', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; warning?: string };
      if (!res.ok) {
        setFormError(data.error || `Ошибка ${res.status}`);
        return;
      }
      setOkMsg(data.warning ? `Подключено. ${data.warning}` : 'Ящик подключён ✓');
      setEmail('');
      setPassword('');
      setDisplayName('');
      await fetchMailboxes();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Ошибка сети');
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(id: string) {
    if (!confirm('Удалить этот ящик?')) return;
    const headers = await authHeaders();
    if (!headers) return;
    const res = await fetch(`/api/client/mailboxes/${id}`, { method: 'DELETE', headers });
    if (res.ok) await fetchMailboxes();
  }

  const inputCls =
    'w-full rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-zinc-400';

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold">Мои почты</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Подключите свои почтовые ящики, чтобы кампании уходили с ваших адресов и доменов.
        </p>
      </header>

      {/* Деливерабилити-предупреждение — это не опция, а защита от выжигания почты */}
      <div className="mb-6 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
        <b>Важно про доставляемость.</b> Для холодной рассылки используйте отдельный домен на бизнес-почте
        (Яндекс&nbsp;360, Mail.ru&nbsp;для&nbsp;бизнеса, Google&nbsp;Workspace) с прогревом 2–3&nbsp;недели и настроенными
        SPF/DKIM/DMARC. Личные и бесплатные ящики (@yandex.ru, @mail.ru, @gmail.com) технически подключатся,
        но быстро улетят в спам и могут быть заблокированы.
      </div>

      {/* Gmail / Workspace — подключение в один клик через OAuth */}
      <div className="mb-6 rounded-lg border border-zinc-800 p-4">
        <h2 className="mb-1 text-sm font-semibold text-zinc-300">Gmail / Google Workspace — в один клик</h2>
        <p className="mb-3 text-xs text-zinc-500">
          Без пароля приложения: войдёте на странице Google и подтвердите доступ. Рекомендуемый способ для Gmail/Workspace.
        </p>
        <button
          type="button"
          onClick={connectGoogle}
          className="rounded-md border border-zinc-600 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-100 hover:border-zinc-400"
        >
          Подключить через Google
        </button>
      </div>

      {/* Подключение по паролю приложения / произвольный SMTP */}
      <form onSubmit={onConnect} className="mb-8 rounded-lg border border-zinc-800 p-4">
        <h2 className="mb-3 text-sm font-semibold text-zinc-300">Подключить по паролю приложения / другой SMTP</h2>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            <span className="mb-1 block text-zinc-400">Провайдер</span>
            <select
              className={inputCls}
              value={provider}
              onChange={(e) => setProvider(e.target.value as MailboxProvider)}
            >
              {PROVIDER_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-zinc-400">Email</span>
            <input
              className={inputCls}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="ivan@company.ru"
              required
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-zinc-400">Имя отправителя (необязательно)</span>
            <input
              className={inputCls}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Иван Петров"
            />
          </label>

          <label className="text-sm">
            <span className="mb-1 block text-zinc-400">Пароль приложения</span>
            <input
              className={inputCls}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="пароль приложения, не основной"
              required
            />
          </label>
        </div>

        {preset && (
          <p className="mt-2 text-xs text-zinc-500">{preset.hint}</p>
        )}
        {email && isFreeDomain(email) && (
          <p className="mt-2 text-xs text-amber-400">
            Это бесплатный домен — для холодного аутрича не рекомендуется.
          </p>
        )}

        {provider === 'custom' && (
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="text-sm sm:col-span-1">
              <span className="mb-1 block text-zinc-400">SMTP-хост</span>
              <input className={inputCls} value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.example.com" />
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-zinc-400">Порт</span>
              <input className={inputCls} value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="465" />
            </label>
            <label className="flex items-end gap-2 text-sm">
              <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} />
              <span className="text-zinc-400">SSL (465)</span>
            </label>
          </div>
        )}

        <div className="mt-3 flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm text-zinc-400">
            <input type="checkbox" checked={sendTest} onChange={(e) => setSendTest(e.target.checked)} />
            Отправить тестовое письмо себе
          </label>
          {provider !== 'custom' && (
            <button
              type="button"
              className="text-xs text-zinc-500 underline"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? 'Скрыть' : 'Показать'} параметры SMTP
            </button>
          )}
        </div>

        {showAdvanced && preset && (
          <p className="mt-2 text-xs text-zinc-500">
            SMTP: {preset.smtpHost}:{preset.smtpPort} (SSL) · IMAP: {preset.imapHost}:{preset.imapPort}
          </p>
        )}

        {formError && <p className="mt-3 text-sm text-red-400">{formError}</p>}
        {okMsg && <p className="mt-3 text-sm text-emerald-400">{okMsg}</p>}

        <button
          type="submit"
          disabled={busy}
          className="mt-4 rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 disabled:opacity-50"
        >
          {busy ? 'Проверяем подключение…' : 'Подключить'}
        </button>
      </form>

      {/* Список */}
      <h2 className="mb-3 text-sm font-semibold text-zinc-300">Подключённые ящики</h2>
      {loading ? (
        <p className="text-sm text-zinc-500">Загрузка…</p>
      ) : listError ? (
        <p className="text-sm text-red-400">{listError}</p>
      ) : mailboxes.length === 0 ? (
        <p className="text-sm text-zinc-500">Пока ничего не подключено.</p>
      ) : (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {mailboxes.map((m) => (
            <li key={m.id} className="flex items-center justify-between px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{m.email}</span>
                  <StatusBadge status={m.status} />
                </div>
                <div className="mt-0.5 text-xs text-zinc-500">
                  {m.smtp_host}:{m.smtp_port} · лимит {m.daily_limit}/день
                  {m.last_error ? ` · ${m.last_error}` : ''}
                </div>
              </div>
              <button onClick={() => onDelete(m.id)} className="text-xs text-red-400 hover:underline">
                Отключить
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
