'use client';

import { useState } from 'react';
import { Archive, ArchiveRestore, Loader2, Plus, X } from 'lucide-react';
import { authFetch } from '@/lib/authFetch';
import type { OutreachCampaign } from '@/lib/tgOutreach/types';

const API_BASE = '/api/tools/tg-outreach';

/** Статусы, из которых кампанию можно убрать в архив: ничего не крутится. */
const ARCHIVABLE = new Set(['stopped', 'error']);

function formatDay(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/** Почему кампанию сейчас нельзя убрать в архив; null — можно. */
export function archiveBlockReason(c: OutreachCampaign): string | null {
  if (c.status === 'warming') return 'Идёт прогрев — остановите его';
  if (!ARCHIVABLE.has(c.status)) return 'Сначала остановите кампанию';
  return null;
}

/**
 * Список кампаний TG-аутрича таблицей: «Активные» и «Архив». Клик по строке
 * открывает кампанию. Архив — не удаление: аккаунты, базы и история остаются,
 * кампанию можно вернуть.
 */
export function CampaignList({ campaigns, statusOf, onOpen, onChanged, onCreate }: {
  campaigns: OutreachCampaign[];
  statusOf: (status: string) => { label: string; cls: string };
  onOpen: (id: string) => void;
  onChanged: () => void;
  onCreate: (name: string) => Promise<void>;
}) {
  const [view, setView] = useState<'active' | 'archive'>('active');
  const [archiving, setArchiving] = useState<OutreachCampaign | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);

  const active = campaigns.filter((c) => !c.archived_at);
  const archived = campaigns.filter((c) => c.archived_at);
  const rows = view === 'active' ? active : archived;

  const restore = async (c: OutreachCampaign) => {
    setRestoringId(c.id);
    setError(null);
    const res = await authFetch(`${API_BASE}/campaigns/${c.id}/archive`, { method: 'DELETE' });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      setError(body?.error || `Не удалось вернуть кампанию (${res.status})`);
    }
    setRestoringId(null);
    onChanged();
  };

  const create = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    await onCreate(newName.trim());
    setCreating(false);
    setNewName('');
    setShowCreate(false);
  };

  const tabCls = (on: boolean) =>
    `rounded-full px-4 py-1.5 text-xs font-medium transition cursor-pointer ${on ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white p-1">
          <button type="button" onClick={() => setView('active')} className={tabCls(view === 'active')}>
            Активные · {active.length}
          </button>
          <button type="button" onClick={() => setView('archive')} className={tabCls(view === 'archive')}>
            Архив · {archived.length}
          </button>
        </div>
        <button type="button" onClick={() => setShowCreate((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition cursor-pointer">
          <Plus className="h-3.5 w-3.5" /> Новая кампания
        </button>
      </div>

      {showCreate && (
        <div className="flex items-center gap-2 rounded-lg border border-gray-200 p-3">
          <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Название кампании" autoFocus
            className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs outline-none focus:border-indigo-400"
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
          <button type="button" onClick={() => void create()} disabled={creating}
            className="rounded-full bg-indigo-600 px-5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition disabled:opacity-50 cursor-pointer">
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Создать'}
          </button>
          <button type="button" onClick={() => setShowCreate(false)} className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 cursor-pointer">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} className="text-rose-400 hover:text-rose-600 cursor-pointer">×</button>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-gray-200 bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
            <tr>
              <th className="px-4 py-2.5 font-semibold">Кампания</th>
              <th className="px-4 py-2.5 font-semibold">Статус</th>
              <th className="px-4 py-2.5 font-semibold">Аккаунтов</th>
              {view === 'archive' ? (
                <>
                  <th className="px-4 py-2.5 font-semibold">Причина</th>
                  <th className="px-4 py-2.5 font-semibold">В архиве с</th>
                </>
              ) : (
                <th className="px-4 py-2.5 font-semibold">Создана</th>
              )}
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                  {view === 'active' ? 'Активных кампаний нет.' : 'В архиве пусто.'}
                </td>
              </tr>
            )}
            {rows.map((c) => {
              const st = statusOf(c.status);
              const blocked = archiveBlockReason(c);
              return (
                <tr key={c.id} onClick={() => onOpen(c.id)}
                  // hover:bg-gray-100 — тёмная тема портала перекрашивает её в свой
                  // цвет подсветки (globals.css); indigo-50 давал белёсую плашку.
                  className="cursor-pointer border-b border-gray-100 last:border-0 hover:bg-gray-100">
                  <td className="px-4 py-3 font-semibold text-gray-900">{c.name}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${st.cls}`}>{st.label}</span>
                    {(c.warming_accounts ?? 0) > 0 && c.status !== 'warming' && (
                      <span className="ml-1.5 text-[10px] text-amber-700">греется {c.warming_accounts}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-gray-700">{c.active_accounts ?? 0}</td>
                  {view === 'archive' ? (
                    <>
                      <td className="max-w-xs truncate px-4 py-3 text-gray-600" title={c.archive_reason ?? ''}>{c.archive_reason || '—'}</td>
                      <td className="px-4 py-3 text-gray-500">{formatDay(c.archived_at)}</td>
                    </>
                  ) : (
                    <td className="px-4 py-3 text-gray-500">{formatDay(c.created_at)}</td>
                  )}
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    {view === 'archive' ? (
                      <button type="button" onClick={() => void restore(c)} disabled={restoringId === c.id}
                        className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-3 py-1.5 text-[11px] font-medium text-gray-700 hover:border-indigo-300 hover:text-indigo-700 disabled:opacity-50 cursor-pointer">
                        {restoringId === c.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArchiveRestore className="h-3 w-3" />}
                        Вернуть
                      </button>
                    ) : (
                      <button type="button" onClick={() => setArchiving(c)} disabled={Boolean(blocked)} title={blocked ?? 'Убрать в архив'}
                        className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-3 py-1.5 text-[11px] font-medium text-gray-600 hover:border-amber-300 hover:text-amber-700 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer">
                        <Archive className="h-3 w-3" /> В архив
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {archiving && (
        <ArchiveCampaignDialog
          campaign={archiving}
          onClose={() => setArchiving(null)}
          onDone={() => { setArchiving(null); onChanged(); }}
        />
      )}
    </div>
  );
}

/** Окно архивации: причина обязательна, отказ сервера показываем как есть. */
export function ArchiveCampaignDialog({ campaign, onClose, onDone }: {
  campaign: OutreachCampaign;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (reason.trim().length < 3) {
      setError('Напишите причину — хотя бы пару слов');
      return;
    }
    setSaving(true);
    setError(null);
    const res = await authFetch(`${API_BASE}/campaigns/${campaign.id}/archive`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason.trim() }),
    });
    setSaving(false);
    if (res.ok) {
      onDone();
      return;
    }
    const body = await res.json().catch(() => null) as { error?: string } | null;
    setError(body?.error || `Не удалось убрать в архив (${res.status})`);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md space-y-3 rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-bold text-gray-900">Убрать «{campaign.name}» в архив</h3>
            <p className="mt-1 text-xs text-gray-500">Аккаунты, базы и история сохранятся. Вернуть можно на вкладке «Архив».</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-gray-400 hover:bg-gray-100 cursor-pointer"><X className="h-4 w-4" /></button>
        </div>
        <label className="block space-y-1">
          <span className="block text-[11px] font-medium text-gray-500">Причина</span>
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} autoFocus maxLength={500}
            placeholder="Например: клиент закончил проект, аккаунты перенесены в другую кампанию"
            className="block w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400" />
        </label>
        {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-full px-4 py-2 text-xs font-medium text-gray-600 hover:bg-gray-100 cursor-pointer">Отмена</button>
          <button type="button" onClick={() => void submit()} disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-full bg-amber-600 px-4 py-2 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50 cursor-pointer">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
            В архив
          </button>
        </div>
      </div>
    </div>
  );
}
