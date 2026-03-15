'use client';

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Bot, Play, Square, FileText, RefreshCw, X } from 'lucide-react';
import type { BotListItem } from '@/app/api/admin/bots/route';

const STATUS_LABELS: Record<string, string> = {
  running: 'Работает',
  exited: 'Остановлен',
  paused: 'Приостановлен',
  unknown: 'Неизвестно',
  'in-app': 'В работе (в портале)',
};

const STATUS_CLASSES: Record<string, string> = {
  running: 'bg-emerald-100 text-emerald-800',
  exited: 'bg-gray-200 text-gray-700',
  paused: 'bg-amber-100 text-amber-800',
  unknown: 'bg-gray-100 text-gray-600',
  'in-app': 'bg-blue-100 text-blue-800',
};

export function AdminBotManagerPanel() {
  const [bots, setBots] = useState<BotListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dockerAvailable, setDockerAvailable] = useState(false);
  const [dockerError, setDockerError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [logsBotId, setLogsBotId] = useState<string | null>(null);
  const [logsContent, setLogsContent] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);

  const fetchBots = useCallback(async () => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch('/api/admin/bots', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j?.error ?? res.statusText);
      }
      const data = await res.json();
      setBots(data.bots ?? []);
      setDockerAvailable(data.dockerAvailable ?? false);
      setDockerError(data.dockerError ?? data.dockerUnavailableReason ?? null);
    } catch (e) {
      setBots([]);
      setDockerError(e instanceof Error ? e.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBots();
  }, [fetchBots]);

  const runAction = useCallback(
    async (botId: string, action: 'stop' | 'start') => {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) return;
      setActionLoading(botId);
      try {
        const res = await fetch(`/api/admin/bots/${botId}/${action}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(j?.error ?? res.statusText);
        await fetchBots();
      } catch (e) {
        alert(e instanceof Error ? e.message : 'Ошибка');
      } finally {
        setActionLoading(null);
      }
    },
    [fetchBots]
  );

  const openLogs = useCallback(
    async (botId: string) => {
      setLogsBotId(botId);
      setLogsContent('');
      setLogsLoading(true);
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setLogsLoading(false);
        return;
      }
      try {
        const res = await fetch(`/api/admin/bots/${botId}/logs?tail=2000`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) {
          setLogsContent(`Ошибка: ${j?.error ?? res.statusText}`);
          return;
        }
        setLogsContent(j.logs ?? '');
      } catch (e) {
        setLogsContent(e instanceof Error ? e.message : 'Ошибка загрузки логов');
      } finally {
        setLogsLoading(false);
      }
    },
    []
  );

  const botName = (id: string) => bots.find((b) => b.id === id)?.name ?? id;
  const actionHint = (bot: BotListItem, action: 'stop' | 'start') => {
    if (bot.kind !== 'container') {
      if (action === 'stop' && bot.status !== 'running' && bot.status !== 'in-app') {
        return 'Бот уже остановлен';
      }
      if (action === 'start' && bot.status === 'running') {
        return 'Бот уже запущен';
      }
      return '';
    }
    if (!dockerAvailable) return 'Недоступно: нет доступа к Docker';
    if (action === 'stop') {
      if (bot.status !== 'running') return 'Можно остановить только работающий контейнер';
      return '';
    }
    if (bot.status !== 'exited' && bot.status !== 'paused') {
      return 'Можно запустить только остановленный или приостановленный контейнер';
    }
    return '';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-gray-500">
        <RefreshCw className="h-6 w-6 animate-spin mr-2" />
        Загрузка…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {!dockerAvailable && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-6 py-4 text-sm text-amber-800">
          Docker недоступен (нет доступа к сокету). Управление контейнерами и логи контейнеров будут недоступны до настройки доступа к Docker на сервере.
          {dockerError && <span className="block mt-2 text-amber-700">{dockerError}</span>}
        </div>
      )}

      <div className="grid gap-5 sm:grid-cols-1 lg:grid-cols-2">
        {bots.map((bot) => (
          <div
            key={bot.id}
            className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3">
                  <Bot className="h-5 w-5 text-gray-500 flex-shrink-0" />
                  <h3 className="font-semibold text-gray-900 truncate">{bot.name}</h3>
                </div>
                <p className="mt-3 text-sm text-gray-500">{bot.description}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASSES[bot.status] ?? STATUS_CLASSES.unknown}`}
                  >
                    {STATUS_LABELS[bot.status] ?? bot.status}
                  </span>
                  {bot.statusDetail && bot.kind === 'container' && (
                    <span className="text-xs text-gray-400 truncate max-w-[200px]" title={bot.statusDetail}>
                      {bot.statusDetail}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => runAction(bot.id, 'stop')}
                disabled={actionLoading === bot.id || !bot.canStop}
                title={actionHint(bot, 'stop')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                {actionLoading === bot.id ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Square className="h-4 w-4" />
                )}
                Остановить
              </button>
              <button
                type="button"
                onClick={() => runAction(bot.id, 'start')}
                disabled={actionLoading === bot.id || !bot.canStart}
                title={actionHint(bot, 'start')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-white px-3 py-1.5 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
              >
                {actionLoading === bot.id ? (
                  <RefreshCw className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                Запустить
              </button>
              {bot.canLogs && (
                <button
                  type="button"
                  onClick={() => openLogs(bot.id)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  <FileText className="h-4 w-4" />
                  Логи
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Logs modal */}
      {logsBotId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setLogsBotId(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Логи бота"
        >
          <div
            className="max-h-[85vh] w-full max-w-4xl rounded-xl bg-white shadow-xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
              <h3 className="font-semibold text-gray-900">Логи: {botName(logsBotId)}</h3>
              <button
                type="button"
                onClick={() => setLogsBotId(null)}
                className="rounded-lg p-2.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                aria-label="Закрыть"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-auto p-6">
              {logsLoading ? (
                <div className="flex items-center gap-2 text-gray-500 py-2">
                  <RefreshCw className="h-5 w-5 animate-spin" />
                  Загрузка логов…
                </div>
              ) : (
                <pre className="whitespace-pre-wrap break-words font-mono text-sm text-gray-800 bg-gray-50 rounded-lg p-5 max-h-[70vh] overflow-auto">
                  {logsContent || '(пусто)'}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
