'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { logError } from '@/lib/loggerClient';

type LogEntry = {
  id: string;
  created_at: string;
  level: 'info' | 'warn' | 'error';
  source: 'server' | 'client' | 'audit';
  event: string;
  message: string;
  context?: Record<string, unknown> | null;
  user_id?: string | null;
  request_id?: string | null;
  route?: string | null;
  ip?: string | null;
};

const MAX_LOGS = 200;
const INITIAL_LOGS = 100;

const LEVEL_LABELS: Record<LogEntry['level'], string> = {
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

const SOURCE_LABELS: Record<LogEntry['source'], string> = {
  server: 'SERVER',
  client: 'CLIENT',
  audit: 'AUDIT',
};

function formatTimestamp(value: string) {
  try {
    return new Date(value).toLocaleString('ru-RU', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return value;
  }
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value ?? '');
  }
}

function getSearchText(context: LogEntry['context']) {
  if (!context || typeof context !== 'object') return null;
  const value =
    (context as Record<string, unknown>).searchText ??
    (context as Record<string, unknown>).text ??
    (context as Record<string, unknown>).query;
  return typeof value === 'string' ? value : null;
}

type AdminLogsPanelProps = {
  title?: string;
  description?: string;
  eventPrefix?: string;
  routePrefix?: string;
};

export function AdminLogsPanel({
  title = 'Логи приложения',
  description = `Realtime поток логов (последние ${MAX_LOGS})`,
  eventPrefix,
  routePrefix,
}: AdminLogsPanelProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [pending, setPending] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [levelFilter, setLevelFilter] = useState<'all' | LogEntry['level']>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | LogEntry['source']>('all');
  const [search, setSearch] = useState('');

  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const mergeLogs = useCallback((incoming: LogEntry[], existing: LogEntry[]) => {
    const map = new Map<string, LogEntry>();
    for (const log of [...incoming, ...existing]) {
      map.set(log.id, log);
    }
    return Array.from(map.values())
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(0, MAX_LOGS);
  }, []);

  const matchesFilter = useCallback((entry: LogEntry) => {
    if (eventPrefix && !entry.event.startsWith(eventPrefix)) return false;
    if (routePrefix && !(entry.route ?? '').startsWith(routePrefix)) return false;
    return true;
  }, [eventPrefix, routePrefix]);

  const appendLog = useCallback((entry: LogEntry) => {
    if (!matchesFilter(entry)) return;
    setLogs((prev) => mergeLogs([entry], prev));
  }, [mergeLogs, matchesFilter]);

  useEffect(() => {
    let isMounted = true;

    const loadLogs = async () => {
      try {
        setLoading(true);
        let query = supabase
          .from('application_logs')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(INITIAL_LOGS);

        if (eventPrefix) {
          query = query.ilike('event', `${eventPrefix}%`);
        }
        if (routePrefix) {
          query = query.ilike('route', `${routePrefix}%`);
        }

        const { data, error: fetchError } = await query;

        if (fetchError) throw fetchError;
        if (isMounted) {
          const initial = (data as LogEntry[]) ?? [];
          setLogs(initial.filter(matchesFilter));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Не удалось загрузить логи';
        if (isMounted) setError(message);
        void logError('admin.logs.fetch.failed', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    void loadLogs();

    const channel = supabase
      .channel('application_logs')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'application_logs' },
        (payload) => {
          const entry = payload.new as LogEntry;
          if (!matchesFilter(entry)) return;
          if (pausedRef.current) {
            setPending((prev) => mergeLogs([entry], prev));
            return;
          }
          appendLog(entry);
        },
      )
      .subscribe();

    return () => {
      isMounted = false;
      void supabase.removeChannel(channel);
    };
  }, [appendLog, mergeLogs]);

  const resume = () => {
    setLogs((prev) => mergeLogs(pending, prev));
    setPending([]);
    setPaused(false);
  };

  const filteredLogs = useMemo(() => {
    const term = search.trim().toLowerCase();
    return logs.filter((log) => {
      if (levelFilter !== 'all' && log.level !== levelFilter) return false;
      if (sourceFilter !== 'all' && log.source !== sourceFilter) return false;
      if (!term) return true;
      return (
        log.event.toLowerCase().includes(term) ||
        log.message.toLowerCase().includes(term) ||
        log.route?.toLowerCase().includes(term) ||
        log.user_id?.toLowerCase().includes(term)
      );
    });
  }, [logs, levelFilter, sourceFilter, search]);

  return (
    <div className="bg-white p-7 rounded-xl border border-gray-200 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">{title}</h2>
          <p className="text-base text-gray-500">{description}</p>
        </div>
        <div className="flex items-center gap-2">
          {paused ? (
            <button
              onClick={resume}
              className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Возобновить{pending.length > 0 ? ` (${pending.length})` : ''}
            </button>
          ) : (
            <button
              onClick={() => setPaused(true)}
              className="rounded-md bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
            >
              Пауза
            </button>
          )}
          <button
            onClick={() => { setLogs([]); setPending([]); }}
            className="rounded-md bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
          >
            Очистить
          </button>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <select
          value={levelFilter}
          onChange={(e) => setLevelFilter(e.target.value as 'all' | LogEntry['level'])}
          className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700"
        >
          <option value="all">Все уровни</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value as 'all' | LogEntry['source'])}
          className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700"
        >
          <option value="all">Все источники</option>
          <option value="server">Server</option>
          <option value="client">Client</option>
          <option value="audit">Audit</option>
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по событию, сообщению, маршруту..."
          className="flex-1 min-w-[220px] rounded-md border border-gray-200 px-3 py-2 text-sm text-gray-700"
        />
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="mt-6 text-base text-gray-500">Загрузка логов...</div>
      ) : (
        <div className="mt-6 max-h-[520px] overflow-auto rounded-lg border border-gray-200">
          {filteredLogs.length === 0 ? (
            <div className="p-4 text-base text-gray-500">Логи не найдены</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {filteredLogs.map((log) => (
                <div key={log.id} className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2 text-sm text-gray-500">
                        <span>{formatTimestamp(log.created_at)}</span>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                          log.level === 'error'
                            ? 'bg-red-100 text-red-700'
                            : log.level === 'warn'
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-emerald-100 text-emerald-700'
                        }`}>
                          {LEVEL_LABELS[log.level]}
                        </span>
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-700">
                          {SOURCE_LABELS[log.source]}
                        </span>
                        {log.route && <span className="text-xs text-gray-400">{log.route}</span>}
                      </div>
                      {getSearchText(log.context) ? (
                        <div className="mt-1 text-sm text-gray-500">
                          Запрос: <span className="font-semibold text-gray-700">{getSearchText(log.context)}</span>
                        </div>
                      ) : null}
                      <div className="mt-1 text-base font-semibold text-gray-900">{log.event}</div>
                      <div className="mt-1 text-base text-gray-700 break-words">{log.message}</div>
                    </div>
                    <details className="shrink-0 text-sm text-gray-500">
                      <summary className="cursor-pointer select-none">Детали</summary>
                      <div className="mt-2 space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
                        {log.user_id && (
                          <div><span className="font-semibold">user_id:</span> {log.user_id}</div>
                        )}
                        {log.request_id && (
                          <div><span className="font-semibold">request_id:</span> {log.request_id}</div>
                        )}
                        {log.ip && (
                          <div><span className="font-semibold">ip:</span> {log.ip}</div>
                        )}
                        {log.context && (
                          <pre className="whitespace-pre-wrap break-words text-sm">{safeJson(log.context)}</pre>
                        )}
                      </div>
                    </details>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
