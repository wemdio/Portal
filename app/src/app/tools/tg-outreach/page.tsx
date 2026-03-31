'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
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
} from 'lucide-react';
import type {
  OutreachCampaign,
  OutreachAccount,
  OutreachProxy,
  OutreachDialog,
  OutreachProcessed,
  OutreachLog,
  OpenAISettings,
  TelegramSettings,
} from '@/lib/tgOutreach/types';
import {
  DEFAULT_OPENAI_SETTINGS,
  DEFAULT_TELEGRAM_SETTINGS,
  DEFAULT_FOLLOW_UP,
} from '@/lib/tgOutreach/types';

const API_BASE = '/api/tools/tg-outreach';

async function getToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? '';
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  stopped: { label: 'Остановлена', cls: 'bg-gray-100 text-gray-600' },
  running: { label: 'Запущена', cls: 'bg-emerald-100 text-emerald-700' },
  paused: { label: 'Пауза', cls: 'bg-amber-100 text-amber-700' },
  error: { label: 'Ошибка', cls: 'bg-rose-100 text-rose-700' },
};

const DIALOG_STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  none: { label: '—', cls: 'text-gray-400' },
  lead: { label: 'Лид', cls: 'bg-emerald-100 text-emerald-700' },
  not_lead: { label: 'Не лид', cls: 'bg-gray-100 text-gray-600' },
  later: { label: 'Потом', cls: 'bg-amber-100 text-amber-700' },
};

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

  const handleSave = async () => {
    setSaving(true);
    try { await onSave(openai, telegram); } finally { setSaving(false); }
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
          value={telegram.blocked_usernames.join(', ')}
          onChange={v => setTG('blocked_usernames', v.split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean))}
          placeholder="SpamBot, another_bot"
        />
      </section>

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
function LogsTab({ campaignId }: { campaignId: string }) {
  const [logs, setLogs] = useState<OutreachLog[]>([]);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const fetchLogs = useCallback(async () => {
    const token = await getToken();
    const res = await fetch(`${API_BASE}/campaigns/${campaignId}/logs?limit=200`, { headers: authHeaders(token) });
    if (res.ok) {
      const d = await res.json() as { items: OutreachLog[] };
      setLogs(d.items.reverse());
    }
    setLoading(false);
  }, [campaignId]);

  useEffect(() => { queueMicrotask(() => { void fetchLogs(); }); }, [fetchLogs]);

  useEffect(() => {
    const interval = setInterval(() => void fetchLogs(), 5000);
    return () => clearInterval(interval);
  }, [fetchLogs]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const levelColor = (l: string) => {
    switch (l) {
      case 'error': return 'text-rose-400';
      case 'warning': return 'text-amber-400';
      default: return 'text-gray-400';
    }
  };

  return (
    <div ref={containerRef} className="rounded-lg border border-gray-800 bg-gray-950 p-3 font-mono text-[11px] leading-relaxed h-[500px] overflow-auto">
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
  );
}

/* =================== DIALOGS TAB =================== */
function DialogsTab({ campaignId }: { campaignId: string }) {
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
  const limit = 30;

  const fetchDialogs = useCallback(async () => {
    setLoading(true);
    const token = await getToken();
    const params = new URLSearchParams({ campaign_id: campaignId, limit: String(limit), offset: String(offset) });
    if (filterStatus) params.set('status', filterStatus);
    if (filterCanSend === 'enabled') params.set('can_send', 'true');
    if (filterCanSend === 'disabled') params.set('can_send', 'false');
    if (filterAudience === 'bots') params.set('tg_is_bot', 'true');
    if (filterAudience === 'users') params.set('tg_is_bot', 'false');
    const res = await fetch(`${API_BASE}/dialogs?${params}`, { headers: authHeaders(token) });
    if (res.ok) {
      const d = await res.json() as { items: OutreachDialog[]; total: number };
      setDialogs(d.items); setTotal(d.total);
    }
    setLoading(false);
  }, [campaignId, offset, filterStatus, filterCanSend, filterAudience]);

  useEffect(() => { queueMicrotask(() => { void fetchDialogs(); }); }, [fetchDialogs]);

  const updateDialog = async (id: string, patch: { status?: string; can_send?: boolean }) => {
    const token = await getToken();
    await fetch(`${API_BASE}/dialogs/${id}`, {
      method: 'PUT', headers: authHeaders(token),
      body: JSON.stringify(patch),
    });
    void fetchDialogs();
  };

  const deleteDialog = async (id: string) => {
    const token = await getToken();
    await fetch(`${API_BASE}/dialogs/${id}`, { method: 'DELETE', headers: authHeaders(token) });
    void fetchDialogs();
  };

  const sendMessage = async (id: string) => {
    if (!sendText.trim()) return;
    setSending(true);
    const token = await getToken();
    await fetch(`${API_BASE}/dialogs/${id}/send`, {
      method: 'POST', headers: authHeaders(token),
      body: JSON.stringify({ message: sendText }),
    });
    setSendText(''); setSending(false);
    void fetchDialogs();
  };

  const exportDialogs = async (format: 'json' | 'html') => {
    const token = await getToken();
    const res = await fetch(`${API_BASE}/dialogs/export?campaign_id=${campaignId}&format=${format}`, { headers: authHeaders(token) });
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
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${d.can_send === false ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}`}>
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
                        <button key={s} type="button" onClick={() => void updateDialog(d.id, { status: s })}
                          className={`rounded-full px-3 py-1 text-[10px] font-medium transition border cursor-pointer ${d.status === s ? 'bg-indigo-100 border-indigo-300 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-indigo-200 hover:bg-indigo-50'}`}>
                          {DIALOG_STATUS_LABELS[s]?.label}
                        </button>
                      ))}
                      <label className="ml-2 inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1 text-[10px] font-medium text-gray-700">
                        <input
                          type="checkbox"
                          checked={d.can_send !== false}
                          onChange={e => void updateDialog(d.id, { can_send: e.target.checked })}
                          className="rounded border-gray-300"
                        />
                        Разрешить отправку
                      </label>
                      <button type="button" onClick={() => void deleteDialog(d.id)} className="ml-auto p-2 rounded-lg text-gray-400 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                    <div className="max-h-72 overflow-auto space-y-1.5 rounded-lg bg-gray-50 p-2">
                      {d.messages.map((m, i) => (
                        <div key={i} className={`rounded-lg px-3 py-2 text-xs ${m.role === 'user' ? 'bg-blue-50 text-gray-800' : 'bg-emerald-50 text-gray-800'}`}>
                          <span className="font-semibold">{m.role === 'user' ? 'Собеседник' : 'GPT'}:</span> {m.content}
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <input value={sendText} onChange={e => setSendText(e.target.value)} placeholder="Написать сообщение..."
                        className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-1.5 text-xs outline-none focus:border-indigo-400" onKeyDown={e => { if (e.key === 'Enter') void sendMessage(d.id); }} />
                      <button type="button" onClick={() => void sendMessage(d.id)} disabled={sending || d.can_send === false}
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
    const token = await getToken();
    const res = await fetch(`${API_BASE}/processed?campaign_id=${campaignId}&limit=200`, { headers: authHeaders(token) });
    if (res.ok) {
      const d = await res.json() as { items: OutreachProcessed[]; total: number };
      setItems(d.items); setTotal(d.total);
    }
    setLoading(false);
  }, [campaignId]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const addProcessed = async () => {
    const token = await getToken();
    await fetch(`${API_BASE}/processed`, {
      method: 'POST', headers: authHeaders(token),
      body: JSON.stringify({ campaign_id: campaignId, tg_user_id: Number(addUserId), tg_username: addUsername || null }),
    });
    setAddUserId(''); setAddUsername(''); setShowAdd(false); void load();
  };

  const removeProcessed = async (id: string) => {
    const token = await getToken();
    await fetch(`${API_BASE}/processed?id=${id}`, { method: 'DELETE', headers: authHeaders(token) });
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

/* =================== CAMPAIGN ACCOUNTS TAB =================== */
function CampaignAccountsTab({ campaignId }: { campaignId: string }) {
  const [accounts, setAccounts] = useState<OutreachAccount[]>([]);
  const [proxies, setProxies] = useState<OutreachProxy[]>([]);
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

  const load = useCallback(async () => {
    setLoading(true);
    const token = await getToken();
    const [accRes, proxRes] = await Promise.all([
      fetch(`${API_BASE}/accounts?campaign_id=${campaignId}`, { headers: authHeaders(token) }),
      fetch(`${API_BASE}/proxies?campaign_id=${campaignId}`, { headers: authHeaders(token) }),
    ]);
    if (accRes.ok) {
      const d = await accRes.json() as { items: OutreachAccount[] };
      setAccounts(d.items);
    }
    if (proxRes.ok) {
      const d = await proxRes.json() as { items: OutreachProxy[] };
      setProxies(d.items);
    }
    setLoading(false);
  }, [campaignId]);

  useEffect(() => { queueMicrotask(() => { void load(); }); }, [load]);

  const addAccount = async () => {
    if (!sessionName.trim() || !apiId.trim() || !apiHash.trim()) return;
    setSaving(true);
    const token = await getToken();
    await fetch(`${API_BASE}/accounts`, {
      method: 'POST', headers: authHeaders(token),
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
    const token = await getToken();
    await fetch(`${API_BASE}/accounts/${id}`, {
      method: 'PUT', headers: authHeaders(token),
      body: JSON.stringify({ is_active: !current }),
    });
    void load();
  };

  const deleteAccount = async (id: string) => {
    if (!confirm('Удалить аккаунт?')) return;
    const token = await getToken();
    await fetch(`${API_BASE}/accounts/${id}`, { method: 'DELETE', headers: authHeaders(token) });
    void load();
  };

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files?.length) return;
    setUploading(true);
    setUploadError(null);
    try {
      const token = await getToken();
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

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Загрузка...</div>
      ) : accounts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center">
          <Users className="mx-auto h-8 w-8 text-gray-300 mb-2" />
          <p className="text-xs text-gray-400">Нет аккаунтов. Добавьте вручную или загрузите файлы.</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="grid grid-cols-[1fr_120px_150px_80px_40px] gap-4 px-4 py-2 text-[11px] font-medium text-gray-400 bg-gray-50">
            <span>Аккаунт</span><span>Телефон</span><span>Прокси</span><span>Активен</span><span />
          </div>
          {accounts.map(a => {
            const proxy = proxies.find(p => p.id === a.proxy_id);
            const onCooldown = a.cooldown_until && new Date(a.cooldown_until) > new Date();
            return (
              <div key={a.id} className="grid grid-cols-[1fr_120px_150px_80px_40px] gap-4 items-center px-4 py-2.5">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-gray-800 truncate">{a.session_name}</p>
                  {onCooldown && (
                    <p className="text-[10px] text-amber-600">
                      Кулдаун до {new Date(a.cooldown_until!).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}
                    </p>
                  )}
                </div>
                <span className="text-xs text-gray-500 truncate">{a.phone || '—'}</span>
                <span className="text-xs text-gray-500 truncate">{proxy ? (proxy.name || proxy.url) : '—'}</span>
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

  const load = useCallback(async () => {
    setLoading(true);
    const token = await getToken();
    const res = await fetch(`${API_BASE}/proxies?campaign_id=${campaignId}`, { headers: authHeaders(token) });
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
    const token = await getToken();
    await fetch(`${API_BASE}/proxies`, {
      method: 'POST', headers: authHeaders(token),
      body: JSON.stringify({ campaign_id: campaignId, url: url.trim(), name: name.trim() }),
    });
    setSaving(false);
    setUrl(''); setName(''); setShowAdd(false);
    void load();
  };

  const addBulk = async () => {
    const lines = bulkText.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return;
    setSaving(true);
    const token = await getToken();
    for (const line of lines) {
      await fetch(`${API_BASE}/proxies`, {
        method: 'POST', headers: authHeaders(token),
        body: JSON.stringify({ campaign_id: campaignId, url: line, name: '' }),
      });
    }
    setSaving(false);
    setBulkText(''); setShowBulk(false);
    void load();
  };

  const toggleActive = async (id: string, current: boolean) => {
    const token = await getToken();
    await fetch(`${API_BASE}/proxies/${id}`, {
      method: 'PUT', headers: authHeaders(token),
      body: JSON.stringify({ is_active: !current }),
    });
    void load();
  };

  const deleteProxy = async (id: string) => {
    if (!confirm('Удалить прокси? Аккаунты с этим прокси будут отвязаны.')) return;
    const token = await getToken();
    await fetch(`${API_BASE}/proxies/${id}`, { method: 'DELETE', headers: authHeaders(token) });
    void load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="text-sm font-medium text-gray-700">
          Прокси кампании <span className="text-gray-400 font-normal">({proxies.length})</span>
        </span>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => { setShowBulk(!showBulk); setShowAdd(false); }}
            className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-4 py-2 text-xs font-medium text-gray-700 hover:border-indigo-300 hover:bg-indigo-50 transition cursor-pointer">
            Массовое добавление
          </button>
          <button type="button" onClick={() => { setShowAdd(!showAdd); setShowBulk(false); }}
            className="inline-flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-700 hover:shadow-md transition cursor-pointer">
            <Plus className="h-3.5 w-3.5" /> Добавить
          </button>
        </div>
      </div>

      {showAdd && (
        <div className="rounded-lg border border-gray-200 p-4 space-y-3 bg-gray-50">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-[11px] font-medium text-gray-500">URL прокси</span>
              <input value={url} onChange={e => setUrl(e.target.value)} placeholder="socks5://user:pass@host:port"
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
            placeholder={'socks5://user:pass@host:port\nhttp://user:pass@host:port'}
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

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-400"><Loader2 className="h-4 w-4 animate-spin" />Загрузка...</div>
      ) : proxies.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center">
          <Network className="mx-auto h-8 w-8 text-gray-300 mb-2" />
          <p className="text-xs text-gray-400">Нет прокси. Добавьте для этой кампании.</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-100 rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="grid grid-cols-[1fr_80px_40px] gap-4 px-4 py-2 text-[11px] font-medium text-gray-400 bg-gray-50">
            <span>URL / Название</span><span>Активен</span><span />
          </div>
          {proxies.map(p => (
            <div key={p.id} className="grid grid-cols-[1fr_80px_40px] gap-4 items-center px-4 py-2.5">
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
  { id: 'proxies', label: 'Прокси', icon: Network },
  { id: 'logs', label: 'Логи', icon: ScrollText },
  { id: 'dialogs', label: 'Диалоги', icon: MessageCircle },
  { id: 'processed', label: 'Обработанные', icon: UserCheck },
] as const;

function CampaignView({ campaign, onUpdate, onDelete }: {
  campaign: OutreachCampaign;
  onUpdate: () => void;
  onDelete: (id: string) => void;
}) {
  const [tab, setTab] = useState<string>('settings');
  const [actionLoading, setActionLoading] = useState(false);

  const doAction = async (action: 'start' | 'stop') => {
    setActionLoading(true);
    const token = await getToken();
    await fetch(`${API_BASE}/campaigns/${campaign.id}/${action}`, { method: 'POST', headers: authHeaders(token) });
    setActionLoading(false);
    onUpdate();
  };

  const saveSettings = async (openai: OpenAISettings, telegram: TelegramSettings) => {
    const token = await getToken();
    await fetch(`${API_BASE}/campaigns/${campaign.id}`, {
      method: 'PUT', headers: authHeaders(token),
      body: JSON.stringify({ openai_settings: openai, telegram_settings: telegram }),
    });
    onUpdate();
  };

  const st = STATUS_LABELS[campaign.status] ?? STATUS_LABELS.stopped;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-gray-900">{campaign.name}</h2>
          <span className={`rounded-full px-2.5 py-0.5 text-[10px] font-semibold ${st.cls}`}>{st.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {campaign.status !== 'running' ? (
            <button type="button" onClick={() => void doAction('start')} disabled={actionLoading}
              className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-emerald-700 hover:shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {actionLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Запустить
            </button>
          ) : (
            <button type="button" onClick={() => void doAction('stop')} disabled={actionLoading}
              className="inline-flex items-center gap-1.5 rounded-full bg-rose-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-rose-700 hover:shadow-md transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer">
              {actionLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
              Остановить
            </button>
          )}
          <button type="button" onClick={() => onDelete(campaign.id)}
            className="rounded-full border border-gray-200 p-2.5 text-gray-400 hover:text-rose-600 hover:border-rose-300 hover:bg-rose-50 transition cursor-pointer">
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

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
        {tab === 'logs' && <LogsTab campaignId={campaign.id} />}
        {tab === 'dialogs' && <DialogsTab campaignId={campaign.id} />}
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

  const fetchCampaigns = useCallback(async () => {
    const token = await getToken();
    if (!token) { setLoading(false); return; }
    const res = await fetch(`${API_BASE}/campaigns`, { headers: authHeaders(token) });
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
    const token = await getToken();
    const res = await fetch(`${API_BASE}/campaigns`, {
      method: 'POST', headers: authHeaders(token),
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
    const token = await getToken();
    await fetch(`${API_BASE}/campaigns/${id}`, { method: 'DELETE', headers: authHeaders(token) });
    if (selectedId === id) setSelectedId(null);
    void fetchCampaigns();
  };

  const selected = campaigns.find(c => c.id === selectedId) ?? null;

  return (
    <div className="flex gap-6 text-left max-w-full">
      <div className="min-w-0 flex-1 max-w-7xl space-y-6">
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
                <span className={`h-1.5 w-1.5 rounded-full ${c.status === 'running' ? 'bg-emerald-400' : c.status === 'error' ? 'bg-rose-400' : 'bg-gray-400'}`} />
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
          <CampaignView campaign={selected} onUpdate={() => void fetchCampaigns()} onDelete={deleteCampaign} />
        )}
      </div>
    </div>
  );
}

/* =================== MAIN PAGE =================== */
export default function TgOutreachPage() {
  return (
    <div className="flex gap-6 text-left max-w-full">
      <div className="min-w-0 flex-1 max-w-7xl">
        <CampaignsSection />
      </div>
    </div>
  );
}
