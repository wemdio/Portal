'use client';

/**
 * Вкладка «Прогрев» — всё на одном экране.
 *
 * Раскладка согласована с заказчиком: полоса управления → метрики →
 * аккаунты слева и переписки справа → логи снизу. Выбор аккаунта слева
 * фильтрует одновременно переписки и логи, чтобы не прыгать между вкладками
 * «Диалоги» и «Логи»: общий поток из шестнадцати аккаунтов нечитаем, а
 * «что было у этого номера» — ровно тот вопрос, который возникает.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import {
  Play,
  Square,
  Loader2,
  ChevronRight,
  ChevronDown,
  AlertCircle,
  Download,
} from 'lucide-react';
import type { CampaignStatus, OutreachAccount } from '@/lib/tgOutreach/types';
import type {
  WarmupActivity,
  WarmupChat,
  WarmupConversation,
  WarmupLog,
  WarmupRun,
} from '@/lib/tgOutreach/warmup/types';

const API_BASE = '/api/tools/tg-outreach';

interface PerAccountStat {
  account_id: string;
  done: number;
  failed: number;
  /** Сорвавшиеся переписки, где виноват именно этот аккаунт (а не собеседник). */
  failed_own?: number;
  planned: number;
  done_today: number;
  planned_today: number;
  last_error: string | null;
  last_error_at?: string | null;
}

interface ChatStageStatus {
  enabled: boolean;
  replies_today: number;
  reactions_today: number;
  replies_total: number;
  reactions_total: number;
  planned_today: number;
}

interface WarmupStatus {
  run: WarmupRun | null;
  per_account: PerAccountStat[];
  per_day?: Array<{ day: number; planned: number; done: number }>;
  today: { planned: number; done: number } | null;
  messages_total?: number;
  chat_stage?: ChatStageStatus;
  defaults: { default_days: number };
}

function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

/** «6 августа», «5 августа» — заголовок группы записей журнала. */
function dayKey(iso: string) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

/** «вчера 21:53» — когда именно у аккаунта был последний сбой. */
function whenOf(iso: string) {
  const d = new Date(iso);
  const today = dayKey(new Date().toISOString());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000).toISOString());
  const key = dayKey(iso);
  const prefix = key === today ? '' : key === yesterday ? 'вчера ' : `${key} `;
  return `${prefix}${timeOf(d.toISOString())}`;
}

const RUN_LABEL: Record<string, string> = {
  pending: 'запускается',
  running: 'идёт',
  finished: 'завершён',
  stopped: 'остановлен',
  failed: 'сорвался',
};

// Флага «своя/чужая кампания» здесь больше нет: 20260807_0004 открыла запись
// в кампанию любому сотруднику, аутрич ведут несколько человек.
export default function WarmupTab({
  campaignId,
  campaignStatus,
}: {
  campaignId: string;
  campaignStatus: CampaignStatus;
}) {
  const [status, setStatus] = useState<WarmupStatus | null>(null);
  const [accounts, setAccounts] = useState<OutreachAccount[]>([]);
  const [conversations, setConversations] = useState<WarmupConversation[]>([]);
  const [logs, setLogs] = useState<WarmupLog[]>([]);
  const [logsHasMore, setLogsHasMore] = useState(false);
  const [logsLoadingMore, setLogsLoadingMore] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [expandedConvId, setExpandedConvId] = useState<number | null>(null);
  const [days, setDays] = useState(4);
  const [publicChats, setPublicChats] = useState(false);
  const [chats, setChats] = useState<WarmupChat[]>([]);
  const [activities, setActivities] = useState<WarmupActivity[]>([]);
  /** Что показывать в правой панели: переписки между своими или чаты. */
  const [rightPanel, setRightPanel] = useState<'conversations' | 'activities'>('conversations');
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [allAccountsLogs, setAllAccountsLogs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup`);
    if (!res.ok) return;
    const data = (await res.json()) as WarmupStatus;
    setStatus(data);
    if (data.run) setDays(data.run.days);
    else if (data.defaults?.default_days) setDays(data.defaults.default_days);
  }, [campaignId]);

  const loadAccounts = useCallback(async () => {
    const res = await authFetch(`${API_BASE}/accounts?campaign_id=${campaignId}`);
    if (!res.ok) return;
    const data = await res.json();
    setAccounts((Array.isArray(data) ? data : data.items ?? []) as OutreachAccount[]);
  }, [campaignId]);

  // Чаты нужны и для галочки (без проверенных её незачем включать), и для
  // подписей в ленте активностей.
  const loadChats = useCallback(async () => {
    const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/chats`);
    if (!res.ok) return;
    const data = await res.json();
    setChats((data.items ?? []) as WarmupChat[]);
  }, [campaignId]);

  const loadActivities = useCallback(async () => {
    const qs = selectedAccountId ? `?account_id=${selectedAccountId}` : '';
    const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/activities${qs}`);
    if (!res.ok) return;
    const data = await res.json();
    setActivities((data.items ?? []) as WarmupActivity[]);
  }, [campaignId, selectedAccountId]);

  const loadConversations = useCallback(async () => {
    const qs = selectedAccountId ? `?account_id=${selectedAccountId}` : '';
    const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/conversations${qs}`);
    if (!res.ok) return;
    const data = await res.json();
    setConversations((data.items ?? []) as WarmupConversation[]);
  }, [campaignId, selectedAccountId]);

  const LOGS_PAGE = 300;

  /**
   * Выгрузка логов за весь период.
   *
   * Обычной ссылкой не обойтись: роут требует токен в заголовке, а <a download>
   * его не отправит. Поэтому тянем ответ как blob и отдаём браузеру ссылку на
   * него; имя файла берём из Content-Disposition, которое сформировал сервер.
   */
  const exportLogs = useCallback(async () => {
    setExporting(true);
    try {
      const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/logs/export`);
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        alert(d?.error ?? `Не удалось выгрузить логи (${res.status})`);
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
      const plain = /filename="([^"]+)"/i.exec(disposition);
      const name = utf8 ? decodeURIComponent(utf8[1]) : (plain?.[1] ?? 'tg-warmup-logs.txt');

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, [campaignId]);

  const loadLogs = useCallback(async () => {
    const params = new URLSearchParams({ limit: String(LOGS_PAGE) });
    if (selectedAccountId && !allAccountsLogs) params.set('account_id', selectedAccountId);
    if (errorsOnly) params.set('errors_only', '1');
    const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/logs?${params}`);
    if (!res.ok) return;
    const data = await res.json();
    setLogs((data.items ?? []) as WarmupLog[]);
    setLogsHasMore(Boolean(data.has_more));
  }, [campaignId, selectedAccountId, allAccountsLogs, errorsOnly]);

  /**
   * Автообновление журнала: доливаем только новые записи сверху, не сбрасывая
   * уже подгруженную историю — иначе каждые 10 секунд «Показать ещё» откатывался
   * бы к первой странице прямо под руками у оператора.
   */
  const refreshLogs = useCallback(async () => {
    const params = new URLSearchParams({ limit: String(LOGS_PAGE) });
    if (selectedAccountId && !allAccountsLogs) params.set('account_id', selectedAccountId);
    if (errorsOnly) params.set('errors_only', '1');
    const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/logs?${params}`);
    if (!res.ok) return;
    const data = await res.json();
    const fresh = (data.items ?? []) as WarmupLog[];
    setLogs((prev) => {
      if (!prev.length) return fresh;
      const seen = new Set(prev.map((l) => l.id));
      const added = fresh.filter((l) => !seen.has(l.id));
      return added.length ? [...added, ...prev] : prev;
    });
  }, [campaignId, selectedAccountId, allAccountsLogs, errorsOnly]);

  /**
   * Подгрузить страницу постарше. Прогрев идёт несколько суток, а с записью
   * каждой отправки одна страница не покрывает даже вчерашний день — «что было
   * в первый день» иначе не посмотреть.
   */
  const loadOlderLogs = useCallback(async () => {
    const oldest = logs[logs.length - 1];
    if (!oldest) return;
    setLogsLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: String(LOGS_PAGE), before_id: String(oldest.id) });
      if (selectedAccountId && !allAccountsLogs) params.set('account_id', selectedAccountId);
      if (errorsOnly) params.set('errors_only', '1');
      const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup/logs?${params}`);
      if (!res.ok) return;
      const data = await res.json();
      setLogs((prev) => [...prev, ...((data.items ?? []) as WarmupLog[])]);
      setLogsHasMore(Boolean(data.has_more));
    } finally {
      setLogsLoadingMore(false);
    }
  }, [campaignId, logs, selectedAccountId, allAccountsLogs, errorsOnly]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await Promise.all([loadStatus(), loadAccounts(), loadChats()]);
      setLoading(false);
    })();
  }, [loadStatus, loadAccounts, loadChats]);

  useEffect(() => {
    void (async () => { await loadConversations(); })();
  }, [loadConversations]);

  useEffect(() => {
    void (async () => { await loadActivities(); })();
  }, [loadActivities]);

  useEffect(() => {
    void (async () => { await loadLogs(); })();
  }, [loadLogs]);

  // Пока прогрев идёт, состояние обновляется само: оператор открывает вкладку
  // именно чтобы следить, а не чтобы жать «обновить».
  useEffect(() => {
    if (status?.run?.status !== 'running') return;
    const t = setInterval(() => {
      void loadStatus();
      void loadConversations();
      void loadActivities();
      void refreshLogs();
    }, 10_000);
    return () => clearInterval(t);
  }, [status?.run?.status, loadStatus, loadConversations, loadActivities, refreshLogs]);

  const act = async (method: 'POST' | 'DELETE') => {
    setBusy(true);
    setError(null);
    try {
      const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/warmup`, {
        method,
        ...(method === 'POST'
          ? {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ days, public_chats: publicChats }),
            }
          : {}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? 'Не получилось');
      }
      await loadStatus();
      await loadConversations();
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-xs text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Загружаю прогрев…
      </div>
    );
  }

  const run = status?.run ?? null;
  const isRunning = run?.status === 'running' || run?.status === 'pending';
  const statByAccount = new Map((status?.per_account ?? []).map((s) => [s.account_id, s]));
  const accountName = (id: string) =>
    accounts.find((a) => a.id === id)?.session_name ?? id.slice(0, 8);
  const problemAccounts = (status?.per_account ?? []).filter((s) => (s.failed_own ?? 0) > 0).length;
  const chatById = new Map(chats.map((c) => [c.id, c]));
  const usableChats = chats.filter((c) => c.status === 'resolved' && c.is_active).length;
  const chatStage = status?.chat_stage;
  // Этап показываем, если он включён в текущем прогоне либо если прогрев ещё не
  // запускали, но чаты уже готовы — оператору надо видеть, что галочка живая.
  const chatStageVisible = Boolean(chatStage?.enabled) || (!run && usableChats > 0);
  // Прогрев и боевой аутрич взаимоисключающие — на запущенной кампании кнопка
  // всё равно получит отказ от сервера, поэтому предупреждаем заранее.
  const blockedByCampaign = campaignStatus === 'running' || campaignStatus === 'paused';

  return (
    <div className="space-y-3 p-4">
      {blockedByCampaign && !isRunning && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-800">
          <AlertCircle className="mt-px h-4 w-4 shrink-0" />
          <span>
            <span className="font-medium">Кампания сейчас работает по боевым лидам.</span>{' '}
            Прогрев можно запустить только на остановленной кампании: аккаунт не может
            одновременно греться и писать клиентам. Остановите кампанию кнопкой сверху.
          </span>
        </div>
      )}

      {/* Полоса управления */}
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[180px] flex-1">
            <div className="text-sm font-medium text-gray-800">
              {run
                ? run.status === 'running'
                  ? `Прогрев идёт — день ${run.current_day} из ${run.days}`
                  : `Прогрев ${RUN_LABEL[run.status] ?? run.status}`
                : 'Прогрев не запускался'}
            </div>
            <div className="mt-0.5 text-[11px] text-gray-500">
              {run?.started_at
                ? `Начат ${new Date(run.started_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
                : 'Аккаунты переписываются между собой, наращивая нагрузку'}
              {run?.error_message ? ` · ${run.error_message}` : ''}
            </div>
          </div>
          <label className="flex items-center gap-2 text-[11px] text-gray-500">
            Дней
            <input
              type="number"
              min={1}
              max={14}
              value={days}
              disabled={isRunning}
              onChange={(e) => setDays(Number(e.target.value))}
              className="w-16 rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-800 outline-none focus:border-indigo-400 disabled:opacity-50"
            />
          </label>

          {/* Необязательный этап. Без проверенных чатов включать нечего —
              блокируем с объяснением, а не молча. */}
          <label
            title={
              usableChats
                ? 'Аккаунты вступят в чаты из вкладки «Чаты» и будут понемногу отвечать людям'
                : 'Сначала добавьте и проверьте чаты во вкладке «Чаты»'
            }
            className={`flex items-center gap-2 text-[11px] ${usableChats && !isRunning ? 'cursor-pointer text-gray-600' : 'cursor-not-allowed text-gray-400'}`}
          >
            <input
              type="checkbox"
              checked={isRunning ? Boolean(chatStage?.enabled) : publicChats}
              disabled={isRunning || !usableChats}
              onChange={(e) => setPublicChats(e.target.checked)}
              className="h-3.5 w-3.5 accent-indigo-600"
            />
            Активность в чатах
            {usableChats > 0 && <span className="text-gray-400">({usableChats})</span>}
          </label>
          {isRunning ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act('DELETE')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-medium text-rose-700 transition hover:bg-rose-100 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
              Остановить
            </button>
          ) : (
            <button
              type="button"
              disabled={busy || blockedByCampaign}
              title={blockedByCampaign ? 'Сначала остановите кампанию' : undefined}
              onClick={() => void act('POST')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-medium text-indigo-700 transition hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Начать прогрев
            </button>
          )}
        </div>

        {run && (
          <>
            <div className="mt-3 flex gap-1">
              {Array.from({ length: run.days }, (_, i) => i + 1).map((d) => {
                const dayStat = status?.per_day?.find((x) => x.day === d);
                const passed = d < run.current_day || run.status === 'finished';
                return (
                  <div
                    key={d}
                    title={dayStat ? `День ${d}: ${dayStat.done} из ${dayStat.planned}` : `День ${d}`}
                    className={`h-1.5 flex-1 rounded-full ${
                      passed ? 'bg-emerald-500' : d === run.current_day ? 'bg-indigo-400' : 'bg-gray-200'
                    }`}
                  />
                );
              })}
            </div>
            <div className="mt-1.5 flex justify-between text-[10px] text-gray-400">
              {Array.from({ length: run.days }, (_, i) => i + 1).map((d) => {
                const dayStat = status?.per_day?.find((x) => x.day === d);
                return (
                  <span key={d}>
                    день {d}
                    {dayStat ? ` · ${dayStat.done}/${dayStat.planned}` : ''}
                  </span>
                );
              })}
            </div>
          </>
        )}

        {error && (
          <div className="mt-3 flex items-start gap-1.5 rounded-lg bg-rose-50 px-3 py-2 text-[11px] text-rose-700">
            <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
            {error}
          </div>
        )}
      </div>

      {/* Метрики */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Аккаунтов" value={accounts.length} />
        <Metric label="Переписок сегодня" value={status?.today ? `${status.today.done} из ${status.today.planned}` : '—'} />
        <Metric label="Сообщений всего" value={status?.messages_total ?? 0} />
        <Metric label="С проблемами" value={problemAccounts} tone={problemAccounts ? 'warn' : undefined} />
      </div>

      {chatStageVisible && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="Ответов в чатах сегодня" value={chatStage?.replies_today ?? 0} />
          <Metric label="Реакций сегодня" value={chatStage?.reactions_today ?? 0} />
          <Metric label="Ответов за прогрев" value={chatStage?.replies_total ?? 0} />
          <Metric label="Чатов в работе" value={usableChats} />
        </div>
      )}

      {/* Аккаунты + переписки */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[230px_minmax(0,1fr)]">
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="border-b border-gray-200 px-3 py-2 text-[11px] text-gray-500">Аккаунты</div>
          <button
            type="button"
            onClick={() => setSelectedAccountId(null)}
            className={`w-full border-b border-gray-100 px-3 py-2 text-left text-xs transition ${
              selectedAccountId === null ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50'
            }`}
          >
            Все аккаунты
          </button>
          <div className="max-h-[420px] overflow-y-auto">
            {accounts.map((a) => {
              const s = statByAccount.get(a.id);
              // Жёлтым помечаем только виновника сбоя. Собеседник по сорванной
              // переписке ни при чём: раньше 2 сбоя окрашивали 4 аккаунта.
              const failed = (s?.failed_own ?? 0) > 0;
              const dot = failed ? 'bg-amber-500' : (s?.done ?? 0) > 0 ? 'bg-emerald-500' : 'bg-gray-300';
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => { setSelectedAccountId(a.id); setExpandedConvId(null); }}
                  className={`block w-full border-b border-gray-100 px-3 py-2 text-left transition ${
                    selectedAccountId === a.id ? 'bg-indigo-50' : 'hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
                    <span className={`truncate text-xs ${selectedAccountId === a.id ? 'font-medium text-indigo-700' : 'text-gray-700'}`}>
                      {a.session_name}
                    </span>
                  </div>
                  <div className={`mt-0.5 text-[10px] ${failed ? 'text-amber-600' : 'text-gray-500'}`}>
                    {s
                      ? `${s.done_today} из ${s.planned_today} сегодня · ${s.done} всего`
                      : 'ещё не участвовал'}
                    {/* Со временем сбоя: без него вчерашняя ошибка читается как
                        «аккаунт сломан прямо сейчас». */}
                    {failed && s?.last_error
                      ? ` · ${s.last_error_at ? `${whenOf(s.last_error_at)} ` : ''}${s.last_error.slice(0, 60)}`
                      : ''}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2">
            <span className="text-xs font-medium text-gray-700">
              {rightPanel === 'conversations'
                ? (selectedAccountId ? `Переписки ${accountName(selectedAccountId)}` : 'Все переписки прогрева')
                : (selectedAccountId ? `Активность ${accountName(selectedAccountId)}` : 'Активность в чатах')}
              <span className="ml-2 text-[11px] font-normal text-gray-400">
                {rightPanel === 'conversations' ? conversations.length : activities.length}
              </span>
            </span>
            {/* Переключатель, а не третья колонка: вкладка и так плотная. */}
            {chatStageVisible && (
              <div className="ml-auto flex gap-1">
                {([
                  ['conversations', 'Переписки'],
                  ['activities', 'В чатах'],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setRightPanel(id)}
                    className={`rounded-lg border px-2.5 py-1 text-[11px] transition ${
                      rightPanel === id
                        ? 'border-indigo-200 bg-indigo-50 text-indigo-700'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {rightPanel === 'activities' ? (
            activities.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-gray-400">
                Действий в чатах пока нет
              </div>
            ) : (
              <div className="max-h-[420px] overflow-y-auto">
                {activities.map((a) => {
                  const chat = chatById.get(a.chat_id);
                  return (
                    <div key={a.id} className="border-b border-gray-100 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="shrink-0 text-xs">{a.kind === 'reaction' ? '👍' : '💬'}</span>
                        <span className="flex-1 truncate text-xs text-gray-700">
                          {accountName(a.account_id)}
                          <span className="text-gray-400"> → </span>
                          {chat?.title ?? chat?.link ?? 'чат'}
                        </span>
                        <span className="shrink-0 text-[10px] text-gray-400">
                          день {a.day_no} · {timeOf(a.planned_at)}
                        </span>
                        <ConvBadge status={a.status} />
                      </div>
                      {a.target_excerpt && (
                        <div className="mt-1 truncate pl-6 text-[10px] text-gray-400">
                          на «{a.target_excerpt}»
                        </div>
                      )}
                      {a.content && (
                        <div className="mt-0.5 pl-6 text-[11px] text-gray-600">
                          {a.kind === 'reaction' ? `поставил ${a.content}` : `«${a.content}»`}
                        </div>
                      )}
                      {a.error_reason && a.status !== 'done' && (
                        <div className="mt-0.5 pl-6 text-[10px] text-amber-600">{a.error_reason}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          ) : conversations.length === 0 ? (
            <div className="px-3 py-6 text-center text-[11px] text-gray-400">
              Переписок пока нет
            </div>
          ) : (
            <div className="max-h-[420px] overflow-y-auto">
              {conversations.map((c) => {
                const partnerId = selectedAccountId === c.account_a_id ? c.account_b_id : c.account_a_id;
                const open = expandedConvId === c.id;
                return (
                  <div key={c.id} className="border-b border-gray-100">
                    <button
                      type="button"
                      onClick={() => setExpandedConvId(open ? null : c.id)}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-gray-50"
                    >
                      {open
                        ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                        : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
                      <span className="flex-1 truncate text-xs text-gray-700">
                        {selectedAccountId
                          ? `с ${accountName(partnerId)}`
                          : `${accountName(c.account_a_id)} ↔ ${accountName(c.account_b_id)}`}
                      </span>
                      <span className="shrink-0 text-[10px] text-gray-400">
                        день {c.day_no} · {timeOf(c.planned_at)}
                        {c.messages?.length ? ` · ${c.messages.length} сообщ.` : ''}
                      </span>
                      <ConvBadge status={c.status} />
                    </button>
                    {open && (
                      <div className="bg-gray-50 px-3 py-2.5 pl-8">
                        {c.error_reason && (
                          <div className="mb-2 rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800">
                            {c.error_reason}
                          </div>
                        )}
                        {c.messages?.length ? (
                          <div className="flex flex-col gap-1.5">
                            {c.messages.map((m, i) => {
                              const mine = m.account_id === c.account_a_id;
                              return (
                                <div
                                  key={i}
                                  className={`max-w-[78%] rounded-xl px-2.5 py-1.5 text-xs ${
                                    mine
                                      ? 'self-start border border-gray-200 bg-white text-gray-700'
                                      : 'self-end bg-indigo-50 text-indigo-800'
                                  }`}
                                >
                                  {m.content}
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="text-[11px] text-gray-400">Сообщений ещё нет</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Логи */}
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 px-3 py-2">
          <span className="text-xs font-medium text-gray-700">Логи прогрева</span>
          <span className="flex-1 text-[11px] text-gray-400">
            {selectedAccountId && !allAccountsLogs ? `только ${accountName(selectedAccountId)}` : 'вся кампания'}
          </span>
          <button
            type="button"
            onClick={() => setAllAccountsLogs((v) => !v)}
            className={`rounded-lg border px-2.5 py-1 text-[11px] transition ${
              allAccountsLogs ? 'border-indigo-200 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            Все события
          </button>
          <button
            type="button"
            onClick={() => { void exportLogs(); }}
            disabled={exporting}
            title="Скачать логи прогрева за весь период одним файлом"
            className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1 text-[11px] text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
          >
            {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
            Выгрузить всё
          </button>
          <button
            type="button"
            onClick={() => setErrorsOnly((v) => !v)}
            className={`rounded-lg border px-2.5 py-1 text-[11px] transition ${
              errorsOnly ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            Только ошибки
          </button>
        </div>
        <div className="max-h-72 overflow-y-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
          {logs.length === 0 ? (
            <div className="py-4 text-center text-gray-400">Событий нет</div>
          ) : (
            <>
              {logs.map((l, i) => {
                // Записи идут от новых к старым, поэтому заголовок даты рисуем
                // там, где день сменился относительно предыдущей строки.
                const showDay = i === 0 || dayKey(l.created_at) !== dayKey(logs[i - 1].created_at);
                return (
                  <React.Fragment key={l.id}>
                    {showDay && (
                      <div className="mt-2 mb-1 flex items-center gap-2 first:mt-0">
                        <span className="text-[10px] font-medium uppercase tracking-wide text-gray-400">
                          {dayKey(l.created_at)}
                        </span>
                        <span className="h-px flex-1 bg-gray-100" />
                      </div>
                    )}
                    <div className="flex gap-2">
                      <span className="shrink-0 text-gray-400">{timeOf(l.created_at)}</span>
                      <span className={l.level === 'error' ? 'text-rose-600' : l.level === 'warning' ? 'text-amber-600' : 'text-gray-600'}>
                        {l.message}
                      </span>
                    </div>
                  </React.Fragment>
                );
              })}
              {logsHasMore && (
                <button
                  type="button"
                  disabled={logsLoadingMore}
                  onClick={() => void loadOlderLogs()}
                  className="mt-2 w-full rounded-lg border border-gray-200 py-1.5 text-[11px] text-gray-600 transition hover:bg-gray-50 disabled:opacity-50"
                >
                  {logsLoadingMore ? 'Загружаю…' : 'Показать более ранние'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string | number; tone?: 'warn' }) {
  return (
    <div className="rounded-xl bg-gray-50 px-3 py-2.5">
      <div className="text-[11px] text-gray-500">{label}</div>
      <div className={`mt-0.5 text-lg font-medium ${tone === 'warn' ? 'text-amber-600' : 'text-gray-800'}`}>
        {value}
      </div>
    </div>
  );
}

function ConvBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    done: { label: 'готово', cls: 'bg-emerald-50 text-emerald-700' },
    running: { label: 'идёт', cls: 'bg-indigo-50 text-indigo-700' },
    pending: { label: 'в плане', cls: 'bg-gray-100 text-gray-500' },
    failed: { label: 'сбой', cls: 'bg-rose-50 text-rose-700' },
    skipped: { label: 'пропущено', cls: 'bg-gray-100 text-gray-400' },
  };
  const s = map[status] ?? { label: status, cls: 'bg-gray-100 text-gray-500' };
  return <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] ${s.cls}`}>{s.label}</span>;
}
