'use client';

import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { authFetch, getAccessToken } from '@/lib/authFetch';
import { supabase } from '@/lib/supabaseClient';
import {
  MessageSquareMore,
  Plus,
  Loader2,
  Settings,
  Users,
  ScrollText,
  MessageCircle,
  UserCheck,
  Play,
  Square,
  Trash2,
  ChevronDown,
  ChevronUp,
  Send,
  Download,
  Search,
  X,
  Network,
  Upload,
  Ban,
  RefreshCw,
  AlertCircle,
  Flame,
} from 'lucide-react';
import WarmupTab from '@/components/tg-outreach/WarmupTab';
import type {
  OutreachCampaign,
  OutreachAccount,
  OutreachProxy,
  OutreachDialog,
  OutreachProcessed,
  OutreachLog,
  OutreachBlockedUser,
  OpenAISettings,
  TelegramSettings,
} from '@/lib/tgOutreach/types';
import {
  DEFAULT_OPENAI_SETTINGS,
  DEFAULT_TELEGRAM_SETTINGS,
  DEFAULT_FOLLOW_UP,
} from '@/lib/tgOutreach/types';

const API_BASE = '/api/tools/tg-outreach';

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Маппинг короткого кода `can_send_changed_reason` в человекочитаемую
 * подпись для UI. Коды одобрены схемой (см. migration / blockedUsers /
 * disableDialogIfUnreachable); если приходит неизвестный код — отдаём
 * сам код как есть, чтобы оператор хотя бы видел сигнал, а не пустоту.
 */
function describeCanSendReason(reason: string | null | undefined): string {
  switch (reason) {
    case 'manual': return 'вручную';
    case 'blocklist_add': return 'добавлен в чёрный список';
    case 'blocklist_remove': return 'удалён из чёрного списка';
    case 'tg_user_deactivated': return 'Telegram: пользователь удалил аккаунт';
    case 'tg_peer_invalid': return 'Telegram: невалидный peer';
    case 'tg_user_blocked_bot': return 'Telegram: пользователь заблокировал бота';
    case 'tg_user_banned_in_channel': return 'Telegram: пользователь забанен в канале';
    case 'tg_unreachable': return 'Telegram: пользователь недоступен';
    default: return reason ?? '';
  }
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  stopped: { label: 'Остановлена', cls: 'bg-gray-100 text-gray-600' },
  running: { label: 'Запущена', cls: 'bg-emerald-100 text-emerald-700' },
  stopping: { label: 'Останавливается...', cls: 'bg-amber-100 text-amber-700 animate-pulse' },
  paused: { label: 'Пауза', cls: 'bg-amber-100 text-amber-700' },
  error: { label: 'Ошибка', cls: 'bg-rose-100 text-rose-700' },
  // Прогрев — самостоятельное состояние, а не разновидность «остановлена»:
  // пока он идёт, боевой аутрич запустить нельзя.
  warming: { label: 'Прогрев', cls: 'bg-blue-100 text-blue-700' },
};

/** Цвет точки кампании в списке. */
function statusDotClass(status: string): string {
  switch (status) {
    case 'running': return 'bg-emerald-400';
    case 'warming': return 'bg-blue-400';
    case 'error': return 'bg-rose-400';
    default: return 'bg-gray-400';
  }
}

const DIALOG_STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  none: { label: '—', cls: 'text-gray-400' },
  lead: { label: 'Лид', cls: 'bg-emerald-100 text-emerald-700' },
  not_lead: { label: 'Не лид', cls: 'bg-gray-100 text-gray-600' },
  later: { label: 'Потом', cls: 'bg-amber-100 text-amber-700' },
};

/* =================== GLOBAL BLOCKLIST SECTION =================== */
function GlobalBlocklistSection() {
  const [items, setItems] = useState<OutreachBlockedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [addId, setAddId] = useState('');
  const [addUsername, setAddUsername] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await authFetch(`${API_BASE}/blocked-users`);
    if (res.ok) {
      const d = await res.json() as { items: OutreachBlockedUser[] };
      setItems(d.items);
    }
    setLoading(false);
  }, []);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const add = async () => {
    const idNum = Number(addId.trim());
    if (!Number.isFinite(idNum) || idNum <= 0) {
      setError('Укажи числовой tg_user_id');
      return;
    }
    setAdding(true);
    setError(null);
    const res = await authFetch(`${API_BASE}/blocked-users`, {
      method: 'POST',
      body: JSON.stringify({
        tg_user_id: idNum,
        tg_username: addUsername.trim() ? addUsername.trim().replace(/^@/, '') : null,
      }),
    });
    setAdding(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({})) as { error?: string };
      setError(d.error ?? 'Не удалось добавить');
      return;
    }
    setAddId(''); setAddUsername('');
    void load();
  };

  const remove = async (tgUserId: number) => {
    await authFetch(`${API_BASE}/blocked-users/${tgUserId}`, { method: 'DELETE' });
    void load();
  };

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-gray-800">Глобальный чёрный список (по tg_user_id)</h3>
        <p className="mt-1 text-[11px] text-gray-500">
          Применяется ко всем твоим кампаниям и аккаунтам. Бот не будет отвечать и не создаст диалог
          для пользователей из этого списка — даже если у них нет username.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 p-3">
        <input
          value={addId}
          onChange={e => setAddId(e.target.value)}
          placeholder="tg_user_id"
          className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400 w-40"
        />
        <input
          value={addUsername}
          onChange={e => setAddUsername(e.target.value)}
          placeholder="@username (необязательно)"
          className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400 w-56"
        />
        <button
          type="button"
          onClick={add}
          disabled={adding}
          className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700 hover:shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
          Заблокировать
        </button>
        {error && <span className="text-[11px] text-rose-600">{error}</span>}
      </div>
      {loading ? (
        <div className="flex items-center gap-2 py-4 text-xs text-gray-400">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />Загрузка...
        </div>
      ) : items.length === 0 ? (
        <p className="text-xs text-gray-400 py-4 text-center">Пока никто не заблокирован</p>
      ) : (
        <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {items.map(b => (
            <div key={b.tg_user_id} className="flex items-center gap-3 px-3 py-2 text-xs">
              <Ban className="h-3.5 w-3.5 text-rose-400 shrink-0" />
              <span className="font-medium text-gray-800 w-36">{b.tg_user_id}</span>
              <span className="text-gray-500 flex-1">{b.tg_username ? `@${b.tg_username}` : '—'}</span>
              <span className="text-gray-400">{formatDate(b.created_at)}</span>
              <button
                type="button"
                onClick={() => void remove(b.tg_user_id)}
                className="p-2 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* =================== SETTINGS TAB =================== */
function SettingsTab({ campaign, onSave }: {
  campaign: OutreachCampaign;
  onSave: (openai: OpenAISettings, telegram: TelegramSettings) => Promise<void>;
}) {
  const [openai, setOpenai] = useState<OpenAISettings>({ ...DEFAULT_OPENAI_SETTINGS, ...campaign.openai_settings });
  const [telegram, setTelegram] = useState<TelegramSettings>({
    ...DEFAULT_TELEGRAM_SETTINGS,
    ...campaign.telegram_settings,
    follow_up: {
      ...DEFAULT_FOLLOW_UP,
      ...campaign.telegram_settings?.follow_up,
      delay_minutes: campaign.telegram_settings?.follow_up?.delay_minutes ?? 0,
      prompt: (campaign.telegram_settings?.follow_up?.prompt ?? '').trim() || DEFAULT_FOLLOW_UP.prompt,
    },
  });
  const [saving, setSaving] = useState(false);
  const [blockedRaw, setBlockedRaw] = useState(
    (campaign.telegram_settings?.blocked_usernames ?? []).join(', ')
  );

  const handleSave = async () => {
    setSaving(true);
    const parsed = blockedRaw.split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);
    const updatedTelegram = { ...telegram, blocked_usernames: parsed };
    try { await onSave(openai, updatedTelegram); } finally { setSaving(false); }
  };

  const setOAI = <K extends keyof OpenAISettings>(k: K, v: OpenAISettings[K]) =>
    setOpenai(prev => ({ ...prev, [k]: v }));
  const setTG = <K extends keyof TelegramSettings>(k: K, v: TelegramSettings[K]) =>
    setTelegram(prev => ({ ...prev, [k]: v }));

  return (
    <div className="space-y-6">
      {/* OpenRouter */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-gray-800">OpenRouter</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Field label="Название проекта" value={openai.project_name} onChange={v => setOAI('project_name', v)} />
        </div>
        <FieldArea label="Системный промпт" value={openai.system_prompt} onChange={v => setOAI('system_prompt', v)} rows={6} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FieldArea label="Триггер (положительный)" value={openai.trigger_phrases_positive} onChange={v => setOAI('trigger_phrases_positive', v)} rows={2} />
          <FieldArea label="Триггер (отрицательный)" value={openai.trigger_phrases_negative} onChange={v => setOAI('trigger_phrases_negative', v)} rows={2} />
          <Field label="Чат для пересылки (+)" value={openai.target_chats_positive} onChange={v => setOAI('target_chats_positive', v)} placeholder="@username" />
          <Field label="Чат для пересылки (−)" value={openai.target_chats_negative} onChange={v => setOAI('target_chats_negative', v)} placeholder="@username" />
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={openai.use_fallback_on_fail} onChange={e => setOAI('use_fallback_on_fail', e.target.checked)} className="rounded border-gray-300" />
            Резервный ответ при ошибке
          </label>
        </div>
        {openai.use_fallback_on_fail && (
          <FieldArea label="Резервный текст" value={openai.fallback_text} onChange={v => setOAI('fallback_text', v)} rows={2} />
        )}
      </section>

      {/* Telegram */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-gray-800">Telegram</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <FieldNum label="Лимит пересылки" value={telegram.forward_limit} onChange={v => setTG('forward_limit', v)} />
          <FieldNum label="Лимит истории" value={telegram.history_limit} onChange={v => setTG('history_limit', v)} />
          <FieldNum label="Смещение часового пояса" value={telegram.timezone_offset} onChange={v => setTG('timezone_offset', v)} />
          <FieldNum label="Пауза аккаунта (часов)" value={telegram.account_cooldown_hours} onChange={v => setTG('account_cooldown_hours', v)} />
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <RangeField label="Задержка до прочтения" value={telegram.pre_read_delay_range} onChange={v => setTG('pre_read_delay_range', v)} />
          <RangeField label="Задержка до ответа" value={telegram.read_reply_delay_range} onChange={v => setTG('read_reply_delay_range', v)} />
          <RangeField label="Задержка между аккаунтами" value={telegram.account_loop_delay_range} onChange={v => setTG('account_loop_delay_range', v)} />
          <RangeField label="Окно ожидания диалога" value={telegram.dialog_wait_window_range} onChange={v => setTG('dialog_wait_window_range', v)} />
          {/* Пауза между полными кругами по всем аккаунтам. Раньше была
              захардкожена в 30 секунд, что на «горячих» mobile-pool IP
              слишком быстро (Telegram продолжал отвечать silent throttle).
              Сейчас вынесено в настройки с дефолтом [300, 600] сек. */}
          <RangeField label="Пауза между кругами" value={telegram.cycle_delay_range ?? [300, 600]} onChange={v => setTG('cycle_delay_range', v)} />
        </div>
        <Field label="Периоды сна" value={telegram.sleep_periods.join(', ')} onChange={v => setTG('sleep_periods', v.split(',').map(s => s.trim()).filter(Boolean))} placeholder="00:00-08:00, 19:00-00:00" />
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={telegram.reply_only_if_previously_wrote} onChange={e => setTG('reply_only_if_previously_wrote', e.target.checked)} className="rounded border-gray-300" />
            Отвечать только если ранее писали
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={telegram.auto_allow_new_dialogs} onChange={e => setTG('auto_allow_new_dialogs', e.target.checked)} className="rounded border-gray-300" />
            Новым диалогам разрешать отправку автоматически
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={telegram.ignore_bot_usernames} onChange={e => setTG('ignore_bot_usernames', e.target.checked)} className="rounded border-gray-300" />
            Игнорировать ботов
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-700">
            <input type="checkbox" checked={telegram.ignore_no_username} onChange={e => setTG('ignore_no_username', e.target.checked)} className="rounded border-gray-300" />
            Игнорировать без имени пользователя
          </label>
        </div>
        <Field
          label="Чёрный список username (через запятую)"
          value={blockedRaw}
          onChange={setBlockedRaw}
          placeholder="SpamBot, another_bot"
        />
      </section>

      <GlobalBlocklistSection />

      {/* Follow-up */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-gray-800">Настройки Follow-up сообщений</h3>
        <div className="rounded-lg border border-blue-100 bg-blue-50/50 p-3 text-xs text-gray-700">
          Follow-up отправляется автоматически, если человек не ответил на сообщение в течение заданного времени. Отправляется только 1 раз для каждого диалога.
        </div>
        <label className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <input type="checkbox" checked={telegram.follow_up.enabled} onChange={e => setTG('follow_up', { ...telegram.follow_up, enabled: e.target.checked })} className="rounded border-gray-300" />
          Включить Follow-up сообщения
        </label>
        {telegram.follow_up.enabled && (
          <div className="space-y-4 rounded-lg border border-gray-200 p-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <FieldNum label="Задержка перед отправкой (часы)" value={telegram.follow_up.delay_hours} onChange={v => setTG('follow_up', { ...telegram.follow_up, delay_hours: v })} />
              </div>
              <div>
                <FieldNum label="Задержка (минуты)" value={telegram.follow_up.delay_minutes ?? 0} onChange={v => setTG('follow_up', { ...telegram.follow_up, delay_minutes: v })} />
              </div>
            </div>
            <p className="text-[11px] text-gray-500">Через сколько времени без ответа отправить follow-up (по умолчанию: 24 часа 0 минут)</p>
            <div>
              <FieldArea label="Промпт для генерации сообщения" value={telegram.follow_up.prompt} onChange={v => setTG('follow_up', { ...telegram.follow_up, prompt: v })} rows={4} placeholder="Напиши короткое напоминание о себе..." />
              <p className="mt-1 text-[11px] text-gray-500">GPT учтёт историю переписки. Опишите, каким должно быть сообщение.</p>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 text-[11px] text-gray-700">
              <strong>Важно:</strong>
              <ul className="mt-1 list-inside list-disc space-y-0.5">
                <li>Отправляется только если последнее сообщение от бота</li>
                <li>Только 1 раз для каждого пользователя</li>
                <li>Не отправляется для уже обработанных клиентов</li>
              </ul>
            </div>
          </div>
        )}
      </section>

      <button type="button" onClick={handleSave} disabled={saving}
        className="inline-flex items-center gap-2 rounded-full bg-indigo-600 px-6 py-2.5 text-xs font-semibold text-white hover:bg-indigo-700 hover:shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Сохранить настройки
      </button>
    </div>
  );
}

/* =================== LOGS TAB =================== */
type ErrorRange = '6h' | '24h' | '7d';

type ErrorCountsResponse = {
  range: ErrorRange;
  since: string;
  until: string;
  truncated: boolean;
  counts: Record<string, { error: number; warning: number; account_id: string }>;
  other: {
    error: number;
    warning: number;
    recent: { id: number; level: 'error' | 'warning'; message: string; created_at: string }[];
  };
};

function formatPeriod(sinceIso: string, untilIso: string) {
  const opts: Intl.DateTimeFormatOptions = {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  };
  const since = new Date(sinceIso).toLocaleString('ru-RU', opts);
  const until = new Date(untilIso).toLocaleString('ru-RU', opts);
  return `${since} — ${until}`;
}

function LogsTab({ campaignId }: { campaignId: string }) {
  const [logs, setLogs] = useState<OutreachLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportingRange, setExportingRange] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isAutoScroll = useRef(true);

  // Side panel state: range, accounts (for opening AccountLogsModal on click)
  // and the aggregated error counts. Polled on the same 5s cadence as logs so
  // a fresh ошибка in the dark block doesn't lag behind in the side list.
  const [panelRange, setPanelRange] = useState<ErrorRange>('24h');
  const [accounts, setAccounts] = useState<OutreachAccount[]>([]);
  const [proxies, setProxies] = useState<OutreachProxy[]>([]);
  const [errData, setErrData] = useState<ErrorCountsResponse | null>(null);
  const [errLoading, setErrLoading] = useState(true);
  const [selectedAccount, setSelectedAccount] = useState<OutreachAccount | null>(null);

  const fetchLogs = useCallback(async () => {
    // Rolling 6-hour window — wide enough to cover overnight quiet hours
    // ending mid-morning, narrow enough that the dark block stays readable
    // and scroll-to-bottom feels live. Limit of 5000 is well above the
    // realistic 6h volume (~300-500 lines at current cadence) and prevents
    // a runaway response if the worker enters a logging hot loop.
    const sinceIso = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const params = new URLSearchParams({ since: sinceIso, limit: '5000' });
    const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/logs?${params}`);
    if (res.ok) {
      const d = await res.json() as { items: OutreachLog[] };
      setLogs(d.items.reverse());
    }
    setLoading(false);
  }, [campaignId]);

  const fetchSidePanel = useCallback(async () => {
    const [errRes, accRes, proxRes] = await Promise.all([
      authFetch(`${API_BASE}/campaigns/${campaignId}/accounts/error-counts?range=${panelRange}`),
      authFetch(`${API_BASE}/accounts?campaign_id=${campaignId}`),
      authFetch(`${API_BASE}/proxies?campaign_id=${campaignId}`),
    ]);
    if (errRes.ok) {
      const d = await errRes.json() as ErrorCountsResponse;
      setErrData(d);
    }
    if (accRes.ok) {
      const d = await accRes.json() as { items: OutreachAccount[] };
      setAccounts(d.items);
    }
    if (proxRes.ok) {
      const d = await proxRes.json() as { items: OutreachProxy[] };
      setProxies(d.items);
    }
    setErrLoading(false);
  }, [campaignId, panelRange]);

  const exportLogs = useCallback(
    async (range: ErrorRange) => {
      setExportingRange(range);
      try {
        const res = await authFetch(`${API_BASE}/campaigns/${campaignId}/logs/export?range=${range}`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert((data as { error?: string }).error ?? `Не удалось выгрузить логи (HTTP ${res.status})`);
          return;
        }
        // Pick up the server-suggested filename from Content-Disposition; fall
        // back to a sensible default if the browser/proxy stripped it.
        const cd = res.headers.get('content-disposition') ?? '';
        const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd);
        const ascii = /filename="?([^";]+)"?/i.exec(cd);
        const filename = utf8
          ? decodeURIComponent(utf8[1])
          : (ascii?.[1] ?? `tg-outreach-logs-${range}.txt`);

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } finally {
        setExportingRange(null);
      }
    },
    [campaignId],
  );

  useEffect(() => { queueMicrotask(() => { void fetchLogs(); }); }, [fetchLogs]);
  useEffect(() => { queueMicrotask(() => { void fetchSidePanel(); }); }, [fetchSidePanel]);

  useEffect(() => {
    const interval = setInterval(() => {
      void fetchLogs();
      void fetchSidePanel();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchLogs, fetchSidePanel]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    // Если мы в пределах 50px от низа, включаем автоскролл
    isAutoScroll.current = scrollHeight - scrollTop - clientHeight < 50;
  }, []);

  useEffect(() => {
    if (isAutoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs]);

  const levelColor = (l: string) => {
    switch (l) {
      case 'error': return 'text-rose-400';
      case 'warning': return 'text-amber-400';
      default: return 'text-gray-400';
    }
  };

  // Sort accounts by error count desc; only show those with non-zero errors or
  // warnings. Account-side keys are session_name (matches API contract).
  const accountsWithErrors = React.useMemo(() => {
    if (!errData) return [] as { account: OutreachAccount; error: number; warning: number }[];
    return accounts
      .map(a => {
        const c = errData.counts[a.session_name];
        return {
          account: a,
          error: c?.error ?? 0,
          warning: c?.warning ?? 0,
        };
      })
      .filter(x => x.error > 0 || x.warning > 0)
      .sort((a, b) => (b.error - a.error) || (b.warning - a.warning));
  }, [errData, accounts]);

  const totalErr = errData?.other.error ?? 0;
  const totalWarn = errData?.other.warning ?? 0;
  const accErr = accountsWithErrors.reduce((s, x) => s + x.error, 0);
  const accWarn = accountsWithErrors.reduce((s, x) => s + x.warning, 0);

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4">
      {/* Left: existing export bar + dark log block */}
      <div className="space-y-3 min-w-0">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-[11px] text-gray-400">
            Показаны логи за последние 6 часов · обновление каждые 10 сек
          </span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 mr-1">Выгрузить .txt:</span>
            {(['6h', '24h', '7d'] as const).map((r) => {
              const labels: Record<typeof r, string> = { '6h': '6 часов', '24h': '24 часа', '7d': '7 дней' };
              const busy = exportingRange === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => void exportLogs(r)}
                  disabled={exportingRange !== null}
                  className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3.5 py-1.5 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 hover:shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  {labels[r]}
                </button>
              );
            })}
          </div>
        </div>
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="rounded-lg border border-gray-800 bg-gray-950 p-3 font-mono text-[11px] leading-relaxed h-[500px] overflow-auto"
        >
          {loading && <p className="text-gray-500">Загрузка логов...</p>}
          {!loading && logs.length === 0 && <p className="text-gray-600">Нет логов. Запустите кампанию.</p>}
          {logs.map(log => (
            <div key={log.id} className="flex gap-2">
              <span className="text-gray-600 shrink-0">{new Date(log.created_at).toLocaleTimeString('ru-RU')}</span>
              <span className={`shrink-0 font-bold uppercase w-14 ${levelColor(log.level)}`}>{log.level}</span>
              <span className="text-gray-300 break-all">{log.message}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Right: errors side panel */}
      <aside className="rounded-lg border border-gray-200 bg-white flex flex-col h-[538px] min-h-0 overflow-hidden">
        <header className="px-3.5 py-3 border-b border-gray-100 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-gray-800 flex items-center gap-1.5">
              <AlertCircle className="h-3.5 w-3.5 text-rose-500" />
              Ошибки за период
            </h3>
            <button
              type="button"
              onClick={() => { setErrLoading(true); void fetchSidePanel(); }}
              title="Обновить"
              className="p-1 rounded-md text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 transition cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${errLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="flex items-center gap-1">
            {(['6h', '24h', '7d'] as const).map(r => {
              const labels: Record<ErrorRange, string> = { '6h': '6ч', '24h': '24ч', '7d': '7д' };
              const active = panelRange === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => { setPanelRange(r); setErrLoading(true); }}
                  className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition cursor-pointer ${
                    active
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white text-gray-600 border border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'
                  }`}
                >
                  {labels[r]}
                </button>
              );
            })}
          </div>
          {errData && (
            <p className="text-[10px] text-gray-500 leading-snug">
              Период: <span className="text-gray-700 font-medium">{formatPeriod(errData.since, errData.until)}</span>
            </p>
          )}
          <div className="flex items-center gap-2 text-[11px]">
            <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-1.5 py-0.5 text-rose-700">
              <span className="font-semibold">{accErr + totalErr}</span> ошибок
            </span>
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-amber-700">
              <span className="font-semibold">{accWarn + totalWarn}</span> предупр.
            </span>
            {errData?.truncated && (
              <span className="text-[10px] text-gray-400 ml-auto">обрезано</span>
            )}
          </div>
        </header>

        <div className="flex-1 overflow-auto">
          {/* Accounts with errors */}
          <div className="px-3.5 py-3 border-b border-gray-100">
            <h4 className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-2">
              Аккаунты с ошибками
            </h4>
            {errLoading && !errData ? (
              <div className="flex items-center gap-2 py-2 text-[11px] text-gray-400">
                <Loader2 className="h-3 w-3 animate-spin" /> Загрузка...
              </div>
            ) : accountsWithErrors.length === 0 ? (
              <p className="text-[11px] text-gray-400 py-2">Нет ошибок у аккаунтов</p>
            ) : (
              <ul className="space-y-1">
                {accountsWithErrors.map(({ account, error, warning }) => (
                  <li key={account.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedAccount(account)}
                      title="Открыть логи аккаунта"
                      className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-gray-50 transition cursor-pointer text-left"
                    >
                      <span className="text-[11px] font-medium text-gray-800 truncate flex-1 min-w-0">
                        {account.session_name}
                      </span>
                      {error > 0 && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 shrink-0">
                          <AlertCircle className="h-2.5 w-2.5" />
                          {error}
                        </span>
                      )}
                      {warning > 0 && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 shrink-0">
                          {warning}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Other errors (not tied to any account) */}
          <div className="px-3.5 py-3">
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-[10px] font-semibold uppercase tracking-wide text-gray-400">
                Прочие ошибки
              </h4>
              {errData && (totalErr + totalWarn > 0) && (
                <span className="text-[10px] text-gray-400">
                  {totalErr} ош. · {totalWarn} пред.
                </span>
              )}
            </div>
            {errLoading && !errData ? (
              <div className="flex items-center gap-2 py-2 text-[11px] text-gray-400">
                <Loader2 className="h-3 w-3 animate-spin" /> Загрузка...
              </div>
            ) : !errData || errData.other.recent.length === 0 ? (
              <p className="text-[11px] text-gray-400 py-2">
                Нет ошибок без привязки к аккаунту
              </p>
            ) : (
              <ul className="space-y-1.5">
                {errData.other.recent.map(row => (
                  <li
                    key={row.id}
                    className="rounded-md border border-gray-100 bg-gray-50 px-2 py-1.5 text-[11px]"
                  >
                    <div className="flex items-center gap-1.5 text-[10px] text-gray-500 mb-0.5">
                      <span className={`font-semibold uppercase ${row.level === 'error' ? 'text-rose-600' : 'text-amber-600'}`}>
                        {row.level}
                      </span>
                      <span>
                        {new Date(row.created_at).toLocaleString('ru-RU', {
                          day: '2-digit', month: '2-digit',
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </span>
                    </div>
                    <p className="text-gray-700 break-words leading-snug">{row.message}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </aside>

      {selectedAccount && (
        <AccountLogsModal
          account={selectedAccount}
          proxy={proxies.find(p => p.id === selectedAccount.proxy_id) ?? null}
          onClose={() => setSelectedAccount(null)}
        />
      )}
    </div>
  );
}

/* =================== DIALOGS TAB =================== */
function DialogsTab({ campaignId, isOwn }: {
  campaignId: string;
  // false = кампания принадлежит другому специалисту. Read-only: переключение
  // can_send / смена статуса / удаление / отправка сообщения упрётся в RLS
  // (миграция 20260320_0003 расширяет SELECT до всех, но не UPDATE/DELETE/INSERT).
  // Без флага UI пускал клики, бэк возвращал криптовое
  // «JSON object requested, multiple (or no) rows returned» от .single() на
  // нулевом результате UPDATE — пользователь не понимал, почему «не работает».
  isOwn: boolean;
}) {
  const [dialogs, setDialogs] = useState<OutreachDialog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const [filterStatus, setFilterStatus] = useState('');
  const [filterCanSend, setFilterCanSend] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [filterAudience, setFilterAudience] = useState<'all' | 'users' | 'bots'>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [sendText, setSendText] = useState('');
  const [sending, setSending] = useState(false);
  const [accounts, setAccounts] = useState<OutreachAccount[]>([]);
  const limit = 30;

  const fetchAccounts = useCallback(async () => {
    const res = await authFetch(`${API_BASE}/accounts?campaign_id=${campaignId}`);
    if (res.ok) {
      const d = await res.json() as { items: OutreachAccount[] };
      setAccounts(d.items);
    }
  }, [campaignId]);

  const accountNameMap = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const a of accounts) map.set(a.id, a.session_name);
    return map;
  }, [accounts]);

  const fetchDialogs = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams({ campaign_id: campaignId, limit: String(limit), offset: String(offset) });
    if (filterStatus) params.set('status', filterStatus);
    if (filterCanSend === 'enabled') params.set('can_send', 'true');
    if (filterCanSend === 'disabled') params.set('can_send', 'false');
    if (filterAudience === 'bots') params.set('tg_is_bot', 'true');
    if (filterAudience === 'users') params.set('tg_is_bot', 'false');
    const res = await authFetch(`${API_BASE}/dialogs?${params}`);
    if (res.ok) {
      const d = await res.json() as { items: OutreachDialog[]; total: number };
      setDialogs(d.items); setTotal(d.total);
    }
    setLoading(false);
  }, [campaignId, offset, filterStatus, filterCanSend, filterAudience]);

  useEffect(() => { queueMicrotask(() => { void fetchDialogs(); void fetchAccounts(); }); }, [fetchDialogs, fetchAccounts]);

  const updateDialog = async (id: string, patch: { status?: string; can_send?: boolean }) => {
    if (!isOwn) {
      // Защита от случая «кнопка disabled не сработала» (например, hotkey).
      // На бэке тот же чек есть (см. PUT /dialogs/[id]) — это просто чтобы UI
      // не отправлял заведомо неуспешный запрос.
      alert('Эту кампанию запустил другой специалист — действия недоступны, только просмотр.');
      return;
    }
    const res = await authFetch(`${API_BASE}/dialogs/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: string } | null;
      alert(body?.error ?? `Не удалось обновить диалог (HTTP ${res.status})`);
      return;
    }
    void fetchDialogs();
  };

  const deleteDialog = async (id: string) => {
    if (!isOwn) {
      alert('Эту кампанию запустил другой специалист — действия недоступны, только просмотр.');
      return;
    }
    await authFetch(`${API_BASE}/dialogs/${id}`, { method: 'DELETE' });
    void fetchDialogs();
  };

  const addToBlacklist = async (dialog: OutreachDialog) => {
    if (!isOwn) {
      alert('Эту кампанию запустил другой специалист — действия недоступны, только просмотр.');
      return;
    }
    const username = (dialog.tg_username ?? '').toLowerCase().replace(/^@/, '');
    // Глобальный блок-лист по tg_user_id: запись применяется ко всем кампаниям и
    // аккаунтам пользователя; API сам выставит can_send=false на всех существующих
    // диалогах с этим tg_user_id (RLS отфильтрует только свои).
    await authFetch(`${API_BASE}/blocked-users`, {
      method: 'POST',
      body: JSON.stringify({
        tg_user_id: dialog.tg_user_id,
        tg_username: username || null,
      }),
    });
    void fetchDialogs();
  };

  const sendMessage = async (id: string) => {
    if (!isOwn) {
      alert('Эту кампанию запустил другой специалист — отправка сообщений недоступна.');
      return;
    }
    if (!sendText.trim()) return;
    setSending(true);
    await authFetch(`${API_BASE}/dialogs/${id}/send`, {
      method: 'POST',
      body: JSON.stringify({ message: sendText }),
    });
    setSendText(''); setSending(false);
    void fetchDialogs();
  };

  const exportDialogs = async (format: 'json' | 'html') => {
    const res = await authFetch(`${API_BASE}/dialogs/export?campaign_id=${campaignId}&format=${format}`);
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dialogs.${format}`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const totalPages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <div className="space-y-4">
      {!isOwn && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="font-medium">👁 Только просмотр.</span>
          <span>Кампанию запустил другой специалист — менять статусы, переключать отправку и отправлять сообщения нельзя.</span>
        </div>
      )}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500">Статус:</span>
          {['', 'none', 'lead', 'not_lead', 'later'].map(s => (
            <button key={s} type="button" onClick={() => { setFilterStatus(s); setOffset(0); }}
              className={`rounded-full px-4 py-1.5 text-xs font-medium transition border cursor-pointer ${filterStatus === s ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'}`}>
              {s ? DIALOG_STATUS_LABELS[s]?.label : 'Все'}
            </button>
          ))}
          <span className="ml-2 text-xs text-gray-500">Отправка:</span>
          {[
            { id: 'all', label: 'Все' },
            { id: 'enabled', label: 'Разрешено' },
            { id: 'disabled', label: 'Запрещено' },
          ].map(s => (
            <button key={s.id} type="button" onClick={() => { setFilterCanSend(s.id as typeof filterCanSend); setOffset(0); }}
              className={`rounded-full px-4 py-1.5 text-xs font-medium transition border cursor-pointer ${filterCanSend === s.id ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'}`}>
              {s.label}
            </button>
          ))}
          <span className="ml-2 text-xs text-gray-500">Тип:</span>
          {[
            { id: 'all', label: 'Все' },
            { id: 'users', label: 'Люди' },
            { id: 'bots', label: 'Боты' },
          ].map(s => (
            <button key={s.id} type="button" onClick={() => { setFilterAudience(s.id as typeof filterAudience); setOffset(0); }}
              className={`rounded-full px-4 py-1.5 text-xs font-medium transition border cursor-pointer ${filterAudience === s.id ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'}`}>
              {s.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void exportDialogs('json')} className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 hover:shadow-sm transition cursor-pointer">
            <Download className="h-3.5 w-3.5" /> JSON
          </button>
          <button type="button" onClick={() => void exportDialogs('html')} className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 hover:shadow-sm transition cursor-pointer">
            <Download className="h-3.5 w-3.5" /> HTML
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Загрузка...</div>
      ) : dialogs.length === 0 ? (
        <p className="text-xs text-gray-400 py-8 text-center">Нет диалогов</p>
      ) : (
        <div className="space-y-2">
          {dialogs.map(d => {
            const isExpanded = expandedId === d.id;
            const st = DIALOG_STATUS_LABELS[d.status] ?? DIALOG_STATUS_LABELS.none;
            return (
              <div key={d.id} className="rounded-xl border border-gray-200 bg-white shadow-sm">
                <button type="button" onClick={() => setExpandedId(isExpanded ? null : d.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-100 transition rounded-xl cursor-pointer">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-900">{d.tg_username ? `@${d.tg_username}` : `ID ${d.tg_user_id}`}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${st.cls}`}>{st.label}</span>
                      {d.tg_is_bot ? (
                        <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-700">Бот</span>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">Пользователь</span>
                      )}
                      <span
                        role={isOwn ? 'button' : undefined}
                        tabIndex={isOwn ? 0 : undefined}
                        onClick={isOwn ? (e) => {
                          // Бейдж лежит внутри кнопки-аккордеона (раскрытие
                          // диалога). Без stopPropagation клик одновременно
                          // переключал can_send и раскрывал/сворачивал — оператор
                          // видит «дёрнулось», а раскрыт диалог или нет —
                          // непонятно.
                          e.stopPropagation();
                          void updateDialog(d.id, { can_send: d.can_send === false });
                        } : undefined}
                        onKeyDown={isOwn ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            void updateDialog(d.id, { can_send: d.can_send === false });
                          }
                        } : undefined}
                        title={
                          !isOwn
                            ? 'Чужая кампания — переключение недоступно.'
                            : d.can_send === false
                              ? 'Сейчас отправка отключена — клик включит «Можно писать».'
                              : 'Сейчас отправка разрешена — клик переключит в «Не писать».'
                        }
                        className={`rounded-full px-2 py-0.5 text-[10px] font-medium transition ${isOwn ? 'cursor-pointer hover:opacity-80' : 'cursor-default opacity-80'} ${d.can_send === false ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}`}
                      >
                        {d.can_send === false ? 'Не писать' : 'Можно писать'}
                      </span>
                      <span className="text-[10px] text-gray-400">{d.messages.length} сообщ.</span>
                    </div>
                    <span className="text-[11px] text-gray-400">{d.last_message_at ? formatDate(d.last_message_at) : '—'}</span>
                  </div>
                  {isExpanded ? <ChevronUp className="h-4 w-4 text-gray-400" /> : <ChevronDown className="h-4 w-4 text-gray-400" />}
                </button>
                {isExpanded && (
                  <div className="border-t border-gray-100 px-4 py-3 space-y-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-gray-500">Статус:</span>
                      {['none', 'lead', 'not_lead', 'later'].map(s => (
                        <button key={s} type="button" disabled={!isOwn}
                          onClick={() => void updateDialog(d.id, { status: s })}
                          title={!isOwn ? 'Чужая кампания — смена статуса недоступна.' : undefined}
                          className={`rounded-full px-3 py-1 text-[10px] font-medium transition border ${!isOwn ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'} ${d.status === s ? 'bg-indigo-100 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-indigo-200 hover:bg-indigo-50'}`}>
                          {DIALOG_STATUS_LABELS[s]?.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        disabled={!isOwn}
                        onClick={() => void addToBlacklist(d)}
                        title={!isOwn ? 'Чужая кампания — добавление в чёрный список недоступно.' : undefined}
                        className={`ml-2 inline-flex items-center gap-1.5 rounded-full border border-rose-200 bg-rose-50 px-3 py-1 text-[10px] font-medium text-rose-700 hover:bg-rose-100 hover:border-rose-300 transition ${!isOwn ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                      >
                        <Ban className="h-3 w-3" />
                        В черный список
                      </button>
                      <button type="button" disabled={!isOwn} onClick={() => void deleteDialog(d.id)}
                        title={!isOwn ? 'Чужая кампания — удаление недоступно.' : undefined}
                        className={`ml-auto p-2 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition ${!isOwn ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    {/* Аудит can_send: кто/когда/почему последний раз менял.
                        Показываем, только если запись о смене есть. До первого
                        переключения поля NULL — диалог унаследовал дефолт при
                        создании, и подпись была бы шумом. Также рендерим
                        крупную кнопку «Разрешить отправку», когда диалог в
                        статусе «Не писать» — чтобы оператор не искал
                        кликабельный бейдж в шапке. */}
                    {(d.can_send_changed_at || d.can_send === false) && (
                      <div className={`flex items-center gap-2 flex-wrap rounded-lg px-3 py-2 text-[11px] ${d.can_send === false ? 'bg-rose-50 text-rose-800 border border-rose-100' : 'bg-emerald-50 text-emerald-800 border border-emerald-100'}`}>
                        <span className="font-medium">
                          Отправка: {d.can_send === false ? 'отключена' : 'разрешена'}
                        </span>
                        {d.can_send_changed_at && (
                          <>
                            <span className="text-gray-400">·</span>
                            <span>
                              {d.can_send_changed_by ? 'переключил оператор' : 'переключил воркер'}
                            </span>
                            <span className="text-gray-400">·</span>
                            <span>{formatDate(d.can_send_changed_at)}</span>
                            {d.can_send_changed_reason && (
                              <>
                                <span className="text-gray-400">·</span>
                                <span>{describeCanSendReason(d.can_send_changed_reason)}</span>
                              </>
                            )}
                          </>
                        )}
                        {d.can_send === false && (
                          <button
                            type="button"
                            disabled={!isOwn}
                            onClick={() => void updateDialog(d.id, { can_send: true })}
                            className={`ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-600 px-3 py-1 text-[10px] font-medium text-white hover:bg-emerald-700 transition ${!isOwn ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
                            title={!isOwn ? 'Чужая кампания — изменение недоступно.' : 'Разрешить отправку в этот диалог. История изменений сохранится в логах кампании.'}
                          >
                            Разрешить отправку
                          </button>
                        )}
                      </div>
                    )}
                    <div className="max-h-72 overflow-auto space-y-1.5 rounded-lg bg-gray-50 p-2">
                      {d.messages.map((m, i) => {
                        const senderName = m.role === 'user'
                          ? (d.tg_username ? `@${d.tg_username}` : `ID ${d.tg_user_id}`)
                          : accountNameMap.get(d.account_id) ?? 'Бот';
                        return (
                          <div key={i} className={`rounded-lg px-3 py-2 text-xs ${m.role === 'user' ? 'bg-blue-50 text-gray-800' : 'bg-emerald-50 text-gray-800'}`}>
                            <span className="font-semibold">{senderName}:</span> {m.content}
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex gap-2">
                      <input value={sendText} onChange={e => setSendText(e.target.value)}
                        placeholder={!isOwn ? 'Чужая кампания — отправка недоступна' : 'Написать сообщение...'}
                        disabled={!isOwn}
                        className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs outline-none focus:border-indigo-400 disabled:opacity-50 disabled:cursor-not-allowed"
                        onKeyDown={e => { if (isOwn && e.key === 'Enter') void sendMessage(d.id); }} />
                      <button type="button" onClick={() => void sendMessage(d.id)} disabled={!isOwn || sending || d.can_send === false}
                        title={!isOwn ? 'Чужая кампания — отправка недоступна.' : undefined}
                        className="rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 hover:shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
                        <Send className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button type="button" disabled={currentPage <= 1} onClick={() => setOffset(Math.max(0, offset - limit))}
            className="rounded-full px-4 py-2 text-xs font-medium border border-gray-200 bg-white text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">Назад</button>
          <span className="text-xs text-gray-500">{currentPage} / {totalPages}</span>
          <button type="button" disabled={currentPage >= totalPages} onClick={() => setOffset(offset + limit)}
            className="rounded-full px-4 py-2 text-xs font-medium border border-gray-200 bg-white text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">Вперёд</button>
        </div>
      )}
    </div>
  );
}

/* =================== PROCESSED TAB =================== */
function ProcessedTab({ campaignId }: { campaignId: string }) {
  const [items, setItems] = useState<OutreachProcessed[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [addUserId, setAddUserId] = useState('');
  const [addUsername, setAddUsername] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const res = await authFetch(`${API_BASE}/processed?campaign_id=${campaignId}&limit=200`);
    if (res.ok) {
      const d = await res.json() as { items: OutreachProcessed[]; total: number };
      setItems(d.items); setTotal(d.total);
    }
    setLoading(false);
  }, [campaignId]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const addProcessed = async () => {
    await authFetch(`${API_BASE}/processed`, {
      method: 'POST',
      body: JSON.stringify({ campaign_id: campaignId, tg_user_id: Number(addUserId), tg_username: addUsername || null }),
    });
    setAddUserId(''); setAddUsername(''); setShowAdd(false); void load();
  };

  const removeProcessed = async (id: string) => {
    await authFetch(`${API_BASE}/processed?id=${id}`, { method: 'DELETE' });
    void load();
  };

  const filtered = search
    ? items.filter(i => (i.tg_username ?? '').toLowerCase().includes(search.toLowerCase()) || String(i.tg_user_id).includes(search))
    : items;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Search className="h-3.5 w-3.5 text-gray-400" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Поиск по имени или ID..."
            className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs outline-none focus:border-indigo-400 w-56" />
          <span className="text-xs text-gray-400">Всего: {total}</span>
        </div>
        <button type="button" onClick={() => setShowAdd(!showAdd)}
          className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 hover:shadow-sm transition cursor-pointer">
          <Plus className="h-3.5 w-3.5" /> Добавить
        </button>
      </div>
      {showAdd && (
        <div className="flex items-center gap-2 rounded-lg border border-gray-200 p-3">
          <input value={addUserId} onChange={e => setAddUserId(e.target.value)} placeholder="User ID" className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs outline-none w-36" />
          <input value={addUsername} onChange={e => setAddUsername(e.target.value)} placeholder="@username" className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs outline-none w-36" />
          <button type="button" onClick={addProcessed} className="rounded-full bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-indigo-700 hover:shadow-md transition cursor-pointer">Добавить</button>
        </div>
      )}
      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Загрузка...</div>
      ) : filtered.length === 0 ? (
        <p className="text-xs text-gray-400 py-8 text-center">Нет обработанных клиентов</p>
      ) : (
        <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {filtered.map(p => (
            <div key={p.id} className="flex items-center gap-3 px-3 py-2 text-xs">
              <UserCheck className="h-3.5 w-3.5 text-gray-400 shrink-0" />
              <span className="font-medium text-gray-800 w-28">{p.tg_user_id}</span>
              <span className="text-gray-500 flex-1">{p.tg_username ? `@${p.tg_username}` : '—'}</span>
              <span className="text-gray-400">{formatDate(p.processed_at)}</span>
              <button type="button" onClick={() => void removeProcessed(p.id)} className="p-2 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer"><Trash2 className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* =================== BULK SELECTION =================== */

/**
 * Чекбокс «выделить всё» с промежуточным состоянием.
 *
 * indeterminate нельзя выставить атрибутом — только через DOM-свойство, поэтому
 * ref + effect. Без него при частичном выделении галка выглядит как «ничего не
 * выбрано», и оператор жмёт её второй раз, снимая уже сделанный выбор.
 */
function SelectAllCheckbox({
  total,
  selectedCount,
  onChange,
}: {
  total: number;
  selectedCount: number;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const allSelected = total > 0 && selectedCount === total;

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = selectedCount > 0 && selectedCount < total;
  }, [selectedCount, total]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={allSelected}
      onChange={e => onChange(e.target.checked)}
      title={allSelected ? 'Снять выделение' : 'Выделить все'}
      aria-label={allSelected ? 'Снять выделение' : 'Выделить все'}
      className="h-3.5 w-3.5 cursor-pointer accent-indigo-600"
    />
  );
}

/** Панель массовых действий: появляется, только когда что-то выделено. */
function BulkActionsBar({
  selectedCount,
  deleting,
  onClear,
  onDelete,
}: {
  selectedCount: number;
  deleting: boolean;
  onClear: () => void;
  onDelete: () => void;
}) {
  if (selectedCount === 0) return null;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2">
      <span className="text-xs font-medium text-indigo-900">Выбрано: {selectedCount}</span>
      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
      >
        {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
        Удалить выбранные
      </button>
      <button
        type="button"
        onClick={onClear}
        disabled={deleting}
        className="text-xs text-indigo-700 hover:text-indigo-900 hover:underline transition cursor-pointer disabled:opacity-50"
      >
        Снять выделение
      </button>
    </div>
  );
}

/** Общая механика выделения строк таблицы: toggle, «выделить всё», сброс. */
function useRowSelection(allIds: string[]) {
  const [raw, setRaw] = useState<Set<string>>(new Set());

  // Выделение выводим из текущего списка, а не подчищаем эффектом после
  // перезагрузки: id удалённой строки просто перестаёт попадать в выборку.
  // Синхронизация через useEffect дала бы лишний каскадный рендер на каждую
  // загрузку таблицы ради того же результата.
  const selectedIds = useMemo(() => allIds.filter(id => raw.has(id)), [allIds, raw]);
  const isSelected = useCallback((id: string) => raw.has(id), [raw]);

  const toggle = useCallback((id: string) => {
    setRaw(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const setAll = useCallback((checked: boolean) => {
    setRaw(checked ? new Set(allIds) : new Set());
  }, [allIds]);

  const clear = useCallback(() => { setRaw(new Set()); }, []);

  return { selectedIds, isSelected, toggle, setAll, clear };
}

/* =================== CAMPAIGN ACCOUNTS TAB =================== */
function CampaignAccountsTab({ campaignId }: { campaignId: string }) {
  const [accounts, setAccounts] = useState<OutreachAccount[]>([]);
  const [proxies, setProxies] = useState<OutreachProxy[]>([]);
  const [errorCounts, setErrorCounts] = useState<
    Record<string, { error: number; warning: number; account_id: string }>
  >({});
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sessionName, setSessionName] = useState('');
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [phone, setPhone] = useState('');
  const [proxyId, setProxyId] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingProxyFor, setEditingProxyFor] = useState<string | null>(null);
  const [selectedAccount, setSelectedAccount] = useState<OutreachAccount | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const accountIds = useMemo(() => accounts.map(a => a.id), [accounts]);
  const { selectedIds, isSelected, toggle, setAll, clear } = useRowSelection(accountIds);

  const load = useCallback(async () => {
    setLoading(true);
    const [accRes, proxRes, errRes] = await Promise.all([
      authFetch(`${API_BASE}/accounts?campaign_id=${campaignId}`),
      authFetch(`${API_BASE}/proxies?campaign_id=${campaignId}`),
      // Bulk error counts in last 24h — cheap (one query, grouped server-side).
      // Used to render the ⚠ N chips next to each account name.
      authFetch(`${API_BASE}/campaigns/${campaignId}/accounts/error-counts?range=24h`),
    ]);
    if (accRes.ok) {
      const d = await accRes.json() as { items: OutreachAccount[] };
      setAccounts(d.items);
    }
    if (proxRes.ok) {
      const d = await proxRes.json() as { items: OutreachProxy[] };
      setProxies(d.items);
    }
    if (errRes.ok) {
      const d = await errRes.json() as {
        counts: Record<string, { error: number; warning: number; account_id: string }>;
      };
      setErrorCounts(d.counts ?? {});
    }
    setLoading(false);
  }, [campaignId]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const addAccount = async () => {
    if (!sessionName.trim() || !apiId.trim() || !apiHash.trim()) return;
    setSaving(true);
    await authFetch(`${API_BASE}/accounts`, {
      method: 'POST',
      body: JSON.stringify({
        campaign_id: campaignId,
        session_name: sessionName.trim(),
        api_id: Number(apiId),
        api_hash: apiHash.trim(),
        phone: phone.trim(),
        proxy_id: proxyId || null,
      }),
    });
    setSaving(false);
    setSessionName(''); setApiId(''); setApiHash(''); setPhone(''); setProxyId('');
    setShowAdd(false);
    void load();
  };

  const toggleActive = async (id: string, current: boolean) => {
    await authFetch(`${API_BASE}/accounts/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ is_active: !current }),
    });
    void load();
  };

  const deleteAccount = async (id: string) => {
    if (!confirm('Удалить аккаунт?')) return;
    await authFetch(`${API_BASE}/accounts/${id}`, { method: 'DELETE' });
    void load();
  };

  const deleteSelected = async () => {
    const ids = selectedIds;
    if (!ids.length) return;
    if (!confirm(`Удалить аккаунтов: ${ids.length}? Действие необратимо.`)) return;
    setBulkDeleting(true);
    setUploadError(null);
    try {
      const res = await authFetch(`${API_BASE}/accounts/bulk`, {
        method: 'DELETE',
        body: JSON.stringify({ campaign_id: campaignId, ids }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setUploadError(d?.error ?? `Не удалось удалить (${res.status})`);
        return;
      }
      clear();
      void load();
    } finally {
      setBulkDeleting(false);
    }
  };

  const assignProxy = async (accountId: string, newProxyId: string) => {
    await authFetch(`${API_BASE}/accounts/${accountId}`, {
      method: 'PUT',
      body: JSON.stringify({ proxy_id: newProxyId || null }),
    });
    setAccounts(prev => prev.map(a => a.id === accountId ? { ...a, proxy_id: newProxyId || null } : a));
    setEditingProxyFor(null);
  };

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    setUploading(true);
    setUploadError(null);
    try {
      const token = await getAccessToken();
      const formData = new FormData();
      Array.from(files).forEach(f => formData.append('files', f));
      const res = await fetch(`${API_BASE}/accounts/bulk-files?campaign_id=${campaignId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) {
        const d = await res.json() as { error?: string };
        setUploadError(d.error ?? 'Ошибка загрузки');
      }
    } finally {
      setUploading(false);
      void load();
    }
    e.target.value = '';
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="text-sm font-medium text-gray-700">
          Аккаунты кампании <span className="text-gray-400 font-normal">({accounts.length})</span>
        </span>
        <div className="flex items-center gap-2">
          <label className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition cursor-pointer">
            {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            Загрузить файлы
            <input type="file" multiple accept=".json,.session" className="hidden" onChange={e => { void handleFiles(e); }} />
          </label>
          <button type="button" onClick={() => setShowAdd(!showAdd)}
            className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 hover:shadow-md transition cursor-pointer">
            <Plus className="h-3.5 w-3.5" /> Добавить
          </button>
        </div>
      </div>

      {uploadError && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{uploadError}</div>
      )}

      {showAdd && (
        <div className="rounded-lg border border-gray-200 p-4 space-y-3 bg-gray-50">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <label className="space-y-1 col-span-2">
              <span className="text-[11px] font-medium text-gray-500">Session name</span>
              <input value={sessionName} onChange={e => setSessionName(e.target.value)} placeholder="my_account"
                className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">API ID</span>
              <input type="number" value={apiId} onChange={e => setApiId(e.target.value)}
                className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">API Hash</span>
              <input value={apiHash} onChange={e => setApiHash(e.target.value)}
                className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">Телефон</span>
              <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="+79001234567"
                className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">Прокси</span>
              <select value={proxyId} onChange={e => setProxyId(e.target.value)}
                className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400">
                <option value="">Без прокси</option>
                {proxies.map(p => <option key={p.id} value={p.id}>{p.name || p.url}</option>)}
              </select>
            </label>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => { void addAccount(); }} disabled={saving || !sessionName.trim() || !apiId || !apiHash.trim()}
              className="rounded-full bg-indigo-600 px-5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Сохранить'}
            </button>
            <button type="button" onClick={() => setShowAdd(false)}
              className="rounded-full border border-gray-200 px-4 py-2 text-xs text-gray-500 hover:bg-gray-100 transition cursor-pointer">Отмена</button>
          </div>
        </div>
      )}

      <BulkActionsBar
        selectedCount={selectedIds.length}
        deleting={bulkDeleting}
        onClear={clear}
        onDelete={() => { void deleteSelected(); }}
      />

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Загрузка...</div>
      ) : accounts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center">
          <Users className="mx-auto h-8 w-8 text-gray-300 mb-2" />
          <p className="text-xs text-gray-400">Нет аккаунтов. Добавьте вручную или загрузите файлы.</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="grid grid-cols-[32px_1fr_120px_150px_80px_40px] gap-4 px-4 py-2 text-[11px] font-medium text-gray-400 bg-gray-50 items-center">
            <SelectAllCheckbox total={accounts.length} selectedCount={selectedIds.length} onChange={setAll} />
            <span>Аккаунт</span><span>Телефон</span><span>Прокси</span><span>Активен</span><span />
          </div>
          {accounts.map(a => {
            const proxy = proxies.find(p => p.id === a.proxy_id);
            const onCooldown = a.cooldown_until && new Date(a.cooldown_until) > new Date();
            const counts = errorCounts[a.session_name];
            const errorCount = counts?.error ?? 0;
            return (
              <div
                key={a.id}
                className={`grid grid-cols-[32px_1fr_120px_150px_80px_40px] gap-4 items-center px-4 py-2.5 ${isSelected(a.id) ? 'bg-indigo-50/60' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={isSelected(a.id)}
                  onChange={() => toggle(a.id)}
                  aria-label={`Выбрать ${a.session_name}`}
                  className="h-3.5 w-3.5 cursor-pointer accent-indigo-600"
                />
                <div className="min-w-0 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedAccount(a)}
                    title="Открыть логи и информацию"
                    className="min-w-0 text-left text-xs font-medium text-gray-800 truncate hover:text-indigo-600 hover:underline transition cursor-pointer"
                  >
                    {a.session_name}
                  </button>
                  {errorCount > 0 && (
                    <button
                      type="button"
                      onClick={() => setSelectedAccount(a)}
                      title={`${errorCount} ошибок за 24ч — открыть логи`}
                      className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-1.5 py-0.5 text-[10px] font-semibold text-rose-700 hover:bg-rose-100 transition cursor-pointer shrink-0"
                    >
                      <AlertCircle className="h-3 w-3" />
                      {errorCount}
                    </button>
                  )}
                  {onCooldown && (
                    <span className="text-[10px] text-amber-600 shrink-0">
                      Кулдаун до {new Date(a.cooldown_until!).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}
                    </span>
                  )}
                </div>
                <span className="text-xs text-gray-500 truncate">{a.phone || '—'}</span>
                {editingProxyFor === a.id ? (
                  <select
                    autoFocus
                    defaultValue={a.proxy_id ?? ''}
                    onBlur={e => { void assignProxy(a.id, e.target.value); }}
                    onChange={e => { void assignProxy(a.id, e.target.value); }}
                    className="w-full rounded border border-indigo-300 bg-white px-1.5 py-0.5 text-xs outline-none focus:border-indigo-500 cursor-pointer"
                  >
                    <option value="">Без прокси</option>
                    {proxies.map(p => <option key={p.id} value={p.id}>{p.name || p.url}</option>)}
                  </select>
                ) : (
                  <button
                    type="button"
                    title="Назначить прокси"
                    onClick={() => setEditingProxyFor(a.id)}
                    className="w-full text-left text-xs truncate rounded px-1 py-0.5 hover:bg-indigo-50 hover:text-indigo-700 transition cursor-pointer group"
                  >
                    {proxy ? (proxy.name || proxy.url) : <span className="text-gray-300 group-hover:text-indigo-400">—</span>}
                  </button>
                )}
                <button type="button" onClick={() => { void toggleActive(a.id, a.is_active); }}
                  className={`rounded-full px-2.5 py-1 text-[10px] font-medium transition cursor-pointer w-fit ${a.is_active ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                  {a.is_active ? 'Да' : 'Нет'}
                </button>
                <button type="button" onClick={() => { void deleteAccount(a.id); }}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {selectedAccount && (
        <AccountLogsModal
          account={selectedAccount}
          proxy={proxies.find(p => p.id === selectedAccount.proxy_id) ?? null}
          onClose={() => setSelectedAccount(null)}
        />
      )}
    </div>
  );
}

/* =================== ACCOUNT LOGS MODAL =================== */
function AccountLogsModal({
  account,
  proxy,
  onClose,
}: {
  account: OutreachAccount;
  proxy: OutreachProxy | null;
  onClose: () => void;
}) {
  const [range, setRange] = useState<'6h' | '24h' | '7d'>('24h');
  const [logs, setLogs] = useState<OutreachLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportingRange, setExportingRange] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`${API_BASE}/accounts/${account.id}/logs?range=${range}`);
      if (res.ok) {
        const d = await res.json() as {
          items: OutreachLog[];
          truncated: boolean;
        };
        setLogs(d.items ?? []);
        setTruncated(Boolean(d.truncated));
      } else {
        setLogs([]);
        setTruncated(false);
      }
    } finally {
      setLoading(false);
    }
  }, [account.id, range]);

  useEffect(() => { void fetchLogs(); }, [fetchLogs]);

  // Close on Escape so the modal feels native.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Auto-scroll to bottom (newest) after each refresh.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [logs]);

  const exportLogs = useCallback(
    async (r: '6h' | '24h' | '7d') => {
      setExportingRange(r);
      try {
        const res = await authFetch(`${API_BASE}/accounts/${account.id}/logs?range=${r}&format=txt`);
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          alert((data as { error?: string }).error ?? `Не удалось выгрузить логи (HTTP ${res.status})`);
          return;
        }
        const cd = res.headers.get('content-disposition') ?? '';
        const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd);
        const ascii = /filename="?([^";]+)"?/i.exec(cd);
        const filename = utf8
          ? decodeURIComponent(utf8[1])
          : (ascii?.[1] ?? `tg-outreach-account-${account.session_name}-${r}.txt`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } finally {
        setExportingRange(null);
      }
    },
    [account.id, account.session_name],
  );

  const levelColor = (l: string) => {
    switch (l) {
      case 'error': return 'text-rose-400';
      case 'warning': return 'text-amber-400';
      default: return 'text-gray-400';
    }
  };

  const errorCount = logs.filter(l => l.level === 'error').length;
  const warningCount = logs.filter(l => l.level === 'warning').length;
  const onCooldown = account.cooldown_until && new Date(account.cooldown_until) > new Date();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-4xl max-h-[90vh] flex flex-col rounded-2xl bg-white shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-gray-100 px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-900 truncate">
              {account.session_name}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-500">
              {account.phone && account.phone !== account.session_name && (
                <span>Телефон: <span className="text-gray-700">{account.phone}</span></span>
              )}
              <span>Прокси: <span className="text-gray-700">{proxy ? (proxy.name || proxy.url) : '—'}</span></span>
              <span>
                Активен:{' '}
                <span className={account.is_active ? 'text-emerald-700' : 'text-gray-500'}>
                  {account.is_active ? 'Да' : 'Нет'}
                </span>
              </span>
              {onCooldown && (
                <span className="text-amber-600">
                  Кулдаун до {new Date(account.cooldown_until!).toLocaleString('ru-RU', {
                    hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit',
                  })}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-3 p-1.5 rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition cursor-pointer"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="px-5 py-3 border-b border-gray-100 flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500 mr-1">Период:</span>
            {(['6h', '24h', '7d'] as const).map(r => {
              const labels: Record<typeof r, string> = { '6h': '6ч', '24h': '24ч', '7d': '7д' };
              const active = range === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRange(r)}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition cursor-pointer ${
                    active
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white text-gray-600 border border-gray-200 hover:border-indigo-300 hover:bg-indigo-50'
                  }`}
                >
                  {labels[r]}
                </button>
              );
            })}
          </div>

          <div className="text-xs text-gray-500">
            {loading ? '…' : (
              <>
                Всего строк: <span className="font-semibold text-gray-700">{logs.length}</span>
                {errorCount > 0 && (
                  <> · <span className="text-rose-600 font-semibold">{errorCount} ошибок</span></>
                )}
                {warningCount > 0 && (
                  <> · <span className="text-amber-600 font-semibold">{warningCount} предупреждений</span></>
                )}
                {truncated && (
                  <> · <span className="text-gray-400">(показано не всё — обрезано лимитом)</span></>
                )}
              </>
            )}
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-xs text-gray-500 mr-1">.txt:</span>
            {(['6h', '24h', '7d'] as const).map(r => {
              const labels: Record<typeof r, string> = { '6h': '6ч', '24h': '24ч', '7d': '7д' };
              const busy = exportingRange === r;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => void exportLogs(r)}
                  disabled={exportingRange !== null}
                  className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
                  {labels[r]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 overflow-auto bg-gray-950 p-3 font-mono text-[11px] leading-relaxed">
          {loading && <p className="text-gray-500">Загрузка логов…</p>}
          {!loading && logs.length === 0 && (
            <p className="text-gray-600">
              По этому аккаунту ничего не найдено в выбранном периоде.
            </p>
          )}
          {logs.map((log, idx) => (
            <div key={`${log.id}-${idx}`} className="flex gap-2">
              <span className="text-gray-600 shrink-0">
                {new Date(log.created_at).toLocaleTimeString('ru-RU')}
              </span>
              <span className={`shrink-0 font-bold uppercase w-14 ${levelColor(log.level)}`}>
                {log.level}
              </span>
              <span className="text-gray-300 break-all">{log.message}</span>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}

/* =================== CAMPAIGN PROXIES TAB =================== */
function CampaignProxiesTab({ campaignId }: { campaignId: string }) {
  const [proxies, setProxies] = useState<OutreachProxy[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [bulkText, setBulkText] = useState('');
  const [saving, setSaving] = useState(false);
  /** Previously errors were ignored — authFetch does not throw on 4xx/5xx, so users saw "nothing happened". */
  const [proxyError, setProxyError] = useState<string | null>(null);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const proxyIds = useMemo(() => proxies.map(p => p.id), [proxies]);
  const { selectedIds, isSelected, toggle, setAll, clear } = useRowSelection(proxyIds);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await authFetch(`${API_BASE}/proxies?campaign_id=${campaignId}`);
    if (res.ok) {
      const d = await res.json() as { items: OutreachProxy[] };
      setProxies(d.items);
    }
    setLoading(false);
  }, [campaignId]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const addProxy = async () => {
    if (!url.trim()) return;
    setSaving(true);
    setProxyError(null);
    try {
      const res = await authFetch(`${API_BASE}/proxies`, {
        method: 'POST',
        body: JSON.stringify({ campaign_id: campaignId, url: url.trim(), name: name.trim() }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
        setProxyError(errBody?.error ?? `Ошибка сервера (${res.status})`);
        return;
      }
      setUrl(''); setName(''); setShowAdd(false);
      void load();
    } finally {
      setSaving(false);
    }
  };

  const addBulk = async () => {
    const lines = bulkText.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    setSaving(true);
    setProxyError(null);
    try {
      for (let i = 0; i < lines.length; i++) {
        const res = await authFetch(`${API_BASE}/proxies`, {
          method: 'POST',
          body: JSON.stringify({ campaign_id: campaignId, url: lines[i], name: '' }),
        });
        if (!res.ok) {
          const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
          setProxyError(
            `Строка ${i + 1}: ${errBody?.error ?? `ошибка ${res.status}`}. Остальные строки не загружены.`,
          );
          return;
        }
      }
      setBulkText(''); setShowBulk(false);
      void load();
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (id: string, current: boolean) => {
    await authFetch(`${API_BASE}/proxies/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ is_active: !current }),
    });
    void load();
  };

  const deleteProxy = async (id: string) => {
    if (!confirm('Удалить прокси? Аккаунты с этим прокси будут отвязаны.')) return;
    await authFetch(`${API_BASE}/proxies/${id}`, { method: 'DELETE' });
    void load();
  };

  const deleteSelected = async () => {
    const ids = selectedIds;
    if (!ids.length) return;
    if (!confirm(`Удалить прокси: ${ids.length}? Аккаунты с этими прокси будут отвязаны.`)) return;
    setBulkDeleting(true);
    setProxyError(null);
    try {
      const res = await authFetch(`${API_BASE}/proxies/bulk`, {
        method: 'DELETE',
        body: JSON.stringify({ campaign_id: campaignId, ids }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => null)) as { error?: string } | null;
        setProxyError(d?.error ?? `Не удалось удалить (${res.status})`);
        return;
      }
      clear();
      void load();
    } finally {
      setBulkDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="text-sm font-medium text-gray-700">
          Прокси кампании <span className="text-gray-400 font-normal">({proxies.length})</span>
        </span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => { setShowBulk(!showBulk); setShowAdd(false); setProxyError(null); }}
            className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition cursor-pointer">
            Массовое добавление
          </button>
          <button type="button" onClick={() => { setShowAdd(!showAdd); setShowBulk(false); setProxyError(null); }}
            className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 hover:shadow-md transition cursor-pointer">
            <Plus className="h-3.5 w-3.5" /> Добавить
          </button>
        </div>
      </div>

      {/* Без привязки к showAdd/showBulk: ошибка массового удаления приходит при
          закрытых формах и иначе была бы не видна вообще. */}
      {proxyError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {proxyError}
        </div>
      )}

      {showAdd && (
        <div className="rounded-lg border border-gray-200 p-4 space-y-3 bg-gray-50">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">URL прокси</span>
              <input value={url} onChange={e => setUrl(e.target.value)} placeholder="http://user:pass@host:port"
                className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">Название (необязательно)</span>
              <input value={name} onChange={e => setName(e.target.value)} placeholder="Proxy 1"
                className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400" />
            </label>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => { void addProxy(); }} disabled={saving || !url.trim()}
              className="rounded-full bg-indigo-600 px-5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Сохранить'}
            </button>
            <button type="button" onClick={() => setShowAdd(false)}
              className="rounded-full border border-gray-200 px-4 py-2 text-xs text-gray-500 hover:bg-gray-100 transition cursor-pointer">Отмена</button>
          </div>
        </div>
      )}

      {showBulk && (
        <div className="rounded-lg border border-gray-200 p-4 space-y-3 bg-gray-50">
          <p className="text-xs text-gray-500">Введите по одному URL прокси на строку:</p>
          <textarea value={bulkText} onChange={e => setBulkText(e.target.value)} rows={5}
            placeholder={'http://user:pass@host:port\nпо одному URL на строку'}
            className="block w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-indigo-400 resize-y font-mono" />
          <div className="flex gap-2">
            <button type="button" onClick={() => { void addBulk(); }} disabled={saving || !bulkText.trim()}
              className="rounded-full bg-indigo-600 px-5 py-2 text-xs font-semibold text-white hover:bg-indigo-700 transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Добавить'}
            </button>
            <button type="button" onClick={() => setShowBulk(false)}
              className="rounded-full border border-gray-200 px-4 py-2 text-xs text-gray-500 hover:bg-gray-100 transition cursor-pointer">Отмена</button>
          </div>
        </div>
      )}

      <BulkActionsBar
        selectedCount={selectedIds.length}
        deleting={bulkDeleting}
        onClear={clear}
        onDelete={() => { void deleteSelected(); }}
      />

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Загрузка...</div>
      ) : proxies.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center">
          <Network className="mx-auto h-8 w-8 text-gray-300 mb-2" />
          <p className="text-xs text-gray-400">Нет прокси. Добавьте для этой кампании.</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="grid grid-cols-[32px_1fr_80px_40px] gap-4 px-4 py-2 text-[11px] font-medium text-gray-400 bg-gray-50 items-center">
            <SelectAllCheckbox total={proxies.length} selectedCount={selectedIds.length} onChange={setAll} />
            <span>URL / Название</span><span>Активен</span><span />
          </div>
          {proxies.map(p => (
            <div
              key={p.id}
              className={`grid grid-cols-[32px_1fr_80px_40px] gap-4 items-center px-4 py-2.5 ${isSelected(p.id) ? 'bg-indigo-50/60' : ''}`}
            >
              <input
                type="checkbox"
                checked={isSelected(p.id)}
                onChange={() => toggle(p.id)}
                aria-label={`Выбрать ${p.name || p.url}`}
                className="h-3.5 w-3.5 cursor-pointer accent-indigo-600"
              />
              <div className="min-w-0">
                {p.name && <p className="text-xs font-medium text-gray-800">{p.name}</p>}
                <p className="text-xs text-gray-500 truncate font-mono">{p.url}</p>
              </div>
              <button type="button" onClick={() => { void toggleActive(p.id, p.is_active); }}
                className={`rounded-full px-2.5 py-1 text-[10px] font-medium transition cursor-pointer w-fit ${p.is_active ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}>
                {p.is_active ? 'Да' : 'Нет'}
              </button>
              <button type="button" onClick={() => { void deleteProxy(p.id); }}
                className="p-1.5 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* =================== CAMPAIGN VIEW (5 tabs) =================== */
const TABS = [
  { id: 'settings', label: 'Настройки', icon: Settings },
  { id: 'accounts', label: 'Аккаунты', icon: Users },
  { id: 'warmup', label: 'Прогрев', icon: Flame },
  { id: 'proxies', label: 'Прокси', icon: Network },
  { id: 'logs', label: 'Логи', icon: ScrollText },
  { id: 'dialogs', label: 'Диалоги', icon: MessageCircle },
  { id: 'processed', label: 'Обработанные', icon: UserCheck },
] as const;

function CampaignView({ campaign, isOwn, onUpdate, onDelete }: {
  campaign: OutreachCampaign;
  isOwn: boolean;
  onUpdate: () => void;
  onDelete: (id: string) => void;
}) {
  const [tab, setTab] = useState<string>('settings');
  const [actionLoading, setActionLoading] = useState(false);
  const [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false);
  const [refetchJobId, setRefetchJobId] = useState<string | null>(null);
  const [refetchProgress, setRefetchProgress] = useState<{
    total: number; done: number; fetched: number; errors: number;
    last_username: string | null; last_messages: number;
    status: string;
  } | null>(null);

  useEffect(() => {
    if (!stopping) return;
    const poll = setInterval(async () => {
      try {
        const res = await authFetch(`${API_BASE}/campaigns/${campaign.id}/status`);
        if (!res.ok) return;
        const body = await res.json() as { status: string; is_running: boolean };
        if (!body.is_running || body.status === 'stopped') {
          setStopping(false);
          stoppingRef.current = false;
          onUpdate();
        }
      } catch { /* ignore */ }
    }, 3000);
    return () => clearInterval(poll);
  }, [stopping, campaign.id, onUpdate]);

  useEffect(() => {
    if (!refetchJobId) return;
    const poll = setInterval(async () => {
      try {
        const res = await authFetch(`${API_BASE}/jobs/${refetchJobId}`);
        if (!res.ok) return;
        const job = await res.json() as {
          status: string;
          progress?: { total: number; done: number; fetched: number; errors: number; last_username: string | null; last_messages: number } | null;
        };
        setRefetchProgress({
          total: job.progress?.total ?? 0,
          done: job.progress?.done ?? 0,
          fetched: job.progress?.fetched ?? 0,
          errors: job.progress?.errors ?? 0,
          last_username: job.progress?.last_username ?? null,
          last_messages: job.progress?.last_messages ?? 0,
          status: job.status,
        });
        if (job.status === 'completed' || job.status === 'failed') {
          setTimeout(() => {
            setRefetchJobId(null);
            setRefetchProgress(null);
            onUpdate();
          }, 3000);
        }
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(poll);
  }, [refetchJobId, onUpdate]);

  const doAction = async (action: 'start' | 'stop' | 'refetch') => {
    setActionLoading(true);
    const res = await authFetch(`${API_BASE}/campaigns/${campaign.id}/${action}`, { method: 'POST' });
    if (action === 'stop') {
      setStopping(true);
      stoppingRef.current = true;
    }
    if (action === 'refetch') {
      try {
        const body = await res.json() as { id?: string; empty_count?: number; message?: string; error?: string };
        if (body.error) {
          alert(`Ошибка: ${body.error}`);
        } else if (body.empty_count === 0) {
          alert('Нет диалогов с пустыми сообщениями');
        } else if (body.id) {
          setRefetchJobId(body.id);
          setRefetchProgress({ total: body.empty_count ?? 0, done: 0, fetched: 0, errors: 0, last_username: null, last_messages: 0, status: 'pending' });
        }
      } catch { /* ignore parse errors */ }
    }
    setActionLoading(false);
    onUpdate();
  };

  const saveSettings = async (openai: OpenAISettings, telegram: TelegramSettings) => {
    await authFetch(`${API_BASE}/campaigns/${campaign.id}`, {
      method: 'PUT',
      body: JSON.stringify({ openai_settings: openai, telegram_settings: telegram }),
    });
    onUpdate();
  };

  const displayStatus = stopping ? 'stopping' : campaign.status;
  const st = STATUS_LABELS[displayStatus] ?? STATUS_LABELS.stopped;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-gray-900">{campaign.name}</h2>
          <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${st.cls}`}>{st.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {campaign.status !== 'running' && !stopping ? (
            <button type="button" onClick={() => void doAction('start')}
              disabled={actionLoading || campaign.status === 'warming'}
              title={campaign.status === 'warming'
                ? 'Идёт прогрев аккаунтов — остановите его на вкладке «Прогрев»'
                : undefined}
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-700 hover:shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {actionLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Запустить
            </button>
          ) : stopping ? (
            <button type="button" disabled
              className="inline-flex items-center gap-1.5 rounded-full bg-amber-500 px-5 py-2.5 text-xs font-semibold text-white opacity-80 cursor-not-allowed">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Останавливается...
            </button>
          ) : (
            <button type="button" onClick={() => void doAction('stop')} disabled={actionLoading}
              className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-rose-700 hover:shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {actionLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
              Остановить
            </button>
          )}
          {campaign.status !== 'running' && !stopping && (
            <button type="button" onClick={() => void doAction('refetch')} disabled={actionLoading || !!refetchJobId}
              title="Перезагрузить пустые диалоги из Telegram"
              className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-2.5 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 hover:shadow-sm transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {actionLoading || refetchJobId ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refetch
            </button>
          )}
          <button type="button" onClick={() => onDelete(campaign.id)}
            className="rounded-full border border-gray-200 p-2.5 text-gray-400 hover:text-rose-600 hover:border-rose-300 hover:bg-rose-50 transition cursor-pointer">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {refetchProgress && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4 space-y-2">
          <div className="flex items-center justify-between text-xs font-medium text-indigo-800">
            <span className="flex items-center gap-2">
              {refetchProgress.status === 'completed' ? (
                <span className="text-emerald-600">✓ Refetch завершён</span>
              ) : refetchProgress.status === 'failed' ? (
                <span className="text-rose-600">✗ Refetch ошибка</span>
              ) : (
                <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Загрузка диалогов...</>
              )}
            </span>
            <span>{refetchProgress.done} / {refetchProgress.total}</span>
          </div>
          <div className="h-2 rounded-full bg-indigo-100 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                refetchProgress.status === 'completed' ? 'bg-emerald-500' :
                refetchProgress.status === 'failed' ? 'bg-rose-500' : 'bg-indigo-500'
              }`}
              style={{ width: `${refetchProgress.total > 0 ? (refetchProgress.done / refetchProgress.total) * 100 : 0}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-indigo-600">
            <span>
              {refetchProgress.last_username && refetchProgress.last_messages > 0
                ? `@${refetchProgress.last_username} — ${refetchProgress.last_messages} сообщ.`
                : refetchProgress.last_username
                  ? `@${refetchProgress.last_username} — пусто`
                  : 'Ожидание...'}
            </span>
            <span>
              {refetchProgress.fetched > 0 && <span className="text-emerald-600 mr-2">+{refetchProgress.fetched} загружено</span>}
              {refetchProgress.errors > 0 && <span className="text-rose-500">{refetchProgress.errors} ошибок</span>}
            </span>
          </div>
        </div>
      )}

      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} type="button" onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-1.5 px-5 py-3 text-xs font-medium transition border-b-2 -mb-px cursor-pointer ${tab === t.id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}>
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      <div>
        {tab === 'settings' && <SettingsTab campaign={campaign} onSave={saveSettings} />}
        {tab === 'accounts' && <CampaignAccountsTab campaignId={campaign.id} />}
        {tab === 'proxies' && <CampaignProxiesTab campaignId={campaign.id} />}
        {tab === 'warmup' && (
          <WarmupTab campaignId={campaign.id} isOwn={isOwn} campaignStatus={campaign.status} />
        )}
        {tab === 'logs' && <LogsTab campaignId={campaign.id} />}
        {tab === 'dialogs' && <DialogsTab campaignId={campaign.id} isOwn={isOwn} />}
        {tab === 'processed' && <ProcessedTab campaignId={campaign.id} />}
      </div>
    </div>
  );
}

/* =================== FORM HELPERS =================== */
function Field({ label, value, onChange, placeholder, type }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <label className="space-y-1">
      <span className="text-[11px] font-medium text-gray-500">{label}</span>
      <input type={type ?? 'text'} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="block w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400" />
    </label>
  );
}

function FieldNum({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="space-y-1">
      <span className="text-[11px] font-medium text-gray-500">{label}</span>
      <input type="number" value={value} onChange={e => onChange(Number(e.target.value))}
        className="block w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400" />
    </label>
  );
}

function FieldArea({ label, value, onChange, rows, placeholder }: { label: string; value: string; onChange: (v: string) => void; rows?: number; placeholder?: string }) {
  return (
    <label className="space-y-1">
      <span className="text-[11px] font-medium text-gray-500">{label}</span>
      <textarea value={value} onChange={e => onChange(e.target.value)} rows={rows ?? 3} placeholder={placeholder}
        className="block w-full rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-1.5 text-xs text-gray-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400 resize-y" />
    </label>
  );
}

function RangeField({ label, value, onChange }: { label: string; value: [number, number]; onChange: (v: [number, number]) => void }) {
  return (
    <label className="space-y-1">
      <span className="text-[11px] font-medium text-gray-500">{label}</span>
      <div className="flex items-center gap-1">
        <input type="number" value={value[0]} onChange={e => onChange([Number(e.target.value), value[1]])}
          className="block w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-800 outline-none focus:border-indigo-400" />
        <span className="text-gray-400 text-xs">—</span>
        <input type="number" value={value[1]} onChange={e => onChange([value[0], Number(e.target.value)])}
          className="block w-full rounded-lg border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-800 outline-none focus:border-indigo-400" />
      </div>
    </label>
  );
}

/* =================== CAMPAIGNS SECTION =================== */
function CampaignsSection() {
  const [campaigns, setCampaigns] = useState<OutreachCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  // Текущий портальный юзер — нужен, чтобы понять, своя ли это кампания.
  // TG-аутрич с миграции 20260320_0003 даёт всем читать любые кампании, но
  // писать (в том числе менять can_send/status диалогов) можно только в своих.
  // Без сравнения с currentUserId UI не отличает «своё» от «чужое», и кнопки
  // молча падают с криптовой ошибкой supabase про 0 строк после UPDATE.
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!cancelled) setCurrentUserId(session?.user?.id ?? null);
      const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
        if (!cancelled) setCurrentUserId(s?.user?.id ?? null);
      });
      return () => subscription.unsubscribe();
    })();
    return () => { cancelled = true; };
  }, []);

  const fetchCampaigns = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) { setLoading(false); return; }
    const res = await authFetch(`${API_BASE}/campaigns`);
    if (res.ok) {
      const d = await res.json() as { items: OutreachCampaign[] };
      setCampaigns(d.items);
    }
    setLoading(false);
  }, []);

  useEffect(() => { queueMicrotask(() => { void fetchCampaigns(); }); }, [fetchCampaigns]);

  const createCampaign = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    const res = await authFetch(`${API_BASE}/campaigns`, {
      method: 'POST',
      body: JSON.stringify({ name: newName.trim() }),
    });
    if (res.ok) {
      const c = await res.json() as OutreachCampaign;
      setSelectedId(c.id);
      setNewName(''); setShowCreate(false);
    }
    setCreating(false);
    void fetchCampaigns();
  };

  const deleteCampaign = async (id: string) => {
    if (!confirm('Удалить кампанию? Это действие необратимо.')) return;
    await authFetch(`${API_BASE}/campaigns/${id}`, { method: 'DELETE' });
    if (selectedId === id) setSelectedId(null);
    void fetchCampaigns();
  };

  const selected = campaigns.find(c => c.id === selectedId) ?? null;

  return (
    <div className="w-full text-left">
      <div className="min-w-0 w-full space-y-6">
        {/* Header */}
        <header className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">
            <MessageSquareMore className="h-3.5 w-3.5" />
            TG Аутрич
          </div>
          <h1 className="text-2xl font-bold text-gray-900">Telegram Аутрич</h1>
          <p className="max-w-2xl text-sm text-gray-500">
            Массовый B2B-аутрич через Telegram. Управление кампаниями, автоответы GPT, квалификация лидов.
          </p>
        </header>

        {/* Campaign selector */}
        <div className="flex items-center gap-3 flex-wrap">
          {campaigns.map(c => {
            const st = STATUS_LABELS[c.status] ?? STATUS_LABELS.stopped;
            return (
              <button key={c.id} type="button" onClick={() => setSelectedId(c.id)} title={st.label}
                className={`inline-flex items-center gap-2 rounded-full px-5 py-2.5 text-xs font-medium transition border cursor-pointer ${selectedId === c.id ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200 hover:border-indigo-300 hover:bg-indigo-50 hover:shadow-sm'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${statusDotClass(c.status)}`} />
                {c.name}
              </button>
            );
          })}
          <button type="button" onClick={() => setShowCreate(!showCreate)}
            className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-gray-300 px-5 py-2.5 text-xs font-medium text-gray-500 hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50/50 transition cursor-pointer">
            <Plus className="h-3.5 w-3.5" /> Новая кампания
          </button>
        </div>

        {showCreate && (
          <div className="flex items-center gap-2 rounded-lg border border-gray-200 p-3">
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Название кампании"
              className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs outline-none focus:border-indigo-400"
              onKeyDown={e => { if (e.key === 'Enter') void createCampaign(); }} />
            <button type="button" onClick={createCampaign} disabled={creating}
              className="rounded-full bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-indigo-700 hover:shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Создать'}
            </button>
            <button type="button" onClick={() => setShowCreate(false)} className="p-2 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition cursor-pointer"><X className="h-4 w-4" /></button>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center py-12 text-gray-400">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />Загрузка...
          </div>
        )}

        {!loading && campaigns.length === 0 && !showCreate && (
          <div className="rounded-2xl border border-gray-200 bg-white/90 p-8 text-center">
            <MessageSquareMore className="mx-auto h-10 w-10 text-gray-300 mb-3" />
            <p className="text-sm text-gray-500">Нет кампаний. Создайте первую для начала работы.</p>
          </div>
        )}

        {selected && (
          <CampaignView
            campaign={selected}
            isOwn={currentUserId != null && selected.user_id === currentUserId}
            onUpdate={() => void fetchCampaigns()}
            onDelete={deleteCampaign}
          />
        )}
      </div>
    </div>
  );
}

/* =================== MAIN PAGE =================== */
export default function TgOutreachPage() {
  return (
    <div className="w-full text-left">
      <CampaignsSection />
    </div>
  );
}
