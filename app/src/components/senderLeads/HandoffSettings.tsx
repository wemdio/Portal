'use client';

import { useCallback, useEffect, useState } from 'react';
import { authFetchJson } from '@/lib/authFetch';
import type { AgencyHandoffSettings, HandoffScope } from '@/lib/agencyLeadHandoff/settings';

interface ManualStatus { status: string; error: string | null; sent_at: string | null; updated_at: string }
interface HistoryRow {
  id: string; scope: HandoffScope; lead_email: string; status: string; error: string | null;
  body: string | null; cc_emails: string[] | null; created_at: string; updated_at: string;
  sender_manual_messages: ManualStatus | ManualStatus[] | null;
}
const API = '/api/tools/agency-lead-handoff';
const LABELS: Record<HandoffScope, string> = {
  auto_ru: 'Автоаутрич RU', auto_en: 'Автоаутрич EN', own_ru: 'Email-аутрич RU · Polza', own_en: 'Email-аутрич EN · ENagency',
};
const STATUS: Record<string, string> = {
  pending: 'готовится', queued: 'в очереди отправки', sending: 'отправляется', sent: 'отправлено',
  failed: 'ошибка', unknown: 'отправка не подтверждена, проверьте исходящие', skipped: 'пропущено',
};
const addresses = (s: string) => s.split(/[,;\s]+/).map(v => v.trim()).filter(Boolean);

function SettingsForm({ value, reload }: { value: AgencyHandoffSettings; reload: () => Promise<void> }) {
  const [form, setForm] = useState(value);
  const [cc, setCc] = useState(value.cc_emails.join(', '));
  const [self, setSelf] = useState(value.self_sender_emails.join(', '));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const save = async () => {
    setBusy(true); setMessage('');
    try {
      await authFetchJson(API, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, cc_emails: addresses(cc), self_sender_emails: addresses(self) }) });
      await reload(); setMessage('Сохранено');
    } catch (err) { setMessage(err instanceof Error ? err.message : 'Не удалось сохранить'); }
    finally { setBusy(false); }
  };
  const field = 'mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm';
  return <div className="space-y-3 rounded-lg border border-zinc-200 p-4">
    <h3 className="font-medium">{LABELS[value.scope]}</h3>
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />
      Автоматически отвечать новым лидам после передачи в Telegram
    </label>
    <label className="block text-sm">Почта ответственного в копии (можно несколько через запятую)
      <input value={cc} onChange={e => setCc(e.target.value)} className={field} placeholder="name@company.ru" />
    </label>
    <label className="block text-sm">Ответ при передаче коллеге
      <textarea value={form.colleague_text} onChange={e => setForm({ ...form, colleague_text: e.target.value })} maxLength={3000} rows={3} className={field} />
    </label>
    <label className="block text-sm">Ящики, которые пишут от лица самого ответственного
      <textarea value={self} onChange={e => setSelf(e.target.value)} rows={2} className={field} placeholder="Ящики Юли, если в копии её основная почта" />
    </label>
    <label className="block text-sm">Ответ с этих ящиков
      <textarea value={form.self_text} onChange={e => setForm({ ...form, self_text: e.target.value })} maxLength={3000} rows={3} className={field} />
    </label>
    <p className="text-xs text-zinc-500">Текст отправляется дословно. Укажите имя коллеги в тексте, если нужно. Письмо уйдёт с прежнего ящика, в копии будет ответственный, под ответом будет переписка.</p>
    <button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50">{busy ? 'Сохраняю…' : 'Сохранить передачу'}</button>
    {message && <p role="status" className="text-sm">{message}</p>}
  </div>;
}

export function HandoffSettings({ folderKey }: { folderKey: string }) {
  const [data, setData] = useState<{ settings: AgencyHandoffSettings[]; history: HistoryRow[] } | null>(null);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState(0);
  const load = useCallback(async () => {
    try { setData(await authFetchJson(API)); setError(''); setCheckedAt(Date.now()); }
    catch (err) { setError(err instanceof Error ? err.message : 'Не удалось загрузить передачу'); }
  }, []);
  useEffect(() => {
    let cancelled = false;
    authFetchJson<{ settings: AgencyHandoffSettings[]; history: HistoryRow[] }>(API)
      .then(value => { if (!cancelled) { setData(value); setCheckedAt(Date.now()); } })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Не удалось загрузить передачу'); });
    return () => { cancelled = true; };
  }, []);
  const en = folderKey === 'auto_en';
  const scopes = new Set([en ? 'auto_en' : 'auto_ru', en ? 'own_en' : 'own_ru']);
  return <section className="space-y-3 rounded-xl border border-zinc-200 bg-white p-5">
    <h2 className="text-base font-semibold">Ответ лиду и передача по email</h2>
    <p className="text-sm text-zinc-500">Отправляется один раз после квалификации и доставки лида в чат. При включении старые лиды не получают писем. После отключения новые передачи не отправляются.</p>
    {error && <p className="text-sm text-red-600">{error}</p>}
    {data?.settings.filter(s => scopes.has(s.scope)).map(s => <SettingsForm key={s.scope} value={s} reload={load} />)}
    <div className="flex items-center justify-between"><h3 className="text-sm font-medium">Последние передачи</h3>
      <button type="button" onClick={() => void load()} className="text-sm text-blue-600">Обновить</button></div>
    {data?.history.filter(r => scopes.has(r.scope)).map(row => {
      const manual = Array.isArray(row.sender_manual_messages) ? row.sender_manual_messages[0] : row.sender_manual_messages;
      const rawStatus = manual?.status ?? row.status;
      const stale = rawStatus === 'sending' && checkedAt - Date.parse(manual?.updated_at ?? row.updated_at) > 10 * 60_000;
      const status = stale ? 'unknown' : rawStatus;
      return <div key={row.id} className="border-t border-zinc-100 pt-2 text-sm">
        <p>{row.lead_email} · {LABELS[row.scope]} · {STATUS[status] || status}</p>
        {(manual?.error || row.error) && <p className="text-xs text-red-600">{manual?.error || row.error}</p>}
        {row.cc_emails?.length ? <p className="text-xs text-zinc-500">Копия: {row.cc_emails.join(', ')}</p> : null}
        {row.body && <details className="mt-1 text-xs"><summary className="cursor-pointer">Текст ответа</summary><p className="whitespace-pre-wrap">{row.body}</p></details>}
      </div>;
    })}
  </section>;
}
