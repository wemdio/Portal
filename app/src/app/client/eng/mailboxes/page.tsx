'use client';

/**
 * /client/eng/mailboxes — ENG-клиент подключает свои ящики паролем приложения.
 * Заведение у отправляющего провайдера уже есть на POST /api/client/mailboxes;
 * имя провайдера в UI не показываем. OAuth здесь нет: его экран согласия
 * как раз и светит чужой бренд.
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { PROVIDER_PRESETS, type MailboxProvider } from '@/lib/byoMailbox/providers';
import { mailboxSendingView } from '@/lib/byoMailbox/sendingStatusView';
import { scrubBrand } from '@/lib/scrubBrand';
import { EngBadge, EngCard, EngSpinner, type EngTone } from '@/components/client-eng/ui';

interface Mailbox {
  id: string;
  email: string;
  display_name: string | null;
  provider: MailboxProvider;
  status: 'pending' | 'verified' | 'failed' | 'disabled';
  sendingStatus?: string | null;
  sendingError?: string | null;
  last_error: string | null;
  created_at: string;
}

function sendingLabel(row: Mailbox): { label: string; tone: EngTone } {
  if (row.sendingStatus === 'registered') return { label: 'Ready to send', tone: 'green' };
  if (row.sendingStatus === 'failed') return { label: 'Not registered', tone: 'red' };
  if (row.status === 'verified') return { label: 'Connected', tone: 'amber' };
  if (row.status === 'failed') return { label: 'Failed', tone: 'red' };
  return { label: 'Pending', tone: 'neutral' };
}

function clientError(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  return scrubBrand(raw).replace(/система рассылки/gi, 'sending service');
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
        setListError('Sign in to connect a mailbox.');
        setLoading(false);
        return;
      }
      const res = await fetch('/api/client/mailboxes', { headers });
      if (!res.ok) {
        setListError(res.status === 403 ? 'This account cannot connect mailboxes yet.' : `Could not load mailboxes (${res.status})`);
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
        if (data.code === 'DEMO_READONLY') {
          setFormError('Demo accounts cannot connect a live mailbox. Sign in with a real ENG client account.');
          return;
        }
        setFormError(clientError(data.error, `Could not connect (${res.status})`));
        return;
      }
      const registered = data.sendingReady === true
        ? 'Mailbox connected and registered for sending.'
        : `Mailbox saved, but sending registration failed: ${clientError(data.sendingError, 'try again in a minute.')}`;
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
          Sending mailboxes
        </h1>
        <p className="mt-1 text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Connect Google Workspace mailboxes with an app password. Campaigns will send from your addresses, not ours.
        </p>
      </header>

      <EngCard className="mb-5">
        <p className="text-sm m-0" style={{ color: 'var(--cp-paper-mute)' }}>
          Use a dedicated outreach domain, not the one your business email already lives on.
          Turn on 2FA, create an app password in Google Account → Security, then paste it below.
          A personal @gmail.com address will connect, but cold email from it burns quickly.
        </p>
      </EngCard>

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
            <p className="mt-3 text-sm m-0" style={{ color: 'var(--cp-red)' }}>{formError}</p>
          )}
          {okMsg && (
            <p className="mt-3 text-sm m-0" style={{ color: 'var(--cp-green)' }}>{okMsg}</p>
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
          <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>No mailboxes yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 p-0 m-0 list-none">
            {mailboxes.map((row) => {
              const sending = sendingLabel(row);
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
                      {row.sendingError && (
                        <p className="mt-2 text-xs m-0" style={{ color: 'var(--cp-red)' }}>
                          {clientError(row.sendingError, 'Registration failed')}
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
