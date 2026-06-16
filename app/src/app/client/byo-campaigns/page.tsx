'use client';

/**
 * /client/byo-campaigns — запуск рассылки через подключённый BYO-ящик (наш SMTP-движок).
 * Пилот, доступ только по флагу BYO_MAILBOX_PILOT_USER_IDS (роуты отдают 403 иначе).
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

interface Mailbox {
  id: string;
  email: string;
  status: string;
}

interface CampaignStat {
  name: string;
  pending: number;
  sent: number;
  failed: number;
  total: number;
}

function parseRecipients(text: string): { email: string; name?: string }[] {
  const out: { email: string; name?: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(/[,;\t]/).map((s) => s.trim()).filter(Boolean);
    const email = (parts[0] || '').toLowerCase();
    if (!email || !email.includes('@')) continue;
    out.push({ email, name: parts[1] || undefined });
  }
  return out;
}

export default function ByoCampaignsPage() {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [mailboxId, setMailboxId] = useState('');
  const [campaignName, setCampaignName] = useState('');
  const [subject, setSubject] = useState('');
  const [bodyText, setBodyText] = useState('');
  const [recipientsText, setRecipientsText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [stats, setStats] = useState<CampaignStat[]>([]);

  async function authHeaders(): Promise<Record<string, string> | null> {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : null;
  }

  const loadMailboxes = useCallback(async () => {
    const h = await authHeaders();
    if (!h) return;
    const res = await fetch('/api/client/mailboxes', { headers: h });
    if (!res.ok) return;
    const data = (await res.json()) as { mailboxes: Mailbox[] };
    const verified = (data.mailboxes || []).filter((m) => m.status === 'verified');
    setMailboxes(verified);
    setMailboxId((cur) => cur || verified[0]?.id || '');
  }, []);

  const loadStats = useCallback(async () => {
    const h = await authHeaders();
    if (!h) return;
    const res = await fetch('/api/client/byo-campaigns', { headers: h });
    if (!res.ok) return;
    const data = (await res.json()) as { campaigns: CampaignStat[] };
    setStats(data.campaigns || []);
  }, []);

  useEffect(() => {
    void loadMailboxes();
    void loadStats();
  }, [loadMailboxes, loadStats]);

  const recipients = parseRecipients(recipientsText);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setOk(null);
    setBusy(true);
    try {
      const h = await authHeaders();
      if (!h) {
        setErr('Не авторизованы');
        return;
      }
      const res = await fetch('/api/client/byo-campaigns', {
        method: 'POST',
        headers: { ...h, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mailboxId, campaignName, subject, body: bodyText, recipients }),
      });
      const data = (await res.json().catch(() => ({}))) as { queued?: number; error?: string };
      if (!res.ok) {
        setErr(data.error || `Ошибка ${res.status}`);
        return;
      }
      setOk(`В очередь поставлено писем: ${data.queued}. Рассылка идёт в фоне с учётом дневного лимита ящика.`);
      setRecipientsText('');
      void loadStats();
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : 'Ошибка сети');
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    'w-full rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-sm outline-none focus:border-zinc-400';

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Рассылка</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Отправка кампании через подключённый ящик. Переменные в теме и тексте:{' '}
            <code className="text-zinc-300">{'{{first_name}}'}</code>,{' '}
            <code className="text-zinc-300">{'{{name}}'}</code>.
          </p>
        </div>
        <a href="/client/mailboxes" className="shrink-0 text-sm text-zinc-400 underline">
          ← Мои почты
        </a>
      </header>

      {mailboxes.length === 0 ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Нет подтверждённых ящиков. Сначала подключите ящик на странице{' '}
          <a href="/client/mailboxes" className="underline">Мои почты</a>.
        </div>
      ) : (
        <form onSubmit={onSubmit} className="rounded-lg border border-zinc-800 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-zinc-400">Ящик отправки</span>
              <select className={inputCls} value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
                {mailboxes.map((m) => (
                  <option key={m.id} value={m.id}>{m.email}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-zinc-400">Название кампании</span>
              <input className={inputCls} value={campaignName} onChange={(e) => setCampaignName(e.target.value)} placeholder="Напр.: Июнь — производители" />
            </label>
          </div>

          <label className="mt-3 block text-sm">
            <span className="mb-1 block text-zinc-400">Тема</span>
            <input className={inputCls} value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Привет, {{first_name}}!" required />
          </label>

          <label className="mt-3 block text-sm">
            <span className="mb-1 block text-zinc-400">Текст письма</span>
            <textarea className={`${inputCls} min-h-[140px]`} value={bodyText} onChange={(e) => setBodyText(e.target.value)} placeholder={'Здравствуйте, {{first_name}}!\n\n...'} required />
          </label>

          <label className="mt-3 block text-sm">
            <span className="mb-1 block text-zinc-400">
              Получатели — по одному в строке: <span className="text-zinc-500">email, Имя</span>
            </span>
            <textarea className={`${inputCls} min-h-[120px] font-mono text-xs`} value={recipientsText} onChange={(e) => setRecipientsText(e.target.value)} placeholder={'ivan@example.com, Иван\npetr@example.com, Пётр'} />
          </label>
          <p className="mt-1 text-xs text-zinc-500">Распознано получателей: {recipients.length}</p>

          {err && <p className="mt-3 text-sm text-red-400">{err}</p>}
          {ok && <p className="mt-3 text-sm text-emerald-400">{ok}</p>}

          <button
            type="submit"
            disabled={busy || recipients.length === 0}
            className="mt-4 rounded-md bg-zinc-100 px-4 py-2 text-sm font-medium text-zinc-900 disabled:opacity-50"
          >
            {busy ? 'Ставим в очередь…' : `Запустить рассылку (${recipients.length})`}
          </button>
        </form>
      )}

      <h2 className="mt-8 mb-3 text-sm font-semibold text-zinc-300">Статус кампаний</h2>
      {stats.length === 0 ? (
        <p className="text-sm text-zinc-500">Пока пусто.</p>
      ) : (
        <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
          {stats.map((s) => (
            <li key={s.name} className="px-4 py-3 text-sm">
              <div className="font-medium">{s.name}</div>
              <div className="mt-0.5 text-xs text-zinc-500">
                всего {s.total} · <span className="text-emerald-400">отправлено {s.sent}</span> ·{' '}
                <span className="text-amber-400">в очереди {s.pending}</span> ·{' '}
                <span className="text-red-400">ошибок {s.failed}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
