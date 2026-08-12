'use client';

/**
 * Список публичных чатов — секция внутри настроек прогрева.
 *
 * Раньше это была отдельная вкладка кампании. Разносить список чатов и числа,
 * управляющие активностью в этих чатах, по разным экранам незачем: оператор
 * настраивает одно и то же.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { AlertCircle, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { CampaignStatus } from '@/lib/tgOutreach/types';
import type { WarmupChat } from '@/lib/tgOutreach/warmup/types';

const API_BASE = '/api/tools/tg-outreach';

interface ChatRow extends WarmupChat {
  joined_accounts: number;
  forbidden_accounts: number;
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  pending: { text: 'не проверен', cls: 'bg-gray-100 text-gray-500' },
  resolved: { text: 'готов', cls: 'bg-emerald-50 text-emerald-700' },
  unresolvable: { text: 'не подошёл', cls: 'bg-rose-50 text-rose-700' },
};

export default function WarmupChatsSection({
  campaignId,
  campaignStatus,
  onChanged,
}: {
  campaignId: string;
  campaignStatus: CampaignStatus;
  /** Дёргается после любого изменения списка: снаружи от него зависят счётчики. */
  onChanged?: () => void;
}) {
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [bulkText, setBulkText] = useState('');
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Проверка чатов занимает аккаунт кампании, поэтому доступна только на
  // остановленной — то же правило, что у чтения профиля.
  const canCheck = campaignStatus === 'stopped' || campaignStatus === 'error';

  const load = useCallback(async () => {
    const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/chats`);
    if (!res.ok) return;
    const data = await res.json();
    setChats((data.items ?? []) as ChatRow[]);
  }, [campaignId]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  const reload = async () => {
    await load();
    onChanged?.();
  };

  const addChats = async () => {
    const links = bulkText.split(/[\n,;\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!links.length) return;
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/chats`, {
        method: 'POST',
        body: JSON.stringify({ links }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Не получилось добавить');
        return;
      }
      setBulkText('');
      const rejected = (data.rejected ?? []) as string[];
      setNotice(
        rejected.length
          ? `Добавлено ${data.added}. Не подошли (закрытые чаты и мусор): ${rejected.slice(0, 3).join(', ')}${rejected.length > 3 ? ` и ещё ${rejected.length - 3}` : ''}`
          : `Добавлено ${data.added}. Нажмите «Проверить», чтобы портал узнал названия.`,
      );
      await reload();
    } finally {
      setAdding(false);
    }
  };

  const checkChats = async () => {
    setChecking(true);
    setError(null);
    setNotice(null);
    try {
      const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/chats/check`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? 'Не получилось проверить');
        return;
      }
      setNotice(`Проверено ${data.checked}, подошло ${data.resolved}.`);
      await reload();
    } finally {
      setChecking(false);
    }
  };

  const toggleActive = async (chat: ChatRow) => {
    await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/chats/${chat.id}`, {
      method: 'PUT',
      body: JSON.stringify({ is_active: !chat.is_active }),
    });
    await reload();
  };

  const removeChat = async (chat: ChatRow) => {
    if (!confirm(`Убрать «${chat.title ?? chat.link}» из списка? Аккаунты из самого чата не выйдут.`)) return;
    await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/chats/${chat.id}`, {
      method: 'DELETE',
    });
    await reload();
  };

  const usable = chats.filter((c) => c.status === 'resolved' && c.is_active).length;
  const unchecked = chats.filter((c) => c.status === 'pending').length;

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-[11px] text-gray-500">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Загружаю чаты…
      </div>
    );
  }

  return (
    <div className="space-y-2.5 rounded-xl bg-gray-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-gray-600">
          Чаты <span className="text-gray-400">
            {usable} готов{usable === 1 ? '' : 'ы'}
            {unchecked > 0 ? ` · ${unchecked} не проверен${unchecked === 1 ? '' : 'о'}` : ''}
          </span>
        </span>
        <button
          type="button"
          disabled={!canCheck || checking || !chats.length}
          onClick={() => { void checkChats(); }}
          title={canCheck ? 'Узнать названия чатов и отсеять неподходящие' : 'Сначала остановите кампанию'}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-700 transition hover:border-indigo-300 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {checking ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          {checking ? 'Проверяю…' : 'Проверить'}
        </button>
      </div>

      {usable === 1 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            В списке один рабочий чат — все аккаунты окажутся в нём. Это заметный след: по одному
            спалившемуся аккаунту находятся остальные. Лучше добавить хотя бы три-четыре.
          </span>
        </div>
      )}

      {chats.length > 0 && (
        <div className="divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-200 bg-white">
          {chats.map((chat) => {
            const badge = STATUS_LABEL[chat.status] ?? STATUS_LABEL.pending;
            return (
              <div
                key={chat.id}
                className={`grid grid-cols-[1fr_92px_86px_32px] items-center gap-2 px-2.5 py-1.5 ${chat.is_active ? '' : 'opacity-50'}`}
              >
                <div className="min-w-0">
                  <div className="truncate text-[11px] text-gray-800">{chat.title ?? chat.link}</div>
                  <div className="truncate text-[10px] text-gray-400">
                    {chat.link}
                    {chat.participants_count ? ` · ${chat.participants_count.toLocaleString('ru-RU')}` : ''}
                    {chat.error_reason ? ` · ${chat.error_reason}` : ''}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => { void toggleActive(chat); }}
                  title={chat.is_active ? 'Выключить чат' : 'Включить чат'}
                  className={`w-fit cursor-pointer rounded px-1.5 py-0.5 text-[10px] transition hover:opacity-80 ${badge.cls}`}
                >
                  {chat.is_active ? badge.text : 'выключен'}
                </button>
                <span className="text-[10px] text-gray-500">
                  {chat.joined_accounts > 0 ? `${chat.joined_accounts} вступило` : '—'}
                  {chat.forbidden_accounts > 0 && (
                    <span className="text-amber-600"> · {chat.forbidden_accounts} запрет</span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => { void removeChat(chat); }}
                  title="Убрать из списка"
                  className="cursor-pointer rounded p-1 text-gray-400 transition hover:bg-rose-50 hover:text-rose-600"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <textarea
        value={bulkText}
        onChange={(e) => setBulkText(e.target.value)}
        rows={2}
        placeholder={'t.me/chat_name\n@another_chat'}
        className="block w-full resize-y rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 font-mono text-[11px] outline-none focus:border-indigo-400"
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => { void addChats(); }}
          disabled={adding || !bulkText.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-[11px] font-medium text-white transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {adding ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          Добавить
        </button>
        <span className="text-[10px] text-gray-400">Закрытые чаты по приглашениям не поддерживаются</span>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1.5 text-[11px] text-rose-700">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] text-gray-600">{notice}</div>
      )}
    </div>
  );
}
